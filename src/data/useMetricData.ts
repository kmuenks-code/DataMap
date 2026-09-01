import { useEffect, useMemo, useState } from 'react';
import { feature } from 'topojson-client';
import type { FeatureCollection, Geometry } from 'geojson';
import type { Topology } from 'topojson-specification';

import { loadGeometry, loadMetric } from './loaders.ts';
import { geometryVintageFor, layerOf, type BaselineFile, type MetricFile } from './types.ts';
import { useActiveBaselineRegionIdFor } from '../lib/baseline.ts';
import { rankAll } from '../lib/stats/ranking.ts';
import { useAppStore } from '../state/useAppStore.ts';

/**
 * Derived-collection cache, shared across every component that calls
 * useMetricData().
 *
 * Four components consume this hook (map, legend, detail panel, timeline), so
 * without a shared cache the TopoJSON->GeoJSON conversion and the full ranking
 * pass would run four times for every year change. Keyed on the inputs that
 * determine the output; a tiny cap keeps scrubbing back and forth instant
 * without holding every year of every metric in memory.
 */
const derivedCache = new Map<string, FeatureCollection<Geometry, MapFeatureProps>>();
const DERIVED_CACHE_MAX = 24;

function cacheDerived(
  key: string,
  build: () => FeatureCollection<Geometry, MapFeatureProps>,
): FeatureCollection<Geometry, MapFeatureProps> {
  const hit = derivedCache.get(key);
  if (hit) return hit;
  const built = build();
  derivedCache.set(key, built);
  if (derivedCache.size > DERIVED_CACHE_MAX) {
    derivedCache.delete(derivedCache.keys().next().value as string);
  }
  return built;
}

/**
 * Do the loaded data and the loaded polygons describe the same geography?
 *
 * Guards the join against the transient state after a geography switch, when
 * one of the two has arrived and the other has not. Joining across that gap
 * yields zero geoid matches, and because the join is memoised the empty result
 * would stick permanently -- a blank map that depends on network ordering, so
 * it reproduces on a deployed site and not on a warm local one.
 */
export function geometryMatchesFile(
  file: Pick<MetricFile, 'geoLevel'>,
  topo: { level: string; vintage: number },
  vintage: number | undefined,
): boolean {
  return file.geoLevel === topo.level && vintage === topo.vintage;
}

/**
 * The 100% line to divide by, per year, when the user has chosen to compare
 * against an ancestor region instead of this one.
 *
 * Returns null when the choice cannot be honoured -- the ancestor's baselines
 * have not arrived, or it does not publish this metric. Callers then fall back
 * to the file's own precomputed index rather than rendering an unindexed map,
 * because a silently mis-scaled choropleth is worse than a briefly stale one.
 */
export function baselineSeries(
  baselines: BaselineFile | undefined,
  metricId: string | null,
): Map<number, number | null> | null {
  const entry = metricId ? baselines?.metrics[metricId] : undefined;
  if (!entry) return null;
  return new Map(entry.years.map((y, i) => [y, entry.values[i] ?? null]));
}

/**
 * The index is `100 * value / baseline`, recomputed rather than read.
 *
 * The ETL ships an index against the region's OWN baseline. Comparing the same
 * areas with a different region means redoing that one division -- which is
 * why an alternative baseline costs a 2 KB file and no rebuild.
 */
export function indexAgainst(value: number | null, baseline: number | null | undefined): number | null {
  if (value == null || baseline == null || baseline === 0) return null;
  return Math.round((value / baseline) * 1000) / 10;
}

/**
 * The ancestor baseline series in effect, plus the id it came from.
 *
 * Three consumers need this (the map join, the sparkline, the leaderboard) and
 * every one of them must resolve it identically -- a panel indexed against the
 * metro while the map is indexed against the US would put two different
 * meanings of "100" on the same screen. One hook, one answer.
 */
export function useBaselineOverride(metricId: string | null) {
  // Resolved FOR THIS METRIC, not for the map's: the scatter calls this hook
  // twice with two different metrics, and an ancestor that publishes one but
  // not the other is in effect for one axis only.
  const baselineRegionId = useActiveBaselineRegionIdFor(metricId);
  const baselineFile = useAppStore((s) =>
    baselineRegionId ? s.baselines[baselineRegionId] : undefined,
  );
  const series = useMemo(
    () => (baselineRegionId ? baselineSeries(baselineFile, metricId) : null),
    [baselineRegionId, baselineFile, metricId],
  );
  return { baselineRegionId, series };
}

export interface MapFeatureProps {
  geoid: string;
  name: string;
  value: number | null;
  index: number | null;
  cv: number | null;
  rank: number | null;
  percentile: number | null;
  total: number;
}

/**
 * Joins the selected metric to the correct geometry for the selected year, and
 * returns a ready-to-render FeatureCollection.
 *
 * The geometry is chosen by BOUNDARY VINTAGE, not by level alone: census areas
 * are redrawn each decade, so 2020 polygons under 2012 data would produce a
 * confident, wrong map.
 */
export function useMetricData() {
  const { regionId, geoLevelId, metricId, year } = useAppStore();
  const region = useAppStore((s) => s.region());
  // The ancestor actually in effect, not merely requested -- so the map and
  // the labels can never disagree about what 100 means. See baseline.ts.
  const { baselineRegionId, series: override } = useBaselineOverride(metricId);

  const [file, setFile] = useState<MetricFile | null>(null);
  /**
   * The topology is tagged with the level and vintage it was fetched FOR.
   *
   * Data and geometry load in two independent effects, so between a geography
   * switch and the second response landing, the new metric file coexists with
   * the previous level's polygons. Joining those two produces zero matches --
   * and the join is memoised, so that empty result would be cached under the
   * new level's key and never recomputed: a permanently blank map, reached only
   * when the responses happen to arrive in that order. The tag is what lets the
   * join tell "still loading" apart from "genuinely no overlap".
   */
  const [topo, setTopo] = useState<{ level: string; vintage: number; topo: Topology } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const layerId = region && metricId ? layerOf(region, metricId)?.id : undefined;
  const level = region?.geoLevels.find((g) => g.id === geoLevelId);
  const vintage = level && year != null ? geometryVintageFor(level, year) : undefined;

  useEffect(() => {
    if (!regionId || !geoLevelId || !metricId || !layerId) return;
    let cancelled = false;
    setLoading(true);
    loadMetric(regionId, geoLevelId, layerId, metricId)
      .then((f) => !cancelled && setFile(f))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [regionId, geoLevelId, metricId, layerId]);

  useEffect(() => {
    if (!regionId || !geoLevelId || vintage == null) return;
    let cancelled = false;
    loadGeometry(regionId, geoLevelId, vintage)
      .then((t) => !cancelled && setTopo({ level: geoLevelId, vintage, topo: t as Topology }))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [regionId, geoLevelId, vintage]);

  const collection = useMemo<FeatureCollection<Geometry, MapFeatureProps> | null>(() => {
    if (!file || !topo || year == null) return null;

    // Both sides must describe the SAME geography before they are joined, or a
    // mid-switch pairing gets memoised as an empty map. See the note on `topo`.
    if (!geometryMatchesFile(file, topo, vintage)) return null;

    const yearIndex = file.years.indexOf(year);
    if (yearIndex === -1) return null;

    const objectName = Object.keys(topo.topo.objects)[0];
    if (!objectName) return null;

    // Vintage belongs in the key too: one level's data is joined to different
    // polygons either side of a decennial redraw.
    // The baseline region belongs in the key: the same areas, year and
    // polygons produce a DIFFERENT index depending on what 100 means.
    const baselineKey = override ? (baselineRegionId ?? 'own') : 'own';
    return cacheDerived(
      `${file.region}/${file.geoLevel}/${topo.vintage}/${file.metric}/${year}/${baselineKey}`,
      () => {
      const ranks = rankAll(file, yearIndex);
      const byGeoid = new Map(file.geoids.map((g, i) => [g, i]));

      const fc = feature(topo.topo, topo.topo.objects[objectName]!) as unknown as FeatureCollection<
        Geometry,
        { geoid?: string; name?: string }
      >;

      const features = fc.features.flatMap((f) => {
        const geoid = f.properties?.geoid ?? (f.id != null ? String(f.id) : undefined);
        if (!geoid) return [];
        const i = byGeoid.get(geoid);
        // A polygon with no matching data row is dropped rather than drawn
        // empty: boundary vintages and data coverage do not align perfectly,
        // and a grey shape that looks like a real value is worse than none.
        if (i === undefined) return [];
        const rank = ranks.get(geoid);
        return [
          {
            ...f,
            id: geoid,
            properties: {
              geoid,
              name: file.names[i] ?? f.properties?.name ?? geoid,
              value: file.values[yearIndex]?.[i] ?? null,
              index: override
                ? indexAgainst(file.values[yearIndex]?.[i] ?? null, override.get(year))
                : (file.index[yearIndex]?.[i] ?? null),
              cv: file.cv?.[yearIndex]?.[i] ?? null,
              rank: rank?.rank ?? null,
              percentile: rank?.percentile ?? null,
              total: rank?.total ?? 0,
            },
          },
        ];
      });

        return { type: 'FeatureCollection' as const, features };
      },
    );
  }, [file, topo, year, vintage, override, baselineRegionId]);

  return { file, collection, loading, error, vintage };
}

/**
 * The selected area's full index series -- what the sparkline draws.
 *
 * Recomputed against the chosen baseline for every year, not just the one on
 * screen: the whole point of the trend is the shape, and a line drawn against
 * two different denominators would bend for the wrong reason.
 */
export function useTrend(file: MetricFile | null, geoid: string | null) {
  const { series: override } = useBaselineOverride(file?.metric ?? null);

  return useMemo(() => {
    if (!file || !geoid) return null;
    const i = file.geoids.indexOf(geoid);
    if (i === -1) return null;
    return file.years.map((y, yi) => {
      const value = file.values[yi]?.[i] ?? null;
      return {
        year: y,
        index: override ? indexAgainst(value, override.get(y)) : (file.index[yi]?.[i] ?? null),
        value,
      };
    });
  }, [file, geoid, override]);
}

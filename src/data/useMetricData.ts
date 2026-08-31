import { useEffect, useMemo, useState } from 'react';
import { feature } from 'topojson-client';
import type { FeatureCollection, Geometry } from 'geojson';
import type { Topology } from 'topojson-specification';

import { loadGeometry, loadMetric } from './loaders.ts';
import { geometryVintageFor, layerOf, type MetricFile } from './types.ts';
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

  const [file, setFile] = useState<MetricFile | null>(null);
  const [topo, setTopo] = useState<Topology | null>(null);
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
      .then((t) => !cancelled && setTopo(t as Topology))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [regionId, geoLevelId, vintage]);

  const collection = useMemo<FeatureCollection<Geometry, MapFeatureProps> | null>(() => {
    if (!file || !topo || year == null) return null;

    const yearIndex = file.years.indexOf(year);
    if (yearIndex === -1) return null;

    const objectName = Object.keys(topo.objects)[0];
    if (!objectName) return null;

    return cacheDerived(`${file.region}/${file.geoLevel}/${file.metric}/${year}`, () => {
      const ranks = rankAll(file, yearIndex);
      const byGeoid = new Map(file.geoids.map((g, i) => [g, i]));

      const fc = feature(topo, topo.objects[objectName]!) as unknown as FeatureCollection<
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
              index: file.index[yearIndex]?.[i] ?? null,
              cv: file.cv?.[yearIndex]?.[i] ?? null,
              rank: rank?.rank ?? null,
              percentile: rank?.percentile ?? null,
              total: rank?.total ?? 0,
            },
          },
        ];
      });

      return { type: 'FeatureCollection' as const, features };
    });
  }, [file, topo, year]);

  return { file, collection, loading, error, vintage };
}

/** The selected area's full index series -- what the sparkline draws. */
export function useTrend(file: MetricFile | null, geoid: string | null) {
  return useMemo(() => {
    if (!file || !geoid) return null;
    const i = file.geoids.indexOf(geoid);
    if (i === -1) return null;
    return file.years.map((y, yi) => ({
      year: y,
      index: file.index[yi]?.[i] ?? null,
      value: file.values[yi]?.[i] ?? null,
    }));
  }, [file, geoid]);
}

import { useEffect, useMemo, useState } from 'react';

import { loadMetric } from './loaders.ts';
import { allMetrics, layerOf, type MetricFile, type MetricSummary } from './types.ts';
import { indexAgainst, useBaselineOverride } from './useMetricData.ts';
import { buildScatter, type ScatterAxis, type ScatterResult } from '../lib/stats/scatter.ts';
import { useAppStore, type AxisSelection } from '../state/useAppStore.ts';

/**
 * One metric file for the current region and geo level.
 *
 * The returned file is guaranteed to describe the CURRENT selection: a metric
 * file carries its own region, level and metric, so a response that lands after
 * the selection moved on is discarded by comparison rather than by racing
 * effects. The map solves the same problem with a tag on the topology; here the
 * file already carries the tag.
 */
function useAxisFile(metricId: string | null): MetricFile | null {
  const regionId = useAppStore((s) => s.regionId);
  const geoLevelId = useAppStore((s) => s.geoLevelId);
  const region = useAppStore((s) => s.region());
  const [file, setFile] = useState<MetricFile | null>(null);

  const layerId = region && metricId ? layerOf(region, metricId)?.id : undefined;

  useEffect(() => {
    if (!regionId || !geoLevelId || !metricId || !layerId) return;
    let cancelled = false;
    loadMetric(regionId, geoLevelId, layerId, metricId)
      .then((f) => !cancelled && setFile(f))
      // A metric absent at this geo level 404s. That is a legitimate state the
      // panel reports as "not published here", not an app error.
      .catch(() => !cancelled && setFile(null));
    return () => {
      cancelled = true;
    };
  }, [regionId, geoLevelId, metricId, layerId]);

  if (!file) return null;
  return file.region === regionId && file.geoLevel === geoLevelId && file.metric === metricId
    ? file
    : null;
}

/**
 * The metric to size dots by, found by UNIT rather than by id.
 *
 * Hardcoding 'population' here would put a registry entry's name into `src/`,
 * which is exactly what the layer/metric registry exists to avoid: a future
 * source publishing its own population count under a different id would size
 * the dots by nothing. A count of people is a count of people.
 */
export function useSizeMetric(): MetricSummary | null {
  const region = useAppStore((s) => s.region());
  const geoLevelId = useAppStore((s) => s.geoLevelId);
  return useMemo(() => {
    if (!region) return null;
    return (
      allMetrics(region).find(
        (m) => m.kind === 'count' && m.unit === 'people' && m.geoLevels.includes(geoLevelId ?? ''),
      ) ?? null
    );
  }, [region, geoLevelId]);
}

export interface ScatterData {
  result: ScatterResult | null;
  xFile: MetricFile | null;
  yFile: MetricFile | null;
  /** The metric sizing the dots, when sizing is on and the region publishes one. */
  sizeMetric: MetricSummary | null;
  /** Which axes' baselines are pinned to an ancestor region, for the labels. */
  baselineRegionIds: { x: string | null; y: string | null };
}

/**
 * The scatter's data, on the same scope the map uses.
 *
 * Region, geo level, year and baseline all come from the shared store, so
 * switching a region or a geography moves both views together and the two can
 * never describe different sets of areas. The only inputs this hook adds are
 * the two axis selections.
 */
export function useScatterData(): ScatterData {
  const axes = useAppStore((s) => s.axes);
  const year = useAppStore((s) => s.year);
  const showImprecise = useAppStore((s) => s.scatterShowImprecise);
  const sizeOn = useAppStore((s) => s.scatterSizeByPopulation);

  const xFile = useAxisFile(axes.x.metricId);
  const yFile = useAxisFile(axes.y.metricId);

  const sizeMetric = useSizeMetric();
  const sizeFile = useAxisFile(sizeOn ? (sizeMetric?.id ?? null) : null);

  // Each axis resolves its own ancestor baseline: one may publish a metric the
  // other does not, and an axis silently falling back to the region's own 100
  // while the label says "vs US" is the failure this separation prevents.
  const xOverride = useBaselineOverride(axes.x.metricId);
  const yOverride = useBaselineOverride(axes.y.metricId);

  const result = useMemo(() => {
    if (!xFile || !yFile || year == null) return null;
    return buildScatter({
      x: toAxis(xFile, axes.x, xOverride.series),
      y: toAxis(yFile, axes.y, yOverride.series),
      year,
      size: sizeFile,
      excludeImprecise: !showImprecise,
    });
  }, [xFile, yFile, year, axes, xOverride.series, yOverride.series, sizeFile, showImprecise]);

  return {
    result,
    xFile,
    yFile,
    sizeMetric: sizeOn ? sizeMetric : null,
    baselineRegionIds: { x: xOverride.baselineRegionId, y: yOverride.baselineRegionId },
  };
}

function toAxis(
  file: MetricFile,
  selection: AxisSelection,
  override: Map<number, number | null> | null,
): ScatterAxis {
  return {
    file,
    measure: selection.measure,
    basis: selection.basis,
    log: selection.log,
    // The same one-division recomputation the map does. See indexAgainst().
    indexAt: (yi, i) =>
      override
        ? indexAgainst(file.values[yi]?.[i] ?? null, override.get(file.years[yi]!))
        : (file.index[yi]?.[i] ?? null),
  };
}

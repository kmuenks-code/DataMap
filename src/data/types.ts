/** Shared contract between the ETL output and the app. Keep in sync with etl/src/transform/pack.ts. */

export type MetricKind = 'median' | 'rate' | 'count' | 'ratio';
export type ViewMode = 'index' | 'raw' | 'change';
export type LayerKind = 'metric' | 'overlay';

/**
 * public/data/manifest.json -- the only file fetched at startup.
 *
 * Its shape IS the app's navigation model: layer > group > metric. The tree is
 * computed at build time so the picker stays usable as the metric count grows
 * from nine into the hundreds, at no cost to the client.
 */
export interface Manifest {
  schema: 2;
  generatedAt: string;
  regions: RegionSummary[];
}

export interface RegionSummary {
  id: string;
  label: string;
  kind: 'metro' | 'state' | 'national';
  center: [number, number];
  zoom: number;
  geoLevels: GeoLevelSummary[];
  layers: LayerSummary[];
}

export interface GeoLevelSummary {
  id: string;
  label: string;
  default?: boolean;
  areaCount: number;
  /**
   * Boundary vintages with geometry on disk. Census areas are redrawn each
   * decade, so the app must pick polygons by the selected year's vintage --
   * see geometryVintageFor().
   */
  geometryVintages: number[];
}

/**
 * A data domain.
 *
 * `kind` decides how it composes on the map, and the two do not mix:
 *   'metric'  -> colors the polygons. MUTUALLY EXCLUSIVE; a polygon has one
 *                fill, so selecting a metric replaces the current one.
 *   'overlay' -> drawn on top. ADDITIVE; any number can be visible at once.
 */
export interface LayerSummary {
  id: string;
  label: string;
  kind: LayerKind;
  description?: string;
  attribution: string;
  /** Metric layers only. */
  groups?: GroupSummary[];
  /** Overlay layers only. */
  render?: { type: string; labelField?: string };
}

export interface GroupSummary {
  id: string;
  label: string;
  metrics: MetricSummary[];
}

export interface MetricSummary {
  id: string;
  label: string;
  unit: string;
  kind: MetricKind;
  higherIsBetter: boolean | null;
  description?: string;
  /** Years with data. Not always contiguous -- see minYear in the registry. */
  years: number[];
  /** Geo levels this metric was actually built for. Not every layer covers every level. */
  geoLevels: string[];
}

export interface MetricFile {
  schema: 1;
  region: string;
  geoLevel: string;
  metric: string;
  layer: string;
  group: string;
  kind: MetricKind;
  unit: string;
  years: number[];
  geoids: string[];
  names: string[];
  baseline: (number | null)[];
  values: (number | null)[][];
  index: (number | null)[][];
  cv?: (number | null)[][];
  meta: {
    generatedAt: string;
    dataset: string;
    variables: string[];
    boundaryVintageByYear?: Record<string, number>;
    notes?: string[];
  };
}

/** What the map layer and detail panel consume for one selected year. */
export interface AreaSlice {
  geoid: string;
  name: string;
  value: number | null;
  index: number | null;
  cv: number | null;
  rank: number | null;
  percentile: number | null;
}

/** Flatten the tree when a search box needs a single list to filter. */
export function allMetrics(region: RegionSummary): MetricSummary[] {
  return region.layers.flatMap((l) => l.groups?.flatMap((g) => g.metrics) ?? []);
}

export function findMetric(region: RegionSummary, id: string): MetricSummary | undefined {
  return allMetrics(region).find((m) => m.id === id);
}

/** The layer a metric belongs to -- needed to build its data path. */
export function layerOf(region: RegionSummary, metricId: string): LayerSummary | undefined {
  return region.layers.find((l) => l.groups?.some((g) => g.metrics.some((m) => m.id === metricId)));
}

/**
 * Which geometry file to draw for a given year: the newest vintage that does
 * not postdate it. Drawing 2020 polygons under 2012 data is the silent-wrong-map
 * failure mode this exists to prevent.
 */
export function geometryVintageFor(level: GeoLevelSummary, year: number): number | undefined {
  const eligible = level.geometryVintages.filter((v) => v <= year);
  return eligible.length > 0 ? Math.max(...eligible) : Math.min(...level.geometryVintages);
}

/** Shared contract between the ETL output and the app. Keep in sync with etl/src/transform/pack.ts. */

export type MetricKind = 'median' | 'rate' | 'count' | 'ratio';
export type ViewMode = 'index' | 'raw' | 'change';
export type LayerKind = 'metric' | 'overlay';

/**
 * public/data/manifest.json -- the ROOT INDEX, and the only file fetched before
 * the app can render anything.
 *
 * Schema 3 split the manifest in two. It used to be a single document carrying
 * every region's full layer > group > metric tree; that tree is ~12 KB per
 * region and is near-identical between them, so a national build (50 states +
 * a US region + metros) would have meant downloading ~600 KB of mostly
 * redundant navigation model before the first pixel. Now the root lists only
 * what a region picker and the initial map camera need, and the tree for one
 * region is fetched on demand from regions/<id>/manifest.json.
 */
export interface Manifest {
  schema: 3;
  generatedAt: string;
  /** Which region to open on a cold start. The app must not assume index 0. */
  defaultRegion: string;
  regions: RegionIndexEntry[];
}

/**
 * One row of the root index: enough to list the region and point the map at
 * it, and deliberately nothing more. Everything else lives in the region
 * document, because "everything else" is what does not scale to 50 states.
 */
export interface RegionIndexEntry {
  id: string;
  label: string;
  kind: 'metro' | 'state' | 'national';
  center: [number, number];
  zoom: number;
  /** Rolled up from the region document so the picker can show scale without fetching it. */
  /** The region this one sits inside, if any. See RegionSummary.parent. */
  parent?: string;
  geoLevelCount: number;
  metricCount: number;
}

/**
 * public/data/regions/<id>/manifest.json -- one region's full navigation model.
 *
 * Its shape IS the app's navigation model: layer > group > metric. The tree is
 * computed at build time so the picker stays usable as the metric count grows
 * from nine into the hundreds, at no cost to the client.
 */
export interface RegionSummary {
  schema: 3;
  generatedAt: string;
  id: string;
  label: string;
  kind: 'metro' | 'state' | 'national';
  center: [number, number];
  zoom: number;
  /**
   * The region this one sits inside.
   *
   * Scope and baseline are separate questions. The areas drawn are always this
   * region's; `parent` names another region whose published totals may be used
   * as the 100% line instead, so the same map can be read against its metro or
   * against the country. Chains upward: metro -> state -> nation.
   */
  parent?: string;
  /**
   * Opening view as [west, south, east, north], when the data's own bounding
   * box cannot supply it. Set only where that box is wrong -- see MapView.
   */
  fitBounds?: [number, number, number, number];
  geoLevels: GeoLevelSummary[];
  layers: LayerSummary[];
}

export interface GeoLevelSummary {
  id: string;
  label: string;
  default?: boolean;
  areaCount: number;
  /**
   * False when the level's areas do NOT cover the whole region, so blank
   * ground is a real gap rather than missing data. Places leave roughly a
   * fifth of the metro population uncovered; the UI has to say so, or the
   * reader will read empty townships as "no data here".
   */
  tilesRegion?: boolean;
  /** Caveat too long for the button label. */
  note?: string;
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
  /** Overlay layers only: shape count in the overlay file. */
  areaCount?: number;
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
  /**
   * No build timestamp here by design: metric files are committed, and a
   * timestamp would make every rebuild a diff. See pack.ts. The region
   * manifest carries generatedAt for the whole build.
   */
  meta: {
    dataset: string;
    variables: string[];
    boundaryVintageByYear?: Record<string, number>;
    notes?: string[];
  };
}

/**
 * public/data/regions/<id>/baselines.json -- one region's 100% line per metric.
 *
 * A few kilobytes, so the app can index one region's areas against ANOTHER
 * region's totals without downloading that region's metric files. The values
 * are the same ones inside the metric files; this is the cheap copy.
 */
export interface BaselineFile {
  schema: 1;
  region: string;
  label: string;
  /** Which geo level's baseline was taken. See writeBaselines() for why it matters. */
  geoLevel: string;
  metrics: Record<string, { years: number[]; values: (number | null)[] }>;
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
 * The chain from a region up to the root, as ids: [self, parent, grandparent].
 *
 * Every entry is a legitimate 100% line for this region's areas, so this IS the
 * list of options the baseline picker offers. Defensive against a cycle in
 * config, which would otherwise hang the UI rather than fail a build.
 */
export function regionChain(index: RegionIndexEntry[], id: string): RegionIndexEntry[] {
  const byId = new Map(index.map((r) => [r.id, r]));
  const chain: RegionIndexEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = id;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const entry: RegionIndexEntry | undefined = byId.get(cursor);
    if (!entry) break;
    chain.push(entry);
    cursor = entry.parent;
  }
  return chain;
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

import { readFile } from 'node:fs/promises';

export interface MetricSource {
  dataset: string;
  value?: string;
  moe?: string;
  numerator?: string;
  denominator?: string;
  numeratorMoe?: string;
  denominatorMoe?: string;
  numeratorSum?: string[];
}

export interface LayerGroup {
  id: string;
  label: string;
  order?: number;
}

export interface LayerDef {
  id: string;
  label: string;
  /**
   * 'metric'  -> choropleth data; MUTUALLY EXCLUSIVE (one fill per polygon).
   * 'overlay' -> drawn on top; ADDITIVE (many can be visible at once).
   */
  kind: 'metric' | 'overlay';
  enabled: boolean;
  order?: number;
  description?: string;
  provider: { name: string; url: string; attribution: string; license: string };
  cadence?: string;
  /** Layers do NOT all support the same geographies -- elections are precinct-level. */
  geoLevels?: string[];
  groups?: LayerGroup[];
  render?: { type: string; labelField?: string };
  /**
   * Where an OVERLAY layer's geometry comes from. Metric layers have no
   * `source` -- their data is described per metric in metrics.json.
   *
   * `regions` scopes a source to the metros it actually describes: Columbus's
   * community boundaries are meaningless in another city, and a region without
   * a source for a layer simply never shows it.
   */
  source?: {
    type: 'arcgis';
    url: string;
    /** Attribute holding the display name; renamed to `name` on the way out. */
    nameField: string;
    simplify?: string;
    regions?: string[];
  };
}

export interface MetricDef {
  id: string;
  label: string;
  /** Must match a layer id in layers.json. */
  layer: string;
  /** Must match a group id within that layer. */
  group: string;
  kind: 'median' | 'rate' | 'count' | 'ratio';
  unit: string;
  source: MetricSource;
  baseline: 'published' | 'aggregate';
  baselineVar?: string;
  higherIsBetter: boolean | null;
  description?: string;
  minYear?: number;
  maxYear?: number;
}

export interface GeoLevelDef {
  id: string;
  label: string;
  censusFor: string;
  /**
   * Where this level sits in the Census hierarchy, which decides how it is
   * fetched. NOT cosmetic -- getting it wrong is an HTTP 400.
   *
   *   'county' (default) -- `in=state:XX county:YYY`, one call per county.
   *                         Tracts and county subdivisions require this; a bare
   *                         `in=state:XX` is rejected for them.
   *   'state'            -- `in=state:XX` only, one call for the whole state.
   *                         Places take this form because a place is NOT nested
   *                         inside a county: Dublin spans Franklin, Delaware and
   *                         Union. Verified live -- adding `county:049` to a
   *                         place query returns 400 "unknown/unsupported
   *                         geography hierarchy".
   */
  censusIn?: 'county' | 'state';
  /**
   * How to cut a state-wide response down to this region. Required when
   * `censusIn` is 'state', because such a query returns every area in Ohio.
   *
   *   'place-by-county' -- the Census place/county relationship file. Also
   *                        filters the TIGER geometry, which for places carries
   *                        no COUNTYFP field to filter on.
   */
  restrictBy?: 'place-by-county';
  /**
   * Whether this level's areas cover the whole region.
   *
   * Tracts and county subdivisions tile the metro exactly, so a rate baseline
   * can be pooled from the areas themselves. Places do NOT: 22% of the metro
   * population lives in unincorporated township land that belongs to no place.
   * Pooling over places would pin "100" to the metro's incorporated population
   * rather than to the metro, quietly redefining the index. Levels that do not
   * tile pull their rate baselines from the published CBSA figures instead.
   */
  tilesRegion?: boolean;
  vintage: number;
  default?: boolean;
  tigerLayer: string;
  simplify: string;
  enabled?: boolean;
  /** Shown in the UI where this level needs a caveat the label cannot carry. */
  note?: string;
}

export interface RegionDef {
  id: string;
  label: string;
  kind: 'metro' | 'state' | 'national';
  cbsa?: string;
  center: [number, number];
  zoom: number;
  state: string;
  counties: { fips: string; name: string }[];
  geoLevels: GeoLevelDef[];
  years: { dataset: string; min: number; max: number };
}

const root = new URL('../config/', import.meta.url);

export async function loadRegion(id: string): Promise<RegionDef> {
  const raw = await readFile(new URL(`regions/${id}.json`, root), 'utf8');
  return JSON.parse(raw) as RegionDef;
}

export async function loadLayers(): Promise<LayerDef[]> {
  const raw = await readFile(new URL('layers.json', root), 'utf8');
  return (JSON.parse(raw) as { layers: LayerDef[] }).layers;
}

export async function loadMetrics(): Promise<MetricDef[]> {
  const raw = await readFile(new URL('metrics.json', root), 'utf8');
  const metrics = (JSON.parse(raw) as { metrics: MetricDef[] }).metrics;
  await validateTaxonomy(metrics);
  return metrics;
}

/**
 * Fail the build on a dangling layer/group reference.
 *
 * Without this a typo'd layer id produces a metric file on disk that no
 * navigation path reaches -- data that exists but is unreachable in the UI,
 * which is far harder to notice than a crash.
 */
async function validateTaxonomy(metrics: MetricDef[]): Promise<void> {
  const layers = await loadLayers();
  const byId = new Map(layers.map((l) => [l.id, l]));
  const problems: string[] = [];

  for (const m of metrics) {
    const layer = byId.get(m.layer);
    if (!layer) {
      problems.push(`metric "${m.id}" references unknown layer "${m.layer}"`);
      continue;
    }
    if (layer.kind !== 'metric') {
      problems.push(`metric "${m.id}" belongs to layer "${m.layer}", which is an overlay`);
    }
    if (!layer.groups?.some((g) => g.id === m.group)) {
      problems.push(`metric "${m.id}" references unknown group "${m.group}" in "${m.layer}"`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid metric taxonomy:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Metrics belonging to enabled metric-layers, in layer/group/label order. */
export function orderMetrics(metrics: MetricDef[], layers: LayerDef[]): MetricDef[] {
  const rank = new Map<string, number>();
  layers.forEach((l, li) =>
    l.groups?.forEach((g, gi) => rank.set(`${l.id}/${g.id}`, (l.order ?? li) * 1000 + (g.order ?? gi))),
  );
  const enabled = new Set(layers.filter((l) => l.enabled && l.kind === 'metric').map((l) => l.id));
  return metrics
    .filter((m) => enabled.has(m.layer))
    .sort(
      (a, b) =>
        (rank.get(`${a.layer}/${a.group}`) ?? 0) - (rank.get(`${b.layer}/${b.group}`) ?? 0) ||
        a.label.localeCompare(b.label),
    );
}

/** Every ACS variable a metric needs, estimate and MOE alike. */
export function variablesFor(m: MetricDef): string[] {
  const s = m.source;
  return [
    s.value,
    s.moe,
    s.numerator,
    s.denominator,
    s.numeratorMoe,
    s.denominatorMoe,
    ...(s.numeratorSum ?? []),
  ].filter((v): v is string => Boolean(v));
}

export function availableIn(m: MetricDef, year: number): boolean {
  if (m.minYear != null && year < m.minYear) return false;
  if (m.maxYear != null && year > m.maxYear) return false;
  return true;
}

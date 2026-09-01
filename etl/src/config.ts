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
   *                         Correct but expensive, and NOT required: an earlier
   *                         note here claimed a bare `in=state:XX` was rejected
   *                         for tracts and county subdivisions. RETESTED
   *                         2026-09-01 against the live API and that is false --
   *                         `for=tract:*&in=state:39` and
   *                         `for=county subdivision:*&in=state:39` both succeed
   *                         for every year 2009-2024. This matters at scale: it
   *                         is the difference between ~2,500 requests to build
   *                         all 51 states and ~50,000. Columbus still fetches
   *                         per-county because its cache is warm and its scope
   *                         is 10 counties, not because it must.
   *   'state'            -- `in=state:XX` only, one call for the whole state.
   *                         Places take this form because a place is NOT nested
   *                         inside a county: Dublin spans Franklin, Delaware and
   *                         Union. Verified live -- adding `county:049` to a
   *                         place query returns 400 "unknown/unsupported
   *                         geography hierarchy".
   *   'us'               -- no `in=` clause at all, one call for the whole
   *                         country. Used by the national region's state
   *                         level: `for=state:*` with no scope returns all 52
   *                         state-equivalents in a single request.
   */
  censusIn?: 'county' | 'state' | 'us';
  /**
   * How to cut a state-wide response down to this region. Required when
   * `censusIn` is 'state', because such a query returns every area in Ohio.
   *
   *   'place-by-county' -- the Census place/county relationship file. Also
   *                        filters the TIGER geometry, which for places carries
   *                        no COUNTYFP field to filter on.
   *   'us-states'       -- drop the territories, so the areas on the map are
   *                        exactly the ones the `us:1` baseline covers. See
   *                        sources/census/states.ts for the measurement that
   *                        makes this mandatory rather than cosmetic.
   */
  restrictBy?: 'place-by-county' | 'us-states';
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
  /**
   * Which boundary vintages to build for this level, and the GENZ release that
   * carries each, as [{ vintage, release }]. Omit to use the decadal default
   * (2020 -> GENZ2023, 2010 -> GENZ2019).
   *
   * Needed because boundary eras are NOT decadal for every geography. County
   * eras are set by individual state actions: Connecticut replaced its 8
   * counties with 9 planning regions in 2022, and Alaska split Valdez-Cordova
   * in 2020. A level whose eras do not fall on decade lines has to say so, or
   * the app joins data to polygons from the wrong era and renders a confidently
   * wrong map. See docs/geography-notes.md.
   */
  boundaryVintages?: { vintage: number; release: number }[];
  default?: boolean;
  tigerLayer: string;
  /**
   * Which TIGER file carries this level: the per-state one, or the national.
   *
   * Not cosmetic -- TIGER publishes tracts, county subdivisions and places per
   * state, but COUNTIES only in the national file (`cb_2019_39_county_500k.zip`
   * is a 404; `cb_2019_us_county_500k.zip` is not). A state region's county
   * level therefore downloads the national file and filters it by STATEFP.
   * Defaults to the per-state file when the region has a state FIPS.
   */
  tigerScope?: 'state' | 'us';
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
  /**
   * The region this one sits inside, by id.
   *
   * Scope and baseline are separate questions, and this is what separates
   * them. The areas on screen are always this region's; `parent` says which
   * OTHER region's published totals may be offered as an alternative 100%
   * line, so Franklin County can be read against Ohio's metro or against the
   * country without rebuilding anything. Chains: a metro may point at a state
   * which points at the nation.
   */
  parent?: string;
  /**
   * Override the map's opening view, as [west, south, east, north].
   *
   * The app fits to the data's own bounding box by default, which is what
   * makes adding a city a config-only change. Declare this ONLY where that box
   * is not the truth about the region -- geometry crossing the antimeridian is
   * the case that forces it (see regions/us.json), not a preference about
   * framing.
   */
  fitBounds?: [number, number, number, number];
  /**
   * Open this region on a cold start. Exactly one region should set it; with
   * none, the root index falls back to the first by id, which is an ordering
   * accident rather than a decision.
   */
  default?: boolean;
  /**
   * State and county FIPS. Both are absent for a NATIONAL region, whose levels
   * are fetched with no `in=` scope at all -- so every use of them must be
   * guarded rather than assumed.
   */
  state?: string;
  counties?: { fips: string; name: string }[];
  geoLevels: GeoLevelDef[];
  years: { dataset: string; min: number; max: number };
}

const root = new URL('../config/', import.meta.url);

export interface StateEntry {
  id: string;
  label: string;
  fips: string;
}

/**
 * The 50 states + DC, generated from the live API rather than transcribed.
 * See the _doc field in states.json.
 */
export async function loadStates(): Promise<StateEntry[]> {
  const raw = await readFile(new URL('states.json', root), 'utf8');
  return (JSON.parse(raw) as { states: StateEntry[] }).states;
}

/**
 * A region definition, from its own file or expanded from the state template.
 *
 * An explicit file always wins, so any single state can be overridden (Alaska
 * needs its own fitBounds) without giving up the shared template for the other
 * fifty. Fifty-one near-identical files would mean fifty-one edits every time
 * a level changes; the template makes that one edit.
 */
export async function loadRegion(id: string): Promise<RegionDef> {
  try {
    const raw = await readFile(new URL(`regions/${id}.json`, root), 'utf8');
    return JSON.parse(raw) as RegionDef;
  } catch {
    /* no explicit file -- fall through to the state template */
  }

  const state = (await loadStates()).find((s) => s.id === id);
  if (!state) {
    throw new Error(
      `Unknown region "${id}". Add etl/config/regions/${id}.json, or use a state id from states.json.`,
    );
  }

  const template = JSON.parse(
    await readFile(new URL('regions/_state-template.json', root), 'utf8'),
  ) as Omit<RegionDef, 'id' | 'label' | 'state' | 'center' | 'zoom'>;

  return {
    ...template,
    id: state.id,
    label: state.label,
    state: state.fips,
    // Placeholders. The map fits to the data's own bounding box, and the ETL
    // records the real one from the built geometry -- so no state's centre is
    // hand-typed, and none can be quietly wrong.
    center: [-98.5795, 39.8283],
    zoom: 6,
  };
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

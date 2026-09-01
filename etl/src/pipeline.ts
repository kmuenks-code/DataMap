import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  availableIn,
  loadLayers,
  loadMetrics,
  loadRegion,
  orderMetrics,
  variablesFor,
} from './config.ts';
import type { GeoLevelDef, LayerDef, MetricDef, RegionDef } from './config.ts';
import { MAX_VARS_PER_CALL, fetchCensus, parseEstimate } from './sources/census/client.ts';
import { placeGeoidsForRegion, restrictPlaces } from './sources/census/places.ts';
import { isUsState } from './sources/census/states.ts';
import { boundaryVintageForYear, canonicalGeoid } from './transform/crosswalk.ts';
import {
  coefficientOfVariation,
  computeBaseline,
  toIndex,
  type AreaValue,
} from './transform/normalize.ts';
import { mergeMetricFile } from './transform/merge.ts';
import { round, type ManifestLayer, type MetricFile } from './transform/pack.ts';

const OUT = new URL('../../public/data/', import.meta.url);

export interface RunOptions {
  region: string;
  metrics?: string[];
  years?: number[];
  geoLevels?: string[];
}

/**
 * Which hierarchy components make up a geography's GEOID, by its Census name.
 *
 * This is a property of the GEOGRAPHY, not of how it was fetched. Getting that
 * backwards is a silent-wrong-map bug: a tract fetched one county at a time and
 * the same tract fetched statewide are the same tract and must produce the same
 * 11-character key, even though the two requests look nothing alike.
 *
 * A place is the odd one out and the reason this table exists -- it does NOT
 * nest inside a county (Dublin spans three), so its GEOID is state+place with
 * no county component, and TIGER builds it the same way.
 */
const GEOID_PARTS: Record<string, string[]> = {
  state: ['state'],
  county: ['state', 'county'],
  place: ['state', 'place'],
  tract: ['state', 'county', 'tract'],
  'county subdivision': ['state', 'county', 'county subdivision'],
  'zip code tabulation area': ['zip code tabulation area'],
};

/**
 * The join key to TIGER geometry, assembled from the hierarchy this geography
 * actually has.
 *
 * Returns null when any component is missing from the row, so a malformed
 * response drops the row rather than producing a short key that matches the
 * wrong polygon.
 */
export function geoidOf(row: Record<string, string>, level: GeoLevelDef): string | null {
  const unit = level.censusFor.split(':')[0]!;
  const parts = GEOID_PARTS[unit];
  if (!parts) {
    throw new Error(
      `[geoid] unknown geography "${unit}" in censusFor "${level.censusFor}". ` +
        'Add it to GEOID_PARTS with the hierarchy its GEOID is built from.',
    );
  }
  const values = parts.map((p) => row[p]);
  return values.every(Boolean) ? values.join('') : null;
}

/** Census NAME is verbose ("Census Tract 1.10; Franklin County; Ohio"); keep the leading segment. */
function shortName(name: string): string {
  return (name.split(';')[0] ?? name).replace(/,.*$/, '').trim();
}

/**
 * One request per (year, scope) carrying EVERY variable for every metric.
 * This batching is what keeps a full 16-year build at ~180 requests instead of
 * a few thousand -- see the arithmetic in sources/census/acs.ts.
 *
 * "Scope" is per level: one call per county for county-nested levels, a single
 * statewide call for places.
 */
async function fetchYear(
  region: RegionDef,
  level: GeoLevelDef,
  year: number,
  vars: string[],
  allowedGeoids: Set<string> | null,
): Promise<Map<string, Record<string, string>>> {
  const chunks: string[][] = [];
  for (let i = 0; i < vars.length; i += MAX_VARS_PER_CALL) {
    chunks.push(vars.slice(i, i + MAX_VARS_PER_CALL));
  }

  // County-nested levels need one call per county. State-scoped levels (places)
  // are ONE call for the whole state -- cheaper, but it returns every place in
  // Ohio, so the region filter below is not optional. A national region has no
  // scope at all: `for=state:*` with no `in=` is the whole country in one call.
  //
  // `undefined` here means "send no in= clause", which is NOT the same as an
  // empty object -- an empty `in=` is a 400.
  const scopes: (Record<string, string> | undefined)[] =
    level.censusIn === 'us'
      ? [undefined]
      : level.censusIn === 'state'
        ? [{ state: requireState(region) }]
        : requireCounties(region).map((c) => ({ state: requireState(region), county: c.fips }));

  const merged = new Map<string, Record<string, string>>();
  for (const inClause of scopes) {
    for (const chunk of chunks) {
      const rows = await fetchCensus({
        year,
        dataset: region.years.dataset,
        get: chunk,
        forClause: level.censusFor,
        inClause,
      });
      for (const row of rows) {
        const raw = geoidOf(row, level);
        if (!raw) continue;
        // A renamed county is the same ground under a new code; folding it here
        // keeps one continuous series instead of two truncated ones, and keeps
        // the older years joined to a polygon that actually exists.
        const geoid = canonicalGeoid(raw);
        merged.set(geoid, { ...(merged.get(geoid) ?? {}), ...row });
      }
    }
  }

  // Territories come back from `for=state:*` but are absent from the `us:1`
  // baseline, so they are dropped here rather than mapped against a yardstick
  // that excludes them. Logged, never silent -- see sources/census/states.ts.
  if (level.restrictBy === 'us-states') {
    const before = merged.size;
    for (const geoid of [...merged.keys()]) {
      // The state FIPS is the leading 2 chars at every level, so one rule
      // covers states (geoid "72") and counties within them ("72001") alike.
      if (!isUsState(geoid.slice(0, 2))) merged.delete(geoid);
    }
    if (merged.size !== before) {
      console.log(
        `    ${year}: ${merged.size} areas kept (dropped ${before - merged.size} territory ` +
          `row(s), which the us:1 baseline does not cover)`,
      );
    }
  }

  return allowedGeoids ? restrictPlaces(merged, allowedGeoids, String(year)) : merged;
}

/**
 * State/county FIPS are optional on RegionDef because a national region has
 * neither. Reaching for them anyway is a config error in the geo level, not a
 * runtime condition to paper over with a fallback -- a silent `state:undefined`
 * would become a 400 from the API with nothing pointing back to the cause.
 */
function requireState(region: RegionDef): string {
  if (!region.state) {
    throw new Error(
      `[${region.id}] a geo level asked for a state-scoped fetch, but the region ` +
        `declares no "state". National levels must set censusIn: "us".`,
    );
  }
  return region.state;
}

function requireCounties(region: RegionDef): { fips: string; name: string }[] {
  if (!region.counties?.length) {
    throw new Error(
      `[${region.id}] a geo level asked for a county-scoped fetch, but the region ` +
        `declares no "counties". National levels must set censusIn: "us".`,
    );
  }
  return region.counties;
}

/**
 * The geography whose PUBLISHED figures define this region's 100% line.
 *
 * The index is `100 * area / baseline`, and the baseline has to be a real
 * published estimate for the whole region -- not something reassembled from
 * the areas on screen, which rule 1 forbids for medians outright. Which
 * geography that is follows from the region's kind, so a new region gets a
 * correct baseline from config alone.
 */
function baselineForClause(region: RegionDef): string | null {
  switch (region.kind) {
    case 'national':
      // Note that us:1 covers the 50 states + DC and EXCLUDES the territories;
      // the state level drops them to match. See sources/census/states.ts.
      return 'us:1';
    case 'state':
      return region.state ? `state:${region.state}` : null;
    case 'metro':
      return region.cbsa
        ? `metropolitan statistical area/micropolitan statistical area:${region.cbsa}`
        : null;
  }
}

/** The published region-level value -- the only correct baseline for medians. */
async function fetchPublishedBaseline(
  region: RegionDef,
  year: number,
  variable: string,
): Promise<number | null> {
  const forClause = baselineForClause(region);
  if (!forClause) return null;
  const rows = await fetchCensus({
    year,
    dataset: region.years.dataset,
    get: [variable],
    forClause,
  });
  return parseEstimate(rows[0]?.[variable]);
}

/**
 * The metro rate, pooled from the CBSA's own published numerator and
 * denominator rather than from the areas on screen.
 *
 * Needed by levels that do not tile the region. `computeBaseline` pools a rate
 * over whatever areas it is handed, which is exactly right for tracts and
 * county subdivisions -- they cover the metro completely, so pooling them IS
 * the metro. Places cover 78% of it. Pooling those would pin 100 to "the rate
 * among people who live in an incorporated place", so every unincorporated
 * township would be measured against a yardstick that excludes it, and the
 * number on the legend would no longer be the metro figure it claims to be.
 */
async function fetchPublishedRateBaseline(
  region: RegionDef,
  year: number,
  m: MetricDef,
): Promise<number | null> {
  const forClause = baselineForClause(region);
  if (!forClause) return null;
  const s = m.source;
  const vars = [
    ...(s.numeratorSum ?? (s.numerator ? [s.numerator] : [])),
    ...(s.denominator ? [s.denominator] : []),
  ];
  if (vars.length === 0) return null;

  const rows = await fetchCensus({
    year,
    dataset: region.years.dataset,
    get: vars,
    forClause,
  });
  // extract() already knows how to fold numeratorSum and divide; reusing it
  // keeps the baseline row and the area rows on exactly one code path.
  return extract(m, rows[0]).value;
}

/** Pull one metric's numbers out of a raw row, respecting its shape. */
function extract(m: MetricDef, row: Record<string, string> | undefined): AreaValue {
  const empty: AreaValue = { geoid: '', value: null };
  if (!row) return empty;
  const s = m.source;

  if (s.value) {
    return { geoid: '', value: parseEstimate(row[s.value]), moe: parseEstimate(row[s.moe ?? '']) };
  }

  // Rate: keep numerator and denominator so the metro baseline can aggregate correctly.
  let num: number | null = null;
  if (s.numeratorSum) {
    let acc = 0;
    let seen = false;
    for (const v of s.numeratorSum) {
      const parsed = parseEstimate(row[v]);
      if (parsed != null) {
        acc += parsed;
        seen = true;
      }
    }
    num = seen ? acc : null;
  } else if (s.numerator) {
    num = parseEstimate(row[s.numerator]);
  }

  const den = s.denominator ? parseEstimate(row[s.denominator]) : null;
  const value = num != null && den != null && den > 0 ? (num / den) * 100 : null;
  return { geoid: '', value, numerator: num, denominator: den };
}

/**
 * Does this level's fetch return ground outside the region?
 *
 * Scope is decided by censusIn; coverage by the region's kind. They line up
 * only when a state region fetches statewide -- a national region fetched with
 * no scope still returns territories, which the `us:1` baseline excludes.
 */
export function scopeExceedsRegion(
  region: Pick<RegionDef, 'kind'>,
  level: Pick<GeoLevelDef, 'censusIn' | 'restrictBy'>,
): boolean {
  if (level.restrictBy) return false;
  if (level.censusIn === 'state') return region.kind !== 'state';
  if (level.censusIn === 'us') return true;
  return false; // county-scoped: the counties ARE the region
}

export async function runPipeline(opts: RunOptions): Promise<void> {
  const region = await loadRegion(opts.region);
  const layers = await loadLayers();
  // orderMetrics also drops metrics whose layer is disabled, so a layer can be
  // switched off in config without deleting its registry entries.
  const allMetrics = orderMetrics(await loadMetrics(), layers);

  const metrics = opts.metrics?.length
    ? allMetrics.filter((m) => opts.metrics!.includes(m.id))
    : allMetrics;
  if (metrics.length === 0) throw new Error('No metrics matched the --metric filter');

  const levels = region.geoLevels.filter(
    (l) => l.enabled !== false && (!opts.geoLevels?.length || opts.geoLevels.includes(l.id)),
  );

  const allYears: number[] = [];
  for (let y = region.years.min; y <= region.years.max; y++) allYears.push(y);
  const years = opts.years?.length ? allYears.filter((y) => opts.years!.includes(y)) : allYears;

  for (const level of levels) {
    console.log(`\n=== ${region.id} / ${level.id} ===`);

    // A fetch that reaches beyond the region must say how it is cut back down.
    // Failing loudly beats shipping a map of all 1,265 Ohio places labelled
    // "Greater Columbus", or a national one that quietly includes territories
    // the baseline omits.
    //
    // The exception is a state region fetched with in=state:XX, where the
    // response IS the region exactly -- there is nothing to cut, and demanding
    // a restrictBy there would be ceremony rather than a check.
    if (scopeExceedsRegion(region, level)) {
      throw new Error(
        `Geo level "${level.id}" fetches beyond ${region.id} (censusIn: "${level.censusIn}") ` +
          'but declares no restrictBy; it would pull in areas outside the region.',
      );
    }
    const allowedGeoids =
      level.restrictBy === 'place-by-county' ? await placeGeoidsForRegion(region) : null;
    if (allowedGeoids) console.log(`  ${allowedGeoids.size} places in region`);

    const rowsByYear = new Map<number, Map<string, Record<string, string>>>();

    for (const year of years) {
      // Deliberately keyed on ALL registered metrics, not the --metric filter.
      // The response cache keys on the exact `get=` string, so letting the
      // filter narrow this would make every filtered run miss the cache and
      // re-fetch. Fetching the year's full superset keeps the cache
      // filter-independent: a narrowed re-run costs zero requests.
      const active = allMetrics.filter((m) => availableIn(m, year));
      if (active.length === 0) continue;
      const vars = [...new Set(active.flatMap(variablesFor))];
      process.stdout.write(`  ${year} (${vars.length} vars) ... `);
      const rows = await fetchYear(region, level, year, vars, allowedGeoids);
      rowsByYear.set(year, rows);
      console.log(`${rows.size} areas`);
    }

    // Geoid universe: union across years, sorted. An area missing in a given
    // year gets null rather than being dropped, so boundary changes show up as
    // visible gaps instead of silently reshaping the map.
    const geoids = [...new Set([...rowsByYear.values()].flatMap((m) => [...m.keys()]))].sort();
    // The MOST RECENT year's name wins, not the first one seen. A renamed area
    // keeps its old label otherwise: Kusilvak Census Area and Oglala Lakota
    // County would both still be shown under the names they were given up in
    // 2015, which is worse than a missing label rather than merely stale.
    const byYearDesc = [...rowsByYear.entries()].sort((a, b) => b[0] - a[0]);
    const names = geoids.map((g) => {
      for (const [, rows] of byYearDesc) {
        const n = rows.get(g)?.['NAME'];
        if (n) return shortName(n);
      }
      return g;
    });

    for (const m of metrics) {
      const metricYears = years.filter((y) => availableIn(m, y) && rowsByYear.has(y));
      if (metricYears.length === 0) continue;

      const values: (number | null)[][] = [];
      const index: (number | null)[][] = [];
      const cv: (number | null)[][] = [];
      const baselines: (number | null)[] = [];
      let anyMoe = false;

      for (const year of metricYears) {
        const rows = rowsByYear.get(year)!;
        const areas: AreaValue[] = geoids.map((g) => ({ ...extract(m, rows.get(g)), geoid: g }));

        // Medians always come from the published CBSA figure (rule 1: never
        // average medians). Rates come from the CBSA too when this level does
        // not tile the region -- see fetchPublishedRateBaseline.
        const published =
          m.baseline === 'published' && m.baselineVar
            ? await fetchPublishedBaseline(region, year, m.baselineVar)
            : level.tilesRegion === false && (m.kind === 'rate' || m.kind === 'ratio')
              ? await fetchPublishedRateBaseline(region, year, m)
              : null;
        const baseline = computeBaseline(m.kind, areas, published);
        baselines.push(round(baseline, 3));

        values.push(areas.map((a) => round(a.value, m.kind === 'rate' ? 2 : 0)));
        index.push(areas.map((a) => round(toIndex(a.value, baseline), 1)));

        cv.push(
          areas.map((a) => {
            const c = coefficientOfVariation(a.value, a.moe ?? null);
            if (c != null) anyMoe = true;
            return round(c, 3);
          }),
        );
      }

      const boundaryVintageByYear = Object.fromEntries(
        metricYears.map((y) => [String(y), boundaryVintageForYear(y)]),
      );
      const spansVintages = new Set(Object.values(boundaryVintageByYear)).size > 1;

      const notes: string[] = [];
      if (spansVintages) {
        notes.push(
          'Spans multiple census boundary vintages; areas are NOT comparable across a ' +
            'vintage break without a crosswalk. See docs/geography-notes.md.',
        );
      }
      if (level.tilesRegion === false) {
        notes.push(
          'These areas do not cover the whole region -- roughly a fifth of the metro ' +
            'population lives outside any of them. The baseline is the published metro ' +
            'figure, not a total of what is shown, so the mapped areas do not sum to it.',
        );
      }
      if (level.tilesRegion === false && m.kind === 'count') {
        notes.push(
          'Count metrics are indexed against the MEAN area, which at this level mixes a ' +
            'city of 900,000 with villages of 300. Read the raw value, not the index.',
        );
      }

      const file: MetricFile = {
        schema: 1,
        region: region.id,
        geoLevel: level.id,
        metric: m.id,
        layer: m.layer,
        group: m.group,
        kind: m.kind,
        unit: m.unit,
        years: metricYears,
        geoids,
        names,
        baseline: baselines,
        values,
        index,
        ...(anyMoe ? { cv } : {}),
        meta: {
          dataset: region.years.dataset,
          variables: variablesFor(m),
          boundaryVintageByYear,
          notes: notes.length > 0 ? notes : undefined,
        },
      };

      // fileURLToPath, not .pathname -- see the note in util/cache.ts.
      // Layer-namespaced: two sources may both publish "population", and the
      // path is what keeps them from silently overwriting each other.
      const path = fileURLToPath(
        new URL(`regions/${region.id}/metrics/${level.id}/${m.layer}/${m.id}.json`, OUT),
      );
      await mkdir(dirname(path), { recursive: true });

      // Merge rather than overwrite, so a --years/--metric run splices into the
      // existing series instead of truncating it. See transform/merge.ts.
      let prior: MetricFile | null = null;
      try {
        prior = JSON.parse(await readFile(path, 'utf8')) as MetricFile;
      } catch {
        /* first build */
      }
      const merged = mergeMetricFile(file, prior);
      await writeFile(path, JSON.stringify(merged));
      const spliced = prior && merged.years.length > metricYears.length;
      console.log(
        `  wrote ${m.id} (${merged.years.length}y x ${merged.geoids.length} areas` +
          (spliced ? `, spliced ${metricYears.length}y into existing)` : ')'),
      );
    }
  }

  await writeRegionManifest(region, allMetrics, layers);
  await writeBaselines(region);
  await writeRootManifest();
}

/**
 * Rebuild one region's manifest by scanning the output directory rather than by
 * accumulating whatever this run happened to touch.
 *
 * A filtered run (--metric / --geo) previously replaced the manifest with just
 * its own slice, silently hiding every other metric already on disk from the
 * app. Deriving it from reality makes that class of bug impossible.
 *
 * The manifest is emitted as a TREE -- layer > group > metric -- because it is
 * the app's entire navigation model. With nine metrics a flat list would do;
 * with the hundreds this project is heading toward, the picker needs structure
 * to be usable, and structure computed at build time costs the client nothing.
 */
async function writeRegionManifest(
  region: RegionDef,
  allMetrics: MetricDef[],
  layers: LayerDef[],
): Promise<void> {
  const byId = new Map(allMetrics.map((m) => [m.id, m]));

  // metric id -> which geo levels actually produced a file, and which years.
  const built = new Map<string, { years: Set<number>; levels: Set<string> }>();
  const geoLevels: {
    id: string;
    label: string;
    default?: boolean;
    areaCount: number;
    geometryVintages: number[];
    tilesRegion?: boolean;
    note?: string;
  }[] = [];

  for (const level of region.geoLevels) {
    if (level.enabled === false) continue;
    const levelDir = fileURLToPath(new URL(`regions/${region.id}/metrics/${level.id}/`, OUT));

    let layerDirs: string[] = [];
    try {
      layerDirs = (await readdir(levelDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue; // level never built
    }

    let areaCount = 0;
    for (const layerId of layerDirs) {
      const dir = join(levelDir, layerId);
      for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json'))) {
        const parsed = JSON.parse(await readFile(join(dir, file), 'utf8')) as MetricFile;
        if (!byId.has(parsed.metric)) continue; // orphan from a removed entry
        areaCount = Math.max(areaCount, parsed.geoids.length);
        const entry = built.get(parsed.metric) ?? { years: new Set(), levels: new Set() };
        parsed.years.forEach((y) => entry.years.add(y));
        entry.levels.add(level.id);
        built.set(parsed.metric, entry);
      }
    }
    if (areaCount === 0) continue;

    // Which boundary vintages have geometry on disk, so the app can pick the
    // right polygons for the selected year instead of guessing.
    const geomDir = fileURLToPath(new URL(`regions/${region.id}/geometry/${level.id}/`, OUT));
    const geometryVintages = (await readdir(geomDir).catch(() => []))
      .filter((f) => f.endsWith('.topojson'))
      .map((f) => Number(f.replace('.topojson', '')))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    geoLevels.push({
      id: level.id,
      label: level.label,
      ...(level.default ? { default: true } : {}),
      areaCount,
      geometryVintages,
      // Surfaced so the UI can warn that a level has gaps, rather than letting
      // the reader assume the blank ground is missing data.
      ...(level.tilesRegion === false ? { tilesRegion: false } : {}),
      ...(level.note ? { note: level.note } : {}),
    });
  }

  // Which overlays actually have a file, read off disk for the same reason the
  // metric tree is: an overlay listed in the manifest but missing on disk gives
  // the user a toggle that does nothing.
  const overlayDir = fileURLToPath(new URL(`regions/${region.id}/overlays/`, OUT));
  const overlayCounts = new Map<string, number>();
  for (const file of (await readdir(overlayDir).catch(() => [])).filter((f) =>
    f.endsWith('.topojson'),
  )) {
    const topo = JSON.parse(await readFile(join(overlayDir, file), 'utf8')) as {
      objects: Record<string, { geometries?: unknown[] }>;
    };
    const count = Object.values(topo.objects)[0]?.geometries?.length ?? 0;
    overlayCounts.set(file.replace('.topojson', ''), count);
  }

  // Build the layer > group > metric tree, pruning anything empty so the UI
  // never renders a group header with nothing under it.
  const tree: ManifestLayer[] = layers
    .filter((l) => l.enabled)
    .map((l): ManifestLayer => ({
      id: l.id,
      label: l.label,
      kind: l.kind,
      description: l.description,
      attribution: l.provider.attribution,
      ...(l.kind === 'overlay'
        ? { render: l.render, areaCount: overlayCounts.get(l.id) ?? 0 }
        : {
            groups: (l.groups ?? [])
              .map((g) => ({
                id: g.id,
                label: g.label,
                metrics: allMetrics
                  .filter((m) => m.layer === l.id && m.group === g.id && built.has(m.id))
                  .map((m) => {
                    const b = built.get(m.id)!;
                    return {
                      id: m.id,
                      label: m.label,
                      unit: m.unit,
                      kind: m.kind,
                      higherIsBetter: m.higherIsBetter,
                      description: m.description,
                      years: [...b.years].sort((x, y) => x - y),
                      geoLevels: [...b.levels],
                    };
                  }),
              }))
              .filter((g) => g.metrics.length > 0),
          }),
    }))
    .filter((l) =>
      l.kind === 'overlay' ? (l.areaCount ?? 0) > 0 : (l.groups?.length ?? 0) > 0,
    );

  // Centre the map on the geometry rather than on a configured guess. A region
  // may still pin fitBounds explicitly, which is required where the bounding
  // box is not the truth -- geometry crossing the antimeridian. See us.json.
  const defaultLevel =
    region.geoLevels.find((l) => l.enabled !== false && l.default) ??
    region.geoLevels.find((l) => l.enabled !== false);
  const bbox = defaultLevel ? await geometryBbox(region, defaultLevel) : null;
  const center: [number, number] = bbox
    ? [round((bbox[0] + bbox[2]) / 2, 4)!, round((bbox[1] + bbox[3]) / 2, 4)!]
    : region.center;

  if (bbox && bbox[2] - bbox[0] > 180 && !region.fitBounds) {
    console.warn(
      `  WARNING  ${region.id}: geometry spans ${(bbox[2] - bbox[0]).toFixed(0)} degrees of ` +
        'longitude, so it crosses the antimeridian and its bounding box is not a usable ' +
        'map view. Set "fitBounds" in the region config.',
    );
  }

  const dest = fileURLToPath(new URL(`regions/${region.id}/manifest.json`, OUT));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(
    dest,
    JSON.stringify(
      {
        schema: 3,
        generatedAt: new Date().toISOString(),
        id: region.id,
        label: region.label,
        kind: region.kind,
        center,
        zoom: region.zoom,
        ...(region.parent ? { parent: region.parent } : {}),
        ...(region.fitBounds ? { fitBounds: region.fitBounds } : {}),
        ...(region.default ? { default: true } : {}),
        geoLevels,
        layers: tree,
      },
      null,
      2,
    ),
  );

  const count = tree.reduce(
    (n, l) => n + (l.groups?.reduce((k, g) => k + g.metrics.length, 0) ?? 0),
    0,
  );
  const overlayCount = tree.filter((l) => l.kind === 'overlay').length;
  console.log(`
wrote regions/${region.id}/manifest.json (${tree.length} layers, ${count} metrics, ${overlayCount} overlays, ${geoLevels.length} geo levels)`);
}

/**
 * Emit this region's 100% line, per metric per year, as a standalone file.
 *
 * WHY A SEPARATE FILE. The numbers are already inside every metric file, but
 * they are the wrong copy to read: indexing Columbus townships against the
 * nation means fetching the US baseline, and the US county file is ~900 KB to
 * obtain sixteen numbers. This is the same data at a few kilobytes, so the app
 * can offer "compare with the US" without downloading the US.
 *
 * WHICH LEVEL'S BASELINE. A baseline is a property of the region, not of the
 * geography drawn on top of it -- the metro median income is one number
 * whether tracts or townships are on screen. The pipeline nonetheless computes
 * one per level, and they can differ slightly: a level that does not tile the
 * region (places) pulls published figures where a tiling level pools its own
 * areas. The DEFAULT level wins, falling back to the first that tiles, because
 * that is the one whose areas actually cover the region.
 */
/**
 * The region's real extent, read from the geometry that was actually built.
 *
 * Fifty-one hand-typed state centres would be fifty-one chances to be quietly
 * wrong, and nothing would catch it -- a bad centre just opens the map in the
 * wrong place. Deriving it from the polygons means it cannot disagree with what
 * is drawn.
 */
async function geometryBbox(
  region: RegionDef,
  level: GeoLevelDef,
): Promise<[number, number, number, number] | null> {
  const dir = fileURLToPath(new URL(`regions/${region.id}/geometry/${level.id}/`, OUT));
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.topojson')).sort();
  const newest = files[files.length - 1];
  if (!newest) return null;
  const topo = JSON.parse(await readFile(join(dir, newest), 'utf8')) as { bbox?: number[] };
  const b = topo.bbox;
  return b && b.length === 4 ? [b[0]!, b[1]!, b[2]!, b[3]!] : null;
}

async function writeBaselines(region: RegionDef): Promise<void> {
  const level =
    region.geoLevels.find((l) => l.enabled !== false && l.default) ??
    region.geoLevels.find((l) => l.enabled !== false && l.tilesRegion !== false);
  if (!level) return;

  const levelDir = fileURLToPath(new URL(`regions/${region.id}/metrics/${level.id}/`, OUT));
  const metrics: Record<string, { years: number[]; values: (number | null)[] }> = {};

  for (const layerId of (await readdir(levelDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)) {
    const dir = join(levelDir, layerId);
    for (const f of (await readdir(dir)).filter((n) => n.endsWith('.json'))) {
      const parsed = JSON.parse(await readFile(join(dir, f), 'utf8')) as MetricFile;
      metrics[parsed.metric] = { years: parsed.years, values: parsed.baseline };
    }
  }

  const dest = fileURLToPath(new URL(`regions/${region.id}/baselines.json`, OUT));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(
    dest,
    JSON.stringify({
      schema: 1,
      region: region.id,
      label: region.label,
      geoLevel: level.id,
      // No timestamp, for the same reason metric files carry none: this file is
      // committed, so its diff should mean "a baseline moved", nothing else.
      metrics,
    }),
  );
  console.log(
    `wrote regions/${region.id}/baselines.json (${Object.keys(metrics).length} metrics, from ${level.id})`,
  );
}

/**
 * Rebuild the ROOT INDEX from whatever region manifests are on disk.
 *
 * Scanning rather than appending is what makes a single-region run safe. The
 * pre-split manifest was written as `regions: [thisRegion]`, so building a
 * second region would have deleted the first from the app's view -- invisible
 * with one region, a data-loss bug the moment there are fifty-two. A region
 * whose directory is deleted likewise drops out of the index on the next run,
 * with no stale entry left pointing at files that are gone.
 *
 * The index deliberately excludes the layer tree: see the schema 3 note in
 * src/data/types.ts for why that split exists at all.
 */
async function writeRootManifest(): Promise<void> {
  const regionsDir = fileURLToPath(new URL('regions/', OUT));
  const ids = (await readdir(regionsDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  // `default` is read from each region document but NOT re-emitted per row --
  // it collapses into the single defaultRegion field below, so the app has one
  // place to look and cannot find two regions both claiming to be default.
  const regions: ({ id: string; default?: boolean } & Record<string, unknown>)[] = [];
  for (const id of ids) {
    let doc;
    try {
      doc = JSON.parse(await readFile(join(regionsDir, id, 'manifest.json'), 'utf8')) as {
        id: string;
        label: string;
        kind: RegionDef['kind'];
        center: [number, number];
        zoom: number;
        parent?: string;
        default?: boolean;
        geoLevels: unknown[];
        layers: ManifestLayer[];
      };
    } catch {
      continue; // a data directory with no manifest yet is not an error
    }
    regions.push({
      id: doc.id,
      label: doc.label,
      kind: doc.kind,
      center: doc.center,
      zoom: doc.zoom,
      ...(doc.parent ? { parent: doc.parent } : {}),
      ...(doc.default ? { default: true } : {}),
      geoLevelCount: doc.geoLevels.length,
      metricCount: doc.layers.reduce(
        (n, l) => n + (l.groups?.reduce((k, g) => k + g.metrics.length, 0) ?? 0),
        0,
      ),
    });
  }

  await writeFile(
    fileURLToPath(new URL('manifest.json', OUT)),
    JSON.stringify(
      {
        schema: 3,
        generatedAt: new Date().toISOString(),
        // An explicit choice in the region config, so which region opens is a
        // decision rather than a side effect of alphabetical order.
        defaultRegion: regions.find((r) => r.default)?.id ?? regions[0]?.id ?? '',
        regions: regions.map(({ default: _default, ...row }) => row),
      },
      null,
      2,
    ),
  );

  console.log(`wrote manifest.json (${regions.length} region${regions.length === 1 ? '' : 's'})`);
}

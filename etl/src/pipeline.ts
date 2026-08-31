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
import { boundaryVintageForYear } from './transform/crosswalk.ts';
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

/** state+county+tract (or +county subdivision) -- the join key to TIGER geometry. */
function geoidOf(row: Record<string, string>, level: GeoLevelDef): string | null {
  const unit = level.censusFor.split(':')[0]!; // "tract" | "county subdivision"
  const parts = [row['state'], row['county'], row[unit]];
  return parts.every(Boolean) ? parts.join('') : null;
}

/** Census NAME is verbose ("Census Tract 1.10; Franklin County; Ohio"); keep the leading segment. */
function shortName(name: string): string {
  return (name.split(';')[0] ?? name).replace(/,.*$/, '').trim();
}

/**
 * One request per (year, county) carrying EVERY variable for every metric.
 * This batching is what keeps a full 16-year build at ~180 requests instead of
 * a few thousand -- see the arithmetic in sources/census/acs.ts.
 */
async function fetchYear(
  region: RegionDef,
  level: GeoLevelDef,
  year: number,
  vars: string[],
): Promise<Map<string, Record<string, string>>> {
  const chunks: string[][] = [];
  for (let i = 0; i < vars.length; i += MAX_VARS_PER_CALL) {
    chunks.push(vars.slice(i, i + MAX_VARS_PER_CALL));
  }

  const merged = new Map<string, Record<string, string>>();
  for (const county of region.counties) {
    for (const chunk of chunks) {
      const rows = await fetchCensus({
        year,
        dataset: region.years.dataset,
        get: chunk,
        forClause: level.censusFor,
        inClause: { state: region.state, county: county.fips },
      });
      for (const row of rows) {
        const geoid = geoidOf(row, level);
        if (!geoid) continue;
        merged.set(geoid, { ...(merged.get(geoid) ?? {}), ...row });
      }
    }
  }
  return merged;
}

/** The published metro-level value -- the only correct baseline for medians. */
async function fetchPublishedBaseline(
  region: RegionDef,
  year: number,
  variable: string,
): Promise<number | null> {
  if (!region.cbsa) return null;
  const rows = await fetchCensus({
    year,
    dataset: region.years.dataset,
    get: [variable],
    forClause: `metropolitan statistical area/micropolitan statistical area:${region.cbsa}`,
  });
  return parseEstimate(rows[0]?.[variable]);
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
      const rows = await fetchYear(region, level, year, vars);
      rowsByYear.set(year, rows);
      console.log(`${rows.size} areas`);
    }

    // Geoid universe: union across years, sorted. An area missing in a given
    // year gets null rather than being dropped, so boundary changes show up as
    // visible gaps instead of silently reshaping the map.
    const geoids = [...new Set([...rowsByYear.values()].flatMap((m) => [...m.keys()]))].sort();
    const names = geoids.map((g) => {
      for (const rows of rowsByYear.values()) {
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

        const published =
          m.baseline === 'published' && m.baselineVar
            ? await fetchPublishedBaseline(region, year, m.baselineVar)
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
          generatedAt: new Date().toISOString(),
          dataset: region.years.dataset,
          variables: variablesFor(m),
          boundaryVintageByYear,
          notes: spansVintages
            ? [
                'Spans multiple census boundary vintages; areas are NOT comparable across a ' +
                  'vintage break without a crosswalk. See docs/geography-notes.md.',
              ]
            : undefined,
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

  await writeManifest(region, allMetrics, layers);
}

/**
 * Rebuild the manifest by scanning the output directory rather than by
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
async function writeManifest(
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
    });
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
        ? { render: l.render }
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
    .filter((l) => l.kind === 'overlay' || (l.groups?.length ?? 0) > 0);

  await writeFile(
    fileURLToPath(new URL('manifest.json', OUT)),
    JSON.stringify(
      {
        schema: 2,
        generatedAt: new Date().toISOString(),
        regions: [
          {
            id: region.id,
            label: region.label,
            kind: region.kind,
            center: region.center,
            zoom: region.zoom,
            geoLevels,
            layers: tree,
          },
        ],
      },
      null,
      2,
    ),
  );

  const count = tree.reduce(
    (n, l) => n + (l.groups?.reduce((k, g) => k + g.metrics.length, 0) ?? 0),
    0,
  );
  console.log(`
wrote manifest.json (${tree.length} layers, ${count} metrics, ${geoLevels.length} geo levels)`);
}

import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { GeoLevelDef, RegionDef } from '../../config.ts';
import { placeGeoidsForRegion } from '../census/places.ts';
import { FIRST_TERRITORY_FIPS } from '../census/states.ts';

const run = promisify(execFile);
const OUT = new URL('../../../../public/data/', import.meta.url);
const CACHE = fileURLToPath(new URL('../../../.cache/tiger/', import.meta.url));

/**
 * Boundary geometry from TIGER/Line CARTOGRAPHIC boundary files (the `cb_`
 * series), NOT the full TIGER files. The cb files are generalized for display
 * and clipped to shoreline -- an order of magnitude smaller, and they do not
 * strand census tracts in the middle of a reservoir.
 *
 * One file is built PER BOUNDARY VINTAGE, not one per level. Census tracts are
 * redrawn each decade (2009 = 2000 tracts, 2010-2019 = 2010 tracts, 2020+ =
 * 2020 tracts), so a single geometry file cannot serve the whole timeline --
 * the app picks geometry by the selected year's vintage.
 *
 * Rerun only when a vintage is added. Output is committed, so an ordinary
 * build downloads nothing.
 */

/** GENZ release whose boundaries match each decennial vintage. */
const RELEASE_FOR_VINTAGE: Record<number, number> = {
  2020: 2023, // GENZ2023 carries 2020-census boundaries
  2010: 2019, // last GENZ release before the 2020 redraw
};

function sourceUrl(release: number, state: string, layer: string): string {
  return `https://www2.census.gov/geo/tiger/GENZ${release}/shp/cb_${release}_${state}_${layer}_500k.zip`;
}

async function download(url: string, dest: string): Promise<void> {
  try {
    if ((await stat(dest)).size > 0) {
      console.log(`  cached  ${url.split('/').pop()}`);
      return;
    }
  } catch {
    /* not cached */
  }
  console.log(`  fetch   ${url.split('/').pop()}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'geodata-columbus/0.1' } });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  await mkdir(CACHE, { recursive: true });
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
}

/**
 * mapshaper does the clip/simplify/reproject/encode in one pass.
 *
 * TopoJSON rather than GeoJSON because adjacent areas share every border and
 * TopoJSON stores each arc once -- worth 70-80% on tiled geography.
 *
 * `keep-shapes` stops simplification from collapsing the smallest polygons
 * entirely; without it, dense urban tracts vanish at aggressive settings.
 */
async function buildOne(
  region: RegionDef,
  level: GeoLevelDef,
  vintage: number,
  allowedGeoids: Set<string> | null,
  releaseOverride?: number,
): Promise<{ vintage: number; bytes: number; features: number } | null> {
  const release = releaseOverride ?? RELEASE_FOR_VINTAGE[vintage];
  if (!release) {
    console.log(`  skip    ${level.id} vintage ${vintage} (no GENZ release mapped)`);
    return null;
  }

  // TIGER publishes state files as `cb_<release>_<statefp>_<layer>` and the
  // nation-wide ones as `cb_<release>_us_<layer>`. A national region has no
  // state FIPS, and `us` is exactly the file it needs. A level may also force
  // the national file -- counties are published ONLY there. See tigerScope.
  const scope = level.tigerScope === 'us' ? 'us' : (region.state ?? 'us');
  const zip = join(CACHE, `cb_${release}_${scope}_${level.tigerLayer}_500k.zip`);
  await download(sourceUrl(release, scope, level.tigerLayer), zip);

  const work = await mkdtemp(join(tmpdir(), 'tiger-'));
  try {
    await run('npx', ['--yes', 'mapshaper', zip, '-o', join(work, 'in.json'), 'format=geojson'], {
      shell: true,
      maxBuffer: 1024 * 1024 * 256,
    });

    // How the state file is cut down to this region depends on the level.
    //
    // Tract and county-subdivision files carry COUNTYFP, so a county list is
    // enough. The PLACE file does NOT -- verified: its fields are STATEFP,
    // PLACEFP, PLACENS, GEOIDFQ, GEOID, NAME, NAMELSAD, STUSPS, STATE_NAME,
    // LSAD, ALAND, AWATER. There is nothing to filter on but GEOID, which is
    // the same reason the data side needs the relationship file. Both sides use
    // ONE allowlist, so geometry and data can never disagree about membership.
    // How the source file is cut down to the region, by level:
    //   - an explicit allowlist (places), matched on GEOID;
    //   - the territory rule (national), which is a numeric threshold rather
    //     than a list precisely so no roster of FIPS codes can go stale --
    //     it must agree with isUsState(), which filters the DATA side;
    //   - otherwise the region's county list, matched on COUNTYFP.
    const counties = region.counties?.map((c) => c.fips) ?? [];
    const filterExpr = allowedGeoids
      ? `${JSON.stringify([...allowedGeoids])}.indexOf(GEOID) > -1`
      : level.restrictBy === 'us-states'
        ? // STATEFP rather than GEOID, so one expression serves every national
          // level: a state's GEOID is 2 chars but a county's is 5, and
          // `+GEOID < 60` retains nothing at county level (measured: 0 of 3,233).
          `+STATEFP < ${FIRST_TERRITORY_FIPS}`
        : counties.length > 0
          ? `${JSON.stringify(counties)}.indexOf(COUNTYFP) > -1`
          : scope === 'us' && region.state
            ? // A state region reading the NATIONAL file (counties) must cut it
              // down to its own state.
              `STATEFP === ${JSON.stringify(region.state)}`
            : // Otherwise the per-state file already IS the region and needs no
              // clipping. Filtering on an empty county list would retain
              // nothing at all, silently producing empty geometry.
              null;
    const outDir = fileURLToPath(new URL(`regions/${region.id}/geometry/${level.id}/`, OUT));
    await mkdir(outDir, { recursive: true });
    const outFile = join(outDir, `${vintage}.topojson`);

    await run(
      'npx',
      [
        '--yes',
        'mapshaper',
        join(work, 'in.json'),
        ...(filterExpr ? ['-filter', JSON.stringify(filterExpr)] : []),
        '-each',
        JSON.stringify('geoid = GEOID, name = NAME'),
        '-filter-fields',
        'geoid,name',
        '-simplify',
        level.simplify,
        'keep-shapes',
        '-proj',
        'wgs84',
        '-o',
        outFile,
        'format=topojson',
        // The file carries its own bounding box so the ETL can derive the
        // region's map view from real geometry instead of a hand-typed centre.
        'bbox',
        'quantization=1e5',
        `id-field=geoid`,
      ],
      { shell: true, maxBuffer: 1024 * 1024 * 256 },
    );

    const { size } = await stat(outFile);
    const topo = JSON.parse(await (await import('node:fs/promises')).readFile(outFile, 'utf8')) as {
      objects: Record<string, { geometries?: unknown[] }>;
    };
    const features = Object.values(topo.objects)[0]?.geometries?.length ?? 0;
    console.log(
      `  built   ${level.id}/${vintage}.topojson  ${features} areas, ${(size / 1024).toFixed(0)} KB`,
    );
    return { vintage, bytes: size, features };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function buildGeometry(region: RegionDef, vintages: number[]): Promise<void> {
  for (const level of region.geoLevels) {
    if (level.enabled === false) continue;
    console.log(`\n--- geometry: ${level.id} ---`);
    // ONE allowlist drives both the data and the geometry side, so the two can
    // never disagree about which areas are in the region.
    const allowedGeoids =
      level.restrictBy === 'place-by-county' ? await placeGeoidsForRegion(region) : null;

    // A level may declare its own eras when they are not decadal -- see the
    // Connecticut and Alaska cases in config.ts.
    const levelVintages = level.boundaryVintages?.map((v) => v.vintage) ?? vintages;
    const releaseFor = new Map((level.boundaryVintages ?? []).map((v) => [v.vintage, v.release]));

    for (const vintage of levelVintages) {
      await buildOne(region, level, vintage, allowedGeoids, releaseFor.get(vintage));
    }
  }
  await readdir(CACHE).catch(() => []);
}

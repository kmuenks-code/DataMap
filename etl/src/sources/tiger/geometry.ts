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
): Promise<{ vintage: number; bytes: number; features: number } | null> {
  const release = RELEASE_FOR_VINTAGE[vintage];
  if (!release) {
    console.log(`  skip    ${level.id} vintage ${vintage} (no GENZ release mapped)`);
    return null;
  }

  const zip = join(CACHE, `cb_${release}_${region.state}_${level.tigerLayer}_500k.zip`);
  await download(sourceUrl(release, region.state, level.tigerLayer), zip);

  const work = await mkdtemp(join(tmpdir(), 'tiger-'));
  try {
    await run('npx', ['--yes', 'mapshaper', zip, '-o', join(work, 'in.json'), 'format=geojson'], {
      shell: true,
      maxBuffer: 1024 * 1024 * 256,
    });

    const counties = region.counties.map((c) => c.fips);
    const outDir = fileURLToPath(new URL(`regions/${region.id}/geometry/${level.id}/`, OUT));
    await mkdir(outDir, { recursive: true });
    const outFile = join(outDir, `${vintage}.topojson`);

    await run(
      'npx',
      [
        '--yes',
        'mapshaper',
        join(work, 'in.json'),
        '-filter',
        JSON.stringify(`${JSON.stringify(counties)}.indexOf(COUNTYFP) > -1`),
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
    for (const vintage of vintages) {
      await buildOne(region, level, vintage);
    }
  }
  await readdir(CACHE).catch(() => []);
}

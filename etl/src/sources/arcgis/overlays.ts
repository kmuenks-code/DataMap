import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { LayerDef, RegionDef } from '../../config.ts';

const run = promisify(execFile);
const OUT = new URL('../../../../public/data/', import.meta.url);
const CACHE = fileURLToPath(new URL('../../../.cache/arcgis/', import.meta.url));

/**
 * Overlay geometry from ArcGIS REST services.
 *
 * Overlays are NOT measurements. They carry no index, no baseline and no
 * timeline -- they are labelled outlines drawn over whatever metric is active,
 * to answer "which part of town is this?". That is why they live outside the
 * metric pipeline entirely and produce a different file shape.
 *
 * They deliberately do NOT nest inside census geography. Columbus's community
 * boundaries follow streets, rivers and historical lines, not tract edges, so
 * statistics are never recomputed onto them -- doing that would require areal
 * interpolation and would invent precision the source does not have. They are
 * display-only, and the UI must not imply otherwise.
 *
 * Fetched at BUILD time and committed, like everything else: the browser reads
 * static TopoJSON from its own origin and never learns this service exists.
 */

/** ArcGIS caps a single response; keep paging until it stops saying there is more. */
async function fetchAllFeatures(url: string, fields: string[]): Promise<GeoJsonFC> {
  const features: unknown[] = [];
  let offset = 0;

  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: fields.join(','),
      outSR: '4326',
      f: 'geojson',
      resultOffset: String(offset),
    });
    const res = await fetch(`${url}/query?${params.toString()}`, {
      headers: { 'User-Agent': 'geodata-columbus/0.1' },
    });
    if (!res.ok) throw new Error(`[arcgis] ${res.status} ${res.statusText} for ${url}`);

    const body = await res.text();
    // Same failure mode as the Census API: an error arrives as 200 + HTML.
    if (body.trimStart().startsWith('<')) {
      throw new Error(`[arcgis] HTTP 200 with an HTML body for ${url}`);
    }
    const json = JSON.parse(body) as GeoJsonFC & { exceededTransferLimit?: boolean };
    const batch = json.features ?? [];
    features.push(...batch);

    if (!json.exceededTransferLimit || batch.length === 0) break;
    offset += batch.length;
  }

  if (features.length === 0) throw new Error(`[arcgis] no features returned by ${url}`);
  return { type: 'FeatureCollection', features };
}

interface GeoJsonFC {
  type: 'FeatureCollection';
  features: unknown[];
}

/**
 * Build one overlay file. Returns null for layers this region has no source
 * for, which is the normal case -- Columbus's community boundaries mean nothing
 * in another metro, and a region without them should simply not show the layer.
 */
export async function buildOverlay(
  region: RegionDef,
  layer: LayerDef,
): Promise<{ features: number; bytes: number } | null> {
  const src = layer.source;
  if (!src || src.type !== 'arcgis') return null;
  if (src.regions && !src.regions.includes(region.id)) return null;

  // Cache the raw response so a rebuild costs no requests, matching the Census
  // path. Unlike ACS vintages this source CAN change, so it is refreshed by
  // deleting the cache file rather than automatically.
  const cachePath = join(CACHE, `${layer.id}.geojson`);
  let raw: string;
  try {
    raw = await readFile(cachePath, 'utf8');
    console.log(`  cached  ${layer.id}`);
  } catch {
    console.log(`  fetch   ${layer.id}  <- ${src.url}`);
    const fc = await fetchAllFeatures(src.url, [src.nameField]);
    raw = JSON.stringify(fc);
    await mkdir(CACHE, { recursive: true });
    await writeFile(cachePath, raw);
  }

  const work = await mkdtemp(join(tmpdir(), 'overlay-'));
  try {
    const inFile = join(work, 'in.geojson');
    await writeFile(inFile, raw);

    const outDir = fileURLToPath(new URL(`regions/${region.id}/overlays/`, OUT));
    await mkdir(outDir, { recursive: true });
    const outFile = join(outDir, `${layer.id}.topojson`);

    await run(
      'npx',
      [
        '--yes',
        'mapshaper',
        inFile,
        // Rename to a stable field the app can read without knowing which
        // service this came from -- the same reason metric files never record
        // their upstream. Only the name survives: the source tables carry
        // volunteer names, emails and phone numbers on some layers, and none of
        // that belongs in a public bundle.
        '-each',
        JSON.stringify(`name = ${src.nameField}`),
        '-filter-fields',
        'name',
        '-simplify',
        src.simplify ?? '8%',
        'keep-shapes',
        '-proj',
        'wgs84',
        '-o',
        outFile,
        'format=topojson',
        'quantization=1e5',
      ],
      { shell: true, maxBuffer: 1024 * 1024 * 256 },
    );

    const { size } = await stat(outFile);
    const topo = JSON.parse(await readFile(outFile, 'utf8')) as {
      objects: Record<string, { geometries?: unknown[] }>;
    };
    const features = Object.values(topo.objects)[0]?.geometries?.length ?? 0;
    console.log(`  built   overlays/${layer.id}.topojson  ${features} areas, ${(size / 1024).toFixed(0)} KB`);
    return { features, bytes: size };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function buildOverlays(region: RegionDef, layers: LayerDef[]): Promise<string[]> {
  const built: string[] = [];
  const overlays = layers.filter((l) => l.kind === 'overlay' && l.enabled);
  if (overlays.length === 0) return built;

  console.log(`\n--- overlays ---`);
  for (const layer of overlays) {
    const result = await buildOverlay(region, layer);
    if (result) built.push(layer.id);
  }
  return built;
}

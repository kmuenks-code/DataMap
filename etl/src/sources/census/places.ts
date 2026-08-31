import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { RegionDef } from '../../config.ts';

const CACHE = fileURLToPath(new URL('../../../.cache/geo/', import.meta.url));

/**
 * The Census place/county relationship file.
 *
 * Places are the one Census geography that does NOT nest inside a county --
 * Dublin city spans Franklin, Delaware and Union -- so the API refuses to
 * scope a place query by county and `for=place:*&in=state:39` hands back all
 * 1,265 Ohio places. Something has to say which of them are in this metro.
 *
 * This file is that something: one pipe-delimited national table listing every
 * (place, county) pair, so membership is DERIVED at build time rather than
 * frozen into a hand-maintained list of FIPS codes that silently goes stale
 * when a village incorporates.
 *
 * Verified 2026-08-31: the 137 places it yields for the 10-county Columbus MSA
 * match, one for one, the 137 found by querying summary level 070 across all
 * 181 county subdivisions -- at 1 request instead of 181.
 */
const REL_URL =
  'https://www2.census.gov/geo/docs/reference/codes2020/national_place_by_county2020.txt';

/**
 * 2020 vintage, used for BOTH geometry vintages.
 *
 * There is no 2010-vintage equivalent published at a stable URL. Place codes
 * are near-static decade to decade, so the 2020 table is a sound filter for
 * 2010-era geometry too; the cost is that a place dissolved before 2020 would
 * be missed. Places created after 2020 are likewise absent -- one exists in
 * this metro already: Hidden Lakes CDP moved from 35133 to 35119 between the
 * 2020 and 2023 vintages. Its population is 0, so it is dropped harmlessly,
 * but `restrictPlaces` logs any such drop rather than hiding it.
 */
async function relationshipFile(): Promise<string> {
  const path = join(CACHE, 'national_place_by_county2020.txt');
  try {
    const hit = await readFile(path, 'utf8');
    if (hit.length > 0) return hit;
  } catch {
    /* miss */
  }

  const res = await fetch(REL_URL, { headers: { 'User-Agent': 'geodata-columbus/0.1' } });
  if (!res.ok) throw new Error(`[places] ${res.status} ${res.statusText} for ${REL_URL}`);
  const body = await res.text();

  // Same trap as the Census API: an error page arrives as HTTP 200 + HTML.
  if (body.trimStart().startsWith('<')) {
    throw new Error(`[places] HTTP 200 with an HTML body for ${REL_URL}`);
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return body;
}

/**
 * Every place GEOID (state FIPS + place FIPS, 7 chars) with any territory in
 * the region's counties. A place straddling the metro boundary is INCLUDED in
 * full -- its published ACS estimate covers the whole municipality, and
 * clipping the polygon to the county line while keeping the whole-city number
 * would put a value on ground it does not describe.
 */
export async function placeGeoidsForRegion(region: RegionDef): Promise<Set<string>> {
  const geoids = parsePlaceCounty(
    await relationshipFile(),
    region.state,
    region.counties.map((c) => c.fips),
  );
  if (geoids.size === 0) {
    throw new Error(`[places] no places found for region ${region.id} -- check state/county FIPS`);
  }
  return geoids;
}

/**
 * Pure parser, split out so it can be tested without the network.
 *
 * Columns are located BY NAME, never by position. This is an external file
 * whose column order is not a contract, and an off-by-one would yield a
 * plausible-looking set of WRONG place codes rather than an error -- the map
 * would render confidently with the wrong cities on it.
 */
export function parsePlaceCounty(text: string, state: string, counties: string[]): Set<string> {
  const wanted = new Set(counties);
  const geoids = new Set<string>();

  const lines = text.split(/\r?\n/);
  const header = lines[0]?.split('|') ?? [];
  const col = (name: string) => header.indexOf(name);
  const [iState, iCounty, iPlace] = [col('STATEFP'), col('COUNTYFP'), col('PLACEFP')];
  if (iState < 0 || iCounty < 0 || iPlace < 0) {
    throw new Error(`[places] unexpected header in relationship file: ${lines[0]}`);
  }

  for (const line of lines.slice(1)) {
    if (!line) continue;
    const f = line.split('|');
    if (f[iState] !== state || !wanted.has(f[iCounty] ?? '')) continue;
    geoids.add(`${f[iState]}${f[iPlace]}`);
  }
  return geoids;
}

/**
 * Keep only rows whose geoid is in the region, reporting what was dropped.
 *
 * Silence here would be the dangerous outcome: a newly incorporated place, or
 * one whose FIPS code was reassigned, would simply never appear on the map and
 * nothing would say so.
 */
export function restrictPlaces<T>(
  rows: Map<string, T>,
  allowed: Set<string>,
  label: string,
): Map<string, T> {
  const kept = new Map<string, T>();
  let dropped = 0;
  for (const [geoid, row] of rows) {
    if (allowed.has(geoid)) kept.set(geoid, row);
    else dropped++;
  }
  // Statewide minus this metro is the expected bulk of the drop; only an
  // unexpectedly small remainder is worth a reader's attention.
  if (kept.size < allowed.size) {
    console.log(
      `    ${label}: ${kept.size}/${allowed.size} places present (${dropped} statewide rows dropped)`,
    );
  }
  return kept;
}

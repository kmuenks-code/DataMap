/**
 * MEDSL county presidential returns, 2000-2024.
 *
 * Source: MIT Election Data and Science Lab, "County Presidential Election
 * Returns 2000-2024", Harvard Dataverse, doi:10.7910/DVN/VOQCHQ. CC0 1.0.
 *
 * WHY COUNTY AND NOT PRECINCT. Election results are reported natively by
 * precinct, and precincts nest inside nothing this project draws -- not tracts,
 * not county subdivisions, not places. The county is the canvassing unit
 * everywhere, so it is the one geography where election data and census data
 * describe the same polygons without interpolation. See docs/data-sources.md
 * for what the sub-county route would cost.
 *
 * The file is one row per (year, county, candidate, mode). Getting a county
 * total out of it is not a sum -- see collapse() -- and four of its quirks are
 * load-bearing enough to be measured rather than assumed. All figures below were
 * VERIFIED 2026-09-02 against the released file (version 20260225).
 */
import { canonicalGeoid } from '../../transform/crosswalk.ts';
import { fetchDataverseFile } from './dataverse.ts';

/** doi:10.7910/DVN/VOQCHQ, file "countypres_2000-2024.csv", dataset version 20. */
const FILE_ID = 13573089;
const VENDOR_NAME = 'countypres_2000-2024.csv';

/** Presidential years present in the file. Not derived -- asserted, then checked. */
export const ELECTION_YEARS = [2000, 2004, 2008, 2012, 2016, 2020, 2024] as const;

export interface CountyResult {
  /** Published total ballots cast for president. NOT a sum of candidates. */
  total: number | null;
  /** Votes by MEDSL party label: DEMOCRAT, REPUBLICAN, LIBERTARIAN, GREEN, OTHER. */
  byParty: Map<string, number>;
  /**
   * MEDSL's own label, upper-cased ("FRANKLIN"). Only a fallback: the builder
   * prefers the names already on disk from the census side, so the map does not
   * label the same polygon two different ways depending on which metric is up.
   */
  name: string;
}

/** year -> geoid -> result. Geoids are 5-char county FIPS, or 2-char at state level. */
export type Returns = Map<number, Map<string, CountyResult>>;

export interface ParseReport {
  rows: number;
  /** Rows dropped, by the rule that dropped them. Printed, never silent. */
  dropped: Record<string, number>;
}

/**
 * Rows whose `party` is empty are SUMMARY or ballot-accounting lines, not
 * candidates: TOTAL VOTES CAST, UNDERVOTES, OVERVOTES, SPOILED.
 *
 * This is the quirk that makes summing candidate rows wrong, and it is silent:
 * Wisconsin and Idaho 2024 carry a TOTAL VOTES CAST row alongside the real
 * candidates, so a naive sum returns EXACTLY DOUBLE the state's turnout
 * (measured: WI 2024 came out 6,845,836 against an actual 3,422,918) while
 * every share stays plausible because numerator and denominator inflate
 * together. Hence `total` is read from the `totalvotes` COLUMN, which is the
 * published county total repeated on every row.
 */
function isCandidateRow(party: string, candidate: string): boolean {
  return party !== '' && candidate !== 'TOTAL VOTES CAST';
}

/**
 * Alaska does not report by borough. It reports by STATE HOUSE DISTRICT, and
 * MEDSL codes those as 02001-02040 -- which COLLIDE with real Alaska borough
 * FIPS: 02013 is Aleutians East Borough, 02016 Aleutians West, 02020 Anchorage.
 * Joined by geoid, House District 20's returns would render as Anchorage's.
 *
 * That is a confidently wrong map rather than a missing one, so Alaska is
 * dropped at county level and Alaska renders blank. It is NOT dropped at state
 * level: the 40 districts tile the state exactly, so summing them is a correct
 * Alaska total (measured 2012: 300,495, matching the official figure).
 */
function isAlaskaHouseDistrict(geoid: string): boolean {
  return geoid.startsWith('02');
}

/**
 * Each postal abbreviation's state FIPS, derived from the file by majority.
 *
 * A guard rather than a lookup table, and it earns its place: 2024 codes Kansas
 * City as "36000" on a row whose state_po is "MO". Five digits, all numeric,
 * and it passes every shape test -- but 36 is NEW YORK, so a geoid join would
 * quietly move 124,288 Missouri votes across the country, and the state rollup
 * did exactly that before this existed.
 *
 * Majority rather than a hand-kept map because the file is its own best witness:
 * Missouri has thousands of rows at prefix 29 and four at 36, so the vote is
 * never close, and no new table can drift out of step with the data.
 */
export function statePrefixes(rows: Record<string, string>[]): Map<string, string> {
  const tally = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const po = r['state_po'] ?? '';
    const fips = (r['county_fips'] ?? '').padStart(5, '0').slice(0, 2);
    if (!po || !/^\d{2}$/.test(fips)) continue;
    let counts = tally.get(po);
    if (!counts) {
      counts = new Map();
      tally.set(po, counts);
    }
    counts.set(fips, (counts.get(fips) ?? 0) + 1);
  }

  const out = new Map<string, string>();
  for (const [po, counts] of tally) {
    let best = '';
    let n = -1;
    for (const [fips, c] of counts) {
      if (c > n) {
        best = fips;
        n = c;
      }
    }
    out.set(po, best);
  }
  return out;
}

/** Minimal RFC-4180 reader. The file has quoted fields containing commas. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      // Guard against a trailing newline producing a phantom one-field row.
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function toInt(raw: string): number | null {
  if (raw === '' || raw === 'NA') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Which rows to keep for a (year, county), given that `mode` is not uniform.
 *
 * Most state-years report a single TOTAL row per candidate. Twenty-nine of them
 * break the count out by how the ballot was cast (ELECTION DAY / ABSENTEE /
 * EARLY VOTING / PROVISIONAL ...), and some -- Arizona, Arkansas, Iowa and
 * Louisiana in 2024 -- publish BOTH the modes and a TOTAL. Summing everything
 * double-counts those; filtering to TOTAL loses the states that publish no such
 * row (Georgia and North Carolina in 2020 among them).
 *
 * So: prefer TOTAL where a county has one, otherwise sum its modes. Verified by
 * reconstruction -- Missouri 2020 comes out at 3,025,962, its official
 * statewide total to the vote, and the 2024 national shares land on 48.33% /
 * 49.81% against the certified 48.3% / 49.8%.
 */
function hasTotalMode(rows: Record<string, string>[]): Set<string> {
  const keys = new Set<string>();
  for (const r of rows) {
    if (r['mode'] === 'TOTAL') keys.add(`${r['year']}|${r['county_fips']}`);
  }
  return keys;
}

/**
 * Normalize a MEDSL county_fips into the geoid the TIGER geometry uses, or null
 * where no county is being described.
 *
 * Three things happen here, all of them measured:
 *
 *  - ZERO PADDING. The column is numeric-ish, so Alabama's Autauga arrives as
 *    "1001". 10,858 of 94,151 rows are 4 characters.
 *  - NON-COUNTY BUCKETS. "NA" is Connecticut's STATEWIDE WRITEIN, Maine's
 *    UOCAVA and Rhode Island's FEDERAL PRECINCT -- ballots that belong to no
 *    county. 3,361 votes nationally in 2020; dropping them is why the county
 *    sum lands 3,361 short of the certified national total.
 *  - KANSAS CITY. FIPS 2938000 is a PLACE geoid: Missouri reports Kansas City
 *    separately from the four counties it spans, and those counties' rows
 *    already exclude it. Dropping it loses 136,645 votes from Missouri in 2020
 *    rather than misattributing them, which is the same call crosswalk.ts makes
 *    for Bedford city.
 */
function toCountyGeoid(raw: string): string | null {
  if (raw === '' || raw === 'NA') return null;
  if (raw.length > 5) return null; // a place geoid, not a county -- Kansas City
  const padded = raw.padStart(5, '0');
  if (!/^\d{5}$/.test(padded)) return null;
  // County FIPS run 001-840; 000 is never a county. 2024 codes Kansas City as
  // "36000" -- the place geoid with its state prefix lost -- and 000 is the
  // half of that which is checkable without knowing the row's state.
  if (padded.slice(2) === '000') return null;
  // 2024 publishes Oglala Lakota under its RETIRED code 46113 while 2016 and
  // 2020 use 46102. Folding here is what keeps it one series joined to a
  // polygon that exists -- the same rename table the ACS side goes through.
  return canonicalGeoid(padded);
}

export interface ParseOptions {
  /**
   * Keep Alaska's house districts under their own (colliding) geoids.
   *
   * Only ever true on the way to a STATE rollup, where the districts tile
   * Alaska and their sum is the right number. At county level this must stay
   * false -- see isAlaskaHouseDistrict.
   */
  keepAlaska?: boolean;
}

/** Parse the raw CSV into county returns, applying every rule above. */
export function parseCountyPresident(
  text: string,
  opts: ParseOptions = {},
): { returns: Returns; report: ParseReport } {
  const rows = parseCsv(text);
  const totalModeKeys = hasTotalMode(rows);
  const prefixes = statePrefixes(rows);
  const dropped: Record<string, number> = {};
  const bump = (why: string) => {
    dropped[why] = (dropped[why] ?? 0) + 1;
  };

  const returns: Returns = new Map();

  for (const r of rows) {
    const year = toInt(r['year'] ?? '');
    if (year == null) {
      bump('unparseable year');
      continue;
    }
    if (!isCandidateRow(r['party'] ?? '', r['candidate'] ?? '')) {
      bump('ballot-accounting row (not a candidate)');
      continue;
    }
    const rawFips = r['county_fips'] ?? '';
    if (totalModeKeys.has(`${r['year']}|${rawFips}`) && r['mode'] !== 'TOTAL') {
      bump('per-mode row superseded by a TOTAL row');
      continue;
    }
    const geoid = toCountyGeoid(rawFips);
    if (geoid == null) {
      bump('not a county (statewide bucket or place geoid)');
      continue;
    }
    // The geoid says which state this ground is in; state_po says which state
    // reported it. When they disagree the geoid is wrong, and trusting it would
    // file the votes under another state entirely.
    const expected = prefixes.get(r['state_po'] ?? '');
    if (expected && geoid.slice(0, 2) !== expected) {
      bump('geoid state prefix disagrees with state_po');
      continue;
    }
    if (!opts.keepAlaska && isAlaskaHouseDistrict(geoid)) {
      bump('Alaska house district (collides with borough FIPS)');
      continue;
    }

    let byYear = returns.get(year);
    if (!byYear) {
      byYear = new Map();
      returns.set(year, byYear);
    }
    let entry = byYear.get(geoid);
    if (!entry) {
      entry = { total: null, byParty: new Map(), name: r['county_name'] ?? geoid };
      byYear.set(geoid, entry);
    }

    const votes = toInt(r['candidatevotes'] ?? '');
    const party = r['party'] ?? '';
    if (votes != null) entry.byParty.set(party, (entry.byParty.get(party) ?? 0) + votes);

    // `totalvotes` is constant across a county's rows -- verified: 0 of 22,098
    // (year, county) keys disagree with themselves -- so last-write-wins is
    // safe, and taking the max would be the same number with more ceremony.
    const total = toInt(r['totalvotes'] ?? '');
    if (total != null) entry.total = total;
  }

  return { returns, report: { rows: rows.length, dropped } };
}

/**
 * Roll county returns up to states.
 *
 * Counts and rates aggregate from their parts, so this is exact -- rule 1 bites
 * only on medians, and there are none here. Alaska is re-included from the raw
 * rows by the caller, because its districts tile the state even though they
 * cannot be mapped to boroughs.
 */
export function rollUpToStates(returns: Returns, stateNames: Map<string, string>): Returns {
  const out: Returns = new Map();
  for (const [year, counties] of returns) {
    const byState = new Map<string, CountyResult>();
    for (const [geoid, r] of counties) {
      const state = geoid.slice(0, 2);
      let entry = byState.get(state);
      if (!entry) {
        entry = { total: 0, byParty: new Map(), name: stateNames.get(state) ?? state };
        byState.set(state, entry);
      }
      if (r.total != null) entry.total = (entry.total ?? 0) + r.total;
      for (const [party, v] of r.byParty) {
        entry.byParty.set(party, (entry.byParty.get(party) ?? 0) + v);
      }
    }
    out.set(year, byState);
  }
  return out;
}

/** Download (or read a vendored copy of) the returns file. */
export async function loadCountyPresident(): Promise<string> {
  return fetchDataverseFile(FILE_ID, VENDOR_NAME, 'MEDSL county presidential returns 2000-2024');
}

import { describe, expect, it } from 'vitest';

import {
  parseCountyPresident,
  parseCsv,
  rollUpToStates,
  statePrefixes,
} from '../etl/src/sources/medsl/countyPresident.ts';
import { areaFilter, extract } from '../etl/src/sources/medsl/elections.ts';
import { computeBaseline, toIndex } from '../etl/src/transform/normalize.ts';
import type { GeoLevelDef, MetricDef, RegionDef } from '../etl/src/config.ts';

const HEADER =
  'state,county_name,year,state_po,county_fips,office,candidate,party,candidatevotes,totalvotes,version,mode';

/** One MEDSL row, in column order, so a test reads like the file it stands for. */
function row(o: {
  state?: string;
  county?: string;
  year?: number;
  po?: string;
  fips: string;
  candidate: string;
  party: string;
  votes: number | string;
  total: number | string;
  mode?: string;
}): string {
  return [
    `"${o.state ?? 'OHIO'}"`,
    `"${o.county ?? 'FRANKLIN'}"`,
    o.year ?? 2024,
    `"${o.po ?? 'OH'}"`,
    `"${o.fips}"`,
    '"US PRESIDENT"',
    `"${o.candidate}"`,
    `"${o.party}"`,
    o.votes,
    o.total,
    '"20260225"',
    `"${o.mode ?? 'TOTAL'}"`,
  ].join(',');
}

const file = (...rows: string[]) => [HEADER, ...rows].join('\n');

describe('parseCsv', () => {
  it('keeps a comma that lives inside a quoted field', () => {
    const rows = parseCsv('a,b\n"one, two",3');
    expect(rows[0]).toEqual({ a: 'one, two', b: '3' });
  });

  it('unescapes a doubled quote', () => {
    expect(parseCsv('a\n"say ""hi"""')[0]).toEqual({ a: 'say "hi"' });
  });

  it('does not emit a phantom row for a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toHaveLength(1);
  });
});

describe('ballot-accounting rows', () => {
  /**
   * The quirk that makes summing candidate rows wrong, and the reason `total`
   * is read from the totalvotes COLUMN.
   *
   * Wisconsin and Idaho 2024 publish a TOTAL VOTES CAST line alongside the real
   * candidates. Summing everything returns exactly double the state's turnout
   * while every vote share stays plausible, because numerator and denominator
   * inflate together -- a wrong map that looks right.
   */
  it('ignores the TOTAL VOTES CAST summary line rather than counting it', () => {
    const text = file(
      row({ state: 'WISCONSIN', po: 'WI', fips: '55025', candidate: 'KAMALA D HARRIS', party: 'DEMOCRAT', votes: 273995, total: 365929, mode: '' }),
      row({ state: 'WISCONSIN', po: 'WI', fips: '55025', candidate: 'DONALD J TRUMP', party: 'REPUBLICAN', votes: 85454, total: 365929, mode: '' }),
      row({ state: 'WISCONSIN', po: 'WI', fips: '55025', candidate: 'TOTAL VOTES CAST', party: '', votes: 365929, total: 365929, mode: '' }),
    );
    const { returns } = parseCountyPresident(text);
    const dane = returns.get(2024)!.get('55025')!;
    expect(dane.total).toBe(365929);
    expect([...dane.byParty.keys()].sort()).toEqual(['DEMOCRAT', 'REPUBLICAN']);
  });

  it('ignores UNDERVOTES, OVERVOTES and SPOILED alike', () => {
    const text = file(
      row({ fips: '39049', candidate: 'X', party: 'DEMOCRAT', votes: 10, total: 100 }),
      row({ fips: '39049', candidate: 'UNDERVOTES', party: '', votes: 5, total: 100 }),
      row({ fips: '39049', candidate: 'SPOILED', party: '', votes: 2, total: 100 }),
    );
    const { returns, report } = parseCountyPresident(text);
    expect(returns.get(2024)!.get('39049')!.byParty.size).toBe(1);
    expect(report.dropped['ballot-accounting row (not a candidate)']).toBe(2);
  });
});

describe('vote mode', () => {
  /**
   * Twenty-nine state-years break the count out by how the ballot was cast, and
   * four of them (AZ, AR, IA, LA in 2024) publish BOTH the modes and a TOTAL.
   * Summing everything double-counts those; filtering to TOTAL loses Georgia
   * and North Carolina in 2020, which publish no such row.
   */
  it('prefers the TOTAL row and ignores the modes it summarizes', () => {
    const text = file(
      row({ po: 'AZ', fips: '4001', candidate: 'T', party: 'REPUBLICAN', votes: 12795, total: 20000, mode: 'TOTAL' }),
      row({ po: 'AZ', fips: '4001', candidate: 'T', party: 'REPUBLICAN', votes: 9000, total: 20000, mode: 'ELECTION DAY' }),
      row({ po: 'AZ', fips: '4001', candidate: 'T', party: 'REPUBLICAN', votes: 3795, total: 20000, mode: 'EARLY VOTING' }),
    );
    const { returns } = parseCountyPresident(text);
    expect(returns.get(2024)!.get('04001')!.byParty.get('REPUBLICAN')).toBe(12795);
  });

  it('sums the modes where no TOTAL row exists', () => {
    const text = file(
      row({ po: 'GA', fips: '13001', candidate: 'B', party: 'DEMOCRAT', votes: 400, total: 1000, mode: 'ABSENTEE' }),
      row({ po: 'GA', fips: '13001', candidate: 'B', party: 'DEMOCRAT', votes: 600, total: 1000, mode: 'ELECTION DAY' }),
    );
    const { returns } = parseCountyPresident(text);
    expect(returns.get(2024)!.get('13001')!.byParty.get('DEMOCRAT')).toBe(1000);
  });

  /** totalvotes is the county total repeated on every row -- never a sum. */
  it('does not add totalvotes up across a county\'s rows', () => {
    const text = file(
      row({ fips: '39049', candidate: 'A', party: 'DEMOCRAT', votes: 60, total: 100 }),
      row({ fips: '39049', candidate: 'B', party: 'REPUBLICAN', votes: 40, total: 100 }),
    );
    expect(parseCountyPresident(text).returns.get(2024)!.get('39049')!.total).toBe(100);
  });
});

describe('geoid normalization', () => {
  it('zero-pads a single-digit state FIPS', () => {
    const text = file(row({ state: 'ALABAMA', po: 'AL', fips: '1001', candidate: 'A', party: 'DEMOCRAT', votes: 1, total: 2 }));
    expect([...parseCountyPresident(text).returns.get(2024)!.keys()]).toEqual(['01001']);
  });

  /**
   * "NA" is Connecticut's STATEWIDE WRITEIN, Maine's UOCAVA and Rhode Island's
   * FEDERAL PRECINCT -- ballots belonging to no county.
   */
  it('drops the statewide buckets that belong to no county', () => {
    const text = file(row({ po: 'CT', fips: 'NA', candidate: 'W', party: 'OTHER', votes: 12, total: 12 }));
    const { returns, report } = parseCountyPresident(text);
    expect(returns.get(2024)).toBeUndefined();
    expect(report.dropped['not a county (statewide bucket or place geoid)']).toBe(1);
  });

  /**
   * 2938000 is a PLACE geoid: Missouri reports Kansas City separately from the
   * four counties it spans, whose own rows already exclude it. Dropping loses
   * 136,645 votes in 2020 rather than misattributing them -- the same call
   * crosswalk.ts makes for Bedford city.
   */
  it('drops the Kansas City place row instead of misattributing it', () => {
    const text = file(row({ po: 'MO', county: 'KANSAS CITY', fips: '2938000', candidate: 'A', party: 'DEMOCRAT', votes: 5, total: 10 }));
    expect(parseCountyPresident(text).returns.get(2024)).toBeUndefined();
  });

  /**
   * MEDSL publishes Oglala Lakota under its RETIRED code 46113 in 2024 while
   * using the current 46102 in 2016 and 2020. Folding through the project's own
   * rename table is what keeps it one series joined to a polygon that exists.
   */
  it('folds a retired county code onto the one in use today', () => {
    const text = file(
      row({ po: 'SD', county: 'OGLALA LAKOTA', fips: '46113', candidate: 'A', party: 'DEMOCRAT', votes: 1, total: 2 }),
    );
    expect([...parseCountyPresident(text).returns.get(2024)!.keys()]).toEqual(['46102']);
  });
});

describe('a geoid that names the wrong state', () => {
  /**
   * MEASURED, and the nastiest row in the file. 2024 codes Kansas City as
   * "36000" -- the place geoid 2938000 with its state prefix lost -- on a row
   * whose state_po is MO. It is five digits and all numeric, so it passes every
   * shape test, but 36 is NEW YORK. Before this guard the state rollup filed
   * 124,288 Missouri votes under New York.
   */
  const text = file(
    ...Array.from({ length: 5 }, (_, i) =>
      row({ state: 'MISSOURI', po: 'MO', county: 'C', fips: `2900${i + 1}`, candidate: 'A', party: 'DEMOCRAT', votes: 10, total: 20 }),
    ),
    row({ state: 'MISSOURI', po: 'MO', county: 'KANSAS CITY', fips: '36000', candidate: 'KAMALA D HARRIS', party: 'DEMOCRAT', votes: 95660, total: 124288 }),
  );

  it('refuses to file a Missouri row under New York', () => {
    const { returns } = parseCountyPresident(text);
    expect([...returns.get(2024)!.keys()].some((g) => g.startsWith('36'))).toBe(false);
  });

  it('leaves the state total free of the misplaced votes', () => {
    const states = rollUpToStates(parseCountyPresident(text).returns, new Map());
    expect(states.get(2024)!.has('36')).toBe(false);
    expect(states.get(2024)!.get('29')!.total).toBe(100);
  });

  it('reports the drop rather than swallowing it', () => {
    const { report } = parseCountyPresident(text);
    expect(report.dropped['not a county (statewide bucket or place geoid)']).toBe(1);
  });

  /** A county part of 000 is never a county, whatever state it claims. */
  it('rejects an x000 code on its own merits', () => {
    const lone = file(row({ po: 'ZZ', fips: '36000', candidate: 'A', party: 'DEMOCRAT', votes: 1, total: 2 }));
    expect(parseCountyPresident(lone).returns.get(2024)).toBeUndefined();
  });
});

describe('statePrefixes', () => {
  it('takes the majority prefix and ignores a stray', () => {
    const rows = parseCsv(
      file(
        row({ po: 'MO', fips: '29095', candidate: 'A', party: 'DEMOCRAT', votes: 1, total: 2 }),
        row({ po: 'MO', fips: '29037', candidate: 'A', party: 'DEMOCRAT', votes: 1, total: 2 }),
        row({ po: 'MO', fips: '36000', candidate: 'A', party: 'DEMOCRAT', votes: 1, total: 2 }),
      ),
    );
    expect(statePrefixes(rows).get('MO')).toBe('29');
  });
});

describe('Alaska', () => {
  const text = file(
    row({ state: 'ALASKA', county: 'DISTRICT 20', po: 'AK', fips: '2020', candidate: 'A', party: 'DEMOCRAT', votes: 100, total: 200 }),
    row({ state: 'ALASKA', county: 'DISTRICT 13', po: 'AK', fips: '2013', candidate: 'A', party: 'DEMOCRAT', votes: 50, total: 150 }),
  );

  /**
   * THE load-bearing case. Alaska reports by state house district, and MEDSL
   * codes those 02001-02040 -- which collide with real borough FIPS: 02013 is
   * Aleutians East, 02016 Aleutians West, 02020 Anchorage. Joined by geoid,
   * House District 20's returns would render as Anchorage's: a confidently
   * wrong map rather than a missing one.
   */
  it('drops the house districts at county level, where they collide', () => {
    const { returns, report } = parseCountyPresident(text);
    expect(returns.get(2024)).toBeUndefined();
    expect(report.dropped['Alaska house district (collides with borough FIPS)']).toBe(2);
  });

  /** The districts tile the state, so their sum IS Alaska. */
  it('keeps them for the state rollup, where their sum is correct', () => {
    const { returns } = parseCountyPresident(text, { keepAlaska: true });
    const states = rollUpToStates(returns, new Map([['02', 'Alaska']]));
    const ak = states.get(2024)!.get('02')!;
    expect(ak.total).toBe(350);
    expect(ak.byParty.get('DEMOCRAT')).toBe(150);
    expect(ak.name).toBe('Alaska');
  });
});

describe('rollUpToStates', () => {
  it('adds counties into their state and leaves other states alone', () => {
    const text = file(
      row({ fips: '39049', candidate: 'A', party: 'DEMOCRAT', votes: 380518, total: 598225 }),
      row({ fips: '39041', candidate: 'A', party: 'DEMOCRAT', votes: 50000, total: 130000 }),
      row({ po: 'IN', state: 'INDIANA', fips: '18001', candidate: 'A', party: 'DEMOCRAT', votes: 1, total: 3 }),
    );
    const states = rollUpToStates(parseCountyPresident(text).returns, new Map([['39', 'Ohio']]));
    const oh = states.get(2024)!.get('39')!;
    expect(oh.total).toBe(728225);
    expect(oh.byParty.get('DEMOCRAT')).toBe(430518);
    expect(states.get(2024)!.get('18')!.total).toBe(3);
  });
});

describe('extract', () => {
  const votes = { source: { dataset: 'medsl/countypres', value: 'totalvotes' }, kind: 'count' } as MetricDef;
  const demShare = {
    source: { dataset: 'medsl/countypres', numerator: 'DEMOCRAT', denominator: 'totalvotes' },
    kind: 'rate',
  } as MetricDef;
  const result = { total: 200, byParty: new Map([['DEMOCRAT', 150]]), name: 'X' };

  it('reads a count straight off the published total', () => {
    expect(extract(votes, result).value).toBe(200);
  });

  /**
   * A rate keeps its parts so the baseline can pool them. Averaging county
   * percentages would weight a village of 300 like a city of 900,000 -- rule
   * 1's logic, arriving through votes rather than medians.
   */
  it('keeps numerator and denominator on a share, not just the percentage', () => {
    const a = extract(demShare, result);
    expect(a.value).toBe(75);
    expect(a.numerator).toBe(150);
    expect(a.denominator).toBe(200);
  });

  it('yields null rather than zero for an area with no returns', () => {
    expect(extract(demShare, undefined).value).toBeNull();
    expect(extract(votes, undefined).value).toBeNull();
  });

  it('pools a share baseline by votes, not by county', () => {
    const areas = [
      { geoid: 'a', value: 90, numerator: 900, denominator: 1000 },
      { geoid: 'b', value: 10, numerator: 1, denominator: 10 },
    ];
    // Vote-weighted: 901/1010 = 89.2%, not the 50% a mean of the two would give.
    const baseline = computeBaseline('rate', areas, null)!;
    expect(baseline).toBeCloseTo(89.2, 1);
    expect(toIndex(90, baseline)).toBeCloseTo(100.9, 1);
  });
});

describe('areaFilter', () => {
  const county = { id: 'county' } as GeoLevelDef;
  const state = { id: 'state' } as GeoLevelDef;
  const national = { kind: 'national' } as RegionDef;
  const ohio = { kind: 'state', state: '39' } as RegionDef;
  const columbus = {
    kind: 'metro',
    state: '39',
    counties: [{ fips: '049', name: 'Franklin' }, { fips: '041', name: 'Delaware' }],
  } as RegionDef;

  /** Same rule as the census side: us:1 does not cover the territories. */
  it('drops territories from the national region', () => {
    expect(areaFilter(national, county)('39049')).toBe(true);
    expect(areaFilter(national, county)('72001')).toBe(false);
    expect(areaFilter(national, state)('72')).toBe(false);
  });

  it('keeps a state region to its own counties', () => {
    const keep = areaFilter(ohio, county);
    expect(keep('39049')).toBe(true);
    expect(keep('18001')).toBe(false);
  });

  it('keeps a metro region to the counties it declares', () => {
    const keep = areaFilter(columbus, county);
    expect(keep('39049')).toBe(true);
    expect(keep('39041')).toBe(true);
    expect(keep('39089')).toBe(false); // Licking: in the MSA, but not in this fixture
  });
});

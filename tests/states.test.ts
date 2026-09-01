import { describe, expect, it } from 'vitest';

import { FIRST_TERRITORY_FIPS, isUsState } from '../etl/src/sources/census/states.ts';
import { canonicalGeoid } from '../etl/src/transform/crosswalk.ts';
import { geoidOf } from '../etl/src/pipeline.ts';
import type { GeoLevelDef } from '../etl/src/config.ts';

const COUNTY_LEVEL: GeoLevelDef = {
  id: 'county',
  label: 'County',
  censusFor: 'county:*',
  censusIn: 'us',
  restrictBy: 'us-states',
  vintage: 2020,
  tigerLayer: 'county',
  simplify: '4%',
};

const STATE_LEVEL: GeoLevelDef = {
  id: 'state',
  label: 'State',
  censusFor: 'state:*',
  censusIn: 'us',
  restrictBy: 'us-states',
  vintage: 2020,
  tigerLayer: 'state',
  simplify: '3%',
};

describe('isUsState', () => {
  it('keeps the 50 states and DC', () => {
    for (const fips of ['01', '06', '11', '39', '56']) {
      expect(isUsState(fips)).toBe(true);
    }
  });

  /**
   * The load-bearing case. `for=state:*` returns these; `us:1` does not cover
   * them, so keeping one would divide its value by a baseline computed for a
   * country it is not part of. Verified against the live API 2026-09-01: the
   * gap between sum(state:*) and us:1 is exactly Puerto Rico's population.
   */
  it('drops every territory, Puerto Rico above all', () => {
    for (const fips of ['60', '66', '69', '72', '78']) {
      expect(isUsState(fips)).toBe(false);
    }
  });

  it('rejects junk rather than treating it as a state', () => {
    expect(isUsState('')).toBe(false);
    expect(isUsState('us')).toBe(false);
    expect(isUsState('00')).toBe(false);
  });

  /**
   * The TIGER side applies this same threshold as a mapshaper expression
   * (`+GEOID < 60`). If the two ever disagree, geometry and data would disagree
   * about which areas are in the region -- silently, since both would still
   * render.
   */
  it('states the threshold the geometry filter also uses', () => {
    expect(FIRST_TERRITORY_FIPS).toBe(60);
    expect(isUsState(String(FIRST_TERRITORY_FIPS - 1))).toBe(true);
    expect(isUsState(String(FIRST_TERRITORY_FIPS))).toBe(false);
  });
});

describe('geoidOf at national scope', () => {
  /**
   * A state is the TOP of the hierarchy, so its geoid is the bare 2-char FIPS.
   * The county-nested branch would prefix row['state'] and yield "3939", which
   * matches no TIGER polygon -- a blank map, not an error.
   */
  it('returns the bare state FIPS, not a doubled one', () => {
    expect(geoidOf({ state: '39', NAME: 'Ohio' }, STATE_LEVEL)).toBe('39');
  });

  it('returns null when the state column is missing', () => {
    expect(geoidOf({ NAME: 'Ohio' }, STATE_LEVEL)).toBeNull();
  });

  /**
   * A county fetched nationally still needs its state prefix. row['county'] on
   * its own is "049", which matches no polygon and is not even unique -- many
   * states have an 049.
   */
  it('keeps the state prefix on a nationally fetched county', () => {
    expect(geoidOf({ state: '39', county: '049', NAME: 'Franklin County, Ohio' }, COUNTY_LEVEL)).toBe(
      '39049',
    );
  });
});

describe('canonicalGeoid', () => {
  /**
   * Renames, verified by population continuity across the boundary: the ground
   * did not change, only the code. Folding them keeps one series per place
   * instead of two truncated ones, and keeps the older years joined to a
   * polygon that exists.
   */
  it('folds a renamed county onto the code it is published under today', () => {
    expect(canonicalGeoid('02270')).toBe('02158'); // Wade Hampton -> Kusilvak
    expect(canonicalGeoid('46113')).toBe('46102'); // Shannon -> Oglala Lakota
  });

  /**
   * Bedford city dissolved INTO Bedford County -- a merge, not a rename. The
   * county's population jumps by the city's the same year, so aliasing would
   * attribute a small city's median to a county eleven times its size.
   */
  it('leaves a genuine merge alone', () => {
    expect(canonicalGeoid('51515')).toBe('51515');
  });

  it('passes through every ordinary geoid untouched', () => {
    expect(canonicalGeoid('39049')).toBe('39049');
    expect(canonicalGeoid('09110')).toBe('09110');
  });
});

describe('geoidOf composes from the geography, not the fetch scope', () => {
  const level = (censusFor: string, censusIn?: GeoLevelDef['censusIn']): GeoLevelDef => ({
    id: 'x',
    label: 'x',
    censusFor,
    ...(censusIn ? { censusIn } : {}),
    vintage: 2020,
    tigerLayer: 'x',
    simplify: '5%',
  });

  /**
   * The load-bearing case for state regions. Tracts and county subdivisions can
   * be fetched EITHER one county at a time or in a single statewide call
   * (verified against the live API for 2009-2024). Both must yield the same
   * key, because they describe the same ground and join to the same polygon.
   */
  it('gives a tract the same 11-char geoid however it was fetched', () => {
    const row = { state: '39', county: '049', tract: '000110' };
    expect(geoidOf(row, level('tract:*'))).toBe('39049000110');
    expect(geoidOf(row, level('tract:*', 'state'))).toBe('39049000110');
  });

  it('gives a county subdivision its county component when fetched statewide', () => {
    const row = { state: '39', county: '049', 'county subdivision': '18000' };
    expect(geoidOf(row, level('county subdivision:*', 'state'))).toBe('3904918000');
  });

  /** A place does not nest in a county -- the whole reason the table exists. */
  it('leaves the county out of a place geoid', () => {
    expect(geoidOf({ state: '39', county: '049', place: '22694' }, level('place:*', 'state'))).toBe(
      '3922694',
    );
  });

  it('refuses an unknown geography rather than guessing a key', () => {
    expect(() => geoidOf({ state: '39' }, level('block group:*'))).toThrow(/unknown geography/);
  });
});

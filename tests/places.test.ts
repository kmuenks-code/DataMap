import { describe, expect, it } from 'vitest';

import { parsePlaceCounty, restrictPlaces } from '../etl/src/sources/census/places.ts';
import { geoidOf } from '../etl/src/pipeline.ts';
import type { GeoLevelDef } from '../etl/src/config.ts';

/**
 * Real rows from national_place_by_county2020.txt, trimmed to the columns that
 * matter. Dublin appears three times because a place is NOT nested inside a
 * county -- that repetition is the whole reason this file exists.
 */
const REL = [
  'STATE|STATEFP|COUNTYFP|COUNTYNAME|PLACEFP|PLACENS|PLACENAME|TYPE|CLASSFP|FUNCSTAT',
  'OH|39|049|Franklin County|22694|02394565|Dublin city|INCORPORATED PLACE|C1|A',
  'OH|39|041|Delaware County|22694|02394565|Dublin city|INCORPORATED PLACE|C1|A',
  'OH|39|159|Union County|22694|02394565|Dublin city|INCORPORATED PLACE|C1|A',
  'OH|39|049|Franklin County|79002|02397787|Upper Arlington city|INCORPORATED PLACE|C1|A',
  'OH|39|035|Cuyahoga County|16000|01084524|Cleveland city|INCORPORATED PLACE|C1|A',
  'IN|18|097|Marion County|22694|00000000|Decoy place|INCORPORATED PLACE|C1|A',
].join('\n');

const COLUMBUS_COUNTIES = ['049', '041', '159'];

describe('parsePlaceCounty', () => {
  it('builds GEOID as state+place, with no county component', () => {
    const geoids = parsePlaceCounty(REL, '39', COLUMBUS_COUNTIES);
    // 7 chars, not 10. A place GEOID that carried a county would match no
    // TIGER polygon and no Census response column.
    expect(geoids.has('3922694')).toBe(true);
    expect([...geoids].every((g) => g.length === 7)).toBe(true);
  });

  it('collapses a place spanning several counties into ONE entry', () => {
    // Dublin is listed under Franklin, Delaware and Union. It is one city with
    // one published estimate; emitting it three times would triple-count it.
    const geoids = parsePlaceCounty(REL, '39', COLUMBUS_COUNTIES);
    expect([...geoids].filter((g) => g === '3922694')).toHaveLength(1);
    expect(geoids.size).toBe(2); // Dublin + Upper Arlington
  });

  it('excludes places in other counties and other states', () => {
    const geoids = parsePlaceCounty(REL, '39', COLUMBUS_COUNTIES);
    expect(geoids.has('3916000')).toBe(false); // Cleveland: Ohio, wrong county
    expect(geoids.has('1822694')).toBe(false); // same PLACEFP, wrong state
  });

  it('locates columns by name, so a reordered file does not silently shift', () => {
    const reordered = [
      'PLACEFP|COUNTYFP|STATEFP|PLACENAME',
      '22694|049|39|Dublin city',
      '16000|035|39|Cleveland city',
    ].join('\n');
    expect(parsePlaceCounty(reordered, '39', COLUMBUS_COUNTIES)).toEqual(new Set(['3922694']));
  });

  it('throws rather than guessing when the expected columns are absent', () => {
    expect(() => parsePlaceCounty('A|B|C\n1|2|3', '39', COLUMBUS_COUNTIES)).toThrow(
      /unexpected header/,
    );
  });
});

describe('restrictPlaces', () => {
  it('keeps only allowed geoids', () => {
    const rows = new Map([
      ['3922694', 'Dublin'],
      ['3916000', 'Cleveland'],
    ]);
    const kept = restrictPlaces(rows, new Set(['3922694']), 'test');
    expect([...kept.keys()]).toEqual(['3922694']);
  });

  it('drops an allowed place that the API did not return, without inventing a row', () => {
    // Hidden Lakes CDP changed FIPS between vintages; the missing side must
    // stay missing rather than being backfilled with a null-valued entry.
    const kept = restrictPlaces(new Map([['3922694', 'Dublin']]), new Set(['3922694', '3935133']), 'test');
    expect(kept.size).toBe(1);
    expect(kept.has('3935133')).toBe(false);
  });
});

describe('geoidOf', () => {
  const base = { vintage: 2020, tigerLayer: 'x', simplify: '1%' };
  const place: GeoLevelDef = {
    ...base,
    id: 'place',
    label: 'Place',
    censusFor: 'place:*',
    censusIn: 'state',
  };
  const tract: GeoLevelDef = { ...base, id: 'tract', label: 'Tract', censusFor: 'tract:*' };

  it('omits the county for a state-scoped level', () => {
    // A place response HAS no county column, so including one would produce
    // null and drop every row on the floor.
    expect(geoidOf({ state: '39', place: '22694' }, place)).toBe('3922694');
  });

  it('includes the county for a county-nested level', () => {
    expect(geoidOf({ state: '39', county: '049', tract: '001100' }, tract)).toBe('39049001100');
  });

  it('returns null when a required component is missing', () => {
    expect(geoidOf({ state: '39' }, tract)).toBeNull();
    expect(geoidOf({ place: '22694' }, place)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { mergeMetricFile } from '../etl/src/transform/merge.ts';
import {
  coefficientOfVariation,
  computeBaseline,
  toIndex,
  type AreaValue,
} from '../etl/src/transform/normalize.ts';
import { boundaryVintageForYear } from '../etl/src/transform/crosswalk.ts';
import { parseEstimate } from '../etl/src/sources/census/client.ts';
import type { MetricFile } from '../etl/src/transform/pack.ts';

describe('parseEstimate', () => {
  it('maps Census negative sentinels to null, not to huge negative numbers', () => {
    // Verified live: B01003_001M returns -555555555 for controlled estimates.
    for (const sentinel of ['-666666666', '-999999999', '-555555555', '-222222222']) {
      expect(parseEstimate(sentinel)).toBeNull();
    }
    expect(parseEstimate('73795')).toBe(73795);
    expect(parseEstimate('')).toBeNull();
    // A genuine small negative (net migration, say) must survive.
    expect(parseEstimate('-12')).toBe(-12);
  });
});

describe('computeBaseline', () => {
  const rates: AreaValue[] = [
    { geoid: 'a', value: 10, numerator: 10, denominator: 100 },
    { geoid: 'b', value: 50, numerator: 50, denominator: 100 },
  ];

  it('aggregates rates from numerator/denominator, not by averaging the rates', () => {
    // Pooled = 60/200 = 30 percent. Here it coincides with the mean because the
    // denominators are equal; the next case proves they actually differ.
    expect(computeBaseline('rate', rates)).toBeCloseTo(30);
  });

  it('weights rates by denominator', () => {
    const skewed: AreaValue[] = [
      { geoid: 'a', value: 10, numerator: 10, denominator: 1000 },
      { geoid: 'b', value: 50, numerator: 50, denominator: 100 },
    ];
    // Pooled = 60/1100 ≈ 5.45%, far from the naive mean of 30%.
    expect(computeBaseline('rate', skewed)).toBeCloseTo((60 / 1100) * 100);
  });

  it('refuses to average medians', () => {
    const medians: AreaValue[] = [{ geoid: 'a', value: 50000 }];
    expect(() => computeBaseline('median', medians)).toThrow(/medians/i);
  });

  it('accepts a published baseline for medians', () => {
    expect(computeBaseline('median', [], 81945)).toBe(81945);
  });
});

describe('toIndex', () => {
  it('pins the baseline to 100', () => {
    expect(toIndex(81945, 81945)).toBe(100);
  });

  it('matches the verified Columbus figure', () => {
    // Census Tract 1.10, Franklin County, 2024: $133,315 against a metro
    // median of $81,945 -> 162.7. Checked against the live API.
    expect(toIndex(133315, 81945)).toBeCloseTo(162.7, 1);
  });

  it('returns null rather than 0 or Infinity for missing data', () => {
    expect(toIndex(null, 100)).toBeNull();
    expect(toIndex(100, null)).toBeNull();
    expect(toIndex(100, 0)).toBeNull();
  });
});

describe('coefficientOfVariation', () => {
  it('converts a 90% MOE to a CV', () => {
    expect(coefficientOfVariation(100, 16.45)).toBeCloseTo(0.1, 3);
  });

  it('is null when the MOE is missing', () => {
    expect(coefficientOfVariation(100, null)).toBeNull();
  });
});

describe('boundaryVintageForYear', () => {
  it('recognises all three eras, including 2009', () => {
    expect(boundaryVintageForYear(2009)).toBe(2000);
    expect(boundaryVintageForYear(2010)).toBe(2010);
    expect(boundaryVintageForYear(2019)).toBe(2010);
    expect(boundaryVintageForYear(2020)).toBe(2020);
    expect(boundaryVintageForYear(2024)).toBe(2020);
  });
});

describe('mergeMetricFile', () => {
  const base = (over: Partial<MetricFile>): MetricFile => ({
    schema: 1,
    region: 'columbus-oh',
    geoLevel: 'county-subdivision',
    metric: 'population',
    layer: 'census-acs',
    group: 'demographics',
    kind: 'count',
    unit: 'people',
    years: [],
    geoids: [],
    names: [],
    baseline: [],
    values: [],
    index: [],
    meta: { generatedAt: '', dataset: 'acs/acs5', variables: [] },
    ...over,
  });

  it('splices a single year in without dropping the rest of the series', () => {
    const existing = base({
      years: [2022, 2023],
      geoids: ['a', 'b'],
      names: ['A', 'B'],
      baseline: [10, 11],
      values: [[1, 2], [3, 4]],
      index: [[10, 20], [30, 40]],
    });
    const incoming = base({
      years: [2024],
      geoids: ['a', 'b'],
      names: ['A', 'B'],
      baseline: [12],
      values: [[5, 6]],
      index: [[50, 60]],
    });

    const merged = mergeMetricFile(incoming, existing);
    expect(merged.years).toEqual([2022, 2023, 2024]);
    expect(merged.values).toEqual([[1, 2], [3, 4], [5, 6]]);
    expect(merged.baseline).toEqual([10, 11, 12]);
  });

  it('lets the incoming run overwrite a year it recomputed', () => {
    const existing = base({
      years: [2024], geoids: ['a'], names: ['A'],
      baseline: [1], values: [[99]], index: [[99]],
    });
    const incoming = base({
      years: [2024], geoids: ['a'], names: ['A'],
      baseline: [2], values: [[7]], index: [[7]],
    });
    expect(mergeMetricFile(incoming, existing).values).toEqual([[7]]);
  });

  it('realigns columns when the two sides have different geoid universes', () => {
    // The dangerous case: a partial run sees fewer boundary eras, so fewer
    // geoids. Naive concatenation would shift every value one column over and
    // produce a wrong-but-plausible map.
    const existing = base({
      years: [2023], geoids: ['a', 'c'], names: ['A', 'C'],
      baseline: [1], values: [[1, 3]], index: [[1, 3]],
    });
    const incoming = base({
      years: [2024], geoids: ['b', 'c'], names: ['B', 'C'],
      baseline: [1], values: [[20, 30]], index: [[20, 30]],
    });

    const merged = mergeMetricFile(incoming, existing);
    expect(merged.geoids).toEqual(['a', 'b', 'c']);
    // 'b' did not exist in 2023, 'a' did not exist in 2024 -> null, not shifted.
    expect(merged.values[0]).toEqual([1, null, 3]);
    expect(merged.values[1]).toEqual([null, 20, 30]);
  });
});

describe('census cache-key stability', () => {
  it('produces the same request string regardless of variable order', async () => {
    // Regression guard: the cache key IS the request string, so if variable
    // order leaked into it, reordering metrics.json would silently invalidate
    // the whole cache and re-fetch everything (measured once at 320 requests).
    const build = (vars: string[]) => {
      const p = new URLSearchParams();
      p.set('get', ['NAME', ...[...vars].sort()].join(','));
      p.set('for', 'tract:*');
      return p.toString();
    };
    expect(build(['B19013_001E', 'B01003_001E'])).toBe(build(['B01003_001E', 'B19013_001E']));
  });
});

describe('rate baseline units', () => {
  it('returns percent, matching how area values are stored', () => {
    // Regression: area values are stored as (num/den)*100, so a baseline
    // returned as a bare fraction inflated every rate index by 100x -- a
    // median index of 6159 instead of 62, which still looks like a real map.
    const areas: AreaValue[] = [
      { geoid: 'a', value: 20, numerator: 20, denominator: 100 },
      { geoid: 'b', value: 4, numerator: 4, denominator: 100 },
    ];
    const baseline = computeBaseline('rate', areas);
    expect(baseline).toBeCloseTo(12); // percent, not 0.12

    // And the index it produces must be sane.
    expect(toIndex(areas[0]!.value, baseline)).toBeCloseTo(166.7, 1);
    expect(toIndex(areas[1]!.value, baseline)).toBeCloseTo(33.3, 1);
  });
});

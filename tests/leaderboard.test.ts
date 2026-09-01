import { describe, expect, it } from 'vitest';

import type { MetricFile } from '../src/data/types.ts';
import { buildLeaderboard } from '../src/lib/stats/leaderboard.ts';

/**
 * Four areas over three years. `d` is missing 2009 on purpose -- a tract
 * redrawn between boundary eras -- and `c` is the small, noisy one.
 */
function fixture(over: Partial<MetricFile> = {}): MetricFile {
  return {
    schema: 1,
    region: 'test',
    geoLevel: 'county-subdivision',
    metric: 'population',
    layer: 'census-acs',
    group: 'people',
    kind: 'count',
    unit: 'people',
    years: [2009, 2016, 2024],
    geoids: ['a', 'b', 'c', 'd'],
    names: ['Alpha', 'Bravo', 'Charlie', 'Delta'],
    baseline: [1000, 1000, 1000],
    values: [
      [500, 900, 100, null],
      [600, 950, 300, 700],
      [700, 1000, 900, 800],
    ],
    index: [
      [50, 90, 10, null],
      [60, 95, 30, 70],
      [70, 100, 90, 80],
    ],
    cv: [
      [0.01, 0.01, 0.4, null],
      [0.01, 0.01, 0.4, 0.02],
      [0.01, 0.01, 0.4, 0.02],
    ],
    meta: { dataset: 'test', variables: [] },
    ...over,
  };
}

/** The default accessor: the region's own index, as shipped in the file. */
const ownIndex =
  (file: MetricFile) =>
  (yi: number, i: number): number | null =>
    file.index[yi]?.[i] ?? null;

describe('buildLeaderboard', () => {
  it('ranks the selected year by raw value, highest first', () => {
    const file = fixture();
    const board = buildLeaderboard(file, {
      year: 2024,
      measure: 'raw',
      basis: 'level',
      direction: 'highest',
      indexAt: ownIndex(file),
    });
    expect(board.rows.map((r) => r.geoid)).toEqual(['b', 'd', 'a']);
    expect(board.rows[0]).toMatchObject({ position: 1, value: 1000, index: 100 });
  });

  it('ranks by index when the measure is index, which can reorder the list', () => {
    // Same year, but scaled against a baseline that makes a small area big.
    const file = fixture();
    const board = buildLeaderboard(file, {
      year: 2016,
      measure: 'index',
      basis: 'level',
      direction: 'highest',
      excludeImprecise: false,
      indexAt: (yi, i) => [[0, 0, 0, 0], [10, 20, 99, 30], [0, 0, 0, 0]][yi]?.[i] ?? null,
    });
    // By raw 2016 value the order is b, d, a, c; by this index it is c, d, b, a.
    expect(board.rows.map((r) => r.geoid)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('lowest reverses the ordering rather than reinterpreting the metric', () => {
    const file = fixture();
    const board = buildLeaderboard(file, {
      year: 2024,
      measure: 'raw',
      basis: 'level',
      direction: 'lowest',
      indexAt: ownIndex(file),
    });
    expect(board.rows.map((r) => r.geoid)).toEqual(['a', 'd', 'b']);
  });

  it('delta spans the metric full range, not the selected year', () => {
    const file = fixture();
    const board = buildLeaderboard(file, {
      year: 2016,
      measure: 'raw',
      basis: 'delta',
      direction: 'highest',
      indexAt: ownIndex(file),
    });
    expect(board.span).toEqual([2009, 2024]);
    // a: +200, b: +100. d has no 2009 value and is not credited with +800.
    expect(board.rows.map((r) => [r.geoid, r.sortValue])).toEqual([
      ['a', 200],
      ['b', 100],
    ]);
    expect(board.rows[0]?.from).toEqual({ value: 500, index: 50 });
  });

  it('excludes an area missing either endpoint from the change list only', () => {
    const file = fixture();
    const opts = {
      year: 2024,
      measure: 'raw' as const,
      basis: 'level' as const,
      direction: 'highest' as const,
      indexAt: ownIndex(file),
    };
    expect(buildLeaderboard(file, opts).rows.map((r) => r.geoid)).toContain('d');
    expect(
      buildLeaderboard(file, { ...opts, basis: 'delta' }).rows.map((r) => r.geoid),
    ).not.toContain('d');
  });

  it('drops imprecise areas by default, counts them, and puts them back on request', () => {
    const file = fixture();
    const opts = {
      year: 2024,
      measure: 'raw' as const,
      basis: 'level' as const,
      direction: 'highest' as const,
      indexAt: ownIndex(file),
    };
    const trimmed = buildLeaderboard(file, opts);
    expect(trimmed.rows.map((r) => r.geoid)).not.toContain('c');
    expect(trimmed.impreciseCount).toBe(1);
    expect(trimmed.total).toBe(3);

    const full = buildLeaderboard(file, { ...opts, excludeImprecise: false });
    expect(full.rows.map((r) => r.geoid)).toContain('c');
    // The count is still reported when nothing was removed, so the label can
    // say "including N imprecise" rather than going silent.
    expect(full.impreciseCount).toBe(1);
    expect(full.total).toBe(4);
  });

  it('treats either noisy endpoint as making the change noisy', () => {
    // Precise in 2024, wildly imprecise in 2009: the difference is still noise.
    const file = fixture({
      cv: [
        [0.01, 0.01, 0.4, null],
        [0.01, 0.01, 0.02, 0.02],
        [0.01, 0.01, 0.02, 0.02],
      ],
    });
    const board = buildLeaderboard(file, {
      year: 2024,
      measure: 'raw',
      basis: 'delta',
      direction: 'highest',
      indexAt: ownIndex(file),
    });
    expect(board.rows.map((r) => r.geoid)).not.toContain('c');
    expect(board.impreciseCount).toBe(1);
  });

  it('has no change to rank when the metric has a single year', () => {
    const file = fixture({
      years: [2024],
      values: [[700, 1000, 900, 800]],
      index: [[70, 100, 90, 80]],
      cv: [[0.01, 0.01, 0.01, 0.01]],
    });
    const board = buildLeaderboard(file, {
      year: 2024,
      measure: 'raw',
      basis: 'delta',
      direction: 'highest',
      indexAt: ownIndex(file),
    });
    expect(board.rows).toEqual([]);
    expect(board.span).toBeNull();
  });

  it('ranks fine with no cv column at all', () => {
    const file = fixture({ cv: undefined });
    const board = buildLeaderboard(file, {
      year: 2024,
      measure: 'raw',
      basis: 'level',
      direction: 'highest',
      indexAt: ownIndex(file),
    });
    expect(board.impreciseCount).toBe(0);
    expect(board.rows).toHaveLength(4);
  });

  it('caps the list at the limit', () => {
    const file = fixture({ cv: undefined });
    expect(
      buildLeaderboard(file, {
        year: 2024,
        measure: 'raw',
        basis: 'level',
        direction: 'highest',
        limit: 2,
        indexAt: ownIndex(file),
      }).rows,
    ).toHaveLength(2);
  });
});

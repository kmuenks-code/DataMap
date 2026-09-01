import type { MetricFile } from '../../data/types.ts';
import { isUnreliable } from './ranking.ts';

/**
 * What the leaderboard ranks on.
 *
 *   'level' -> the number in the selected year, i.e. the same quantity the map
 *              is coloring right now.
 *   'delta' -> how far that number moved across the metric's WHOLE published
 *              span. A different question: "who is biggest" and "who grew
 *              most" have almost disjoint answers.
 */
export type RankBasis = 'level' | 'delta';

/**
 * Which end of the ordering to show.
 *
 * 'highest' is always literally the largest number, never "best" -- matching
 * rankAll(), where rank 1 is the highest value regardless of higherIsBetter.
 * Folding direction into the metric's polarity would make the leaderboard
 * silently contradict the rank the detail panel prints for the same area.
 */
export type RankDirection = 'highest' | 'lowest';

/** Which quantity is being ranked: mirrors the map's view mode. */
export type RankMeasure = 'index' | 'raw';

export interface LeaderboardRow {
  geoid: string;
  name: string;
  /** Position within the list as displayed, 1-based. */
  position: number;
  /** The number actually sorted on -- an index, a raw value, or a change in either. */
  sortValue: number;
  /** The end-of-window state, which is what the row's headline shows. */
  value: number | null;
  index: number | null;
  cv: number | null;
  /** Delta rows only: the start-of-window state the change was measured from. */
  from: { value: number | null; index: number | null } | null;
}

export interface Leaderboard {
  rows: LeaderboardRow[];
  /** Eligible areas the list was drawn from, after exclusions. */
  total: number;
  /**
   * Areas whose coefficient of variation exceeds the threshold -- dropped when
   * excludeImprecise is on, merely counted when it is off.
   *
   * Surfaced rather than swallowed because it is the single most important
   * caveat on this panel: at tract and place level the untrimmed
   * top-10-by-change is mostly rural townships of a few hundred people whose
   * swing is survey error. The reader is told how many were removed and can
   * put them back.
   */
  impreciseCount: number;
  /** Delta rows only: the window the change spans, as [firstYear, lastYear]. */
  span: [number, number] | null;
}

export interface LeaderboardOptions {
  /** The year on the scrubber. Used by 'level'; ignored by 'delta'. */
  year: number;
  measure: RankMeasure;
  basis: RankBasis;
  direction: RankDirection;
  limit?: number;
  /** Drop areas whose estimate is too imprecise to rank honestly. */
  excludeImprecise?: boolean;
  cvThreshold?: number;
  /**
   * The index for one (year, area) cell.
   *
   * Injected rather than read off the file because the index depends on which
   * region is pinned at 100, and that is a runtime choice: `file.index` holds
   * only the region's own. See indexAgainst() / useBaselineOverride().
   */
  indexAt: (yearIndex: number, areaIndex: number) => number | null;
}

/**
 * Rank the areas in one metric file.
 *
 * Built from the metric file rather than from the geometry-joined collection
 * on purpose: the collection drops any area whose polygon is missing for the
 * current boundary vintage, and a leaderboard that quietly omits real areas
 * because of a geometry gap is wrong in a way nobody would notice. It also
 * means the list renders before geometry arrives.
 */
export function buildLeaderboard(file: MetricFile, opts: LeaderboardOptions): Leaderboard {
  const {
    year,
    measure,
    basis,
    direction,
    limit = 10,
    excludeImprecise = true,
    cvThreshold = 0.15,
    indexAt,
  } = opts;

  const lastIndex = file.years.length - 1;
  const endIndex = basis === 'delta' ? lastIndex : file.years.indexOf(year);
  const startIndex = basis === 'delta' ? 0 : -1;
  if (endIndex === -1 || lastIndex < 0) {
    return { rows: [], total: 0, impreciseCount: 0, span: null };
  }
  // A one-year metric has no window to measure change over.
  if (basis === 'delta' && lastIndex === 0) {
    return { rows: [], total: 0, impreciseCount: 0, span: null };
  }

  const at = (yi: number, i: number): number | null =>
    measure === 'index' ? indexAt(yi, i) : (file.values[yi]?.[i] ?? null);
  const cvAt = (yi: number, i: number): number | null => file.cv?.[yi]?.[i] ?? null;

  let impreciseCount = 0;
  const eligible: LeaderboardRow[] = [];

  file.geoids.forEach((geoid, i) => {
    const end = at(endIndex, i);
    if (end == null) return;
    const start = basis === 'delta' ? at(startIndex, i) : null;
    // A change needs BOTH ends. Areas that exist in only one of them -- a tract
    // redrawn between eras, a place incorporated mid-series -- are absent from
    // the comparison rather than credited with their whole value as growth.
    if (basis === 'delta' && start == null) return;

    // Either endpoint being noisy makes the CHANGE noisy, so both are checked.
    const imprecise =
      isUnreliable(cvAt(endIndex, i), cvThreshold) ||
      (basis === 'delta' && isUnreliable(cvAt(startIndex, i), cvThreshold));
    if (imprecise) {
      impreciseCount += 1;
      if (excludeImprecise) return;
    }

    eligible.push({
      geoid,
      name: file.names[i] ?? geoid,
      position: 0,
      sortValue: basis === 'delta' ? end - (start as number) : end,
      value: file.values[endIndex]?.[i] ?? null,
      index: indexAt(endIndex, i),
      cv: cvAt(endIndex, i),
      from:
        basis === 'delta'
          ? { value: file.values[startIndex]?.[i] ?? null, index: indexAt(startIndex, i) }
          : null,
    });
  });

  eligible.sort((a, b) =>
    direction === 'highest' ? b.sortValue - a.sortValue : a.sortValue - b.sortValue,
  );

  return {
    rows: eligible.slice(0, limit).map((r, i) => ({ ...r, position: i + 1 })),
    total: eligible.length,
    impreciseCount,
    span: basis === 'delta' ? [file.years[0]!, file.years[lastIndex]!] : null,
  };
}

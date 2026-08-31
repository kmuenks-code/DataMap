import type { MetricFile } from '../../data/types.ts';

export interface Ranked {
  rank: number | null;
  percentile: number | null;
  total: number;
}

/**
 * Rank within the region for one year, ignoring areas with no data.
 *
 * Rank 1 is always "highest value", independent of whether high is good --
 * `higherIsBetter` belongs to presentation (which end of the color ramp), not
 * to the ordering itself. Mixing the two makes ranks incomparable across
 * metrics for no benefit.
 */
export function rankAll(file: MetricFile, yearIndex: number): Map<string, Ranked> {
  const row = file.values[yearIndex] ?? [];
  const present: { geoid: string; value: number }[] = [];

  file.geoids.forEach((geoid, i) => {
    const v = row[i];
    if (v != null) present.push({ geoid, value: v });
  });

  present.sort((a, b) => b.value - a.value);

  const out = new Map<string, Ranked>();
  const total = present.length;
  present.forEach((entry, i) => {
    out.set(entry.geoid, {
      rank: i + 1,
      percentile: total > 1 ? Math.round((1 - i / (total - 1)) * 100) : 100,
      total,
    });
  });
  return out;
}

/** Areas whose estimate is too imprecise to state confidently. */
export function isUnreliable(cv: number | null | undefined, threshold = 0.15): boolean {
  return cv != null && cv > threshold;
}

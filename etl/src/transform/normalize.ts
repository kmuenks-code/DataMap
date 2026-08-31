/**
 * Relative-index math -- the conceptual core of this project.
 *
 * For every (area, year) we emit:
 *   index = 100 * areaValue / metroValue
 *
 * The metro is pinned to 100 by construction in every year. An area at 130 in
 * 2010 and 118 in 2023 has lost ground relative to the metro even if its raw
 * dollar income rose. Two useful properties fall out of this for free:
 *
 *   1. Inflation cancels. Numerator and denominator are same-year dollars, so
 *      no CPI deflator is needed for the relative view. (The RAW view still
 *      needs one -- see toReal2023Dollars in this file.)
 *   2. Metro-wide shocks cancel, isolating local divergence.
 *
 * Caveat to surface in the UI: ACS 5-year estimates are 5-year rolling
 * averages, so consecutive years overlap and are NOT independent samples.
 * Compare non-overlapping years (2013 vs 2018 vs 2023) for real trend claims.
 */

export type MetricKind = 'median' | 'rate' | 'count' | 'ratio';

export interface AreaValue {
  geoid: string;
  value: number | null;
  moe?: number | null;
  /** Present for rate metrics; needed for correct aggregation. */
  numerator?: number | null;
  denominator?: number | null;
}

/**
 * Compute the region baseline (the "100%" line) for one year.
 *
 * Medians CANNOT be averaged -- the mean of tract medians is not the metro
 * median. For `kind: 'median'` the pipeline must instead pull the published
 * CBSA-level estimate ('baseline: published' in metrics.json), which is what
 * `publishedBaseline` carries. Rates and counts aggregate correctly from parts.
 */
export function computeBaseline(
  kind: MetricKind,
  areas: AreaValue[],
  publishedBaseline?: number | null,
): number | null {
  if (publishedBaseline != null) return publishedBaseline;

  if (kind === 'median') {
    throw new Error(
      'Refusing to average medians. Set baseline:"published" + baselineVar in metrics.json.',
    );
  }

  if (kind === 'rate' || kind === 'ratio') {
    let num = 0;
    let den = 0;
    for (const a of areas) {
      if (a.numerator == null || a.denominator == null) continue;
      num += a.numerator;
      den += a.denominator;
    }
    // Scaled to PERCENT, matching how area values are stored.
    //
    // The pipeline records a rate area-value as (numerator/denominator) * 100,
    // so the baseline must use the same units. Returning the bare fraction here
    // made every rate metric's index 100x too large -- a median index of 6159
    // instead of 62 -- which reads as a plausible map until you look at the
    // legend. Keep these two in lockstep.
    return den > 0 ? (num / den) * 100 : null;
  }

  // count
  const total = areas.reduce((s, a) => s + (a.value ?? 0), 0);
  return areas.length > 0 ? total / areas.length : null;
}

/** 100 = metro average. Returns null where either side is missing. */
export function toIndex(value: number | null, baseline: number | null): number | null {
  if (value == null || baseline == null || baseline === 0) return null;
  return (value / baseline) * 100;
}

/**
 * Coefficient of variation from the ACS margin of error (90% CI).
 * Tract-level estimates are often statistically useless -- a CV above ~0.30 is
 * conventionally "do not publish". The app dims / hatches these rather than
 * hiding them, so the user can see WHERE the data is thin.
 */
export function coefficientOfVariation(value: number | null, moe: number | null): number | null {
  if (value == null || moe == null || value === 0) return null;
  const standardError = moe / 1.645;
  return Math.abs(standardError / value);
}

/** CPI-U annual averages, rebased so 2023 = 1.0. Extend as new years land. */
const CPI_U_TO_2023: Record<number, number> = {
  2009: 1.42, 2010: 1.40, 2011: 1.36, 2012: 1.33, 2013: 1.31, 2014: 1.29,
  2015: 1.29, 2016: 1.27, 2017: 1.25, 2018: 1.22, 2019: 1.19, 2020: 1.18,
  2021: 1.13, 2022: 1.05, 2023: 1.00,
};

/** Only for the RAW-dollar view. The relative index needs no deflator. */
export function toReal2023Dollars(value: number | null, year: number): number | null {
  const factor = CPI_U_TO_2023[year];
  if (value == null || factor == null) return null;
  return value * factor;
}

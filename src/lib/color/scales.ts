/**
 * Color ramps.
 *
 * The index view uses a DIVERGING ramp centered on 100, because the whole point
 * is "above or below the metro" -- a sequential ramp would bury the crossing
 * point that carries the meaning. The raw view uses a sequential ramp, since
 * there is no meaningful midpoint.
 *
 * Ramps are colorblind-safe (ColorBrewer PuOr / YlGnBu) and read on both light
 * and dark backgrounds.
 */

/** Below metro -> above metro. Purple/orange: safe for deuteranopia, unlike red/green. */
const DIVERGING = [
  '#8c510a', '#bf812d', '#dfc27d', '#f6e8c3',
  '#f5f5f5',
  '#c7eae5', '#80cdc1', '#35978f', '#01665e',
] as const;

const SEQUENTIAL = [
  '#ffffd9', '#edf8b1', '#c7e9b4', '#7fcdbb',
  '#41b6c4', '#1d91c0', '#225ea8', '#253494', '#081d58',
] as const;

export type Ramp = readonly string[];

export function rampFor(mode: 'index' | 'raw'): Ramp {
  return mode === 'index' ? DIVERGING : SEQUENTIAL;
}

/**
 * Diverging breaks centered on 100.
 *
 * Symmetric around the center so equal divergence gets equal color weight in
 * both directions. The span is driven by the data's own spread, clamped so a
 * single wild outlier cannot flatten everything else to the middle.
 */
export function divergingBreaks(values: number[], center = 100): number[] {
  const spread = robustSpread(values, center);
  const steps = [1, 0.6, 0.3, 0.1];
  return [
    ...steps.map((s) => center - spread * s),
    ...[...steps].reverse().map((s) => center + spread * s),
  ];
}

/** Quantile breaks: equal-count bins, so the map uses its whole palette. */
export function quantileBreaks(values: number[], bins = 9): number[] {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const out: number[] = [];
  for (let i = 1; i < bins; i++) {
    out.push(sorted[Math.floor((i / bins) * sorted.length)] ?? sorted[sorted.length - 1]!);
  }
  return out;
}

/**
 * 90th-percentile deviation rather than max: with ACS data a couple of tiny,
 * high-MOE areas routinely sit at 3x the metro, and letting them set the scale
 * washes out every real difference.
 */
function robustSpread(values: number[], center: number): number {
  const deviations = values
    .filter((v) => Number.isFinite(v))
    .map((v) => Math.abs(v - center))
    .sort((a, b) => a - b);
  if (deviations.length === 0) return 50;
  const p90 = deviations[Math.floor(deviations.length * 0.9)] ?? 50;
  return Math.max(10, Math.min(p90, 150));
}

/** MapLibre `step` expression: [ramp[0], break0, ramp[1], break1, ...]. */
export function toStepExpression(
  ramp: Ramp,
  breaks: number[],
): (string | number)[] {
  const out: (string | number)[] = [ramp[0]!];
  breaks.forEach((b, i) => {
    out.push(b, ramp[Math.min(i + 1, ramp.length - 1)]!);
  });
  return out;
}

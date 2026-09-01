/** Axis tick generation. Kept apart from formatting: where the marks go, not what they read. */

/** Round tick steps (1, 2, 2.5, 5 x 10^n) covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const raw = (max - min) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step / 1e6; t += step) {
    // Snap away the float dust that makes a tick read "0.30000000000000004",
    // and with it the negative zero that a padded domain otherwise prints as "-0".
    const v = Math.round(t / step) * step;
    out.push(v === 0 ? 0 : v);
  }
  return out;
}

/**
 * Powers of ten across the domain, with 2x and 5x subdivisions when the span
 * is narrow enough that decades alone would leave one or two labels.
 */
export function logTicks(min: number, max: number): number[] {
  if (!(min > 0) || !(max > 0)) return [];
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  const dense = hi - lo <= 3;
  const out: number[] = [];
  for (let e = lo; e <= hi; e += 1) {
    for (const m of dense ? [1, 2, 5] : [1]) {
      const v = m * Math.pow(10, e);
      if (v >= min && v <= max) out.push(v);
    }
  }
  return out;
}

/** Value formatting. Units come from the metric registry, so this is the only place they map to display. */

export function formatValue(value: number | null, unit: string): string {
  if (value == null) return '—';
  switch (unit) {
    case 'usd':
      return value >= 1000
        ? `$${Math.round(value).toLocaleString()}`
        : `$${value.toFixed(0)}`;
    case 'usd-monthly':
      return `$${Math.round(value).toLocaleString()}/mo`;
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'years':
      return `${value.toFixed(1)} yrs`;
    case 'people':
      return Math.round(value).toLocaleString();
    default:
      return value.toLocaleString();
  }
}

/** The index is the headline number, so it reads as "of <baseline> average". */
export function formatIndex(index: number | null): string {
  if (index == null) return '—';
  return `${index.toFixed(0)}%`;
}

/**
  * Signed distance from the baseline, which is what the timeline is really
  * about. The noun is passed in rather than assumed: "vs metro" on the
  * national map would name the wrong denominator. See lib/baseline.ts.
  */
export function formatRelative(index: number | null, noun = 'metro'): string {
  if (index == null) return '—';
  const delta = index - 100;
  if (Math.abs(delta) < 0.5) return `at ${noun} average`;
  return `${delta > 0 ? '+' : ''}${delta.toFixed(0)} pts vs ${noun}`;
}

export function formatOrdinal(n: number | null): string {
  if (n == null) return '—';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

/**
 * A signed change in a metric's own units, for the leaderboard's delta mode.
 *
 * Always signed, including a leading '+': the whole point of the column is
 * direction, and an unsigned "4,200" next to a signed "-1,900" reads as a
 * formatting slip rather than growth. Zero is written as "0" with no sign.
 */
export function formatDelta(value: number | null, unit: string): string {
  if (value == null) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${formatValue(Math.abs(value), unit)}`;
}

/**
 * A signed change in INDEX POINTS -- "+14 pts" -- which is what a move looks
 * like when the baseline is pinned at 100.
 *
 * Points, not percent: 179 -> 193 is +14 points and +7.8%, and calling it a
 * percentage of a percentage is how index charts get misread.
 */
export function formatIndexDelta(value: number | null): string {
  if (value == null) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(1)} pts`;
}

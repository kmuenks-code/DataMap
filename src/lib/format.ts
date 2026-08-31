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

/** The index is the headline number, so it reads as "of metro average". */
export function formatIndex(index: number | null): string {
  if (index == null) return '—';
  return `${index.toFixed(0)}%`;
}

/** Signed distance from the metro baseline, which is what the timeline is really about. */
export function formatRelative(index: number | null): string {
  if (index == null) return '—';
  const delta = index - 100;
  if (Math.abs(delta) < 0.5) return 'at metro average';
  return `${delta > 0 ? '+' : ''}${delta.toFixed(0)} pts vs metro`;
}

export function formatOrdinal(n: number | null): string {
  if (n == null) return '—';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

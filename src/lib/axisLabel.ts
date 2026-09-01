import type { AxisSelection } from '../state/useAppStore.ts';
import type { AxisMeta } from './stats/scatter.ts';
import { formatDelta, formatIndex, formatIndexDelta, formatValue } from './format.ts';

/**
 * The four things an axis can plot, as one token.
 *
 * The store keeps (measure, basis) because that is what the stats layer
 * consumes; a control offering two separate dropdowns for a choice the reader
 * experiences as one is worse, so the UI flattens them here and only here.
 */
export type AxisQuantity = 'value' | 'index' | 'delta-value' | 'delta-index';

export function quantityOf(sel: Pick<AxisSelection, 'measure' | 'basis'>): AxisQuantity {
  if (sel.basis === 'delta') return sel.measure === 'index' ? 'delta-index' : 'delta-value';
  return sel.measure === 'index' ? 'index' : 'value';
}

export function quantityToSelection(q: AxisQuantity): Pick<AxisSelection, 'measure' | 'basis'> {
  switch (q) {
    case 'index':
      return { measure: 'index', basis: 'level' };
    case 'delta-value':
      return { measure: 'raw', basis: 'delta' };
    case 'delta-index':
      return { measure: 'index', basis: 'delta' };
    default:
      return { measure: 'raw', basis: 'level' };
  }
}

/** What each option is called, given what the 100% line is called here. */
export function quantityLabel(q: AxisQuantity, noun: string): string {
  switch (q) {
    case 'index':
      return `% of ${noun}`;
    case 'delta-value':
      return 'Change in value';
    case 'delta-index':
      return `Change vs ${noun} (pts)`;
    default:
      return 'Value';
  }
}

/**
 * The axis caption -- and it must state the window, because the two halves of
 * a scatter can be reading different years. A metric that does not publish the
 * scrubbed year is drawn at its nearest one, and an axis that does not say so
 * is claiming a year it did not use.
 */
export function axisTitle(
  metricLabel: string,
  sel: Pick<AxisSelection, 'measure' | 'basis' | 'log'>,
  noun: string,
  meta: AxisMeta | null,
): string {
  const q = quantityOf(sel);
  const span = meta?.span ? `${meta.span[0]}→${meta.span[1]}` : 'the full span';
  const year = meta ? `${meta.year}${meta.clamped ? ' (nearest published)' : ''}` : '';
  const log = sel.log ? ' — log scale' : '';

  switch (q) {
    case 'index':
      return `${metricLabel} — % of ${noun}, ${year}${log}`;
    case 'delta-value':
      return `${metricLabel} — change ${span}`;
    case 'delta-index':
      return `${metricLabel} — change vs ${noun}, ${span} (pts)`;
    default:
      return `${metricLabel}, ${year}${log}`;
  }
}

/** Format a number on an axis in the units that axis is actually plotting. */
export function formatAxis(
  value: number | null,
  sel: Pick<AxisSelection, 'measure' | 'basis'>,
  unit: string,
): string {
  switch (quantityOf(sel)) {
    case 'index':
      return formatIndex(value);
    case 'delta-value':
      return formatDelta(value, unit);
    case 'delta-index':
      return formatIndexDelta(value);
    default:
      return formatValue(value, unit);
  }
}

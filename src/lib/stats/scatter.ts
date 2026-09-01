import type { MetricFile } from '../../data/types.ts';
import type { RankBasis, RankMeasure } from './leaderboard.ts';
import { isUnreliable } from './ranking.ts';

/**
 * One axis of the scatter: which metric, and which QUANTITY of it.
 *
 * The pair (measure, basis) is deliberately the same pair the leaderboard
 * ranks on, and for the same reason -- "how big is it" and "how far did it
 * move" are different questions, and each can be asked of the raw number or of
 * the index. Folding them into a single three-way "raw | index | change" mode
 * would leave 'change' silently ambiguous about its units: an income shift is
 * +$8,400 or +14 points depending on which, and those are different claims.
 */
export interface ScatterAxis {
  file: MetricFile;
  measure: RankMeasure;
  basis: RankBasis;
  /** Plot on a log scale. Meaningless for a change, which is signed. */
  log?: boolean;
  /**
   * The index for one (year, area) cell -- injected for the same reason as in
   * buildLeaderboard(): `file.index` holds only the region's own baseline, and
   * which region is pinned at 100 is a runtime choice.
   */
  indexAt: (yearIndex: number, areaIndex: number) => number | null;
}

/** What one axis contributes to a point, including the context the tooltip needs. */
export interface AxisReading {
  /** The number actually plotted, before any log transform. */
  plotted: number;
  value: number | null;
  index: number | null;
  /** Change readings only: the start-of-window state the move was measured from. */
  from: { value: number | null; index: number | null } | null;
  cv: number | null;
}

export interface ScatterPoint {
  geoid: string;
  name: string;
  x: AxisReading;
  y: AxisReading;
  /** The sizing metric's value, or null when none was supplied. */
  size: number | null;
}

/** Where an axis actually read from, which is not always where it was asked to. */
export interface AxisMeta {
  /** The year used for a 'level' reading. */
  year: number;
  /**
   * True when that is not the year on the scrubber, because this metric does
   * not publish it -- unemployment starts in 2011, education in 2012. The axis
   * label has to say so, or the plot claims a year it did not use.
   */
  clamped: boolean;
  /** Change readings only: the window measured, as [firstYear, lastYear]. */
  span: [number, number] | null;
}

/** Least-squares fit through the plotted cloud, in the space it is drawn in. */
export interface ScatterFit {
  slope: number;
  intercept: number;
  /** Pearson correlation of the plotted coordinates. */
  r: number;
  n: number;
}

export interface ScatterResult {
  points: ScatterPoint[];
  /** Areas with a usable reading on BOTH axes, before the imprecision cut. */
  total: number;
  /** Areas dropped (or merely counted) for a coefficient of variation over the threshold. */
  impreciseCount: number;
  /**
   * Areas a log axis cannot place. log(0) is undefined and a negative has no
   * log at all, so these are omitted rather than clamped to the axis floor,
   * which would invent a position for them.
   */
  nonPositiveCount: number;
  x: AxisMeta;
  y: AxisMeta;
  fit: ScatterFit | null;
}

export interface ScatterOptions {
  x: ScatterAxis;
  y: ScatterAxis;
  /** The year on the scrubber. Used by 'level' axes; a 'delta' axis spans everything. */
  year: number;
  /** Values to size the dots by, already loaded for the same region and geo level. */
  size?: MetricFile | null;
  excludeImprecise?: boolean;
  cvThreshold?: number;
}

/** The index of the published year closest to `year`. Two metrics need not share coverage. */
function nearestYearIndex(years: number[], year: number): number {
  if (years.length === 0) return -1;
  const exact = years.indexOf(year);
  if (exact !== -1) return exact;
  let best = 0;
  years.forEach((y, i) => {
    if (Math.abs(y - year) < Math.abs(years[best]! - year)) best = i;
  });
  return best;
}

interface AxisWindow {
  endIndex: number;
  startIndex: number;
  meta: AxisMeta;
}

function windowFor(axis: ScatterAxis, year: number): AxisWindow | null {
  const years = axis.file.years;
  const last = years.length - 1;
  if (last < 0) return null;

  if (axis.basis === 'delta') {
    // A single-year metric has no window to measure a change over.
    if (last === 0) return null;
    return {
      endIndex: last,
      startIndex: 0,
      meta: { year: years[last]!, clamped: false, span: [years[0]!, years[last]!] },
    };
  }

  const endIndex = nearestYearIndex(years, year);
  if (endIndex === -1) return null;
  return {
    endIndex,
    startIndex: -1,
    meta: { year: years[endIndex]!, clamped: years[endIndex] !== year, span: null },
  };
}

function readingFor(axis: ScatterAxis, w: AxisWindow, i: number): AxisReading | null {
  const at = (yi: number): number | null =>
    axis.measure === 'index' ? axis.indexAt(yi, i) : (axis.file.values[yi]?.[i] ?? null);

  const end = at(w.endIndex);
  if (end == null) return null;

  // A change needs BOTH ends. An area present in only one of them -- a tract
  // redrawn between eras, a place incorporated mid-series -- is absent from the
  // comparison rather than credited with its whole value as movement.
  const start = axis.basis === 'delta' ? at(w.startIndex) : null;
  if (axis.basis === 'delta' && start == null) return null;

  const cvAt = (yi: number): number | null => axis.file.cv?.[yi]?.[i] ?? null;
  // Either endpoint being noisy makes the change noisy, so the worst is carried.
  const cv = Math.max(
    cvAt(w.endIndex) ?? 0,
    axis.basis === 'delta' ? (cvAt(w.startIndex) ?? 0) : 0,
  );

  return {
    plotted: axis.basis === 'delta' ? end - (start as number) : end,
    value: axis.file.values[w.endIndex]?.[i] ?? null,
    index: axis.indexAt(w.endIndex, i),
    from:
      axis.basis === 'delta'
        ? {
            value: axis.file.values[w.startIndex]?.[i] ?? null,
            index: axis.indexAt(w.startIndex, i),
          }
        : null,
    cv: cv > 0 ? cv : null,
  };
}

/**
 * Pair two metrics over the same areas.
 *
 * Built from the metric files rather than from the map's joined collection, for
 * the same reason the leaderboard is: the collection drops any area whose
 * polygon is missing for the current boundary vintage, and a correlation
 * computed over a silently reduced set of areas is wrong in a way nobody would
 * notice. It also means the plot renders without downloading any geometry --
 * this view needs none.
 */
export function buildScatter(opts: ScatterOptions): ScatterResult | null {
  const { x, y, year, size = null, excludeImprecise = true, cvThreshold = 0.15 } = opts;

  const xw = windowFor(x, year);
  const yw = windowFor(y, year);
  if (!xw || !yw) return null;

  const yIndexByGeoid = new Map(y.file.geoids.map((g, i) => [g, i]));
  const sizeByGeoid = size
    ? (() => {
        const si = nearestYearIndex(size.years, year);
        const row = si === -1 ? [] : (size.values[si] ?? []);
        return new Map(size.geoids.map((g, i) => [g, row[i] ?? null]));
      })()
    : null;

  const points: ScatterPoint[] = [];
  let total = 0;
  let impreciseCount = 0;
  let nonPositiveCount = 0;

  x.file.geoids.forEach((geoid, xi) => {
    const yi = yIndexByGeoid.get(geoid);
    if (yi === undefined) return;

    const xr = readingFor(x, xw, xi);
    const yr = readingFor(y, yw, yi);
    if (!xr || !yr) return;

    total += 1;

    if (isUnreliable(xr.cv, cvThreshold) || isUnreliable(yr.cv, cvThreshold)) {
      impreciseCount += 1;
      if (excludeImprecise) return;
    }

    if ((x.log === true && xr.plotted <= 0) || (y.log === true && yr.plotted <= 0)) {
      nonPositiveCount += 1;
      return;
    }

    points.push({
      geoid,
      name: x.file.names[xi] ?? y.file.names[yi] ?? geoid,
      x: xr,
      y: yr,
      size: sizeByGeoid?.get(geoid) ?? null,
    });
  });

  return {
    points,
    total,
    impreciseCount,
    nonPositiveCount,
    x: xw.meta,
    y: yw.meta,
    fit: fitLine(points, x.log === true, y.log === true),
  };
}

/**
 * Ordinary least squares, computed in the space the dots are DRAWN in.
 *
 * A log axis means the straight line on screen is a fit to the logs, and `r`
 * describes that same relationship -- a line fitted to raw values would not
 * pass through its own cloud once the axis is transformed.
 *
 * The caveat that cannot be fixed here, only stated: consecutive ACS 5-year
 * estimates share sample, so an `r` computed over changes across the span has
 * no clean degrees of freedom. It describes this picture; it is not a test.
 */
export function fitLine(points: ScatterPoint[], xLog: boolean, yLog: boolean): ScatterFit | null {
  const n = points.length;
  if (n < 3) return null;

  const xs = points.map((p) => (xLog ? Math.log10(p.x.plotted) : p.x.plotted));
  const ys = points.map((p) => (yLog ? Math.log10(p.y.plotted) : p.y.plotted));

  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  // A degenerate axis (every area identical) has no line and no correlation.
  if (sxx === 0 || syy === 0) return null;

  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r: sxy / Math.sqrt(sxx * syy), n };
}

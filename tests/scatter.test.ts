import { describe, expect, it } from 'vitest';

import type { MetricFile } from '../src/data/types.ts';
import { axisTitle } from '../src/lib/axisLabel.ts';
import { buildScatter, fitLine, type ScatterAxis } from '../src/lib/stats/scatter.ts';

/**
 * Four areas over three years, in the shape the ETL emits.
 *
 * `d` is missing 2009 -- a tract redrawn between boundary eras -- and `c` is
 * the small, noisy one whose swing is survey error, exactly the two cases the
 * plot has to handle without inventing a dot.
 */
function file(over: Partial<MetricFile> = {}): MetricFile {
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

function axis(f: MetricFile, over: Partial<ScatterAxis> = {}): ScatterAxis {
  return {
    file: f,
    measure: 'raw',
    basis: 'level',
    indexAt: (yi, i) => f.index[yi]?.[i] ?? null,
    ...over,
  };
}

const byName = (r: { points: { name: string }[] } | null) => r?.points.map((p) => p.name);

describe('buildScatter', () => {
  it('pairs the two metrics on geoid for the selected year', () => {
    const income = file({ metric: 'income', values: [[1, 2, 3, null], [4, 5, 6, 7], [8, 9, 10, 11]] });
    const r = buildScatter({ x: axis(file()), y: axis(income), year: 2016 });

    expect(byName(r)).toEqual(['Alpha', 'Bravo', 'Delta']); // Charlie is imprecise
    expect(r!.points[0]!.x.plotted).toBe(600);
    expect(r!.points[0]!.y.plotted).toBe(4);
  });

  it('excludes imprecise areas by default, counts them either way', () => {
    const excluded = buildScatter({ x: axis(file()), y: axis(file()), year: 2024 });
    expect(excluded!.impreciseCount).toBe(1);
    expect(byName(excluded)).not.toContain('Charlie');

    const included = buildScatter({
      x: axis(file()),
      y: axis(file()),
      year: 2024,
      excludeImprecise: false,
    });
    expect(included!.impreciseCount).toBe(1);
    expect(byName(included)).toContain('Charlie');
    expect(included!.total).toBe(4);
  });

  it('drops an area with no data on one axis rather than plotting it at zero', () => {
    const sparse = file({ metric: 'income', values: [[1, 2, 3, 4], [5, null, 7, 8], [9, 10, 11, 12]] });
    const r = buildScatter({ x: axis(file()), y: axis(sparse), year: 2016 });
    expect(byName(r)).toEqual(['Alpha', 'Delta']);
  });

  it('measures change across the full published span, and needs both ends', () => {
    const r = buildScatter({
      x: axis(file(), { basis: 'delta' }),
      y: axis(file()),
      year: 2016,
    });

    expect(r!.x.span).toEqual([2009, 2024]);
    // Delta has no 2009 value, so it has no change -- it is absent rather than
    // credited with its whole 2024 population as growth.
    expect(byName(r)).toEqual(['Alpha', 'Bravo']);
    expect(r!.points[0]!.x.plotted).toBe(200);
    expect(r!.points[0]!.x.from).toEqual({ value: 500, index: 50 });
    // A level axis alongside a change axis still reads the scrubbed year.
    expect(r!.y.span).toBeNull();
    expect(r!.points[0]!.y.plotted).toBe(600);
  });

  it('measures change in index points when the axis is indexed', () => {
    const r = buildScatter({
      x: axis(file(), { basis: 'delta', measure: 'index' }),
      y: axis(file()),
      year: 2016,
    });
    expect(r!.points[0]!.x.plotted).toBe(20); // 50 -> 70
  });

  it('indexes against the injected baseline, not the file, so an ancestor repins it', () => {
    const vsUs = axis(file(), { measure: 'index', indexAt: (yi, i) => (file().values[yi]?.[i] ?? 0) / 2 });
    const r = buildScatter({ x: vsUs, y: axis(file()), year: 2024 });
    expect(r!.points[0]!.x.plotted).toBe(350); // 700 / 2, not the file's 70
  });

  it('reads the nearest published year and says so when the metric lacks the scrubbed one', () => {
    const late = file({ metric: 'unemployment', years: [2011, 2016, 2024] });
    const r = buildScatter({ x: axis(file()), y: axis(late), year: 2009 });

    expect(r!.x.clamped).toBe(false);
    expect(r!.y.clamped).toBe(true);
    expect(r!.y.year).toBe(2011);
  });

  it('omits values a log axis cannot place, rather than clamping them to the floor', () => {
    const withZero = file({ values: [[0, 900, 100, null], [0, 950, 300, 700], [0, 1000, 900, 800]] });
    const r = buildScatter({ x: axis(withZero, { log: true }), y: axis(file()), year: 2024 });

    expect(r!.nonPositiveCount).toBe(1);
    expect(byName(r)).toEqual(['Bravo', 'Delta']);
  });

  it('has no change to plot for a single-year metric', () => {
    const oneYear = file({ years: [2024], values: [[1, 2, 3, 4]], index: [[1, 2, 3, 4]], cv: [[0, 0, 0, 0]] });
    expect(buildScatter({ x: axis(oneYear, { basis: 'delta' }), y: axis(file()), year: 2024 })).toBeNull();
  });

  it('sizes dots from a third metric, read at the same year', () => {
    const pop = file({ metric: 'pop2' });
    const r = buildScatter({ x: axis(file()), y: axis(file()), year: 2016, size: pop });
    expect(r!.points[0]!.size).toBe(600);
  });
});

describe('fitLine', () => {
  const points = (pairs: [number, number][]) =>
    pairs.map(([x, y], i) => ({
      geoid: String(i),
      name: String(i),
      x: { plotted: x, value: x, index: null, from: null, cv: null },
      y: { plotted: y, value: y, index: null, from: null, cv: null },
      size: null,
    }));

  it('recovers a straight line exactly', () => {
    const fit = fitLine(points([[1, 3], [2, 5], [3, 7], [4, 9]]), false, false);
    expect(fit!.slope).toBeCloseTo(2);
    expect(fit!.intercept).toBeCloseTo(1);
    expect(fit!.r).toBeCloseTo(1);
  });

  it('signs r for an inverse relationship', () => {
    expect(fitLine(points([[1, 9], [2, 7], [3, 5], [4, 3]]), false, false)!.r).toBeCloseTo(-1);
  });

  it('fits in log space when the axis is logged, so the drawn line matches the cloud', () => {
    // y = x^2 is a straight line of slope 2 once both axes are logs.
    const fit = fitLine(points([[1, 1], [10, 100], [100, 10000], [1000, 1e6]]), true, true);
    expect(fit!.slope).toBeCloseTo(2);
    expect(fit!.r).toBeCloseTo(1);
  });

  it('declines to fit a degenerate or near-empty cloud', () => {
    expect(fitLine(points([[1, 1], [2, 2]]), false, false)).toBeNull();
    expect(fitLine(points([[1, 5], [1, 6], [1, 7]]), false, false)).toBeNull();
  });
});

describe('axisTitle', () => {
  const level = { year: 2024, clamped: false, span: null };
  const sel = (measure: 'raw' | 'index', basis: 'level' | 'delta', log = false) => ({
    measure,
    basis,
    log,
  });

  it('names the year a level axis actually read', () => {
    expect(axisTitle('Median Household Income', sel('raw', 'level'), 'metro', level)).toBe(
      'Median Household Income, 2024',
    );
  });

  it('says so when the metric does not publish the scrubbed year', () => {
    expect(
      axisTitle('Unemployment Rate', sel('raw', 'level'), 'metro', {
        year: 2011,
        clamped: true,
        span: null,
      }),
    ).toBe('Unemployment Rate, 2011 (nearest published)');
  });

  it('names the baseline, because "100" is a choice the reader made', () => {
    expect(axisTitle('Poverty Rate', sel('index', 'level'), 'US', level)).toBe(
      'Poverty Rate — % of US, 2024',
    );
  });

  it('states the window and the units a change is measured in', () => {
    const span = { year: 2024, clamped: false, span: [2009, 2024] as [number, number] };
    expect(axisTitle('Poverty Rate', sel('raw', 'delta'), 'metro', span)).toBe(
      'Poverty Rate — change 2009→2024',
    );
    expect(axisTitle('Poverty Rate', sel('index', 'delta'), 'metro', span)).toBe(
      'Poverty Rate — change vs metro, 2009→2024 (pts)',
    );
  });

  it('marks a log axis, since the spacing is not what a reader assumes', () => {
    expect(axisTitle('Total Population', sel('raw', 'level', true), 'metro', level)).toBe(
      'Total Population, 2024 — log scale',
    );
  });
});

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useScatterData } from '../../data/useScatterData.ts';
import { findMetric, type MetricSummary } from '../../data/types.ts';
import { axisTitle, formatAxis, quantityOf } from '../../lib/axisLabel.ts';
import { baselineNoun, useBaselineTargetFor } from '../../lib/baseline.ts';
import { formatValue } from '../../lib/format.ts';
import { isUnreliable } from '../../lib/stats/ranking.ts';
import type { ScatterPoint, ScatterResult } from '../../lib/stats/scatter.ts';
import { logTicks, niceTicks } from '../../lib/ticks.ts';
import { useAppStore, type AxisSelection } from '../../state/useAppStore.ts';

// The bottom band holds the tick labels, the axis title and the footer strip
// that reports n and r -- all three inside the same measured box.
const PAD = { top: 18, right: 22, bottom: 76, left: 82 };
const DOT_MIN = 2.5;
const DOT_MAX = 15;

/** A linear or log10 mapping from data space to pixels, plus its ticks. */
interface Scale {
  to: (v: number) => number;
  ticks: number[];
  domain: [number, number];
}

function buildScale(values: number[], range: [number, number], log: boolean): Scale | null {
  const usable = log ? values.filter((v) => v > 0) : values;
  if (usable.length === 0) return null;

  let lo = Math.min(...usable);
  let hi = Math.max(...usable);
  if (lo === hi) {
    // A single distinct value still needs a box to sit in the middle of.
    const pad = Math.abs(lo) || 1;
    lo -= pad;
    hi += pad;
  }

  if (log) {
    const l0 = Math.log10(lo);
    const l1 = Math.log10(hi);
    const pad = (l1 - l0) * 0.05 || 0.1;
    const a = l0 - pad;
    const b = l1 + pad;
    return {
      to: (v) => range[0] + ((Math.log10(v) - a) / (b - a)) * (range[1] - range[0]),
      ticks: logTicks(Math.pow(10, a), Math.pow(10, b)),
      domain: [Math.pow(10, a), Math.pow(10, b)],
    };
  }

  const pad = (hi - lo) * 0.06;
  const a = lo - pad;
  const b = hi + pad;
  return {
    to: (v) => range[0] + ((v - a) / (b - a)) * (range[1] - range[0]),
    ticks: niceTicks(a, b, 6),
    domain: [a, b],
  };
}

/**
 * Dot area proportional to population, which means radius on a square root --
 * scaling the radius directly would make a township of 40,000 look eight times
 * a township of 5,000 rather than the ~3x it is.
 */
function radiusScale(points: ScatterPoint[]): (p: ScatterPoint) => number {
  const sizes = points.map((p) => p.size).filter((s): s is number => s != null && s > 0);
  if (sizes.length === 0) return () => 4;
  const max = Math.max(...sizes);
  const min = Math.min(...sizes);
  if (max === min) return () => 5;
  return (p) => {
    if (p.size == null || p.size <= 0) return DOT_MIN;
    const t = (Math.sqrt(p.size) - Math.sqrt(min)) / (Math.sqrt(max) - Math.sqrt(min));
    return DOT_MIN + t * (DOT_MAX - DOT_MIN);
  };
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect;
      if (r) setSize({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}

/**
 * Two metrics, one dot per area.
 *
 * Shares the map's entire scope -- region, geo level, year, baseline -- and
 * adds only the second metric and each axis's quantity. That is what makes it
 * a second reading of the same selection rather than a second app: switch the
 * region here and the map moves with it.
 */
export function ScatterView() {
  const region = useAppStore((s) => s.region());
  const axes = useAppStore((s) => s.axes);
  const geoLevelId = useAppStore((s) => s.geoLevelId);
  const showImprecise = useAppStore((s) => s.scatterShowImprecise);
  const trendline = useAppStore((s) => s.scatterTrendline);
  const hoveredGeoid = useAppStore((s) => s.hoveredGeoid);
  const selectedGeoid = useAppStore((s) => s.selectedGeoid);
  const setHovered = useAppStore((s) => s.setHovered);
  const setSelected = useAppStore((s) => s.setSelected);

  const { result, sizeMetric } = useScatterData();
  const { ref, width, height } = useElementSize<HTMLDivElement>();

  const xMetric = region && axes.x.metricId ? findMetric(region, axes.x.metricId) : undefined;
  const yMetric = region && axes.y.metricId ? findMetric(region, axes.y.metricId) : undefined;
  const xNoun = baselineNoun(useBaselineTargetFor(axes.x.metricId));
  const yNoun = baselineNoun(useBaselineTargetFor(axes.y.metricId));
  const level = region?.geoLevels.find((g) => g.id === geoLevelId);

  const plot = useMemo(() => {
    if (!result || width <= 0 || height <= 0) return null;
    const x = buildScale(
      result.points.map((p) => p.x.plotted),
      [PAD.left, width - PAD.right],
      axes.x.log,
    );
    const y = buildScale(
      result.points.map((p) => p.y.plotted),
      [height - PAD.bottom, PAD.top],
      axes.y.log,
    );
    if (!x || !y) return null;
    return { x, y, r: radiusScale(result.points) };
  }, [result, width, height, axes.x.log, axes.y.log]);

  // Hovering is local: a dot under the cursor is a pointer position, not app
  // state. The store still hears about it so the map and the Top 10 highlight
  // the same area when the reader switches back.
  const [hover, setHover] = useState<{ point: ScatterPoint; x: number; y: number } | null>(null);
  useEffect(() => {
    if (hover && hover.point.geoid !== hoveredGeoid) setHover(null);
  }, [hoveredGeoid, hover]);

  const active = hover?.point.geoid ?? hoveredGeoid;

  /*
   * The measured container is rendered UNCONDITIONALLY, with the empty and
   * loading states inside it. Returning a different element while the data is
   * in flight leaves the ref unattached on the only pass the size observer
   * runs on, so it never observes anything and the plot area stays 0x0 --
   * silently, since the footer and controls render fine.
   */
  return (
    <div className="scatter" ref={ref}>
      {!xMetric || !yMetric ? (
        <p className="scatter-message">Pick a metric for each axis.</p>
      ) : !result ? (
        <p className="scatter-message">Loading…</p>
      ) : result.points.length === 0 ? (
        <p className="scatter-message">
          No areas have data for both metrics
          {result.total > 0 ? ' once imprecise areas are excluded' : ''}.
        </p>
      ) : (
        plot && (
          <svg width={width} height={height} role="img" aria-label={`${xMetric.label} against ${yMetric.label}`}>
            <Gridlines plot={plot} axes={axes} xMetric={xMetric} yMetric={yMetric} width={width} height={height} />

            {/*
              A reference line where the quantity's own origin is: 100 for an
              index (the baseline itself), 0 for a change (no movement). The
              quadrants only mean anything with it drawn.
            */}
            <OriginLines plot={plot} axes={axes} width={width} height={height} />

            {trendline && result.fit && (
              <FitLine plot={plot} fit={result.fit} logX={axes.x.log} logY={axes.y.log} />
            )}

            <g>
              {result.points.map((p) => {
                const cx = plot.x.to(p.x.plotted);
                const cy = plot.y.to(p.y.plotted);
                const isActive = p.geoid === active;
                const isSelected = p.geoid === selectedGeoid;
                return (
                  <circle
                    key={p.geoid}
                    // Imprecise areas, when the reader has put them back, are
                    // drawn faded rather than identically: they are in the
                    // cloud on sufferance and the picture should say so.
                    className={`dot${isActive ? ' hot' : ''}${isSelected ? ' sel' : ''}${
                      isUnreliable(p.x.cv) || isUnreliable(p.y.cv) ? ' imprecise' : ''
                    }`}
                    cx={cx}
                    cy={cy}
                    r={plot.r(p)}
                    onMouseEnter={() => {
                      setHover({ point: p, x: cx, y: cy });
                      setHovered(p.geoid);
                    }}
                    onMouseLeave={() => {
                      setHover(null);
                      setHovered(null);
                    }}
                    onClick={() => setSelected(selectedGeoid === p.geoid ? null : p.geoid)}
                  />
                );
              })}
            </g>

            <text className="axis-title" x={(PAD.left + width - PAD.right) / 2} y={height - 38} textAnchor="middle">
              {axisTitle(xMetric.label, axes.x, xNoun, result.x)}
            </text>
            <text
              className="axis-title"
              transform={`translate(16, ${(PAD.top + height - PAD.bottom) / 2}) rotate(-90)`}
              textAnchor="middle"
            >
              {axisTitle(yMetric.label, axes.y, yNoun, result.y)}
            </text>
          </svg>
        )
      )}

      {hover && xMetric && yMetric && (
        <Tooltip
          point={hover.point}
          x={hover.x}
          y={hover.y}
          width={width}
          xMetric={xMetric}
          yMetric={yMetric}
          axes={axes}
          nouns={{ x: xNoun, y: yNoun }}
          sizeMetric={sizeMetric}
        />
      )}

      {result && (
        <ScatterFooter
          result={result}
          showImprecise={showImprecise}
          tilesRegion={level?.tilesRegion !== false}
          trendline={trendline}
        />
      )}
    </div>
  );
}

interface PlotScales {
  x: Scale;
  y: Scale;
  r: (p: ScatterPoint) => number;
}

function Gridlines({
  plot,
  axes,
  xMetric,
  yMetric,
  width,
  height,
}: {
  plot: PlotScales;
  axes: Record<'x' | 'y', AxisSelection>;
  xMetric: MetricSummary;
  yMetric: MetricSummary;
  width: number;
  height: number;
}) {
  return (
    <g>
      {plot.x.ticks.map((t) => (
        <g key={`x${t}`}>
          <line className="grid" x1={plot.x.to(t)} x2={plot.x.to(t)} y1={PAD.top} y2={height - PAD.bottom} />
          <text className="tick-label" x={plot.x.to(t)} y={height - PAD.bottom + 16} textAnchor="middle">
            {formatAxis(t, axes.x, xMetric.unit)}
          </text>
        </g>
      ))}
      {plot.y.ticks.map((t) => (
        <g key={`y${t}`}>
          <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={plot.y.to(t)} y2={plot.y.to(t)} />
          <text className="tick-label" x={PAD.left - 8} y={plot.y.to(t) + 3} textAnchor="end">
            {formatAxis(t, axes.y, yMetric.unit)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** The line at "no difference": 100 for an index, 0 for a change. */
function OriginLines({
  plot,
  axes,
  width,
  height,
}: {
  plot: PlotScales;
  axes: Record<'x' | 'y', AxisSelection>;
  width: number;
  height: number;
}) {
  const originOf = (sel: AxisSelection): number | null => {
    const q = quantityOf(sel);
    if (q === 'index') return 100;
    if (q === 'delta-value' || q === 'delta-index') return 0;
    return null;
  };
  const ox = originOf(axes.x);
  const oy = originOf(axes.y);
  const within = (s: Scale, v: number) => v > s.domain[0] && v < s.domain[1];
  return (
    <g>
      {ox != null && within(plot.x, ox) && (
        <line className="origin" x1={plot.x.to(ox)} x2={plot.x.to(ox)} y1={PAD.top} y2={height - PAD.bottom} />
      )}
      {oy != null && within(plot.y, oy) && (
        <line className="origin" x1={PAD.left} x2={width - PAD.right} y1={plot.y.to(oy)} y2={plot.y.to(oy)} />
      )}
    </g>
  );
}

function FitLine({
  plot,
  fit,
  logX,
  logY,
}: {
  plot: PlotScales;
  fit: { slope: number; intercept: number };
  logX: boolean;
  logY: boolean;
}) {
  // The fit lives in the space the dots are drawn in, so the endpoints are
  // transformed the same way before the line is evaluated. See fitLine().
  const [d0, d1] = plot.x.domain;
  const ends = [d0, d1].map((v) => {
    const tx = logX ? Math.log10(v) : v;
    const ty = fit.slope * tx + fit.intercept;
    return { x: plot.x.to(v), y: plot.y.to(logY ? Math.pow(10, ty) : ty) };
  });
  return <line className="fit" x1={ends[0]!.x} y1={ends[0]!.y} x2={ends[1]!.x} y2={ends[1]!.y} />;
}

function Tooltip({
  point,
  x,
  y,
  width,
  xMetric,
  yMetric,
  axes,
  nouns,
  sizeMetric,
}: {
  point: ScatterPoint;
  x: number;
  y: number;
  width: number;
  xMetric: MetricSummary;
  yMetric: MetricSummary;
  axes: Record<'x' | 'y', AxisSelection>;
  nouns: { x: string; y: string };
  sizeMetric: MetricSummary | null;
}) {
  // Flip to the left of the cursor near the right edge rather than letting the
  // card leave the panel.
  const flip = x > width - 240;
  const line = (
    reading: ScatterPoint['x'],
    metric: MetricSummary,
    sel: AxisSelection,
    noun: string,
  ) => {
    const q = quantityOf(sel);
    const headline = formatAxis(reading.plotted, sel, metric.unit);
    if (q === 'value') return `${headline} · ${reading.index?.toFixed(0) ?? '—'}% of ${noun}`;
    if (q === 'index') return `${headline} of ${noun} · ${formatValue(reading.value, metric.unit)}`;
    if (q === 'delta-value') {
      return `${headline} · ${formatValue(reading.from?.value ?? null, metric.unit)} → ${formatValue(
        reading.value,
        metric.unit,
      )}`;
    }
    return `${headline} · ${reading.from?.index?.toFixed(0) ?? '—'}% → ${reading.index?.toFixed(0) ?? '—'}% of ${noun}`;
  };

  return (
    <div className={`scatter-tip${flip ? ' flip' : ''}`} style={{ left: x, top: y }}>
      <strong>{point.name}</strong>
      <div className="tip-row">
        <span className="tip-metric">{xMetric.label}</span>
        <span>{line(point.x, xMetric, axes.x, nouns.x)}</span>
      </div>
      <div className="tip-row">
        <span className="tip-metric">{yMetric.label}</span>
        <span>{line(point.y, yMetric, axes.y, nouns.y)}</span>
      </div>
      {/* Not repeated when the sizing metric is already one of the axes. */}
      {sizeMetric && point.size != null && sizeMetric.id !== xMetric.id && sizeMetric.id !== yMetric.id && (
        <div className="tip-row">
          <span className="tip-metric">{sizeMetric.label}</span>
          <span>{formatValue(point.size, sizeMetric.unit)}</span>
        </div>
      )}
    </div>
  );
}

function ScatterFooter({
  result,
  showImprecise,
  tilesRegion,
  trendline,
}: {
  result: ScatterResult;
  showImprecise: boolean;
  tilesRegion: boolean;
  trendline: boolean;
}) {
  return (
    <footer className="scatter-foot">
      {/* The geography itself is named by the control that chose it. */}
      <span>{result.points.length.toLocaleString()} areas plotted</span>
      {trendline && result.fit && (
        <span className="scatter-r" title="Pearson correlation of the plotted coordinates">
          r = {result.fit.r.toFixed(2)}
          <small>
            {/*
              Rule 4: consecutive ACS 5-year estimates share sample, so this
              number describes the picture rather than testing a hypothesis.
              Printing it without that is how a scatter becomes a claim.
            */}
            descriptive only — ACS years overlap
          </small>
        </span>
      )}
      {result.impreciseCount > 0 && (
        <span className={showImprecise ? 'warn-inline' : ''}>
          {showImprecise
            ? `including ${result.impreciseCount} imprecise`
            : `${result.impreciseCount} excluded as imprecise`}
        </span>
      )}
      {result.nonPositiveCount > 0 && (
        <span>{result.nonPositiveCount} omitted: a log axis cannot place zero or less</span>
      )}
      {!tilesRegion && <span>this geography does not cover the whole region</span>}
    </footer>
  );
}

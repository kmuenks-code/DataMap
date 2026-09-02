import { useEffect, useMemo } from 'react';

import { useMetricData, useTrend } from '../../data/useMetricData.ts';
import { formatRelative, formatValue } from '../../lib/format.ts';
import { baselineNoun, useBaselineTarget } from '../../lib/baseline.ts';
import { useAppStore } from '../../state/useAppStore.ts';
import { findMetric } from '../../data/types.ts';

export function TimelineBar() {
  const region = useAppStore((s) => s.region());
  const target = useBaselineTarget();
  const metricId = useAppStore((s) => s.metricId);
  const year = useAppStore((s) => s.year);
  const setYear = useAppStore((s) => s.setYear);
  const playing = useAppStore((s) => s.playing);
  const setPlaying = useAppStore((s) => s.setPlaying);
  const selectedGeoid = useAppStore((s) => s.selectedGeoid);

  const { file } = useMetricData();
  const trend = useTrend(file, selectedGeoid);
  const metric = region && metricId ? findMetric(region, metricId) : undefined;
  const noun = baselineNoun(target);
  const years = metric?.years ?? [];

  useEffect(() => {
    if (!playing || years.length === 0) return;
    const id = setInterval(() => {
      const s = useAppStore.getState();
      const i = years.indexOf(s.year ?? years[0]!);
      const next = years[(i + 1) % years.length]!;
      s.setYear(next);
    }, 700);
    return () => clearInterval(id);
  }, [playing, years]);

  if (!metric || year == null || years.length === 0) return null;

  // A CV is shipped only where the source had a margin of error, so its
  // presence IS the question "is this a sample?" -- and the overlapping-sample
  // caveat below is meaningless for anything else. Election returns are
  // certified counts and carry none; labelling them "5-year estimate" would be
  // a plainly false statement about the data on screen.
  const isSurvey = Boolean(file?.cv);
  const idx = years.indexOf(year);
  const selectedName = trend ? file?.names[file.geoids.indexOf(selectedGeoid!)] : null;

  return (
    <div className="timeline">
      <div className="timeline-head">
        <button className="play" onClick={() => setPlaying(!playing)}>
          {playing ? '❚❚' : '▶'}
        </button>
        <div className="timeline-title">
          <strong>{year}</strong>
          <span className="muted">{metric.label}</span>
        </div>

        {trend ? (
          <Sparkline
            trend={trend}
            year={year}
            name={selectedName ?? ''}
            unit={metric.unit}
            noun={noun}
          />
        ) : (
          <span className="muted hint">Click an area to see its trend vs the {noun} average</span>
        )}
      </div>

      <input
        className="scrubber"
        type="range"
        min={0}
        max={years.length - 1}
        step={1}
        value={idx === -1 ? 0 : idx}
        onChange={(e) => setYear(years[Number(e.target.value)]!)}
      />

      <div className="ticks">
        {years.map((y) => (
          <button
            key={y}
            className={`tick${y === year ? ' active' : ''}`}
            onClick={() => setYear(y)}
            title={tickTitle(y, years, isSurvey)}
          >
            {String(y).slice(2)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * What one year tick claims about its own comparability.
 *
 * ACS 5-year estimates overlap -- 2023 and 2024 share four years of sample --
 * so the honest comparisons are the non-overlapping ones, and the tick says
 * which those are. A source that is not a survey has no such caveat to make:
 * two presidential elections four years apart share no sample because neither
 * is a sample.
 */
export function tickTitle(year: number, years: number[], isSurvey: boolean): string {
  if (!isSurvey) return String(year);
  const first = years[0]!;
  return (year - first) % 5 === 0
    ? `${year} — non-overlapping with ${first}`
    : `${year} (5-year estimate; overlaps neighbouring years)`;
}

/**
 * The selected area's index over time against a fixed 100 baseline.
 *
 * The baseline is drawn as a real line because it is the whole point: the metro
 * is pinned at 100 in every year, so the shape shows divergence from the metro
 * rather than the general upward drift of nominal dollars.
 */
function Sparkline({
  trend,
  year,
  name,
  unit,
  noun,
}: {
  trend: { year: number; index: number | null; value: number | null }[];
  year: number;
  name: string;
  unit: string;
  /** What the 100 line is called here -- "metro", "state", "US". */
  noun: string;
}) {
  const w = 260;
  const h = 44;

  const { path, dot, current } = useMemo(() => {
    const pts = trend.filter((t) => t.index != null) as {
      year: number;
      index: number;
      value: number | null;
    }[];
    if (pts.length === 0) return { path: '', dot: null, current: null };

    const years = pts.map((p) => p.year);
    const minY = Math.min(...years);
    const maxY = Math.max(...years);
    const values = pts.map((p) => p.index);
    // Always include 100 in the domain so the baseline is visible even when an
    // area never crosses it.
    const lo = Math.min(100, ...values);
    const hi = Math.max(100, ...values);
    const span = hi - lo || 1;

    const x = (yr: number) => ((yr - minY) / (maxY - minY || 1)) * (w - 4) + 2;
    const y = (v: number) => h - 4 - ((v - lo) / span) * (h - 8);

    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.year)},${y(p.index)}`).join(' ');
    const at = pts.find((p) => p.year === year) ?? pts[pts.length - 1]!;
    return {
      path: d,
      dot: { cx: x(at.year), cy: y(at.index) },
      current: at,
      baselineY: y(100),
    };
  }, [trend, year]);

  if (!path) return <span className="muted hint">No trend data for this area</span>;

  const pts = trend.filter((t) => t.index != null) as { index: number }[];
  const lo = Math.min(100, ...pts.map((p) => p.index));
  const hi = Math.max(100, ...pts.map((p) => p.index));
  const baselineY = h - 4 - ((100 - lo) / (hi - lo || 1)) * (h - 8);

  return (
    <div className="spark">
      <div className="spark-label">
        <strong>{name}</strong>
        <span className={current && current.index >= 100 ? 'above' : 'below'}>
          {formatRelative(current?.index ?? null, noun)}
        </span>
        <span className="muted">{formatValue(current?.value ?? null, unit)}</span>
      </div>
      <svg width={w} height={h} role="img" aria-label={`${name} trend versus ${noun} average`}>
        <line x1={0} x2={w} y1={baselineY} y2={baselineY} className="spark-base" />
        <path d={path} className="spark-line" />
        {dot && <circle cx={dot.cx} cy={dot.cy} r={3.5} className="spark-dot" />}
      </svg>
    </div>
  );
}

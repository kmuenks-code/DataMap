import { useMetricData } from '../../data/useMetricData.ts';
import { divergingBreaks, quantileBreaks, rampFor } from '../../lib/color/scales.ts';
import { formatValue } from '../../lib/format.ts';
import { useAppStore } from '../../state/useAppStore.ts';
import { findMetric } from '../../data/types.ts';

export function Legend() {
  const region = useAppStore((s) => s.region());
  const metricId = useAppStore((s) => s.metricId);
  const viewMode = useAppStore((s) => s.viewMode);
  const hideUnreliable = useAppStore((s) => s.hideUnreliable);
  const setHideUnreliable = useAppStore((s) => s.setHideUnreliable);
  const { collection } = useMetricData();

  const metric = region && metricId ? findMetric(region, metricId) : undefined;
  if (!collection || !metric) return null;

  const values = collection.features
    .map((f) => (viewMode === 'index' ? f.properties.index : f.properties.value))
    .filter((v): v is number => v != null);
  if (values.length === 0) return null;

  const ramp = rampFor(viewMode === 'index' ? 'index' : 'raw');
  const breaks =
    viewMode === 'index' ? divergingBreaks(values) : quantileBreaks(values, ramp.length);
  const unreliable = collection.features.filter(
    (f) => f.properties.cv != null && f.properties.cv > 0.15,
  ).length;

  return (
    <div className="legend">
      <div className="legend-title">
        {viewMode === 'index' ? '% of metro average' : metric.label}
      </div>
      <div className="ramp">
        {ramp.map((c, i) => (
          <div key={c + String(i)} className="swatch" style={{ background: c }} />
        ))}
      </div>
      <div className="ramp-labels">
        <span>
          {viewMode === 'index'
            ? `${Math.round(breaks[0] ?? 0)}%`
            : formatValue(breaks[0] ?? null, metric.unit)}
        </span>
        {viewMode === 'index' && <span className="center">100%</span>}
        <span>
          {viewMode === 'index'
            ? `${Math.round(breaks[breaks.length - 1] ?? 0)}%`
            : formatValue(breaks[breaks.length - 1] ?? null, metric.unit)}
        </span>
      </div>

      {unreliable > 0 && (
        <label className="reliability">
          <input
            type="checkbox"
            checked={hideUnreliable}
            onChange={(e) => setHideUnreliable(e.target.checked)}
          />
          {/* Small-area ACS estimates are often too imprecise to state. Faded
              areas are shown, not hidden, so thin data stays visible as thin. */}
          <span>
            Fade {unreliable} imprecise {unreliable === 1 ? 'area' : 'areas'}
            <small>margin of error &gt; 15%</small>
          </span>
        </label>
      )}
    </div>
  );
}

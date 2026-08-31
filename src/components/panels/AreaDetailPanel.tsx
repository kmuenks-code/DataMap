import { useMetricData } from '../../data/useMetricData.ts';
import { formatIndex, formatOrdinal, formatRelative, formatValue } from '../../lib/format.ts';
import { useAppStore } from '../../state/useAppStore.ts';
import { findMetric } from '../../data/types.ts';

export function AreaDetailPanel() {
  const region = useAppStore((s) => s.region());
  const metricId = useAppStore((s) => s.metricId);
  const hovered = useAppStore((s) => s.hoveredGeoid);
  const selected = useAppStore((s) => s.selectedGeoid);
  const { collection } = useMetricData();

  const geoid = hovered ?? selected;
  const metric = region && metricId ? findMetric(region, metricId) : undefined;
  const f = collection?.features.find((x) => x.properties.geoid === geoid);
  if (!f || !metric) return null;

  const p = f.properties;
  const imprecise = p.cv != null && p.cv > 0.15;

  return (
    <div className="detail">
      <h2>{p.name}</h2>
      <div className="detail-metric">{metric.label}</div>

      <div className="detail-value">{formatValue(p.value, metric.unit)}</div>
      <div className={`detail-index ${p.index != null && p.index >= 100 ? 'above' : 'below'}`}>
        {formatIndex(p.index)} of metro · {formatRelative(p.index)}
      </div>

      {p.rank != null && (
        <div className="detail-rank">
          Ranked {formatOrdinal(p.rank)} of {p.total} · {p.percentile}th percentile
        </div>
      )}

      {imprecise && (
        <p className="warn">
          Imprecise estimate (margin of error {Math.round((p.cv ?? 0) * 100)}%). Small areas
          have wide survey error — treat changes here with caution.
        </p>
      )}
    </div>
  );
}

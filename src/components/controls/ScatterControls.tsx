import { useSizeMetric } from '../../data/useScatterData.ts';
import { findMetric } from '../../data/types.ts';
import {
  quantityLabel,
  quantityOf,
  quantityToSelection,
  type AxisQuantity,
} from '../../lib/axisLabel.ts';
import { baselineNoun, useBaselineTargetFor } from '../../lib/baseline.ts';
import { useAppStore, type AxisKey } from '../../state/useAppStore.ts';

/** Which visualisation the stage shows. Everything above it in the sidebar serves both. */
export function StageToggle() {
  const stageView = useAppStore((s) => s.stageView);
  const setStageView = useAppStore((s) => s.setStageView);
  return (
    <div className="segmented">
      <button
        className={stageView === 'map' ? 'active' : ''}
        onClick={() => setStageView('map')}
        title="Colour every area by how it ranks within the region"
      >
        Map
      </button>
      <button
        className={stageView === 'scatter' ? 'active' : ''}
        onClick={() => setStageView('scatter')}
        title="Plot two metrics against each other, one dot per area"
      >
        Scatter
      </button>
    </div>
  );
}

/**
 * The scatter's own controls: two axes, and three display choices.
 *
 * Takes the place of the metric tree while the scatter is on screen, because
 * the tree is a single-select for the one thing that can colour a polygon and
 * this view has two slots. Everything above it in the sidebar -- region,
 * geography, baseline -- is shared and stays put.
 */
export function ScatterControls() {
  const showImprecise = useAppStore((s) => s.scatterShowImprecise);
  const setShowImprecise = useAppStore((s) => s.setScatterShowImprecise);
  const sizeBy = useAppStore((s) => s.scatterSizeByPopulation);
  const setSizeBy = useAppStore((s) => s.setScatterSizeByPopulation);
  const trendline = useAppStore((s) => s.scatterTrendline);
  const setTrendline = useAppStore((s) => s.setScatterTrendline);
  const sizeMetric = useSizeMetric();

  return (
    <div className="picker scatter-controls">
      <AxisPicker which="x" label="X axis" />
      <AxisPicker which="y" label="Y axis" />

      <section className="layer">
        <h3>Display</h3>

        <label className="row overlay">
          <input type="checkbox" checked={trendline} onChange={(e) => setTrendline(e.target.checked)} />
          <span>Trend line and r</span>
        </label>

        <label className="row overlay">
          <input
            type="checkbox"
            checked={sizeBy && sizeMetric != null}
            disabled={sizeMetric == null}
            onChange={(e) => setSizeBy(e.target.checked)}
          />
          <span>
            {sizeMetric ? `Size dots by ${sizeMetric.label.toLowerCase()}` : 'Size dots by population'}
          </span>
        </label>

        {/*
          Rule 5 again, and the same bargain the Top 10 strikes: the noisy
          areas are out by default, the count is always stated, and putting
          them back is one click. A scatter is worse than a list here -- an
          outlier does not just sit at the top, it drags the axis and the fit.
        */}
        <label className="row overlay">
          <input
            type="checkbox"
            checked={showImprecise}
            onChange={(e) => setShowImprecise(e.target.checked)}
          />
          <span>Include imprecise areas</span>
        </label>
        <p className="level-note">
          Areas with a margin of error above 15% are excluded. They are almost always small
          populations, where an apparent gap is survey noise.
        </p>
      </section>
    </div>
  );
}

function AxisPicker({ which, label }: { which: AxisKey; label: string }) {
  const region = useAppStore((s) => s.region());
  const geoLevelId = useAppStore((s) => s.geoLevelId);
  const selection = useAppStore((s) => s.axes[which]);
  const setAxis = useAppStore((s) => s.setAxis);
  const noun = baselineNoun(useBaselineTargetFor(selection.metricId));

  if (!region) return null;

  const metric = selection.metricId ? findMetric(region, selection.metricId) : undefined;
  // A one-year metric has no window to measure a change over, so those two
  // options are withheld rather than offered and then silently ignored.
  const hasSpan = (metric?.years.length ?? 0) > 1;
  const quantity = quantityOf(selection);
  const quantities: AxisQuantity[] = hasSpan
    ? ['value', 'index', 'delta-value', 'delta-index']
    : ['value', 'index'];

  return (
    <section className="layer axis-picker">
      <h3>{label}</h3>

      <select
        className="axis-select"
        value={selection.metricId ?? ''}
        onChange={(e) => setAxis(which, { metricId: e.target.value })}
      >
        {region.layers
          .filter((l) => l.kind === 'metric')
          .flatMap((l) => l.groups ?? [])
          .map((g) => (
            <optgroup key={g.id} label={g.label}>
              {g.metrics.map((m) => {
                // A metric may not exist at the current geography. Listed but
                // disabled, so its absence is visible rather than mysterious.
                const available = m.geoLevels.includes(geoLevelId ?? '');
                return (
                  <option key={m.id} value={m.id} disabled={!available}>
                    {m.label}
                    {available ? '' : ' — not at this geography'}
                  </option>
                );
              })}
            </optgroup>
          ))}
      </select>

      <select
        className="axis-select"
        value={quantity}
        onChange={(e) => setAxis(which, quantityToSelection(e.target.value as AxisQuantity))}
      >
        {quantities.map((q) => (
          <option key={q} value={q}>
            {quantityLabel(q, noun)}
          </option>
        ))}
      </select>

      <label className="row overlay">
        <input
          type="checkbox"
          checked={selection.log}
          // A change is signed and has no logarithm; the store enforces the
          // same rule, this just stops the control from lying about it.
          disabled={selection.basis === 'delta'}
          onChange={(e) => setAxis(which, { log: e.target.checked })}
        />
        <span>Log scale</span>
      </label>
    </section>
  );
}

import { useBaselineOptions } from '../../lib/baseline.ts';
import { useAppStore } from '../../state/useAppStore.ts';

/**
 * Which region's areas are on the map.
 *
 * Hidden when only one region is built, so a single-city deployment shows no
 * vestigial control.
 */
export function RegionPicker() {
  const manifest = useAppStore((s) => s.manifest);
  const regionId = useAppStore((s) => s.regionId);
  const setRegion = useAppStore((s) => s.setRegion);
  const regions = manifest?.regions ?? [];
  if (regions.length < 2) return null;

  return (
    <div className="segmented">
      {regions.map((r) => (
        <button
          key={r.id}
          className={r.id === regionId ? 'active' : ''}
          onClick={() => setRegion(r.id)}
          title={`${r.geoLevelCount} geographies, ${r.metricCount} metrics`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Which region's totals are the 100% line.
 *
 * This is the control that separates scope from baseline. The areas drawn do
 * not change; what changes is the yardstick they are measured against, so a
 * Columbus township can be read as "above average for the metro" and "below
 * average for the country" without either being wrong.
 *
 * Hidden unless the region declares a parent -- with nothing to compare
 * against, "vs itself" is the only option and is not a choice.
 */
export function BaselinePicker() {
  const options = useBaselineOptions();
  const regionId = useAppStore((s) => s.regionId);
  const baselineRegionId = useAppStore((s) => s.baselineRegionId);
  const setBaselineRegion = useAppStore((s) => s.setBaselineRegion);
  if (options.length < 2) return null;

  const activeId = baselineRegionId ?? regionId;

  return (
    <>
      {/* The label lives here so it disappears with the control it names. */}
      <label className="control-label">Compared with</label>
      <div className="segmented">
        {options.map((r) => (
          <button
            key={r.id}
            className={r.id === activeId ? 'active' : ''}
            // The region's own baseline is stored as null, not as its id, so
            // that "own" survives a region switch without pointing at a region
            // that is no longer on screen.
            onClick={() => setBaselineRegion(r.id === regionId ? null : r.id)}
            title={`Pin 100% to ${r.label}`}
          >
            {r.label}
          </button>
        ))}
      </div>
      {baselineRegionId && baselineRegionId !== regionId && (
        <p className="level-note">
          Areas are still this region&apos;s; only the 100% line has moved.
        </p>
      )}
    </>
  );
}

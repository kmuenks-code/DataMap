import { baselineLabel, baselineNoun, useBaselineTarget } from '../../lib/baseline.ts';
import { useAppStore } from '../../state/useAppStore.ts';

export function GeoLevelPicker() {
  const region = useAppStore((s) => s.region());
  const geoLevelId = useAppStore((s) => s.geoLevelId);
  const setGeoLevel = useAppStore((s) => s.setGeoLevel);
  if (!region) return null;

  const active = region.geoLevels.find((g) => g.id === geoLevelId);

  return (
    <>
      <div className="segmented">
        {region.geoLevels.map((g) => (
          <button
            key={g.id}
            className={g.id === geoLevelId ? 'active' : ''}
            onClick={() => setGeoLevel(g.id)}
            title={g.note ? `${g.areaCount} areas -- ${g.note}` : `${g.areaCount} areas`}
          >
            {g.label}
          </button>
        ))}
      </div>
      {/*
        A level that does not cover the whole region leaves real holes in the
        map. Without saying so, a reader takes blank ground for missing data
        rather than for land that belongs to no city.
      */}
      {active?.note && <p className="level-note">{active.note}</p>}
    </>
  );
}

export function ViewModeToggle() {
  const target = useBaselineTarget();
  const viewMode = useAppStore((s) => s.viewMode);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const noun = baselineNoun(target);
  return (
    <div className="segmented">
      <button
        className={viewMode === 'index' ? 'active' : ''}
        onClick={() => setViewMode('index')}
        title={`Each area as a % of the ${noun} average (${noun} = 100)`}
      >
        vs {baselineLabel(target)}
      </button>
      <button
        className={viewMode === 'raw' ? 'active' : ''}
        onClick={() => setViewMode('raw')}
        title="Raw values, not adjusted for inflation"
      >
        Raw value
      </button>
    </div>
  );
}

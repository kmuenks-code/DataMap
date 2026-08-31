import { useAppStore } from '../../state/useAppStore.ts';

export function GeoLevelPicker() {
  const region = useAppStore((s) => s.region());
  const geoLevelId = useAppStore((s) => s.geoLevelId);
  const setGeoLevel = useAppStore((s) => s.setGeoLevel);
  if (!region) return null;

  return (
    <div className="segmented">
      {region.geoLevels.map((g) => (
        <button
          key={g.id}
          className={g.id === geoLevelId ? 'active' : ''}
          onClick={() => setGeoLevel(g.id)}
          title={`${g.areaCount} areas`}
        >
          {g.label}
        </button>
      ))}
    </div>
  );
}

export function ViewModeToggle() {
  const viewMode = useAppStore((s) => s.viewMode);
  const setViewMode = useAppStore((s) => s.setViewMode);
  return (
    <div className="segmented">
      <button
        className={viewMode === 'index' ? 'active' : ''}
        onClick={() => setViewMode('index')}
        title="Each area as a % of the metro average (metro = 100)"
      >
        vs Metro
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

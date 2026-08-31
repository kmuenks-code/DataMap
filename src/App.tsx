import { useEffect, useState } from 'react';

import { GeoLevelPicker, ViewModeToggle } from './components/controls/GeoLevelPicker.tsx';
import { MetricPicker } from './components/controls/MetricPicker.tsx';
import { Legend } from './components/map/Legend.tsx';
import { MapView } from './components/map/MapView.tsx';
import { AreaDetailPanel } from './components/panels/AreaDetailPanel.tsx';
import { TimelineBar } from './components/timeline/TimelineBar.tsx';
import { loadManifest } from './data/loaders.ts';
import { useAppStore } from './state/useAppStore.ts';

export function App() {
  const manifest = useAppStore((s) => s.manifest);
  const setManifest = useAppStore((s) => s.setManifest);
  const region = useAppStore((s) => s.region());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadManifest()
      .then(setManifest)
      .catch((e: Error) => setError(e.message));
  }, [setManifest]);

  if (error) {
    return (
      <div className="boot">
        <h1>Could not load data</h1>
        <p>{error}</p>
        <p className="muted">
          Run <code>npm run etl:columbus</code> to build <code>public/data</code>.
        </p>
      </div>
    );
  }
  if (!manifest || !region) return <div className="boot">Loading…</div>;

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>{region.label}</h1>
          <p className="muted">
            Each area compared with the metro average, which is pinned at 100%.
          </p>
        </header>
        <div className="controls">
          <label className="control-label">Geography</label>
          <GeoLevelPicker />
          <label className="control-label">Show</label>
          <ViewModeToggle />
        </div>
        <MetricPicker />
        <footer>
          {region.layers.map((l) => (
            <div key={l.id} className="attribution">
              {l.attribution}
            </div>
          ))}
        </footer>
      </aside>

      <main className="stage">
        <MapView />
        <Legend />
        <AreaDetailPanel />
        <TimelineBar />
      </main>
    </div>
  );
}

import { useEffect, useState } from 'react';

import { GeoLevelPicker, ViewModeToggle } from './components/controls/GeoLevelPicker.tsx';
import { MetricPicker } from './components/controls/MetricPicker.tsx';
import { BaselinePicker, RegionPicker } from './components/controls/RegionPicker.tsx';
import { Legend } from './components/map/Legend.tsx';
import { MapView } from './components/map/MapView.tsx';
import { AreaDetailPanel } from './components/panels/AreaDetailPanel.tsx';
import { TimelineBar } from './components/timeline/TimelineBar.tsx';
import { loadBaselines, loadManifest, loadRegion } from './data/loaders.ts';
import { baselineNoun, useBaselineTarget } from './lib/baseline.ts';
import { useAppStore } from './state/useAppStore.ts';

export function App() {
  const manifest = useAppStore((s) => s.manifest);
  const setManifest = useAppStore((s) => s.setManifest);
  const setRegionDoc = useAppStore((s) => s.setRegionDoc);
  const setBaselines = useAppStore((s) => s.setBaselines);
  const baselineRegionId = useAppStore((s) => s.baselineRegionId);
  const regionId = useAppStore((s) => s.regionId);
  const region = useAppStore((s) => s.region());
  const target = useBaselineTarget();
  const [error, setError] = useState<string | null>(null);

  // Boot is two fetches, not one: the root index says which regions exist, and
  // only then is that region's layer tree worth downloading. See loadRegion().
  useEffect(() => {
    loadManifest()
      .then(setManifest)
      .catch((e: Error) => setError(e.message));
  }, [setManifest]);

  // An ancestor's baselines are ~2 KB and are fetched only if the user asks to
  // compare against it -- the whole reason they are a separate file.
  useEffect(() => {
    if (!baselineRegionId || baselineRegionId === regionId) return;
    let stale = false;
    loadBaselines(baselineRegionId)
      .then((b) => {
        if (!stale) setBaselines(b);
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      stale = true;
    };
  }, [baselineRegionId, regionId, setBaselines]);

  useEffect(() => {
    if (!regionId) return;
    let stale = false;
    loadRegion(regionId)
      .then((doc) => {
        if (!stale) setRegionDoc(doc);
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      stale = true;
    };
  }, [regionId, setRegionDoc]);

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
            Each area compared with the {baselineNoun(target)} average, which is pinned at 100%.
          </p>
        </header>
        <div className="controls">
          <RegionPicker />
          <label className="control-label">Geography</label>
          <GeoLevelPicker />
          <BaselinePicker />
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

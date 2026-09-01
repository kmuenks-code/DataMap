import { useEffect, useState } from 'react';

import { GeoLevelPicker, ViewModeToggle } from './components/controls/GeoLevelPicker.tsx';
import { MetricPicker } from './components/controls/MetricPicker.tsx';
import { ScatterControls, StageToggle } from './components/controls/ScatterControls.tsx';
import { BaselinePicker, RegionPicker } from './components/controls/RegionPicker.tsx';
import { Legend } from './components/map/Legend.tsx';
import { MapView } from './components/map/MapView.tsx';
import { AreaDetailPanel } from './components/panels/AreaDetailPanel.tsx';
import { ScatterView } from './components/scatter/ScatterView.tsx';
import { TopListPanel } from './components/panels/TopListPanel.tsx';
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
  const stageView = useAppStore((s) => s.stageView);
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
    <div className={stageView === 'map' ? 'app' : 'app scatter-mode'}>
      <aside className="sidebar">
        <header>
          <h1>{region.label}</h1>
          <p className="muted">
            {stageView === 'map'
              ? `Each area compared with the ${baselineNoun(target)} average, which is pinned at 100%.`
              : 'Two metrics, one dot per area, on the same scope the map uses.'}
          </p>
        </header>
        <div className="controls">
          <RegionPicker />
          <label className="control-label">View</label>
          <StageToggle />
          <label className="control-label">Geography</label>
          <GeoLevelPicker />
          <BaselinePicker />
          {stageView === 'map' && (
            <>
              <label className="control-label">Show</label>
              <ViewModeToggle />
            </>
          )}
        </div>
        {/*
          The metric tree is a single-select for the one thing that can colour
          a polygon; the scatter has two slots and states its own units, so it
          brings its own controls rather than bending that one.
        */}
        {stageView === 'map' ? <MetricPicker /> : <ScatterControls />}
        <footer>
          {region.layers.map((l) => (
            <div key={l.id} className="attribution">
              {l.attribution}
            </div>
          ))}
        </footer>
      </aside>

      {/*
        MapView is kept MOUNTED while the scatter is on screen, merely hidden.
        Remounting it costs a fresh MapLibre instance, a re-fit and a geometry
        re-parse, and would throw away the reader's pan and zoom every time
        they glance at the plot -- the two views are one exploration.
      */}
      <main className="stage">
        <div className={stageView === 'map' ? 'stage-pane' : 'stage-pane hidden'}>
          <MapView />
          <Legend />
        </div>
        {stageView === 'scatter' && <ScatterView />}
        <AreaDetailPanel />
        <TimelineBar />
      </main>

      {/*
        A column of its own rather than another card floating over the map:
        .legend and .detail already hold the map's two top corners, and a third
        panel there would cover the areas it is ranking.
      */}
      {stageView === 'map' && <TopListPanel />}
    </div>
  );
}

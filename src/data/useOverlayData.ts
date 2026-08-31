import { useEffect, useState } from 'react';
import { feature } from 'topojson-client';
import type { FeatureCollection, Geometry } from 'geojson';
import type { Topology } from 'topojson-specification';

import { loadOverlay } from './loaders.ts';
import { useAppStore } from '../state/useAppStore.ts';

export interface OverlayProps {
  name: string;
}

export type OverlayCollection = FeatureCollection<Geometry, OverlayProps>;

/**
 * Geometry for the currently visible overlays, keyed by layer id.
 *
 * Overlays are ADDITIVE, so this returns a map rather than a single collection
 * the way useMetricData does -- any number can be on at once. Files are cached
 * for the session once fetched: toggling a layer off and on again is free, and
 * these are small (the Columbus set is 41 KB).
 */
export function useOverlayData(): Map<string, OverlayCollection> {
  const regionId = useAppStore((s) => s.regionId);
  const overlays = useAppStore((s) => s.overlays);
  const [loaded, setLoaded] = useState<Map<string, OverlayCollection>>(new Map());

  useEffect(() => {
    if (!regionId) return;
    let cancelled = false;

    for (const id of overlays) {
      if (loaded.has(id)) continue;
      void loadOverlay(regionId, id)
        .then((raw) => {
          if (cancelled) return;
          const topo = raw as Topology;
          const objectName = Object.keys(topo.objects)[0];
          if (!objectName) return;
          const fc = feature(topo, topo.objects[objectName]!) as unknown as OverlayCollection;
          // Functional update: two overlays enabled at once resolve
          // independently, and reading `loaded` from the closure would let the
          // slower one overwrite the faster one's entry.
          setLoaded((prev) => new Map(prev).set(id, fc));
        })
        // An overlay that fails to load is a missing outline, not a broken
        // app -- the choropleth underneath is unaffected, so this stays quiet
        // rather than taking over the error surface used for metric data.
        .catch((e: Error) => console.warn(`[overlay] ${id}: ${e.message}`));
    }

    return () => {
      cancelled = true;
    };
  }, [regionId, overlays, loaded]);

  return loaded;
}

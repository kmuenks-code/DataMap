import { create } from 'zustand';

import type { Manifest, RegionSummary, ViewMode } from '../data/types.ts';
import { findMetric } from '../data/types.ts';

interface AppState {
  manifest: Manifest | null;
  regionId: string | null;
  geoLevelId: string | null;
  metricId: string | null;
  year: number | null;
  viewMode: ViewMode;
  /** Additive overlay layers, by id. Independent of the selected metric. */
  overlays: Set<string>;
  hoveredGeoid: string | null;
  selectedGeoid: string | null;
  /** Dim areas whose estimate is too imprecise to trust. */
  hideUnreliable: boolean;
  playing: boolean;

  setManifest: (m: Manifest) => void;
  setGeoLevel: (id: string) => void;
  setMetric: (id: string) => void;
  setYear: (y: number) => void;
  setViewMode: (v: ViewMode) => void;
  toggleOverlay: (id: string) => void;
  setHovered: (g: string | null) => void;
  setSelected: (g: string | null) => void;
  setHideUnreliable: (v: boolean) => void;
  setPlaying: (v: boolean) => void;

  region: () => RegionSummary | null;
}

export const useAppStore = create<AppState>((set, get) => ({
  manifest: null,
  regionId: null,
  geoLevelId: null,
  metricId: null,
  year: null,
  viewMode: 'index',
  overlays: new Set(),
  hoveredGeoid: null,
  selectedGeoid: null,
  hideUnreliable: false,
  playing: false,

  setManifest: (manifest) => {
    const region = manifest.regions[0];
    if (!region) return set({ manifest });

    const level = region.geoLevels.find((g) => g.default) ?? region.geoLevels[0];
    const first = region.layers.find((l) => l.kind === 'metric')?.groups?.[0]?.metrics[0];

    set({
      manifest,
      regionId: region.id,
      geoLevelId: level?.id ?? null,
      metricId: first?.id ?? null,
      year: first ? first.years[first.years.length - 1]! : null,
    });
  },

  /**
   * Changing geo level can strand the current metric: not every layer covers
   * every geography (elections are precinct-level). Fall back to the first
   * metric that does exist here rather than rendering an empty map.
   */
  setGeoLevel: (geoLevelId) => {
    const region = get().region();
    const current = region && get().metricId ? findMetric(region, get().metricId!) : undefined;
    if (!region || current?.geoLevels.includes(geoLevelId)) {
      return set({ geoLevelId, selectedGeoid: null });
    }
    const fallback = region.layers
      .flatMap((l) => l.groups ?? [])
      .flatMap((g) => g.metrics)
      .find((m) => m.geoLevels.includes(geoLevelId));
    set({
      geoLevelId,
      selectedGeoid: null,
      ...(fallback ? { metricId: fallback.id } : {}),
    });
  },

  /** Metrics have different year ranges; clamp rather than showing a blank map. */
  setMetric: (metricId) => {
    const region = get().region();
    const metric = region ? findMetric(region, metricId) : undefined;
    const year = get().year;
    if (!metric) return set({ metricId });
    const nextYear =
      year != null && metric.years.includes(year)
        ? year
        : nearestYear(metric.years, year ?? metric.years[metric.years.length - 1]!);
    set({ metricId, year: nextYear });
  },

  setYear: (year) => set({ year }),
  setViewMode: (viewMode) => set({ viewMode }),

  toggleOverlay: (id) =>
    set((s) => {
      const overlays = new Set(s.overlays);
      if (!overlays.delete(id)) overlays.add(id);
      return { overlays };
    }),

  setHovered: (hoveredGeoid) => set({ hoveredGeoid }),
  setSelected: (selectedGeoid) => set({ selectedGeoid }),
  setHideUnreliable: (hideUnreliable) => set({ hideUnreliable }),
  setPlaying: (playing) => set({ playing }),

  region: () => {
    const { manifest, regionId } = get();
    return manifest?.regions.find((r) => r.id === regionId) ?? null;
  },
}));

export function nearestYear(years: number[], target: number): number {
  return years.reduce(
    (best, y) => (Math.abs(y - target) < Math.abs(best - target) ? y : best),
    years[0]!,
  );
}

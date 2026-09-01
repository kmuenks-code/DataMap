import { create } from 'zustand';

import type { BaselineFile, Manifest, RegionSummary, ViewMode } from '../data/types.ts';
import { findMetric } from '../data/types.ts';

interface AppState {
  /** The root index. Present as soon as the app boots. */
  manifest: Manifest | null;
  /**
   * Region documents, by id, fetched lazily as regions are opened and kept so
   * that returning to one costs nothing. The index alone cannot drive the UI --
   * the layer tree and geo levels live here.
   */
  regions: Record<string, RegionSummary>;
  regionId: string | null;
  /**
   * Which region's totals are the 100% line, when it is NOT the region on
   * screen. null means "this region's own baseline", the default and the only
   * option for a region with no parent.
   *
   * Kept separate from regionId because scope and baseline are separate
   * questions: the areas drawn are always the current region's.
   */
  baselineRegionId: string | null;
  /** Ancestor baselines, by region id, fetched on demand and kept. */
  baselines: Record<string, BaselineFile>;
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
  setRegionDoc: (doc: RegionSummary) => void;
  setRegion: (id: string) => void;
  setBaselineRegion: (id: string | null) => void;
  setBaselines: (b: BaselineFile) => void;
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
  regions: {},
  regionId: null,
  baselineRegionId: null,
  baselines: {},
  geoLevelId: null,
  metricId: null,
  year: null,
  viewMode: 'index',
  overlays: new Set(),
  hoveredGeoid: null,
  selectedGeoid: null,
  hideUnreliable: false,
  playing: false,

  /**
   * The root index carries no layer tree, so this only decides WHICH region to
   * open; the selections that depend on the tree are made in setRegionDoc once
   * that region's document arrives.
   */
  setManifest: (manifest) => {
    const id =
      manifest.regions.find((r) => r.id === manifest.defaultRegion)?.id ??
      manifest.regions[0]?.id ??
      null;
    set({ manifest, regionId: id });
  },

  /**
   * Cache a region document and settle the selections that depend on its tree.
   *
   * Selections CARRY OVER when the new region also has them: switching from
   * Columbus to the US while looking at poverty in 2016 should land on poverty
   * in 2016, not reset to the alphabetically first metric in the latest year.
   * Anything the new region lacks falls back to its own default.
   */
  setRegionDoc: (doc) => {
    const s = get();
    const metrics = doc.layers.flatMap((l) => l.groups ?? []).flatMap((g) => g.metrics);
    const metric =
      (s.metricId ? metrics.find((m) => m.id === s.metricId) : undefined) ??
      doc.layers.find((l) => l.kind === 'metric')?.groups?.[0]?.metrics[0];

    const level =
      (s.geoLevelId && metric?.geoLevels.includes(s.geoLevelId)
        ? doc.geoLevels.find((g) => g.id === s.geoLevelId)
        : undefined) ??
      doc.geoLevels.find((g) => g.default) ??
      doc.geoLevels[0];

    const years = metric?.years ?? [];
    const year =
      s.year != null && years.includes(s.year) ? s.year : (years[years.length - 1] ?? null);

    set({
      regions: { ...s.regions, [doc.id]: doc },
      regionId: doc.id,
      geoLevelId: level?.id ?? null,
      metricId: metric?.id ?? null,
      year,
    });
  },

  /**
   * Switch the region on screen. The document is fetched by App; this only
   * moves the pointer and clears state that cannot survive the move.
   *
   * The baseline selection is dropped: "vs the US" is meaningful while looking
   * at Columbus, but once the US itself is on screen the same setting would
   * pin every state against a baseline it is part of, which is just the
   * region's own baseline wearing a confusing label.
   */
  setRegion: (regionId) =>
    set({ regionId, baselineRegionId: null, selectedGeoid: null, hoveredGeoid: null }),

  setBaselineRegion: (baselineRegionId) => set({ baselineRegionId }),
  setBaselines: (b) => set((s) => ({ baselines: { ...s.baselines, [b.region]: b } })),

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
    const { regions, regionId } = get();
    return regionId ? (regions[regionId] ?? null) : null;
  },
}));

export function nearestYear(years: number[], target: number): number {
  return years.reduce(
    (best, y) => (Math.abs(y - target) < Math.abs(best - target) ? y : best),
    years[0]!,
  );
}

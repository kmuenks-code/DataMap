import { create } from 'zustand';

import type { BaselineFile, Manifest, MetricSummary, RegionSummary, ViewMode } from '../data/types.ts';
import type { RankBasis, RankDirection, RankMeasure } from '../lib/stats/leaderboard.ts';
import { allMetrics, findMetric } from '../data/types.ts';

/** Which visualisation occupies the stage. The scope controls serve both. */
export type StageView = 'map' | 'scatter';

/**
 * One scatter axis: a metric, and which quantity of it to plot.
 *
 * (measure, basis) is the leaderboard's pair, so "value / change" means the
 * same thing everywhere in the app -- and 'change' always carries the units of
 * its measure rather than leaving them to be guessed. See lib/stats/scatter.ts.
 */
export interface AxisSelection {
  metricId: string | null;
  measure: RankMeasure;
  basis: RankBasis;
  log: boolean;
}

export type AxisKey = 'x' | 'y';

/**
 * A metric for an axis that can actually be drawn here: published at this geo
 * level, and ideally not the one already on the other axis -- a scatter of a
 * metric against itself is a diagonal line and no information.
 */
function pickAxisMetric(
  metrics: MetricSummary[],
  geoLevelId: string | null,
  preferred: string | null,
  avoid: string | null,
): string | null {
  const usable = metrics.filter((m) => !geoLevelId || m.geoLevels.includes(geoLevelId));
  if (preferred && usable.some((m) => m.id === preferred)) return preferred;
  return (usable.find((m) => m.id !== avoid) ?? usable[0])?.id ?? null;
}

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
  /**
   * Leaderboard settings. Deliberately NOT derived from viewMode's sibling
   * controls: what the map colors and what the list ranks on are the same
   * quantity (viewMode), but "biggest now" versus "grew most since 2009" is an
   * independent question the reader asks of that same quantity.
   */
  topBasis: RankBasis;
  topDirection: RankDirection;
  /** Put the areas excluded for wide survey error back into the list. */
  topShowImprecise: boolean;
  topOpen: boolean;

  /**
   * The scatter view. It shares the whole scope -- region, geo level, year,
   * baseline -- with the map, and adds only what a map has no room for: a
   * second metric, and which quantity each axis plots.
   */
  stageView: StageView;
  axes: Record<AxisKey, AxisSelection>;
  /** Put the areas excluded for wide survey error back into the cloud. */
  scatterShowImprecise: boolean;
  /** Size dots by the region's population metric, when it publishes one. */
  scatterSizeByPopulation: boolean;
  scatterTrendline: boolean;

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
  setTopBasis: (v: RankBasis) => void;
  setTopDirection: (v: RankDirection) => void;
  setTopShowImprecise: (v: boolean) => void;
  setTopOpen: (v: boolean) => void;
  setStageView: (v: StageView) => void;
  setAxis: (which: AxisKey, patch: Partial<AxisSelection>) => void;
  setScatterShowImprecise: (v: boolean) => void;
  setScatterSizeByPopulation: (v: boolean) => void;
  setScatterTrendline: (v: boolean) => void;

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
  topBasis: 'level',
  topDirection: 'highest',
  topShowImprecise: false,
  topOpen: true,

  stageView: 'map',
  // Metric ids are settled in setRegionDoc, once a region's tree is known.
  axes: {
    x: { metricId: null, measure: 'raw', basis: 'level', log: false },
    y: { metricId: null, measure: 'raw', basis: 'level', log: false },
  },
  scatterShowImprecise: false,
  scatterSizeByPopulation: true,
  scatterTrendline: true,

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
    const metrics = allMetrics(doc);
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

    // The axes carry over on the same terms as the map's metric: a scatter of
    // income against poverty stays that scatter when the region changes, and
    // only a region that lacks one of them forces a substitution. The x axis
    // seeds from the map's metric on a cold start, so the first scatter opened
    // is about something the reader was already looking at.
    const x = pickAxisMetric(metrics, level?.id ?? null, s.axes.x.metricId ?? metric?.id ?? null, null);
    const y = pickAxisMetric(metrics, level?.id ?? null, s.axes.y.metricId, x);

    set({
      regions: { ...s.regions, [doc.id]: doc },
      regionId: doc.id,
      geoLevelId: level?.id ?? null,
      metricId: metric?.id ?? null,
      year,
      axes: {
        x: { ...s.axes.x, metricId: x },
        y: { ...s.axes.y, metricId: y },
      },
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
    const s = get();
    const region = s.region();
    if (!region) return set({ geoLevelId, selectedGeoid: null });

    const metrics = allMetrics(region);
    // Both axes are stranded by the same move, and for the same reason: a
    // scatter half-drawn from a metric this geography does not publish is an
    // empty panel with no explanation.
    const x = pickAxisMetric(metrics, geoLevelId, s.axes.x.metricId, null);
    const y = pickAxisMetric(metrics, geoLevelId, s.axes.y.metricId, x);
    const axes = { x: { ...s.axes.x, metricId: x }, y: { ...s.axes.y, metricId: y } };

    const current = s.metricId ? findMetric(region, s.metricId) : undefined;
    if (current?.geoLevels.includes(geoLevelId)) {
      return set({ geoLevelId, selectedGeoid: null, axes });
    }
    const fallback = metrics.find((m) => m.geoLevels.includes(geoLevelId));
    set({
      geoLevelId,
      selectedGeoid: null,
      axes,
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
  setTopBasis: (topBasis) => set({ topBasis }),
  setTopDirection: (topDirection) => set({ topDirection }),
  setTopShowImprecise: (topShowImprecise) => set({ topShowImprecise }),
  setTopOpen: (topOpen) => set({ topOpen }),

  setStageView: (stageView) => set({ stageView }),

  /**
   * A change is signed, so it has no logarithm. Rather than let the two
   * controls contradict each other, switching an axis to 'change' drops its log
   * scale here -- one rule, in the place that owns the state, instead of a
   * guard in every consumer.
   */
  setAxis: (which, patch) =>
    set((s) => {
      const next = { ...s.axes[which], ...patch };
      if (next.basis === 'delta') next.log = false;
      return { axes: { ...s.axes, [which]: next } };
    }),

  setScatterShowImprecise: (scatterShowImprecise) => set({ scatterShowImprecise }),
  setScatterSizeByPopulation: (scatterSizeByPopulation) => set({ scatterSizeByPopulation }),
  setScatterTrendline: (scatterTrendline) => set({ scatterTrendline }),

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

import type { RegionIndexEntry, RegionSummary } from '../data/types.ts';
import { regionChain } from '../data/types.ts';
import { useAppStore } from '../state/useAppStore.ts';

/** Anything that can serve as the 100% line: the region on screen, or an ancestor. */
type BaselineTarget = Pick<RegionSummary, 'kind' | 'label'> | null;

/**
 * What the 100% line is called.
 *
 * The index is `100 * area / baseline`, and the baseline is a different real
 * thing per region kind: a metro's published CBSA figure, a state's own total,
 * the nation's `us:1`. Every string that says "metro" is therefore a claim
 * about which of those is on screen -- calling the US baseline "the metro
 * average" is not a wording slip, it names the wrong denominator.
 *
 * Note this describes the BASELINE region, which after step 4 is not always
 * the region being drawn: Columbus townships compared with the country say
 * "US", not "metro".
 */
export function baselineNoun(target: BaselineTarget): string {
  switch (target?.kind) {
    case 'national':
      return 'US';
    case 'state':
      return 'state';
    default:
      return 'metro';
  }
}

/** Title-case form for buttons and labels ("vs Metro", "vs US"). */
export function baselineLabel(target: BaselineTarget): string {
  const noun = baselineNoun(target);
  return noun === 'US' ? 'US' : noun[0]!.toUpperCase() + noun.slice(1);
}

/**
 * The ancestor baseline that is actually IN EFFECT, or null for the region's
 * own.
 *
 * Selecting an ancestor is a request, not a guarantee: its baselines file may
 * still be in flight, or it may not publish this metric at all. In both cases
 * the numbers fall back to the region's own precomputed index -- so this
 * predicate must gate the LABEL too, or the panel would read "196% of US"
 * while showing a figure divided by the metro. Numbers and words have to
 * describe the same denominator.
 *
 * Every consumer derives from this one function for exactly that reason.
 */
export function useActiveBaselineRegionId(): string | null {
  const regionId = useAppStore((s) => s.regionId);
  const baselineRegionId = useAppStore((s) => s.baselineRegionId);
  const metricId = useAppStore((s) => s.metricId);
  const file = useAppStore((s) =>
    s.baselineRegionId ? s.baselines[s.baselineRegionId] : undefined,
  );
  if (!baselineRegionId || baselineRegionId === regionId || !metricId) return null;
  return file?.metrics[metricId] ? baselineRegionId : null;
}

/**
 * The region whose totals are currently the 100% line -- the ancestor in
 * effect if there is one, otherwise the region on screen.
 */
export function useBaselineTarget(): Pick<RegionSummary, 'kind' | 'label'> | null {
  const region = useAppStore((s) => s.region());
  const manifest = useAppStore((s) => s.manifest);
  const activeId = useActiveBaselineRegionId();
  if (!activeId) return region;
  return manifest?.regions.find((r) => r.id === activeId) ?? region;
}

/**
 * Every region whose totals this region's areas may legitimately be compared
 * with: itself first, then each ancestor. One entry means no choice to offer.
 */
export function useBaselineOptions(): RegionIndexEntry[] {
  const manifest = useAppStore((s) => s.manifest);
  const regionId = useAppStore((s) => s.regionId);
  if (!manifest || !regionId) return [];
  return regionChain(manifest.regions, regionId);
}

/**
 * Output format. One file per (region, geoLevel, metric), columnar.
 *
 * Why columnar rather than an array of objects: the browser needs "all years
 * for one metric" to draw the timeline, and repeating the geoid string 15x per
 * area triples the payload. Here geoids are declared once and every year is a
 * parallel array indexed the same way -- roughly 4x smaller than the naive
 * shape, and it maps straight onto typed arrays for the color scale.
 *
 * Values are rounded before writing: indices to 1 decimal, raw values to the
 * metric's natural precision. Full float64 precision is meaningless against an
 * ACS margin of error and costs real bytes.
 *
 * Target: ~570 tracts x 15 years x 2 series ≈ 120 KB raw / ~25 KB gzipped
 * per metric. Small enough to fetch on metric select with no loading state.
 */
export interface MetricFile {
  schema: 1;
  region: string;
  geoLevel: string;
  metric: string;
  /** Taxonomy: which layer and group this metric hangs under. */
  layer: string;
  group: string;
  kind: string;
  unit: string;
  years: number[];
  /** Parallel to every `values`/`index` row. */
  geoids: string[];
  /** Display names, parallel to geoids. */
  names: string[];
  /** The 100% line, per year. Parallel to `years`. */
  baseline: (number | null)[];
  /** Raw estimate. `values[yearIdx][geoIdx]`. */
  values: (number | null)[][];
  /** Relative index, 100 = metro. `index[yearIdx][geoIdx]`. */
  index: (number | null)[][];
  /** Coefficient of variation, for reliability shading. Omitted if no MOE. */
  cv?: (number | null)[][];
  /**
   * Deliberately carries NO build timestamp.
   *
   * These files are committed, and a timestamp would rewrite every one of them
   * on every run whether or not any number changed -- making `git diff` useless
   * for the question it exists to answer ("did this refresh actually alter the
   * data?") and adding history for nothing. The build time lives once, in the
   * region manifest.
   */
  meta: {
    dataset: string;
    variables: string[];
    /** Set when boundaries differ from the current vintage; see crosswalk.ts. */
    boundaryVintageByYear?: Record<string, number>;
    notes?: string[];
  };
}

/** Shape of the layer > group > metric tree emitted into manifest.json. */
export interface ManifestMetric {
  id: string;
  label: string;
  unit: string;
  kind: string;
  higherIsBetter: boolean | null;
  description?: string;
  years: number[];
  geoLevels: string[];
}

export interface ManifestGroup {
  id: string;
  label: string;
  metrics: ManifestMetric[];
}

export interface ManifestLayer {
  id: string;
  label: string;
  kind: 'metric' | 'overlay';
  description?: string;
  attribution: string;
  /** Present on metric layers. */
  groups?: ManifestGroup[];
  /** Present on overlay layers. */
  render?: { type: string; labelField?: string };
  /** Overlay layers: how many shapes are in the file. */
  areaCount?: number;
}

export function round(n: number | null, places: number): number | null {
  if (n == null) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

import { describe, expect, it } from 'vitest';

import { geometryMatchesFile } from '../src/data/useMetricData.ts';

/**
 * Regression: switching geography blanked the map on the deployed site.
 *
 * The metric file and the geometry load in two independent effects. Switching
 * from county-subdivision to place made the new data available while the old
 * polygons were still in state; joining them matched zero geoids, and the join
 * is memoised on the FILE's identity, so the empty result was cached under the
 * place key and never recomputed. The map stayed blank until reload.
 *
 * It only fired when the responses landed in that order, which is why it showed
 * up on GitHub Pages and not against a warm local dev server.
 */
describe('geometryMatchesFile', () => {
  const place = { geoLevel: 'place' };

  it('joins only when level AND vintage agree', () => {
    expect(geometryMatchesFile(place, { level: 'place', vintage: 2020 }, 2020)).toBe(true);
  });

  it('refuses the stale previous level still held in state', () => {
    expect(geometryMatchesFile(place, { level: 'county-subdivision', vintage: 2020 }, 2020)).toBe(
      false,
    );
  });

  it('refuses geometry from the wrong boundary vintage', () => {
    // Scrubbing across a decennial redraw swaps the polygons; the old vintage
    // must not be joined to the new year's data even at the same level.
    expect(geometryMatchesFile(place, { level: 'place', vintage: 2010 }, 2020)).toBe(false);
  });

  it('refuses while the target vintage is still unknown', () => {
    expect(geometryMatchesFile(place, { level: 'place', vintage: 2020 }, undefined)).toBe(false);
  });
});

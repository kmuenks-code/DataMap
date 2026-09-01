/**
 * TRACT BOUNDARY CROSSWALK -- the biggest correctness trap in this project.
 *
 * Census tracts are REDRAWN every decade. VERIFIED against the live API on
 * 2026-08-29 by counting Franklin County (39049) tracts per vintage -- there
 * are THREE eras here, not two, which is easy to miss:
 *
 *     2009        -> 264 tracts   (Census 2000 boundaries)
 *     2010-2019   -> 284 tracts   (Census 2010 boundaries)
 *     2020-2024   -> 328 tracts   (Census 2020 boundaries)
 *
 * The 2009 ACS5 (covering 2005-2009) predates the 2010 redraw, so it is its
 * own era. Joining a 2012 estimate to a 2020 tract polygon by GEOID silently
 * produces a WRONG map -- the geoid may even match while describing different
 * ground.
 *
 * Three options, in increasing order of effort:
 *
 *   A. Use a decade-stable geography instead. County subdivisions (townships /
 *      municipalities) barely move and cover the whole metro. This gives a
 *      genuine 2009-2023 series with zero crosswalk work, at coarser
 *      resolution. RECOMMENDED for the first working version of the timeline.
 *
 *   B. Split the timeline into two eras (2009-2019 on 2010 tracts, 2020-2023 on
 *      2020 tracts) with a visible break in the UI. Honest, no interpolation,
 *      but no single continuous series.
 *
 *   C. Areal/population-weighted interpolation of 2010 tracts onto 2020 tracts
 *      using the official Census 2010->2020 relationship file, or the NHGIS
 *      crosswalks (which are population-weighted and better). Gives one
 *      continuous series but introduces estimation error that must be
 *      disclosed in the UI.
 *
 * Ship A first. Implement C behind a flag once the rest works.
 *
 * Census relationship files:
 *   https://www.census.gov/geographies/reference-files/time-series/geo/relationship-files.html
 * NHGIS crosswalks (free account required):
 *   https://www.nhgis.org/geographic-crosswalks
 */

export type BoundaryVintage = 2000 | 2010 | 2020;

export interface CrosswalkRow {
  sourceGeoid: string;
  targetGeoid: string;
  /** Share of the SOURCE tract's population landing in the target tract. */
  weight: number;
}

export function boundaryVintageForYear(year: number): 2000 | 2010 | 2020 {
  if (year >= 2020) return 2020;
  if (year >= 2010) return 2010;
  return 2000; // the 2009 ACS5 vintage
}

export function applyCrosswalk(
  _values: Map<string, number | null>,
  _rows: CrosswalkRow[],
): Map<string, number | null> {
  throw new Error('Not implemented -- see option C above. Ship option A first.');
}

/**
 * COUNTY GEOID RENAMES -- areas that changed code without changing ground.
 *
 * Distinct from the tract problem above, and much smaller: no interpolation is
 * involved, because the polygon is the same polygon. A county is simply
 * published under a new GEOID from some year onward, so a naive build produces
 * two half-length series for one place and leaves the older one joined to no
 * polygon at all (the TIGER release only carries the new code).
 *
 * VERIFIED 2026-09-01 from the built data -- population is continuous across
 * each boundary, which is what distinguishes a rename from a merge:
 *
 *   02270 Wade Hampton Census Area -> 02158 Kusilvak Census Area  (2015)
 *      7,778 in 2014  ->  7,914 in 2015
 *   46113 Shannon County -> 46102 Oglala Lakota County            (2015)
 *     14,005 in 2014  -> 14,153 in 2015
 *
 * NOT included, deliberately: 51515 Bedford city -> 51019 Bedford County
 * (2014). That one is a genuine MERGE -- an independent city dissolving into
 * the surrounding county, whose population jumps 69,175 -> 75,607 the same
 * year, absorbing the city's ~6,400. Aliasing it would attribute a small
 * city's median to a county eleven times its size. It stays a real gap: the
 * city has data for 2009-2013 and no polygon in any shipped vintage.
 */
const COUNTY_RENAMES: Record<string, string> = {
  '02270': '02158',
  '46113': '46102',
};

/**
 * The geoid an area is published under TODAY, for one that was renamed.
 *
 * Applied on the way in so a metric file carries one continuous series per
 * place rather than two truncated ones under two codes.
 */
export function canonicalGeoid(geoid: string): string {
  return COUNTY_RENAMES[geoid] ?? geoid;
}

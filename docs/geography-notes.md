# Geography Notes

## Choosing the area unit

| Level | Count (Columbus MSA) | Complete 2009–2024 series | Tiles the metro? | Good for |
|---|---|---|---|---|
| County | 10 | ✅ | ✅ | Too coarse for a city map |
| **County subdivision** (township/city) | 188 | **90%** | ✅ | **Default. Carries the timeline** |
| **Place** (municipality) | **137** | **77%** | ❌ 78% of population | **The colloquial view — Dublin, UA, Hilliard** |
| Census tract | 651 | 43% | ✅ | Best resolution; needs a crosswalk for long series |
| Block group | ~1,700 | — | ✅ | MOEs too large to be meaningful |
| ZCTA (ZIP) | ~190 | ⚠️ shifts | ✅ | Intuitive, but ZIPs are mail routes, not places |

Completeness figures are measured from the built files, not estimated.

## Places: the geography residents actually use

Townships are correct and unfamiliar. Nobody says "I live in Washington township" —
they say Dublin. The `place` level exists to close that gap, and it does so without
compromising anything, because **the ACS publishes places directly**:

- Medians are published per place (verified for every year 2009–2024), so `baseline:
  "published"` works unchanged. Nothing is aggregated and no median is ever averaged.
- Place FIPS codes are stable across the whole series — Dublin is `3922694` in 2009
  and in 2024.
- Boundaries are the real annexed city limits, so Dublin spans Franklin, Delaware and
  Union counties and cuts across several townships. That is the point.

### Three things about places that will bite

**1. A place does NOT nest inside a county.** `for=place:*&in=state:39 county:049`
returns HTTP 400, "unknown/unsupported geography hierarchy". Places must be fetched
statewide and filtered afterwards, which is what `censusIn: "state"` +
`restrictBy: "place-by-county"` encode. Membership comes from the Census relationship
file (`national_place_by_county2020.txt`), derived at build time rather than frozen
into a hand-maintained list. The same allowlist filters the TIGER geometry, because
the place shapefile carries **no COUNTYFP field** to filter on.

**2. They do not tile the metro.** 137 places hold 1,681,980 of the metro's 2,151,847
people — **78.2%**. The other **21.8%** live in unincorporated township land that
belongs to no place and is simply blank. Two consequences:

- The UI must say so, or blank ground reads as missing data. It does, under the
  geography picker.
- A rate baseline pooled over places would be "the rate among people who live in an
  incorporated place", not the metro rate. Levels with `tilesRegion: false` pull rate
  baselines from the published CBSA numerator/denominator instead. Verified: the
  place-level 2023 poverty baseline is 12.24, matching both the published CBSA figure
  and the county-subdivision pooled value.

**3. Rule 5 applies harder here than anywhere else.** 105 of the 137 places are under
5,000 people; only 13 are at or above 20,000. Small-place noise is the dominant signal
if CV shading is off.

Also note that place boundaries change with **annexation every year**, not on a
decennial redraw. The ID persists while the area grows, so part of a suburb's movement
over 16 years is the suburb physically getting bigger. This is a different failure mode
from tracts (where the ID persists but describes different ground) and is milder, but
it is not nothing. Geometry is still built per decade-vintage, which approximates the
drift; there is no per-year place geometry.

## Nesting

`state (2) → county (3) → tract (6) → block group (1)` — a tract GEOID is `39049001100`:
state 39, county 049, tract 001100. County subdivisions nest in counties but tracts do
**not** nest in county subdivisions, so those two levels are alternative views, not a
drill-down hierarchy.

Places are the exception to all of it: a place GEOID is **state + place, 7 characters**
(`3922694`), with no county component, because a place can span counties. `geoidOf()`
in the pipeline branches on `censusIn` for exactly this reason.

## "Neighborhoods"

There is no federal neighborhood geography. Inside the city of Columbus — which the
place level renders as one 906,480-person polygon — named areas come from the city's own
GIS as a **display-only overlay**: 41 "Columbus Communities" (Clintonville, German
Village, Franklinton, University District, Northland…), licensed CC0-1.0.

They follow streets and rivers, not tract lines, so **no statistic is recomputed onto
them**. Doing that would require areal or population-weighted interpolation and would
invent precision the source does not have. They are outlines and labels over whatever
metric is active, and the UI must not imply otherwise.

The city also publishes an **Area Commissions** layer (21 polygons). It is deliberately
not used: it covers only part of the city, and its attribute table carries volunteer
names, personal emails and phone numbers, none of which belongs in a public bundle.

## Summary level 070 — evaluated and rejected

`place/remainder (or part)` looks like the perfect geography: it splits each township
into its place-parts plus a labelled remainder, giving a complete tiling with familiar
names. It works —

```
Dublin city (part), Washington township        pop 40,461
Hilliard city (part), Washington township      pop  1,452
Remainder of Washington township               pop  1,365
```

— but **medians come back null at 070**. Verified: `B19013_001E` is null for every row
above. It also refuses a wildcard on county subdivision, so it costs one request per
subdivision (181/year) rather than one. Usable for counts and rates only. Not worth it
while places carry published medians at 1 request per year.

## Scaling to states

The national/state view is the same pipeline with different config: `geoLevel: state`,
`for=state:*` with no `in` clause, `cb_YYYY_us_state_20m` geometry, and the baseline
becoming the US value rather than a metro's. It is a new region entry, not new code —
which is the reason for the registry design.

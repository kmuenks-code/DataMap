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

## National geography (`us` region)

Added 2026-09-01. One geo level, `state`, fetched with `censusIn: "us"` — `for=state:*`
with **no `in=` clause at all**, one request per year for the whole country.

### Puerto Rico is in the areas but not in the baseline

`for=state:*` returns **52 rows**: the 50 states, DC, and Puerto Rico. The national
baseline `for=us:1` covers **51** — it excludes PR. Verified against the live API, and
the gap is exact to the person:

| Year | sum(`state:*`) | `us:1` | difference | PR population |
|---|---|---|---|---|
| 2009 | 305,401,642 | 301,461,533 | 3,940,109 | 3,940,109 |
| 2024 | 338,156,808 | 334,922,499 | 3,234,309 | 3,234,309 |

Keeping PR would break the index in both directions: its own value would be divided by a
baseline computed for a country it is not part of, and an `aggregate` baseline pooled
over all 52 rows would no longer equal the published national figure it claims to be —
the same failure rule 9 describes for places, reached by a different route.

With territories dropped, the aggregated rate matches the published one exactly
(2009: 13.471% both; 2024: 12.454% both), which is the check that confirms the rule.

The threshold (`FIPS >= 60` is a territory) is expressed once in
`etl/src/sources/census/states.ts` and applied on both the data side (`isUsState`) and
the geometry side (`+GEOID < 60` in mapshaper), because geometry and data disagreeing
about membership would render silently rather than fail.

**Puerto Rico is not thereby unmappable.** It belongs as its own region (`kind: "state"`,
baseline = PR), where its municipios are compared with Puerto Rico rather than with a
mainland average that excludes them.

### The national map cannot fit to its own bounding box

Alaska's Aleutian Islands cross the antimeridian, so Alaska's longitude span in the
TIGER file is **-178.9° to +179.8°** and the whole collection's bounding box comes out
**358.6° wide** — nearly the entire globe. `fitBounds` on that box zooms all the way out
and the lower 48 becomes a speck. The box is not merely coarse, it is false.

A region may therefore declare `fitBounds` in its config, which the app trusts over the
computed box. `us.json` uses `[-170, 18, -66, 60]`, framing the lower 48 plus Hawaii and
mainland Alaska. Alaska is enormous at that latitude under Web Mercator.

The real cartographic answer is the Albers USA convention — translate and scale AK and HI
into insets — which is **not built**. It would mean shipping geometry at coordinates that
are not the real ones, so it needs a deliberate decision rather than a quiet transform.

### State geography has no boundary-era problem

State boundaries are fixed across all three boundary eras, so this level has a genuinely
continuous 2009–2024 series with no crosswalk. That is the national analogue of the
county-subdivision choice for Columbus.

### Counties have THREE boundary eras, and none of them is decadal

The decadal assumption baked into `boundaryVintageForYear()` is a *tract* rule. County
boundaries change when an individual state acts, on that state's schedule. VERIFIED
2026-09-01 by listing `for=county:*` per year:

| Era | Years | What changed |
|---|---|---|
| 1 | 2009–2019 | Alaska has Valdez-Cordova (`02261`) |
| 2 | 2020–2021 | Alaska splits it into Chugach (`02063`) + Copper River (`02066`) |
| 3 | 2022–2024 | Connecticut replaces 8 counties with **9 planning regions**, under entirely new GEOIDs (`09001`–`09015` → `09110`–`09190`) |

Counts run 3,143 → 3,142 → 3,144 non-territory areas across the range.

The county level therefore declares its own `boundaryVintages`, mapping each era to the
GENZ release that carries it (2010→GENZ2019, 2020→GENZ2021, 2022→GENZ2023). Using the
decadal default would join 2020–2021 Connecticut data to 2022 planning-region polygons
and leave the whole state blank for two years. Verified in the browser: CT renders 8/8
counties in 2019 and 2021, and 9/9 planning regions in 2022 and 2024.

### Renames are not merges

Three counties still failed to join before this was handled. Population continuity across
the boundary is what tells the two cases apart:

| Old → new | Year | 2014 → 2015 population | Verdict |
|---|---|---|---|
| `02270` Wade Hampton → `02158` Kusilvak | 2015 | 7,778 → 7,914 | **rename** |
| `46113` Shannon → `46102` Oglala Lakota | 2015 | 14,005 → 14,153 | **rename** |
| `51515` Bedford city → `51019` Bedford County | 2014 | county jumps 69,175 → 75,607 | **merge** |

The two renames are folded by `canonicalGeoid()` in `etl/src/transform/crosswalk.ts`, so
each place has one continuous series. The merge is deliberately NOT folded: aliasing it
would attribute an independent city's median to a county eleven times its size. Bedford
city keeps its 2009–2013 data and has no polygon in any shipped vintage — 5 area-years
out of ~50,000, and the only remaining gap at this level.

Display names come from the **most recent** year an area appears, not the first. Otherwise
Kusilvak and Oglala Lakota would both still be labelled with the names they were given up
in 2015, which is worse than a missing label.


## Region hierarchy and the baseline picker

A region may declare `parent`. That does NOT change what is drawn -- it names another
region whose published totals may serve as the 100% line instead. `columbus-oh` declares
`parent: "us"`; when an Ohio region exists, the chain becomes metro -> state -> nation and
the picker gains a rung with no code change.

The mechanism is deliberately cheap. Each region emits `baselines.json` (~2 KB: every
metric's 100% line per year), so comparing Columbus with the country costs one small
fetch rather than the ~900 KB US county file, and the index is recomputed client-side as
`100 * value / baseline`. Nothing is rebuilt and no second index is shipped.

Two invariants worth keeping:

- **Rank is not rebaselined.** Ranking is over the areas on screen, so it does not depend
  on what 100 means. Bexley stays 12th of 179 either way.
- **Labels and numbers share one predicate.** Choosing an ancestor is a request; it takes
  effect only once that region's baselines have loaded AND contain the selected metric.
  `useActiveBaselineRegionId()` gates the numbers and the wording together, so the panel
  can never read "196% of US" over a figure divided by the metro.

`writeBaselines()` takes the region's DEFAULT geo level. A baseline is a property of the
region, not of the geography drawn on it, but the pipeline computes one per level and
levels that do not tile the region (places) pull published figures where tiling levels
pool their own areas. The default level is the one whose areas actually cover the region.

## State regions

All 50 states + DC exist as regions, but there are **no 51 config files**. `states.json`
is generated from the live API (`for=state:*`, so no FIPS code or name is transcribed by
hand) and each entry expands through `regions/_state-template.json` in `loadRegion()`.
Changing what a state region contains is one edit, not fifty-one. An explicit
`regions/<id>.json` still wins — `alaska.json` is the only one, and exists solely because
the Aleutians cross the antimeridian.

### One statewide call per level, not one per county

`for=tract:*&in=state:39` and `for=county subdivision:*&in=state:39` both succeed, for
every year 2009–2024. An earlier note in `config.ts` asserted the opposite — that
county-nested levels required `in=state:XX county:YYY`. Retested 2026-09-01: false.

The correction is worth the emphasis because it decides feasibility. Per-county fetching
would mean 3,143 counties × 16 years ≈ **50,000 requests** to build the states. Statewide
fetching is 51 × 16 × 3 levels ≈ **2,500**.

It also exposed a latent bug. `geoidOf()` inferred county-nesting from `censusIn` — how
the level was *fetched* — so a statewide-fetched tract would have produced a 7-character
geoid instead of 11 and joined to nothing. Nesting is a property of the **geography**, so
it now comes from a `GEOID_PARTS` table keyed on the Census geography name, and an
unknown geography throws rather than guessing a key.

### TIGER publishes counties only nationally

`cb_2019_39_county_500k.zip` is a 404; `cb_2019_us_county_500k.zip` is not. Tracts,
county subdivisions and places all have per-state files. A geo level therefore declares
`tigerScope`, and a state region's county level downloads the national file and filters
it by `STATEFP`.

### Levels, and why tract is off by default

| Level | Areas (Ohio) | Tiles the state | Default |
|---|---|---|---|
| county | 88 | yes | **yes** |
| county-subdivision | 1,622 | yes | no |
| place | 1,283 | **no** (~78% of population) | no |
| tract | — | yes | **disabled** |

County is the default for the same reason county subdivisions are for Columbus: it tiles
and is stable across the range, so the timeline is honest there. **Tract is disabled by
default** — rule 3 has not gone away, only ~43% of tracts have a complete 2009–2024
series, and the crosswalk is still unbuilt. The geometry and data both build correctly;
it is the *series* that is not continuous, so enabling it per state should be deliberate.

Residual unjoined rows in Ohio: 51 area-years at county-subdivision and 18 at place, out
of ~26,000 and ~20,000 — dissolved villages (Brady Lake) and redefined CDPs, concentrated
in 2009–2013. The `2010` vintage uses GENZ2019, i.e. *end*-of-decade boundaries, so an
entity that existed in 2009 and was gone by 2019 has no polygon. Same trade as Bedford
city: an extra vintage is not worth 0.2%.

### Map view comes from the geometry

No state's centre is typed. `writeRegionManifest()` reads the bounding box mapshaper
writes into the built TopoJSON and centres the region on it, so the opening view cannot
disagree with what is drawn. When a bbox spans more than 180° of longitude the ETL warns
and refuses to guess — that is the antimeridian case, and it needs an explicit
`fitBounds`.

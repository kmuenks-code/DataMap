# Data Sources

## US Census — American Community Survey (primary)

**Endpoint:** `https://api.census.gov/data/{year}/acs/acs5`
**Key:** free, instant, no approval — https://api.census.gov/data/key_signup.html
**Discovery:** `https://api.census.gov/data/2023/acs/acs5/variables.json` (every variable, ~35 MB)
**Group browser:** `https://api.census.gov/data/2023/acs/acs5/groups/B19013.json`

### Which ACS product

| Product | Smallest geography | Use here |
|---|---|---|
| ACS 5-year (`acs/acs5`) | **census tract, block group** | ✅ the only option for neighborhood-level |
| ACS 3-year | 20k+ population | ✗ discontinued after 2013 |
| ACS 1-year (`acs/acs1`) | 65k+ population | ✗ no tract data; useful only for county/metro/state |
| Decennial (`dec/pl`, `dec/dhc`) | block | Later — exact counts, but only 2010/2020 |

**Available tract-level range: 2009–2023.** ACS 5-year begins with the 2005–2009 vintage.

### Rate limits — and why they never bind here

- **A key is now mandatory.** Verified 2026-08-29: an unkeyed request returns **HTTP 200 with an HTML "Missing Key" page**, not a 4xx and not JSON. Older docs describing a 500/day unkeyed allowance are out of date. `client.ts` fails fast on a missing key and content-type-checks every response, because the naive failure mode is a baffling `Unexpected token '<'` from `JSON.parse`.
- Keyed: no published hard cap. Be courteous — the ETL throttles to 8 req/s by default.
- **Measured**: a complete cold build — 9 metrics x 16 years x 2 geo levels x 10 counties, plus metro baselines — cost **404 requests** and produced a 6.6 MB response cache. Comfortably a single sitting, and the throttle keeps it polite (~4.5 min wall clock).
- Because all fetching happens at build time and responses are disk-cached content-addressed, a normal re-run makes **zero** requests. Published vintages are immutable, so cache hits are always as correct as live fetches.

Three rules keep it that way:
0. **Always send the key.** Non-negotiable now, and 200-with-HTML is the failure mode to guard against.
1. **Batch variables.** Up to 49 per call. Fetch every metric's variables for a year/county together, not one call per metric.
2. **Never fetch from the browser.** A client-side key is a public key, and per-user traffic would blow the quota instantly.
3. **Cache raw responses.** `etl/.cache/`, gitignored, restored in CI. Measured: a full rebuild after a cold build makes **0 requests** and finishes in 1.2s.
4. **Keep cache keys filter-independent.** The pipeline always fetches the full per-year variable superset, never just the `--metric` subset — otherwise every filtered run misses the cache and re-fetches. This is why `--metric x` costs nothing after a full build.

### Gotchas that will bite

- **Suppressed values** come back as large negatives (`-666666666`, `-999999999`), not `null`. `parseEstimate()` maps them to `null`.
- **Medians cannot be averaged.** The metro median income is not the mean of tract medians. Pull the published CBSA value instead — `baseline: "published"`.
- **5-year estimates overlap.** 2022 and 2023 share four years of sample. Consecutive years are not independent; compare 2013/2018/2023 for real trend claims.
- **Margins of error at tract level are large.** Ship the CV and shade unreliable areas rather than presenting a false crispness.
- **Errors can arrive as HTTP 200.** Missing key, bad key, and unknown variable names all return an HTML page with a 200 status. Never call `res.json()` without checking the content type.
- **Variables get renamed between vintages.** `B15003` replaced `B15002` in 2012; `B23025` starts in 2010. Hence `minYear` in the metric registry.
- **Tract boundaries change every decade.** See `etl/src/transform/crosswalk.ts` — this is the single biggest correctness risk in the project.
- **Places do not nest inside counties.** `for=place:*&in=state:39 county:049` is HTTP 400. Places must be fetched statewide (one call, not ten) and filtered afterwards. See `etl/src/sources/census/places.ts` and `docs/geography-notes.md`.
- **Summary level 070 publishes no medians.** `place/remainder (or part)` gives a complete, familiarly-named tiling of each township, but `B19013` is null on every row and it costs one request per county subdivision. Counts and rates only.

## Geometry — TIGER/Line cartographic boundaries

Use the **`cb_` cartographic** series, not full TIGER: generalized for display and clipped to shoreline.

```
https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_39_tract_500k.zip
https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_39_cousub_500k.zip
https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_state_20m.zip
```

Convert with mapshaper (already a devDependency):

```bash
npx mapshaper cb_2023_39_tract_500k.shp \
  -filter '["049","041","089","045","129","097","159","117","127","073"].includes(COUNTYFP)' \
  -simplify 8% keep-shapes \
  -proj wgs84 \
  -o format=topojson quantization=1e5 public/data/regions/columbus-oh/geometry/tract.topojson
```

TopoJSON stores each shared border once; with tracts, which share every edge, it lands 70–80% under the equivalent GeoJSON.

## Census place/county relationship file

One static, pipe-delimited national table, cached in `etl/.cache/geo/`:

```
https://www2.census.gov/geo/docs/reference/codes2020/national_place_by_county2020.txt
STATE|STATEFP|COUNTYFP|COUNTYNAME|PLACEFP|PLACENS|PLACENAME|TYPE|CLASSFP|FUNCSTAT
```

This is what makes the `place` geo level possible without a hand-maintained FIPS list.
It answers "which places are in this metro?" in **one request**, and the answer is
derived at build time, so a newly incorporated village appears on the next rebuild.

**Verified 2026-08-31:** the 137 places it yields for the 10-county Columbus MSA match,
one for one, the 137 found by querying summary level 070 across all 181 county
subdivisions — at 1 request instead of 181. The single discrepancy is instructive:
Hidden Lakes CDP is `35133` in the 2020 file and `35119` from the 2023 vintage onward.
Population 0, so it drops harmlessly, but `restrictPlaces()` logs any such drop rather
than hiding it.

Caveats: there is **no 2010-vintage equivalent** at a stable URL, so the 2020 table
filters both geometry vintages. Places created after 2020 are absent until the next
decennial file.

## City of Columbus GIS — neighborhood overlay

```
https://maps2.columbus.gov/arcgis/rest/services/Schemas/Development/MapServer/25
```

**"Columbus Communities"** — 41 polygons, field `AREA_NAME`, covering the entire city.
Serves GeoJSON directly with `f=geojson&outSR=4326`. **License CC0-1.0**, verified
2026-08-31 from the portal item metadata (this replaces the earlier
`unknown-check-before-publishing` placeholder in `layers.json`).

Deliberately NOT layer 12, **"Area Commissions"**: 21 polygons covering only part of the
city, and its attribute table carries volunteer names, personal emails and phone
numbers. The overlay builder keeps only the `name` field for exactly this reason.

Fetched at build time, cached in `etl/.cache/arcgis/`, emitted as TopoJSON to
`public/data/regions/<id>/overlays/`. Unlike ACS vintages this source *can* change, so
refresh means deleting the cache file rather than waiting for an automatic invalidation.

## Basemap

**The app ships with no basemap, and that is deliberate.** Verified 2026-08-29: CARTO's
formerly-keyless raster tiles now return `API KEY REQUIRED` images. Any keyless third-party
tile service can do this at any moment, and a key embedded in a static client bundle is a
public key — the exact thing this project's build-time-ETL architecture exists to avoid.

Areas are drawn on a plain background; identification comes from hover and the detail
panel. For ~180 townships that reads well, works offline, and has no expiry date.

To add street context, set `VITE_BASEMAP_TILES` (and `VITE_BASEMAP_ATTRIBUTION`) to a
raster tile template. Options, best first:

- **Self-hosted [Protomaps](https://protomaps.com/)** — a single `.pmtiles` file served
  over HTTP range requests from your own origin. Keyless, no third party, works on GitHub
  Pages. A Columbus-area extract is a few tens of MB. This is the recommended upgrade.
- **A keyed provider** (MapTiler, Stadia, CARTO). Workable, but the key ships to the
  client — restrict it by HTTP referrer and treat it as public.
- **Raw OSM tiles** — the OSMF tile usage policy forbids sustained app use. Do not.

### Three MapLibre traps, all verified here

1. **Never gate `addSource`/`addLayer` on the `load` event.** `load` waits for the style
   *and its sources*, so a slow or blocked basemap means your own data never renders. Key
   off `styledata` instead.
2. **An inline style OBJECT never finishes loading in MapLibre 5** — `isStyleLoaded()`
   stays false forever, no layers register, and no error is raised. The byte-identical
   style passed as a *URL* loads immediately. `basemap.ts` serialises the style to a blob
   URL for this reason.
3. **A `symbol` layer with `text-field` needs a `glyphs` URL**, which means fetching PBF
   font ranges from a third-party server at runtime — a runtime external dependency, and
   the end of the offline guarantee. Overlay labels are therefore plain DOM markers
   (`maplibregl.Marker`), which need no glyphs, no network and no basemap. They also get
   no automatic collision avoidance, so labels are hidden below a zoom threshold rather
   than allowed to pile up.

## MIT Election Lab — county presidential returns

"County Presidential Election Returns 2000-2024", `doi:10.7910/DVN/VOQCHQ`, CC0 1.0.
One 10 MB CSV covering seven presidential elections. Fetched by
`etl/src/sources/medsl/`, which emits the same `MetricFile` shape the ACS path does.

### Why county, and not precinct

Returns are reported natively by **precinct**, and precincts nest inside nothing this
project draws — not tracts, not county subdivisions, not places. Agreement with our
geographies is exact at county and above, and absent below it:

| Geo level | Agrees with election geography? |
|---|---|
| `state` | Exact. Canvass is published by state. |
| `county` | Exact. The county is the canvassing unit nationwide. |
| `county-subdivision` | No. Ohio precincts mostly sit inside one township, but the returns carry no cousub code, and "mostly" is not a join key. |
| `place` | No — and `tilesRegion: false` forbids a pooled rate baseline there anyway (rule 9). |
| `tract` | No. Precincts and tracts genuinely cross. |

Precinct is deliberately **not** a geo level. VEST publishes precinct shapefiles joined to
results (`doi:10.7910/DVN/K7760H`, CC BY 4.0), but they would need geometry per election
cycle, carry no stable ids across years, and join to no other metric here — the scatter
and the baseline picker would both go dark at that level. If sub-county politics is ever
wanted, the honest route is the **block disaggregation** VEST and the Redistricting Data
Hub publish: precinct results apportioned onto 2020 census blocks, which nest exactly into
every level we already have. Those values are estimates and would carry the same
disclosure burden as the unbuilt weather interpolation.

### Getting the file: the guestbook

MEDSL's datasets sit behind a **required Dataverse guestbook**, and it fails the way the
Census API does — HTTP 200 with a JSON error body, so `res.ok` proves nothing:

```json
{"status":"ERROR","message":"You may not download this file without the required Guestbook response for guestbookID 458."}
```

The documented way through is a POST of the guestbook response to the same endpoint, which
returns a short-lived signed URL. No account or API token is needed, but the depositor
marked name/email/institution/position **required**, so the ETL supplies them from `.env`
and refuses to run without them:

```
DATAVERSE_NAME=
DATAVERSE_EMAIL=
DATAVERSE_INSTITUTION=
DATAVERSE_POSITION=
```

The server will in fact issue a signed URL for a blank response. Sending blanks anyway
would be evading a disclosure the depositor asked for in exchange for the data, so the
build does not do it. The alternative is to download the file once in a browser and drop
it at `etl/vendor/countypres_2000-2024.csv`, which is used as-is with no request made.
That directory is gitignored for the same reason `.cache/` is.

### Five quirks, all measured against the released file (version 20260225)

1. **`totalvotes` is a column, not a sum.** Wisconsin and Idaho 2024 carry a
   `TOTAL VOTES CAST` row alongside the real candidates, so summing candidate rows returns
   **exactly double** the state's turnout — measured, WI 2024 came out 6,845,836 against an
   actual 3,422,918 — while every vote share stays plausible, because numerator and
   denominator inflate together. Read the total from the column; sum candidates only for
   party numerators, skipping rows with an empty `party` (`TOTAL VOTES CAST`, `UNDERVOTES`,
   `OVERVOTES`, `SPOILED`).
2. **`mode` is not uniform.** 29 state-years break the count out by how the ballot was
   cast, and AZ/AR/IA/LA in 2024 publish **both** the modes and a `TOTAL`. Summing
   everything double-counts those; filtering to `TOTAL` loses GA and NC in 2020, which
   publish no such row. Rule: prefer `TOTAL` where a county has one, else sum its modes.
   Verified by reconstruction — Missouri 2020 comes out at 3,025,962, its official
   statewide total to the vote.
3. **Alaska is not boroughs.** It reports by state house district, coded `02001`-`02040`,
   which **collide with real borough FIPS**: `02013` is Aleutians East, `02016` Aleutians
   West, `02020` Anchorage. Joined by geoid, House District 20's returns would render as
   Anchorage's. Alaska is therefore dropped at county level and blank on that map. It is
   kept at state level, where the districts tile the state and their sum is correct
   (measured 2012: 300,495, matching the official figure).
4. **A geoid can name the wrong state.** 2024 codes Kansas City as `36000` — the place
   geoid `2938000` with its state prefix lost — on a row whose `state_po` is `MO`. Five
   digits, all numeric, passes every shape test, and `36` is **New York**. Before the guard
   existed the state rollup filed 124,288 Missouri votes under New York. Two checks catch
   it: a county part of `000` is never a county, and the geoid's state prefix must match
   the row's own `state_po` (mapped from the file by majority, so no hand-kept table can
   drift).
5. **Connecticut stays on legacy counties.** The returns use the eight pre-2022 counties
   through 2024, while our boundaries from 2022 on are the nine planning regions under new
   GEOIDs. They do not nest, so **Connecticut is blank from 2022** rather than crosswalked.
   2020 and earlier join fine.

Smaller deliberate gaps: ballots belonging to no county (CT statewide write-in, ME UOCAVA,
RI federal precinct — about 3,400 votes nationally in 2020) and Kansas City's 136,645,
which Missouri reports separately from the four counties it spans. Both are dropped rather
than misattributed, the same call `crosswalk.ts` makes for Bedford city.

Oglala Lakota is published under its **retired** code `46113` in 2024 and the current
`46102` in 2016/2020; the project's existing rename table folds it, so it stays one series.

### What the numbers come out as

Reconstructed national shares against certified results:

| Year | Built (state level) | Certified |
|---|---|---|
| 2024 | 48.307% D / 49.828% R | 48.3 / 49.8 |
| 2020 | 51.254% D / 46.857% R | 51.3 / 46.8 |
| 2016 | 48.212% D / 46.167% R | 48.2 / 46.1 |

Raw totals run slightly light — 2024 sums to 155,085,264 — because MEDSL's file trails
late canvass updates in a few states (NY, CA and OH are each 100-200k short). The
**shares** are the load-bearing figures and they land within 0.03 points.

The county-level baseline differs from the state-level one in the second decimal (2024:
48.322% against 48.307%) because Alaska is absent from one and present in the other. That
is the intended behaviour, not drift: each level's 100% line is pooled from the areas that
level actually draws.

### The metrics, and the one that is missing

`presidential-votes` (count), `presidential-dem-share` and `presidential-rep-share`
(rates, aggregated from votes and totals — never by averaging county percentages, which is
rule 1's logic arriving through votes rather than medians).

A signed **margin** metric is deliberately absent. The index is `100 * area / baseline`,
which is meaningless for a quantity that crosses zero: a county at +0.1 points against a
national +1.0 would index at 10, and one at −0.1 at −10 — numbers that look like a scale
and are not one. The two shares carry the same information and both index correctly.

`presidential-votes` is a **count of ballots, not a turnout rate**. A real turnout rate
needs a citizen-voting-age denominator (the Census CVAP special tabulation), which this
project does not yet carry.

## Future sources (deferred, but the architecture leaves room)

| Source | Endpoint | Notes |
|---|---|---|
| Census CVAP special tabulation | `census.gov/programs-surveys/decennial-census/about/voting-rights/cvap.html` | Static CSVs. The missing denominator that would turn `presidential-votes` into a real turnout rate. |
| NOAA/NWS historical weather | `ncei.noaa.gov/cdo-web/api/v2` | Token required; daily summaries by station. Points, not polygons — needs interpolation to areas. |
| OpenStreetMap features | Overpass API | Heavily rate-limited; extract once at build time, never at runtime. |
| BLS employment | `api.bls.gov/publicAPI/v2` | County-level; 500 queries/day registered. |
| Zillow ZHVI | static CSV | ZIP/metro level, monthly, no key. |

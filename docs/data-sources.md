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

### Two MapLibre traps, both verified here

1. **Never gate `addSource`/`addLayer` on the `load` event.** `load` waits for the style
   *and its sources*, so a slow or blocked basemap means your own data never renders. Key
   off `styledata` instead.
2. **An inline style OBJECT never finishes loading in MapLibre 5** — `isStyleLoaded()`
   stays false forever, no layers register, and no error is raised. The byte-identical
   style passed as a *URL* loads immediately. `basemap.ts` serialises the style to a blob
   URL for this reason.

## Future sources (deferred, but the architecture leaves room)

| Source | Endpoint | Notes |
|---|---|---|
| NOAA/NWS historical weather | `ncei.noaa.gov/cdo-web/api/v2` | Token required; daily summaries by station. Points, not polygons — needs interpolation to areas. |
| OpenStreetMap features | Overpass API | Heavily rate-limited; extract once at build time, never at runtime. |
| Neighborhood boundaries | City of Columbus open data / ArcGIS REST | Columbus publishes civic-association boundaries. **No federal equivalent** — these are locally defined and do not nest inside tracts, so expect an areal-interpolation step. |
| BLS employment | `api.bls.gov/publicAPI/v2` | County-level; 500 queries/day registered. |
| Zillow ZHVI | static CSV | ZIP/metro level, monthly, no key. |

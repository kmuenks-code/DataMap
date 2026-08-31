# GeoDataProject

Interactive choropleth map of the greater Columbus, OH area. Select a metric; every area
is colored by how it ranks within the metro. A timeline scrubber shows each area's trend
**relative to the metro average**, which is pinned at 100.

## The one architectural rule

**All external API access happens at build time, in `etl/`. The browser only ever fetches
static JSON from its own origin.**

Everything else follows from this: the Census key never ships, rate limits never bind at
runtime, GitHub Pages is sufficient forever, and the site works offline once loaded.
If a change would make the browser call an external API, it is the wrong change.

## Layout

```
etl/            Build-time data pipeline (Node + tsx). Never imported by src/.
  config/       layers.json + metrics.json + regions/*.json -- the registries
  src/sources/  census/ (ACS), tiger/ (boundaries); future: osm/, noaa/
  src/transform/ normalize.ts (index math), crosswalk.ts, pack.ts (output format)
  .cache/       Raw upstream responses, content-addressed. Gitignored.
public/data/    ETL OUTPUT. Committed. This is the site's database.
  manifest.json          Fetched at startup; lists regions/metrics/years
  regions/<id>/geometry/<level>/<boundaryVintage>.topojson
  regions/<id>/metrics/<level>/<layer>/<metric>.json
src/            React + TS + MapLibre app
  data/         loaders.ts, types.ts (ETL<->app contract), useMetricData.ts (the join)
  lib/          color scales, classification, ranking, formatting
  state/        zustand store (region, geoLevel, metric, year, viewMode)
docs/           layers.md, data-sources.md, geography-notes.md, deployment.md
```

## Data taxonomy: Layer > Group > Metric

Built from `layers.json` + `metrics.json` into a tree inside `manifest.json`, which IS
the app's navigation model. Designed so hundreds of metrics stay navigable. Full detail
in `docs/layers.md`; the one distinction to keep straight:

- **Metric layers** color the map. **Mutually exclusive** -- a polygon has one fill, so
  selecting a metric replaces the current one.
- **Overlay layers** draw on top (neighborhoods, transit, parks). **Additive** -- any
  number visible at once, and they carry no index or baseline.

Layers do NOT share geographies (elections are precinct-level, not tract-level), so
`geoLevels` is per-layer and each metric records the levels it was actually built for.
The UI must handle "this metric doesn't exist at the current geo level".

Geo levels also differ in HOW they are fetched and whether they cover the region:
`censusIn` ('county' = one call per county; 'state' = one statewide call + a `restrictBy`
rule) and `tilesRegion` (false = the level leaves gaps, so rate baselines come from the
published CBSA rather than being pooled from what's on screen). See `docs/layers.md`.

## Core concept: the relative index

```
index = 100 * areaValue / metroValue     (same year, both sides)
```

The metro is 100 in every year by construction. An area drifting 130 → 118 lost ground
even if its raw dollars rose. Inflation and metro-wide shocks cancel out — the raw-dollar
view needs a CPI deflator, the index view does not.

## Non-negotiable data rules

These are correctness traps, not style preferences. Details in `docs/data-sources.md`.

1. **Never average medians.** Metro median income ≠ mean of tract medians. Medians use
   `baseline: "published"` (pull the CBSA value). Rates aggregate from numerator/denominator.
2. **Suppressed values are large negatives**, not null. Always go through `parseEstimate()`.
3. **Tract boundaries change every decade — and there are THREE eras, not two.**
   2009 = Census 2000 tracts, 2010–2019 = 2010 tracts, 2020–2024 = 2020 tracts.
   Measured consequence: only **43% of tracts** have a complete 2009–2024 series, versus
   **90% of county subdivisions** and **77% of places**. Build the timeline on county
   subdivisions until a crosswalk exists. See `etl/src/transform/crosswalk.ts`.
4. **ACS 5-year estimates overlap.** Consecutive years share sample and are not independent.
5. **Surface uncertainty, and beware small areas.** Tract MOEs are large; the ETL ships a
   CV per area/year. Measured: the largest apparent "movers" are rural townships of
   500–2,600 people — Thompson township appears to gain +124 index points on a CV of 0.29,
   which is noise, not history. Without CV shading AND some population weighting or floor,
   the map tells a story about sampling error in the rural fringe rather than about
   Columbus. This is a UI requirement, not a nicety.
6. **Batch Census variables** (≤49/call) and always fetch through the cached client.
   Variables are sorted canonically before the request: the cache key IS the request
   string, so unsorted lists make it depend on registry order, and one reordering
   silently cost 320 needless refetches.
7. **The Census API returns HTTP 200 with HTML on error** (missing/bad key, unknown
   variable). `res.ok` is not enough — check the content type. A key is now mandatory.
   The same is true of `www2.census.gov` files and the ArcGIS overlay endpoint.
8. **A place does not nest inside a county.** `for=place:*&in=state:39 county:049` is a
   400. Places are fetched statewide and filtered by the Census place/county
   relationship file; that same allowlist filters the geometry, because the TIGER place
   shapefile has no COUNTYFP field. A place GEOID is state+place (7 chars), NOT
   state+county+place — `geoidOf()` branches on `censusIn`.
9. **Places don't tile the metro.** 137 places hold 78.2% of the population; the other
   21.8% is unincorporated and blank. Never pool a rate baseline over a level with
   `tilesRegion: false` — it would redefine "100" as the incorporated-population rate.

## Adding things

- **A metric** → one entry in `etl/config/metrics.json` (tagged with `layer` + `group`),
  re-run the ETL. No app code. Dangling layer/group refs fail the build.
- **A data domain** (politics, weather, transit) → one entry in `etl/config/layers.json`
  plus a fetcher under `etl/src/sources/` emitting the standard `MetricFile`. No app code.
- **A city** → one file in `etl/config/regions/`. No app code.
- **An overlay** (neighborhoods, districts) → one `layers.json` entry with a `source`
  block pointing at an ArcGIS endpoint. No app code. Only the name field ships.
- **The 50-state view** → a region with `kind: "state"`, baseline = US. No app code.
- **A new data source** → a new dir under `etl/src/sources/` emitting the same `MetricFile`
  shape. The app never learns where a metric came from.

If adding a metric or region requires touching `src/`, the registry abstraction has leaked —
fix that instead.

## Commands

```bash
npm run dev                 # local site
npm run etl:columbus        # rebuild all Columbus data (cached; ~0 requests on re-run)
npm run etl -- --region columbus-oh --metric median-household-income
npm run build && npm run preview
```

`CENSUS_API_KEY` lives in `.env` (gitignored) — required, ETL only, deliberately *not*
`VITE_`-prefixed so Vite cannot inline it into the bundle.

## Status

**Working:** the full ETL runs end to end, with 26 passing tests over the transform core
and the place/geoid logic. `public/data/` holds 9 metrics x 16 years (2009-2024) x 3 geo
levels, plus one overlay. 2.6 MB total.
Cold build = 404 requests / ~4.5 min; any rebuild after that = 0 requests / 1.2s.
Partial runs (`--metric`, `--years`, `--geo`) splice into existing files rather than
truncating them, so incremental refresh is the normal path.
Geometry is built too: TopoJSON per boundary vintage, joins verified against the data.
**The app runs**: choropleth, layer/group/metric picker, geography switch, view-mode
toggle, year scrubber with play, per-area trend sparkline, rank/percentile detail panel,
CV-based fading, and overlay outlines with labels. Verified in-browser end to end.
**Not yet implemented:** URL state/deep links, and the tract-era crosswalk.

Verified facts (2026-08-29, live API) that override anything ACS docs may suggest:
- ACS5 is published for **2009-2024**; 2025 returns 404.
- Default geo level is **county-subdivision** (townships/cities), chosen for timeline
  integrity; tract is available and better-looking but has a broken pre-2020 series.
- **`place` is the colloquial geography** — Dublin, Upper Arlington, Hilliard on real
  annexed city limits that cut across townships and counties. ACS publishes medians per
  place for all of 2009-2024 and place FIPS are stable (Dublin = 3922694 throughout), so
  it costs 1 request/year and breaks no data rule. Its two costs are coverage (78.2%) and
  small-area noise (105 of 137 places are under 5,000 people). See `docs/geography-notes.md`.
- **Summary level 070 (`place/remainder`) publishes NO medians** — verified null — and
  needs one request per county subdivision. Evaluated and rejected; don't revisit it.
- Overlay labels are **DOM markers, not MapLibre symbol layers**: `text-field` requires a
  `glyphs` URL, i.e. runtime font fetches from a third party. Markers get no collision
  avoidance, so labels hide below zoom 9.5.
- **No basemap ships by default**: CARTO's keyless tiles now return "API KEY REQUIRED",
  and a key in a static bundle is a public key. Set `VITE_BASEMAP_TILES` to add one;
  self-hosted Protomaps is the recommended route. See `docs/data-sources.md`.
- **MapLibre 5 never loads an inline style OBJECT** (silently -- no error). It must be
  passed as a URL; `basemap.ts` uses a blob URL. Also: add layers on `styledata`, not
  `load`, or a blocked basemap stops your own data from rendering.
- **The map container is 169x0 when the map is constructed in dev.** Vite injects CSS via
  JS, so the first fitBounds is computed against a collapsed box and leaves the region a
  speck. MapView re-fits whenever `transform` size disagrees with the container's real
  size, and stops once the user pans or zooms. Production is unaffected (CSS is a
  `<link>`), but the guard covers a slow stylesheet there too.
- `B23025` (unemployment) starts **2011**. `B15003` (education) starts **2012**;
  `B15002` covers 2009-2011 if a backfill is wanted.
- MSA tract counts: **398 (2009) -> 433 (2010-2019) -> 516 (2020-2024)**.

## Open questions

- How to handle small-population noise: CV shading only, a population floor, or both?
  Nothing is decided; see rule 5.
- Pre-2012 education backfill via `B15002` is possible (verified available 2009-2011)
  but not wired up.
- Neighborhood overlays don't nest in tracts. Currently display-only, which is the
  honest default; interpolation remains unbuilt and would need its error disclosed.
- Whether to commit regenerated data (history growth) or build in CI. See `docs/deployment.md`.

## Conventions

- TypeScript strict; explicit `null` for missing data, never `0` or `NaN`.
- Comments explain *why* (especially data-quirk workarounds), not *what*.
- `src/` and `etl/` never import from each other except the type shapes in `src/data/types.ts`.
- Keep this file short. Deep detail belongs in `docs/`.

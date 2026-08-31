# Data Layers

The taxonomy is three levels: **Layer → Group → Metric**. It exists so the UI stays navigable as the metric count grows from nine into the hundreds. The tree is computed at build time and shipped inside `manifest.json`, so the client does no work to render the picker.

```
Census & Demographics        <- layer   (a data domain, tied to one provider)
  Economy                    <- group   (a subcategory within that layer)
    Median Household Income  <- metric  (a leaf; one choropleth)
    Poverty Rate
  Housing
    Median Home Value
Politics & Elections         <- another layer, its own geographies
Neighborhoods                <- an OVERLAY layer, not a metric layer
```

## Two kinds of layer, and why the distinction matters

| | `kind: "metric"` | `kind: "overlay"` |
|---|---|---|
| What it is | Choropleth data | Boundaries, points, lines drawn on top |
| Composition | **Mutually exclusive** — a polygon has one fill, so picking a metric replaces the current one | **Additive** — any number visible at once |
| Has index/baseline | Yes | No — overlays are geometry and labels, not measurements |
| Example | Median income | Neighborhood outlines, transit, parks |

Conflating the two is the mistake worth avoiding: "show me median income *and* neighborhood boundaries" is one metric layer plus one overlay, not two layers competing for the same fill. The UI should reflect that — metric layers in a single-select tree, overlays as independent checkboxes.

## Adding a layer

1. Add an entry to `etl/config/layers.json` (id, label, kind, provider, groups).
2. For a metric layer, add metrics to `etl/config/metrics.json` tagged with `layer` and `group`.
3. Add a fetcher under `etl/src/sources/<layer>/` that emits the standard `MetricFile` shape.
4. Re-run the ETL.

No app code changes. `loadMetrics()` validates every `layer`/`group` reference at build time and fails the run on a dangling one — otherwise a typo produces a file on disk that no navigation path reaches, which is far harder to notice than a crash.

Set `enabled: false` to hide a layer without deleting its registry entries. The `elections`, `weather`, and `osm-features` layers are still declared that way — they are structural placeholders proving the shape works, not stubs to be filled in blindly.

The `neighborhoods` overlay is now **live**, and it is the worked example of the overlay half of the taxonomy: one entry in `layers.json` carrying a `source` block, one generic fetcher (`etl/src/sources/arcgis/overlays.ts`), and no app code. An overlay layer declares where its geometry comes from:

```json
"source": {
  "type": "arcgis",
  "url": "https://…/MapServer/25",
  "nameField": "AREA_NAME",
  "simplify": "6%",
  "regions": ["columbus-oh"]
}
```

`regions` scopes a source to the metros it actually describes — Columbus's community boundaries mean nothing in another city, and a region without a source simply never shows the layer. Only `nameField` survives into the output: some source tables carry personal contact details, and an overlay ships nothing but a shape and a name.

## What varies per layer

**Geography.** Layers do not share geographies. Census data is tract, county-subdivision and place; election returns are precincts, which do not nest inside tracts and are redrawn frequently. Hence `geoLevels` is a per-layer field, and each metric records the levels it was actually built for. The UI must handle "this metric does not exist at the current level" — grey it out, or offer to switch level.

**How a level is fetched.** Not every geography nests the same way, and the registry has to say which. `censusIn: "county"` (the default) means one request per county; `censusIn: "state"` means one statewide request plus a `restrictBy` rule to cut it back to the region. Places need the latter, because a place is not inside a county. A level that fetches statewide without declaring `restrictBy` throws rather than quietly mapping the whole state.

**Whether a level covers the region.** `tilesRegion: false` marks a level whose areas leave gaps — places miss 22% of the metro's population. It changes two things: rate baselines come from the published CBSA figures instead of being pooled from the areas on screen, and the UI shows the level's `note` so blank ground does not read as missing data.

**Cadence.** ACS is annual, elections biennial, weather daily. The timeline should reflect the metric's real years (`metric.years`), never a global range.

**Shape of the source.** Weather arrives as station *points*, not polygons, so it needs interpolation onto areas before it can be a choropleth — and that interpolation is an estimate that has to be disclosed. Not every dataset is choropleth-ready.

**Licensing.** Census is public domain; OSM is ODbL (requires attribution); municipal open data is often unspecified. Each layer carries `provider.attribution`, and the map must display it for every visible layer.

## File layout

Metric files are namespaced by layer, because two sources may both publish something called `population`:

```
public/data/regions/<region>/metrics/<geoLevel>/<layer>/<metric>.json
public/data/regions/<region>/geometry/<geoLevel>/<boundaryVintage>.topojson
public/data/regions/<region>/overlays/<layer>.topojson
```

Overlay files carry **no vintage** in the path. Metrics need geometry per boundary vintage because census areas are redrawn each decade and the year decides which polygons are correct; an overlay has no time dimension at all, so one file serves every year.

Geometry is keyed by **boundary vintage, not by level**, since census areas are redrawn each decade. `geometryVintageFor(level, year)` in `src/data/types.ts` picks the newest vintage not postdating the selected year. Drawing 2020 polygons under 2012 data is exactly the silent-wrong-map failure this prevents.

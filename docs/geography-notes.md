# Geography Notes

## Choosing the area unit

| Level | Count (Columbus MSA) | Stable across decades? | Good for |
|---|---|---|---|
| County | 10 | ✅ yes | Too coarse for a city map |
| **County subdivision** (township/city) | ~180 | ✅ largely | **Best first target for the 15-year timeline** |
| Census tract | ~570 | ❌ redrawn each decade | Best resolution; needs a crosswalk for long series |
| Block group | ~1,700 | ❌ | MOEs too large to be meaningful |
| ZCTA (ZIP) | ~190 | ⚠️ shifts | Intuitive to users, but ZIPs are mail routes, not places |
| Place (municipality) | ~80 | ✅ | Doesn't tile the metro — gaps between cities |

**Recommended path:** build the tract view first because it is the visually compelling one, but wire the timeline on county subdivisions, which need no crosswalk. Both are just entries in `geoLevels`.

## Nesting

`state (2) → county (3) → tract (6) → block group (1)` — a tract GEOID is `39049001100`: state 39, county 049, tract 001100. County subdivisions nest in counties but tracts do **not** nest in county subdivisions, so those two levels are alternative views, not a drill-down hierarchy.

## "Neighborhoods"

There is no federal neighborhood geography. Columbus civic-association boundaries come from city open data and do not align to tracts. Mapping a metric to them requires areal or population-weighted interpolation with its own error. Treat it as a display-only overlay initially — label the map without recomputing statistics onto it.

## Scaling to states

The national/state view is the same pipeline with different config: `geoLevel: state`, `for=state:*` with no `in` clause, `cb_YYYY_us_state_20m` geometry, and the baseline becoming the US value rather than a metro's. It is a new region entry, not new code — which is the reason for the registry design.

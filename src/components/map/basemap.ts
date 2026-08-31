import type { StyleSpecification } from 'maplibre-gl';

/**
 * A locally-defined style with NO third-party dependency by default.
 *
 * Two things forced this, both learned the hard way:
 *
 * 1. Pointing MapLibre at a remote style URL makes OUR data hostage to THEIR
 *    availability. Every addSource/addLayer is gated on the `load` event, and
 *    `load` waits for the style AND its sources -- so a slow or blocked basemap
 *    means the choropleth never draws at all, despite the data being in memory.
 *    (MapView keys off `styledata` for the same reason.)
 *
 * 2. CARTO's free basemap tiles now return "API KEY REQUIRED" images. Any
 *    keyless third-party tile service can do this at any time, and a key in a
 *    static client bundle is a public key -- the thing this project's whole
 *    build-time-ETL architecture exists to avoid.
 *
 * So the default is no basemap: areas are drawn on a plain background, with
 * identification handled by hover and the detail panel. For a choropleth of
 * ~180 townships that reads perfectly well, and it works offline and forever.
 *
 * To add street context, set VITE_BASEMAP_TILES to a raster tile URL template
 * (and VITE_BASEMAP_ATTRIBUTION). Self-hosted Protomaps is the recommended
 * upgrade -- a single .pmtiles file served from the same origin, keyless and
 * dependency-free. See docs/data-sources.md.
 */

const TILES = import.meta.env['VITE_BASEMAP_TILES'] as string | undefined;
const ATTRIBUTION =
  (import.meta.env['VITE_BASEMAP_ATTRIBUTION'] as string | undefined) ??
  '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> contributors';

export const hasBasemap = Boolean(TILES);

/**
 * Hand the style to MapLibre as a URL, not as an object.
 *
 * Verified in MapLibre 5: an inline style OBJECT never finishes loading --
 * `isStyleLoaded()` stays false forever and no layers are ever registered, with
 * no error raised. The byte-identical style passed as a URL loads immediately.
 * Serialising to a blob URL keeps the style fully local (no network, no third
 * party) while using the code path that actually works.
 *
 * Callers must revoke the URL when the map is destroyed.
 */
export function basemapStyleUrl(): string {
  return URL.createObjectURL(
    new Blob([JSON.stringify(basemapStyle())], { type: 'application/json' }),
  );
}

export function basemapStyle(): StyleSpecification {
  const sources: StyleSpecification['sources'] = {};
  const layers: StyleSpecification['layers'] = [
    { id: 'background', type: 'background', paint: { 'background-color': '#eef2f6' } },
  ];

  if (TILES) {
    sources['basemap'] = {
      type: 'raster',
      tiles: [TILES],
      tileSize: 256,
      maxzoom: 19,
      attribution: ATTRIBUTION,
    };
    layers.push({
      id: 'basemap',
      type: 'raster',
      source: 'basemap',
      paint: { 'raster-opacity': 0.85 },
    });
  }

  return { version: 8, sources, layers };
}

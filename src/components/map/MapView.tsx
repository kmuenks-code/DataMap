import { useCallback, useEffect, useRef } from 'react';
import maplibregl, { type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { useMetricData, type MapFeatureProps } from '../../data/useMetricData.ts';
import { useOverlayData } from '../../data/useOverlayData.ts';
import { basemapStyleUrl, hasBasemap } from './basemap.ts';
import {
  divergingBreaks,
  quantileBreaks,
  rampFor,
  toStepExpression,
} from '../../lib/color/scales.ts';
import { useAppStore } from '../../state/useAppStore.ts';

const SOURCE = 'areas';
const overlaySource = (id: string) => `overlay-${id}`;

/**
 * Below this, 41 neighbourhood labels collide into an unreadable mat. The
 * outlines stay drawn -- only the text is withheld.
 */
const LABEL_MIN_ZOOM = 9.5;

export function MapView() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);

  const region = useAppStore((s) => s.region());
  const viewMode = useAppStore((s) => s.viewMode);
  const hideUnreliable = useAppStore((s) => s.hideUnreliable);
  const setHovered = useAppStore((s) => s.setHovered);
  const setSelected = useAppStore((s) => s.setSelected);
  const selectedGeoid = useAppStore((s) => s.selectedGeoid);

  const { collection } = useMetricData();
  const overlays = useAppStore((s) => s.overlays);
  const overlayData = useOverlayData();

  /**
   * Latest render inputs, held in a ref.
   *
   * Map setup and data arrival race in both directions, and event-based
   * coordination proved unreliable: `load` waits on basemap tiles, and a
   * one-shot `idle` handler can wait forever on a map with nothing left to
   * load. Instead both paths call the same apply(), which no-ops until the
   * source exists. Whichever finishes last paints, and it is idempotent.
   */
  // apply() is a stable callback with no deps -- it reads everything it needs
  // through this ref so that re-rendering never re-registers map listeners.
  // fitBounds rides along for the same reason: reading `region` from the
  // closure would capture the null it held on the first render.
  const pending = useRef({ collection, viewMode, hideUnreliable, fitBounds: region?.fitBounds });
  pending.current = { collection, viewMode, hideUnreliable, fitBounds: region?.fitBounds };

  const pendingOverlays = useRef({ overlays, overlayData });
  pendingOverlays.current = { overlays, overlayData };

  /** Overlay ids currently on the map, so removals can be diffed against them. */
  const mounted = useRef<Set<string>>(new Set());
  /**
   * Labels are HTML markers, not a MapLibre symbol layer.
   *
   * A symbol layer needs a `glyphs` URL, which means fetching PBF font ranges
   * from a third-party server at runtime -- precisely the dependency this
   * project's build-time-ETL architecture exists to avoid, and it would break
   * the offline guarantee. DOM markers need no glyphs, no network and no
   * basemap. See basemap.ts.
   */
  const labels = useRef<maplibregl.Marker[]>([]);

  /** Fit once per region/level, not on every year change (which would fight the user's panning). */
  const fitted = useRef<string | null>(null);
  /** Once the user pans or zooms, stop re-fitting: the view is theirs. */
  const userMoved = useRef(false);

  /**
   * Switching region is the one case where the user's view must be overridden.
   * Their panning was of a different place -- keeping it would leave Columbus's
   * viewport pointed at Ohio while the national map loads underneath, or the
   * reverse. Both refs reset so the next collection fits from scratch.
   */
  const lastRegion = useRef<string | null>(null);
  if (region && lastRegion.current !== region.id) {
    lastRegion.current = region.id;
    userMoved.current = false;
    fitted.current = null;
  }
  const lastBounds = useRef<[number, number, number, number] | null>(null);

  const apply = useCallback(() => {
    const m = map.current;
    if (!m) return;
    const src = m.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
    const { collection: fc, viewMode: mode, hideUnreliable: fade, fitBounds } = pending.current;
    if (!src || !fc) return;

    src.setData(fc as GeoJSON.FeatureCollection);

    // Fit to the data rather than trusting a hand-tuned center/zoom. The config
    // values cannot be right for every region, and this is what makes adding a
    // new city a config-only change.
    //
    // The exception is geometry that crosses the antimeridian, where the
    // bounding box is not merely imperfect but false: Alaska's Aleutians run
    // from -178.9 to +179.8, so the national collection measures 358.6 degrees
    // wide and fitting it zooms out to the whole globe. A region may therefore
    // declare fitBounds, which is trusted over the computed box.
    const key = `${fc.features.length}`;
    const usable = m.getContainer().clientHeight > 0;
    if (usable && fitted.current !== key && fc.features.length > 0) {
      const b = fitBounds ?? bounds(fc);
      if (b) {
        lastBounds.current = b;
        fitToBounds(m, b);
        fitted.current = key;
      }
    }

    const field = mode === 'index' ? 'index' : 'value';
    const values = fc.features
      .map((f) => (mode === 'index' ? f.properties.index : f.properties.value))
      .filter((v): v is number => v != null);
    if (values.length === 0) return;

    const ramp = rampFor(mode === 'index' ? 'index' : 'raw');
    const breaks = mode === 'index' ? divergingBreaks(values) : quantileBreaks(values, ramp.length);

    // Breaks are recomputed from the CURRENT year so every year stays legible;
    // the legend shows the scale, keeping the rescaling visible to the reader.
    m.setPaintProperty('areas-fill', 'fill-color', [
      'case',
      ['==', ['get', field], null],
      '#e5e7eb',
      ['step', ['to-number', ['get', field]], ...toStepExpression(ramp, breaks)],
    ] as unknown as maplibregl.ExpressionSpecification);

    // Imprecise estimates are faded, never hidden: showing WHERE the data is
    // thin is more useful than silently dropping those areas.
    m.setPaintProperty('areas-fill', 'fill-opacity', [
      'case',
      ['==', ['get', 'value'], null],
      0.25,
      ['>', ['coalesce', ['get', 'cv'], 0], 0.15],
      fade ? 0.15 : 0.45,
      0.82,
    ] as unknown as maplibregl.ExpressionSpecification);
  }, []);

  /**
   * Sync overlay outlines and labels to the map.
   *
   * Idempotent and driven off a ref, for the same reason apply() is: map setup
   * and file arrival race in both directions, so both paths call this and
   * whichever lands last wins.
   */
  const applyOverlays = useCallback(() => {
    const m = map.current;
    if (!m || !m.isStyleLoaded()) return;
    const { overlays: visible, overlayData: data } = pendingOverlays.current;

    // Only overlays whose file has actually arrived; a checked-but-unloaded
    // layer simply appears a moment later.
    const wanted = new Set([...visible].filter((id) => data.has(id)));

    for (const id of [...mounted.current]) {
      if (wanted.has(id)) continue;
      if (m.getLayer(`${overlaySource(id)}-line`)) m.removeLayer(`${overlaySource(id)}-line`);
      if (m.getSource(overlaySource(id))) m.removeSource(overlaySource(id));
      mounted.current.delete(id);
    }

    for (const id of wanted) {
      const fc = data.get(id)!;
      const srcId = overlaySource(id);
      const existing = m.getSource(srcId) as maplibregl.GeoJSONSource | undefined;
      if (existing) {
        existing.setData(fc as GeoJSON.FeatureCollection);
        continue;
      }
      m.addSource(srcId, { type: 'geojson', data: fc as GeoJSON.FeatureCollection });
      m.addLayer(
        {
          id: `${srcId}-line`,
          type: 'line',
          source: srcId,
          paint: {
            // Darker and heavier than the area borders underneath: an overlay
            // has to read as a different KIND of line, not a stronger one.
            'line-color': '#1f2937',
            'line-width': 1.6,
            'line-opacity': 0.75,
            'line-dasharray': [3, 2],
          },
        },
        // Under the selection outline, so clicking an area still stands out.
        m.getLayer('areas-selected') ? 'areas-selected' : undefined,
      );
      mounted.current.add(id);
    }

    for (const marker of labels.current) marker.remove();
    labels.current = [];
    for (const id of wanted) {
      for (const f of data.get(id)!.features) {
        const at = centroid(f.geometry);
        const name = f.properties?.name;
        if (!at || !name) continue;
        const el = document.createElement('div');
        el.className = 'overlay-label';
        el.textContent = name;
        labels.current.push(new maplibregl.Marker({ element: el }).setLngLat(at).addTo(m));
      }
    }
    updateLabelVisibility(m);
  }, []);

  useEffect(() => {
    if (!container.current || map.current || !region) return;

    const styleUrl = basemapStyleUrl();
    const m = new maplibregl.Map({
      container: container.current,
      style: styleUrl,
      center: region.center,
      zoom: region.zoom,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    const addLayers = () => {
      if (!m.isStyleLoaded() || m.getSource(SOURCE)) return;

      m.addSource(SOURCE, { type: 'geojson', data: emptyCollection(), promoteId: 'geoid' });
      m.addLayer({
        id: 'areas-fill',
        type: 'fill',
        source: SOURCE,
        paint: { 'fill-color': '#e5e7eb', 'fill-opacity': 0.8 },
      });
      m.addLayer({
        id: 'areas-line',
        type: 'line',
        source: SOURCE,
        paint: {
          'line-color': hasBasemap ? '#ffffff' : '#94a3b8',
          'line-width': hasBasemap ? 0.5 : 0.6,
          'line-opacity': hasBasemap ? 0.6 : 0.9,
        },
      });
      m.addLayer({
        id: 'areas-selected',
        type: 'line',
        source: SOURCE,
        paint: { 'line-color': '#111827', 'line-width': 2.5 },
        filter: ['==', ['get', 'geoid'], ''],
      });

      apply(); // data may already have arrived
      applyOverlays(); // ditto -- an overlay may have loaded before the style did
    };

    // `styledata`, not `load`: load waits for the style AND its sources, so a
    // slow or blocked basemap would stop our own data from ever being added.
    m.on('styledata', addLayers);
    addLayers();

    // Labels are DOM nodes with no zoom awareness of their own, so their
    // visibility has to be driven explicitly.
    m.on('zoom', () => updateLabelVisibility(m));

    m.on('mousemove', 'areas-fill', (e) => {
      const f = e.features?.[0] as MapGeoJSONFeature | undefined;
      m.getCanvas().style.cursor = f ? 'pointer' : '';
      setHovered((f?.properties as MapFeatureProps | undefined)?.geoid ?? null);
    });
    m.on('mouseleave', 'areas-fill', () => {
      m.getCanvas().style.cursor = '';
      setHovered(null);
    });
    m.on('click', 'areas-fill', (e) => {
      const f = e.features?.[0] as MapGeoJSONFeature | undefined;
      const geoid = (f?.properties as MapFeatureProps | undefined)?.geoid ?? null;
      setSelected(useAppStore.getState().selectedGeoid === geoid ? null : geoid);
    });

    map.current = m;
    if (import.meta.env.DEV) (window as unknown as { __map?: maplibregl.Map }).__map = m;

    // MapLibre sizes itself from the container at construction time. The
    // sidebar and timeline settle after that, so without this the first fit is
    // computed against a stale size and the region lands off-centre.
    m.on('dragstart', () => (userMoved.current = true));
    m.on('zoomstart', () => (userMoved.current = true));

    /**
     * Re-fit until the user takes over.
     *
     * The map is constructed before the stylesheet applies (Vite injects CSS
     * via JS in dev; a slow stylesheet does the same in production), so the
     * container is briefly 169x0 and any fit computed then is wrong. An
     * earlier version only re-fit when the container size disagreed with the
     * map's cached size -- but once those agree the guard blocks correction
     * forever, freezing whatever bad fit landed first. Re-fitting
     * unconditionally is cheap, converges, and stops the moment the user pans
     * or zooms.
     */
    const maybeRefit = () => {
      const el = m.getContainer();
      if (el.clientHeight === 0 || userMoved.current || !lastBounds.current) return;
      fitToBounds(m, lastBounds.current);
    };

    const ro = new ResizeObserver(maybeRefit);
    ro.observe(container.current);

    // Safety net for the case where the container never changes size after the
    // stylesheet lands, so the observer has nothing to report.
    const settle = setTimeout(maybeRefit, 300);

    return () => {
      clearTimeout(settle);
      ro.disconnect();
      for (const marker of labels.current) marker.remove();
      labels.current = [];
      mounted.current.clear();
      m.remove();
      URL.revokeObjectURL(styleUrl);
      map.current = null;
    };
  }, [region, setHovered, setSelected, apply, applyOverlays]);

  useEffect(apply, [collection, viewMode, hideUnreliable, apply]);
  useEffect(applyOverlays, [overlays, overlayData, applyOverlays]);

  useEffect(() => {
    const m = map.current;
    if (!m?.getLayer('areas-selected')) return;
    m.setFilter('areas-selected', ['==', ['get', 'geoid'], selectedGeoid ?? '']);
  }, [selectedGeoid]);

  return <div ref={container} className="map" />;
}

function fitToBounds(m: maplibregl.Map, b: [number, number, number, number]): void {
  // resize() first. MapLibre caches the container size in its transform, and at
  // first paint that value predates the stylesheet, so fitting against it is
  // computed for the wrong box.
  m.resize();

  // Padding scales with the container. The timeline overlays the bottom of the
  // map, so it needs clearance -- but a flat 110px eats a quarter of a short
  // mobile viewport, leaving the region tiny.
  const h = m.getContainer().clientHeight || 1;
  const w = m.getContainer().clientWidth || 1;
  const side = Math.min(40, w * 0.06);
  m.fitBounds(b, {
    padding: {
      top: Math.min(40, h * 0.06),
      right: side,
      left: side,
      bottom: Math.min(110, h * 0.2),
    },
    duration: 0,
  });
}

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/** Bounding box of every coordinate in the collection, walked without a dependency. */
function bounds(fc: { features: { geometry: GeoJSON.Geometry }[] }): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const [x, y] = coords as [number, number];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }
    for (const c of coords) visit(c);
  };

  for (const f of fc.features) {
    if (f.geometry && 'coordinates' in f.geometry) visit(f.geometry.coordinates);
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

function updateLabelVisibility(m: maplibregl.Map): void {
  const show = m.getZoom() >= LABEL_MIN_ZOOM;
  for (const el of m.getContainer().querySelectorAll<HTMLElement>('.overlay-label')) {
    el.style.display = show ? '' : 'none';
  }
}

/**
 * A representative interior point for a label.
 *
 * Uses the area-weighted centroid of the LARGEST ring, not of all coordinates.
 * Several Columbus communities are one big lobe plus a thin strip along a
 * river; averaging every vertex drags the label into the strip, and averaging
 * across a MultiPolygon's parts can put it between them, on ground the shape
 * does not occupy.
 */
function centroid(geometry: GeoJSON.Geometry): [number, number] | null {
  const rings: [number, number][][] =
    geometry.type === 'Polygon'
      ? [geometry.coordinates[0] as [number, number][]]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates.map((poly) => poly[0] as [number, number][])
        : [];

  let best: [number, number][] | null = null;
  let bestArea = 0;
  for (const ring of rings) {
    const a = Math.abs(signedArea(ring));
    if (a > bestArea) {
      bestArea = a;
      best = ring;
    }
  }
  if (!best || best.length < 3) return null;

  const a = signedArea(best);
  // A degenerate ring (zero area) has no meaningful centroid; fall back to a
  // vertex rather than dividing by zero.
  if (a === 0) return best[0] ?? null;

  let x = 0;
  let y = 0;
  for (let i = 0; i < best.length - 1; i++) {
    const [x0, y0] = best[i]!;
    const [x1, y1] = best[i + 1]!;
    const cross = x0 * y1 - x1 * y0;
    x += (x0 + x1) * cross;
    y += (y0 + y1) * cross;
  }
  return [x / (6 * a), y / (6 * a)];
}

function signedArea(ring: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[i + 1]!;
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

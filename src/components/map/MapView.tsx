import { useCallback, useEffect, useRef } from 'react';
import maplibregl, { type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { useMetricData, type MapFeatureProps } from '../../data/useMetricData.ts';
import { basemapStyleUrl, hasBasemap } from './basemap.ts';
import {
  divergingBreaks,
  quantileBreaks,
  rampFor,
  toStepExpression,
} from '../../lib/color/scales.ts';
import { useAppStore } from '../../state/useAppStore.ts';

const SOURCE = 'areas';

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

  /**
   * Latest render inputs, held in a ref.
   *
   * Map setup and data arrival race in both directions, and event-based
   * coordination proved unreliable: `load` waits on basemap tiles, and a
   * one-shot `idle` handler can wait forever on a map with nothing left to
   * load. Instead both paths call the same apply(), which no-ops until the
   * source exists. Whichever finishes last paints, and it is idempotent.
   */
  const pending = useRef({ collection, viewMode, hideUnreliable });
  pending.current = { collection, viewMode, hideUnreliable };

  /** Fit once per region/level, not on every year change (which would fight the user's panning). */
  const fitted = useRef<string | null>(null);
  /** Once the user pans or zooms, stop re-fitting: the view is theirs. */
  const userMoved = useRef(false);
  const lastBounds = useRef<[number, number, number, number] | null>(null);

  const apply = useCallback(() => {
    const m = map.current;
    if (!m) return;
    const src = m.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
    const { collection: fc, viewMode: mode, hideUnreliable: fade } = pending.current;
    if (!src || !fc) return;

    src.setData(fc as GeoJSON.FeatureCollection);

    // Fit to the data rather than trusting a hand-tuned center/zoom. The config
    // values cannot be right for every region, and this is what makes adding a
    // new city a config-only change.
    const key = `${fc.features.length}`;
    const usable = m.getContainer().clientHeight > 0;
    if (usable && fitted.current !== key && fc.features.length > 0) {
      const b = bounds(fc);
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
    };

    // `styledata`, not `load`: load waits for the style AND its sources, so a
    // slow or blocked basemap would stop our own data from ever being added.
    m.on('styledata', addLayers);
    addLayers();

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
     * Re-fit whenever the container's real size no longer matches what the map
     * thinks it is.
     *
     * The map is constructed before the stylesheet applies (Vite injects CSS
     * via JS in dev, and a slow stylesheet does the same in production), so the
     * container is briefly 169x0 and the first fit is computed against a
     * collapsed box -- leaving the region as a speck in the middle of the map.
     * Comparing sizes rather than trusting a single event catches every case,
     * and stops once the user takes control of the view.
     */
    const maybeRefit = () => {
      const el = m.getContainer();
      const stale = m.transform.width !== el.clientWidth || m.transform.height !== el.clientHeight;
      if (!stale || el.clientHeight === 0) return;
      m.resize();
      if (!userMoved.current && lastBounds.current) fitToBounds(m, lastBounds.current);
    };
    m.on('render', maybeRefit);

    // Re-fit after a resize, not just resize(). The first fit runs while the
    // sidebar and timeline are still settling, so it is computed against a
    // stale container size and the region lands off-centre. Stops as soon as
    // the user pans or zooms -- after that the view belongs to them.
    const ro = new ResizeObserver(maybeRefit);
    ro.observe(container.current);

    return () => {
      ro.disconnect();
      m.remove();
      URL.revokeObjectURL(styleUrl);
      map.current = null;
    };
  }, [region, setHovered, setSelected, apply]);

  useEffect(apply, [collection, viewMode, hideUnreliable, apply]);

  useEffect(() => {
    const m = map.current;
    if (!m?.getLayer('areas-selected')) return;
    m.setFilter('areas-selected', ['==', ['get', 'geoid'], selectedGeoid ?? '']);
  }, [selectedGeoid]);

  return <div ref={container} className="map" />;
}

function fitToBounds(m: maplibregl.Map, b: [number, number, number, number]): void {
  const fit = () => {
    // resize() first, every time. MapLibre caches the container size in its
    // transform; at first paint that value predates the flex layout settling,
    // so fitting against it zooms out too far. There is no event for "layout
    // finished", and the container never changes size afterwards, so nothing
    // would ever correct it.
    m.resize();
    m.fitBounds(b, { padding: { top: 40, right: 40, bottom: 110, left: 40 }, duration: 0 });
  };

  fit();
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

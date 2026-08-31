import type { Manifest, MetricFile } from './types.ts';

/**
 * All data is static JSON under the site's own origin -- no API keys, no CORS,
 * no runtime quota. `BASE_URL` keeps paths correct under a GitHub Pages
 * project subpath (/DataMap/) and at a bare custom domain alike.
 */
const base = import.meta.env.BASE_URL;

const memo = new Map<string, Promise<unknown>>();

function loadJson<T>(path: string): Promise<T> {
  const url = `${base}data/${path}`.replace(/([^:]\/)\/+/g, '$1');
  let hit = memo.get(url) as Promise<T> | undefined;
  if (!hit) {
    hit = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
      return r.json() as Promise<T>;
    });
    // Don't cache a rejection: a transient network failure would otherwise
    // poison this path for the rest of the session.
    hit.catch(() => memo.delete(url));
    memo.set(url, hit);
  }
  return hit;
}

export const loadManifest = () => loadJson<Manifest>('manifest.json');

/**
 * Metric files are layer-namespaced, because two sources may both publish a
 * metric called "population" and the path is what keeps them apart.
 */
export const loadMetric = (region: string, geoLevel: string, layer: string, metric: string) =>
  loadJson<MetricFile>(`regions/${region}/metrics/${geoLevel}/${layer}/${metric}.json`);

/**
 * Geometry is per boundary vintage, not per level: census areas are redrawn
 * each decade, so the year being viewed decides which polygons are correct.
 * Use geometryVintageFor() to pick. Convert with topojson-client feature().
 */
export const loadGeometry = (region: string, geoLevel: string, vintage: number) =>
  loadJson<unknown>(`regions/${region}/geometry/${geoLevel}/${vintage}.topojson`);

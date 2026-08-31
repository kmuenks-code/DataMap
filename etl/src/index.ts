/**
 * ETL entry point.
 *
 *   npm run etl:columbus                                  # geometry + metrics
 *   npm run etl -- --only geometry                        # boundaries only
 *   npm run etl -- --only metrics                         # skip the geometry step
 *   npm run etl -- --region columbus-oh --metric median-household-income
 *   npm run etl -- --region columbus-oh --years 2019,2024
 *   npm run etl -- --region columbus-oh --geo county-subdivision
 *
 * Writes to public/data/. Output IS committed to git -- it is the site's
 * database, and GitHub Pages serves it as static files.
 */
import { parseArgs } from 'node:util';
import { loadEnv } from './util/env.ts';

loadEnv(); // must precede any import that reads process.env.CENSUS_API_KEY

const { values } = parseArgs({
  options: {
    region: { type: 'string', default: 'columbus-oh' },
    metric: { type: 'string', multiple: true },
    geo: { type: 'string', multiple: true },
    years: { type: 'string' },
    only: { type: 'string' }, // 'geometry' | 'metrics'
  },
});

const years = values.years
  ?.split(',')
  .map((y) => Number(y.trim()))
  .filter(Number.isFinite);

const started = Date.now();

if (values.only !== 'metrics') {
  const { loadLayers, loadRegion } = await import('./config.ts');
  const { buildGeometry } = await import('./sources/tiger/geometry.ts');
  const { buildOverlays } = await import('./sources/arcgis/overlays.ts');
  const region = await loadRegion(values.region!);
  // One file per boundary vintage: tracts are redrawn each decade, so no single
  // geometry file can serve 2009-2024. See sources/tiger/geometry.ts.
  await buildGeometry(region, [2020, 2010]);
  // Overlays are geometry too, but carry no data and no vintage -- see
  // sources/arcgis/overlays.ts.
  await buildOverlays(region, await loadLayers());
}

if (values.only !== 'geometry') {
  const { runPipeline } = await import('./pipeline.ts');
  await runPipeline({
    region: values.region!,
    metrics: values.metric,
    geoLevels: values.geo,
    years,
  });
}
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

import type { MetricFile } from './pack.ts';

/**
 * Merge a freshly-built MetricFile into whatever is already on disk.
 *
 * Without this, `--years 2024` rewrites the file with ONLY 2024 and silently
 * destroys the other fifteen years. That makes partial runs actively dangerous
 * and forces a full rebuild for every small change.
 *
 * Merging also makes incremental refresh the natural path: when a new ACS
 * vintage lands, `--years <new>` fetches one year and splices it in.
 *
 * The geoid axis is re-unioned across both files, because a partial run sees a
 * smaller geoid universe (fewer years -> fewer boundary eras). Rows are
 * remapped onto the union, so an area absent from one side becomes null rather
 * than shifting every value one column over -- which is the failure mode that
 * would produce a plausible-looking but completely wrong map.
 */
export function mergeMetricFile(incoming: MetricFile, existing: MetricFile | null): MetricFile {
  if (!existing || existing.schema !== incoming.schema || existing.metric !== incoming.metric) {
    return incoming;
  }

  const geoids = [...new Set([...existing.geoids, ...incoming.geoids])].sort();
  const years = [...new Set([...existing.years, ...incoming.years])].sort((a, b) => a - b);

  const idx = (f: MetricFile) => new Map(f.geoids.map((g, i) => [g, i]));
  const existingIdx = idx(existing);
  const incomingIdx = idx(incoming);

  // Incoming wins for any year it covers; existing supplies the rest.
  const sourceFor = (year: number) =>
    incoming.years.includes(year)
      ? ({ file: incoming, map: incomingIdx, row: incoming.years.indexOf(year) } as const)
      : ({ file: existing, map: existingIdx, row: existing.years.indexOf(year) } as const);

  const remap = (
    field: 'values' | 'index' | 'cv',
  ): (number | null)[][] | undefined => {
    if (field === 'cv' && !existing.cv && !incoming.cv) return undefined;
    return years.map((year) => {
      const { file, map, row } = sourceFor(year);
      const data = file[field]?.[row];
      if (!data) return geoids.map(() => null);
      return geoids.map((g) => {
        const i = map.get(g);
        return i === undefined ? null : (data[i] ?? null);
      });
    });
  };

  const names = geoids.map((g) => {
    const i = incomingIdx.get(g);
    if (i !== undefined) return incoming.names[i]!;
    const j = existingIdx.get(g);
    return j !== undefined ? existing.names[j]! : g;
  });

  return {
    ...incoming,
    years,
    geoids,
    names,
    baseline: years.map((year) => {
      const { file, row } = sourceFor(year);
      return file.baseline[row] ?? null;
    }),
    values: remap('values')!,
    index: remap('index')!,
    ...(remap('cv') ? { cv: remap('cv') } : {}),
    meta: {
      ...incoming.meta,
      boundaryVintageByYear: {
        ...existing.meta.boundaryVintageByYear,
        ...incoming.meta.boundaryVintageByYear,
      },
    },
  };
}

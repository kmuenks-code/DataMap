import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..."
// which join() then turns into the nonexistent "C:\C:\...".
const ROOT = fileURLToPath(new URL('../../.cache/', import.meta.url));

/**
 * Content-addressed disk cache for raw upstream responses.
 *
 * This is the single most important piece for staying inside API limits: the
 * Census API is immutable for a published vintage, so a given (year, dataset,
 * variables, geography) tuple only ever needs to be fetched ONCE, forever.
 * Re-running the ETL after a config tweak costs zero requests.
 *
 * The cache is gitignored (large, regenerable). CI restores it from
 * actions/cache so scheduled refreshes only fetch genuinely new vintages.
 */
export async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
  const path = join(ROOT, hash.slice(0, 2), `${hash}.json`);

  try {
    const hit = await readFile(path, 'utf8');
    return JSON.parse(hit).body as T;
  } catch {
    /* miss */
  }

  const body = await fetcher();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ key, fetchedAt: new Date().toISOString(), body }));
  return body;
}

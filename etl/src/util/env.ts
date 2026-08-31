import { readFileSync } from 'node:fs';

/**
 * Minimal .env loader. Node 22 has --env-file, but relying on it would mean
 * every invocation needs the flag; doing it here keeps `npm run etl` working
 * as-is and keeps CI (where vars come from the real environment) untouched.
 * Existing environment variables always win.
 */
export function loadEnv(path = new URL('../../../.env', import.meta.url)): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // no .env -- fine in CI
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
}

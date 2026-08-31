import { cached } from '../../util/cache.ts';
import { createLimiter } from '../../util/limiter.ts';

const BASE = 'https://api.census.gov/data';
const KEY = process.env.CENSUS_API_KEY ?? '';
const limit = createLimiter(Number(process.env.ETL_RATE_LIMIT_RPS ?? 8));

export interface CensusQuery {
  /** e.g. 2023 */
  year: number;
  /** e.g. "acs/acs5" */
  dataset: string;
  /** Variable names. NAME is added automatically. Census caps this at 50 per call. */
  get: string[];
  /** e.g. "tract:*" */
  forClause: string;
  /** e.g. { state: "39", county: "049" } */
  inClause?: Record<string, string>;
}

/** Census hard-caps `get=` at 50 variables per request. */
export const MAX_VARS_PER_CALL = 49; // 49 + NAME

function requireKey(): string {
  if (KEY) return KEY;
  throw new Error(
    '[census] CENSUS_API_KEY is required.\n' +
      'The API no longer serves unkeyed requests, and it fails in a hostile way: it\n' +
      'returns HTTP 200 with an HTML "Missing Key" page, so res.ok is true and only\n' +
      'JSON.parse gives it away. Failing loudly here beats debugging that downstream.\n' +
      'Free key, issued instantly: https://api.census.gov/data/key_signup.html',
  );
}

/**
 * Fetch one ACS table slice as an array of row objects.
 *
 * Every call is rate-limited AND disk-cached. Published ACS vintages are
 * immutable, so a cache hit is always as correct as a live fetch.
 */
export async function fetchCensus(q: CensusQuery): Promise<Record<string, string>[]> {
  if (q.get.length > MAX_VARS_PER_CALL) {
    throw new Error(`Too many variables (${q.get.length}); chunk to ${MAX_VARS_PER_CALL}.`);
  }

  // Sort variables canonically before building the request.
  //
  // The cache key is the request string, so an unsorted list makes the key
  // depend on registry ORDER: reordering metrics.json, or changing how the
  // pipeline sorts metrics, silently invalidates the entire cache and re-fetches
  // everything. (Measured: one reordering cost 320 needless requests.)
  // Column order carries no meaning -- responses are joined by header name.
  const params = new URLSearchParams();
  params.set('get', ['NAME', ...[...q.get].sort()].join(','));
  params.set('for', q.forClause);
  if (q.inClause) {
    params.set(
      'in',
      Object.entries(q.inClause)
        .map(([k, v]) => `${k}:${v}`)
        .join(' '),
    );
  }

  // Cache key deliberately EXCLUDES the API key, so the cache stays portable
  // between machines and no secret is ever written to disk.
  const cacheKey = `${q.year}/${q.dataset}?${params.toString()}`;

  return cached(cacheKey, async () => {
    const withKey = new URLSearchParams(params);
    withKey.set('key', requireKey());
    const url = `${BASE}/${q.year}/${q.dataset}?${withKey.toString()}`;
    const rows = await limit(() => requestWithRetry(url, cacheKey));
    if (rows.length === 0) return [];

    // Census returns [header[], ...rows[]] -- reshape to objects.
    const [header, ...body] = rows as [string[], ...string[][]];
    return body.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] as string])));
  });
}

async function requestWithRetry(url: string, label: string, attempt = 0): Promise<string[][]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'geodata-columbus/0.1 (open-source civic mapping project)' },
  });

  // 429/5xx are transient. Back off exponentially rather than hammering.
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    const delay = 2 ** attempt * 1000 + Math.random() * 500;
    console.warn(`[census] ${res.status} on ${label}; retry ${attempt + 1} in ${Math.round(delay)}ms`);
    await new Promise((r) => setTimeout(r, delay));
    return requestWithRetry(url, label, attempt + 1);
  }

  // 204 means "no data for this geography/vintage" -- a legitimate outcome,
  // not an error. Callers treat an empty result as a data gap.
  if (res.status === 204) return [];

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[census] ${res.status} ${res.statusText} on ${label}\n${text.slice(0, 400)}`);
  }

  // The Census API signals several failures with HTTP 200 + an HTML body
  // (missing key, invalid key, unrecognized variable). Trusting res.ok alone
  // surfaces those as an inscrutable "Unexpected token '<'" from JSON.parse,
  // so check the shape of the body before parsing it.
  const body = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  if (!isJson || body.trimStart().startsWith('<')) {
    const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1]?.trim();
    throw new Error(
      `[census] HTTP 200 with a non-JSON body on ${label}` +
        (title ? ` -- "${title}"` : '') +
        '\nUsually a missing/invalid CENSUS_API_KEY, or a variable name that does not ' +
        'exist in this vintage.',
    );
  }

  return JSON.parse(body) as string[][];
}

/** Census uses large negative sentinels for suppressed/unavailable estimates. */
export function parseEstimate(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n <= -222222222) return null; // -666666666, -999999999, etc.
  return n;
}

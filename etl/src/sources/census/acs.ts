/**
 * ACS-specific fetch orchestration on top of client.ts.
 *
 * Request-count math for the whole Columbus build, which is what keeps this
 * comfortably inside any published limit:
 *
 *   ~9 metrics -> ~14 distinct variables, all fitting in ONE 49-variable call.
 *   1 call per (year x county) for tract data, since `for=tract:*` requires a
 *   single `in=state:39 county:XXX`.
 *   = 15 years x 10 counties = 150 calls, plus 15 CBSA baseline calls.
 *
 *   ~165 requests for a complete cold build of every metric and every year.
 *
 * The unkeyed cap is 500/day, so even a keyless first run succeeds. With the
 * disk cache, every subsequent run is 0 requests unless a new vintage is
 * published or a new variable is added to metrics.json.
 *
 * Batch aggressively: fetch ALL variables for a year/county in one call rather
 * than one call per metric. That is the difference between ~165 and ~1,500.
 */
export {};

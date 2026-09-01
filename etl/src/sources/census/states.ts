/**
 * Which state-equivalents belong to the NATIONAL region.
 *
 * `for=state:*` returns 52 rows -- the 50 states, DC, and Puerto Rico. The
 * national baseline, `for=us:1`, does NOT include Puerto Rico. VERIFIED
 * against the live API on 2026-09-01, and the gap is exact to the person:
 *
 *     2009:  sum(state:*) 305,401,642 - us:1 301,461,533 = 3,940,109 = PR
 *     2024:  sum(state:*) 338,156,808 - us:1 334,922,499 = 3,234,309 = PR
 *
 * So the 51 rows below FIPS 60 sum to `us:1` exactly, and PR is the whole of
 * the difference.
 *
 * That makes dropping the territories a CORRECTNESS requirement, not a
 * political or editorial one. Keeping PR on the map would break the index in
 * both directions: its own value would be divided by a baseline computed for a
 * country it is not part of, and an `aggregate` baseline pooled over all 52
 * rows would no longer equal the published national figure it claims to be --
 * the same failure rule 9 describes for places, arriving by a different route.
 *
 * Puerto Rico is not thereby unmappable. It belongs as its OWN region
 * (kind: 'state', baseline = PR), where the index compares its municipios with
 * Puerto Rico rather than with a mainland average that excludes them.
 *
 * The rule is derived, not a hand-kept list: Census assigns territories FIPS
 * 60 and above (60 AS, 66 GU, 69 MP, 72 PR, 78 VI) and states/DC 01-56, so no
 * future territory or state admission needs an edit here.
 */
/**
 * Exported because the TIGER side must apply the SAME rule to the geometry
 * (`+GEOID < 60` in mapshaper). Two expressions of one rule is already one too
 * many; two definitions of the number would be how they drift apart.
 */
export const FIRST_TERRITORY_FIPS = 60;

/** True for the 50 states and DC; false for AS, GU, MP, PR, VI. */
export function isUsState(stateFips: string): boolean {
  const n = Number(stateFips);
  return Number.isFinite(n) && n > 0 && n < FIRST_TERRITORY_FIPS;
}

/**
 * Pure predicates for the admin Users screen's status pills
 * (apps/mobile/app/(drawer)/admin/users.tsx). Extracted so the "which pill
 * shows" decision has a test surface — that screen is a route file with no
 * RN component-render harness in this repo (vitest cannot load
 * react-native), so a pure helper is the testable seam.
 */

/**
 * A disabled member still gets a "DISABLED" pill next to their role — the
 * account-disable program (mig 0308) leaves org membership intact, so the
 * row stays listed rather than being filtered out.
 *
 * STATUS ONLY: reads disabled_at alone, never disabled_reason/disabled_by.
 * Migration 0311 keeps those two columns service-role-only (dropped from
 * the `authenticated` column grant); this screen's Supabase query never
 * selects them in the first place, so there's nothing here that could leak
 * the reason or the disabling admin's identity even by accident.
 */
export function shouldShowDisabledBadge(
  profile: { disabled_at: string | null } | null | undefined,
): boolean {
  return Boolean(profile?.disabled_at);
}

/**
 * Org timezone helper — RE-EXPORT SHIM.
 *
 * The four formatters moved to `packages/core/src/time/org-timezone.ts` on
 * 2026-08-13 so the delivery-request builder (also now in core, so web and
 * mobile compose the identical email) can reach `formatOrgDateTime`. Their
 * documentation, behaviour and defaults live there and are unchanged.
 *
 * This file stays because rewriting web's five importers to `@stockpilot/core`
 * would silently defeat `vi.mock('@/lib/timezone', ...)` in
 * `schedule-calendar.test.tsx` — a mock keyed on this specifier stops
 * intercepting the moment the code under test imports from somewhere else.
 * Named re-exports, deliberately not `export * from '@stockpilot/core'`, so
 * this module's surface stays exactly these four names rather than the whole
 * core barrel.
 */
export {
  ORG_TIMEZONE_DEFAULT,
  formatOrgDate,
  formatOrgTime,
  formatOrgDateTime,
} from '@stockpilot/core';

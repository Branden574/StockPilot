/**
 * Human-readable name for an inline-created rack or crate — the WEB alias for
 * the ONE core planner.
 *
 * The rule itself (rack XOR crate, a crate needs a number, how each is named)
 * lives in `planNewLocation` / `deriveNewLocationName` in
 * packages/core/src/inventory/new-location.ts, because the mobile transfer
 * route, the native move-stock sheet and the web dialogs all have to agree with
 * it and apps/mobile cannot import from apps/web. Read that header before
 * changing anything here.
 *
 * This file stays as the web import path — `@/lib/locations/rack-name` is what
 * the server actions, the API route and the dialogs already import, and it is
 * the file the rack-shape guard points at. It adds NOTHING: composing a name
 * here by hand is exactly the divergence the guard exists to catch.
 *
 *   crate → "Blue #42" / "Crate #42"  (the DEDUPE KEY 0270's index is built on)
 *   rack  → "22-B" or "22"
 *   both / neither → '' (a validation error at the schema, never a guess)
 */
import { deriveNewLocationName, type NewLocationFields } from '@stockpilot/core';

export type NewRackFields = NewLocationFields;

export function deriveLocationName(n: NewRackFields): string {
  return deriveNewLocationName(n);
}

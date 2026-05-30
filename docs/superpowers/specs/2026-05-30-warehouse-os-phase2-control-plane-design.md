# Configurable Warehouse OS — Phase 2 (Owner Control Plane) Design Spec

**Date:** 2026-05-30
**Status:** Approved for planning
**Builds on:** Phase 1 Foundation (shipped) — `docs/superpowers/specs/2026-05-29-warehouse-os-foundation-design.md`. Parent review: `docs/strategy/2026-05-29-stockpilot-warehouse-os-review.md`.

---

## Goal

Make the Phase 1 entitlement foundation **owner-operable**: a Settings → Modules page where an owner/admin toggles optional/premium modules on/off org-wide (the first *visible* payoff of the foundation), plus the two follow-ups the foundation deferred — a graceful "module not enabled" route page, and mobile entitlement refresh on org switch.

Phase 1 already shipped: `MODULE_REGISTRY` + resolver in `packages/core`; `organization_modules` table + `module_enabled()` helper + `domain_pack`; `ServiceContext.enabledModules` + `assertModuleEnabled`; web sidebar + mobile drawer/tabs derived from the registry; L4L grandfathered with every module enabled. Phase 2 only adds the human controls + the two UX gaps.

## Scope

**In scope:**
1. `setModuleEnabledAction(moduleId, enabled)` server action (owner+admin, audited, dependency-coherent).
2. Settings → Modules page + a settings-landing tile (owner/admin only).
3. Graceful `ModuleNotEnabled` page for direct navigation to a disabled module's route.
4. Mobile entitlement refresh when a multi-org user switches active org.

**Out of scope (later phases):** nav reordering / drag-drop, mobile tab-slot picker, per-user nav prefs, custom fields/statuses/document templates/notification registry, per-user capability delegation (explicitly declined — owner+admin is the gate), connectors, the selective RLS `module_enabled()` write-table backstop, retiring/activating `plans.ts` (billing stays dormant; `minPlan` inert).

## Success criteria

- Owner/admin sees Settings → Modules listing every module grouped by tier, with current on/off; managers/staff/viewers cannot reach it.
- Toggling a module off removes it from the web sidebar (after `revalidatePath`), the mobile drawer/tabs (after refresh), and makes its routes render `ModuleNotEnabled` + its service entry points 403 — toggling on restores all of it.
- Dependency coherence always holds: you cannot end in a state where an enabled module's required dep is disabled.
- Every toggle writes an `audit_logs` row.
- **Zero behavior change for L4L** until someone actually toggles (it starts all-enabled).
- Mobile: switching active org reflects the new org's enabled modules in the drawer/tabs.

---

## Design

### Authorization
Gate on the existing `organization:update` permission (owner + admin both hold it; manager/staff/viewer do not), consistent with the other org-config actions (`updateTerminologyAction`, `updateOrgTimezoneAction`). Mutations also pass `assertCurrentAal2` like the sibling actions. No new permission, no per-user grants.

### Server action — `apps/web/src/server/actions/organization.ts`
`setModuleEnabledAction(input: { moduleId: ModuleId; enabled: boolean })`:
1. zod-validate `moduleId` ∈ `MODULE_REGISTRY` keys AND `MODULE_REGISTRY[moduleId].tier !== 'core'` (core modules are always on — reject with `validation_error`).
2. `assertPermission(ctx, 'organization:update')` + `assertCurrentAal2(ctx)`.
3. **Compute the dependency-coherent change set** (see below) — the full set of `{moduleId, enabled}` rows to upsert so no invariant breaks.
4. Upsert each into `organization_modules` (`enabled`, `enabled_at = now()`, `enabled_by = ctx.userId`), `tier` from the registry. (Core rows are never written here.)
5. `audit({ event: enabled ? 'module.enabled' : 'module.disabled', entityType: 'organization_module', entityId: moduleId, after: { changeSet } })`.
6. `revalidatePath('/dashboard', 'layout')` (re-resolves the sidebar) + `revalidatePath('/dashboard/settings/modules')`.
7. Return the resulting full enabled-set so the client reflects cascades.

The action is the **only** writer of `organization_modules` for toggles, so it is the single place that keeps the table coherent (the Phase-1 resolver intentionally does not enforce `dependsOn`).

### Dependency cascade (coherence)
`MODULE_REGISTRY[id].dependsOn` defines required deps. The action enforces closure:
- **Enabling X:** also enable every transitive dep of X that is currently a non-core, disabled module. (Enabling Receiving auto-enables Purchase orders; deps that are `core` are already on.)
- **Disabling X:** also disable every module that transitively `dependsOn` X and is currently enabled. (Disabling AI auto-disables AI shelf scan.)
The UI shows a **confirmation dialog** before applying when the cascade touches more than the toggled module, listing exactly what else changes ("Also enables: Purchase orders (required)" / "Also disables: AI shelf scan (depends on this)"). A pure helper `computeModuleChangeSet(registry, currentlyEnabled, moduleId, enabled): {moduleId,enabled}[]` lives in `packages/core` (testable, shared) and is used by both the action (authoritative) and the client (to preview the cascade).

### Settings → Modules page — `apps/web/src/app/(dashboard)/dashboard/settings/modules/page.tsx`
Server component: `withContext()`, redirect non-`organization:update` roles (mirrors how `billing`/`public-requests` pages redirect). Loads `organization_modules` for the org, renders a client `<ModuleToggles>` fed `MODULE_REGISTRY` (grouped by tier) + the enabled set:
- **Core** group: listed, shown as "Always on", no toggle.
- **Optional** group: a toggle per module (`title` + `description`).
- **Premium** group: same toggle UX, labeled "Premium" (billing dormant → freely toggleable).
Each toggle calls `setModuleEnabledAction`; if `computeModuleChangeSet` returns >1 row, show the confirm dialog first. Optimistic UI with rollback on error (toast). Add a **Modules** tile to the settings landing (`apps/web/src/app/(dashboard)/dashboard/settings/page.tsx`) in an owner+admin-gated section (alongside the admin/owner tiles).

### Graceful disabled-route page
New `apps/web/src/components/dashboard/module-not-enabled.tsx` — a `<ModuleNotEnabled moduleId>` server component rendering inside the dashboard shell: the module `title` from the registry, "This module isn't enabled for your organization," and a CTA — for owner/admin a link to `/dashboard/settings/modules`, otherwise "Ask an owner or admin to enable it." Each **optional/premium** module page guards at the top:
```tsx
const ctx = await withContext();
if (MODULE_REGISTRY[MODULE_ID].tier !== 'core' && !ctx.enabledModules.has(MODULE_ID))
  return <ModuleNotEnabled moduleId={MODULE_ID} />;
```
This replaces the current behavior where the page's service call throws `module_disabled` into the generic error boundary. (~13 module pages get the 2-line guard. Considered + rejected: a single layout-level pathname guard — less explicit and Next.js layouts don't receive the pathname cleanly.)

### Mobile entitlement refresh on org switch
`apps/mobile/src/lib/use-workspace.ts` `setActiveOrg(orgId)` triggers a re-fetch of the snapshot (or just `enabledModules`) for the new org so `enabled-modules.ts` reflects the switched org; until it resolves, the drawer/tabs fall back to `DEFAULT_MODULE_IDS` (already the loading default) so nothing flickers empty. The snapshot endpoint is already per-org and returns `enabledModules` (Phase 1).

---

## Testing strategy
- **`computeModuleChangeSet` (core unit):** enabling cascades required deps; disabling cascades dependents; transitive chains; no-op when already in desired state; never includes core modules; idempotent.
- **`setModuleEnabledAction` (web):** rejects `core`/unknown moduleId (`validation_error`); non-owner/admin → `forbidden`; writes `organization_modules` + audit row; applies the full change set; revalidates.
- **Page:** renders registry grouped by tier with correct on/off; non-privileged role is redirected.
- **Disabled route:** with a module disabled, its page renders `ModuleNotEnabled` (not the error boundary); owner sees the settings CTA.
- **Sidebar integration:** after disabling, `navForRole(role, enabledModules)` drops the module (already covered by Phase 1 resolver tests; add an action→revalidate integration check).
- **Mobile:** `setActiveOrg` re-fetches entitlements; drawer reflects the new org.
- **Backwards-compat:** L4L (all enabled) renders every toggle on; no behavior change until a toggle flips.

## Files
- **New:** `packages/core/src/modules/change-set.ts` (+ test); `apps/web/src/app/(dashboard)/dashboard/settings/modules/page.tsx` + client `module-toggles.tsx`; `apps/web/src/components/dashboard/module-not-enabled.tsx`; `setModuleEnabledAction` (in `organization.ts` or new `module-settings.ts`) + test.
- **Edit:** `apps/web/src/app/(dashboard)/dashboard/settings/page.tsx` (Modules tile); each optional/premium module `page.tsx` (2-line guard); `apps/mobile/src/lib/use-workspace.ts` (refresh on switch); export `computeModuleChangeSet` from the core barrel.

## Open items to resolve during planning
1. **Exact list of the optional/premium module pages** that need the guard, and their canonical `ModuleId` mapping (derive from the registry's `web_sidebar` placements). PO imports / Receiving share the purchase-orders area — confirm route ownership.
2. **`audit_logs` schema fields** — confirm `entityType`/`entityId`/`after` shape against the existing `audit()` helper signature before writing the action.
3. **Settings-landing section** for the Modules tile — add to an existing owner+admin-gated array or a new one; confirm the role check used there matches `organization:update`.
4. **Snapshot refresh mechanism on mobile** — confirm whether to re-run the full `sync.ts` snapshot or add a lightweight `enabledModules`-only fetch on `setActiveOrg`.

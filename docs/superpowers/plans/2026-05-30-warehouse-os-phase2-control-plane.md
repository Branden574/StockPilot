# Warehouse-OS Phase 2 (Owner Control Plane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shipped Phase 1 entitlement foundation owner-operable — a Settings → Modules page (owner+admin) that toggles optional/premium modules on/off org-wide with dependency-coherent cascades, a graceful "module not enabled" route page, and mobile entitlement refresh on org switch.

**Architecture:** A pure `computeModuleChangeSet` cascade helper in `packages/core` keeps `organization_modules` coherent; a `setModuleEnabledAction` (mirroring the existing `updateOrgTimezoneAction`) writes it + audits; a Settings page renders `MODULE_REGISTRY` grouped by tier and calls the action; each optional/premium module page early-returns a `ModuleNotEnabled` component when its module is off; the mobile drawer/tabs re-read entitlements after an org switch.

**Tech Stack:** TypeScript, pnpm/turbo monorepo, Next.js 16 App Router (web), Expo SDK 53 (mobile), Supabase, Vitest.

**Conventions confirmed against the codebase:**
- Server actions in `apps/web/src/server/actions/organization.ts` use `requireOrgContext()` + an explicit `if (ctx.role !== 'owner' && ctx.role !== 'admin') return err('forbidden', …)` check (NOT `withContext`/`assertPermission`), then mutate, `await audit({event, entityType, entityId, before, after})`, `revalidatePath('/dashboard','layout')`, return `ok()`/`err()` (`ActionResult` from `@stockpilot/core`).
- `audit()` event names are a closed `AuditEvent` union in `apps/web/src/server/services/audit.ts` (must add new events there).
- Settings sub-pages: `requireOrgContext()` then `if (!hasPermission(ctx.role, '<perm>')) redirect('/dashboard')`.
- `organization:update` is held by owner + admin only.
- Registry real (non-core) dependency edges: `receiving→purchase_orders`, `po_imports→purchase_orders`, `public_requests→orders`, `ai_shelf_scan→ai`. All other `dependsOn` point at core modules (always on).
- Commit per task with trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Stage only each task's files (unrelated web WIP is uncommitted in the tree).

---

## File structure

| File | Responsibility |
|---|---|
| `packages/core/src/modules/change-set.ts` (new) | Pure `computeModuleChangeSet(enabled, moduleId, next)` cascade. |
| `packages/core/src/modules/change-set.test.ts` (new) | Cascade unit tests. |
| `packages/core/src/index.ts` (edit) | Export change-set. |
| `apps/web/src/server/services/audit.ts` (edit) | Add `module.enabled`/`module.disabled` to `AuditEvent`. |
| `apps/web/src/server/actions/module-settings.ts` (new) | `setModuleEnabledAction`. |
| `apps/web/src/server/actions/module-settings.test.ts` (new) | Action tests. |
| `apps/web/src/app/(dashboard)/dashboard/settings/modules/page.tsx` (new) | Server page: gate + load state + render toggles. |
| `apps/web/src/components/settings/module-toggles.tsx` (new) | Client: grouped toggles + cascade confirm dialog. |
| `apps/web/src/app/(dashboard)/dashboard/settings/page.tsx` (edit) | Add Modules tile (owner+admin). |
| `apps/web/src/components/dashboard/module-not-enabled.tsx` (new) | Graceful "not enabled" page body. |
| 11 optional module `page.tsx` (edit) | 2-line guard. |
| `apps/mobile/src/lib/api.ts` (edit) | Send `X-Organization-Id` from active org. |
| `apps/mobile/src/lib/enabled-modules.ts` (edit) | Subscribe-able refresh; `refreshEnabledModules()`. |
| `apps/mobile/src/lib/use-workspace.ts` (edit) | `setActiveOrg` → `syncNow()` + refresh. |

---

## Task 1: `computeModuleChangeSet` cascade helper (packages/core)

**Files:** Create `packages/core/src/modules/change-set.ts`, `packages/core/src/modules/change-set.test.ts`.

- [ ] **Step 1: Write the failing test** (`change-set.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { computeModuleChangeSet } from './change-set';
import type { ModuleId } from './registry';

const set = (...ids: ModuleId[]) => new Set<ModuleId>(ids);
const norm = (cs: { moduleId: ModuleId; enabled: boolean }[]) =>
  [...cs].sort((a, b) => a.moduleId.localeCompare(b.moduleId));

describe('computeModuleChangeSet', () => {
  it('enabling a module with a non-core dep cascades the dep on', () => {
    // receiving dependsOn purchase_orders (both optional)
    expect(norm(computeModuleChangeSet(set(), 'receiving', true))).toEqual(
      norm([{ moduleId: 'receiving', enabled: true }, { moduleId: 'purchase_orders', enabled: true }]),
    );
  });
  it('enabling a module whose deps are all core only toggles itself', () => {
    // books dependsOn inventory (core, always on)
    expect(computeModuleChangeSet(set(), 'books', true)).toEqual([{ moduleId: 'books', enabled: true }]);
  });
  it('disabling a module cascades its dependents off (transitive)', () => {
    // purchase_orders has dependents receiving + po_imports
    expect(norm(computeModuleChangeSet(set('purchase_orders', 'receiving', 'po_imports'), 'purchase_orders', false))).toEqual(
      norm([
        { moduleId: 'purchase_orders', enabled: false },
        { moduleId: 'receiving', enabled: false },
        { moduleId: 'po_imports', enabled: false },
      ]),
    );
  });
  it('disabling only cascades dependents that are currently enabled', () => {
    expect(norm(computeModuleChangeSet(set('purchase_orders', 'receiving'), 'purchase_orders', false))).toEqual(
      norm([{ moduleId: 'purchase_orders', enabled: false }, { moduleId: 'receiving', enabled: false }]),
    );
  });
  it('disabling ai cascades ai_shelf_scan off', () => {
    expect(norm(computeModuleChangeSet(set('ai', 'ai_shelf_scan'), 'ai', false))).toEqual(
      norm([{ moduleId: 'ai', enabled: false }, { moduleId: 'ai_shelf_scan', enabled: false }]),
    );
  });
  it('is idempotent: no change when already in desired state', () => {
    expect(computeModuleChangeSet(set('orders'), 'orders', true)).toEqual([]);
    expect(computeModuleChangeSet(set(), 'orders', false)).toEqual([]);
  });
  it('never emits a core module', () => {
    const cs = computeModuleChangeSet(set(), 'receiving', true);
    expect(cs.some((c) => c.moduleId === 'inventory')).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `cd packages/core && npx vitest run src/modules/change-set.test.ts`

- [ ] **Step 3: Implement `change-set.ts`:**

```ts
import { MODULE_REGISTRY, type ModuleId } from './registry';

export interface ModuleChange { moduleId: ModuleId; enabled: boolean; }

const isCore = (id: ModuleId) => MODULE_REGISTRY[id].tier === 'core';

/** Modules (non-core) that directly depend on `id`. */
function directDependents(id: ModuleId): ModuleId[] {
  return (Object.values(MODULE_REGISTRY))
    .filter((m) => m.dependsOn.includes(id))
    .map((m) => m.id);
}

/**
 * The coherent set of (moduleId, enabled) changes to apply so that toggling
 * `moduleId` to `next` never leaves an enabled module with a disabled required
 * dependency. Enabling cascades required deps ON; disabling cascades dependents
 * OFF. Core modules are always on and never emitted. Only modules whose state
 * actually changes vs `enabled` are returned.
 */
export function computeModuleChangeSet(
  enabled: Set<ModuleId>,
  moduleId: ModuleId,
  next: boolean,
): ModuleChange[] {
  if (isCore(moduleId)) return []; // core can't be toggled
  const target = new Map<ModuleId, boolean>();
  const visit = (id: ModuleId) => {
    if (isCore(id) || target.has(id)) return;
    target.set(id, next);
    if (next) {
      // enabling: pull required (non-core) deps on
      for (const dep of MODULE_REGISTRY[id].dependsOn) if (!isCore(dep)) visit(dep);
    } else {
      // disabling: push (non-core) dependents off
      for (const dep of directDependents(id)) visit(dep);
    }
  };
  visit(moduleId);
  // keep only real changes vs current state
  const out: ModuleChange[] = [];
  for (const [id, want] of target) {
    if (enabled.has(id) !== want) out.push({ moduleId: id, enabled: want });
  }
  return out;
}
```

- [ ] **Step 4: Run → PASS.** Also `cd packages/core && npx tsc --noEmit`.
- [ ] **Step 5: Export + commit.** Add `export * from './modules/change-set';` to `packages/core/src/index.ts`. Then:
```bash
git add packages/core/src/modules/change-set.ts packages/core/src/modules/change-set.test.ts packages/core/src/index.ts
git commit -m "feat(core): module dependency cascade (computeModuleChangeSet)"
```

---

## Task 2: `setModuleEnabledAction` + AuditEvent (web)

**Files:** Modify `apps/web/src/server/services/audit.ts`; Create `apps/web/src/server/actions/module-settings.ts`, `apps/web/src/server/actions/module-settings.test.ts`.

- [ ] **Step 1: Add audit events.** In `audit.ts`, add to the `AuditEvent` union (near `'organization.updated'`):
```ts
  | 'module.enabled'
  | 'module.disabled'
```

- [ ] **Step 2: Write the failing test** (`module-settings.test.ts`). Mirror the existing action test style (mock `requireOrgContext`, `createClient`, `audit`). Assert: core moduleId → `validation_error`; unknown moduleId → `validation_error`; role `staff` → `forbidden`; enabling `receiving` upserts BOTH `receiving` and `purchase_orders` (cascade) and calls `audit` with `event:'module.enabled'`; returns `ok`.

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
// Mock requireOrgContext / createClient / audit per the repo's existing
// action-test pattern (see organization tests). Then:
import { setModuleEnabledAction } from './module-settings';

// ... mocks set ctx.role='owner', org id, and a supabase upsert spy ...

describe('setModuleEnabledAction', () => {
  it('rejects a core module', async () => {
    const r = await setModuleEnabledAction({ moduleId: 'inventory', enabled: false });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('validation_error');
  });
  it('rejects an unknown module', async () => {
    const r = await setModuleEnabledAction({ moduleId: 'nope' as never, enabled: true });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('validation_error');
  });
  it('forbids non owner/admin', async () => {
    // set ctx.role = 'staff'
    const r = await setModuleEnabledAction({ moduleId: 'rentals', enabled: false });
    expect(r.error?.code).toBe('forbidden');
  });
  it('enabling receiving also enables purchase_orders (cascade) and audits', async () => {
    // ctx.role='owner'; current enabled set excludes purchase_orders+receiving
    const r = await setModuleEnabledAction({ moduleId: 'receiving', enabled: true });
    expect(r.ok).toBe(true);
    // assert upsert called with both module rows enabled=true
    // assert audit called once with event 'module.enabled'
  });
});
```

- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement `module-settings.ts`** (mirror `updateOrgTimezoneAction` structure exactly):

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { audit } from '@/server/services/audit';
import { ServiceError } from '@/server/services/context';

import {
  MODULE_REGISTRY,
  computeModuleChangeSet,
  err,
  ok,
  type ActionResult,
  type ModuleId,
} from '@stockpilot/core';

const schema = z.object({
  moduleId: z.string().refine((id): id is ModuleId => id in MODULE_REGISTRY, 'Unknown module'),
  enabled: z.boolean(),
});

export async function setModuleEnabledAction(
  input: { moduleId: ModuleId; enabled: boolean },
): Promise<ActionResult<{ enabled: ModuleId[] }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid module');
  const { moduleId, enabled } = parsed.data;
  if (MODULE_REGISTRY[moduleId].tier === 'core')
    return err('validation_error', 'Core modules are always enabled.');

  try {
    const ctx = await requireOrgContext();
    if (ctx.role !== 'owner' && ctx.role !== 'admin')
      return err('forbidden', 'Only owners and admins can change modules.');

    const supabase = await createClient();
    const { data: rows } = await supabase
      .from('organization_modules')
      .select('module_id, enabled')
      .eq('organization_id', ctx.organizationId);
    const current = new Set<ModuleId>(
      ((rows ?? []) as Array<{ module_id: string; enabled: boolean }>)
        .filter((r) => r.enabled)
        .map((r) => r.module_id as ModuleId),
    );

    const changes = computeModuleChangeSet(current, moduleId, enabled);
    if (changes.length === 0) {
      return ok({ enabled: [...current] });
    }

    const upserts = changes.map((c) => ({
      organization_id: ctx.organizationId,
      module_id: c.moduleId,
      enabled: c.enabled,
      tier: MODULE_REGISTRY[c.moduleId].tier,
      enabled_at: new Date().toISOString(),
      enabled_by: ctx.userId,
    }));
    const { error } = await supabase
      .from('organization_modules')
      .upsert(upserts, { onConflict: 'organization_id,module_id' });
    if (error) throw new ServiceError('internal_error', error.message);

    await audit({
      event: enabled ? 'module.enabled' : 'module.disabled',
      entityType: 'organization_module',
      entityId: moduleId,
      after: { changes },
    });

    revalidatePath('/dashboard', 'layout');
    revalidatePath('/dashboard/settings/modules');

    const nextEnabled = new Set(current);
    for (const c of changes) c.enabled ? nextEnabled.add(c.moduleId) : nextEnabled.delete(c.moduleId);
    return ok({ enabled: [...nextEnabled] });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
```

- [ ] **Step 5: Run → PASS;** `cd apps/web && npx tsc --noEmit`.
- [ ] **Step 6: Commit.**
```bash
git add apps/web/src/server/services/audit.ts apps/web/src/server/actions/module-settings.ts apps/web/src/server/actions/module-settings.test.ts
git commit -m "feat(web): setModuleEnabledAction (owner+admin, audited, cascade-coherent)"
```

---

## Task 3: Settings → Modules page + landing tile

**Files:** Create `apps/web/src/app/(dashboard)/dashboard/settings/modules/page.tsx`, `apps/web/src/components/settings/module-toggles.tsx`; Modify `apps/web/src/app/(dashboard)/dashboard/settings/page.tsx`.

- [ ] **Step 1: Page (server component).** `page.tsx`: `requireOrgContext()`; `if (!hasPermission(ctx.role, 'organization:update')) redirect('/dashboard')`; query `organization_modules` (module_id, enabled) for the org into an `enabledSet`; pass `MODULE_REGISTRY` (as a serializable list grouped by tier: core/optional/premium with `id,title,description,tier`) + `enabledSet` (string[]) to `<ModuleToggles>`. (Import `hasPermission` from `@stockpilot/core`, `redirect` from `next/navigation`, `requireOrgContext` from `@/lib/auth/session`.)

- [ ] **Step 2: Client toggles component.** `module-toggles.tsx` (`'use client'`): renders three groups. Core rows show a static "Always on" pill (no Switch). Optional/Premium rows render a shadcn `Switch` reflecting `enabledSet`. On change, compute the preview with `computeModuleChangeSet(new Set(enabledSet), id, next)`; if it returns >1 change, open a confirm dialog listing the extra modules ("Also enables/disables: …") before calling `setModuleEnabledAction`; otherwise call it directly. Optimistic update; on `err` result, revert + `toast.error`. On success, set local enabled state to `result.data.enabled`.

- [ ] **Step 3: Landing tile.** In `settings/page.tsx`, add:
```ts
const MODULES_SECTIONS = [
  { href: '/dashboard/settings/modules', title: 'Modules', description: 'Turn features on or off for your whole organization.' },
];
```
and compose it gated on `organization:update`:
```ts
    ...(hasPermission(ctx.role, 'organization:update') ? MODULES_SECTIONS : []),
```

- [ ] **Step 4: Verify.** `cd apps/web && npx tsc --noEmit && npx eslint src/app/\(dashboard\)/dashboard/settings/modules/page.tsx src/components/settings/module-toggles.tsx`. Manually: as owner, `/dashboard/settings/modules` lists all modules with L4L all-on; toggling Rentals off removes it from the sidebar (after revalidate); as staff, the page redirects to `/dashboard` and no Modules tile shows.

- [ ] **Step 5: Commit.**
```bash
git add "apps/web/src/app/(dashboard)/dashboard/settings/modules/page.tsx" apps/web/src/components/settings/module-toggles.tsx "apps/web/src/app/(dashboard)/dashboard/settings/page.tsx"
git commit -m "feat(web): Settings -> Modules owner control plane"
```

---

## Task 4: Graceful `ModuleNotEnabled` page + per-page guards

**Files:** Create `apps/web/src/components/dashboard/module-not-enabled.tsx`; Modify the 11 optional module pages.

- [ ] **Step 1: Component.** `module-not-enabled.tsx` (server component): props `{ moduleId: ModuleId }`. Render a centered card in the dashboard shell: the module `MODULE_REGISTRY[moduleId].title`, text "This module isn't enabled for your organization.", and a CTA — accept a `canManage: boolean` prop; if true, a `<Link href="/dashboard/settings/modules">Enable in Settings → Modules</Link>`, else "Ask an owner or admin to enable it." Keep it presentational.

- [ ] **Step 2: Add the guard to each optional module page.** At the top of each page's default export (after it resolves `ctx`/role), add:
```tsx
import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
// ... inside the component, once ctx (with enabledModules + role) is available:
const MODULE_ID: ModuleId = 'rentals'; // per page
if (MODULE_REGISTRY[MODULE_ID].tier !== 'core' && !ctx.enabledModules.has(MODULE_ID))
  return <ModuleNotEnabled moduleId={MODULE_ID} canManage={ctx.role === 'owner' || ctx.role === 'admin'} />;
```
Pages + their `MODULE_ID` (these are the optional modules with a web route):

| Page file (under `apps/web/src/app/(dashboard)/dashboard/`) | MODULE_ID |
|---|---|
| `books/page.tsx` | `books` |
| `bundles/page.tsx` | `bundles` |
| `cycle-counts/page.tsx` | `cycle_counts` |
| `orders/page.tsx` | `orders` |
| `procedures/page.tsx` | `procedures` |
| `purchase-orders/page.tsx` | `purchase_orders` |
| `purchase-orders/imports/page.tsx` | `po_imports` |
| `rentals/page.tsx` | `rentals` |
| `schedule/page.tsx` | `schedule` |
| `suppliers/page.tsx` | `suppliers` |
| `ai/page.tsx` | `ai` |

> Each page already resolves a context with the role; if a page uses `requireOrgContext()` (no `enabledModules`), fetch the org's modules inline (one `organization_modules` select) or switch that page to `withContext()` which carries `enabledModules`. READ each page first; use whichever context it already has and add the minimal entitlement read. Do NOT change unrelated page logic.

- [ ] **Step 3: Verify.** `cd apps/web && npx tsc --noEmit`. Manually disable `rentals` (DB or the new toggle), visit `/dashboard/rentals` → renders `ModuleNotEnabled` (not the error boundary); re-enable → page returns. Spot-check 2-3 other guarded pages.

- [ ] **Step 4: Commit.**
```bash
git add apps/web/src/components/dashboard/module-not-enabled.tsx "apps/web/src/app/(dashboard)/dashboard/books/page.tsx" "apps/web/src/app/(dashboard)/dashboard/bundles/page.tsx" "apps/web/src/app/(dashboard)/dashboard/cycle-counts/page.tsx" "apps/web/src/app/(dashboard)/dashboard/orders/page.tsx" "apps/web/src/app/(dashboard)/dashboard/procedures/page.tsx" "apps/web/src/app/(dashboard)/dashboard/purchase-orders/page.tsx" "apps/web/src/app/(dashboard)/dashboard/purchase-orders/imports/page.tsx" "apps/web/src/app/(dashboard)/dashboard/rentals/page.tsx" "apps/web/src/app/(dashboard)/dashboard/schedule/page.tsx" "apps/web/src/app/(dashboard)/dashboard/suppliers/page.tsx" "apps/web/src/app/(dashboard)/dashboard/ai/page.tsx"
git commit -m "feat(web): graceful ModuleNotEnabled page for disabled module routes"
```

---

## Task 5: Mobile entitlement refresh on org switch

**Files:** Modify `apps/mobile/src/lib/api.ts`, `apps/mobile/src/lib/enabled-modules.ts`, `apps/mobile/src/lib/use-workspace.ts`.

- [ ] **Step 1: Scope mobile API calls to the active org.** In `api.ts` `authHeader()` (or the header assembly in `api()`), add `X-Organization-Id` from the persisted active org so `withApiContext` scopes to the switched org (it already validates membership + 401s on mismatch). Read the persisted value:
```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
// ...
const orgId = await AsyncStorage.getItem('workspace.activeOrgId'); // ORG_STORAGE_KEY
return {
  ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
  ...(orgId ? { 'X-Organization-Id': orgId } : {}),
};
```
(For single-org L4L this equals the default org → no behavior change.)

- [ ] **Step 2: Make `useEnabledModules` refreshable.** In `enabled-modules.ts`, add a tiny module-level subscriber set + `refreshEnabledModules()` that re-reads + notifies, and have `useEnabledModules` subscribe (mirroring the `use-workspace` listener pattern):
```ts
const listeners = new Set<() => void>();
export function refreshEnabledModules(): void { for (const fn of listeners) fn(); }
// in the hook: register a listener that re-runs readPersistedEnabledModules() and setModules(...)
// on mount AND whenever notified; clean up on unmount.
```

- [ ] **Step 3: Refresh on org switch.** In `use-workspace.ts` `setActiveOrg`, after the org is switched + warehouses loaded, trigger a snapshot pull for the new org then refresh entitlements:
```ts
import { syncNow } from './sync';
import { refreshEnabledModules } from './enabled-modules';
// ... at the end of setActiveOrg:
void syncNow().then(() => refreshEnabledModules());
```
`syncNow()` now pulls the snapshot scoped to the new org (Step 1) and persists `enabled_modules`; `refreshEnabledModules()` makes the drawer/tabs re-read it. While the pull is in flight, the existing `DEFAULT_ENABLED_MODULES` fallback keeps the drawer/tabs populated.

- [ ] **Step 4: Verify.** `cd apps/mobile && npx tsc --noEmit`. (Single-org L4L: behavior unchanged — same org, same modules.) If a second test org with differing modules is available, switching orgs updates the drawer/tabs without a remount.

- [ ] **Step 5: Commit.**
```bash
git add apps/mobile/src/lib/api.ts apps/mobile/src/lib/enabled-modules.ts apps/mobile/src/lib/use-workspace.ts
git commit -m "feat(mobile): refresh entitlements on org switch (X-Organization-Id + re-read)"
```

---

## Final verification (definition of done)
- [ ] `cd packages/core && npx vitest run` and `cd apps/web && npx vitest run` → all PASS; both `npx tsc --noEmit` clean; `cd apps/mobile && npx tsc --noEmit` clean.
- [ ] Owner: Settings → Modules lists all modules (L4L all-on); disabling Rentals removes it from the sidebar and `/dashboard/rentals` shows ModuleNotEnabled; the cascade confirm appears when disabling Purchase orders (also disables Receiving + PO imports); re-enabling restores everything.
- [ ] Staff: no Modules tile, `/dashboard/settings/modules` redirects to `/dashboard`.
- [ ] Every toggle writes an `audit_logs` row (`module.enabled`/`module.disabled`).
- [ ] No migration needed (uses Phase 1's `organization_modules`). Web ships via Vercel on merge; mobile via OTA (native-safe — pure JS) — flag to user, don't auto-publish.

## Plan self-review
- **Spec coverage:** action (T2) ✓, cascade (T1) ✓, page+tile (T3) ✓, ModuleNotEnabled+guards (T4) ✓, mobile refresh (T5) ✓. Out-of-scope items absent.
- **Placeholder scan:** the action-test mocks reference "the repo's existing action-test pattern" — the implementer must read an existing `*.test.ts` in `server/actions` to copy the mock setup; flagged explicitly, not a silent TODO. Page/component steps describe concrete props + behavior; the toggle component's exact JSX is left to the implementer to match the shadcn `Switch`/`Dialog` already used in the app (READ an existing settings form first).
- **Type consistency:** `ModuleId`, `MODULE_REGISTRY`, `computeModuleChangeSet`, `ModuleChange`, `setModuleEnabledAction({moduleId,enabled})`, `ModuleNotEnabled({moduleId,canManage})`, `refreshEnabledModules`, `ENABLED_MODULES_META_KEY`/`workspace.activeOrgId` all consistent across tasks.

## Open items the implementer must resolve by reading code (not placeholders)
1. The exact mock setup for `module-settings.test.ts` — copy from an existing `apps/web/src/server/actions/*.test.ts`.
2. Whether each of the 11 module pages uses `requireOrgContext()` or `withContext()` — use the context it already has; add the minimal `enabledModules` read (one select) if it lacks it.
3. The shadcn `Switch` + `Dialog` import paths + the app's toast util (`sonner`) — match existing usage.

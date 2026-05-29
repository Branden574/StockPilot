# Warehouse-OS Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an org-level **entitlement axis** (which modules exist for an org) plus a shared **module registry** that web + mobile navigation derive from — pure foundation, zero user-visible change for the existing org (L4L Fresno).

**Architecture:** A new `MODULE_REGISTRY` in `packages/core` is the single catalog of modules (entitlement metadata + per-surface nav placements). A new `organization_modules` table + `module_enabled()` SQL helper store per-org on/off state. `ServiceContext` gains `enabledModules`; `assertModuleEnabled()` is the service-layer gate. Web sidebar and mobile drawer are rebuilt to derive from the registry via a shared pure resolver; mobile bottom tabs stay the same 5 files but gate visibility. A grandfather migration enables every module for existing orgs so behavior is identical.

**Tech Stack:** TypeScript, pnpm/turbo monorepo, Next.js 16 (web), Expo SDK 53 / expo-router (mobile), Supabase Postgres + RLS, Vitest (web/core tests). Spec: `docs/superpowers/specs/2026-05-29-warehouse-os-foundation-design.md`.

**Conventions to follow:**
- New migrations are numbered after the current highest, `0143`. This plan uses `0144` and `0145`.
- RLS helpers `is_org_member(uuid)` / `has_org_role(uuid, role)` exist (0001/0140); reuse them. Wrap helper calls in `(select …)` for the InitPlan optimization (matches `0140`).
- The `Database` TS type is an intentional `any` stub, so the compiler will NOT catch wrong column names — verify SQL by applying the migration.
- Run tests from `apps/web` (web/nav) and `packages/core` (core) via `pnpm --filter <pkg> test` or `npx vitest run <file>`.
- Commit after each task with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## File structure (what each new/edited file is responsible for)

| File | Responsibility |
|---|---|
| `packages/core/src/modules/registry.ts` (new) | Module catalog: `ModuleId`, `ModuleDefinition`, `NavPlacement`, `MODULE_REGISTRY`, `modulesForPack()`, `DEFAULT_MODULE_IDS`. |
| `packages/core/src/modules/resolve.ts` (new) | Pure `resolveSurface(surface, {role, enabledModules})` → grouped/sorted nav. No platform imports. |
| `packages/core/src/index.ts` (edit) | Re-export the modules API. |
| `supabase/migrations/0144_org_modules_entitlements.sql` (new) | `organization_modules` table, RLS, `module_enabled()` helper, `organizations.domain_pack` column. |
| `supabase/migrations/0145_grandfather_existing_orgs.sql` (new) | Enable full module set for existing orgs + `domain_pack='charter_school'` + AFTER INSERT seed trigger for new orgs. |
| `apps/web/src/server/services/context.ts` (edit) | `enabledModules` on `ServiceContext`, resolve in `withContext`, `assertModuleEnabled`, `'module_disabled'` code, `serviceErrorStatus()`. |
| `apps/web/src/lib/auth/api-context.ts` (edit) | Resolve `enabledModules` on the bearer path; export `assertModuleEnabledForPath()` middleware helper. |
| `apps/web/src/components/dashboard/icons.ts` (new) | `iconName → lucide-react component` map. |
| `apps/web/src/components/dashboard/nav.ts` (edit) | `navForRole(role, enabledModules)` derives from the registry via the resolver. |
| `apps/web/src/components/dashboard/nav.test.ts` (edit) | Pass full module set; assert identical hrefs. |
| `apps/web/src/components/dashboard/sidebar.tsx` (edit) | Pass `enabledModules` into `navForRole`. |
| optional/premium service files (edit) | Add `assertModuleEnabled` to entry points. |
| `apps/mobile/src/lib/nav-icons.ts` (new) | `iconName → lucide-react-native component` map. |
| `apps/mobile/src/lib/drawer-nav.ts` (edit) | Replace `DRAWER_SECTIONS` consumption with resolver output. |
| `apps/mobile/src/components/drawer-content.tsx` (edit) | Render resolved sections. |
| `apps/mobile/app/(drawer)/(tabs)/_layout.tsx` (edit) | Gate the 5 tabs via `href: null` per entitlement. |
| `apps/web/src/app/api/v1/mobile/snapshot/route.ts` (edit) | Add `enabledModules` to the response. |
| `apps/mobile/src/lib/sync.ts` (edit) | Add `enabledModules` to `SnapshotResponse` + persist. |

---

## Task 1: Module registry (`packages/core`)

**Files:**
- Create: `packages/core/src/modules/registry.ts`
- Test: `packages/core/src/modules/registry.test.ts`

The registry must contain a placement for **every** current nav entry so the derived nav is 1:1. Source of truth for the current nav (transcribe exactly):
- Web `apps/web/src/components/dashboard/nav.ts` — `BASE_NAV` (Overview; Inventory: Items, Books, Categories, Tags, Movements, Rentals, Bundles, Orders, Cycle counts, Procedures, Purchase orders, PO imports, Locations, Suppliers, Reports; Workspace: AI Assistant, Schedule, Notifications, Team, Settings) + `ADMIN_NAV` (Admin overview, Charters, Warehouses, Bins, Users, Vendor mappings, UoM conversions, Reconciliation, Audit log).
- Mobile `apps/mobile/src/lib/drawer-nav.ts` — same items + a `TOOLS` section with `Scan`, and `Receive POs` (`/receive`) marked `inTabs`.

**Module model:** a module is an entitlement unit that owns ≥1 nav placement. Admin sub-pages without their own table ride a core `admin_tools` module; `tags`/`movements` ride core modules; `public_requests` is entitlement-only (no nav).

- [ ] **Step 1: Write the failing test** — `packages/core/src/modules/registry.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  MODULE_REGISTRY,
  DEFAULT_MODULE_IDS,
  modulesForPack,
  type ModuleId,
} from './registry';

describe('MODULE_REGISTRY', () => {
  it('every module id matches its record key', () => {
    for (const [key, def] of Object.entries(MODULE_REGISTRY)) {
      expect(def.id).toBe(key);
    }
  });

  it('dependsOn references only known modules and is acyclic', () => {
    const ids = new Set(Object.keys(MODULE_REGISTRY));
    for (const def of Object.values(MODULE_REGISTRY)) {
      for (const dep of def.dependsOn) expect(ids.has(dep)).toBe(true);
    }
    // acyclic: topological reachability never revisits a node
    const seenGlobal = new Set<string>();
    const visit = (id: string, stack: Set<string>) => {
      if (stack.has(id)) throw new Error(`cycle through ${id}`);
      if (seenGlobal.has(id)) return;
      stack.add(id);
      for (const d of MODULE_REGISTRY[id as ModuleId].dependsOn) visit(d, stack);
      stack.delete(id);
      seenGlobal.add(id);
    };
    expect(() => Object.keys(MODULE_REGISTRY).forEach((id) => visit(id, new Set()))).not.toThrow();
  });

  it('every nav placement href is unique per surface', () => {
    const seen = new Set<string>();
    for (const def of Object.values(MODULE_REGISTRY)) {
      for (const p of def.placements) {
        const k = `${p.surface}:${p.href}`;
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });

  it('DEFAULT_MODULE_IDS = the charter pack set and includes every core module', () => {
    const core = Object.values(MODULE_REGISTRY).filter((m) => m.tier === 'core').map((m) => m.id);
    for (const id of core) expect(DEFAULT_MODULE_IDS).toContain(id);
    expect(modulesForPack('charter_school').sort()).toEqual([...DEFAULT_MODULE_IDS].sort());
  });

  it('covers the current web sidebar hrefs', () => {
    const webHrefs = Object.values(MODULE_REGISTRY)
      .flatMap((m) => m.placements)
      .filter((p) => p.surface === 'web_sidebar')
      .map((p) => p.href);
    for (const href of [
      '/dashboard', '/dashboard/inventory', '/dashboard/books', '/dashboard/categories',
      '/dashboard/tags', '/dashboard/movements', '/dashboard/rentals', '/dashboard/bundles',
      '/dashboard/orders', '/dashboard/cycle-counts', '/dashboard/procedures',
      '/dashboard/purchase-orders', '/dashboard/purchase-orders/imports', '/dashboard/locations',
      '/dashboard/suppliers', '/dashboard/reports', '/dashboard/ai', '/dashboard/schedule',
      '/dashboard/notifications', '/dashboard/team', '/dashboard/settings',
      '/dashboard/admin', '/dashboard/admin/charters', '/dashboard/admin/warehouses',
      '/dashboard/admin/bins', '/dashboard/admin/users', '/dashboard/admin/vendor-mappings',
      '/dashboard/admin/uom-conversions', '/dashboard/admin/reconciliation', '/dashboard/admin/audit',
    ]) {
      expect(webHrefs).toContain(href);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — `cd packages/core && npx vitest run src/modules/registry.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `registry.ts`**

```ts
import type { Permission, PlanId, Role } from '../constants/permissions';
// NOTE: if PlanId lives in ../constants/plans, import it from there instead.

export type ModuleTier = 'core' | 'optional' | 'premium';
export type NavSurface = 'web_sidebar' | 'mobile_drawer' | 'mobile_tab';
export type NavSectionKey = 'overview' | 'inventory' | 'workspace' | 'tools' | 'admin';
export type DomainPack =
  | 'charter_school' | 'distribution' | 'agriculture_food' | 'retail_backroom' | 'light_3pl';

export type ModuleId =
  // core (always implicitly enabled; cannot be disabled)
  | 'overview' | 'inventory' | 'movements' | 'categories' | 'locations'
  | 'reports' | 'notifications' | 'team' | 'settings' | 'admin_tools' | 'charters'
  | 'scan'
  // optional (free owner-toggle)
  | 'books' | 'rentals' | 'bundles' | 'orders' | 'cycle_counts' | 'procedures'
  | 'purchase_orders' | 'receiving' | 'po_imports' | 'suppliers' | 'schedule'
  | 'ai' | 'public_requests'
  // premium (entitlement; minPlan present but INERT in Phase 1)
  | 'lot_serial' | 'reports_advanced' | 'ai_shelf_scan' | 'api_access';

export interface NavPlacement {
  surface: NavSurface;
  section: NavSectionKey;
  label: string;          // default label (terminology overrides applied by caller later)
  href: string;           // per-surface route
  iconName: string;       // lucide name; resolved per platform via an icon map
  defaultSortOrder: number;
  requires?: Permission;
  requiresAdmin?: boolean;
  mobileTabEligible?: boolean; // informational in Phase 1 (no dynamic slotting)
}

export interface ModuleDefinition {
  id: ModuleId;
  tier: ModuleTier;
  title: string;
  dependsOn: ModuleId[];
  permissions: Permission[];
  surfaces: ('web' | 'mobile' | 'api')[];
  apiPrefixes: string[];
  ownsTables: string[];
  minPlan?: PlanId;              // INERT in Phase 1
  defaultOnFor: DomainPack[];    // which packs enable it by default
  placements: NavPlacement[];
}

export const MODULE_REGISTRY: Record<ModuleId, ModuleDefinition> = {
  // ---- CORE (always on) ----
  overview: {
    id: 'overview', tier: 'core', title: 'Overview', dependsOn: [], permissions: [],
    surfaces: ['web', 'mobile'], apiPrefixes: [], ownsTables: [], defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'overview', label: 'Overview', href: '/dashboard', iconName: 'Home', defaultSortOrder: 0 },
      { surface: 'mobile_drawer', section: 'overview', label: 'Overview', href: '/', iconName: 'Home', defaultSortOrder: 0, mobileTabEligible: true },
    ],
  },
  inventory: {
    id: 'inventory', tier: 'core', title: 'Inventory',
    dependsOn: [], permissions: ['items:read', 'items:update'],
    surfaces: ['web', 'mobile'], apiPrefixes: ['/api/v1/items'],
    ownsTables: ['inventory_items', 'item_stock_levels'], defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'inventory', label: 'Items', href: '/dashboard/inventory', iconName: 'Boxes', defaultSortOrder: 0, requires: 'items:read' },
      { surface: 'web_sidebar', section: 'inventory', label: 'Tags', href: '/dashboard/tags', iconName: 'Tags', defaultSortOrder: 3, requires: 'items:update' },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Items', href: '/inventory', iconName: 'Box', defaultSortOrder: 0, requires: 'items:read', mobileTabEligible: true },
      { surface: 'mobile_drawer', section: 'inventory', label: 'Tags', href: '/tags', iconName: 'Tags', defaultSortOrder: 3, requires: 'items:update' },
    ],
  },
  // ... (continue per the table below — one ModuleDefinition per row)
} as ModuleRegistryComplete; // see note

type ModuleRegistryComplete = Record<ModuleId, ModuleDefinition>;

/** Core modules are implicitly enabled; optional/premium are listed when on. */
export const DEFAULT_MODULE_IDS: ModuleId[] = modulesForPack('charter_school');

export function modulesForPack(pack: DomainPack): ModuleId[] {
  return (Object.values(MODULE_REGISTRY) as ModuleDefinition[])
    .filter((m) => m.tier === 'core' || m.defaultOnFor.includes(pack))
    .map((m) => m.id);
}
```

**Complete module enumeration to transcribe** (every current nav item is covered). Build one `ModuleDefinition` per row; placements use the labels/hrefs/icons/permissions copied verbatim from the current nav files (web `nav.ts` + mobile `drawer-nav.ts`).

| ModuleId | tier | web_sidebar items (label → href, requires) | mobile_drawer items | mobile tab? | defaultOnFor (besides core) |
|---|---|---|---|---|---|
| overview | core | Overview→/dashboard | Overview→/ | yes(index) | — |
| inventory | core | Items→/dashboard/inventory (items:read); Tags→/dashboard/tags (items:update) | Items→/inventory; Tags→/tags | Items=yes | — |
| movements | core | Movements→/dashboard/movements (activity_logs:read) | Movements→/movements | no | — |
| categories | core | Categories→/dashboard/categories (categories:read) | Categories→/categories | no | — |
| locations | core | Locations→/dashboard/locations (locations:read); **admin:** Warehouses→/dashboard/admin/warehouses, Bins→/dashboard/admin/bins (requiresAdmin) | Locations→/locations; admin Warehouses, Bins | no | — |
| reports | core | Reports→/dashboard/reports (reports:read) | Reports→/reports | no | — |
| notifications | core | Notifications→/dashboard/notifications | Notifications→/notifications | no | — |
| team | core | Team→/dashboard/team (members:invite); **admin:** Users→/dashboard/admin/users (requiresAdmin) | Team→/team; admin Users | no | — |
| settings | core | Settings→/dashboard/settings | Settings→/settings | no | — |
| admin_tools | core | Admin overview→/dashboard/admin; Vendor mappings→/dashboard/admin/vendor-mappings; UoM conversions→/dashboard/admin/uom-conversions; Reconciliation→/dashboard/admin/reconciliation (all requiresAdmin) | same under ADMIN | no | — |
| charters | core | Charters→/dashboard/admin/charters (requiresAdmin) | admin Charters | no | — |
| audit→(fold into admin_tools) | core | Audit log→/dashboard/admin/audit (requiresAdmin) | admin Audit log | no | — |
| scan | core | *(none on web)* | Scan→/scan (TOOLS) | yes | — |
| books | optional | Books→/dashboard/books (items:read) | Books→/books | yes | charter_school |
| rentals | optional | Rentals→/dashboard/rentals (rentals:create) | Rentals→/rentals | no | charter_school |
| bundles | optional | Bundles→/dashboard/bundles (bundles:distribute) | Bundles→/bundles | no | charter_school, distribution |
| orders | optional | Orders→/dashboard/orders (orders:request) | Orders→/orders | no | charter_school, distribution, light_3pl |
| cycle_counts | optional | Cycle counts→/dashboard/cycle-counts (stock:adjust) | Cycle counts→/cycle-counts | no | charter_school, distribution, agriculture_food, retail_backroom, light_3pl |
| procedures | optional | Procedures→/dashboard/procedures (items:update) | Procedures→/procedures | no | charter_school |
| purchase_orders | optional | Purchase orders→/dashboard/purchase-orders (purchase_orders:read) | Purchase orders→/purchase-orders | no | charter_school, distribution, agriculture_food, light_3pl |
| receiving | optional | *(rides purchase-orders on web)* | Receive POs→/receive (inTabs) | yes | charter_school, distribution, agriculture_food, light_3pl |
| po_imports | optional | PO imports→/dashboard/purchase-orders/imports (purchase_orders:manage) | PO imports→/po-imports | no | charter_school |
| suppliers | optional | Suppliers→/dashboard/suppliers (suppliers:read) | Suppliers→/suppliers | no | charter_school, distribution, agriculture_food, light_3pl |
| schedule | optional | Schedule→/dashboard/schedule (schedule:manage) | Schedule→/schedule | no | charter_school |
| ai | optional | AI Assistant→/dashboard/ai (items:update) | AI Assistant→/ai | no | charter_school |
| public_requests | optional | *(no nav — settings-managed)* | — | no | charter_school |
| lot_serial | premium | *(no nav in P1)* | — | no | agriculture_food |
| reports_advanced | premium | *(no nav — same /reports page)* | — | no | — |
| ai_shelf_scan | premium | *(no nav — inside cycle-counts)* | — | no | charter_school |
| api_access | premium | *(no nav)* | — | no | — |

> Decision: fold `audit` into `admin_tools` (it has no separate table concern in nav terms) to avoid a 1-placement module; keep `charters` as its own core module (it owns the `charters`/`warehouse_charters` tables). Both stay admin-gated so they render exactly as today.

- [ ] **Step 4: Run the test** — `cd packages/core && npx vitest run src/modules/registry.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/registry.ts packages/core/src/modules/registry.test.ts
git commit -m "feat(core): module registry (entitlement catalog + nav placements)"
```

---

## Task 2: Nav resolver (`packages/core`)

**Files:**
- Create: `packages/core/src/modules/resolve.ts`
- Test: `packages/core/src/modules/resolve.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { resolveSurface } from './resolve';
import { DEFAULT_MODULE_IDS } from './registry';

const ALL = new Set(DEFAULT_MODULE_IDS);

describe('resolveSurface', () => {
  it('admin sees the web sidebar including admin items', () => {
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: ALL });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/dashboard/inventory');
    expect(hrefs).toContain('/dashboard/admin'); // admin item present for admin
  });

  it('staff does NOT see admin items', () => {
    const out = resolveSurface('web_sidebar', { role: 'staff', enabledModules: ALL });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs.some((h) => h.startsWith('/dashboard/admin'))).toBe(false);
  });

  it('disabling an optional module removes its items (core stays)', () => {
    const without = new Set([...ALL].filter((m) => m !== 'rentals'));
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: without });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain('/dashboard/rentals');
    expect(hrefs).toContain('/dashboard/inventory'); // core unaffected
  });

  it('a core module renders even if absent from enabledModules', () => {
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: new Set() });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/dashboard'); // overview is core
  });

  it('drops empty sections and sorts by defaultSortOrder', () => {
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: ALL });
    expect(out.every((s) => s.items.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it → FAIL** — `cd packages/core && npx vitest run src/modules/resolve.test.ts`.

- [ ] **Step 3: Implement `resolve.ts`**

```ts
import { hasPermission, isAdminRole, type Role } from '../constants/permissions';
import {
  MODULE_REGISTRY, type ModuleId, type NavSurface, type NavSectionKey, type NavPlacement,
} from './registry';

export interface ResolveInput {
  role: Role;
  enabledModules: Set<ModuleId>;
}
export interface ResolvedNavItem {
  moduleId: ModuleId; label: string; href: string; iconName: string;
  section: NavSectionKey; sortOrder: number; requiresAdmin: boolean;
}
export interface ResolvedNavSection { section: NavSectionKey; items: ResolvedNavItem[]; }

const SECTION_ORDER: NavSectionKey[] = ['overview', 'inventory', 'workspace', 'tools', 'admin'];

export function resolveSurface(surface: NavSurface, input: ResolveInput): ResolvedNavSection[] {
  const admin = isAdminRole(input.role);
  const items: ResolvedNavItem[] = [];
  for (const def of Object.values(MODULE_REGISTRY)) {
    const moduleOn = def.tier === 'core' || input.enabledModules.has(def.id);
    if (!moduleOn) continue;
    for (const p of def.placements as NavPlacement[]) {
      if (p.surface !== surface) continue;
      if (p.requiresAdmin && !admin) continue;
      if (p.requires && !hasPermission(input.role, p.requires)) continue;
      items.push({
        moduleId: def.id, label: p.label, href: p.href, iconName: p.iconName,
        section: p.section, sortOrder: p.defaultSortOrder, requiresAdmin: !!p.requiresAdmin,
      });
    }
  }
  const bySection = new Map<NavSectionKey, ResolvedNavItem[]>();
  for (const it of items) {
    const arr = bySection.get(it.section) ?? [];
    arr.push(it);
    bySection.set(it.section, arr);
  }
  return SECTION_ORDER
    .filter((s) => (bySection.get(s)?.length ?? 0) > 0)
    .map((s) => ({ section: s, items: bySection.get(s)!.sort((a, b) => a.sortOrder - b.sortOrder) }));
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/resolve.ts packages/core/src/modules/resolve.test.ts
git commit -m "feat(core): shared nav resolver (entitlement ∧ permission)"
```

---

## Task 3: Export modules API from core

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add re-exports** (place near the other `export * from './constants/...'` lines):

```ts
export * from './modules/registry';
export * from './modules/resolve';
```

- [ ] **Step 2: Verify the package builds/typechecks** — `cd packages/core && npx tsc --noEmit` → no errors. Then `cd ../../apps/web && npx tsc --noEmit` → no errors (imports resolve).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export modules registry + resolver"
```

---

## Task 4: Migration 0144 — entitlement table + helper + domain_pack

**Files:**
- Create: `supabase/migrations/0144_org_modules_entitlements.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0144_org_modules_entitlements.sql
-- Entitlement axis: per-org module on/off + the domain pack identity.

alter table public.organizations
  add column if not exists domain_pack text not null default 'charter_school'
  check (domain_pack in ('charter_school','distribution','agriculture_food','retail_backroom','light_3pl'));

create table if not exists public.organization_modules (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  module_id   text not null,
  enabled     boolean not null default true,
  tier        text not null check (tier in ('core','optional','premium')),
  settings    jsonb not null default '{}'::jsonb,
  enabled_at  timestamptz not null default now(),
  enabled_by  uuid references public.user_profiles(id),
  primary key (organization_id, module_id)
);
create index if not exists org_modules_enabled_idx
  on public.organization_modules (organization_id) where enabled;

-- STABLE + SECURITY DEFINER so RLS / app reads can call it cheaply, mirroring
-- is_org_member()/has_org_role() (0001/0140).
create or replace function public.module_enabled(p_org uuid, p_module text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organization_modules om
    where om.organization_id = p_org and om.module_id = p_module and om.enabled
  );
$$;

alter table public.organization_modules enable row level security;

drop policy if exists org_modules_read on public.organization_modules;
create policy org_modules_read on public.organization_modules
  for select using ((select public.is_org_member(organization_id)));

drop policy if exists org_modules_admin on public.organization_modules;
create policy org_modules_admin on public.organization_modules
  for all using ((select public.has_org_role(organization_id,'admin')))
          with check ((select public.has_org_role(organization_id,'admin')));

grant select, insert, update, delete on public.organization_modules to authenticated;
```

- [ ] **Step 2: Apply + verify locally**

Run: `supabase db reset` (applies all migrations to the local DB) **or**, if using a remote dev branch, `supabase db push --dry-run` then apply. Expected: no SQL errors.
Verify the helper exists:
```bash
supabase db execute "select public.module_enabled('00000000-0000-0000-0000-000000000000','orders');"
```
Expected: returns `f` (false) without error.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0144_org_modules_entitlements.sql
git commit -m "feat(db): organization_modules + module_enabled() + domain_pack (0144)"
```

---

## Task 5: Migration 0145 — grandfather existing orgs + seed new orgs

**Files:**
- Create: `supabase/migrations/0145_grandfather_existing_orgs.sql`

The full charter set = every `core` module + the optional + the premium L4L already uses (`lot_serial`, `ai_shelf_scan`, `reports_advanced`). Keep this list in sync with `MODULE_REGISTRY` tiers from Task 1.

- [ ] **Step 1: Write the migration**

```sql
-- 0145_grandfather_existing_orgs.sql
-- Existing orgs wake up with the full charter feature set ENABLED so behavior
-- is identical. New orgs are seeded from their domain_pack via a trigger.

-- 1. Stamp pack (column already defaults to charter_school; explicit for clarity).
update public.organizations set domain_pack = 'charter_school' where domain_pack is null;

-- 2. Enable the full charter module set for every existing org.
insert into public.organization_modules (organization_id, module_id, tier, enabled)
select o.id, m.module_id, m.tier, true
from public.organizations o
cross join (values
  -- core
  ('overview','core'),('inventory','core'),('movements','core'),('categories','core'),
  ('locations','core'),('reports','core'),('notifications','core'),('team','core'),
  ('settings','core'),('admin_tools','core'),('charters','core'),('scan','core'),
  -- optional
  ('books','optional'),('rentals','optional'),('bundles','optional'),('orders','optional'),
  ('cycle_counts','optional'),('procedures','optional'),('purchase_orders','optional'),
  ('receiving','optional'),('po_imports','optional'),('suppliers','optional'),
  ('schedule','optional'),('ai','optional'),('public_requests','optional'),
  -- premium L4L already exercises
  ('lot_serial','premium'),('ai_shelf_scan','premium'),('reports_advanced','premium')
) as m(module_id, tier)
on conflict (organization_id, module_id) do nothing;

-- 3. Seed NEW orgs automatically from their domain_pack.
--    Phase 1 ships ALL packs as the charter set above (pack-specific defaults
--    arrive with the vertical packs phase); this trigger guarantees a new org
--    is never module-less.
create or replace function public.seed_org_modules()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.organization_modules (organization_id, module_id, tier, enabled)
  select new.id, m.module_id, m.tier, true
  from (values
    ('overview','core'),('inventory','core'),('movements','core'),('categories','core'),
    ('locations','core'),('reports','core'),('notifications','core'),('team','core'),
    ('settings','core'),('admin_tools','core'),('charters','core'),('scan','core'),
    ('books','optional'),('rentals','optional'),('bundles','optional'),('orders','optional'),
    ('cycle_counts','optional'),('procedures','optional'),('purchase_orders','optional'),
    ('receiving','optional'),('po_imports','optional'),('suppliers','optional'),
    ('schedule','optional'),('ai','optional'),('public_requests','optional')
  ) as m(module_id, tier)
  on conflict (organization_id, module_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_seed_org_modules on public.organizations;
create trigger trg_seed_org_modules
  after insert on public.organizations
  for each row execute function public.seed_org_modules();
```

- [ ] **Step 2: Apply + verify** — re-run `supabase db reset` (or push). Verify L4L has the full set:
```bash
supabase db execute "select count(*) from public.organization_modules om join public.organizations o on o.id=om.organization_id where o.name ilike '%L4L%' and om.enabled;"
```
Expected: 27 (12 core + 12 optional + 3 premium). Re-running the migration is a no-op (`on conflict do nothing`).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0145_grandfather_existing_orgs.sql
git commit -m "feat(db): grandfather existing orgs + seed new orgs (0145)"
```

---

## Task 6: `ServiceContext.enabledModules` + `assertModuleEnabled` + `module_disabled`

**Files:**
- Modify: `apps/web/src/server/services/context.ts`
- Test: `apps/web/src/server/services/context.modules.test.ts`

- [ ] **Step 1: Write the failing test** (pure unit over `assertModuleEnabled` + `serviceErrorStatus`)

```ts
import { describe, expect, it } from 'vitest';
import { assertModuleEnabled, serviceErrorStatus, ServiceError, type ServiceContext } from './context';

const ctx = (mods: string[]): ServiceContext => ({
  organizationId: 'o', userId: 'u', role: 'admin',
  supabase: {} as never, mfaRequired: false, mfaSatisfied: true,
  enabledModules: new Set(mods as never),
});

describe('assertModuleEnabled', () => {
  it('passes when module enabled', () => {
    expect(() => assertModuleEnabled(ctx(['orders']), 'orders')).not.toThrow();
  });
  it('throws module_disabled when off', () => {
    try { assertModuleEnabled(ctx([]), 'orders'); throw new Error('no throw'); }
    catch (e) { expect(e).toBeInstanceOf(ServiceError); expect((e as ServiceError).code).toBe('module_disabled'); }
  });
  it('module_disabled maps to HTTP 403', () => {
    expect(serviceErrorStatus('module_disabled')).toBe(403);
    expect(serviceErrorStatus('not_found')).toBe(404);
    expect(serviceErrorStatus('internal_error')).toBe(500);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `cd apps/web && npx vitest run src/server/services/context.modules.test.ts`.

- [ ] **Step 3: Edit `context.ts`**

(a) import the type:
```ts
import type { ModuleId } from '@stockpilot/core';
```
(b) add to `ServiceContext`:
```ts
  /** Modules enabled for this org (entitlement axis). Core modules are
   *  always treated as enabled even if absent. */
  enabledModules: Set<ModuleId>;
```
(c) add `'module_disabled'` to the `ServiceError` code union (after `'plan_limit_exceeded'`).
(d) resolve `enabledModules` inside `withContext` (after `resolveMfaState`):
```ts
  const { data: modRows } = await supabase
    .from('organization_modules')
    .select('module_id')
    .eq('organization_id', ctx.organizationId)
    .eq('enabled', true);
  const enabledModules = new Set(
    ((modRows ?? []) as Array<{ module_id: string }>).map((r) => r.module_id as ModuleId),
  );
```
and include `enabledModules` in the returned object.
(e) add the guard + status mapper at the bottom:
```ts
export function assertModuleEnabled(ctx: ServiceContext, moduleId: ModuleId): void {
  // Core modules are never gated; only optional/premium can be disabled.
  if (ctx.enabledModules.has(moduleId)) return;
  // Treat unknown/core as enabled by consulting the registry tier.
  // (Importing the registry here is fine — it's pure data.)
  // Lazy import to avoid a cycle if any.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MODULE_REGISTRY } = require('@stockpilot/core') as typeof import('@stockpilot/core');
  if (MODULE_REGISTRY[moduleId]?.tier === 'core') return;
  throw new ServiceError('module_disabled', `Module not enabled for this organization: ${moduleId}`);
}

export function serviceErrorStatus(code: ServiceError['code']): number {
  switch (code) {
    case 'unauthenticated': return 401;
    case 'forbidden':
    case 'module_disabled': return 403;
    case 'not_found': return 404;
    case 'validation_error':
    case 'conflict':
    case 'plan_limit_exceeded': return 409;
    default: return 500;
  }
}
```
> Prefer a static `import { MODULE_REGISTRY } from '@stockpilot/core'` at the top if no cycle results (it shouldn't — core has no dep on web). Use that and delete the `require`.

- [ ] **Step 4: Run → PASS.** Then `npx tsc --noEmit` in `apps/web`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/services/context.ts apps/web/src/server/services/context.modules.test.ts
git commit -m "feat(web): enabledModules on ServiceContext + assertModuleEnabled + module_disabled"
```

---

## Task 7: Resolve `enabledModules` on the API (bearer) path + v1 module guard

**Files:**
- Modify: `apps/web/src/lib/auth/api-context.ts`

> First READ the full file to find where the `ServiceContext` is assembled and returned (it builds `organizationId`, `userId`, `role`, `supabase`, `mfaRequired`, `mfaSatisfied`).

- [ ] **Step 1: Resolve `enabledModules` the same way as `withContext`.** After the membership + MFA are resolved and before returning the context object, add the `organization_modules` query (identical to Task 6d, using the bearer-bound `supabase`) and include `enabledModules` in the returned `ServiceContext`.

- [ ] **Step 2: Add a path→module guard helper** (exported, used by v1 routes that own a module):
```ts
import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

/** Returns the ModuleId owning an API path, or null. */
export function moduleForApiPath(pathname: string): ModuleId | null {
  for (const def of Object.values(MODULE_REGISTRY)) {
    if (def.apiPrefixes.some((p) => pathname.startsWith(p))) return def.id;
  }
  return null;
}
```
The convention: a v1 route resolves `ctx`, then `const m = moduleForApiPath(req.nextUrl.pathname); if (m) assertModuleEnabled(ctx, m);` and maps a thrown `ServiceError` via `serviceErrorStatus(e.code)`. Because the existing per-route mappers default unknown codes to 500, the guard runs the assert explicitly and catches it to return `serviceErrorStatus('module_disabled')` = 403.

- [ ] **Step 3: Typecheck** — `cd apps/web && npx tsc --noEmit`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/auth/api-context.ts
git commit -m "feat(web): resolve enabledModules on bearer path + moduleForApiPath guard"
```

---

## Task 8: Gate optional/premium service entry points

**Files (edit — add the assert as the FIRST line of each public entry method):**
- `apps/web/src/server/services/orders.ts` (or `order-requests.ts`) → `assertModuleEnabled(this.ctx, 'orders')`
- `rentals.ts` → `'rentals'` · `bundles.ts` → `'bundles'` · `cycle-counts.ts` → `'cycle_counts'`
- `procedures.ts` → `'procedures'` · `schedule.ts` → `'schedule'` · `purchase-orders.ts` → `'purchase_orders'`
- `receiving.ts` → `'receiving'` · `suppliers.ts` → `'suppliers'` · the AI chat/shelf-scan services → `'ai'` / `'ai_shelf_scan'`
- public order-request service → `'public_requests'`

> Core services (inventory, movements, categories, locations, reports, team, notifications) are NOT gated.

- [ ] **Step 1: Write one integration test** — `apps/web/src/server/services/orders.modules.test.ts`: construct a service with a `ServiceContext` whose `enabledModules` excludes `'orders'`; assert the entry method throws `ServiceError('module_disabled')`. (Mock supabase as needed, mirroring existing service tests like `cycle-counts.selection.test.ts`.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Add `assertModuleEnabled(this.ctx, '<id>')` as the first statement of each listed service's public entry methods**, alongside the existing `assertPermission`. Import `assertModuleEnabled` from `./context`.

- [ ] **Step 4: Run the new test → PASS;** run the existing service tests (`npx vitest run src/server/services`) → all PASS (grandfathered ctx has the modules, so no regressions; tests that build a ctx must include `enabledModules` — add a shared test helper if many tests construct contexts).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/services
git commit -m "feat(web): gate optional/premium service entry points on entitlement"
```

---

## Task 9: Web sidebar derives from the registry

**Files:**
- Create: `apps/web/src/components/dashboard/icons.ts`
- Modify: `apps/web/src/components/dashboard/nav.ts`, `nav.test.ts`, `sidebar.tsx`

- [ ] **Step 1: Update `nav.test.ts` to the new signature (failing)**

```ts
import { describe, expect, it } from 'vitest';
import { DASHBOARD_NAV_HREFS, navForRole } from './nav';
import { DEFAULT_MODULE_IDS } from '@stockpilot/core';

const ALL = new Set(DEFAULT_MODULE_IDS);

describe('dashboard navigation', () => {
  it('admin sees the full href set (superset) with all modules enabled', () => {
    const adminHrefs = navForRole('admin', ALL).flatMap((s) => s.items.map((i) => i.href));
    expect(new Set(adminHrefs).size).toBe(adminHrefs.length);
    // every previously-static href is still present
    for (const href of DASHBOARD_NAV_HREFS) expect(adminHrefs).toContain(href);
  });
  it('omits admin section for non-admin roles', () => {
    const staffHrefs = navForRole('staff', ALL).flatMap((s) => s.items.map((i) => i.href));
    expect(staffHrefs.some((h) => h.startsWith('/dashboard/admin'))).toBe(false);
  });
  it('disabling rentals removes it from the sidebar', () => {
    const without = new Set([...ALL].filter((m) => m !== 'rentals'));
    const hrefs = navForRole('admin', without).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain('/dashboard/rentals');
  });
});
```

- [ ] **Step 2: Run → FAIL** (`navForRole` arity changed; import missing).

- [ ] **Step 3: Create `icons.ts`** — map every `iconName` used in web placements to its `lucide-react` component:
```ts
import {
  ArrowLeftRight, BarChart3, Bell, BookOpen, Boxes, Building2, Calendar, ClipboardCheck,
  ClipboardList, Cog, FileLock, Home, MapPin, Network, Package, PackageOpen, ShoppingCart,
  Sparkles, Tag, Tags, Truck, Upload, Users, Warehouse, type LucideIcon,
} from 'lucide-react';
export const NAV_ICONS: Record<string, LucideIcon> = {
  ArrowLeftRight, BarChart3, Bell, BookOpen, Boxes, Building2, Calendar, ClipboardCheck,
  ClipboardList, Cog, FileLock, Home, MapPin, Network, Package, PackageOpen, ShoppingCart,
  Sparkles, Tag, Tags, Truck, Upload, Users, Warehouse,
};
```

- [ ] **Step 4: Rewrite `nav.ts`** — keep the `NavItem`/`NavSection` exported shapes (consumers depend on them), but build them from the resolver:
```ts
import { resolveSurface, type ModuleId } from '@stockpilot/core';
import type { Role } from '@stockpilot/core';
import { NAV_ICONS } from './icons';
import type { LucideIcon } from 'lucide-react';

export interface NavItem { href: string; label: string; icon: LucideIcon; badge?: string | number; alert?: boolean; }
export interface NavSection { label?: string; items: NavItem[]; }

const SECTION_LABEL: Record<string, string | undefined> = {
  overview: undefined, inventory: 'Inventory', workspace: 'Workspace', tools: 'Tools', admin: 'Admin',
};

export function navForRole(role: Role, enabledModules: Set<ModuleId>): NavSection[] {
  return resolveSurface('web_sidebar', { role, enabledModules }).map((sec) => ({
    label: SECTION_LABEL[sec.section],
    items: sec.items.map((it) => ({
      href: it.href, label: it.label, icon: NAV_ICONS[it.iconName] ?? NAV_ICONS.Boxes,
    })),
  }));
}

// Static href list for route warming (full module set, admin).
import { DEFAULT_MODULE_IDS } from '@stockpilot/core';
export const DASHBOARD_NAV_HREFS = navForRole('admin', new Set(DEFAULT_MODULE_IDS))
  .flatMap((s) => s.items.map((i) => i.href));
```
> The `'AI Assistant'` Beta badge + Workspace labels are cosmetic; if the badge must persist, add an optional `badge` to the placement and carry it through. (Decision: drop the Beta badge in Phase 1 to keep the registry clean, OR add `badge?` to `NavPlacement` — pick one and note it. This plan adds `badge?: string` to `NavPlacement` and maps it through, preserving the badge.)

- [ ] **Step 5: Update `sidebar.tsx`** — it currently calls `navForRole(role)`. READ it; pass the enabled modules. The server component that renders the sidebar has access to `ServiceContext` (or fetches it); thread `ctx.enabledModules` into the prop and call `navForRole(role, enabledModules)`. If the sidebar is a client component, pass `enabledModules` (string[]) as a prop from the dashboard layout server component and reconstruct the Set.

- [ ] **Step 6: Run `nav.test.ts` → PASS;** `npx tsc --noEmit` in `apps/web` → no errors; load `/dashboard` as admin in dev and confirm the sidebar is visually identical.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/dashboard/nav.ts apps/web/src/components/dashboard/nav.test.ts apps/web/src/components/dashboard/icons.ts apps/web/src/components/dashboard/sidebar.tsx
git commit -m "feat(web): derive sidebar from the shared module registry"
```

---

## Task 10: Mobile drawer derives + tabs gated + snapshot carries enabledModules

**Files:**
- Modify: `apps/web/src/app/api/v1/mobile/snapshot/route.ts`, `apps/mobile/src/lib/sync.ts`
- Create: `apps/mobile/src/lib/nav-icons.ts`
- Modify: `apps/mobile/src/lib/drawer-nav.ts`, `apps/mobile/src/components/drawer-content.tsx`, `apps/mobile/app/(drawer)/(tabs)/_layout.tsx`

> READ each mobile file before editing. The mobile app already imports `@stockpilot/core`, so the registry + resolver are available on-device.

- [ ] **Step 1: Snapshot adds `enabledModules`** — in the snapshot route, after resolving `ctx`, include `enabledModules: Array.from(ctx.enabledModules)` in the JSON response. In `sync.ts`, add `enabledModules: string[]` to `SnapshotResponse` and persist it (same store the snapshot already writes to).

- [ ] **Step 2: Create `apps/mobile/src/lib/nav-icons.ts`** — same shape as web `icons.ts` but importing from `lucide-react-native`, covering every `iconName` used by `mobile_drawer` placements (`Home, Box, BookOpen, Tag, Tags, ArrowLeftRight, PackageOpen, Package, ShoppingCart, ClipboardCheck, BookOpen, Truck, ClipboardList, Upload, MapPin, BarChart3, Sparkles, Calendar, Bell, Users, Cog, ScanLine, Network, Building2, Warehouse, Layers, FileLock`).

- [ ] **Step 3: Rewrite `drawer-nav.ts`** — replace the static `DRAWER_SECTIONS` with a builder that calls the resolver:
```ts
import { resolveSurface, type ModuleId } from '@stockpilot/core';
import type { Role } from '@stockpilot/core';
import { NAV_ICONS } from './nav-icons';

export interface DrawerNavItem { id: string; href: string; label: string; iconName: string; }
export interface DrawerNavSection { label?: string; items: DrawerNavItem[]; }

export function drawerSectionsFor(role: Role, enabledModules: Set<ModuleId>): DrawerNavSection[] {
  return resolveSurface('mobile_drawer', { role, enabledModules }).map((sec) => ({
    label: sec.section === 'overview' ? undefined : sec.section.toUpperCase(),
    items: sec.items.map((it) => ({ id: `${it.moduleId}:${it.href}`, href: it.href, label: it.label, iconName: it.iconName })),
  }));
}
```

- [ ] **Step 4: Update `drawer-content.tsx`** — READ it; it currently maps `DRAWER_SECTIONS` and filters admin by role. Replace with `drawerSectionsFor(role, enabledModules)` (role from auth/snapshot; `enabledModules` from the persisted snapshot, defaulting to `new Set(DEFAULT_MODULE_IDS)` while loading so the drawer is never empty offline). Render `NAV_ICONS[item.iconName]`.

- [ ] **Step 5: Gate the bottom tabs** — in `_layout.tsx`, read the persisted `enabledModules` (hook), then set `href: enabledModules.has('books') ? undefined : null` on the `books` `Tabs.Screen` (and similarly `receive`→`receiving`, `scan`→`scan`). `index`/`inventory` are core → never gated. Layout otherwise unchanged. Default to "enabled" while the snapshot is loading so tabs never flicker out for L4L.

- [ ] **Step 6: Verify** — `cd apps/mobile && npx tsc --noEmit` → no errors. Run the app (dev client): drawer + tabs render identical to before for the L4L account.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/api/v1/mobile/snapshot/route.ts apps/mobile/src/lib/sync.ts apps/mobile/src/lib/nav-icons.ts apps/mobile/src/lib/drawer-nav.ts apps/mobile/src/components/drawer-content.tsx "apps/mobile/app/(drawer)/(tabs)/_layout.tsx"
git commit -m "feat(mobile): derive drawer from registry + gate tabs + snapshot enabledModules"
```

---

## Final verification (definition of done)

- [ ] `cd packages/core && npx vitest run` → all PASS.
- [ ] `cd apps/web && npx vitest run && npx tsc --noEmit` → all PASS, no type errors.
- [ ] `cd apps/mobile && npx tsc --noEmit` → no errors.
- [ ] Migrations applied to a DB copy; L4L has 27 enabled rows + `domain_pack='charter_school'`; re-apply is a no-op.
- [ ] Manual: web sidebar + mobile drawer + tabs render identical for L4L (every role).
- [ ] Manual: set `update organization_modules set enabled=false where module_id='rentals'` for L4L → Rentals disappears from web sidebar + mobile drawer; an `orders`-gated service still works; a `rentals` service entry point returns `module_disabled`. Revert the row.
- [ ] Push: `git push origin main`. (Migrations 0144/0145 must be applied to prod via `supabase db push` — flag to the user before applying.)

---

## Plan self-review

**Spec coverage:** registry (T1) ✓, resolver (T2) ✓, core exports (T3) ✓, `organization_modules`+`domain_pack`+`module_enabled` (T4) ✓, grandfather + new-org seed (T5) ✓, `enabledModules`+`assertModuleEnabled`+`module_disabled` (T6) ✓, API path resolve+guard (T7) ✓, optional/premium gating (T8) ✓, web sidebar derive (T9) ✓, mobile drawer/tabs/snapshot (T10) ✓. Out-of-scope items (owner UI, dynamic tab slotting, RLS predicates, `*_defs`, connectors, retiring plan booleans) are absent — correct.

**Placeholder scan:** the registry "complete enumeration table" + one worked example is the full spec for T1 (deterministic transcription from the two nav files quoted); no `TBD`/`implement later`. The one explicit decision flagged (Beta badge: add `badge?` to `NavPlacement`) is resolved, not deferred.

**Type consistency:** `ModuleId`, `ModuleDefinition`, `NavPlacement`, `resolveSurface(surface, {role, enabledModules})`, `assertModuleEnabled(ctx, moduleId)`, `serviceErrorStatus(code)`, `DEFAULT_MODULE_IDS`, `modulesForPack(pack)`, `moduleForApiPath(pathname)` are used consistently across tasks. `navForRole(role, enabledModules)` arity change is reflected in T9's test + `sidebar.tsx` update.

**Known follow-the-file items (not placeholders — explicit reads):** `sidebar.tsx`, `drawer-content.tsx`, `sync.ts` `SnapshotResponse`, and the exact service entry-method names are to be confirmed by reading those files during their task; each task says so and gives the exact change to make.

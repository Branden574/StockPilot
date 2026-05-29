# Configurable Warehouse OS — Phase 1 (Foundation) Design Spec

**Date:** 2026-05-29
**Status:** Approved for planning
**Parent review:** [docs/strategy/2026-05-29-stockpilot-warehouse-os-review.md](../../strategy/2026-05-29-stockpilot-warehouse-os-review.md) (read its *Canonical reconciliation decisions* section — it is authoritative; this spec implements its Phase 1).

---

## Goal

Introduce the **entitlement axis** — a third authorization dimension (orthogonal to roles and RLS tenancy) that answers *"which modules exist for this org at all"* — as pure foundation. Ship the shared module registry, the `organization_modules` table, the `module_enabled()` helper, the grandfather migration, the `assertModuleEnabled` service guard, and **derive web sidebar + mobile drawer from the registry**, with **zero user-visible change** for the existing org (L4L Fresno).

The composition rule is a strict AND that can only *reduce* surface area:

```
visible/allowed ⇔ is_org_member(org)            -- tenancy (RLS, unchanged)
             AND  module_enabled(org, moduleId)  -- entitlement (NEW)
             AND  hasPermission(role, perm)      -- role matrix (unchanged)
             AND  mfaSatisfied (mutations)        -- AAL2 (unchanged)
```

An entitlement never *grants* anything; disabling a module can only remove surface area. This keeps the security model conservative.

## Scope

**In scope (Phase 1 = "plumbing only, zero UX change"):**
1. Shared module registry in `packages/core/src/modules/registry.ts`.
2. Shared nav resolver in `packages/core/src/modules/resolve.ts`.
3. `organization_modules` table + `organizations.domain_pack` column + `module_enabled(org, module)` SECURITY DEFINER helper (migration `0144`).
4. Grandfather migration enabling the full charter set for all existing orgs (migration `0145`).
5. `enabledModules: Set<ModuleId>` on `ServiceContext` + `assertModuleEnabled(ctx, moduleId)` + new `ServiceError` code `module_disabled` → HTTP 403.
6. `assertModuleEnabled` wired into the entry-point methods of **optional/premium** module services (core modules ungated).
7. Web sidebar (`nav.ts`) + mobile drawer (`drawer-nav.ts`/`drawer-content.tsx`) **derived from the registry** via the shared resolver. Per-platform icon-name → component maps.
8. Mobile bottom tabs: keep the existing 5 route files; gate visibility via `href:null` when the owning module is disabled. **Layout unchanged.**
9. Mobile snapshot (`/api/v1/mobile/snapshot`) carries `enabledModules`.

**Explicitly OUT of scope (later phases):**
- Owner-facing Settings → Modules toggle UI (Phase 2).
- Dynamic mobile tab-slotting / `organization_nav_overrides` / per-user nav prefs (Phase 2).
- Selective RLS `module_enabled()` predicates on write tables (Phase 1.5).
- Custom fields/statuses/document templates/notification registry (`*_defs` tables) (Phase 2).
- Connector framework / Square / Shopify / QuickBooks / carriers (Phase 3).
- Net-new modules: transfers w/ in-transit, returns/RMA, quality holds, traceability enforcement (Phase 5).
- Retiring/repurposing the `plans.ts` booleans. **Billing stays dormant; entitlements are an owner-toggle, not plan-gated.** `minPlan` exists on the registry but is **inert** in Phase 1.

## Success criteria (definition of done)

- L4L's web sidebar, mobile drawer, and bottom tabs render **byte-identical** before/after (snapshot-tested for every role).
- Setting an `organization_modules` row to `enabled=false` (by hand in the DB) makes that module disappear from the web sidebar, mobile drawer, and tab bar, and its optional/premium service entry points + v1 routes return `module_disabled`/403.
- `nav.test.ts` passes (updated to drive `navForRole(role, enabledModules)`).
- The grandfather migration is idempotent and verified on a DB copy; L4L ends with the full module set + `domain_pack='charter_school'`.
- No existing write path breaks (no RLS gating added in Phase 1; the guard no-ops for grandfathered orgs).

---

## Architecture

### Module registry — `packages/core/src/modules/registry.ts`

One declarative `ModuleDefinition` per module, merging entitlement metadata and nav placements so web + mobile read a single source.

```ts
export type ModuleId =
  // core (always implicitly enabled; cannot be disabled)
  | 'inventory' | 'movements' | 'locations' | 'categories'
  | 'team' | 'audit' | 'reports_basic' | 'notifications'
  // optional (free owner-toggle)
  | 'purchase_orders' | 'receiving' | 'suppliers' | 'po_imports'
  | 'cycle_counts' | 'orders' | 'bundles' | 'rentals'
  | 'schedule' | 'procedures' | 'books' | 'public_requests'
  | 'shipments' | 'charters'
  // premium (entitlement; minPlan present but INERT in Phase 1)
  | 'lot_serial' | 'reports_advanced' | 'ai_assistant' | 'ai_shelf_scan'
  | 'api_access';
  // NOTE: net-new modules (traceability, pos_sync, accounting_sync,
  // shipping_sync, transfers, returns, quality) are NOT declared in Phase 1.

export type ModuleTier = 'core' | 'optional' | 'premium';
export type NavSurface = 'web_sidebar' | 'mobile_drawer' | 'mobile_tab';
export type NavSectionKey = 'overview' | 'inventory' | 'workspace' | 'admin';
export type DomainPack =
  | 'charter_school' | 'distribution' | 'agriculture_food'
  | 'retail_backroom' | 'light_3pl';

export interface NavPlacement {
  surface: NavSurface;
  section: NavSectionKey;
  href: string;               // per-surface (web + mobile routes differ)
  iconName: string;           // lucide name; resolved per platform via icon map
  defaultVisible: boolean;
  defaultSortOrder: number;
  mobileTabEligible: boolean; // informational in Phase 1 (no dynamic slotting yet)
  requires?: Permission;      // existing permission gate (unchanged matrix)
  requiresAdmin?: boolean;
}

export interface ModuleDefinition {
  id: ModuleId;
  tier: ModuleTier;
  title: string;
  description: string;
  dependsOn: ModuleId[];      // enforced when toggling (Phase 2 UI); validated in tests now
  permissions: Permission[];  // permissions this module owns (namespaced)
  surfaces: ('web' | 'mobile' | 'api')[];
  apiPrefixes: string[];      // v1 route prefixes this module owns (for the API middleware)
  ownsTables: string[];       // used by grandfather + future RLS work
  settingsSchema?: Record<string, { type: 'string'|'boolean'|'number'|'enum'; enum?: string[]; default?: unknown }>;
  minPlan?: PlanId;           // INERT in Phase 1
  defaultOnFor: DomainPack[]; // which packs enable it by default
  placements: NavPlacement[];
}

export const MODULE_REGISTRY: Record<ModuleId, ModuleDefinition> = { /* … */ };

/** core ∪ modules whose defaultOnFor includes the pack. */
export function modulesForPack(pack: DomainPack): ModuleId[];
```

**Coverage requirement:** the registry MUST contain a placement for every current nav entry so the derived nav is 1:1 with today's static nav. Mapping reference (verify against the live files during implementation):
- Web `BASE_NAV` (18 items, `apps/web/src/components/dashboard/nav.ts`): Overview→`inventory` placement on overview section… each item maps to a module placement.
- Web `ADMIN_NAV` (9 items): map to `team`/`audit`/`charters`/`categories`/admin placements.
- Mobile `DRAWER_SECTIONS` (`apps/mobile/src/lib/drawer-nav.ts`): same modules, `mobile_drawer` placements.
- Mobile tabs (`apps/mobile/app/(drawer)/(tabs)/_layout.tsx`): Home/Items/Books/POs(receive)/Scan → `mobile_tab` placements with `mobileTabEligible: true`.

**Tier classification** (per the review): `inventory, movements, locations, categories, team, audit, reports_basic, notifications` = **core** (no "off"); the workflow modules = **optional**; `lot_serial, reports_advanced, ai_assistant, ai_shelf_scan, api_access` = **premium** (toggle freely; `minPlan` inert).

**Icons:** the registry stores `iconName` strings (not components, because `nav.ts` currently imports lucide components and `lucide-react` ≠ `lucide-react-native`). Each app keeps a small `ICONS: Record<string, IconComponent>` map. This is the only platform-specific shim.

### Nav resolver — `packages/core/src/modules/resolve.ts`

```ts
export interface ResolveInput {
  role: Role;
  enabledModules: Set<ModuleId>;
}
export interface ResolvedNavItem {
  moduleId: ModuleId; href: string; iconName: string;
  label: string; section: NavSectionKey; sortOrder: number;
}
/** Pure function — web + mobile call it identically (kills nav drift). */
export function resolveSurface(surface: NavSurface, input: ResolveInput): ResolvedNavSection[];
```

Resolution per item: render iff `enabledModules.has(module)` (skipped for `core`, which is always on) ∧ permission/admin checks pass ∧ a placement exists for the surface. Then group by section, sort by `defaultSortOrder`, label via terminology (existing `resolveTerminology`). Empty sections are pruned (existing behavior).

### Data model + migrations

`organizations` today has `industry text` and `plan text` (free/pro/business/enterprise); **no `domain_pack`**. Highest migration is **`0143`** (139 files).

**`0144_org_modules_entitlements.sql`:**
```sql
alter table organizations
  add column if not exists domain_pack text not null default 'charter_school'
  check (domain_pack in ('charter_school','distribution','agriculture_food','retail_backroom','light_3pl'));

create table organization_modules (
  organization_id uuid not null references organizations(id) on delete cascade,
  module_id   text not null,
  enabled     boolean not null default true,
  tier        text not null,
  settings    jsonb not null default '{}'::jsonb,
  enabled_at  timestamptz not null default now(),
  enabled_by  uuid references user_profiles(id),
  primary key (organization_id, module_id)
);
create index org_modules_enabled_idx on organization_modules (organization_id) where enabled;

create or replace function public.module_enabled(p_org uuid, p_module text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from organization_modules om
    where om.organization_id = p_org and om.module_id = p_module and om.enabled);
$$;

alter table organization_modules enable row level security;
create policy org_modules_read  on organization_modules
  for select using ((select is_org_member(organization_id)));
create policy org_modules_admin on organization_modules
  for all using ((select has_org_role(organization_id,'admin')))
          with check ((select has_org_role(organization_id,'admin')));
```

**`0145_grandfather_existing_orgs.sql`:** stamp `domain_pack='charter_school'` for existing orgs; insert the full charter module set (core + all optional + the premium L4L exercises: `lot_serial`, `ai_assistant`, `ai_shelf_scan`, `reports_advanced`) for every existing org, `on conflict do nothing`. Net-new/integration modules are NOT inserted (no current behavior to preserve). New orgs seed from `modulesForPack(domain_pack)` at create time.

> No RLS `module_enabled()` predicates on module-owned tables in Phase 1 (deferred to Phase 1.5 after the axis is proven). The grandfather insert runs before any future predicate ships.

### Service-layer enforcement

- Add `enabledModules: Set<ModuleId>` to `ServiceContext` (`apps/web/src/server/services/context.ts:11`), resolved once per request (React.cache, mirroring `resolveMfaState`), reading `organization_modules`.
- Add `'module_disabled'` to the `ServiceError` code union (context.ts ~86) → **HTTP 403** in the API normalizer. *(Open item: locate the normalizer that maps `forbidden`/`plan_limit_exceeded`; add `module_disabled` there. For v1 routes it's the route-level convention.)*
- `assertModuleEnabled(ctx, moduleId)` next to `assertPermission`:
  ```ts
  export function assertModuleEnabled(ctx: ServiceContext, moduleId: ModuleId) {
    if (!ctx.enabledModules.has(moduleId))
      throw new ServiceError('module_disabled', `Module not enabled: ${moduleId}`);
  }
  ```
- **Coverage:** call `assertModuleEnabled` first in the entry-point methods of optional/premium module services (orders, rentals, bundles, cycle_counts, procedures, schedule, public_requests, ai, shipments, po_imports). Core modules are not gated. Add a thin path→module middleware in `withApiContext` for the v1 routes that exist (account, ai, books, bundles, cycle-counts, items, mobile, po, public, push) — note orders live at `/api/orders` (Server Action territory), so its guard lives in the service method, not v1 middleware. Since everything is grandfathered ON, all asserts are no-ops for L4L.

### Nav derivation

- **Web:** `navForRole(role)` → `navForRole(role, enabledModules)`; the sidebar is built from `resolveSurface('web_sidebar', …)`; `sidebar.tsx` consumes resolved sections; add the web `ICONS` map; update `nav.test.ts` to pass an `enabledModules` set (full set → identical output).
- **Mobile drawer:** `drawer-content.tsx`/`drawer-nav.ts` call `resolveSurface('mobile_drawer', …)` with the mobile `ICONS` map.
- **Mobile tabs:** `(tabs)/_layout.tsx` keeps its 5 `<Tabs.Screen>` files; each gets `href: null` when its owning module is disabled (the existing cycle-counts trick). No dynamic slotting.

### Mobile snapshot / parity

`/api/v1/mobile/snapshot` response gains `enabledModules: ModuleId[]`. The device caches it and resolves nav from the bundled registry + this set, so web/mobile cannot drift and the drawer resolves offline-stably.

### Grandfather & backwards-compatibility

All existing orgs wake up with every module enabled + `domain_pack='charter_school'` → identical nav, guard no-ops, no write breaks. New non-charter orgs get a leaner nav from their pack preset.

---

## Testing strategy

- **Registry integrity (unit):** every grandfathered `module_id` exists in the registry; every current nav item maps to exactly one module placement; `dependsOn` is acyclic; every `apiPrefix` is unique.
- **Resolver (unit):** `resolveSurface` drops a module when `!enabledModules.has(id)`; core modules always present; permission/admin gates respected; sections sorted/pruned.
- **Snapshot (`nav.test.ts`):** for each role, `navForRole(role, fullModuleSet)` equals today's static output.
- **Service guard (integration):** `assertModuleEnabled` throws `module_disabled` when off; a representative v1 route returns 403; an optional service method 403s.
- **Migration:** apply `0144`+`0145` to a copy; assert L4L has the full module set + `domain_pack`; re-running is a no-op.
- **Manual/e2e:** flip `organization_modules.enabled=false` for `rentals` → gone from web sidebar + mobile drawer; flip `books` → gone from drawer + tab.

## Files touched

- **New:** `packages/core/src/modules/registry.ts`, `packages/core/src/modules/resolve.ts`; web icon map (`apps/web/src/components/dashboard/icons.ts`), mobile icon map (`apps/mobile/src/lib/nav-icons.ts`); migrations `supabase/migrations/0144_org_modules_entitlements.sql`, `0145_grandfather_existing_orgs.sql`.
- **Edit:** `apps/web/src/server/services/context.ts` (+`enabledModules`, `assertModuleEnabled`, `module_disabled`); `apps/web/src/lib/auth/api-context.ts` (resolve + path→module middleware); `apps/web/src/components/dashboard/nav.ts` + `nav.test.ts` + `sidebar.tsx`; optional/premium service entry points (add the assert); org-create path (seed from pack); `apps/mobile/src/lib/drawer-nav.ts` + `apps/mobile/src/components/drawer-content.tsx`; `apps/mobile/app/(drawer)/(tabs)/_layout.tsx`; `apps/mobile/src/lib/sync.ts` + the snapshot route.

## Open items to resolve during implementation

1. **`ServiceError` → HTTP normalizer location** — find where `forbidden`/`plan_limit_exceeded` map to status codes; add `module_disabled → 403` there.
2. **Exact current nav inventory** — enumerate `BASE_NAV`/`ADMIN_NAV`/`DRAWER_SECTIONS`/tabs verbatim and confirm the 1:1 module mapping before deleting the static arrays.
3. **`industry` → `domain_pack` backfill** — decide the mapping for any existing free-text `industry` values (default to `charter_school`).
4. **Org-create seeding** — confirm the org-create code path (action/RPC) to attach the `modulesForPack()` seed (trigger vs application code).

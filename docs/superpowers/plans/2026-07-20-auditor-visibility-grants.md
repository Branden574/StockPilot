# Auditor visibility: grantable read surfaces + warehouse access control

> Execute: Unit 1 (core+DB) first, Unit 3 (team) in parallel; Units 2 + 4 branch from Unit 1's head; integrate 1→3→2→4; 3-lens adversarial review; ship (migs to prod BEFORE deploy) + OTA. Base: main.

**Owner (2026-07-20):** read-only auditors log in and "don't see anything"; owner wants full control over what they can see. Investigation (evidence in session): (a) viewers are warehouse-locked at invite with no UI to widen or even see the scoping; (b) five surfaces (cycle counts, schedule, bundles, rentals, returns) gate nav/pages on WRITE perms so no grant can open them read-only; (c) audit log is hardcoded admin (`requiresAdmin` + admin layout + manager+ RLS floor on `audit_logs`); (d) nothing explains scoping to the scoped user. Owner approved building everything.

## Pinned contract (all units)

**New permissions (exact strings):** `cycle_counts:read`, `schedule:read`, `bundles:read`, `rentals:read`, `returns:read`.

**Role defaults (mirror current write-perm holders — zero behavior change for existing roles):**
- admin, manager: all five.
- staff: `cycle_counts:read`, `bundles:read`, `rentals:read` (staff holds stock:adjust/bundles:distribute/rentals:create; NOT schedule:manage/returns:manage).
- viewer: none (grantable via matrix / Auditor preset).

**Mig 0279 seed:** 13 rows into `role_default_permissions` (admin 5, manager 5, staff 3), `on conflict do nothing` — pattern of migs 0250/0261/0274. pgTAP `supabase/tests/0207_permission_overrides.test.sql:41-45` count 96 → **109** (update the arithmetic comment).

**Audit-log RLS (also mig 0279):** new stable helper `public.rls_orgs_with_permission(p_permission text) returns setof uuid` (active memberships of `auth.uid()` where `public.has_permission(org_id, p_permission)`), then replace `audit_logs` SELECT policy (current winner: 0272 `rls_manager_org_ids`) with `organization_id in (select public.rls_orgs_with_permission('activity_logs:read'))`. Managers/admins keep access (they hold the perm by default); viewers gain it only when granted. Keep the initplan-friendly `in (select …)` shape (perf posture of 0229/0230/0272).

**Unit 3 mig 0280:** `organization_members.all_warehouses boolean not null default false`; same column on the invites table; AFTER INSERT trigger on `warehouses` inserting `user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary=false, assigned_by=null)` for flagged active members, `on conflict (user_id, warehouse_id) do nothing`.

**Global constraints:** NO Claude/Anthropic co-author trailers. No emojis in any copy. Migrations applied to prod by the assistant via `supabase db push --linked` BEFORE the web deploy. Local pgTAP needs `supabase db reset`. Mobile parity via registry auto-derivation + explicit CTA gating. Never regress existing role UX (staff/manager/admin see exactly what they see today by default).

## Unit 1 — core + DB (FIRST)

`packages/core/src/constants/permissions.ts`:
1. Add the 5 perms to `PERMISSIONS` (near their families).
2. `ROLE_PERMISSIONS`: per the pinned defaults table.
3. `PERMISSION_META`: add each read perm to its existing group (Cycle counts, Schedule, Bundles, Rentals, Returns) with clear labels ("View cycle counts" etc.).
4. **Fix `PERMISSION_GROUP_ORDER` (lines ~551-566): it omits "Customers" and "Rentals"** — verify whether the matrix renders unlisted groups; add both so every group renders.
5. `FULLY_GRANTABLE_PERMISSIONS`: add all five (reads: RLS floors verified — cycle_counts/bundles/returns org-member; schedule org-member + warehouse cond; rentals warehouse-scoped like items:read).
6. Migration `0279_auditor_read_permissions.sql`: seed + `rls_orgs_with_permission` + audit_logs SELECT swap (drop/recreate policy). pgTAP: bump 0207 count to 109; new `0279` test file: viewer denied audit_logs by default, viewer + role-override grant of activity_logs:read can SELECT, staff default has cycle_counts:read, viewer does not.

## Unit 2 — web gates + audit surface (after Unit 1)

1. Registry swaps (`packages/core/src/modules/registry.ts`): cycle_counts `:358/:359` → `cycle_counts:read`; schedule `:456/:457` → `schedule:read`; rentals `:313/:314` → `rentals:read`; bundles `:328/:329` → `bundles:read`; returns `:544` → `returns:read`.
2. Page gates: `cycle-counts/page.tsx:34` → `cycle_counts:read` (keep `new/page.tsx` on stock:adjust); **add** read gate to `cycle-counts/[id]/page.tsx` (currently ungated) + pass `canAdjust` into `CycleCountDetail` and gate ALL write UI (entry inputs, save, post-adjustments) — read-only render for non-adjusters. `schedule/page.tsx:33` → `schedule:read`; gate calendar "Add event" links (`schedule-calendar.tsx:201-207`) on `schedule:manage` prop. `bundles/page.tsx:42` → `bundles:read`. `returns/page.tsx:59` + `returns/[id]/page.tsx:40` → `returns:read` (action panels stay returns:manage). `rentals/page.tsx`: add `rentals:read` gate (consistency; staff keeps default). Gate cycle-counts list "+ Start a count" (`page.tsx:78-89`) on stock:adjust.
3. **Audit consolidation:** two pages exist — `dashboard/admin/audit/page.tsx` (nav-linked, admin-layout-gated, direct `audit_logs` queries) and `dashboard/settings/audit/page.tsx` (already gated `activity_logs:read`, no nav). Investigate both; consolidate to ONE grantable surface: move the richer console to a stable non-admin route (e.g. `/dashboard/audit`), gate `can(ctx,'activity_logs:read')`, registry placement `requires: 'activity_logs:read'` (drop `requiresAdmin`), old URLs redirect. Verify AuditLogService/queries use the USER client so the new RLS applies. Admin layout untouched for other admin pages.
4. `reports/page.tsx`: add explicit `reports:read` gate (currently nav-only).
5. Tests: gate tests per page (viewer+grant sees read-only; viewer without grant redirected; staff unchanged), CycleCountDetail readonly render test.

## Unit 3 — warehouse access control (parallel with Unit 1)

1. Mig `0280_all_warehouse_access.sql` per pinned contract + pgTAP (trigger inserts rows for flagged member on warehouse create; unflagged member untouched; conflict-safe).
2. Invite dialog (`team-manager.tsx` `InviteDialog`): staff/viewer warehouse select gains "All warehouses" option → submits `allWarehouses: true` (schema + `inviteMemberAction` + `TeamService.invite` store on invite row). Accept flow (`acceptInviteWithToken` `team.ts:775-783`): if flagged → set member flag + insert one assignment row per current warehouse (admin client, conflict-safe).
3. **Member "Warehouse access" editing (new):** action in the member dropdown → dialog: radio "All warehouses" | "One warehouse" (select). New server action (gate `members:invite`, mirror `setMemberCharterAssignments` patterns): All → flag true + insert rows for every warehouse; One → flag false + reconcile rows to exactly that warehouse (delete others — this re-scopes charters too, by design). Team page: show each member's warehouse access (warehouse name / "All warehouses" / "—") in the row.
4. Tests: invite validation (staff/viewer require warehouse OR all), accept-flow row creation, edit-action reconcile, display.

## Unit 4 — preset + banners + mobile (after Unit 1)

1. **Auditor preset:** server action `applyAuditorPresetAction` (gate `isAdminRole`, like `server/actions/permissions.ts` siblings): bulk role-override grants to `viewer`: `reports:read, activity_logs:read, cycle_counts:read, schedule:read, bundles:read, rentals:read, returns:read, items:export, reports:export`. Button + confirm in the matrix header (`role-permission-matrix.tsx:206-216`), refreshes matrix state.
2. **Web scoped-view banner:** items list (`inventory/page.tsx` header `:175-177`) + dashboard (`dashboard/page.tsx` header `:151`): when `getWarehouseAccess()` (request-cached) returns `hasAllAccess=false`, render info line: "You're viewing {warehouse name(s)} only. An admin can widen your access from the Team page." Names via `getWarehousesForRequest`. Also append the same explanation to `inventoryEmptyState()` when scoped and zero results.
3. **Mobile:** add `warehouseScope { hasAllAccess, warehouseNames }` to the mobile snapshot payload (`api/v1/mobile/snapshot/route.ts` already computes access); items screen (`(tabs)/inventory.tsx`) renders the same banner when scoped. Gate mobile write CTAs by effective permissions (`useEffectivePermissions`): cycle-counts "Start a cycle count" (`(tabs)/cycle-counts.tsx:219`) on `stock:adjust`; schedule add-event on `schedule:manage`. Drawer/tabs need zero changes (registry-derived).
4. Tests: preset action grants exactly the set; banner renders only when scoped; snapshot payload shape.

## Review + ship
- Integrate 1→3→2→4 on `feature/auditor-visibility`; full web + mobile + pgTAP suites.
- 3-lens adversarial review (security: RLS/permission escalation + cross-org; correctness: gate regressions for existing roles; UX/parity: read-only surfaces truly read-only, mobile parity) — verify each serious finding before fixing.
- Ship order: `supabase db push --linked` (0279+0280) → merge to main (push deploys) → `pnpm release:ota` → live-verify in Demo Co web+mobile with a REAL viewer session (invite an auditor test user, apply Auditor preset, walk every unlocked surface; verify banners + read-only rendering) → teach.

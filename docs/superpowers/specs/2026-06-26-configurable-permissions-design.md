# Configurable Permissions — Design

**Date:** 2026-06-26
**Owner ask:** "for read-only auditors, admin, and the dev owner should be able to set which
features they have access to as a whole." Granularity = **role defaults + per-user exceptions**.
Grant depth = **full feature access**. Concrete driver: auditors (viewer role) should be able to
import POs.

## Problem

Permissions are static: `ROLE_PERMISSIONS` (packages/core) is enforced at two layers —
1. **App layer**: `hasPermission(ctx.role, perm)` (108 gates) + `assertPermission(ctx, perm)`.
2. **RLS layer**: `has_org_role(org, min_role)` — *role-rank* based, knows nothing about
   individual permissions. This is the **authoritative** gate because `ctx.supabase` is
   user-authenticated (RLS applies to all service writes).

There is no way for an org admin to grant/revoke a specific capability for a role or user.

## Model — delta overrides

Two override tables (deltas on top of the static defaults), plus a global reference table so
SQL knows the defaults:

- `role_default_permissions(role, permission)` — **global**, seeded from `ROLE_PERMISSIONS`.
  Read-only reference; only migrations write it. Source of truth for SQL defaults (mirrors how
  `has_org_role` hard-codes role ranks). Parity with the TS map is asserted by pgTAP.
- `role_permission_overrides(org_id, role, permission, granted, updated_by, updated_at)` —
  per-org role-level delta. `granted=true` adds; `granted=false` removes.
- `user_permission_overrides(org_id, user_id, permission, granted, updated_by, updated_at)` —
  per-user delta. **User override beats role override beats static default.**

### Resolution order
`owner` ⇒ always all permissions (cannot be locked out — the org's escape hatch).
Otherwise: static default → apply role overrides → apply user overrides (last wins).

### `has_permission(org_id, perm)` SQL function
`security definer`, `stable`. Resolves the caller's role for the org, then returns the effective
boolean via the resolution order above. Used by RLS policies that migrate off `has_org_role`.

## App layer

- core: `effectivePermissions(role, roleOverrides, userOverrides): Set<Permission>` (pure) +
  `can(ctx, perm)` (reads `ctx.permissions`).
- `requireOrgContext()` (the single `cache()`d source) computes `permissions: Set<Permission>`
  once per request and puts it on `OrgContext`; `withContext()` carries it into `ServiceContext`;
  `withApiContext()` (bearer/mobile) computes it the same way. **Fail-safe**: if the override
  load errors, fall back to the static `ROLE_PERMISSIONS[role]` (no escalation, preserves
  current behavior).
- All 108 `hasPermission(ctx.role,…)` / `sessionCtx.role` gates → `can(ctx,…)`. The static
  reference rendering (`hasPermission(role, p)` in the matrix page) and OAuth-callback gates
  (role from state, not a ctx) stay on `hasPermission`.

## Enforcement asymmetry (must communicate)

App gate is checked **before** the DB write, so:
- **Revokes** take effect immediately, everywhere (app gate blocks before reaching RLS).
- **Grants** work fully for: app-only permissions (reads, exports, report/AI/view gates — RLS
  already lets any org member read), and write-paths whose RLS has been migrated to
  `has_permission()`. Granting a *not-yet-migrated* mutation permission would pass the app gate
  but the DB write would still be blocked by `has_org_role`.

`FULLY_GRANTABLE_PERMISSIONS` (core) lists permissions whose grant is fully effective today.
The matrix UI marks the rest "rolling out" so an admin isn't surprised by a save-time block.

## Rollout

- **P1** (this change): tables + `has_permission()` + core effective-perms + `ctx.permissions`
  + codemod all app gates + editable matrix UI (role + per-user), admin/owner only, owner
  immutable. pgTAP + vitest.
- **P2** (this change): migrate `purchase_orders` + `po_imports` write RLS to additionally honor
  `has_permission('purchase_orders:manage')` (additive `OR` — zero regression). Auditors can be
  granted PO management/import end-to-end. pgTAP proving manager keeps it, granted-viewer gains
  it, plain-viewer still denied.
- **P3** (incremental, follow-up): roll the `has_permission()` RLS pattern to the remaining
  mutation features (items/stock/locations/categories/suppliers/orders), expanding
  `FULLY_GRANTABLE_PERMISSIONS` as each lands. Playbook = the P2 migration shape.

## Safety invariants

- Owner role is immutable (always all permissions) → org can never be locked out.
- Override writes require `has_org_role(org, 'admin')` (RLS) **and** `members:update_role` app
  gate. Per-user overrides cannot target a permission the actor can't themselves grant? — No:
  admin/owner manage overrides; that's the existing role-management trust boundary.
- Unknown permission strings in override rows are ignored by `effectivePermissions` (defensive).
- Override load failure → static defaults (fail-safe, no escalation).

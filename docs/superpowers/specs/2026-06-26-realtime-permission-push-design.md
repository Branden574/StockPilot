# Realtime Permission Push — Design

**Date:** 2026-06-26
**Owner ask:** when an admin changes a logged-in user's permissions, that user's
open session should update **instantly** instead of needing a manual refresh.
Builds on the configurable-permissions feature (migs 0207/0208, the
role/user override tables + `has_permission()` + effective `ctx.permissions` +
the permission-gated sidebar).

## Decisions (approved)

- **Transport:** Supabase Realtime `postgres_changes` on the override tables —
  the same pattern as `OrderRealtimeRefresh` / `inventory-realtime`. Secure by
  construction: Realtime enforces RLS, so a client only receives events for
  rows it can already SELECT.
- **Reaction:** auto-refresh + a toast ("Your access was updated").
- **Scope:** web **and** mobile.
- **Sequence:** B (web) first, then C (mobile).

## A. Transport & security

- Migration adds `public.role_permission_overrides` and
  `public.user_permission_overrides` to the `supabase_realtime` publication.
  RLS is already enabled on both (mig 0207).
- Subscription scoping (RLS does the real enforcement; filters reduce noise):
  - role table: `filter: organization_id=eq.{org}` — RLS already limits to the
    caller's org; the client further ignores events whose `role` ≠ its own.
  - user table: `filter: user_id=eq.{me}` — RLS limits to own rows (or admin).
- No cross-tenant leakage: a client cannot subscribe to another org's overrides
  because RLS rejects the rows.

## B. Web (small — foundation already shipped)

- New client component `PermissionsRealtime` (mirrors `OrderRealtimeRefresh`):
  - props: `organizationId`, `userId`, `role`.
  - subscribes to both override tables; on a change touching the user's role or
    their own user row → debounced (500ms leading-edge) `router.refresh()` +
    `toast("Your access was updated")`.
  - fail-silent: if the socket can't open, no throw — refresh-on-navigate still
    works (today's behavior).
- Mounted once in `DashboardShell` so it is active across the dashboard.
- `router.refresh()` re-runs `requireOrgContext()` → fresh `ctx.permissions` →
  the sidebar re-gates and `/purchase-orders/layout.tsx` (and peers) re-evaluate,
  so links appear/disappear and forbidden sections show the access card live.

## C. Mobile (the bulk — needs a permission-aware foundation first)

Mobile currently gates nav by role + enabled modules only; it never fetches a
user's effective permissions, and the `mobile_drawer` feature placements don't
declare `requires`. Three steps:

- **C1 — endpoint + registry:**
  - `GET /api/v1/me/permissions` → `{ permissions: string[] }`, the caller's
    effective set for the active org (via `withApiContext` → `ctx.permissions`).
  - Add `requires` to the key `mobile_drawer` feature placements that have a
    read permission (e.g. Purchase orders → `purchase_orders:read`), matching
    the web sidebar placements. (Admin placements already use `requiresAdmin`.)
- **C2 — fetch + gate:**
  - `use-workspace` (or a small `useEffectivePermissions` hook) fetches
    `/me/permissions` for the active org and exposes the set.
  - `drawerNavForRole` threads it into
    `resolveSurface('mobile_drawer', { role, enabledModules, permissions })`
    (the param already exists from the web work).
- **C3 — realtime:**
  - An RN effect subscribes to the override tables via the mobile Supabase
    client; on a relevant change → re-fetch `/me/permissions` + republish the
    workspace state (re-renders the drawer) + a toast. Fail-silent.
  - All JS → OTA-able, no new native build.

## D. Edge cases

- **Burst writes:** one matrix toggle = several row writes inside one request;
  debounce so we refresh once per burst.
- **Mid-action user:** their nav/page just updates; the toast explains it.
- **Admin's own session:** harmless (owner immutable; admin can't self-escalate).
- **Socket failure / offline:** silent fallback to manual/navigation refresh.
- **Active-org switch (mobile):** re-subscribe + re-fetch for the new org.

## E. Testing

- pgTAP: assert both override tables are members of `supabase_realtime`, and RLS
  still scopes SELECT (a viewer sees their org's role overrides + own user rows;
  not another org's).
- Unit: mobile drawer nav hides a placement when its `requires` permission is
  absent from the effective set (reuse the web `resolve` test pattern).
- Manual: two sessions (admin + target); revoke in the matrix → target updates
  live with the toast, on web and in the app.

## Non-goals

- No new permission-change history/audit beyond what the override actions
  already write.
- No realtime for permission changes to *other* surfaces (public API consumers,
  etc.) — only the interactive web + mobile sessions.

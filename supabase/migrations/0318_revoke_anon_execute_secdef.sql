-- 0318_revoke_anon_execute_secdef.sql
-- P0 security fix: close anonymous EXECUTE on ungated SECURITY DEFINER functions.
--
-- ROOT CAUSE (plain terms)
-- ------------------------
-- Postgres grants `EXECUTE TO PUBLIC` on every newly created function by
-- default. Several of our migrations assumed the opposite — that *omitting* a
-- GRANT leaves a function closed. It does not. Migration 0093 states the wrong
-- belief out loud:
--
--     "No grant to authenticated — purge is operational, called from cron
--      with the service-role key ... Keeping it closed reduces blast radius"
--
-- `purge_read_notifications` was never closed. It was PUBLIC-executable from
-- the moment it was created, and so were the other functions listed below.
--
-- On top of the PUBLIC default, this project runs with Supabase's standard
-- `alter default privileges ... grant execute on functions to anon,
-- authenticated, service_role`, so each of these functions also carries a
-- DIRECT `anon=X` ACL entry. That matters for the shape of the fix: revoking
-- from PUBLIC alone does NOT close anon. Both grantees must be named.
--
-- WHY THIS REACHES THE INTERNET
-- -----------------------------
-- The anon (publishable) key is, by design, shipped inside the web bundle and
-- the mobile app binary. Anyone who loads the site holds it. PostgREST exposes
-- every EXECUTE-able function in `public` at `POST /rest/v1/rpc/<name>`, so
-- "callable by anon" means "callable by an unauthenticated stranger with curl".
-- SECURITY DEFINER means those calls execute with the function owner's rights,
-- bypassing RLS entirely.
--
-- WHAT THIS MIGRATION DOES / DOES NOT DO
-- --------------------------------------
-- Grants only. No function BODY is touched. Adding internal auth gates
-- (`auth.uid() is null then raise`) to these functions is a deliberate
-- follow-up, kept out of this change so the privilege delta stays small and
-- reviewable. Every statement is idempotent and safe to re-run.
--
-- The explicit `grant execute ... to <role>` after each revoke is not
-- redundant decoration: it states the intended end state so the migration is
-- correct even on a database where the surviving role's privilege happened to
-- be PUBLIC-derived rather than direct. Without it, `revoke ... from public`
-- could remove the very privilege we mean to keep.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- GROUP 1 — service_role only.
--   revoke from public, anon, authenticated.
-- Caller verified for each: every live caller is either the service-role admin
-- client or another SECURITY DEFINER function (which executes as its own owner
-- and therefore needs no privilege of its own for the callee).
-- ═══════════════════════════════════════════════════════════════════════════

-- Closes: unauthenticated cross-tenant DELETE of every already-read
-- notification in every organization, repeatable and unthrottled.
-- Caller check: zero callers anywhere in apps/ or supabase/, and no cron.job
-- entry. Nothing loses access.
revoke execute on function public.purge_read_notifications(interval) from public, anon, authenticated;
grant  execute on function public.purge_read_notifications(interval) to service_role;

-- Closes: unauthenticated cross-tenant DELETE of AI chat sessions older than
-- 30 days, cascading to their messages.
-- Caller check: apps/web/src/app/api/cron/purge-ai-chat-history/route.ts,
-- through `createAdminClient()` — service_role.
revoke execute on function public.purge_ai_chat_history() from public, anon, authenticated;
grant  execute on function public.purge_ai_chat_history() to service_role;

-- Closes: an unauthenticated denial-of-service primitive. The bucket records
-- the CALLER's window and judges against the CALLER's limit, and the keys are
-- predictable (`pwreset-req:<email>`, `support:user:<uuid>`, ...), so a
-- stranger can pre-create a bucket with a ~24-day window and a saturated count
-- and lock a named victim out of password reset for weeks. (Raising one's own
-- budget is not possible — no branch lowers a count or shrinks a live window.)
-- Caller check: sole caller apps/web/src/lib/rate-limit.ts, through
-- `createAdminClient()` — service_role.
revoke execute on function public.increment_rate_limit(text, integer, integer) from public, anon, authenticated;
grant  execute on function public.increment_rate_limit(text, integer, integer) to service_role;

-- Closes: an unauthenticated roster oracle. Returns the owner/admin/manager
-- user IDs for ANY organization UUID, and org UUIDs are not secret — they
-- appear in storage paths and dashboard URLs, and a removed former member
-- knows theirs permanently.
-- Caller check: the only callers are the notification trigger functions
-- _notify_low_stock, _notify_po_status, _notify_receipt_posted,
-- _notify_bundle_shortage and _notify_order_request_changes. All five are
-- SECURITY DEFINER, so they reach this function as their owner, not as the
-- authenticated user whose write fired the trigger. No client ever calls it
-- directly (apps/web/src/server/services/maintenance-notify.ts documents this
-- helper as one to avoid). Migration 0025's `grant ... to authenticated` was
-- never needed.
revoke execute on function public._notify_recipients(uuid) from public, anon, authenticated;
grant  execute on function public._notify_recipients(uuid) to service_role;

-- Closes: an unauthenticated account-existence oracle — "does this email have
-- an account here?" — which is precisely the targeting primitive that makes
-- credential stuffing efficient.
-- Caller check: sole caller apps/web/src/server/actions/team.ts
-- (acceptInviteWithSignupAction), through `admin.rpc(...)` where
-- `admin = createAdminClient()` — service_role. No mobile caller exists.
-- Migration 0097's `grant ... to authenticated` is not used by any code path.
revoke execute on function public.auth_user_exists_by_email(text) from public, anon, authenticated;
grant  execute on function public.auth_user_exists_by_email(text) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- GROUP 2 — revoke public, anon; DELIBERATELY KEEP authenticated.
--
-- OUTAGE HAZARD, read before editing anything below.
--
-- RLS policies are evaluated with the QUERYING ROLE's privileges. The
-- `*_in_org` helpers are referenced inside 25+ policies (item_stock_levels_write,
-- bins_write, locations_insert/update, receipts_write, purchase_orders_write,
-- order_requests_insert, stock_movements_insert, po_imports_insert/update,
-- schedule_events_insert/update, cycle_counts_insert, putaway_moves_write,
-- inventory_stock_write, organization_invites_insert, uwa_admin_write,
-- wc_admin_write, recurring_po_templates_insert/update, po_attachments manage
-- insert, bundle_distributions_insert, product_groups_insert,
-- cycle_count_lines_update, public_link_catalog_entries_write, ...).
--
-- Revoking EXECUTE from `authenticated` on ANY function in this group breaks
-- every one of those write policies at once: a total write outage across stock,
-- locations, receipts, purchase orders, orders and scheduling. Do not "tighten
-- everything" here. The companion pgTAP test asserts `authenticated` RETAINS
-- EXECUTE on each of these, specifically so that mistake fails in CI instead
-- of in production.
--
-- Removing anon still delivers the security win: it closes the cross-tenant
-- confirmation oracle ("does item X belong to org Y?", "which modules does
-- org Y have?") without touching policy evaluation for real users.
--
-- Only one `_in_org` policy is scoped to role `public` (which includes anon):
-- public_link_catalog_entries_write. Verified against the live catalog: that
-- policy references item_in_org in its WITH CHECK only, never in its USING
-- clause, and public catalog visitors only ever SELECT — served by the separate
-- public_link_catalog_entries_select policy, which references no `_in_org`
-- helper. Anonymous reads are unaffected. Anonymous writes were already denied
-- by has_org_role/has_permission; the only change is that they now fail as
-- "permission denied for function" instead of as a false policy.
-- ═══════════════════════════════════════════════════════════════════════════

-- Cross-tenant membership oracle for items. authenticated RETAINED: RLS
-- policies reference this function and evaluate it as the querying role.
revoke execute on function public.item_in_org(uuid, uuid) from public, anon;
grant  execute on function public.item_in_org(uuid, uuid) to authenticated, service_role;

-- Cross-tenant membership oracle for locations. authenticated RETAINED: RLS
-- policies reference this function and evaluate it as the querying role.
revoke execute on function public.location_in_org(uuid, uuid) from public, anon;
grant  execute on function public.location_in_org(uuid, uuid) to authenticated, service_role;

-- Cross-tenant membership oracle for charters. authenticated RETAINED: RLS
-- policies reference this function and evaluate it as the querying role.
revoke execute on function public.charter_in_org(uuid, uuid) from public, anon;
grant  execute on function public.charter_in_org(uuid, uuid) to authenticated, service_role;

-- Cross-tenant membership oracle for suppliers. authenticated RETAINED: RLS
-- policies reference this function and evaluate it as the querying role.
revoke execute on function public.supplier_in_org(uuid, uuid) from public, anon;
grant  execute on function public.supplier_in_org(uuid, uuid) to authenticated, service_role;

-- Cross-tenant membership oracle for warehouses. authenticated RETAINED: RLS
-- policies reference this function and evaluate it as the querying role.
revoke execute on function public.warehouse_in_org(uuid, uuid) from public, anon;
grant  execute on function public.warehouse_in_org(uuid, uuid) to authenticated, service_role;

-- Cross-tenant membership oracle for purchase orders. authenticated RETAINED:
-- RLS policies reference this function and evaluate it as the querying role.
revoke execute on function public.purchase_order_in_org(uuid, uuid) from public, anon;
grant  execute on function public.purchase_order_in_org(uuid, uuid) to authenticated, service_role;

-- Raising variant of location_in_org, used inside write paths. authenticated
-- RETAINED: RLS policies and SECURITY INVOKER RPCs reference this function and
-- evaluate it as the querying role.
revoke execute on function public.assert_location_in_org(uuid, uuid) from public, anon;
grant  execute on function public.assert_location_in_org(uuid, uuid) to authenticated, service_role;

-- Cross-tenant entitlement oracle ("which modules does org Y have?").
-- authenticated RETAINED: RLS policies reference this function and evaluate it
-- as the querying role.
revoke execute on function public.module_enabled(uuid, text) from public, anon;
grant  execute on function public.module_enabled(uuid, text) to authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- The two `ensure_*` placement helpers. These were originally triaged as
-- "service_role only", and closing `authenticated` on them WOULD HAVE BEEN AN
-- OUTAGE. Verified against the live catalog (pg_proc.prosecdef), not against
-- migration text:
--
--   public.apply_level_delta(uuid, numeric, text)                is SECURITY INVOKER
--   public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)  is SECURITY INVOKER
--
-- Both call these helpers, and both are reached from user-scoped clients
-- (`ctx.supabase` on web, the mobile Supabase client in apps/mobile/app/po/[id].tsx),
-- so the effective role at the moment of the inner call is `authenticated`.
-- apply_level_delta is itself the shared tail of adjust_stock, assemble_bundle,
-- distribute_bundle and post_cycle_count — all SECURITY INVOKER. Revoking
-- `authenticated` here would break stock adjustments, bundle assembly and
-- distribution, cycle-count posting and PO receiving.
--
-- (Reading the migration text alone is misleading: 0292's apply_level_delta
-- body contains the phrase "Use SECURITY DEFINER helper" in a COMMENT while
-- the function itself is declared `security invoker`. The catalog is the only
-- reliable source.)
--
-- anon is still closed, which is the actual finding: these are unauthenticated
-- writes that create `locations` rows inside an arbitrary organization — row
-- injection into another tenant.
-- ───────────────────────────────────────────────────────────────────────────

-- Closes: anonymous row injection of org-level Staging/Unplaced locations into
-- an arbitrary organization. authenticated RETAINED: SECURITY INVOKER callers
-- (apply_level_delta and everything above it) execute this as the querying role.
revoke execute on function public.ensure_org_placement_locations(uuid) from public, anon;
grant  execute on function public.ensure_org_placement_locations(uuid) to authenticated, service_role;

-- Closes: anonymous row injection of warehouse-level Staging/Unplaced
-- locations into an arbitrary organization's warehouse. authenticated
-- RETAINED: SECURITY INVOKER callers (post_receipt_v2, apply_level_delta)
-- execute this as the querying role.
revoke execute on function public.ensure_warehouse_placement_locations(uuid) from public, anon;
grant  execute on function public.ensure_warehouse_placement_locations(uuid) to authenticated, service_role;

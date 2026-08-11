-- supabase/tests/0318_secdef_grants.test.sql
-- Proves migration 0318: no SECURITY DEFINER function on the P0 fix list is
-- reachable by the anonymous role, and the RLS-predicate helpers keep the
-- `authenticated` privilege their policies depend on.
--
-- Why an EXECUTE-privilege test is worth writing at all: Postgres defaults new
-- functions to `EXECUTE TO PUBLIC`, so a function is open unless a migration
-- actively closes it. There is no syntax error, no failing query, and no log
-- line to notice — the only way this class of bug is caught is by asserting the
-- privilege directly. Migration 0093 shipped a comment claiming a function was
-- closed while it was PUBLIC-executable for its whole life.
--
-- Two families of assertion:
--
--   A. anon CANNOT execute — for all 15 functions. `has_function_privilege`
--      resolves inherited privileges, so a single `not has_function_privilege('anon', ...)`
--      catches BOTH a direct `anon=X` grant and a PUBLIC grant that anon would
--      inherit. Each is paired with a structural check that no empty-grantee
--      (PUBLIC) entry survives in the ACL, because a future `drop function; create
--      function` would silently reinstate the default and a null ACL is itself
--      PUBLIC-executable (same idiom as 0308).
--
--   B. authenticated MUST STILL execute — for the 10 Group 2 functions.
--      THIS IS THE REGRESSION GUARD, and it is the more important half of this
--      file. The `*_in_org` helpers are referenced inside 25+ RLS policies, and
--      RLS is evaluated with the querying role's privileges; the two `ensure_*`
--      helpers are called from SECURITY INVOKER RPCs (apply_level_delta,
--      post_receipt_v2) that run as `authenticated`. A well-meaning future
--      "revoke everything from everyone" sweep over this list would take down
--      writes across stock, locations, receipts, purchase orders, orders and
--      scheduling. These assertions make that failure land in CI instead of in
--      production.
--
-- Group 1 (service_role only) additionally asserts authenticated is closed and
-- service_role is open — the admin/cron clients are the only intended callers.
--
-- Pure privilege introspection: no fixtures, no writes, no namespace needed.
-- Wrapped in begin/rollback for house consistency.

begin;

select plan(45);

-- ═══════════════════════════════════════════════════════════════════════════
-- GROUP 1 — service_role only. anon and authenticated both closed.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1-4. purge_read_notifications(interval) — the Critical finding: an
-- unauthenticated, repeatable, cross-tenant DELETE of every read notification.
select ok(
  not has_function_privilege('anon', 'public.purge_read_notifications(interval)', 'execute'),
  'purge_read_notifications: anon holds no EXECUTE'
);
select ok(
  not has_function_privilege('authenticated', 'public.purge_read_notifications(interval)', 'execute'),
  'purge_read_notifications: authenticated holds no EXECUTE (operational function, cron only)'
);
select ok(
  has_function_privilege('service_role', 'public.purge_read_notifications(interval)', 'execute'),
  'purge_read_notifications: service_role RETAINS EXECUTE (the retention cron path)'
);
select ok(
  (select p.proacl is not null
          and not exists (select 1 from unnest(p.proacl) a where a::text like '=%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'purge_read_notifications'),
  'purge_read_notifications: no PUBLIC execute grant survives in the ACL'
);

-- 5-8. purge_ai_chat_history() — unauthenticated cross-tenant DELETE of AI
-- chat sessions, cascading to messages.
select ok(
  not has_function_privilege('anon', 'public.purge_ai_chat_history()', 'execute'),
  'purge_ai_chat_history: anon holds no EXECUTE'
);
select ok(
  not has_function_privilege('authenticated', 'public.purge_ai_chat_history()', 'execute'),
  'purge_ai_chat_history: authenticated holds no EXECUTE'
);
select ok(
  has_function_privilege('service_role', 'public.purge_ai_chat_history()', 'execute'),
  'purge_ai_chat_history: service_role RETAINS EXECUTE (api/cron/purge-ai-chat-history)'
);
select ok(
  (select p.proacl is not null
          and not exists (select 1 from unnest(p.proacl) a where a::text like '=%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'purge_ai_chat_history'),
  'purge_ai_chat_history: no PUBLIC execute grant survives in the ACL'
);

-- 9-12. increment_rate_limit(text,integer,integer) — the lockout primitive:
-- predictable keys plus a caller-supplied window let a stranger pre-saturate a
-- named victim's password-reset bucket.
select ok(
  not has_function_privilege('anon', 'public.increment_rate_limit(text, integer, integer)', 'execute'),
  'increment_rate_limit: anon holds no EXECUTE'
);
select ok(
  not has_function_privilege('authenticated', 'public.increment_rate_limit(text, integer, integer)', 'execute'),
  'increment_rate_limit: authenticated holds no EXECUTE'
);
select ok(
  has_function_privilege('service_role', 'public.increment_rate_limit(text, integer, integer)', 'execute'),
  'increment_rate_limit: service_role RETAINS EXECUTE (lib/rate-limit.ts admin client)'
);
select ok(
  (select p.proacl is not null
          and not exists (select 1 from unnest(p.proacl) a where a::text like '=%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'increment_rate_limit'),
  'increment_rate_limit: no PUBLIC execute grant survives in the ACL'
);

-- 13-16. _notify_recipients(uuid) — the roster oracle. Its five callers are
-- all SECURITY DEFINER trigger functions, so closing authenticated is safe:
-- the trigger reaches this helper as its own owner, not as the writer.
select ok(
  not has_function_privilege('anon', 'public._notify_recipients(uuid)', 'execute'),
  '_notify_recipients: anon holds no EXECUTE'
);
select ok(
  not has_function_privilege('authenticated', 'public._notify_recipients(uuid)', 'execute'),
  '_notify_recipients: authenticated holds no EXECUTE (all callers are SECURITY DEFINER triggers)'
);
select ok(
  has_function_privilege('service_role', 'public._notify_recipients(uuid)', 'execute'),
  '_notify_recipients: service_role RETAINS EXECUTE'
);
select ok(
  (select p.proacl is not null
          and not exists (select 1 from unnest(p.proacl) a where a::text like '=%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_notify_recipients'),
  '_notify_recipients: no PUBLIC execute grant survives in the ACL'
);

-- Structural backstop for the claim above: all five notification triggers must
-- stay SECURITY DEFINER. If one is ever recreated as SECURITY INVOKER it would
-- reach _notify_recipients as `authenticated` and start failing, so this pins
-- the precondition that makes revoking authenticated safe.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('_notify_low_stock', '_notify_po_status', '_notify_receipt_posted',
                        '_notify_bundle_shortage', '_notify_order_request_changes')
      and p.prosecdef),
  5,
  'all five _notify_recipients callers are SECURITY DEFINER (what makes closing authenticated safe)'
);

-- 18-21. auth_user_exists_by_email(text) — the account-existence oracle that
-- makes credential stuffing efficient.
select ok(
  not has_function_privilege('anon', 'public.auth_user_exists_by_email(text)', 'execute'),
  'auth_user_exists_by_email: anon holds no EXECUTE (closes the account-existence oracle)'
);
select ok(
  not has_function_privilege('authenticated', 'public.auth_user_exists_by_email(text)', 'execute'),
  'auth_user_exists_by_email: authenticated holds no EXECUTE (sole caller is the admin client)'
);
select ok(
  has_function_privilege('service_role', 'public.auth_user_exists_by_email(text)', 'execute'),
  'auth_user_exists_by_email: service_role RETAINS EXECUTE (invite-accept preflight)'
);
select ok(
  (select p.proacl is not null
          and not exists (select 1 from unnest(p.proacl) a where a::text like '=%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'auth_user_exists_by_email'),
  'auth_user_exists_by_email: no PUBLIC execute grant survives in the ACL'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- GROUP 2 — anon closed, `authenticated` DELIBERATELY RETAINED.
--
-- Every `not has_function_privilege('anon', ...)` below is the security fix.
-- Every `has_function_privilege('authenticated', ...)` below is the OUTAGE
-- GUARD described in the header: these functions are RLS predicates (evaluated
-- as the querying role) or are called from SECURITY INVOKER RPCs, so revoking
-- `authenticated` takes down writes across stock, locations, receipts, POs,
-- orders and scheduling. Do not "fix" a failure here by loosening the anon
-- assertion or by deleting the authenticated assertion.
-- ═══════════════════════════════════════════════════════════════════════════

-- 22-23. item_in_org
select ok(
  not has_function_privilege('anon', 'public.item_in_org(uuid, uuid)', 'execute'),
  'item_in_org: anon holds no EXECUTE (closes the cross-tenant item oracle)'
);
select ok(
  has_function_privilege('authenticated', 'public.item_in_org(uuid, uuid)', 'execute'),
  'item_in_org: authenticated RETAINS EXECUTE — RLS policies reference it (outage guard)'
);

-- 24-25. location_in_org
select ok(
  not has_function_privilege('anon', 'public.location_in_org(uuid, uuid)', 'execute'),
  'location_in_org: anon holds no EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.location_in_org(uuid, uuid)', 'execute'),
  'location_in_org: authenticated RETAINS EXECUTE — RLS policies reference it (outage guard)'
);

-- 26-27. charter_in_org
select ok(
  not has_function_privilege('anon', 'public.charter_in_org(uuid, uuid)', 'execute'),
  'charter_in_org: anon holds no EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.charter_in_org(uuid, uuid)', 'execute'),
  'charter_in_org: authenticated RETAINS EXECUTE — RLS policies reference it (outage guard)'
);

-- 28-29. supplier_in_org
select ok(
  not has_function_privilege('anon', 'public.supplier_in_org(uuid, uuid)', 'execute'),
  'supplier_in_org: anon holds no EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.supplier_in_org(uuid, uuid)', 'execute'),
  'supplier_in_org: authenticated RETAINS EXECUTE — RLS policies reference it (outage guard)'
);

-- 30-31. warehouse_in_org
select ok(
  not has_function_privilege('anon', 'public.warehouse_in_org(uuid, uuid)', 'execute'),
  'warehouse_in_org: anon holds no EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.warehouse_in_org(uuid, uuid)', 'execute'),
  'warehouse_in_org: authenticated RETAINS EXECUTE — RLS policies reference it (outage guard)'
);

-- 32-33. purchase_order_in_org
select ok(
  not has_function_privilege('anon', 'public.purchase_order_in_org(uuid, uuid)', 'execute'),
  'purchase_order_in_org: anon holds no EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.purchase_order_in_org(uuid, uuid)', 'execute'),
  'purchase_order_in_org: authenticated RETAINS EXECUTE — RLS policies reference it (outage guard)'
);

-- 34-35. assert_location_in_org
select ok(
  not has_function_privilege('anon', 'public.assert_location_in_org(uuid, uuid)', 'execute'),
  'assert_location_in_org: anon holds no EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.assert_location_in_org(uuid, uuid)', 'execute'),
  'assert_location_in_org: authenticated RETAINS EXECUTE — write paths reference it (outage guard)'
);

-- 36-37. module_enabled
select ok(
  not has_function_privilege('anon', 'public.module_enabled(uuid, text)', 'execute'),
  'module_enabled: anon holds no EXECUTE (closes the cross-tenant entitlement oracle)'
);
select ok(
  has_function_privilege('authenticated', 'public.module_enabled(uuid, text)', 'execute'),
  'module_enabled: authenticated RETAINS EXECUTE — RLS policies reference it (outage guard)'
);

-- 38-39. ensure_org_placement_locations — moved out of the "service_role only"
-- group after catalog verification: SECURITY INVOKER callers need it.
select ok(
  not has_function_privilege('anon', 'public.ensure_org_placement_locations(uuid)', 'execute'),
  'ensure_org_placement_locations: anon holds no EXECUTE (closes anonymous cross-tenant row injection)'
);
select ok(
  has_function_privilege('authenticated', 'public.ensure_org_placement_locations(uuid)', 'execute'),
  'ensure_org_placement_locations: authenticated RETAINS EXECUTE — apply_level_delta is SECURITY INVOKER (outage guard)'
);

-- 40-41. ensure_warehouse_placement_locations
select ok(
  not has_function_privilege('anon', 'public.ensure_warehouse_placement_locations(uuid)', 'execute'),
  'ensure_warehouse_placement_locations: anon holds no EXECUTE (closes anonymous cross-tenant row injection)'
);
select ok(
  has_function_privilege('authenticated', 'public.ensure_warehouse_placement_locations(uuid)', 'execute'),
  'ensure_warehouse_placement_locations: authenticated RETAINS EXECUTE — post_receipt_v2/apply_level_delta are SECURITY INVOKER (outage guard)'
);

-- 42-43. Structural pin on WHY Group 2's ensure_* helpers must keep
-- `authenticated`: their callers are SECURITY INVOKER. If either of these ever
-- flips to SECURITY DEFINER the retention becomes unnecessary — but until then,
-- removing it is an outage. Pinning prosecdef keeps the reasoning in
-- the test rather than only in a comment.
--
-- 0331 INVERTED the apply_level_delta half: it is now SECURITY DEFINER (with
-- its own org/staff self-authorization gate), the prerequisite for the AR-2
-- warehouse-narrowing of item_stock_levels_select. The ensure_* helpers keep
-- `authenticated` regardless: post_receipt_v2 is still SECURITY INVOKER and
-- calls ensure_warehouse_placement_locations as the querying user, and the
-- helpers self-scope, so the retained grant stays harmless.
select ok(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'apply_level_delta'),
  'apply_level_delta is SECURITY DEFINER since 0331 (draw-down selection immune to the caller''s read scope)'
);
select ok(
  (select not p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'post_receipt_v2'),
  'post_receipt_v2 is SECURITY INVOKER — this is why ensure_warehouse_placement_locations keeps authenticated'
);

-- 44. Blanket sweep: not one of the 15 functions on the fix list is reachable
-- by anon. Guards against a hand-edited revoke losing a line without any
-- individual assertion above being touched.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('purge_read_notifications', 'purge_ai_chat_history', 'increment_rate_limit',
                        '_notify_recipients', 'auth_user_exists_by_email',
                        'ensure_org_placement_locations', 'ensure_warehouse_placement_locations',
                        'item_in_org', 'location_in_org', 'charter_in_org', 'supplier_in_org',
                        'warehouse_in_org', 'purchase_order_in_org', 'assert_location_in_org',
                        'module_enabled')
      and has_function_privilege('anon', p.oid, 'execute')),
  0,
  'sweep: none of the 15 fix-list functions is anon-EXECUTE'
);

-- 45. The mirror sweep: all 10 Group 2 functions still executable by
-- authenticated. One assertion that fails loudly if a future change tightens
-- the whole group at once.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('item_in_org', 'location_in_org', 'charter_in_org', 'supplier_in_org',
                        'warehouse_in_org', 'purchase_order_in_org', 'assert_location_in_org',
                        'module_enabled', 'ensure_org_placement_locations',
                        'ensure_warehouse_placement_locations')
      and has_function_privilege('authenticated', p.oid, 'execute')),
  10,
  'sweep: all 10 Group 2 functions RETAIN authenticated EXECUTE (write-outage guard)'
);

select * from finish();
rollback;

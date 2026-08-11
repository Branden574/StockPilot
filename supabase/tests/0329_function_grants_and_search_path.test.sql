-- supabase/tests/0329_function_grants_and_search_path.test.sql
-- Proves migration 0329: the function-grant + search_path sweep landed and
-- stays landed. Four security properties, each literal-pinned:
--
--   A. All 34 first-party trigger functions hold NO EXECUTE for anon or
--      authenticated, and no PUBLIC grant survives in any of their ACLs.
--      (Trigger firing does not need the DML user's EXECUTE — checked at
--      CREATE TRIGGER time only — so zero grantees is the correct end state.)
--   B. All 22 previously-unpinned functions now carry the repo-standard
--      `search_path=public` pin in proconfig — the VALUE is asserted, not
--      just "some pin exists".
--   C. Ten spot-checked user RPCs keep authenticated EXECUTE (outage guard)
--      while anon stays closed (the security fix). Do not "fix" a failure
--      here by deleting the authenticated half.
--   D. The three anon-reachable RLS helpers (has_org_role, has_permission,
--      is_org_member) DELIBERATELY keep anon EXECUTE: policies without a TO
--      clause evaluate as anon on tables anon still holds privileges on, and
--      a revoke would turn silent policy denials into function-permission
--      errors on an internet-facing surface. The anon=true pins below force
--      any future sweep to consciously revisit that decision rather than
--      break it in passing.
--
-- Plus the citext tripwire: migration 0329 must not (and no future sweep may
-- silently) ALTER citext extension functions — they live in `public` because
-- 0001 created the extension there, which makes them easy to sweep up by
-- accident. Their default state is NULL proconfig and PUBLIC-derived EXECUTE.
--
-- Pure privilege/catalog introspection: no fixtures, no writes, no namespace.
-- Wrapped in begin/rollback for house consistency.

begin;

select plan(44);

-- ═══════════════════════════════════════════════════════════════════════════
-- A. Trigger functions: the complete first-party `returns trigger` set (34).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. List integrity: every name below exists in `public` and returns trigger.
--    A typo or a dropped/renamed function fails HERE instead of silently
--    weakening the two sweep assertions that follow.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prorettype = 'trigger'::regtype
      and p.proname in (
        '_auto_restock_restore', '_clear_auto_archived_on_unarchive',
        '_clear_awaiting_first_receipt', '_dispatch_push_for_notification',
        '_enforce_schedule_events_writer', '_grant_all_warehouse_access',
        '_guard_org_billing_columns', '_guard_organization_member_changes',
        '_notify_bundle_shortage', '_notify_cycle_count_assigned',
        '_notify_low_stock', '_notify_order_request_changes',
        '_notify_po_status', '_notify_receipt_posted',
        '_touch_ai_chat_session', '_touch_schedule_events_updated_at',
        '_track_zero_since', '_validate_order_request_status_transition',
        '_validate_return_status_transition', 'assign_maintenance_request_number',
        'assign_order_request_number', 'seed_org_modules',
        'shipments_enforce_status_transition', 'tg_handle_new_auth_user',
        'tg_inventory_items_set_updated_at', 'tg_inventory_set_archived_at',
        'tg_items_search_vector', 'tg_pin_product_group_org',
        'tg_pin_user_profile_disable_flags', 'tg_pin_user_profile_email',
        'tg_return_lines_enforce_fulfilled_cap', 'tg_seed_initial_level',
        'tg_seed_warehouse_locations', 'tg_set_updated_at')),
  34,
  'all 34 swept trigger functions exist in public and return trigger (list-integrity pin)'
);

-- 2-3. The sweep itself: anon and authenticated hold EXECUTE on none of them.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prorettype = 'trigger'::regtype
      and p.proname in (
        '_auto_restock_restore', '_clear_auto_archived_on_unarchive',
        '_clear_awaiting_first_receipt', '_dispatch_push_for_notification',
        '_enforce_schedule_events_writer', '_grant_all_warehouse_access',
        '_guard_org_billing_columns', '_guard_organization_member_changes',
        '_notify_bundle_shortage', '_notify_cycle_count_assigned',
        '_notify_low_stock', '_notify_order_request_changes',
        '_notify_po_status', '_notify_receipt_posted',
        '_touch_ai_chat_session', '_touch_schedule_events_updated_at',
        '_track_zero_since', '_validate_order_request_status_transition',
        '_validate_return_status_transition', 'assign_maintenance_request_number',
        'assign_order_request_number', 'seed_org_modules',
        'shipments_enforce_status_transition', 'tg_handle_new_auth_user',
        'tg_inventory_items_set_updated_at', 'tg_inventory_set_archived_at',
        'tg_items_search_vector', 'tg_pin_product_group_org',
        'tg_pin_user_profile_disable_flags', 'tg_pin_user_profile_email',
        'tg_return_lines_enforce_fulfilled_cap', 'tg_seed_initial_level',
        'tg_seed_warehouse_locations', 'tg_set_updated_at')
      and has_function_privilege('anon', p.oid, 'execute')),
  0,
  'sweep: not one of the 34 trigger functions is anon-EXECUTE'
);
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prorettype = 'trigger'::regtype
      and p.proname in (
        '_auto_restock_restore', '_clear_auto_archived_on_unarchive',
        '_clear_awaiting_first_receipt', '_dispatch_push_for_notification',
        '_enforce_schedule_events_writer', '_grant_all_warehouse_access',
        '_guard_org_billing_columns', '_guard_organization_member_changes',
        '_notify_bundle_shortage', '_notify_cycle_count_assigned',
        '_notify_low_stock', '_notify_order_request_changes',
        '_notify_po_status', '_notify_receipt_posted',
        '_touch_ai_chat_session', '_touch_schedule_events_updated_at',
        '_track_zero_since', '_validate_order_request_status_transition',
        '_validate_return_status_transition', 'assign_maintenance_request_number',
        'assign_order_request_number', 'seed_org_modules',
        'shipments_enforce_status_transition', 'tg_handle_new_auth_user',
        'tg_inventory_items_set_updated_at', 'tg_inventory_set_archived_at',
        'tg_items_search_vector', 'tg_pin_product_group_org',
        'tg_pin_user_profile_disable_flags', 'tg_pin_user_profile_email',
        'tg_return_lines_enforce_fulfilled_cap', 'tg_seed_initial_level',
        'tg_seed_warehouse_locations', 'tg_set_updated_at')
      and has_function_privilege('authenticated', p.oid, 'execute')),
  0,
  'sweep: not one of the 34 trigger functions is authenticated-EXECUTE'
);

-- 4. Structural backstop (0318/0308 idiom): a NULL proacl is itself
--    PUBLIC-executable, and a future `drop function; create function` would
--    silently reinstate the default. No trigger function may have a NULL ACL
--    or a surviving empty-grantee (PUBLIC) entry.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prorettype = 'trigger'::regtype
      and p.proname in (
        '_auto_restock_restore', '_clear_auto_archived_on_unarchive',
        '_clear_awaiting_first_receipt', '_dispatch_push_for_notification',
        '_enforce_schedule_events_writer', '_grant_all_warehouse_access',
        '_guard_org_billing_columns', '_guard_organization_member_changes',
        '_notify_bundle_shortage', '_notify_cycle_count_assigned',
        '_notify_low_stock', '_notify_order_request_changes',
        '_notify_po_status', '_notify_receipt_posted',
        '_touch_ai_chat_session', '_touch_schedule_events_updated_at',
        '_track_zero_since', '_validate_order_request_status_transition',
        '_validate_return_status_transition', 'assign_maintenance_request_number',
        'assign_order_request_number', 'seed_org_modules',
        'shipments_enforce_status_transition', 'tg_handle_new_auth_user',
        'tg_inventory_items_set_updated_at', 'tg_inventory_set_archived_at',
        'tg_items_search_vector', 'tg_pin_product_group_org',
        'tg_pin_user_profile_disable_flags', 'tg_pin_user_profile_email',
        'tg_return_lines_enforce_fulfilled_cap', 'tg_seed_initial_level',
        'tg_seed_warehouse_locations', 'tg_set_updated_at')
      and (p.proacl is null
           or exists (select 1 from unnest(p.proacl) a where a::text like '=%'))),
  0,
  'no trigger function has a NULL ACL or a surviving PUBLIC grant entry'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- B. search_path pins on the 22 previously-unpinned functions.
-- ═══════════════════════════════════════════════════════════════════════════

-- 5. List integrity: all 22 exist (each name has exactly one overload in
--    public, verified at migration time, so a name-based count is exact).
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        '_clear_auto_archived_on_unarchive', '_clear_awaiting_first_receipt',
        '_dedup_rack_locations', '_enforce_schedule_events_writer',
        '_guard_org_billing_columns', '_track_zero_since',
        'shipments_enforce_status_transition', 'tg_inventory_items_set_updated_at',
        'tg_items_search_vector', 'tg_pin_product_group_org',
        'tg_pin_user_profile_disable_flags', 'tg_pin_user_profile_email',
        'tg_set_updated_at', 'duplicate_inventory_item', 'generate_sku',
        'inventory_distinct_racks', 'inventory_set_rack', 'inventory_value',
        'log_audit', 'low_stock_count', 'low_stock_items',
        'order_request_top_skus_for_warehouse')),
  22,
  'all 22 pin-target functions exist in public with a single overload each (list-integrity pin)'
);

-- 6. The pin itself — the exact repo-standard VALUE, not merely "has some
--    proconfig". `search_path=public` is how `set search_path = public` is
--    stored in proconfig.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        '_clear_auto_archived_on_unarchive', '_clear_awaiting_first_receipt',
        '_dedup_rack_locations', '_enforce_schedule_events_writer',
        '_guard_org_billing_columns', '_track_zero_since',
        'shipments_enforce_status_transition', 'tg_inventory_items_set_updated_at',
        'tg_items_search_vector', 'tg_pin_product_group_org',
        'tg_pin_user_profile_disable_flags', 'tg_pin_user_profile_email',
        'tg_set_updated_at', 'duplicate_inventory_item', 'generate_sku',
        'inventory_distinct_racks', 'inventory_set_rack', 'inventory_value',
        'log_audit', 'low_stock_count', 'low_stock_items',
        'order_request_top_skus_for_warehouse')
      and 'search_path=public' = any(p.proconfig)),
  22,
  'all 22 previously-unpinned functions now carry search_path=public in proconfig'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- C. Kept user RPCs: authenticated RETAINED (outage guard), anon closed.
-- ═══════════════════════════════════════════════════════════════════════════

-- 7-8. claim_picking
select ok(
  has_function_privilege('authenticated', 'public.claim_picking(uuid)', 'execute'),
  'claim_picking: authenticated RETAINS EXECUTE (picker claim flow — outage guard)'
);
select ok(
  not has_function_privilege('anon', 'public.claim_picking(uuid)', 'execute'),
  'claim_picking: anon holds no EXECUTE'
);

-- 9-10. adjust_stock
select ok(
  has_function_privilege('authenticated', 'public.adjust_stock(uuid, numeric, text, uuid, text, text, text)', 'execute'),
  'adjust_stock: authenticated RETAINS EXECUTE (core stock write — outage guard)'
);
select ok(
  not has_function_privilege('anon', 'public.adjust_stock(uuid, numeric, text, uuid, text, text, text)', 'execute'),
  'adjust_stock: anon holds no EXECUTE'
);

-- 11-12. post_cycle_count
select ok(
  has_function_privilege('authenticated', 'public.post_cycle_count(uuid)', 'execute'),
  'post_cycle_count: authenticated RETAINS EXECUTE (count posting — outage guard)'
);
select ok(
  not has_function_privilege('anon', 'public.post_cycle_count(uuid)', 'execute'),
  'post_cycle_count: anon holds no EXECUTE'
);

-- 13-14. approve_order_request
select ok(
  has_function_privilege('authenticated', 'public.approve_order_request(uuid)', 'execute'),
  'approve_order_request: authenticated RETAINS EXECUTE (order approval — outage guard)'
);
select ok(
  not has_function_privilege('anon', 'public.approve_order_request(uuid)', 'execute'),
  'approve_order_request: anon holds no EXECUTE'
);

-- 15-16. complete_picking
select ok(
  has_function_privilege('authenticated', 'public.complete_picking(uuid)', 'execute'),
  'complete_picking: authenticated RETAINS EXECUTE (pick completion — outage guard)'
);
select ok(
  not has_function_privilege('anon', 'public.complete_picking(uuid)', 'execute'),
  'complete_picking: anon holds no EXECUTE'
);

-- 17-18. partial_pick_line
select ok(
  has_function_privilege('authenticated', 'public.partial_pick_line(uuid, numeric)', 'execute'),
  'partial_pick_line: authenticated RETAINS EXECUTE (partial pick — outage guard)'
);
select ok(
  not has_function_privilege('anon', 'public.partial_pick_line(uuid, numeric)', 'execute'),
  'partial_pick_line: anon holds no EXECUTE'
);

-- 19-20. revoke_my_session
select ok(
  has_function_privilege('authenticated', 'public.revoke_my_session(uuid)', 'execute'),
  'revoke_my_session: authenticated RETAINS EXECUTE (device management — outage guard)'
);
select ok(
  not has_function_privilege('anon', 'public.revoke_my_session(uuid)', 'execute'),
  'revoke_my_session: anon holds no EXECUTE'
);

-- 21-22. inventory_value
select ok(
  has_function_privilege('authenticated', 'public.inventory_value(uuid)', 'execute'),
  'inventory_value: authenticated RETAINS EXECUTE (dashboard read — outage guard)'
);
select ok(
  not has_function_privilege('anon', 'public.inventory_value(uuid)', 'execute'),
  'inventory_value: anon holds no EXECUTE'
);

-- 23-24. low_stock_items
select ok(
  has_function_privilege('authenticated', 'public.low_stock_items(uuid, integer)', 'execute'),
  'low_stock_items: authenticated RETAINS EXECUTE (dashboard read — outage guard)'
);
select ok(
  not has_function_privilege('anon', 'public.low_stock_items(uuid, integer)', 'execute'),
  'low_stock_items: anon holds no EXECUTE'
);

-- 25-26. duplicate_inventory_item
select ok(
  has_function_privilege('authenticated', 'public.duplicate_inventory_item(uuid, jsonb)', 'execute'),
  'duplicate_inventory_item: authenticated RETAINS EXECUTE (item duplication — outage guard)'
);
select ok(
  not has_function_privilege('anon', 'public.duplicate_inventory_item(uuid, jsonb)', 'execute'),
  'duplicate_inventory_item: anon holds no EXECUTE'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- D. RLS helpers.
-- ═══════════════════════════════════════════════════════════════════════════

-- 27-32. has_org_role / has_permission / is_org_member: authenticated is the
-- outage guard (dozens of policies call them as the querying role); anon is a
-- DELIBERATE KEEP — policies without a TO clause evaluate as anon on tables
-- anon can still reach, and revoking would replace silent policy denials with
-- permission errors on an internet-facing surface. If a future change
-- tightens those policies' TO clauses first, flip these three anon pins in
-- the same PR — never before.
select ok(
  has_function_privilege('authenticated', 'public.has_org_role(uuid, text)', 'execute'),
  'has_org_role: authenticated RETAINS EXECUTE (RLS predicate — outage guard)'
);
select ok(
  has_function_privilege('anon', 'public.has_org_role(uuid, text)', 'execute'),
  'has_org_role: anon KEEPS EXECUTE (deliberate: referenced by TO-clause-less policies reachable by anon)'
);
select ok(
  has_function_privilege('authenticated', 'public.has_permission(uuid, text)', 'execute'),
  'has_permission: authenticated RETAINS EXECUTE (RLS predicate — outage guard)'
);
select ok(
  has_function_privilege('anon', 'public.has_permission(uuid, text)', 'execute'),
  'has_permission: anon KEEPS EXECUTE (deliberate: referenced by TO-clause-less policies reachable by anon)'
);
select ok(
  has_function_privilege('authenticated', 'public.is_org_member(uuid)', 'execute'),
  'is_org_member: authenticated RETAINS EXECUTE (RLS predicate — outage guard)'
);
select ok(
  has_function_privilege('anon', 'public.is_org_member(uuid)', 'execute'),
  'is_org_member: anon KEEPS EXECUTE (deliberate: referenced by TO-clause-less policies reachable by anon)'
);

-- 33-34. user_org_role: helper family keeps authenticated; nothing anon-facing
-- references it, so anon is closed.
select ok(
  has_function_privilege('authenticated', 'public.user_org_role(uuid)', 'execute'),
  'user_org_role: authenticated RETAINS EXECUTE (RLS-helper family — outage guard)'
);
select ok(
  not has_function_privilege('anon', 'public.user_org_role(uuid)', 'execute'),
  'user_org_role: anon holds no EXECUTE'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- E. Orphaned RPCs closed entirely (service_role only).
-- ═══════════════════════════════════════════════════════════════════════════

-- 35-37. generate_sku
select ok(
  not has_function_privilege('anon', 'public.generate_sku(uuid, text)', 'execute'),
  'generate_sku: anon holds no EXECUTE'
);
select ok(
  not has_function_privilege('authenticated', 'public.generate_sku(uuid, text)', 'execute'),
  'generate_sku: authenticated holds no EXECUTE (zero call sites anywhere — see 0329 header)'
);
select ok(
  has_function_privilege('service_role', 'public.generate_sku(uuid, text)', 'execute'),
  'generate_sku: service_role RETAINS EXECUTE'
);

-- 38-40. log_audit
select ok(
  not has_function_privilege('anon', 'public.log_audit(uuid, text, jsonb)', 'execute'),
  'log_audit: anon holds no EXECUTE'
);
select ok(
  not has_function_privilege('authenticated', 'public.log_audit(uuid, text, jsonb)', 'execute'),
  'log_audit: authenticated holds no EXECUTE (zero call sites anywhere — see 0329 header)'
);
select ok(
  has_function_privilege('service_role', 'public.log_audit(uuid, text, jsonb)', 'execute'),
  'log_audit: service_role RETAINS EXECUTE'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- F. citext tripwire: extension functions were NOT altered.
--    citext lives in `public` (0001 created the extension there), which makes
--    its 40+ member functions easy for a schema-wide sweep to catch by
--    accident. Their factory state: NULL proconfig, PUBLIC-derived EXECUTE.
-- ═══════════════════════════════════════════════════════════════════════════

-- 41. The pg_depend join is not vacuous — an empty join would make the
--     zero-altered assertion below pass trivially (tautology guard).
select ok(
  (select count(*)
     from pg_proc p
     join pg_depend d on d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
     join pg_extension e on e.oid = d.refobjid and e.extname = 'citext') >= 40,
  'citext extension owns 40+ member functions (the guard below is checking real rows)'
);

-- 42. Not one citext member function carries ANY proconfig (a search_path pin
--     would show up here).
select is(
  (select count(*)::int
     from pg_proc p
     join pg_depend d on d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
     join pg_extension e on e.oid = d.refobjid and e.extname = 'citext'
    where p.proconfig is not null),
  0,
  'no citext extension function was ALTERed with a proconfig entry (search_path sweep kept its hands off)'
);

-- 43. Spot check: citext_eq keeps its default PUBLIC-derived EXECUTE — a
--     grant sweep that revoked it would break every citext comparison for
--     request roles.
select ok(
  has_function_privilege('anon', 'public.citext_eq(public.citext, public.citext)', 'execute'),
  'citext_eq: default PUBLIC-derived EXECUTE intact for request roles'
);

-- 44. And the extension still functions: case-insensitive equality works.
select is(
  ('StockPilot'::public.citext = 'stockpilot'::public.citext),
  true,
  'citext case-insensitive equality still behaves (extension state untouched)'
);

select * from finish();
rollback;

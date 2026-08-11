-- 0329_function_grants_and_search_path.sql
-- Security sweep PR F: pin search_path on every remaining unpinned first-party
-- function, strip EXECUTE from every first-party trigger function, and close
-- anon EXECUTE on user RPCs that never need it.
--
-- Three independent hardening moves, none of which touches a function BODY:
--
--   1. SEARCH_PATH PINS (22 functions). Every other first-party function
--      already carries `set search_path = public` (or `public, extensions`
--      where pgcrypto is needed). These 22 were created without a pin, so they
--      resolve unqualified names through the SESSION search_path — a classic
--      privilege-escalation vector for SECURITY DEFINER functions and sloppy
--      hygiene even for INVOKER ones. Every body below was read before
--      pinning: all reference only schema-qualified `public.*` relations,
--      `auth.uid()`, and pg_catalog built-ins (now, md5, to_hex, to_tsvector,
--      setweight, gen_random_uuid — in pg_catalog since PG13), so the plain
--      `public` pin the repo uses everywhere is sufficient. None needs
--      `extensions`. `_dedup_rack_locations` references an unqualified temp
--      table; pg_temp is implicitly searched first for RELATIONS even when not
--      listed in search_path, so the pin does not break it.
--
--   2. TRIGGER FUNCTION EXECUTE (34 functions — the complete set of
--      first-party `returns trigger` functions in `public`). Supabase's
--      default privileges (`alter default privileges ... grant execute on
--      functions to anon, authenticated, service_role`) gave every one of
--      these a direct anon + authenticated EXECUTE it has never needed.
--      Trigger functions cannot be invoked directly ("trigger functions can
--      only be called as triggers"), and PostgreSQL checks EXECUTE on the
--      trigger function only against the user running CREATE TRIGGER, not
--      against the DML user at fire time:
--
--        - CREATE TRIGGER docs: "To create or replace a trigger on a table,
--          the user must have the TRIGGER privilege on the table. The user
--          must also have EXECUTE privilege on the trigger function." That is
--          the only EXECUTE requirement stated, and it attaches to the
--          trigger CREATOR.
--        - Overview of Trigger Behavior docs describe fire-time context
--          purely as "the trigger will always run as the role that queued
--          the trigger event, unless the trigger function is marked as
--          SECURITY DEFINER" — no fire-time EXECUTE check is specified.
--        - Verified empirically on this schema (2026-08-11, local stack):
--          after `revoke execute on function tg_set_updated_at() from
--          public, anon, authenticated`, an UPDATE issued under `set role
--          authenticated` still fired the trigger and bumped updated_at.
--
--      So revoking EXECUTE here breaks nothing: existing triggers keep
--      firing, and future CREATE TRIGGER statements run in migrations as
--      postgres, which passes the creation-time check regardless. Nothing is
--      granted back — a trigger function with zero EXECUTE grantees is the
--      correct end state.
--
--   3. RPC GRANT NARROWING. anon (the key shipped inside every browser
--      bundle and app binary; PostgREST exposes each EXECUTE-able public
--      function at POST /rest/v1/rpc/<name>) held EXECUTE on ~30 user RPCs
--      that no anonymous flow calls. Revoked, with `authenticated` granted
--      back explicitly (0318 idiom: the grant states the intended end state
--      rather than hoping the surviving privilege was direct). Two RPCs with
--      no caller anywhere additionally lose `authenticated` (Group 3c).
--
-- POLICY-REFERENCE AUDIT (rule: an anon-reachable RLS policy that calls a
-- function needs the querying role to hold EXECUTE on it, because policy
-- expressions are evaluated with the querying role's privileges). Every
-- migration was swept for CREATE/ALTER POLICY expressions referencing each
-- function below. Results:
--
--   - has_org_role, has_permission, is_org_member: referenced by dozens of
--     policies, many created WITHOUT a TO clause (0010-0023, 0080, 0144,
--     0162-0164, 0203 among others), which defaults to PUBLIC — including
--     anon. anon still holds Supabase's default table privileges on most of
--     those tables, so an anonymous PostgREST request CAN reach those policy
--     expressions; revoking anon EXECUTE would turn today's silent empty
--     result / policy denial into a "permission denied for function" error on
--     an internet-facing surface. KEEPING anon EXECUTE on these three.
--     They are STABLE membership checks gated on auth.uid() (NULL for anon →
--     false), so anon EXECUTE discloses nothing. Not touched by this file.
--   - user_org_role: no policy reference in any migration. RLS-helper family,
--     so authenticated is kept per the standing rule; anon revoked.
--   - Every other function in Group 3: no policy reference in any migration
--     ('no policy reference' verified per function, same sweep — including
--     adjust_stock and post_cycle_count, which were added to the revoke list
--     after the live catalog showed they still carried anon EXECUTE).
--
-- CALLER AUDIT for the two full closures (Group 3c):
--   - generate_sku(uuid, text): zero references in apps/web, apps/mobile,
--     packages, and no call from any SQL function or policy. Granted to
--     authenticated in 0004 for an app layer that never materialized.
--   - log_audit(uuid, text, jsonb): zero references likewise (0007 comment
--     "signature stable for app layer" — the app layer writes audit rows
--     directly instead). SECURITY INVOKER, so no function-to-function caller
--     needs a grant either.
--   service_role retains EXECUTE on both (admin/ops path, not an anon
--   surface). If either is ever wired into the app, re-grant deliberately.
--
--   assign_cycle_count(uuid, uuid) is NOT closed for authenticated despite
--   having no live app caller today: 0282 granted it deliberately as the
--   manager assign/reassign surface with authorization enforced inside the
--   RPC, and the conservative rule is to keep authenticated when intent is
--   explicit. anon is revoked.
--
-- WHAT THIS FILE MUST NEVER TOUCH: citext extension functions. They are
-- first-party-adjacent (they live in `public` because 0001 created the
-- extension there) and intentionally unpinned — ALTERing extension member
-- functions would diverge them from the extension's shipped state and break
-- dump/restore and extension upgrades. The pgTAP suite for this migration
-- asserts every citext-owned function still has NULL proconfig.
--
-- Everything below is idempotent and safe to re-run.
--
-- ROLLBACK (manual, for reference — do not ship):
--   -- 1. Unpin (restores "no proconfig" state):
--   --   alter function public.<fn>(<args>) reset search_path;  -- x22
--   -- 2. Restore trigger-function grants:
--   --   grant execute on function public.<fn>() to anon, authenticated;  -- x34
--   -- 3. Restore anon on Group 3a/3b:
--   --   grant execute on function public.<fn>(<args>) to anon;
--   -- 4. Reopen Group 3c:
--   --   grant execute on function public.generate_sku(uuid, text) to authenticated;
--   --   grant execute on function public.log_audit(uuid, text, jsonb) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) SEARCH_PATH PINS — the 22 remaining unpinned first-party functions.
--    ALTER FUNCTION ... SET does not change bodies, ownership, or ACLs.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1a. Trigger functions (no args) + the _dedup_rack_locations maintenance
--     helper (listed with the triggers in the sweep inventory, but it
--     `returns integer`; its grants were already fully revoked in 0270).
alter function public._clear_auto_archived_on_unarchive()   set search_path = public;
alter function public._clear_awaiting_first_receipt()       set search_path = public;
alter function public._dedup_rack_locations()               set search_path = public;
alter function public._enforce_schedule_events_writer()     set search_path = public;
alter function public._guard_org_billing_columns()          set search_path = public;
alter function public._track_zero_since()                   set search_path = public;
alter function public.shipments_enforce_status_transition() set search_path = public;
alter function public.tg_inventory_items_set_updated_at()   set search_path = public;
alter function public.tg_items_search_vector()              set search_path = public;
alter function public.tg_pin_product_group_org()            set search_path = public;
alter function public.tg_pin_user_profile_disable_flags()   set search_path = public;
alter function public.tg_pin_user_profile_email()           set search_path = public;
alter function public.tg_set_updated_at()                   set search_path = public;

-- 1b. RPCs.
alter function public.duplicate_inventory_item(uuid, jsonb)                    set search_path = public;
alter function public.generate_sku(uuid, text)                                 set search_path = public;
alter function public.inventory_distinct_racks(text)                           set search_path = public;
alter function public.inventory_set_rack(uuid[], text, text, text, text)       set search_path = public;
alter function public.inventory_value(uuid)                                    set search_path = public;
alter function public.log_audit(uuid, text, jsonb)                             set search_path = public;
alter function public.low_stock_count(uuid)                                    set search_path = public;
alter function public.low_stock_items(uuid, integer)                           set search_path = public;
alter function public.order_request_top_skus_for_warehouse(uuid, integer, integer) set search_path = public;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) TRIGGER FUNCTIONS — revoke ALL EXECUTE (PUBLIC, anon, authenticated).
--    Complete first-party `returns trigger` set (34). Nothing granted back;
--    see the header for why trigger firing does not need it.
-- ═══════════════════════════════════════════════════════════════════════════

revoke execute on function public._auto_restock_restore()                       from public, anon, authenticated;
revoke execute on function public._clear_auto_archived_on_unarchive()           from public, anon, authenticated;
revoke execute on function public._clear_awaiting_first_receipt()               from public, anon, authenticated;
revoke execute on function public._dispatch_push_for_notification()             from public, anon, authenticated;
revoke execute on function public._enforce_schedule_events_writer()             from public, anon, authenticated;
revoke execute on function public._grant_all_warehouse_access()                 from public, anon, authenticated;
revoke execute on function public._guard_org_billing_columns()                  from public, anon, authenticated;
revoke execute on function public._guard_organization_member_changes()          from public, anon, authenticated;
revoke execute on function public._notify_bundle_shortage()                     from public, anon, authenticated;
revoke execute on function public._notify_cycle_count_assigned()                from public, anon, authenticated;
revoke execute on function public._notify_low_stock()                           from public, anon, authenticated;
revoke execute on function public._notify_order_request_changes()               from public, anon, authenticated;
revoke execute on function public._notify_po_status()                           from public, anon, authenticated;
revoke execute on function public._notify_receipt_posted()                      from public, anon, authenticated;
revoke execute on function public._touch_ai_chat_session()                      from public, anon, authenticated;
revoke execute on function public._touch_schedule_events_updated_at()           from public, anon, authenticated;
revoke execute on function public._track_zero_since()                           from public, anon, authenticated;
revoke execute on function public._validate_order_request_status_transition()   from public, anon, authenticated;
revoke execute on function public._validate_return_status_transition()          from public, anon, authenticated;
revoke execute on function public.assign_maintenance_request_number()           from public, anon, authenticated;
revoke execute on function public.assign_order_request_number()                 from public, anon, authenticated;
revoke execute on function public.seed_org_modules()                            from public, anon, authenticated;
revoke execute on function public.shipments_enforce_status_transition()         from public, anon, authenticated;
revoke execute on function public.tg_handle_new_auth_user()                     from public, anon, authenticated;
revoke execute on function public.tg_inventory_items_set_updated_at()           from public, anon, authenticated;
revoke execute on function public.tg_inventory_set_archived_at()                from public, anon, authenticated;
revoke execute on function public.tg_items_search_vector()                      from public, anon, authenticated;
revoke execute on function public.tg_pin_product_group_org()                    from public, anon, authenticated;
revoke execute on function public.tg_pin_user_profile_disable_flags()           from public, anon, authenticated;
revoke execute on function public.tg_pin_user_profile_email()                   from public, anon, authenticated;
revoke execute on function public.tg_return_lines_enforce_fulfilled_cap()       from public, anon, authenticated;
revoke execute on function public.tg_seed_initial_level()                       from public, anon, authenticated;
revoke execute on function public.tg_seed_warehouse_locations()                 from public, anon, authenticated;
revoke execute on function public.tg_set_updated_at()                           from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3a) USER RPCs — anon revoked, authenticated explicitly restated.
--     Every function here is either in the client .rpc() call inventory or is
--     called through the user-authed server client (ctx.supabase), and none
--     is referenced by any RLS policy ('no policy reference' per the header
--     audit). The paired grant is the intended end state, not decoration.
-- ═══════════════════════════════════════════════════════════════════════════

-- adjust_stock and post_cycle_count sit at the heart of the stock ledger and
-- were still anon-EXECUTE (never revoked by any prior migration — verified
-- against the live catalog). No policy references either; the SECURITY
-- INVOKER functions that call adjust_stock internally (post_receipt_v2,
-- reverse_receipt, post_shipment_shipped) all retain authenticated EXECUTE
-- themselves, so every legitimate caller chain is unaffected.
revoke execute on function public.adjust_stock(uuid, numeric, text, uuid, text, text, text) from public, anon, authenticated;
grant  execute on function public.adjust_stock(uuid, numeric, text, uuid, text, text, text) to authenticated;

revoke execute on function public.post_cycle_count(uuid)                  from public, anon, authenticated;
grant  execute on function public.post_cycle_count(uuid)                  to authenticated;

revoke execute on function public.approve_order_request(uuid)             from public, anon, authenticated;
grant  execute on function public.approve_order_request(uuid)             to authenticated;

revoke execute on function public.approve_partial(uuid)                   from public, anon, authenticated;
grant  execute on function public.approve_partial(uuid)                   to authenticated;

revoke execute on function public.assign_cycle_count(uuid, uuid)          from public, anon, authenticated;
grant  execute on function public.assign_cycle_count(uuid, uuid)          to authenticated;

revoke execute on function public.assign_picking(uuid, uuid)              from public, anon, authenticated;
grant  execute on function public.assign_picking(uuid, uuid)              to authenticated;

revoke execute on function public.cancel_order_request(uuid, text)        from public, anon, authenticated;
grant  execute on function public.cancel_order_request(uuid, text)        to authenticated;

revoke execute on function public.claim_picking(uuid)                     from public, anon, authenticated;
grant  execute on function public.claim_picking(uuid)                     to authenticated;

revoke execute on function public.close_partial(uuid)                     from public, anon, authenticated;
grant  execute on function public.close_partial(uuid)                     to authenticated;

revoke execute on function public.complete_picking(uuid)                  from public, anon, authenticated;
grant  execute on function public.complete_picking(uuid)                  to authenticated;

revoke execute on function public.confirm_physical_signature(uuid, text)  from public, anon, authenticated;
grant  execute on function public.confirm_physical_signature(uuid, text)  to authenticated;

revoke execute on function public.consume_mfa_recovery_code(text)         from public, anon, authenticated;
grant  execute on function public.consume_mfa_recovery_code(text)         to authenticated;

revoke execute on function public.edit_movement_note(uuid, text)          from public, anon, authenticated;
grant  execute on function public.edit_movement_note(uuid, text)          to authenticated;

revoke execute on function public.force_reassign_cycle_count(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.force_reassign_cycle_count(uuid, uuid, text) to authenticated;

revoke execute on function public.generate_mfa_recovery_codes()           from public, anon, authenticated;
grant  execute on function public.generate_mfa_recovery_codes()           to authenticated;

revoke execute on function public.partial_pick_line(uuid, numeric)        from public, anon, authenticated;
grant  execute on function public.partial_pick_line(uuid, numeric)        to authenticated;

revoke execute on function public.release_cycle_count(uuid, text)         from public, anon, authenticated;
grant  execute on function public.release_cycle_count(uuid, text)         to authenticated;

revoke execute on function public.release_picking(uuid)                   from public, anon, authenticated;
grant  execute on function public.release_picking(uuid)                   to authenticated;

revoke execute on function public.reopen_picking(uuid, text)              from public, anon, authenticated;
grant  execute on function public.reopen_picking(uuid, text)              to authenticated;

revoke execute on function public.resume_fulfillment(uuid)                from public, anon, authenticated;
grant  execute on function public.resume_fulfillment(uuid)                to authenticated;

revoke execute on function public.revoke_my_other_sessions(uuid)          from public, anon, authenticated;
grant  execute on function public.revoke_my_other_sessions(uuid)          to authenticated;

revoke execute on function public.revoke_my_session(uuid)                 from public, anon, authenticated;
grant  execute on function public.revoke_my_session(uuid)                 to authenticated;

revoke execute on function public.set_default_bin(uuid, uuid, text, uuid) from public, anon, authenticated;
grant  execute on function public.set_default_bin(uuid, uuid, text, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3b) SECURITY INVOKER helper RPCs — anon revoked, authenticated kept.
--     user_org_role is an RLS-helper-family function (kept for authenticated
--     by standing rule even though no policy references it today); the other
--     three are dashboard read RPCs in the client .rpc() inventory.
-- ═══════════════════════════════════════════════════════════════════════════

revoke execute on function public.user_org_role(uuid)                     from public, anon, authenticated;
grant  execute on function public.user_org_role(uuid)                     to authenticated;

revoke execute on function public.inventory_value(uuid)                   from public, anon, authenticated;
grant  execute on function public.inventory_value(uuid)                   to authenticated;

revoke execute on function public.low_stock_count(uuid)                   from public, anon, authenticated;
grant  execute on function public.low_stock_count(uuid)                   to authenticated;

revoke execute on function public.low_stock_items(uuid, integer)          from public, anon, authenticated;
grant  execute on function public.low_stock_items(uuid, integer)          to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3c) ORPHANED RPCs — closed to anon AND authenticated (caller audit in the
--     header: zero call sites anywhere). service_role restated explicitly.
-- ═══════════════════════════════════════════════════════════════════════════

revoke execute on function public.generate_sku(uuid, text)                from public, anon, authenticated;
grant  execute on function public.generate_sku(uuid, text)                to service_role;

revoke execute on function public.log_audit(uuid, text, jsonb)            from public, anon, authenticated;
grant  execute on function public.log_audit(uuid, text, jsonb)            to service_role;

-- 3d) DELIBERATELY NOT TOUCHED: has_org_role(uuid, text),
--     has_permission(uuid, text), is_org_member(uuid) — referenced by
--     anon-reachable policies (no TO clause = PUBLIC); see the header audit.
--     Revoking anon here would 500 anonymous requests that today get a clean
--     policy denial. The pgTAP suite pins this keep so a future sweep must
--     consciously revisit it.

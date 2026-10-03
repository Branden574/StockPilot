-- 0387_order_workflow_guard.sql
--
-- SECURITY (S0): an order is approved, and moved along every stock-bearing
-- status edge, only by the order RPCs. Signed-in callers keep the six edges the
-- app writes through the user client (deny, pick slip, packing slips, both
-- stagings, in transit). One SECURITY INVOKER trigger function, one BEFORE
-- UPDATE trigger, column and table revokes on order_requests, comments. No
-- table, column, index, policy or data change, and no existing function body
-- changes (approve_order_request, approve_partial, the transition trigger and
-- every other order RPC keep their md5).
--
-- ── THE HOLE (pre-existing; read on production 2026-10-02) ───────────────
-- authenticated held column UPDATE on 57 of the 58 order_requests columns
-- (0384 withheld organization_id only), order_requests_update admits a manager
-- or an orders:approve holder, and the transition trigger allows
-- pending_approval -> approved for any writer. So one PostgREST
-- PATCH {"status":"approved"} approved an order with no stock check, no holds,
-- no warehouse scope, no MFA and no audit row, and still pushed "Stock has
-- been reserved" to the requester. The same PATCH reached every other edge the
-- RPCs own: cancel (skips the hold release and the restock), picking complete
-- (skips the stock draw), completed or backordered (skips the hand-over
-- accounting and the signature), resume, reopen and close partial. And it
-- could forge or erase the approval, completion and signature stamps. At
-- audit time (2026-10-02) every L4L approval carried its audit row and its
-- holds; no use of the raw approval was found.
--
-- ── WHO WRITES ORDER STATUS AND THE GUARDED COLUMNS (census on 853d6def) ──
--   - approve_order_request, approve_partial: the only writers of approved,
--     approved_by and approved_at. SECURITY DEFINER, owned by postgres, so
--     current_user is postgres inside them.
--   - Every other edge an RPC owns (cancel_order_request, complete_picking,
--     partial_pick_line, reopen_picking, resume_fulfillment, close_partial,
--     confirm_physical_signature, confirm_order_signature,
--     confirm_public_order_request) and the picker and needed-by RPCs: all
--     SECURITY DEFINER. The 15 functions whose body updates order_requests are
--     all DEFINER; no SECURITY INVOKER function updates the table.
--   - The web's user client (services/order-requests.ts) makes exactly six
--     status edges: deny (pending_approval -> denied), the pick slip
--     (approved -> pick_slip_generated), packing slips (picking_complete ->
--     packing_slip_generated, or a same-status regenerate), staging
--     (packing_slip_generated -> staged_for_pickup / staged_for_delivery) and
--     in transit (staged_for_delivery -> in_transit). Its other two writes are
--     internal_notes and the assigned_delivery_* stamps. None names a column
--     revoked below.
--   - The admin client (service_role): the return prompt (return_token,
--     return_prompt_sent_at), the public and portal inserts, announceLineChange
--     (updated_at).
--   - FK actions: order_requests_approved_by_fkey ON DELETE SET NULL nulls
--     approved_by when an approver's account is deleted (web, phone and
--     platform deletion). RI actions run as the table owner (postgres).
--   - The phone never writes order_requests (every bundle in history); its
--     order actions go through /api/v1, the service and the RPCs.
--
-- ── WHY current_user AND NO TRANSACTION-LOCAL FLAG ───────────────────────
-- Every legitimate writer of a refused edge or column runs as a non-API role
-- (postgres for DEFINER bodies, fixtures and FK actions; service_role for the
-- admin client). A flag set by the approval RPCs would need edits to their
-- md5-pinned bodies and would refuse the FK SET NULL, blocking account
-- deletion for every account that ever approved an order. Never key this on
-- auth.uid() or JWT claims: a DEFINER body and a cascade still carry the
-- caller's JWT (0359). The shape is 0218's and 0359's.
--
-- ── ORDER OF THE BEFORE UPDATE TRIGGERS (by name) ─────────────────────────
--   order_requests_set_updated_at, trg_order_requests_validate_transition,
--   trg_order_requests_workflow_guard. An illegal edge still reports
--   invalid_status_transition (P0001) first; a legal edge an API role may not
--   make reports status_through_rpc_only (42501).
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- 42501 (PostgREST answers 403) with a stable hint: approval_through_rpc_only
-- or status_through_rpc_only. Never 40001 or 40P01 (PostgREST retries those).
--
-- ── COLUMN REVOKES ────────────────────────────────────────────────────────
-- authenticated holds no table-level UPDATE since 0384, so column revokes take
-- effect. 21 columns only the order RPCs or the admin client write, plus 17
-- (owner decision O5, default yes) that no user-client path writes.
-- created_at and warehouse_id (owner question Q4, pinned editable by 0379 C1)
-- and delivery_charter_id (owner question Q7, pinned by 0382 C1) stay
-- writable until the owner answers. authenticated keeps UPDATE on exactly 19
-- columns: status, denied_reason, internal_notes, the pick-slip, packing-slip,
-- staging, delivery-assignment and in-transit stamps, signature_token and its
-- expiry, created_at, warehouse_id and delivery_charter_id.
--
-- Lock footprint (read from pg_locks on the local stack; the push holds each
-- lock to the end of the file): CREATE OR REPLACE TRIGGER takes SHARE ROW
-- EXCLUSIVE on order_requests and COMMENT ON COLUMN SHARE UPDATE EXCLUSIVE;
-- the REVOKEs and CREATE OR REPLACE FUNCTION take no lock on the table. None
-- of these conflicts with a reader (ACCESS SHARE), so order pages, the RLS
-- subqueries on order_request_lines and order_request_attachments, and an
-- open report export are never blocked and never block the push. Writers
-- (ROW EXCLUSIVE) wait while the file runs (56 ms on the local stack).
-- lock_timeout 5s fails the push fast instead of queueing behind a long
-- writer. Proven by scripts/db-concurrency/0387_migration_lock_footprint.sh.
-- This migration writes no row.

set lock_timeout = '5s';

create or replace function public.tg_order_requests_workflow_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Only the API roles are held here. The order RPCs are SECURITY DEFINER and
  -- run as postgres, the server's admin client is service_role, and foreign-key
  -- actions (approved_by ON DELETE SET NULL) run as the table owner, so none of
  -- them is 'authenticated' or 'anon' here. SECURITY INVOKER on purpose: a
  -- DEFINER trigger always sees postgres and would never enforce. Never key
  -- this on auth.uid() or JWT claims: a DEFINER body and a cascade still carry
  -- the caller's JWT (0359).
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if new.approved_by is distinct from old.approved_by
     or new.approved_at is distinct from old.approved_at then
    raise exception 'order_approval_through_rpc_only'
      using errcode = '42501',
            hint    = 'approval_through_rpc_only',
            detail  = 'An order''s approver and approval time are set only by approve_order_request or approve_partial.';
  end if;

  -- The edge, never the value: a notes save on an approved order keeps
  -- status = 'approved' and must pass.
  if new.status is distinct from old.status
     and (old.status, new.status) not in (
       ('pending_approval',       'denied'),
       ('approved',               'pick_slip_generated'),
       ('picking_complete',       'packing_slip_generated'),
       ('packing_slip_generated', 'staged_for_pickup'),
       ('packing_slip_generated', 'staged_for_delivery'),
       ('staged_for_delivery',    'in_transit')
     ) then
    raise exception 'order_status_through_rpc_only'
      using errcode = '42501',
            hint    = 'status_through_rpc_only',
            detail  = format('An order moves from %s to %s only through its order action.', old.status, new.status);
  end if;

  return new;
end;
$$;

comment on function public.tg_order_requests_workflow_guard() is
  'BEFORE UPDATE guard (0387): an API-role caller may not change approved_by or approved_at, and may '
  'change status only along the six edges the app writes through the user client. The order RPCs '
  '(SECURITY DEFINER), the admin client and FK actions are not API roles and pass.';

revoke all on function public.tg_order_requests_workflow_guard() from public, anon, authenticated;

-- Name sorts after trg_order_requests_validate_transition ('v' < 'w'), so an
-- illegal edge still reports invalid_status_transition first, and before the
-- routing plan's trg_order_requests_zreview_gate. CREATE OR REPLACE, as
-- 0360 and 0362-0365 do, and never DROP TRIGGER IF EXISTS first: a DROP
-- takes ACCESS EXCLUSIVE on order_requests even when the trigger does not
-- exist, and the push would hold it to the end of the file, stopping every
-- order read.
create or replace trigger trg_order_requests_workflow_guard
  before update on public.order_requests
  for each row execute function public.tg_order_requests_workflow_guard();

-- Columns only the order RPCs or the admin client write (audit 1, 3.3 and 9;
-- audit 2, 5.5). Column revokes are effective: authenticated holds no
-- table-level UPDATE since 0384.
revoke update (approved_by, approved_at,
               cancelled_at, cancelled_by,
               assigned_picker_id, picking_claimed_at, picking_claimed_by,
               picking_completed_at, picking_completed_by,
               signed_by_name, signed_by_email, signature_data_url, signature_method,
               signed_at, completed_at, completed_by,
               return_token, return_prompt_sent_at, public_track_token,
               confirmation_token_hash, confirmation_token_expires_at)
  on table public.order_requests from authenticated;

-- Owner decision O5 (default yes): columns that no user-client path writes
-- either. The 8 user-client .update( payloads in services/order-requests.ts
-- write none of these. needed_by is owned by revise_order_needed_by (0383),
-- which this closes as a raw-PATCH bypass; customer_id would put an internal
-- order on a B2B customer's portal (portal.ts:491-501); requester_user_id
-- moves pings, self-cancel and return rights to another member. created_at,
-- warehouse_id and delivery_charter_id are NOT here: 0379 C1 pins the first
-- two editable (owner question Q4) and 0382 C1 pins the charter editable
-- (owner question Q7); add them only on the owner's yes.
revoke update (id, order_number, source, customer_id, needed_by,
               requester_user_id, requester_email, requester_name, requester_phone,
               requester_org_label, fulfillment_type,
               pickup_location_notes, notes, delivered_at, packaging_at, ready_at,
               updated_at)
  on table public.order_requests from authenticated;

-- Hygiene: unreachable through PostgREST, removed with the same migration.
-- anon has no order_requests policy, so it never reached a row; every public
-- path uses the admin client.
revoke truncate, references, trigger, maintain on table public.order_requests from authenticated;
revoke all on table public.order_requests from anon;

comment on column public.order_requests.approved_by is
  'Who approved the order. Written only by approve_order_request and approve_partial (as postgres) and '
  'nulled by the user_profiles FK when an account is deleted. authenticated holds no UPDATE on it (0387) '
  'and tg_order_requests_workflow_guard refuses an API-role change.';

reset lock_timeout;

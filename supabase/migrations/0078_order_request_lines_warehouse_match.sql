-- ============================================================================
-- 0078_order_request_lines_warehouse_match.sql
--
-- I7 from the Orders hunter report: the order_request_lines INSERT RLS
-- policy (from 0044) only verifies the parent order_request belongs to
-- the current requester. It does NOT verify the inserted item belongs
-- to the same warehouse as the parent request.
--
-- The TS service-layer create() already validates this app-side, but
-- RLS is the canonical guardrail — a manager-account driver, an admin
-- SQL session, or a hypothetical future "bulk-import lines" pathway
-- could still insert a line whose item lives in a different warehouse
-- than the parent request. That breaks the
-- `item.warehouse_id = request.warehouse_id` invariant that approve /
-- deliver rely on, and would surface as a confusing
-- 'item_warehouse_mismatch' error from approve_order_request at the
-- worst possible moment (manager clicking Approve in the UI).
--
-- Fix: tighten the INSERT policy so the WITH CHECK verifies that the
-- referenced inventory_item lives in the parent request's warehouse
-- AND the parent request is in the caller's org.
--
-- We also broaden the `requester_user_id = auth.uid()` check to
-- `is_org_member(r.organization_id)` because manager-driven imports
-- (e.g. a future admin tool that re-issues a missed line on a
-- still-pending request) should be allowed by RLS even though they
-- aren't the original requester — the underlying service code still
-- gates per-action; this just stops RLS from being the bottleneck on
-- legitimate paths.
-- ============================================================================

drop policy if exists order_request_lines_insert on public.order_request_lines;
create policy order_request_lines_insert on public.order_request_lines
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.order_requests r
      join public.inventory_items ii
        on ii.id = order_request_lines.item_id
       and ii.organization_id = r.organization_id
      where r.id = order_request_lines.order_request_id
        and (
          r.requester_user_id = auth.uid()
          or public.has_org_role(r.organization_id, 'manager')
        )
        and ii.warehouse_id = r.warehouse_id
    )
  );

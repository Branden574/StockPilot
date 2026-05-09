-- ============================================================================
-- 0049_lines_status_gate.sql
-- ============================================================================
-- Closes two findings from the offensive-mode security audit.
--
-- M2: order_request_lines INSERT had no status gate, so an authenticated
--     requester could append a line to their own order AFTER the
--     manager approved it. deliver_order_request iterates every line,
--     which would then decrement stock for an item the manager never
--     reviewed. Tightened to require status='pending_approval' on the
--     parent order_requests row.
--
-- M1: cycle_count_lines was writable by any manager+ regardless of the
--     parent count's status. So a manager could overwrite a
--     counted_quantity AFTER the count was posted, or write to a
--     canceled count, bypassing the audit trail set by recordCount()
--     in the service. Tightened to require status='in_progress' on
--     the parent cycle_counts row, AND require counted_by =
--     auth.uid() OR null on insert/update so the audit field can't
--     be impersonated.
-- ============================================================================

-- ── order_request_lines: status gate on INSERT ────────────────────────
drop policy if exists order_request_lines_insert on public.order_request_lines;
create policy order_request_lines_insert on public.order_request_lines
  for insert to authenticated
  with check (
    exists (
      select 1 from public.order_requests r
      where r.id = order_request_lines.order_request_id
        and r.requester_user_id = auth.uid()
        and r.status = 'pending_approval'
    )
  );

-- order_request_lines update + delete should be locked down too —
-- once a line is created it shouldn't be mutated outside the SQL
-- approve/deliver/cancel functions. No UPDATE/DELETE policies means
-- those operations are blocked for end users; SECURITY DEFINER
-- functions still work. Idempotent: drop any historical UPDATE
-- policy if one was added.
drop policy if exists order_request_lines_update on public.order_request_lines;
drop policy if exists order_request_lines_delete on public.order_request_lines;

-- ── cycle_count_lines: status gate ────────────────────────────────────
drop policy if exists cycle_count_lines_write on public.cycle_count_lines;
create policy cycle_count_lines_write on public.cycle_count_lines
  for all to authenticated
  using (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and public.has_org_role(cc.organization_id, 'manager')
        and cc.status = 'in_progress'
    )
  )
  with check (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and public.has_org_role(cc.organization_id, 'manager')
        and cc.status = 'in_progress'
    )
    -- Audit-field integrity: counted_by may only be the calling
    -- user or null. Stops a manager from setting counted_by =
    -- another user to obscure who recorded a value.
    and (counted_by is null or counted_by = auth.uid())
  );

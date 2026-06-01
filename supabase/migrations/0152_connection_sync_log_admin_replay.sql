-- ============================================================================
-- 0152_connection_sync_log_admin_replay.sql — operator replay of dead-letters.
--
-- connection_sync_log is the per-(connection,event) delivery ledger. Failed
-- connector exports dead-letter here (status='dead' after MAX_ATTEMPTS, or
-- 'error' with backoff). Until now the table had ONLY a member SELECT policy
-- (0146) — every WRITE was reserved for the service-role drainer. That left no
-- way for an operator to re-queue an event after fixing the root cause (a bad
-- QBO account id, an expired token): exports just stayed silently behind.
--
-- This migration adds a NARROW, admin-gated UPDATE policy so the new replay
-- endpoint can flip a failed row back to 'pending' through the user's
-- (authenticated) request client, keeping RLS as the real security boundary
-- (the service layer adds the integrations:manage / shipping:manage gate + an
-- explicit org/status filter as defense in depth).
--
-- FAIL-CLOSED design:
--   * scoped to the caller's own org via has_org_role(organization_id,'admin')
--     in BOTH `using` (which existing rows are visible to update) and
--     `with check` (what the row may become) — an admin can never touch another
--     org's ledger;
--   * `with check` additionally pins the NEW row to status='pending' so this
--     policy can ONLY be used to re-queue, never to forge a 'success' row or
--     otherwise rewrite ledger history;
--   * requires the 'admin' org role (owner+admin) — manager/staff/viewer
--     cannot replay (the app-layer permission gate further requires the
--     integrations:manage / shipping:manage capability).
--
-- Policies wrap helper calls in (SELECT ...) per the InitPlan convention (0140)
-- and use the `drop policy if exists` idempotency guard from 0144/0146.
-- The table already has RLS enabled and authenticated already holds the table
-- UPDATE grant (0146 granted select; we add update below). is_org_member /
-- has_org_role are re-used verbatim from 0001_init.sql.
-- ============================================================================

-- Admin-only replay: re-queue a failed (error/dead) export. The status check is
-- on the POST-update row (with check), so the only legal transition this policy
-- permits is "set status='pending'". The drainer (service_role) is unaffected —
-- it bypasses RLS entirely. We do NOT add a broad authenticated UPDATE; this is
-- the single permitted write path for the authenticated role.
drop policy if exists connection_sync_log_admin_replay on public.connection_sync_log;
create policy connection_sync_log_admin_replay on public.connection_sync_log
  for update to authenticated
  using ((select public.has_org_role(organization_id, 'admin')))
  with check (
    (select public.has_org_role(organization_id, 'admin'))
    and status = 'pending'
  );

-- 0146 granted only SELECT on this table to authenticated. The UPDATE above
-- needs the table-level UPDATE privilege too (RLS narrows it to the policy).
grant update on public.connection_sync_log to authenticated;

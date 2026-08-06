-- 0317_maintenance_resolved.sql
--
-- Maintenance Resolved (owner decisions D1-D5, spec
-- docs/superpowers/specs/2026-08-06-maintenance-resolved-design.md).
-- Adds the fifth status 'resolved' + resolution columns + the at-most-once
-- resolution-email stamp + attachments.kind + the muteable pref column, and
-- recreates (pattern #24: drop + create, never `alter policy`) the three
-- policies whose predicates change. SELECT policies are deliberately
-- untouched (D4: history stays visible forever). No permission seeds — the
-- 0207 pgTAP count stays 119.

-- ── 1) Status CHECK: 4 → 5 values ───────────────────────────────────────────
alter table public.maintenance_requests
  drop constraint maintenance_requests_status_check;
alter table public.maintenance_requests
  add constraint maintenance_requests_status_check
  check (status in ('saved','draft_opened','resolved','archived','cancelled'));

-- ── 2) Resolution columns ───────────────────────────────────────────────────
-- resolved_by_name_snapshot: the requester_name_snapshot precedent (0314) —
-- display + email read the snapshot; no cross-profile read or embed needed.
-- resolution_email_sent_at: the 0278 return_prompt_sent_at twin (at-most-once).
alter table public.maintenance_requests
  add column if not exists resolved_at               timestamptz,
  add column if not exists resolved_by               uuid references auth.users(id) on delete set null,
  add column if not exists resolved_by_name_snapshot text
    check (resolved_by_name_snapshot is null or length(resolved_by_name_snapshot) between 1 and 200),
  add column if not exists resolution_note           text
    check (resolution_note is null or length(resolution_note) between 1 and 2000),
  add column if not exists resolution_email_sent_at  timestamptz;

comment on column public.maintenance_requests.resolved_at is
  'StockPilot-local close-out record. Never an observation of Zendesk state — StockPilot cannot see the ticket.';

-- ── 3) Attachment kind ──────────────────────────────────────────────────────
-- One column, not a second table: the 0316 (org, storage_path) uniqueness
-- must keep covering proof photos (phantom-photo cap bypass), and the share
-- page + photo proxy index into ONE shared ordered list.
alter table public.maintenance_request_attachments
  add column if not exists kind text not null default 'requester'
    check (kind in ('requester','resolution'));

-- ── 4) RLS recreates (pattern #24; EXISTS qualification per pattern #25) ────
-- 4a. maintenance_requests_update: the requester's own-row arm now also
--     requires resolved_at IS NULL (resolved is a closed state).
drop policy if exists maintenance_requests_update on public.maintenance_requests;
create policy maintenance_requests_update on public.maintenance_requests
  for update to authenticated
  using (
    (requester_user_id = (select auth.uid()) and archived_at is null and cancelled_at is null
      and resolved_at is null
      and (select public.has_org_role(organization_id, 'viewer')))
    or (select public.has_org_role(organization_id, 'manager'))
    or (select public.has_permission(organization_id, 'maintenance_requests:manage'))
  )
  with check (
    (
      (requester_user_id = (select auth.uid()) and (select public.has_org_role(organization_id, 'viewer')))
      or (select public.has_org_role(organization_id, 'manager'))
      or (select public.has_permission(organization_id, 'maintenance_requests:manage'))
    )
    and (select public.module_enabled(organization_id, 'maintenance_requests'))
  );

-- 4b. attachments INSERT: parent must also be un-resolved; only a
--     manage-holder may label a row 'resolution' (a requester inserting
--     straight through PostgREST must not be able to plant a self-supplied
--     image labeled as staff proof on the share page / email).
drop policy if exists maintenance_request_attachments_insert on public.maintenance_request_attachments;
create policy maintenance_request_attachments_insert on public.maintenance_request_attachments
  for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and (select public.module_enabled(organization_id, 'maintenance_requests'))
    and (
      kind = 'requester'
      or (select public.has_permission(organization_id, 'maintenance_requests:manage'))
    )
    and exists (
      select 1 from public.maintenance_requests r
       where r.id = maintenance_request_id
         and r.organization_id = maintenance_request_attachments.organization_id
         and r.archived_at is null and r.cancelled_at is null and r.resolved_at is null
         and (
           r.requester_user_id = (select auth.uid())
           or (select public.has_org_role(r.organization_id, 'manager'))
           or (select public.has_permission(r.organization_id, 'maintenance_requests:manage'))
         )
    )
  );

-- 4c. attachments DELETE: photos of a resolved request are frozen history.
drop policy if exists maintenance_request_attachments_delete on public.maintenance_request_attachments;
create policy maintenance_request_attachments_delete on public.maintenance_request_attachments
  for delete to authenticated
  using (
    exists (
      select 1 from public.maintenance_requests r
       where r.id = maintenance_request_id
         and r.organization_id = maintenance_request_attachments.organization_id
         and r.archived_at is null and r.cancelled_at is null and r.resolved_at is null
         and (
           r.requester_user_id = (select auth.uid())
           or (select public.has_org_role(r.organization_id, 'manager'))
           or (select public.has_permission(r.organization_id, 'maintenance_requests:manage'))
         )
    )
  );

-- ── 5) Muteable pref column (0265 recipe; fail-open in code) ────────────────
alter table public.notification_preferences
  add column if not exists push_maintenance_resolved boolean not null default true;

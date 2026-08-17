-- 0338_export_presets.sql
--
-- DB-backed SHARED export presets for the Export Builder (owner decision 8,
-- 2026-08-16). One row = one named, org-visible preset: the serialized
-- builder config (field keys in output order, format, options) plus who
-- saved it. The existing per-browser localStorage presets are untouched;
-- these rows are the "share it with the team" tier the Export Builder
-- program report recommended as the next phase.
--
-- THE STORED CONFIG IS CLIENT-INFLUENCED DATA. This migration ships a SHAPE
-- FLOOR only (object + fieldKeys array), the 0337 email_routing posture: the
-- authoritative validation lives in TS where the field registry lives
-- (apps/web/src/lib/exports/preset-config.ts sanitizes on load, dropping
-- unknown field ids with a visible note), and FIELD PERMISSIONS are enforced
-- at export time by resolveExportFields on the server — a preset is a
-- suggestion the export route re-validates for the CURRENT user, never a
-- bypass. A second SQL definition of "valid config" would drift from the
-- registry the moment a field is added or retired.
--
-- Presets are IMMUTABLE by design: no UPDATE grant and no UPDATE policy.
-- "Save" is INSERT-only, and UNIQUE (org, lower(name)) makes a duplicate
-- name a loud 23505 instead of a silent shadow — replacing a preset is an
-- explicit delete + re-save. updated_at exists (with the tg_set_updated_at
-- trigger) only so a future rename/update feature needs no new migration;
-- today it always equals created_at.

create table if not exists public.export_presets (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 60),
  config          jsonb not null,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.export_presets is
  'Org-shared Export Builder presets. config = {itemTypeKind, fieldKeys[], format?, options?}; validated in TS against the field registry on load (unknown fields dropped with a note) and re-gated per-user by resolveExportFields at export time. The CHECK below is a shape floor only.';

-- SHAPE FLOOR ONLY (0337 posture). NULL-PROPAGATION NOTE, inherited from
-- 0337's pgTAP catch: jsonb_typeof(config -> 'fieldKeys') is SQL NULL when
-- the key is absent and `NULL = 'array'` is NULL — a NULL CHECK passes — so
-- the typeof-equality on the possibly-absent key is coalesced to false.
alter table public.export_presets add constraint export_presets_config_shape check (
  jsonb_typeof(config) = 'object'
  and coalesce(jsonb_typeof(config -> 'fieldKeys') = 'array', false)
);

-- Two saves can never silently shadow each other: name identity is
-- case-insensitive within the org.
create unique index if not exists export_presets_org_name_uniq
  on public.export_presets (organization_id, lower(name));

create index if not exists export_presets_org_created_idx
  on public.export_presets (organization_id, created_at desc);

-- updated_at maintenance (tg_set_updated_at convention, 0001; nearest
-- precedent 0314_maintenance_requests.sql). Dormant until an update path
-- exists — see the immutability note above.
drop trigger if exists trg_export_presets_updated_at on public.export_presets;
create trigger trg_export_presets_updated_at
  before update on public.export_presets
  for each row execute function public.tg_set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Every helper call is initplan-wrapped in (select ...) — the 0140 convention
-- every new policy since 0297 follows. No UPDATE policy (immutable rows), so
-- pattern #24 (`alter policy ... with check` REPLACES) has no surface here.
alter table public.export_presets enable row level security;

grant select, insert, delete on public.export_presets to authenticated;

-- SELECT: every accepted, non-disabled org member. A preset is not a secret —
-- it names columns, not data — and anyone who can open the export dialog
-- should see the team's presets.
create policy export_presets_select on public.export_presets
  for select to authenticated
  using ((select public.is_org_member(organization_id)));

-- INSERT: gated EXACTLY the way the export itself is (items:export — the
-- permission POST /api/inventory/export checks), and rows are always
-- attributed to their real author (created_by must be the caller; a forged
-- author is a policy violation, not a normalized write).
create policy export_presets_insert on public.export_presets
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select public.has_permission(organization_id, 'items:export'))
  );

-- DELETE: the creator, or an org admin (has_org_role 'admin' = admin/owner
-- rank). Membership is re-checked so a creator who left the org (or was
-- disabled — is_org_member/has_org_role both refuse disabled accounts per
-- 0310) cannot still reach in and delete.
create policy export_presets_delete on public.export_presets
  for delete to authenticated
  using (
    (select public.is_org_member(organization_id))
    and (
      created_by = (select auth.uid())
      or (select public.has_org_role(organization_id, 'admin'))
    )
  );

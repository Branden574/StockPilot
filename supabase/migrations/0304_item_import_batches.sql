-- Same-file dedupe for the GENERIC items CSV import.
--
-- Live verification in Demo Co (2026-07-28, report line 11) re-uploaded a
-- byte-identical CSV and the screen showed "no indication whatsoever that the
-- file had been seen before" — no duplicate warning, no supersede prompt. It
-- simply offered "Import 4 items" again. PO imports have deduped by file
-- SHA-256 since long before the sports program; this screen never has, so a
-- double-click of an accidental second upload silently doubles an org's stock.
--
-- SHAPE: mirrors the po_imports chassis (0286 lineage + 0287 supersede) at the
-- granularity this much simpler screen needs. There is no document to store, no
-- approval state machine and no purchase order — just "which file produced this
-- batch of items, and is it still the live import of that file".
--
--   * (organization_id, sha256) is unique among LIVE rows only.
--   * A re-upload is never permanently blocked: the requirements are explicit
--     that the importer must "distinguish same-request retry from an
--     intentional second shipment — never permanently block a file hash". A
--     human who confirms the warning supersedes the predecessor, which frees
--     the hash for exactly ONE new live batch.
--   * The predecessor is PRESERVED. `superseded_at` (plus `superseded_by_id`
--     for lineage) is purely an "is this the live import for this file" marker;
--     its counts, its timestamp and its author stay intact for audit.
--
-- Purely additive: one new table. Nothing existing is altered or rewritten, and
-- an org that never imports a CSV never gains a row.

create table public.item_import_batches (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  -- Hex SHA-256 of the file's canonical parsed content, computed SERVER-SIDE.
  -- Never trusted from the client: a hash the browser supplies could be
  -- randomised to walk straight past the warning.
  sha256            text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  file_name         text,
  row_count         integer not null default 0 check (row_count >= 0),
  created_count     integer not null default 0 check (created_count >= 0),
  failed_count      integer not null default 0 check (failed_count >= 0),
  -- Set when a LATER batch re-used this file after a human acknowledged the
  -- duplicate warning. Removes the row from the live-uniqueness index below
  -- without destroying anything it recorded.
  superseded_at     timestamptz,
  superseded_by_id  uuid references public.item_import_batches(id) on delete set null,
  imported_by       uuid references public.user_profiles(id) on delete set null,
  created_at        timestamptz not null default now()
);

comment on table public.item_import_batches is
  'One row per committed generic items-CSV import. Fingerprints the file by '
  'SHA-256 per organization so a same-file re-upload warns instead of silently '
  'double-importing. Superseding a row (never deleting it) frees the hash for '
  'exactly one new live batch.';

comment on column public.item_import_batches.superseded_at is
  'Set when a later batch re-used this batch''s file with explicit human '
  'confirmation. Removes the row from item_import_batches_org_sha_live_uniq '
  'without altering its counts or history.';

-- THE dedupe guard. Partial on `superseded_at is null` for the same reason
-- 0287 narrowed po_imports_org_sha_uniq: an unconditional unique index would
-- block a file's second legitimate import FOREVER, which the requirements
-- forbid. Uniqueness among LIVE batches is still enforced by the database, so
-- two concurrent imports of one file still collide and exactly one wins.
create unique index item_import_batches_org_sha_live_uniq
  on public.item_import_batches (organization_id, sha256)
  where superseded_at is null;

-- "Show me this org's recent imports", the only other access path.
create index item_import_batches_org_created_idx
  on public.item_import_batches (organization_id, created_at desc);

-- Lineage lookups ("what superseded this batch") stay free without bloating
-- the index set — same partial-index posture as po_imports_reimported_from_idx.
create index item_import_batches_superseded_by_idx
  on public.item_import_batches (superseded_by_id)
  where superseded_by_id is not null;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Read: any org member (the warning has to be visible to whoever re-uploads).
-- Write: manager and above, matching who can hold `items:import` — a viewer
-- who cannot import must not be able to forge or clear a fingerprint either.
-- No DELETE policy: a batch is superseded, never removed, so the audit trail of
-- what was imported when cannot be erased from the client.
alter table public.item_import_batches enable row level security;

create policy item_import_batches_select on public.item_import_batches
  for select to authenticated
  using ((select public.is_org_member(organization_id)));

create policy item_import_batches_insert on public.item_import_batches
  for insert to authenticated
  with check ((select public.has_org_role(organization_id, 'manager')));

create policy item_import_batches_update on public.item_import_batches
  for update to authenticated
  using ((select public.has_org_role(organization_id, 'manager')))
  with check ((select public.has_org_role(organization_id, 'manager')));

grant select, insert, update on public.item_import_batches to authenticated;

-- ROLLBACK (documented, reversible — the table is additive and nothing reads
-- it outside the items-CSV import screen):
--   drop table if exists public.item_import_batches;

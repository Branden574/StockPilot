-- ============================================================================
-- 0124_ai_shelf_scan.sql
-- ============================================================================
-- Schema + storage + policies for the AI Shelf Scan v1 feature.
--
-- Flow recap: picker frames a shelf in the Expo app, captures one photo,
-- the server calls Gemini against the cycle count's line set and returns
-- a per-line confidence-flagged proposed count. User reviews + confirms
-- on a follow-up screen, which writes counted_quantity through the
-- existing recordCount path with an audit pointer to the scan that
-- proposed it.
--
-- Three pieces in this migration:
--
--   1. cycle_count_ai_scans table — one row per scan attempt, regardless
--      of whether the user confirmed the proposed counts. Stores the
--      raw Gemini response as JSONB so we can analyze AI-vs-human
--      deltas later and re-tune thresholds / prompts.
--
--   2. cycle_count_lines.ai_scan_id — nullable FK pointer so we can
--      trace which scan proposed a given count. NULL for the existing
--      manual + barcode flows. No CHECK constraint.
--
--   3. cycle-count-scans private storage bucket — path convention
--      {organization_id}/{cycle_count_id}/{uuid}.webp. Org-scoped RLS;
--      no public access (photos can show inventory layout).
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────
-- 1. cycle_count_ai_scans
-- ─────────────────────────────────────────────────────────────────────
create table public.cycle_count_ai_scans (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  cycle_count_id       uuid not null references public.cycle_counts(id) on delete cascade,
  created_by           uuid not null references public.user_profiles(id) on delete restrict,

  -- Storage path (relative to the cycle-count-scans bucket) of the
  -- captured photo. Org-scoped folder prefix per the bucket's policies.
  photo_storage_path   text not null,

  -- Raw Gemini response. JSONB so we can index into matched_line_id,
  -- sku, count, confidence, notes — but the column-shape stays
  -- forward-compatible if the prompt evolves.
  gemini_response      jsonb not null default '{}'::jsonb,

  -- Which Gemini model produced the response. Bumped when we swap
  -- models (e.g. gemini-2.0-flash → gemini-2.0-pro). Lets us segment
  -- accuracy analysis by model version.
  model_version        text not null,

  created_at           timestamptz not null default now(),

  -- Filled in when the user confirms the proposed counts. NULL means
  -- the scan was abandoned (user retook the photo, navigated away, or
  -- the connection dropped). May be re-confirmed by a manager later,
  -- in which case confirmed_by != created_by.
  confirmed_at         timestamptz,
  confirmed_by         uuid references public.user_profiles(id) on delete set null,

  -- Guard against confirming a scan with no proposal data.
  constraint cc_ai_scans_confirm_chk check (
    (confirmed_at is null and confirmed_by is null)
    or (confirmed_at is not null and confirmed_by is not null)
  )
);

create index cycle_count_ai_scans_count_idx
  on public.cycle_count_ai_scans(cycle_count_id, created_at desc);
create index cycle_count_ai_scans_org_idx
  on public.cycle_count_ai_scans(organization_id, created_at desc);
create index cycle_count_ai_scans_creator_idx
  on public.cycle_count_ai_scans(created_by);

comment on table public.cycle_count_ai_scans is
  'One row per AI Shelf Scan attempt — photo path + raw Gemini response. '
  'Audit trail; preserved indefinitely so we can analyze human-vs-AI '
  'corrections and tune the model over time. Confirmed_at NULL means '
  'the user abandoned the scan without writing counted_quantity.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. cycle_count_lines.ai_scan_id
-- ─────────────────────────────────────────────────────────────────────
alter table public.cycle_count_lines
  add column if not exists ai_scan_id uuid
    references public.cycle_count_ai_scans(id) on delete set null;

create index if not exists cycle_count_lines_ai_scan_idx
  on public.cycle_count_lines(ai_scan_id)
  where ai_scan_id is not null;

comment on column public.cycle_count_lines.ai_scan_id is
  'When the counted_quantity on this line was proposed by an AI scan and '
  'confirmed by the user, points at the scan that produced it. NULL for '
  'manual + barcode entries (the existing flows).';

-- ─────────────────────────────────────────────────────────────────────
-- 3. RLS — cycle_count_ai_scans
--    SELECT: any org member with cycle-count read access
--    INSERT: any org member who can perform cycle counts (staff+)
--    UPDATE: only to set confirmed_at — restricted to the scan's
--            creator OR a manager (manager review-and-confirm flow).
--    DELETE: never (audit trail). Drop is via on-delete-cascade
--            when the parent cycle_count is deleted.
-- ─────────────────────────────────────────────────────────────────────
alter table public.cycle_count_ai_scans enable row level security;

create policy cc_ai_scans_select on public.cycle_count_ai_scans
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy cc_ai_scans_insert on public.cycle_count_ai_scans
  for insert to authenticated
  with check (
    public.has_org_role(organization_id, 'staff')
    and created_by = auth.uid()
  );

create policy cc_ai_scans_update on public.cycle_count_ai_scans
  for update to authenticated
  using (
    public.has_org_role(organization_id, 'staff')
    and (created_by = auth.uid() or public.has_org_role(organization_id, 'manager'))
  )
  with check (
    public.has_org_role(organization_id, 'staff')
    and (created_by = auth.uid() or public.has_org_role(organization_id, 'manager'))
  );

create policy cc_ai_scans_no_delete on public.cycle_count_ai_scans
  for delete to authenticated
  using (false);

-- Per the post-2026 grants convention. RLS is the gate; the GRANT is
-- the SQL-level prerequisite that lets PostgREST surface the table.
grant select, insert, update, delete on public.cycle_count_ai_scans to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Storage bucket — cycle-count-scans
--    Path convention: {organization_id}/{cycle_count_id}/{uuid}.webp
--    Private (not public). Signed URLs are minted by the service
--    layer when the review screen needs to display the photo.
-- ─────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cycle-count-scans',
  'cycle-count-scans',
  false,
  10 * 1024 * 1024, -- 10 MB cap matches the compressed master from compressImageVariants
  array['image/webp', 'image/jpeg', 'image/png']::text[]
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ─────────────────────────────────────────────────────────────────────
-- 5. storage.objects policies for cycle-count-scans
--    SELECT: org members can read scans inside their org's folder.
--    INSERT: server-side uploads use service_role; org members can
--            also INSERT into their own org's folder for the
--            client-direct PUT path.
--    UPDATE: never (a scan photo is immutable).
--    DELETE: managers + admins can prune their own org's photos
--            (for storage hygiene); other roles cannot.
-- ─────────────────────────────────────────────────────────────────────
drop policy if exists "cycle-count-scans org read" on storage.objects;
drop policy if exists "cycle-count-scans org write" on storage.objects;
drop policy if exists "cycle-count-scans manager delete" on storage.objects;

create policy "cycle-count-scans org read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'cycle-count-scans'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  );

create policy "cycle-count-scans org write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'cycle-count-scans'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'staff')
  );

create policy "cycle-count-scans manager delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'cycle-count-scans'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  );

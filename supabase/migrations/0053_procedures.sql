-- ============================================================================
-- 0053_procedures.sql — Standard Operating Procedures (SOPs) knowledge base
-- ============================================================================
-- Cross-warehouse knowledge base for ops procedures. A field manager records
-- "how we replace a ceiling tile" at one warehouse; every other warehouse can
-- find and watch it.
--
-- Four tables:
--   procedure_categories — picklist (Plumbing / Lighting / HVAC / …) per org
--   procedures           — the SOP itself: title + markdown body + metadata
--   procedure_videos     — N videos per procedure, served from Supabase Storage
--   procedure_comments   — single-level threaded discussion under each SOP
--
-- Plus a Supabase Storage bucket `procedure-videos` for the video files.
--
-- RLS: org members can read everything; managers+ author procedures + videos;
-- comments are open to all org members; only the author or admin+ can edit /
-- delete their own comment.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- procedure_categories — picklist seeded with sensible defaults per org
-- ----------------------------------------------------------------------------
create table public.procedure_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null check (length(name) between 1 and 80),
  color           text,
  sort_order      int not null default 0,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, name)
);

create trigger procedure_categories_set_updated_at
  before update on public.procedure_categories
  for each row execute function public.tg_set_updated_at();

create index procedure_categories_org_idx
  on public.procedure_categories(organization_id, sort_order);

-- Seed a default category set for every existing org. New orgs will need their
-- categories created via the UI (or we add a trigger later).
insert into public.procedure_categories (organization_id, name, color, sort_order)
select o.id, c.name, c.color, c.sort_order
from public.organizations o
cross join (values
  ('Plumbing',   '#3b82f6', 10),
  ('Lighting',   '#f59e0b', 20),
  ('HVAC',       '#10b981', 30),
  ('Doors',      '#8b5cf6', 40),
  ('Electrical', '#ef4444', 50),
  ('Safety',     '#dc2626', 60),
  ('General',    '#6b7280', 99)
) as c(name, color, sort_order)
on conflict (organization_id, name) do nothing;

-- ----------------------------------------------------------------------------
-- procedures — the SOP record itself
-- ----------------------------------------------------------------------------
create table public.procedures (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,

  title                   text not null check (length(title) between 1 and 200),
  description             text,
  body                    text, -- markdown

  category_id             uuid references public.procedure_categories(id) on delete set null,
  -- Optional "authored at" warehouse for credit + filtering. Visibility is
  -- always org-wide regardless of this value.
  authoring_warehouse_id  uuid references public.warehouses(id) on delete set null,

  -- Generated full-text search vector. Weighted: title=A, description=B,
  -- body=C, so a title match outranks a body match. GIN index below.
  search_tsv              tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) stored,

  created_by              uuid references public.user_profiles(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_by              uuid references public.user_profiles(id) on delete set null,
  updated_at              timestamptz not null default now(),
  archived_at             timestamptz
);

create trigger procedures_set_updated_at
  before update on public.procedures
  for each row execute function public.tg_set_updated_at();

create index procedures_org_created_idx
  on public.procedures(organization_id, created_at desc)
  where archived_at is null;
create index procedures_org_category_idx
  on public.procedures(organization_id, category_id)
  where archived_at is null;
create index procedures_authoring_warehouse_idx
  on public.procedures(authoring_warehouse_id)
  where authoring_warehouse_id is not null;
create index procedures_search_idx
  on public.procedures using gin(search_tsv);

-- ----------------------------------------------------------------------------
-- procedure_videos — N per procedure, served from Supabase Storage
-- ----------------------------------------------------------------------------
create table public.procedure_videos (
  id                uuid primary key default gen_random_uuid(),
  procedure_id      uuid not null references public.procedures(id) on delete cascade,
  organization_id   uuid not null references public.organizations(id) on delete cascade,

  title             text,
  -- Path WITHIN the procedure-videos bucket, e.g.
  -- "{org_id}/{procedure_id}/{uuid}.mp4". Service-layer signs URLs on read.
  storage_path      text not null,
  thumbnail_path    text,   -- optional storage path to a still frame

  duration_seconds  int,
  size_bytes        bigint,
  mime_type         text,
  order_idx         int not null default 0,

  uploaded_by       uuid references public.user_profiles(id) on delete set null,
  uploaded_at       timestamptz not null default now()
);

create index procedure_videos_procedure_idx
  on public.procedure_videos(procedure_id, order_idx);

-- ----------------------------------------------------------------------------
-- procedure_comments — single-level threading (a comment has 0 or 1 parent)
-- ----------------------------------------------------------------------------
create table public.procedure_comments (
  id              uuid primary key default gen_random_uuid(),
  procedure_id    uuid not null references public.procedures(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- NULL = top-level; non-null = a reply. Enforced single-level by the
  -- service layer (no replies-to-replies).
  parent_id       uuid references public.procedure_comments(id) on delete cascade,

  author_id       uuid references public.user_profiles(id) on delete set null,
  body            text not null check (length(body) between 1 and 5000),

  edited_at       timestamptz,
  created_at      timestamptz not null default now(),
  -- Soft delete so threads don't collapse when a parent is removed; UI shows
  -- "(deleted)" for the body.
  deleted_at      timestamptz
);

create index procedure_comments_procedure_idx
  on public.procedure_comments(procedure_id, created_at);
create index procedure_comments_parent_idx
  on public.procedure_comments(parent_id)
  where parent_id is not null;

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.procedure_categories enable row level security;
alter table public.procedures           enable row level security;
alter table public.procedure_videos     enable row level security;
alter table public.procedure_comments   enable row level security;

-- Categories: org members read; admins write.
create policy procedure_categories_select on public.procedure_categories
  for select to authenticated
  using (public.is_org_member(organization_id));
create policy procedure_categories_write on public.procedure_categories
  for all to authenticated
  using (public.has_org_role(organization_id, 'admin'))
  with check (public.has_org_role(organization_id, 'admin'));

-- Procedures: org members read; managers+ write.
create policy procedures_select on public.procedures
  for select to authenticated
  using (public.is_org_member(organization_id));
create policy procedures_write on public.procedures
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

-- Videos: same shape as procedures.
create policy procedure_videos_select on public.procedure_videos
  for select to authenticated
  using (public.is_org_member(organization_id));
create policy procedure_videos_write on public.procedure_videos
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

-- Comments: any org member can read + insert. Update/delete: own row or admin+.
create policy procedure_comments_select on public.procedure_comments
  for select to authenticated
  using (public.is_org_member(organization_id));
create policy procedure_comments_insert on public.procedure_comments
  for insert to authenticated
  with check (
    public.is_org_member(organization_id)
    and author_id = auth.uid()
  );
create policy procedure_comments_update_own on public.procedure_comments
  for update to authenticated
  using (
    public.is_org_member(organization_id)
    and (author_id = auth.uid() or public.has_org_role(organization_id, 'admin'))
  )
  with check (
    public.is_org_member(organization_id)
    and (author_id = auth.uid() or public.has_org_role(organization_id, 'admin'))
  );
create policy procedure_comments_delete_own on public.procedure_comments
  for delete to authenticated
  using (
    public.is_org_member(organization_id)
    and (author_id = auth.uid() or public.has_org_role(organization_id, 'admin'))
  );

-- ============================================================================
-- Storage bucket — `procedure-videos`
-- ============================================================================
-- Private bucket. Videos served via signed URLs (7-day TTL) generated server-
-- side by ProcedureVideosService. Path convention: {org_id}/{procedure_id}/
-- {uuid}.{ext}.
--
-- 500 MB per-file cap covers ~10 minutes of decent-quality phone video; bigger
-- files probably need transcoding which is out of v1 scope.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'procedure-videos',
  'procedure-videos',
  false,
  524288000,  -- 500 MB
  array['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Storage RLS on storage.objects for this bucket. Path's first segment must
-- equal the user's org_id so a malicious upload can't target another org's
-- folder.
create policy procedure_videos_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'procedure-videos'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  );

create policy procedure_videos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'procedure-videos'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  );

create policy procedure_videos_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'procedure-videos'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  )
  with check (
    bucket_id = 'procedure-videos'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  );

create policy procedure_videos_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'procedure-videos'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  );

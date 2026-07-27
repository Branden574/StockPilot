-- 0294_category_tracking_profiles.sql
--
-- Phase 2 of the Sports program: per-category tracking policy + structured
-- size scales.
--
-- WHY HERE: today `categories` carries zero tracking configuration, so the
-- sports-only serial exemption has nowhere to live, and the apparel size
-- vocabulary is duplicated across five places that already disagree (web form
-- offers 9 sizes, the server action zod caps at 7, plus the size-run regex,
-- the 0284 CHECK and mobile's own copy).
--
-- SUBCATEGORIES NEED NO SCHEMA. `categories.parent_id` has existed since 0002
-- (with index `categories_parent_idx`) and is written by the service layer but
-- never set by any UI. Sports subcategories reuse it; this migration only adds
-- the INHERITANCE resolver.
--
-- BACKWARD COMPATIBILITY: every new column is NULLABLE with no backfill.
-- `tracking_mode is null` reads as QUANTITY, which is exactly today's behaviour
-- for every existing category in every existing org. There is deliberately no
-- `update public.categories set ...` statement anywhere in this file.

-- ── 1) Size scales ──────────────────────────────────────────────────────────
-- organization_id NULL = a built-in system scale, readable by every org and
-- editable by nobody. A non-null org owns a private scale.
create table public.size_scales (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid references public.organizations(id) on delete cascade,
  key              text not null,
  name             text not null,
  kind             text not null
                     check (kind in ('apparel_alpha','shoe_numeric','youth_numeric','custom')),
  /* US Men / US Women / US Youth / UK / EU / CM / custom. NULL for apparel. */
  size_system      text,
  description      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

-- A key is unique per owner. NULLS NOT DISTINCT so two system scales cannot
-- share a key either.
create unique index size_scales_owner_key_uniq
  on public.size_scales (organization_id, key)
  nulls not distinct
  where deleted_at is null;

create index size_scales_org_idx
  on public.size_scales (organization_id) where deleted_at is null;

create trigger size_scales_set_updated_at
  before update on public.size_scales
  for each row execute function public.tg_set_updated_at();

comment on table public.size_scales is
  'Ordered size vocabularies (apparel letters, numeric shoe sizes with halves '
  'and widths, youth). organization_id NULL = a built-in system scale visible '
  'to every org. Retires the five hardcoded apparel size lists.';

-- ── 2) Size scale values ────────────────────────────────────────────────────
create table public.size_scale_values (
  id             uuid primary key default gen_random_uuid(),
  size_scale_id  uuid not null references public.size_scales(id) on delete cascade,
  /* As printed on the sticker: 'XL', '10.5', '7Y'. Preserved verbatim. */
  value          text not null,
  /* Case/space-normalized form used for matching. Never shown to a user. */
  normalized     text not null,
  /* Display order within the scale. Sizes are ORDERED, not alphabetical. */
  sort_order     integer not null,
  is_half        boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (size_scale_id, normalized)
);

create index size_scale_values_scale_idx
  on public.size_scale_values (size_scale_id, sort_order);

comment on column public.size_scale_values.value is
  'The size AS PRINTED. Never auto-converted between systems (requirements: '
  '"never auto-convert between systems without an approved mapping").';

-- ── 3) Category tracking profile columns ────────────────────────────────────
alter table public.categories
  add column if not exists tracking_mode text,
  add column if not exists size_scale_id uuid references public.size_scales(id) on delete set null,
  add column if not exists default_unit_of_measure text,
  /* Sports subcategory key from packages/core/src/sports/tracking-modes.ts.
     NULL for every non-sports category, which is every category today. */
  add column if not exists sports_subcategory_key text,
  /* Full profile for a CUSTOM subcategory (requirements: a custom subcategory
     MUST carry a full tracking profile). Shape = SubcategoryTrackingProfile. */
  add column if not exists tracking_profile jsonb;

-- The CHECK mirrors TRACKING_MODES in packages/core/src/sports/tracking-modes.ts.
-- The TS union and this list must stay in lockstep.
alter table public.categories
  drop constraint if exists categories_tracking_mode_check;
alter table public.categories
  add constraint categories_tracking_mode_check
  check (tracking_mode is null or tracking_mode in (
    'QUANTITY','QUANTITY_BY_VARIANT','NUMBERED_VARIANT',
    'SERIALIZED','OPTIONAL_SERIALIZED','INDIVIDUALLY_TAGGED','LOT_TRACKED'
  ));

-- Mirrors COUNTING_UNITS in the same module.
alter table public.categories
  drop constraint if exists categories_default_uom_check;
alter table public.categories
  add constraint categories_default_uom_check
  check (default_unit_of_measure is null or default_unit_of_measure in (
    'unit','each','pair','set','case'
  ));

comment on column public.categories.tracking_mode is
  'Category tracking policy. NULL reads as QUANTITY — the behaviour every '
  'existing category already has. A child category inherits its parent''s mode '
  'when its own is NULL (see public.category_tracking_mode).';

comment on column public.categories.default_unit_of_measure is
  'Default counting unit stamped onto items created in this category. PAIR is '
  'a DISPLAY convention only — there is no conversion anywhere (owner decision '
  '2026-07-27).';

-- ── 4) Inheritance resolver ─────────────────────────────────────────────────
-- Walks at most ONE level up (categories are a parent/child pair, not a deep
-- tree) and falls back to 'QUANTITY'. STABLE + security definer so RLS on
-- categories cannot make a child silently resolve differently per caller
-- (a viewer with restricted category access might not see the PARENT row, and
-- a per-caller tracking policy would be a correctness hole, not a feature).
create or replace function public.category_tracking_mode(p_category_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    c.tracking_mode,
    p.tracking_mode,
    'QUANTITY'
  )
  from public.categories c
  left join public.categories p on p.id = c.parent_id and p.deleted_at is null
  where c.id = p_category_id and c.deleted_at is null;
$$;

grant execute on function public.category_tracking_mode(uuid) to authenticated;

-- Same shape for the counting unit.
create or replace function public.category_default_uom(p_category_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    c.default_unit_of_measure,
    p.default_unit_of_measure,
    'unit'
  )
  from public.categories c
  left join public.categories p on p.id = c.parent_id and p.deleted_at is null
  where c.id = p_category_id and c.deleted_at is null;
$$;

grant execute on function public.category_default_uom(uuid) to authenticated;

-- ── 5) RLS ──────────────────────────────────────────────────────────────────
alter table public.size_scales       enable row level security;
alter table public.size_scale_values enable row level security;

-- System scales (organization_id IS NULL) are readable by every member.
create policy size_scales_select on public.size_scales
  for select to authenticated
  using (
    organization_id is null
    or (select public.is_org_member(organization_id))
  );

create policy size_scales_insert on public.size_scales
  for insert to authenticated
  with check (
    organization_id is not null
    and (
      (select public.has_org_role(organization_id, 'manager'))
      or (select public.has_permission(organization_id, 'sports:manage'))
    )
  );

create policy size_scales_update on public.size_scales
  for update to authenticated
  using (
    organization_id is not null
    and (
      (select public.has_org_role(organization_id, 'manager'))
      or (select public.has_permission(organization_id, 'sports:manage'))
    )
  )
  with check (
    organization_id is not null
    and (
      (select public.has_org_role(organization_id, 'manager'))
      or (select public.has_permission(organization_id, 'sports:manage'))
    )
  );

create policy size_scales_delete on public.size_scales
  for delete to authenticated
  using (
    organization_id is not null
    and (select public.has_org_role(organization_id, 'manager'))
  );

-- Values inherit their scale's visibility exactly.
create policy size_scale_values_select on public.size_scale_values
  for select to authenticated
  using (
    exists (
      select 1 from public.size_scales s
      where s.id = size_scale_values.size_scale_id
        and (s.organization_id is null
             or (select public.is_org_member(s.organization_id)))
    )
  );

create policy size_scale_values_write on public.size_scale_values
  for all to authenticated
  using (
    exists (
      select 1 from public.size_scales s
      where s.id = size_scale_values.size_scale_id
        and s.organization_id is not null
        and (select public.has_org_role(s.organization_id, 'manager'))
    )
  )
  with check (
    exists (
      select 1 from public.size_scales s
      where s.id = size_scale_values.size_scale_id
        and s.organization_id is not null
        and (select public.has_org_role(s.organization_id, 'manager'))
    )
  );

-- EXPLICIT GRANTS. Migration 0283 omitted these and it is a documented defect
-- (0067: "on hardened Supabase projects, missing grants cause real-feature
-- 403s even when RLS would otherwise allow the row"). Do not repeat it.
grant select, insert, update, delete on public.size_scales to authenticated;
grant select, insert, update, delete on public.size_scale_values to authenticated;

-- ── 6) Seed the built-in system scales ──────────────────────────────────────
-- Owner-facing decision (see "Open policy questions"): these four are the
-- opening set. organization_id NULL so every org gets them without a per-org
-- backfill, and no org can mutate them.
insert into public.size_scales (id, organization_id, key, name, kind, size_system, description)
values
  ('5ca1e000-0000-0000-0000-000000000001', null, 'apparel_alpha', 'Apparel (XS-5XL)',
   'apparel_alpha', null, 'Letter sizing for jerseys, uniforms and apparel.'),
  ('5ca1e000-0000-0000-0000-000000000002', null, 'us_mens_shoe', 'US Men''s shoe',
   'shoe_numeric', 'US_MENS', 'US Men''s numeric shoe sizes, half sizes included.'),
  ('5ca1e000-0000-0000-0000-000000000003', null, 'us_womens_shoe', 'US Women''s shoe',
   'shoe_numeric', 'US_WOMENS', 'US Women''s numeric shoe sizes, half sizes included.'),
  ('5ca1e000-0000-0000-0000-000000000004', null, 'us_youth_shoe', 'US Youth shoe',
   'youth_numeric', 'US_YOUTH', 'US Youth numeric shoe sizes, half sizes included.')
on conflict do nothing;

-- Apparel letters, in wearing order. Deliberately the UNION of every list that
-- exists today: the 9 the writers emit plus the 2XL-6XL forms size-run.ts
-- already parses, so nothing that renders today stops rendering.
insert into public.size_scale_values (size_scale_id, value, normalized, sort_order, is_half)
select '5ca1e000-0000-0000-0000-000000000001', v.value, upper(v.value), v.ord, false
from (values
  ('XS', 10), ('S', 20), ('M', 30), ('L', 40), ('XL', 50),
  ('XXL', 60), ('2XL', 61), ('XXXL', 70), ('3XL', 71),
  ('XXXXL', 80), ('4XL', 81), ('XXXXXL', 90), ('5XL', 91), ('6XL', 100)
) as v(value, ord)
on conflict (size_scale_id, normalized) do nothing;

-- Numeric shoe sizes in HALF steps. The series is generated over half-steps
-- (g.h = size * 2) and the label is built by integer division, so the printed
-- value is exact: '9' and '9.5'. Deriving it with to_char(size,'FM990.9')
-- instead renders every whole size as '9.' — measured on PG 17, not assumed.
-- sort_order stays size * 10 so the ordering is stable and gap-free.
--
-- US Men's / US Women's: 4.0 through 18.0 (g.h 8..36).
insert into public.size_scale_values (size_scale_id, value, normalized, sort_order, is_half)
select s.id,
       case when g.h % 2 = 1 then (g.h / 2)::text || '.5' else (g.h / 2)::text end,
       case when g.h % 2 = 1 then (g.h / 2)::text || '.5' else (g.h / 2)::text end,
       g.h * 5,
       g.h % 2 = 1
from public.size_scales s
cross join generate_series(8, 36) as g(h)
where s.organization_id is null
  and s.key in ('us_mens_shoe', 'us_womens_shoe')
on conflict (size_scale_id, normalized) do nothing;

-- US Youth: 1.0 through 7.0 (g.h 2..14).
insert into public.size_scale_values (size_scale_id, value, normalized, sort_order, is_half)
select s.id,
       case when g.h % 2 = 1 then (g.h / 2)::text || '.5' else (g.h / 2)::text end,
       case when g.h % 2 = 1 then (g.h / 2)::text || '.5' else (g.h / 2)::text end,
       g.h * 5,
       g.h % 2 = 1
from public.size_scales s
cross join generate_series(2, 14) as g(h)
where s.organization_id is null
  and s.key = 'us_youth_shoe'
on conflict (size_scale_id, normalized) do nothing;

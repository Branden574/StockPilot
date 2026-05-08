-- 0037_saved_views_sharing.sql
-- Adds optional org-wide sharing to saved_views (migration 0035). When
-- is_shared = true, every member of the same organization can SELECT
-- the view; only the owner can still UPDATE / DELETE / INSERT.
--
-- Defaults to false so all existing rows stay private — shared views
-- are an explicit opt-in per view.
--
-- Spec: docs/superpowers/specs/2026-05-08-saved-views-design.md (extended)

alter table public.saved_views
  add column if not exists is_shared boolean not null default false;

comment on column public.saved_views.is_shared is
  'When true, all org members can read this view. The owner is still the only one who can edit, share-toggle, or delete it.';

-- Replace the SELECT policy so it covers shared rows too. Other policies
-- (insert/update/delete) stay owner-only.
drop policy if exists "saved_views_owner_select" on public.saved_views;

create policy "saved_views_visible_to_org_or_owner" on public.saved_views
  for select using (
    user_id = auth.uid()
    or (
      is_shared = true
      and organization_id in (
        select organization_id
        from public.organization_members
        where user_id = auth.uid()
          and accepted_at is not null
      )
    )
  );

-- Helpful index for the org-shared SELECT path.
create index if not exists saved_views_org_shared_idx
  on public.saved_views(organization_id, scope, sort_order, created_at)
  where is_shared = true;

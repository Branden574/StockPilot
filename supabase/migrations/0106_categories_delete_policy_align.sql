-- 0106_categories_delete_policy_align.sql
-- Align the categories DELETE RLS policy with the rest of the table
-- (INSERT / UPDATE require manager+). The previous policy required
-- admin for DELETE, but the application service only ever soft-deletes
-- via UPDATE deleted_at = now(), so the DELETE policy is unreachable
-- in normal flows and a manual hard-delete via the SQL editor would
-- surprisingly fail for a manager who otherwise owns the row's
-- lifecycle. Standardize on manager+ for the whole CRUD surface.
--
-- The service layer continues to gate everything behind
-- `categories:manage` (manager + admin + owner), so this only matters
-- for direct SQL access and defense-in-depth consistency.

drop policy if exists categories_delete on public.categories;

create policy categories_delete on public.categories
  for delete to authenticated
  using (public.has_org_role(organization_id, 'manager'));

comment on policy categories_delete on public.categories is
  'Manager+ may hard-delete category rows. Service layer prefers soft-delete (deleted_at); '
  'this policy exists as a defense-in-depth alignment with INSERT/UPDATE.';

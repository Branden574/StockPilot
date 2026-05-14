-- 0088_procedure_comments_insert_manager.sql
-- ============================================================================
-- Tighten procedure_comments INSERT RLS to manager+
-- ----------------------------------------------------------------------------
-- Original 0053 policy allowed any org member (incl. viewers/staff) to
-- insert a comment as themselves. Procedures are an editorial knowledge
-- base — letting viewers post in the discussion thread invited drive-by
-- chatter and clutter from accounts that can't otherwise mutate any
-- product data.
--
-- The service layer adds an `items:update` assert in
-- ProcedureCommentsService.create() (staff+); the database RLS goes a
-- step further and requires manager+. The stricter RLS is intentional:
-- staff can still see and edit their own old comments (update/delete
-- policy untouched), but new authoring is reserved for managers and
-- admins. This matches how procedures themselves work — viewers/staff
-- read, managers+ write.
--
-- update/delete policies on procedure_comments are unchanged: own-row
-- OR admin+ may still edit/soft-delete pre-existing comments.
-- ============================================================================

drop policy if exists procedure_comments_insert on public.procedure_comments;

create policy procedure_comments_insert on public.procedure_comments
  for insert to authenticated
  with check (
    public.is_org_member(organization_id)
    and author_id = auth.uid()
    and public.has_org_role(organization_id, 'manager')
  );

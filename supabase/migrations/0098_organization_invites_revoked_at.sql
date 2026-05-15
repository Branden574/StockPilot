-- 0098_organization_invites_revoked_at.sql
--
-- Soft-revoke for `organization_invites`. Previously, `revokeInvite`
-- deleted the row outright, which:
--   * lost the audit trail (you could no longer tell why an invite went
--     missing — was it accepted? expired? revoked by an admin?)
--   * left audit_logs rows pointing at deleted org_invite entity ids
--
-- Adds a nullable `revoked_at` column. The application layer
-- (TeamService.revokeInvite) sets it instead of deleting, and
-- `acceptInviteWithToken` refuses to consume rows where
-- `revoked_at is not null`.
--
-- Backfill is a no-op: existing rows have revoked_at = NULL which
-- preserves the prior "still active" semantics.

alter table public.organization_invites
  add column if not exists revoked_at timestamptz;

comment on column public.organization_invites.revoked_at is
  'Set when an admin revokes a pending invite. The row is retained '
  'for audit; acceptInviteWithToken refuses to consume rows where '
  'revoked_at is not null. Resend rotates the token but does not '
  'clear revoked_at — revoked invites are terminal.';

-- Partial index for the "list pending invites" path. The page-level
-- query filters on (organization_id, accepted_at is null, revoked_at
-- is null, expires_at > now()); a partial index covering the first
-- three predicates keeps the scan small as the audit-retention
-- backlog grows.
create index if not exists organization_invites_org_pending_idx
  on public.organization_invites (organization_id)
  where accepted_at is null and revoked_at is null;

-- Multi-charter invites: an invite can name several charters a user oversees.
-- Back-compat: keep charter_id (single); charter_ids takes precedence when set.
alter table public.organization_invites
  add column if not exists charter_ids uuid[];

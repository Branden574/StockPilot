-- 0116_orders_on_behalf_of.sql
--
-- Bug fix surfaced by the first live test: an internal manager who
-- toggles "Create on behalf of someone else" on /dashboard/orders/new
-- can't actually submit. The Phase-2 service layer correctly sets
-- requester_user_id = NULL + requester_name/email to the external
-- contact (so status emails go to that person, not the manager), but
-- migration 0044 had two pre-existing gates that reject that shape:
--
--   1. RLS policy `order_requests_insert` requires
--      `requester_user_id = auth.uid()`.
--   2. CHECK constraint `order_requests_identity_chk` requires
--      `source = 'internal' AND requester_user_id IS NOT NULL`.
--
-- Both predate the orders refactor and were never exercised against
-- the on-behalf-of flow. Loosening both to permit:
--   * Standard self-submit: requester_user_id matches the caller.
--   * Manager-on-behalf-of: caller is manager+, row has the external
--     contact's email but no requester_user_id.
--
-- Public-link orders are untouched — they continue to require
-- source='public_link' and requester_email set, and they go through
-- the admin client (RLS bypassed) anyway.

begin;

-- 1. Replace the INSERT RLS policy.
drop policy if exists order_requests_insert on public.order_requests;

create policy order_requests_insert on public.order_requests
  for insert to authenticated
  with check (
    public.is_org_member(organization_id)
    and source = 'internal'
    and (
      -- Self-submit: the row tracks the caller as the requester.
      requester_user_id = auth.uid()
      or
      -- On-behalf-of: manager+ creates the row for an external
      -- requester who'll get the status emails. Service-layer
      -- isManagerOrAbove guard already filters the action; this
      -- RLS clause is defense-in-depth.
      (
        requester_user_id is null
        and requester_email is not null
        and public.has_org_role(organization_id, 'manager')
      )
    )
  );

comment on policy order_requests_insert on public.order_requests is
  'Authenticated insert: either self-submit (requester_user_id = '
  'auth.uid()) or manager+ on-behalf-of (requester_user_id IS NULL '
  '+ requester_email populated). Public-link orders are inserted via '
  'the service-role admin client and bypass this policy entirely.';

-- 2. Relax the identity CHECK constraint to match.
alter table public.order_requests
  drop constraint if exists order_requests_identity_chk;

alter table public.order_requests
  add constraint order_requests_identity_chk
  check (
    case source
      when 'internal' then
        -- Either the requester is an internal user OR the row is
        -- a manager-created on-behalf-of with the external contact.
        requester_user_id is not null or requester_email is not null
      when 'public_link' then
        requester_email is not null
      else false
    end
  );

commit;

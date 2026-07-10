-- 0253: delivery-driver designation on org membership.
--
-- The Assign-delivery dialog used to list EVERY accepted member as a
-- candidate driver. Orgs want to mark who actually drives so the picker
-- shows only real drivers. Org-scoped (a person can drive for one org and
-- not another), so it lives on organization_members — NOT user_profiles.
--
-- Writes ride the existing organization_members UPDATE policy (admin/role
-- managers), surfaced through TeamService.setDeliveryDriver which asserts
-- members:update_role. Reads ride the existing member-visibility policy.
alter table public.organization_members
  add column if not exists is_delivery_driver boolean not null default false;

comment on column public.organization_members.is_delivery_driver is
  'Marked delivery driver — only these members appear in the Assign-delivery picker (falls back to all staff when an org has none marked).';

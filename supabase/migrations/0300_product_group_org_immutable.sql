-- 0300_product_group_org_immutable.sql
--
-- Closes the KNOWN GAP that migration 0298 documented and deliberately deferred
-- (it stayed a pure schema migration):
--
--   "product_groups.organization_id is MUTABLE: nothing pins it across an
--    UPDATE. [...] What it does allow is someone holding manager in two orgs
--    moving a group out from under its variants: product_group_in_org is only
--    enforced on inventory_items writes, so the already-attached items would
--    keep pointing at a group that now lives in another org. A guard belongs
--    with the group service as an organization_id-immutability trigger."
--
-- WHY A TRIGGER AND NOT RLS. RLS gates ROWS, never COLUMNS. The existing
-- product_groups_update policy evaluates USING on the OLD row and WITH CHECK on
-- the NEW one, so re-homing already requires manager (or sports:manage) in BOTH
-- orgs — it is not a cross-tenant escalation. The damage is to REFERENTIAL
-- consistency: inventory_items.group_id has a plain FK to product_groups(id)
-- with no org column in it, and product_group_in_org() is only evaluated when
-- an ITEM is written. Move the group and every attached variant silently
-- becomes a cross-org reference that nothing will ever re-check.
--
-- WHY NOT SERVICE-LEVEL ONLY. ProductGroupsService.update() never puts
-- organization_id in its patch (and a test pins that), but `authenticated` holds
-- a table-level UPDATE grant, so a raw PostgREST call bypasses the service
-- entirely. The invariant has to live where the write lands.
--
-- SHAPE: modelled on public._guard_org_billing_columns (0218) — BEFORE UPDATE,
-- raise rather than silently coerce, so a caller is never told a re-home
-- succeeded when it did not.
--
-- Unlike 0218 this guard applies to EVERY role, including service_role. There
-- is no legitimate re-home: a group's identity key is unique per organization,
-- so "the same product in another org" is a different row by construction, and
-- an admin console that needed to move one would have to re-point the variants
-- too. Migrations still bypass it the ordinary way (`alter table ... disable
-- trigger`), which keeps a future, deliberate data-repair possible without
-- leaving an always-open door.
--
-- This file contains ZERO DML: no insert, update or delete on any table.

create or replace function public.tg_pin_product_group_org()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception
      'product_groups.organization_id is immutable (group % owns variants in org %)',
      old.id, old.organization_id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists product_groups_pin_org on public.product_groups;
-- WHEN filters at the executor, so an ordinary group edit (name, brand, key)
-- never enters the function at all.
create trigger product_groups_pin_org
  before update on public.product_groups
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_pin_product_group_org();

revoke all on function public.tg_pin_product_group_org() from public, anon, authenticated;

comment on function public.tg_pin_product_group_org() is
  'Pins product_groups.organization_id across UPDATE. Closes the mutability gap '
  '0298 documented: inventory_items.group_id carries no org column, and '
  'product_group_in_org() is only checked when an ITEM is written, so re-homing '
  'a group would leave every attached variant pointing across a tenant boundary '
  'with nothing left to re-check it.';

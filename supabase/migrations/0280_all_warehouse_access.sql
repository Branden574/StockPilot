-- 0280_all_warehouse_access.sql
-- "All warehouses" access for warehouse-scoped members (staff/viewer).
--
-- Warehouse scoping is enforced by the EXISTENCE of user_warehouse_assignments
-- rows (0229 hashed-set functions for inventory_items SELECT;
-- user_can_access_warehouse for schedule/rentals). "All warehouses" is
-- therefore materialized as one null-charter assignment row per warehouse and
-- kept in sync going forward by an AFTER INSERT trigger on warehouses — no
-- RLS changes in this migration.
--
--   1. organization_members.all_warehouses — the durable intent flag. Set by
--      the invite-accept flow (all-warehouse invites) and by the Team page's
--      "Warehouse access" editor. The app inserts rows for all CURRENT
--      warehouses when the flag turns on; this trigger covers FUTURE ones.
--   2. organization_invites.all_warehouses — carried on the invite row; the
--      accept flow reads it (warehouse_id / charter fields stay null on such
--      invites — charter scoping is warehouse-scoped and does not apply).
--   3. trg_warehouses_all_warehouse_access — on warehouse INSERT, grant a
--      null-charter assignment row to every ACTIVE (accepted) member of the
--      org whose all_warehouses flag is set.
--
-- Conflict target note: 0008 dropped unique(user_id, warehouse_id) in favor
-- of two partial unique indexes (uwa_user_wh_no_charter_uniq WHERE charter_id
-- IS NULL; uwa_user_wh_charter_uniq WHERE charter_id IS NOT NULL). The
-- trigger only ever inserts null-charter rows, so the arbiter below names the
-- null-charter partial index — a bare (user_id, warehouse_id) target would
-- fail to infer any index (42P10).

alter table public.organization_members
  add column if not exists all_warehouses boolean not null default false;

comment on column public.organization_members.all_warehouses is
  'Member may access every warehouse in the org, including future ones (0280 trigger inserts an assignment row on warehouse creation). Set via the invite "All warehouses" option or Team > Warehouse access.';

alter table public.organization_invites
  add column if not exists all_warehouses boolean not null default false;

comment on column public.organization_invites.all_warehouses is
  'Invitee receives all-warehouse access on accept: organization_members.all_warehouses=true plus one assignment row per current warehouse. warehouse_id/charter fields are null on such invites.';

-- AFTER INSERT on warehouses: flagged active members get access to the new
-- warehouse automatically. SECURITY DEFINER because the inserting user
-- (organization:update holder) is not necessarily allowed to write other
-- users' assignment rows under uwa_admin_write; the rows the trigger writes
-- are fully derived from the NEW warehouse row + membership flags, so there
-- is no caller-controlled input beyond what warehouse RLS already vetted.
create or replace function public._grant_all_warehouse_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_warehouse_assignments
    (organization_id, user_id, warehouse_id, charter_id, is_primary, assigned_by)
  select new.organization_id, m.user_id, new.id, null, false, null
    from public.organization_members m
   where m.organization_id = new.organization_id
     and m.all_warehouses = true
     and m.accepted_at is not null
  on conflict (user_id, warehouse_id) where charter_id is null do nothing;
  return null;
end;
$$;

drop trigger if exists trg_warehouses_all_warehouse_access on public.warehouses;
create trigger trg_warehouses_all_warehouse_access
  after insert on public.warehouses
  for each row execute function public._grant_all_warehouse_access();

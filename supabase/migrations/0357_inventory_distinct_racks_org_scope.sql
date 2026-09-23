-- 0357_inventory_distinct_racks_org_scope.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- The rack-filter dropdown's options, for ONE organization.
--
-- THE BUG. public.inventory_distinct_racks(p_scope text) (0066, tightened in
-- 0068, search_path pinned in 0329) reads public.inventory_items with NO
-- organization predicate. It is SECURITY INVOKER, so row level security is the
-- only thing that scopes it, and RLS scopes by MEMBERSHIP, not by the
-- organization the caller is working in. A user who belongs to two
-- organizations therefore gets both organizations' rack labels in the Items
-- and Books rack filters (InventoryService.listDistinctRacks), whichever one
-- the page is for. It is not a leak across the RLS boundary (the caller may
-- read every one of those rows), but the dropdown offers racks that match no
-- item in the organization on screen and shows one organization's stockroom
-- layout inside another's.
--
-- THE FIX. A new function, inventory_distinct_racks_for_org(p_org, p_scope):
-- the 0068 body verbatim plus `organization_id = p_org`, and a refusal of a
-- NULL organization. It stays SECURITY INVOKER, so RLS still applies on top of
-- the predicate: an organization the caller cannot read yields an empty list,
-- never another organization's racks. The org predicate also lets the planner
-- start from the organization's rows instead of every row the caller can see.
--
-- WHY A NEW NAME, NOT AN OVERLOAD. Two public functions with one name and
-- different arguments is the PostgREST ambiguity hazard 0068 already met, and
-- 0329's list-integrity pin (supabase/tests/0329_*.test.sql, section 5) counts
-- exactly one pg_proc row named inventory_distinct_racks. A distinct name keeps
-- both true.
--
-- THE OLD FUNCTION IS KEPT, UNCHANGED, for the rollout: the application code
-- that switches to this function deploys AFTER this migration, and until then
-- the running app still calls inventory_distinct_racks(text). Drop it in a
-- later migration once no deployed app calls it (apps/web is its only caller;
-- apps/mobile and packages do not reference it).
--
-- POSTURE (the 0329/0335 house standard): SECURITY INVOKER, STABLE,
-- search_path = public, EXECUTE for authenticated only. Supabase's default
-- privileges would otherwise grant anon and PUBLIC EXECUTE on a new function,
-- so both are revoked explicitly.
--
-- ROLLBACK:
--   drop function if exists public.inventory_distinct_racks_for_org(uuid, text);
-- (only after the application is back on inventory_distinct_racks(text)).

create or replace function public.inventory_distinct_racks_for_org(p_org uuid, p_scope text)
returns text[]
language plpgsql
security invoker
stable
set search_path = public
as $$
declare
  result text[];
begin
  if p_scope is null or p_scope not in ('books', 'items') then
    raise exception 'invalid_scope' using errcode = '22023';
  end if;
  if p_org is null then
    raise exception 'invalid_org' using errcode = '22023';
  end if;

  with src as (
    select
      case when p_scope = 'books'
           then custom_fields->>'book_rack_number'
           else custom_fields->>'rack_number'
      end as num,
      case when p_scope = 'books'
           then custom_fields->>'book_rack_row'
           else custom_fields->>'rack_row'
      end as rrow
    from public.inventory_items
    where organization_id = p_org
      and deleted_at is null
      and (
        (p_scope =  'books' and item_type =  'book') or
        (p_scope <> 'books' and item_type <> 'book')
      )
  ),
  labeled as (
    select distinct
      case
        when nullif(trim(coalesce(rrow, '')), '') is null
          then trim(num)
        else trim(num) || '-' || trim(rrow)
      end as label
    from src
    where nullif(trim(coalesce(num, '')), '') is not null
  )
  select coalesce(array_agg(label order by label), '{}')::text[]
    into result
  from labeled;

  return result;
end;
$$;

comment on function public.inventory_distinct_racks_for_org(uuid, text) is
  'Distinct rack labels (sorted text[]) for one organization''s non-deleted items '
  '(p_scope ''items'') or books (p_scope ''books''). SECURITY INVOKER: RLS applies '
  'on top of the organization predicate. 0357.';

revoke all on function public.inventory_distinct_racks_for_org(uuid, text) from public;
revoke all on function public.inventory_distinct_racks_for_org(uuid, text) from anon;
grant execute on function public.inventory_distinct_racks_for_org(uuid, text) to authenticated;

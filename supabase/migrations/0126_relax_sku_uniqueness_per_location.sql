-- 0126_relax_sku_uniqueness_per_location.sql
--
-- Allow the same SKU to exist at multiple physical locations within
-- one organization. Today the unique constraint `(organization_id,
-- sku)` from 0002 forces the Duplicate-item feature to suffix the
-- SKU (`SP-ABC` → `SP-ABC-2`), which mangles what was supposed to be
-- a product identifier just to satisfy a row constraint.
--
-- New model:
--   • SKU = product code (often shared across rack rows of the same
--     real-world product).
--   • bin_location = physical disambiguator.
--   • Uniqueness is (organization_id, sku, bin_location) so two rows
--     can share a SKU iff they live at different racks.
--
-- `nulls not distinct` keeps bulk-import dedup working: rows
-- imported without a rack (bin_location = NULL) still can't have
-- duplicate SKUs against each other, because Postgres treats NULLs
-- as equal under this clause.
--
-- Requires Postgres ≥ 15 (Supabase Pro is on 15+). The original
-- constraint name is the Postgres-auto-generated one for an inline
-- `unique (organization_id, sku)`; we drop by lookup against
-- pg_constraint so we don't depend on the exact name.

do $$
declare
  v_conname text;
begin
  -- Find any unique constraint on inventory_items whose key columns
  -- are exactly (organization_id, sku). pg_constraint.conkey stores
  -- attnums in definition order; we resolve them back to names and
  -- compare as a sorted set so the lookup is order-independent.
  select conname into v_conname
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'inventory_items'
    and t.relnamespace = 'public'::regnamespace
    and c.contype = 'u'
    and (
      select array_agg(a.attname order by a.attname)
      from unnest(c.conkey) k
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
    ) = array['organization_id', 'sku']
  limit 1;

  if v_conname is not null then
    execute format('alter table public.inventory_items drop constraint %I', v_conname);
  end if;
end$$;

-- New uniqueness: same SKU allowed across different bin_locations.
-- NULL bin_locations are treated as equal so bulk-import dedup still
-- catches "same product, no rack assigned" duplicates.
create unique index if not exists inventory_items_org_sku_bin_unique
  on public.inventory_items (organization_id, sku, bin_location)
  nulls not distinct
  where deleted_at is null;

-- 0063_categories_supports_sizes.sql
-- New column on categories. When true, items whose category has this
-- flag get a Sizes selector in the item form, and saving creates one
-- inventory row per selected size (variant model). Default false so
-- existing categories are unchanged.
--
-- This is a column add, not a new table, so no new GRANT statement is
-- required — categories already has table-level grants from its
-- original migration.

alter table public.categories
  add column if not exists supports_sizes boolean not null default false;

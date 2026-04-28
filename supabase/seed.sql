-- Local development seed.
-- Runs after migrations on `supabase db reset`. Keep idempotent.

insert into public.organizations (id, name, slug, plan, currency)
values ('00000000-0000-0000-0000-000000000001', 'Acme Demo Co', 'acme-demo', 'pro', 'USD')
on conflict (slug) do nothing;

-- Demo categories
insert into public.categories (organization_id, name, color)
values
  ('00000000-0000-0000-0000-000000000001', 'Electronics', '#6366f1'),
  ('00000000-0000-0000-0000-000000000001', 'Apparel',     '#10b981'),
  ('00000000-0000-0000-0000-000000000001', 'Tools',       '#f97316'),
  ('00000000-0000-0000-0000-000000000001', 'Supplies',    '#0ea5e9')
on conflict do nothing;

-- Default warehouse
insert into public.locations (organization_id, name, type)
values ('00000000-0000-0000-0000-000000000001', 'Main Warehouse', 'warehouse')
on conflict do nothing;

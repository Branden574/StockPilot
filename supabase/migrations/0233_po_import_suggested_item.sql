-- supabase/migrations/0233_po_import_suggested_item.sql
-- Advisory match target for PO-import lines. A parse-time / barcode / ISBN
-- match now writes a SUGGESTION here (with match_status='suggested'), never
-- item_id. Only an explicit user 'use_existing' decision sets item_id. This
-- is what stops an import from auto-merging into (and inheriting the charter
-- of) an existing same-SKU item. No accounting change — Phase 2 owns staging.
alter table public.po_import_lines
  add column if not exists suggested_item_id uuid
    references public.inventory_items(id) on delete set null;

comment on column public.po_import_lines.suggested_item_id is
  'Advisory "possible existing match" for this line (barcode/ISBN/vendor '
  'mapping). Informational only — the user must accept it (decision '
  'use_existing) to set item_id. Never linked automatically.';

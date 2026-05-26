-- Add missing FK indexes flagged by the 2026-05-26 DB audit.
--
-- Each column is a foreign key that's already used in joins from the
-- application layer, but had no covering index. Sequential scans on
-- these tables become a bottleneck as row counts grow.
--
-- Using IF NOT EXISTS so re-runs against a partially-applied schema
-- are safe. CONCURRENTLY is intentionally omitted: these tables are
-- still small in the internal-pilot org, the locks are tiny, and
-- CONCURRENTLY can't run inside a transaction (which Supabase's
-- migration runner wraps every file in).

create index if not exists purchase_order_items_item_idx
  on public.purchase_order_items (item_id);

create index if not exists push_tokens_user_idx
  on public.push_tokens (user_id);

-- Partial index: most reference_id values are populated (every receipt,
-- transfer, adjustment row sets one), but we exclude NULLs so the
-- index doesn't carry rows where the column is meaningless.
create index if not exists stock_movements_reference_idx
  on public.stock_movements (reference_id)
  where reference_id is not null;

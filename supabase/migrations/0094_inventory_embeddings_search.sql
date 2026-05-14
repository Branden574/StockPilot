-- 0094_inventory_embeddings_search.sql
-- Wires up semantic search on `inventory_items.embedding` (vector(1536)).
-- The column was scaffolded in 0002 for Phase 9 but never indexed or
-- queried. This migration adds the HNSW index and the match function
-- the AI assistant calls from searchInventorySemantic.
--
-- The embedding model is Gemini's gemini-embedding-001 at
-- outputDimensionality=1536. App-side generation lives in
-- apps/web/src/lib/ai/embeddings.ts. Existing rows have NULL embeddings
-- until a backfill (or per-item lazy embed on first AI mention) runs.

-- HNSW with cosine distance. Partial WHERE so we don't index the
-- mostly-null column. m=16 / ef_construction=64 are pgvector defaults
-- and work well up to ~100k vectors per org.
create index if not exists inventory_items_embedding_hnsw_idx
  on public.inventory_items
  using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;

-- Match function. Returns items ranked by cosine similarity (1.0 = best).
-- SECURITY INVOKER so the caller's RLS on inventory_items decides which
-- rows are visible — same org-scoping the rest of the app uses.
create or replace function public.match_inventory_items_by_embedding(
  p_query     extensions.vector(1536),
  p_limit     int default 10,
  p_min_score float default 0.0
) returns table (
  id          uuid,
  name        text,
  sku         text,
  warehouse_id uuid,
  quantity_on_hand numeric,
  similarity  float
)
language plpgsql
security invoker
stable
as $$
begin
  return query
  select
    i.id,
    i.name,
    i.sku,
    i.warehouse_id,
    i.quantity_on_hand,
    (1 - (i.embedding <=> p_query))::float as similarity
  from public.inventory_items i
  where i.embedding is not null
    and i.deleted_at is null
    and i.status = 'active'
    and (1 - (i.embedding <=> p_query)) >= p_min_score
  order by i.embedding <=> p_query
  limit greatest(1, least(p_limit, 50));
end;
$$;

revoke all on function public.match_inventory_items_by_embedding(
  extensions.vector(1536), int, float
) from public;
revoke all on function public.match_inventory_items_by_embedding(
  extensions.vector(1536), int, float
) from anon;
grant execute on function public.match_inventory_items_by_embedding(
  extensions.vector(1536), int, float
) to authenticated;

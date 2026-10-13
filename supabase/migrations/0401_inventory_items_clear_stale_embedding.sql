-- 0401_inventory_items_clear_stale_embedding.sql
--
-- An item's search embedding (inventory_items.embedding, the vector the AI
-- assistant's semantic search ranks items by) is built from its name, SKU,
-- barcode, description and custom_fields.author (itemEmbeddingSource in
-- apps/web/src/lib/ai/embeddings.ts). When one of them changes, the stored
-- vector describes text the item no longer has.
--
-- THE GAP (review of the embeddings fix, 2026-10-13). An edited item kept its
-- old vector until the app re-embedded it, and a re-embed can fail (a Gemini
-- 429 or 5xx, the 10 s timeout, an instance cut off) or never start: Ungroup's
-- split_item_sku (0399) gives up to 100 records a new SKU, and splitSku
-- re-embedded none of them then, and the SKU fan-out in
-- InventoryService.update() rewrites the other records of a SKU but re-embeds
-- them only when the edited record's own value changed, although another
-- record's value can differ. The hourly sweep (cron/embeddings-sweep) embeds
-- only items with no embedding, so a stale vector stayed stale for good.
--
-- THE FIX. A BEFORE UPDATE trigger clears the embedding in the same statement
-- that changes the text, judged row by row on each row's own old and new
-- values. The request re-embeds what it saved within a second (update() and
-- its fan-out, and since this branch Ungroup's splitSku for the records it
-- gave a new SKU), and an item left without one is embedded by the next
-- sweep run that reaches it, in an organization that switched the AI module
-- on (at most 100 items per organization per run, so a larger backlog clears
-- over several runs). One rule covers every path that changes a searched
-- column today (InventoryService.update, its fan-out, split_item_sku) and any
-- path added later.
--
-- WHEN IT FIRES. BEFORE UPDATE OF name, sku, barcode, description,
-- custom_fields, so a statement that sets none of them (a stock movement, a
-- price, a status, an embedding-only write) never runs it. Its WHEN clause
-- then compares the row's old and new values, custom_fields only by its
-- author key (the rack and crate kept there are not searched text: 0064,
-- 0334, 0336), and skips a row that has no embedding. The function only sets
-- NEW.embedding.
--
-- ONE RULE FOR WRITERS. An UPDATE that changes a searched column and also
-- writes an embedding has that embedding cleared. Write the embedding in its
-- own statement, as embedInventoryItem and embedItemsBatch do.
--
-- updated_at is unchanged: a searched change is a real change, so
-- tg_inventory_items_set_updated_at (0242, restated in 0303) moves it as
-- before, and it ignores the embedding column either way.
--
-- WHO CHANGES AT PUSH: no row. The trigger acts only on later updates, and
-- what it clears is derived data the app rebuilds. Ship it with the code
-- that adds the sweep (cron/embeddings-sweep): without the sweep, an
-- embedding cleared by an edit whose re-embed failed waits for the
-- Settings > AI backfill.
--
-- LOCKS. The function, its grants and its comment take no table lock. CREATE
-- TRIGGER takes SHARE ROW EXCLUSIVE on inventory_items, held to commit, so
-- stock writes queue behind it for the few milliseconds the file holds it. As
-- in 0395, a prelude takes it first, NOWAIT, inside a subtransaction that
-- retries up to 40 times with a 50-150 ms pause holding nothing; after it no
-- statement takes a new table lock, so the file never waits while holding
-- one and is never part of a deadlock. lock_timeout 900ms bounds anything
-- unforeseen.
--
-- DATA SAFETY: no row changes. The file adds one function and one trigger.
--
-- ERRORS: the trigger raises nothing. The push raises only 55P03 (busy,
-- nothing applied). Never 40001 or 40P01 (PostgREST retries those forever).

set lock_timeout = '900ms';

create or replace function public.tg_inventory_items_clear_stale_embedding()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- The trigger's WHEN clause runs this only for a row that has an embedding
  -- and whose searched text this statement changed.
  new.embedding := null;
  return new;
end;
$$;

revoke all on function public.tg_inventory_items_clear_stale_embedding() from public, anon, authenticated, service_role;

comment on function public.tg_inventory_items_clear_stale_embedding() is
  'BEFORE UPDATE OF name, sku, barcode, description, custom_fields trigger (0401): clears the search embedding of a row whose searched text (name, sku, barcode, description, custom_fields author) this statement changed, so the hourly embeddings sweep embeds it again from its new text. Sets only NEW.embedding.';

-- ═══ The lock prelude (see LOCKS above) ═══
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, as 0373 found); the lock lasts until the batch
-- commits.
do $lock$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.inventory_items in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock$;

create or replace trigger inventory_items_clear_stale_embedding
  before update of name, sku, barcode, description, custom_fields on public.inventory_items
  for each row
  when (
    old.embedding is not null
    and (
      new.name is distinct from old.name
      or new.sku is distinct from old.sku
      or new.barcode is distinct from old.barcode
      or new.description is distinct from old.description
      or (new.custom_fields -> 'author') is distinct from (old.custom_fields -> 'author')
    )
  )
  execute function public.tg_inventory_items_clear_stale_embedding();

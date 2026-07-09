-- Don't let a background embedding/search write masquerade as a user edit.
--
-- inventory_items.embedding (the AI semantic-search vector) is filled in by a
-- fire-and-forget background job — embedInventoryItem() after every create/edit
-- and embedItemsBatch() for the "backfill embeddings" sweep. That write targets
-- ONLY the embedding column, but the shared tg_set_updated_at() trigger bumps
-- updated_at on ANY update, so an item that no human touched shows up as
-- "updated just now". This actually confused the owner into thinking stock had
-- moved: 19 old items showed a fresh updated_at with no audit-log row and no
-- stock movement — because a semantic-search backfill had embedded them.
--
-- Fix: give inventory_items its own updated_at trigger that PRESERVES updated_at
-- when the row differs only in the machine-maintained columns (embedding,
-- search_vector), and bumps it for every real edit. search_vector is only ever
-- rewritten alongside name/sku/barcode/description (see
-- inventory_items_search_trigger), so in practice `embedding` is the only truly
-- silent writer — but we neutralize both derived columns for robustness.
--
-- Mechanism: build a copy of NEW with the derived columns (and updated_at
-- itself) forced back to OLD's values; if that copy is not distinct from OLD,
-- then only derived columns changed and we keep the old timestamp. This is
-- column-list-free, so new business columns automatically count as "real" edits
-- and keep bumping updated_at — no future migration has to remember to add them.
--
-- Side effect (intentional, harmless): a true no-op UPDATE (setting a column to
-- its current value) also no longer bumps updated_at. Read-your-write caching
-- keys off explicit {expire:0} invalidation on write paths, not updated_at, so
-- nothing downstream depends on the every-update bump.

create or replace function public.tg_inventory_items_set_updated_at()
returns trigger
language plpgsql
as $$
declare
  neutralized public.inventory_items;
begin
  neutralized := new;
  neutralized.embedding     := old.embedding;
  neutralized.search_vector := old.search_vector;
  neutralized.updated_at    := old.updated_at;  -- exclude the timestamp itself from the compare

  if neutralized is distinct from old then
    new.updated_at := now();          -- a real column changed → normal bump
  else
    new.updated_at := old.updated_at; -- only embedding/search_vector changed → preserve
  end if;

  return new;
end;
$$;

drop trigger if exists inventory_items_set_updated_at on public.inventory_items;

create trigger inventory_items_set_updated_at
  before update on public.inventory_items
  for each row execute function public.tg_inventory_items_set_updated_at();

-- 0303_variant_size_backfill.sql
--
-- ============================================================================
-- PROD PUSH NOTE — PUSH THIS FILE IN A SCHEDULED LOW-TRAFFIC WINDOW.
--
-- A migration file runs inside ONE transaction, so the ACCESS EXCLUSIVE lock
-- the first `alter table ... add column` takes on inventory_items is held until
-- this file COMMITS. For that whole window the table is completely unavailable
-- — READS INCLUDED. Every dashboard query, every /api/v1 call and every mobile
-- sync that touches inventory_items queues behind it. Do not read the
-- statement-level notes below as a promise of concurrency: individually the
-- ADD COLUMN is rewrite-free, the VALIDATE takes only SHARE UPDATE EXCLUSIVE
-- and the UPDATEs take only ROW EXCLUSIVE, but every one of them runs while
-- that first lock is still held.
--
-- COST: ~4s warm on 1.2 M rows for the scans, plus index maintenance on the
-- rows the backfill actually updates. Budget tens of seconds of full table
-- unavailability, not milliseconds.
--
-- `set lock_timeout = '5s'` below bounds the blast radius. Without it the ADD
-- COLUMN's lock REQUEST queues ahead of every new reader, so one slow
-- analytics query holding a read lock would take the whole table offline for
-- as long as it ran, and the migration would wait behind it indefinitely.
--
-- ON lock_timeout FAILURE ("canceling statement due to lock timeout", SQLSTATE
-- 55P03): nothing was applied — the transaction rolled back whole — so RETRY.
-- Ideally a few minutes later, or once whatever holds inventory_items has
-- finished (`select pid, state, xact_start, query from pg_stat_activity where
-- state <> 'idle' order by xact_start`). Every statement in this file is
-- idempotent (`if not exists`, `create or replace`, and backfill WHERE clauses
-- that re-match zero rows), so a retry after ANY failure is safe and cannot
-- double-write. The pgTAP file asserts the idempotence directly.
--
-- THIS FILE IS NOT THE ONLY ONE IN THE WINDOW. 0295 and 0298 take the same
-- ACCESS EXCLUSIVE lock on inventory_items for the same reason (0295 swaps the
-- tracking_type CHECK; 0298 adds ten columns, two CHECKs and two NON-CONCURRENT
-- index builds), and both now carry the same `set lock_timeout = '5s'` +
-- trailing `reset lock_timeout` and their own copy of this note. Schedule
-- 0294-0303 as ONE low-traffic window, not three: the push applies them in file
-- order in a single run, and 0298's index builds are the most expensive
-- statements in it. A 55P03 on any one of them rolls back only that file, so
-- retry from the failed migration onward.
--
-- DEPLOY-ORDER COUPLING — MIGRATIONS FIRST, WEB DEPLOY SECOND.
-- Two web paths select columns this run adds UNCONDITIONALLY, with no feature
-- flag and no fallback, so shipping the web deploy first 500s them:
--   * apps/web/src/app/api/v1/items/lookup/route.ts — its select list names
--     group_id, variant_size and jersey_number (route.ts:100), all added by 0298.
--   * apps/web/src/server/services/size-counts.ts (SizeCountsService) — reads
--     and writes size_count_sessions.product_group_id, added by 0302.
-- Neither path reads a column this file adds, so the ordering constraint is
-- satisfied as soon as 0302 has landed — but the whole run is one window
-- anyway, so treat "all migrations pushed" as the gate for the deploy.
-- ============================================================================
--
-- Copies the STORED size out of custom_fields into the indexed column, and
-- flags what a human must look at.
--
-- WHAT IS BACKFILLED AND WHY IT IS SAFE:
-- custom_fields.size was written by bulkCreateSizedVariants at create time
-- from a size the user explicitly picked. It is recorded data, not inference.
-- Copying it into variant_size loses nothing and gains an index and a CHECK.
--
-- WHAT IS *NOT* BACKFILLED:
-- group_id. Deriving a group from an item NAME is exactly the name-heuristic
-- backfill the owner ruled out on 2026-07-27 ("existing families link via a
-- bulk review tool the owner drives"), because a wrong guess would bake a
-- wrong grouping into persistent identity. Every existing item keeps
-- group_id = NULL and continues to render through the display-only heuristic
-- until a human links it in /dashboard/product-groups/link. Not one statement
-- below writes group_id, in either direction — the pgTAP file asserts it.
--
-- Also not backfilled: jersey_number (no historical source exists — the field
-- has never existed anywhere, and inventing one from a name would be exactly
-- the fabrication the requirements forbid).
--
-- ROLLBACK: `update public.inventory_items set variant_size = null,
-- variant_size_original = null, sports_review_flag = null where ...` —
-- custom_fields is never modified by this migration, so the source of truth
-- for every backfilled value survives intact.
--
-- Proof: supabase/tests/0303_variant_size_backfill.test.sql

-- Bound the lock wait for EVERY statement in this transaction. See the PROD
-- PUSH NOTE above: this is what turns "the whole table is offline until some
-- unrelated long read finishes" into "the push failed, retry it". 5s is long
-- enough to win an uncontended lock on a busy table and short enough that a
-- failed push is an inconvenience rather than an outage. It applies to the
-- backfill UPDATEs too — a row lock held by an app transaction for more than
-- 5s aborts the migration instead of stalling behind it, which is the same
-- trade and the same remedy (retry).
--
-- PLAIN `set`, NOT `set local` — deliberately, and verified against the CLI.
-- The Supabase CLI applies a migration file as one pipelined pgx batch. That
-- IS atomic (a mid-file error rolls the whole file back — probed directly), but
-- the statements never enter a transaction BLOCK in the sense
-- `IsTransactionBlock()` means, so `set local` emits "WARNING (25P01): SET
-- LOCAL can only be used in transaction blocks" and is DISCARDED: the timeout
-- would silently not exist, which is worse than not writing it. A plain `set`
-- takes effect immediately for the rest of the batch. Its one side effect is
-- session scope, so the file `reset`s it at the end — and if any statement
-- fails, the abort unwinds the GUC anyway.
set lock_timeout = '5s';

-- ── 1) Review flag ──────────────────────────────────────────────────────────
-- Column first, CHECK second, as NOT VALID + VALIDATE. Spelling the CHECK
-- inline on the ADD COLUMN would make Postgres verify it against all 1.2 M
-- existing rows before the ALTER could return, so the split still buys
-- something real: added NOT VALID the constraint is catalog-only and instant
-- (it still enforces every subsequent insert/update, which is all the backfill
-- below needs), and VALIDATE's one scan takes only SHARE UPDATE EXCLUSIVE.
-- The ADD COLUMN itself is metadata-only: a nullable column with no default
-- has been rewrite-free since PG 11.
--
-- What the split does NOT buy is concurrency, and it would be wrong to read it
-- that way. The ADD COLUMN takes ACCESS EXCLUSIVE on inventory_items, and a
-- migration file is one transaction, so that lock is held through the VALIDATE,
-- through the backfill, through the index build, until COMMIT. Read the whole
-- file as a single window in which inventory_items answers nobody — reads
-- included. That every individual statement below is cheap or weakly-locking is
-- true and still does not help. Hence the PROD PUSH NOTE at the top.
alter table public.inventory_items
  add column if not exists sports_review_flag text;

alter table public.inventory_items
  drop constraint if exists inventory_items_sports_review_flag_check;
alter table public.inventory_items
  add constraint inventory_items_sports_review_flag_check
  check (sports_review_flag is null or sports_review_flag in (
    'ambiguous_size',        -- custom_fields.size held something unparseable
    'sized_but_ungrouped',   -- has a size, no group: a linking candidate
    'name_size_conflict'     -- the name suffix disagrees with the stored size
  )) not valid;
alter table public.inventory_items
  validate constraint inventory_items_sports_review_flag_check;

comment on column public.inventory_items.sports_review_flag is
  'Set by the 0303 backfill to mark rows a human should look at. Never blocks '
  'anything and never changes behaviour — it only populates the review queue '
  'in /dashboard/product-groups/link.';

-- The index on this column is created in section 4, AFTER the backfill. See the
-- rationale there.

-- ── 2) A backfill must not look like a human edit ───────────────────────────
-- Migration 0242 stopped background embedding writes from bumping updated_at,
-- because 19 items showing a fresh updated_at with no audit row and no stock
-- movement made the owner think stock had moved. It detects a derived write by
-- COLUMN SET: only `embedding` and `search_vector` are neutralized, and every
-- other column — variant_size included, correctly — counts as a real edit.
--
-- This backfill is the other kind of derived write: real business columns,
-- written by a machine, for every sized item in the org at once. Left alone it
-- would bump updated_at on all of them, which spams every "recently changed"
-- surface, re-sorts the default updated_desc item list, and forces a full
-- mobile re-sync for a change no human made.
--
-- So the trigger gains a second, explicit signal alongside 0242's column-set
-- test: a transaction-scoped GUC that the maintenance function below turns on
-- around its own statements and back off before it returns. Nothing in the
-- request path can reach it: PostgREST cannot set an arbitrary GUC and no RPC
-- exposes set_config, so the only way to turn it on is to already hold a SQL
-- connection — and anyone who does can write updated_at directly anyway.
create or replace function public.tg_inventory_items_set_updated_at()
returns trigger
language plpgsql
as $$
declare
  neutralized public.inventory_items;
begin
  -- DERIVED-WRITE ESCAPE HATCH (0303). See the header above.
  if coalesce(current_setting('stockpilot.derived_write', true), '') = 'on' then
    new.updated_at := old.updated_at;
    return new;
  end if;

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

-- ── 3) The backfill itself ──────────────────────────────────────────────────
-- Body lives in a locked-down function so the pgTAP test can re-invoke the REAL
-- statements against its own fixtures rather than a copy of them (same shape as
-- 0293's _backfill_portal_pricing_mode).
--
-- SCALE: four targeted UPDATEs, no batching loop. A migration file runs inside
-- one transaction, so a loop could not COMMIT between batches and would hold
-- exactly the same locks for exactly as long — it would only add code. What
-- actually bounds the cost is the WHERE clauses: every row the app has ever
-- created without a custom_fields.size is filtered out by an index-free but
-- cheap jsonb key test, and only matched rows are locked and re-versioned.
-- No statement here rewrites the table, and an UPDATE on its own would take
-- nothing stronger than ROW EXCLUSIVE — but that is not the lock that decides
-- anything here. Section 1's ADD COLUMN is still holding ACCESS EXCLUSIVE for
-- the rest of this transaction, so the backfill runs with the table already
-- closed to every other session, and its duration is added to that window
-- rather than overlapped with anything. See the PROD PUSH NOTE at the top.
create or replace function public._backfill_variant_size()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- Everything below is a derived write. See section 2. The matching reset at
  -- the end of this body is LOAD-BEARING and must not be dropped: a function's
  -- own SET clause is what would normally unwind this automatically, but a
  -- custom placeholder GUC cannot go in one ("permission denied to set
  -- parameter"), so the reset is manual. Without it the suppression stays on
  -- for the REST of the migration transaction and silently robs every later
  -- statement of its updated_at bump — which is exactly what the pgTAP file's
  -- "a REAL edit still bumps updated_at" assertion caught. The error path
  -- needs no handler: is_local settings are undone when the transaction ends,
  -- and any failure here aborts the whole migration.
  perform set_config('stockpilot.derived_write', 'on', true);

  -- 3a) Copy the STORED size into the indexed column.
  -- Only where custom_fields.size is a non-empty string and variant_size is
  -- still null, so a re-run is a no-op and nothing already set is overwritten.
  -- The length test is applied to the NORMALIZED value, which is the one that
  -- has to satisfy inventory_items_variant_size_check (0298, 1..24) — testing
  -- the raw value could let a case-folding that lengthens the string through
  -- and abort the whole migration on a CHECK violation.
  update public.inventory_items
  set variant_size          = upper(trim(custom_fields->>'size')),
      variant_size_original = custom_fields->>'size'
  where deleted_at is null
    and variant_size is null
    and custom_fields ? 'size'
    and jsonb_typeof(custom_fields->'size') = 'string'
    and length(upper(trim(custom_fields->>'size'))) between 1 and 24;

  -- 3b) A stored size nobody can read as a size.
  -- Covers both shapes: a string too long or empty to be a size, and a
  -- non-string json value (a number, a bool, a json null). Neither is coerced
  -- — "AI may SUGGEST but never invent ... sizes. Missing stays missing" — so
  -- both go to the review queue with variant_size still NULL.
  update public.inventory_items
  set sports_review_flag = 'ambiguous_size'
  where deleted_at is null
    and variant_size is null
    and sports_review_flag is distinct from 'ambiguous_size'
    and custom_fields ? 'size'
    and (
      jsonb_typeof(custom_fields->'size') <> 'string'
      or length(upper(trim(custom_fields->>'size'))) not between 1 and 24
    );

  -- 3c) Sized but ungrouped: the linking review queue.
  update public.inventory_items
  set sports_review_flag = 'sized_but_ungrouped'
  where deleted_at is null
    and variant_size is not null
    and group_id is null
    and sports_review_flag is null;

  -- 3d) The name suffix disagrees with the stored size — evidence the two
  -- sources already diverged, so neither should be trusted silently. This
  -- OVERWRITES 3c deliberately: a conflict is the more urgent thing to show a
  -- human, and the row is still a linking candidate once they resolve it. The
  -- `is distinct from` guard keeps the re-run a true zero-row no-op.
  update public.inventory_items i
  set sports_review_flag = 'name_size_conflict'
  where i.deleted_at is null
    and i.variant_size is not null
    and i.sports_review_flag is distinct from 'name_size_conflict'
    and i.name ~* '(\s-\s|\s)(6XL|5XL|4XL|3XL|2XL|XXXXXL|XXXXL|XXXL|XXL|XL|XS|L|M|S)\s*$'
    -- upper() on BOTH sides. A row this backfill wrote is already uppercase,
    -- but a variant_size written earlier by the app is only as normalized as
    -- normalizeSizeValue left it, and 'xl' vs 'XL' is not a disagreement about
    -- the SIZE — flagging it would put clean rows in front of a human for
    -- nothing. Numeric sizes never reach here: the alternation above is letter
    -- sizes only, so a '10.5' shoe run cannot be flagged as a conflict.
    and upper(regexp_replace(i.name, '^.*[\s-]([A-Za-z0-9]+)\s*$', '\1')) <> upper(i.variant_size);

  -- Hand updated_at back to the humans. See the note at the top of this body.
  perform set_config('stockpilot.derived_write', 'off', true);
end;
$fn$;

-- One-shot maintenance helper — no runtime caller, so no grants.
revoke all on function public._backfill_variant_size() from public, anon, authenticated, service_role;

select public._backfill_variant_size();

-- ── 4) The review-queue index, built AFTER the flags ────────────────────────
-- Order matters, and it is the opposite of what it looks like. With the index
-- already in place the backfill's UPDATEs would each have to maintain it, and
-- because 3b/3c/3d write sports_review_flag itself — an indexed column — not
-- one of those updates could take the HOT path: every touched row would pay a
-- fresh index tuple as well as its heap tuple. Building once over the finished
-- flag set is a single pass instead (106 ms measured), and nothing can read the
-- index in the meantime: its only reader is the review queue behind
-- /dashboard/product-groups/link, and this whole file is one transaction that
-- has not committed yet.
--
-- Partial on both predicates: the review queue always reads one org's flagged,
-- live rows, and an equality test on the flag implies `is not null` for the
-- planner, so the index stays usable from `where organization_id = ? and
-- sports_review_flag = ? and deleted_at is null`. (Contrast
-- inventory_items_group_idx in 0298, which had to be widened to non-partial
-- because the FK referential-integrity probe behind it cannot see a deleted_at
-- predicate at all. There is no FK on this column, so no such probe exists and
-- the partial form is safe here.)
create index if not exists inventory_items_sports_review_idx
  on public.inventory_items (organization_id, sports_review_flag)
  where sports_review_flag is not null and deleted_at is null;

-- ── 5) The ledger is untouched ──────────────────────────────────────────────
-- This migration writes NO quantity column and NO stock_movements row, so
-- SUM(stock_movements.quantity_change) = inventory_items.quantity_on_hand
-- still holds for every touched item. The pgTAP file asserts both halves.

-- Hand the lock timeout back. The `set` at the top of the file is plain, not
-- LOCAL (see the note there), so it would otherwise outlive this migration on
-- the apply connection and quietly impose 5s on every LATER migration in the
-- same push. On a failed push the abort unwinds it instead, so this line only
-- matters on the success path.
reset lock_timeout;

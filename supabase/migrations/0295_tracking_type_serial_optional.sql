-- 0295_tracking_type_serial_optional.sql
--
-- ============================================================================
-- PROD PUSH NOTE — PUSH THIS FILE IN A SCHEDULED LOW-TRAFFIC WINDOW.
-- Same hazard, same window, same remedy as 0298 and 0303 (whose header carries
-- the long-form explanation and the retry procedure). Read all three as one
-- push.
--
-- `alter table ... drop constraint` / `add constraint` both take ACCESS
-- EXCLUSIVE on inventory_items, and a migration file runs inside ONE
-- transaction, so that lock is held until this file COMMITS. For that window
-- inventory_items answers nobody — READS INCLUDED. Every dashboard query, every
-- /api/v1 call and every mobile sync that touches the table queues behind it.
--
-- Without `set lock_timeout` the lock REQUEST queues AHEAD of every new reader,
-- so one slow analytics query holding a read lock takes the whole table offline
-- for as long as it runs and this migration waits behind it. Prod
-- statement_timeout is 120s, which bounds that to roughly a two-minute full
-- inventory_items outage per attempt. 5s converts it into "the push failed,
-- retry it".
--
-- ON lock_timeout FAILURE ("canceling statement due to lock timeout", SQLSTATE
-- 55P03): nothing was applied — the transaction rolled back whole — so RETRY,
-- ideally once whatever holds inventory_items has finished (`select pid, state,
-- xact_start, query from pg_stat_activity where state <> 'idle' order by
-- xact_start`). Every statement in this file is idempotent (`if exists`,
-- explicit constraint name), so a retry is safe.
-- ============================================================================
--
-- Adds a fourth tracking_type: 'serial_optional'.
--
-- WHY: the Sports "OPTIONAL_SERIALIZED" mode (protective equipment, training
-- equipment, balls) means a receipt MAY carry unit-level serials for some of
-- the quantity and none for the rest. Today tracking_type is a three-value
-- CHECK from 0015 and post_receipt_v2 has exactly two branches, so there is no
-- way to express "serials welcome, not required" without either lying
-- ('none', losing the units) or forcing fake placeholder serials — which the
-- requirements explicitly forbid ("NEVER fake placeholders (N/A, 0000,
-- NO SERIAL)").
--
-- The CHECK from 0015 was added via ADD COLUMN ... CHECK and is therefore
-- auto-named `inventory_items_tracking_type_check` (verified against the live
-- catalog: pg_constraint on public.inventory_items carries exactly that one
-- tracking constraint). Drop by that name (IF EXISTS so a re-run is safe) and
-- re-add with an EXPLICIT name so the next migration never has to guess.
--
-- NOTHING IS BACKFILLED. Every existing row keeps its exact tracking_type.
-- 'none'/'lot'/'serial' behaviour is untouched; the new value is only ever
-- written by a category whose mode is OPTIONAL_SERIALIZED.

-- Bound the lock wait for EVERY statement in this transaction. See the PROD
-- PUSH NOTE above.
--
-- PLAIN `set`, NOT `set local` — deliberately, for the reason 0303:72-81
-- documents at length: the Supabase CLI applies a migration file as one
-- pipelined pgx batch that is atomic but is not a transaction BLOCK, so `set
-- local` emits "WARNING (25P01): SET LOCAL can only be used in transaction
-- blocks" and is DISCARDED — the timeout would silently not exist. A plain
-- `set` takes effect for the rest of the batch and is `reset` at the end of
-- this file so it cannot leak into a LATER migration in the same push.
set lock_timeout = '5s';

alter table public.inventory_items
  drop constraint if exists inventory_items_tracking_type_check;

-- NOT VALID + VALIDATE, the split 0303:85-92 establishes. A validated CHECK
-- added inline makes Postgres verify it against all 1.2 M existing rows before
-- the ALTER can return, and that scan runs under the ACCESS EXCLUSIVE lock the
-- DROP above already holds. Added NOT VALID the constraint is catalog-only and
-- instant, and it still enforces every subsequent insert/update; VALIDATE's one
-- scan takes only SHARE UPDATE EXCLUSIVE. Every existing row already satisfies
-- this predicate by construction — the new list is a strict SUPERSET of the
-- 0015 one — so the VALIDATE cannot fail on legacy data.
--
-- The end state is identical to a validated add (convalidated = true), which is
-- why the pgTAP file needs no change: an out-of-list value is still rejected
-- with 23514.
alter table public.inventory_items
  add constraint inventory_items_tracking_type_check
  check (tracking_type in ('none', 'lot', 'serial', 'serial_optional')) not valid;

alter table public.inventory_items
  validate constraint inventory_items_tracking_type_check;

comment on column public.inventory_items.tracking_type is
  'Per-item capture requirement at receive time. none = quantity only; lot = '
  'lot rows required and must sum to qty_accepted; serial = exactly '
  'qty_accepted serials required; serial_optional = 0..qty_accepted serials '
  'accepted, never required (added 0295 for the Sports OPTIONAL_SERIALIZED '
  'mode). Stamped from the category tracking_mode at creation.';

-- The 0015 partial index `where tracking_type <> 'none'` already covers the
-- new value; no index change is needed. Asserted in the pgTAP file.

-- Hand the lock timeout back — the `set` above is plain, not LOCAL (see the note
-- there), so it would otherwise outlive this migration on the apply connection
-- and quietly impose 5s on every LATER migration in the same push. On a failed
-- push the abort unwinds it instead, so this line only matters on success.
reset lock_timeout;

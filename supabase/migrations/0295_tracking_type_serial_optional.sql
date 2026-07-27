-- 0295_tracking_type_serial_optional.sql
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

alter table public.inventory_items
  drop constraint if exists inventory_items_tracking_type_check;

alter table public.inventory_items
  add constraint inventory_items_tracking_type_check
  check (tracking_type in ('none', 'lot', 'serial', 'serial_optional'));

comment on column public.inventory_items.tracking_type is
  'Per-item capture requirement at receive time. none = quantity only; lot = '
  'lot rows required and must sum to qty_accepted; serial = exactly '
  'qty_accepted serials required; serial_optional = 0..qty_accepted serials '
  'accepted, never required (added 0295 for the Sports OPTIONAL_SERIALIZED '
  'mode). Stamped from the category tracking_mode at creation.';

-- The 0015 partial index `where tracking_type <> 'none'` already covers the
-- new value; no index change is needed. Asserted in the pgTAP file.

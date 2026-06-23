-- 0181_reusable_cancelled_po_numbers.sql
--
-- Let a CANCELLED purchase order's number be reused.
--
-- The original constraint `UNIQUE (organization_id, po_number)` reserved a
-- number across ALL statuses, so a meaningful number (e.g. a supplier's
-- "MLA-001071") that was entered on a PO which then had to be cancelled stayed
-- permanently locked — the user could never reissue it. A cancelled PO is void,
-- so its number should be free again.
--
-- Replace the total unique constraint with a PARTIAL unique index that only
-- enforces uniqueness across NON-cancelled POs:
--   * two non-cancelled POs still cannot share a number (no real duplicates),
--   * a cancelled PO + a new active PO MAY share a number (reuse allowed),
--   * multiple cancelled POs may share a number (a fully-released number).
--
-- Safe to create without a violation: the dropped constraint guaranteed global
-- (organization_id, po_number) uniqueness, so the non-cancelled subset is
-- already unique. The separate trigram search index (po_number_trgm_idx) is
-- untouched.

alter table public.purchase_orders
  drop constraint if exists purchase_orders_organization_id_po_number_key;

create unique index if not exists purchase_orders_org_ponumber_active_key
  on public.purchase_orders (organization_id, po_number)
  where status <> 'cancelled';

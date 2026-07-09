-- Non-inventory PO charges (tax, freight, White Glove service, e-waste fee,
-- discounts, etc.) — a purely FINANCIAL child of purchase_orders that appears
-- on the PO PDF and rolls into the PO total, but NEVER touches inventory.
--
-- WHY A SEPARATE TABLE (owner requirement: "those charges should only go on the
-- PO PDF, they never create or touch inventory"):
--   • The stock-receiving path reads ONLY purchase_order_items. A charge row
--     lives in a different table with NO item_id and NO FK to inventory_items,
--     so there is physically no code path from a charge to a stock movement —
--     the "never touch inventory" guarantee is structural, not conventional.
--   • purchase_order_items.item_id is NOT NULL → it cannot hold a charge line
--     anyway; and its line_total is a GENERATED column, so charges have no home
--     there.
--   • purchase_orders already has scalar tax/shipping columns, but they collapse
--     every charge to one number and drop the per-charge LABEL the owner wants
--     to see ("White Glove Service", "CA E-Waste Fee"). A child table preserves
--     each original charge line verbatim (type + label + amount).
--
-- The PO total is authoritative on purchase_orders.total; approve() writes it as
-- subtotal(inventory) + Σ(charge amounts) (discounts carry a negative amount).

create table if not exists public.purchase_order_charges (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  -- Mirrors po_import_lines.line_type's non-inventory classes (classify.ts).
  charge_type       text not null default 'other'
                    check (charge_type in ('tax','freight','service','fee','discount','other')),
  -- The vendor's own label for the line, e.g. 'Sales tax 8.35%', 'White Glove
  -- Service', 'CA E-Waste Fee'. Falls back to a humanized charge_type in the UI
  -- when null/blank.
  label             text,
  -- Optional qty + unit cost so the PO PDF can render a charge as a faithful
  -- line row (e.g. "White Glove Service  100 @ $9.00 = $900.00"), matching the
  -- source vendor PO. Null when the charge is a flat amount (e.g. a tax line).
  quantity          numeric(14,4),
  unit_cost         numeric(14,4),
  -- Signed line total: discounts are stored NEGATIVE so Σ(amount) is a straight
  -- add. This is the figure that rolls into purchase_orders.total.
  amount            numeric(14,4) not null default 0,
  -- Provenance: the po_import_lines.line_number this charge came from (null for
  -- manually-entered charges once that UI exists). Display/order only.
  source_line_number int,
  sort_order        int not null default 0,
  created_at        timestamptz not null default now()
);

create index if not exists purchase_order_charges_po_idx
  on public.purchase_order_charges(purchase_order_id);

alter table public.purchase_order_charges enable row level security;

-- RLS mirrors purchase_order_items (0140 + 0208): any org member reads; managers
-- or holders of purchase_orders:manage write. Charges are financial records of a
-- PO the user already governs — same trust boundary as the PO's line items.
drop policy if exists purchase_order_charges_select on public.purchase_order_charges;
create policy purchase_order_charges_select on public.purchase_order_charges
  for select to authenticated
  using ((select public.is_org_member(organization_id)));

drop policy if exists purchase_order_charges_write on public.purchase_order_charges;
create policy purchase_order_charges_write on public.purchase_order_charges
  for all to authenticated
  using (
    (select public.has_org_role(organization_id, 'manager'))
    or (select public.has_permission(organization_id, 'purchase_orders:manage'))
  )
  with check (
    (select public.has_org_role(organization_id, 'manager'))
    or (select public.has_permission(organization_id, 'purchase_orders:manage'))
  );

# Phase 2 — Hardened Receiving Implementation Plan

> **For agentic workers:** Architecture-level plan. When this phase is next-up, expand each task to full TDD step-by-step detail (see Phase 1 as the format reference). Steps remain checkbox-tracked.

**Goal:** Replace the single-shot `receive_purchase_order` RPC with a proper `receipts` + `receipt_lines` model, idempotency-key-protected receipt posting, separate damaged/rejected qty tracking, and a clean reversal flow that preserves audit history.

**Architecture:**
- New `receipts` (header) + `receipt_lines` (per-line) tables. A PO can have N receipts over time. `purchase_order_items.quantity_received` becomes a derived column (sum of receipt_lines.qty_accepted_base).
- New `idempotency_keys` table, scoped per organization. Same key + same payload hash returns the original receipt; same key + different payload is rejected with `409`.
- New `ReceivingService.postReceipt(input, idempotencyKey)` replaces the inline `inventorySvc.adjustStock()` path. Posts everything inside one Postgres transaction via a new RPC `post_receipt_v2`.
- Reversal: new `ReceivingService.reverseReceipt(receiptId, reason)` creates a sibling receipt with status `reversal` and writes negative `stock_movements`. Original is untouched.
- `receive_purchase_order` RPC stays for one release as a fallback then is dropped at the end of Phase 2.

**Tech Stack:** Same as Phase 1. Adds a Postgres function `post_receipt_v2` (security-invoker, transactional).

---

## File structure

### New files

```
supabase/migrations/
  0012_receipts.sql               # receipts + receipt_lines + new RPC post_receipt_v2
  0013_idempotency.sql            # idempotency_keys table + helper RPCs

apps/web/src/server/services/
  receiving.ts                    # ReceivingService: postReceipt, reverseReceipt, listForPo
  receiving.test.ts               # service tests
  idempotency.ts                  # reserveIdempotencyKey + completeIdempotencyKey

apps/web/src/server/actions/
  receiving.ts                    # postReceiptAction (handles idempotency-key from client), reverseReceiptAction

apps/web/src/components/receiving/
  receipt-form.tsx                # client form (qty received, accepted, rejected, lot/serial placeholders for Phase 3)
  receipt-history.tsx             # table of past receipts on a PO
  receipt-status-badge.tsx
  reversal-dialog.tsx             # confirm + reason

apps/web/src/app/(dashboard)/dashboard/purchase-orders/[id]/
  receive/
    page.tsx                      # full receive screen (replaces the modal)
```

### Modified files

```
supabase/setup/full-schema.sql                                                       # bundle migrations 0012-0013
apps/web/src/server/services/audit.ts                                                # +stock.received.posted, stock.receipt.reversed, idempotency.replay, idempotency.conflict
apps/web/src/server/services/purchase-orders.ts                                      # remove receive(); proxy to ReceivingService
apps/web/src/components/purchase-orders/po-receive-dialog.tsx                        # delete (replaced by receipt-form.tsx)
apps/web/src/app/(dashboard)/dashboard/purchase-orders/[id]/page.tsx                 # add ReceiptHistory + "Receive items" link
packages/core/src/schemas/index.ts                                                   # +receipts.ts re-export
packages/core/src/schemas/receipts.ts                                                # postReceiptSchema, receiptLineSchema
```

---

## Task list

### Task 1: Migration 0012 — receipts tables + post_receipt_v2 RPC

```sql
-- 0012_receipts.sql (excerpt — full file written when expanded to TDD)
create table if not exists public.receipts (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id   uuid not null references public.purchase_orders(id) on delete restrict,
  warehouse_id        uuid not null references public.warehouses(id) on delete restrict,
  receipt_number      text not null,
  status              text not null default 'posted'
                        check (status in ('draft','posted','reversed','reversal','canceled')),
  reversed_receipt_id uuid references public.receipts(id) on delete restrict,
  reversal_reason     text,
  notes               text,
  received_by         uuid not null references public.user_profiles(id) on delete restrict,
  received_at         timestamptz not null default now(),
  idempotency_key_id  uuid,
  immutable_hash      text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, receipt_number)
);

create table if not exists public.receipt_lines (
  id                       uuid primary key default gen_random_uuid(),
  receipt_id               uuid not null references public.receipts(id) on delete cascade,
  purchase_order_line_id   uuid not null references public.purchase_order_items(id) on delete restrict,
  item_id                  uuid not null references public.inventory_items(id) on delete restrict,
  qty_received_base        numeric(18,4) not null check (qty_received_base >= 0),
  qty_accepted_base        numeric(18,4) not null check (qty_accepted_base >= 0),
  qty_rejected_base        numeric(18,4) not null default 0 check (qty_rejected_base >= 0),
  base_uom                 text not null default 'EA',
  unit_cost                numeric(18,4) not null default 0,
  notes                    text,
  created_at               timestamptz not null default now(),
  check (qty_accepted_base + qty_rejected_base <= qty_received_base + 0.0001)
);

create index if not exists receipts_po_idx on public.receipts(purchase_order_id, received_at desc);
create index if not exists receipt_lines_receipt_idx on public.receipt_lines(receipt_id);

-- RPC that does it all transactionally:
create or replace function public.post_receipt_v2(
  p_purchase_order_id uuid,
  p_warehouse_id      uuid,
  p_lines             jsonb,   -- [{po_line_id, qty_received, qty_accepted, qty_rejected, unit_cost, notes}]
  p_idempotency_key   text,
  p_request_hash      text,
  p_notes             text default null
) returns public.receipts
language plpgsql security invoker set search_path = public as $$
declare
  v_receipt   public.receipts%rowtype;
  v_existing  public.idempotency_keys%rowtype;
  v_line      record;
  v_po        public.purchase_orders%rowtype;
  v_org       uuid;
begin
  -- Idempotency check
  select * into v_existing
    from public.idempotency_keys
    where scope = 'receipt' and key = p_idempotency_key
    for update;
  if found and v_existing.request_hash = p_request_hash then
    select * into v_receipt from public.receipts where id = v_existing.resource_id;
    return v_receipt;  -- replay
  end if;
  if found and v_existing.request_hash <> p_request_hash then
    raise exception 'idempotency_conflict' using errcode = '40001';
  end if;

  -- Lock + load PO
  select * into v_po from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0002'; end if;
  v_org := v_po.organization_id;
  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_po.status not in ('draft','expected_inbound','ordered','partially_received') then
    raise exception 'po_already_closed' using errcode = '22023';
  end if;

  -- Insert header
  insert into public.receipts(
    organization_id, purchase_order_id, warehouse_id, receipt_number,
    received_by, idempotency_key_id, immutable_hash, notes
  ) values (
    v_org, v_po.id, p_warehouse_id,
    'R-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6),
    auth.uid(), null, encode(digest(p_request_hash, 'sha256'), 'hex'), p_notes
  ) returning * into v_receipt;

  -- Apply each line: insert receipt_line + stock_movement, update PO line
  for v_line in select * from jsonb_to_recordset(p_lines) as x(
    po_line_id uuid, qty_received numeric, qty_accepted numeric,
    qty_rejected numeric, unit_cost numeric, notes text
  ) loop
    if v_line.qty_accepted > 0 then
      -- bump inventory
      perform public.adjust_stock(
        (select item_id from public.purchase_order_items where id = v_line.po_line_id),
        v_line.qty_accepted, 'receive_po', null,
        'receipt_line', v_receipt.id::text
      );
    end if;

    insert into public.receipt_lines(
      receipt_id, purchase_order_line_id, item_id,
      qty_received_base, qty_accepted_base, qty_rejected_base,
      unit_cost, notes
    ) values (
      v_receipt.id, v_line.po_line_id,
      (select item_id from public.purchase_order_items where id = v_line.po_line_id),
      v_line.qty_received, v_line.qty_accepted, coalesce(v_line.qty_rejected, 0),
      coalesce(v_line.unit_cost, 0), v_line.notes
    );

    update public.purchase_order_items
      set quantity_received = quantity_received + v_line.qty_accepted
      where id = v_line.po_line_id;
  end loop;

  -- Update PO status (partially vs fully received)
  perform public.recompute_po_status(v_po.id);

  -- Idempotency record
  insert into public.idempotency_keys(scope, key, request_hash, status, resource_type, resource_id)
    values ('receipt', p_idempotency_key, p_request_hash, 'completed', 'receipt', v_receipt.id);

  return v_receipt;
end$$;
```

Plus a `recompute_po_status(p_po_id)` helper function that sets `partially_received` when any line is short and `received` when all lines are full.

Steps when expanded:
1. Write migration with `if not exists` guards
2. Append to bundle
3. Apply locally + verify via `psql` test
4. Commit

### Task 2: Migration 0013 — idempotency_keys

```sql
create table if not exists public.idempotency_keys (
  id              uuid primary key default gen_random_uuid(),
  scope           text not null,                 -- e.g. 'receipt'
  key             text not null,
  request_hash    text not null,
  response_hash   text,
  status          text not null default 'in_progress'
                    check (status in ('in_progress','completed','failed')),
  resource_type   text,
  resource_id     uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (scope, key)
);
```

Plus RLS: only the org's manager+ can read/write their own org's keys. Add `created_by uuid` FK and a per-org constraint via the resource it references — for now, RLS scopes by joining to the resource (e.g., `receipts.organization_id`).

### Task 3: Audit events

Add to `audit.ts` AuditEvent union:
- `stock.receipt.posted`
- `stock.receipt.reversed`
- `idempotency.replay`
- `idempotency.conflict`

### Task 4: Core schemas (`packages/core/src/schemas/receipts.ts`)

```typescript
export const postReceiptLineSchema = z.object({
  poLineId: z.string().uuid(),
  qtyReceived: z.number().nonnegative(),
  qtyAccepted: z.number().nonnegative(),
  qtyRejected: z.number().nonnegative().default(0),
  unitCost: z.number().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
}).refine(
  (v) => v.qtyAccepted + v.qtyRejected <= v.qtyReceived + 0.0001,
  { message: 'accepted + rejected cannot exceed received' },
);

export const postReceiptSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  lines: z.array(postReceiptLineSchema).min(1),
  notes: z.string().max(2000).optional(),
  /** Required from the client. UUID v4 generated once per receive form session. */
  idempotencyKey: z.string().uuid(),
});
```

### Task 5: `idempotency.ts` helper service

Wraps the `idempotency_keys` table with two methods:

```typescript
async function reserveOrReplay(scope, key, requestHash):
  → { mode: 'replay'; resourceId } | { mode: 'reserved' } | throw 'conflict'
async function complete(scope, key, resourceType, resourceId, responseHash): void
```

### Task 6: `ReceivingService` — `postReceipt(input, idempotencyKey)`

Calls `post_receipt_v2` RPC. Handles error codes:
- `idempotency_conflict` → throw `ServiceError('conflict', ...)` + audit `idempotency.conflict`
- `po_already_closed` → throw `ServiceError('conflict', ...)`
- `forbidden` → throw `ServiceError('forbidden', ...)`
- success → audit `stock.receipt.posted` with receiptId

### Task 7: `ReceivingService.reverseReceipt(receiptId, reason)`

- Loads receipt + lines
- Validates not already reversed
- Inserts a sibling receipt with `status='reversal'` + `reversed_receipt_id=receiptId`
- For each receipt_line, calls `adjust_stock(item_id, -qty_accepted_base, 'correction', ...)`
- Decrements `purchase_order_items.quantity_received`
- Recomputes PO status
- Updates original receipt to `status='reversed'`
- Audit `stock.receipt.reversed` with reason

### Task 8: Server actions — `postReceiptAction`, `reverseReceiptAction`

Standard ActionResult wrappers. `postReceiptAction` accepts an idempotency key generated client-side (`crypto.randomUUID()` once per form load).

### Task 9: UI — receive screen at `/dashboard/purchase-orders/[id]/receive`

Replaces the existing modal with a full page. Form shows:
- Each PO line with qty_open, qty_received_to_date
- Inputs: qty_received, qty_accepted, qty_rejected
- Per-line notes
- Top-of-form notes
- Hidden idempotency key (generated on mount)
- Submit calls `postReceiptAction`

On success: redirect to PO detail page with success toast.

### Task 10: UI — receipt history component on PO detail page

Lists all receipts for the PO with date, receiver, qty totals, and a "Reverse" button (admin/manager only). Reverse opens a confirmation dialog asking for a reason.

### Task 11: Cleanup — drop `receive_purchase_order` RPC

After verifying nothing in the codebase still calls the old RPC, append a `drop function if exists public.receive_purchase_order(uuid, jsonb, text);` to the **end of migration `0012_receipts.sql`**. Do **not** create a new migration file for the drop — it belongs in the same migration that introduces the replacement, so a fresh database setup never has the orphan RPC. Phase 3's migrations (0014, 0015) keep their slots.

### Task 12: Tests

Required tests (TDD-expanded when phase begins):
1. Posting a receipt for the first time creates a receipt and bumps stock by `qty_accepted`
2. Posting again with same idempotency key + same payload returns the original receipt; stock unchanged
3. Posting with same idempotency key + different payload returns conflict (409)
4. `qty_accepted + qty_rejected > qty_received` is rejected with validation error
5. `qty_rejected > 0` does NOT bump stock (only accepted does)
6. Reversing a receipt creates a `reversal` row, decrements stock, marks original `reversed`
7. Reversing an already-reversed receipt is rejected
8. Warehouse user with no access to the PO's warehouse gets 403
9. Posting a partial receipt sets PO status to `partially_received`
10. Posting the final accepted qty sets PO status to `received`

### Task 13: Done criteria

- [ ] Migrations 0012 + 0013 applied (local + prod)
- [ ] Old `receive_purchase_order` RPC removed
- [ ] Existing PO detail page shows a ReceiptHistory section
- [ ] Cannot post the same receipt twice
- [ ] Reversal works end-to-end (post → reverse → stock returns to pre-receipt)
- [ ] All audit events visible at `/dashboard/admin/audit`

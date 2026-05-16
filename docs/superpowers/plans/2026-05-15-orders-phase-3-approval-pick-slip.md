# Orders Workflow Refactor — Phase 3: Approval + Pick Slip

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the new picking workflow. Approval auto-assigns the approver as picker. Pick slips become a first-class artifact (printable PDF + mobile-friendly digital pick page). Completing picking decrements stock atomically via a new RPC that ports the proven `post_shipment_shipped` pattern.

**Architecture:** One DB migration (`0111`) introduces three things: (a) an extension to the existing `approve_order_request` RPC so it also writes `assigned_picker_id`, (b) two new SECURITY DEFINER functions — `partial_pick_line` for per-line saves and `complete_picking` for the atomic finish, and (c) the `order_email_log` dedup table from the spec's email pipeline. TS layer adds `generatePickSlipAction`, `recordPickedLineAction`, `completePickingAction`, a new PDF route, and a new digital pick page.

**Tech Stack:** Postgres SECURITY DEFINER · `@react-pdf/renderer` (already in repo) · Next.js 16 server actions · React 19 + `useState`.

---

## Reference

- Spec: `docs/superpowers/specs/2026-05-15-orders-workflow-refactor-design.md` §1.5, §2.3, §4 phase 3
- Phase 1 plan + state machine: `packages/core/src/order-state-machine.ts` (already exports `availableOrderActions` covering `pick_slip_generated` / `picking_in_progress` / `picking_complete`)
- Reference RPC for atomic stock work: `supabase/migrations/0054_post_shipment_shipped.sql` — copy its locking + audit pattern.

---

### Task 1: Migration 0111 — pick slip RPCs + order_email_log

**File:** `supabase/migrations/0111_orders_pick_slip_rpcs.sql`

This migration ports the proven `post_shipment_shipped` pattern into a new `complete_picking` function tailored to the order workflow. It also adds `partial_pick_line` for the digital-pick "save as I go" UX, extends `approve_order_request` to auto-assign the approver as picker, and creates the `order_email_log` dedup table referenced by the spec's email pipeline.

- [ ] **Step 1.1: Write the migration file**

```sql
-- 0111_orders_pick_slip_rpcs.sql
--
-- Phase 3 of the orders workflow refactor: introduces atomic picking.
--   * approve_order_request now also writes assigned_picker_id
--   * partial_pick_line — per-line save-as-you-go for the digital pick UI
--   * complete_picking — atomic stock decrement + reservation release +
--     status flip from pick_slip_generated/picking_in_progress to
--     picking_complete. Ports the post_shipment_shipped (0054) pattern.
--   * order_email_log — dedup table behind sendOrderEmail() so a retry
--     can't double-send the same status email.
--
-- All functions are SECURITY DEFINER + search_path locked; the
-- transition guard from 0109 mirrors the legal source statuses.

begin;

-- ────────────────────────────────────────────────────────────────────
-- 1. Auto-assign picker on approve
--
-- The approver becomes the default picker (manager+ can reassign via
-- a separate UI action). Drop in to the existing approve_order_request
-- body and add the assignment to the final UPDATE.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.approve_order_request(p_id uuid)
returns public.order_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.order_requests%rowtype;
  v_line record;
  v_active_reserved numeric(14,4);
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_req.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status <> 'pending_approval' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  for v_line in
    select l.id as line_id, l.item_id, l.quantity_requested,
           ii.quantity_on_hand, ii.warehouse_id as item_warehouse
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_id
    order by l.item_id
    for update of ii
  loop
    if v_line.item_warehouse is distinct from v_req.warehouse_id then
      raise exception 'item_warehouse_mismatch'
        using errcode = 'P0001', detail = v_line.item_id::text;
    end if;
    select coalesce(sum(quantity), 0) into v_active_reserved
    from public.stock_reservations
    where item_id = v_line.item_id and released_at is null;
    if v_line.quantity_requested >
       greatest(0, v_line.quantity_on_hand - v_active_reserved) then
      raise exception 'insufficient_stock'
        using errcode = 'P0001', detail = v_line.item_id::text;
    end if;
  end loop;

  insert into public.stock_reservations (
    organization_id, item_id, warehouse_id, order_request_id, quantity
  )
  select v_req.organization_id, l.item_id, v_req.warehouse_id, p_id, l.quantity_requested
  from public.order_request_lines l
  where l.order_request_id = p_id;

  update public.order_requests
    set status              = 'approved',
        approved_by         = v_user,
        approved_at         = now(),
        assigned_picker_id  = v_user
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 2. partial_pick_line — record progress as the picker walks the shelves.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.partial_pick_line(
  p_line_id uuid,
  p_qty     numeric
)
returns public.order_request_lines
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line public.order_request_lines%rowtype;
  v_req  public.order_requests%rowtype;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_qty is null or p_qty < 0 then
    raise exception 'invalid_quantity' using errcode = 'P0001';
  end if;

  -- Lock the line + the parent order to serialize concurrent saves.
  select * into v_line from public.order_request_lines where id = p_line_id for update;
  if not found then
    raise exception 'order_request_line_not_found' using errcode = 'P0002';
  end if;
  select * into v_req from public.order_requests where id = v_line.order_request_id for update;

  if not public.has_org_role(v_req.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;
  if p_qty > v_line.quantity_requested then
    raise exception 'over_pick' using errcode = 'P0001',
      detail = format('Picked %s exceeds requested %s', p_qty, v_line.quantity_requested);
  end if;

  update public.order_request_lines
    set quantity_picked = p_qty,
        picked_at       = now(),
        picked_by       = v_user
    where id = p_line_id;

  -- First non-zero pick flips the order to picking_in_progress.
  if v_req.status = 'pick_slip_generated' and p_qty > 0 then
    update public.order_requests
      set status = 'picking_in_progress'
      where id = v_req.id;
  end if;

  select * into v_line from public.order_request_lines where id = p_line_id;
  return v_line;
end;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 3. complete_picking — atomic stock decrement + reservation release
--                       + flip to picking_complete.
--
-- Ports the locking + per-line adjust_stock pattern from
-- post_shipment_shipped (0054). The whole sequence runs in one
-- transaction; any insufficient_stock failure rolls back every
-- prior deduction.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.complete_picking(p_order_id uuid)
returns public.order_requests
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_req  public.order_requests%rowtype;
  v_line record;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_req from public.order_requests where id = p_order_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_req.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- For each line, decrement quantity_picked from on-hand. Lines with
  -- quantity_picked IS NULL or 0 are treated as "not picked at all" —
  -- the row stays at 0 fulfilled and stock is untouched for that item.
  for v_line in
    select l.id as line_id, l.item_id, coalesce(l.quantity_picked, 0) as qty
    from public.order_request_lines l
    where l.order_request_id = p_order_id
    order by l.item_id
  loop
    if v_line.qty > 0 then
      perform public.adjust_stock(
        v_line.item_id,
        -v_line.qty,
        'transfer',
        null,
        'Order pick (order_request ' || p_order_id::text || ')',
        null
      );
      -- Mirror picked qty into quantity_fulfilled so existing
      -- analytics (which read quantity_fulfilled) reflect picks.
      update public.order_request_lines
        set quantity_fulfilled = v_line.qty
        where id = v_line.line_id;
    end if;
  end loop;

  -- Release all open reservations for this order.
  update public.stock_reservations
    set released_at = now()
    where order_request_id = p_order_id
      and released_at is null;

  update public.order_requests
    set status               = 'picking_complete',
        picking_completed_at = now(),
        picking_completed_by = v_user
    where id = p_order_id;

  select * into v_req from public.order_requests where id = p_order_id;
  return v_req;
end;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 4. order_email_log — dedup keyed by (order, kind, recipient).
--
-- Phase 3+ status emails INSERT into this table with ON CONFLICT DO
-- NOTHING; a 0-rowcount means "already sent, skip the Resend call."
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.order_email_log (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.order_requests(id) on delete cascade,
  email_type      text not null,
  recipient_email citext not null,
  sent_at         timestamptz not null default now(),
  message_id      text,
  unique (order_id, email_type, recipient_email)
);

create index if not exists order_email_log_order_idx
  on public.order_email_log(order_id, sent_at desc);

alter table public.order_email_log enable row level security;

-- Service role only — application reads via the admin client for the
-- dedup INSERT, and we don't expose this to direct authenticated
-- queries (the inbox UI joins via the order_requests row instead).
revoke all on table public.order_email_log from public, anon, authenticated;
grant select, insert on table public.order_email_log to service_role;

-- ────────────────────────────────────────────────────────────────────
-- 5. Grants for the new functions
-- ────────────────────────────────────────────────────────────────────
grant execute on function public.partial_pick_line(uuid, numeric) to authenticated;
grant execute on function public.complete_picking(uuid) to authenticated;
-- approve_order_request grant already exists (0044/0055); no change needed.

comment on function public.partial_pick_line(uuid, numeric) is
  'Save-as-you-go: writes quantity_picked / picked_at / picked_by for a '
  'single line, and (first non-zero pick only) flips the parent order '
  'from pick_slip_generated to picking_in_progress. Rejects over-picks '
  'and out-of-range statuses; serializes via row lock on the order.';

comment on function public.complete_picking(uuid) is
  'Atomic finish for the picking phase: decrements on-hand stock by '
  'each line''s quantity_picked, releases stock_reservations, and flips '
  'order_requests.status to picking_complete. Whole sequence is one '
  'transaction — any insufficient_stock failure rolls back every prior '
  'deduction. Ports the post_shipment_shipped pattern from migration 0054.';

commit;
```

- [ ] **Step 1.2: Commit + push the migration (DO NOT apply)**

```bash
git add supabase/migrations/0111_orders_pick_slip_rpcs.sql
git commit -m "feat(orders): migration 0111 — pick slip RPCs + order_email_log

Three additions for Phase 3:
  * approve_order_request now also writes assigned_picker_id
    (auto-assigns approver as picker; reassignable via manager+ UI
    action in a later task).
  * partial_pick_line + complete_picking SECURITY DEFINER functions
    port the locking + atomic-deduction pattern from
    post_shipment_shipped (0054). complete_picking is the only place
    in the new workflow that decrements on-hand stock; reservations
    are released in the same transaction.
  * order_email_log table with UNIQUE(order_id, email_type,
    recipient_email) — the dedup guarantee behind sendOrderEmail()."
```

- [ ] **Step 1.3: STOP**

After pushing, wait for the user to apply 0111 in Supabase Studio and confirm "0111 good" before proceeding to Task 2. Per the user's standing migration-pause rule.

---

### Task 2: `generatePickSlipAction` server action + service method

**Files:**
- Modify: `apps/web/src/server/services/order-requests.ts`
- Modify: `apps/web/src/server/actions/order-requests.ts`

- [ ] **Step 2.1: Add a `generatePickSlip` method on `OrderRequestsService`**

After the existing `approve` method, add:

```ts
async generatePickSlip(id: string): Promise<OrderRequestRow> {
  assertPermission(this.ctx, 'orders:approve');
  await this.requireWarehouseAccess(id, 'write');
  // Load + lock by org-scoped query; the centralized state machine
  // catches any illegal transitions.
  const { data: row, error } = await this.ctx.supabase
    .from('order_requests')
    .select('*')
    .eq('organization_id', this.ctx.organizationId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new ServiceError('internal_error', error.message);
  if (!row) throw new ServiceError('not_found', 'Order not found');
  if ((row as OrderRequestRow).status !== 'approved') {
    throw new ServiceError(
      'validation_error',
      'Pick slip can only be generated from an approved order.',
    );
  }
  const { data: updated, error: updErr } = await this.ctx.supabase
    .from('order_requests')
    .update({
      status: 'pick_slip_generated',
      pick_slip_generated_at: new Date().toISOString(),
      pick_slip_generated_by: this.ctx.userId,
    })
    .eq('organization_id', this.ctx.organizationId)
    .eq('id', id)
    .select('*')
    .single();
  if (updErr) throw new ServiceError('internal_error', updErr.message);
  await audit(
    { event: 'order.pick_slip_generated', entityType: 'order_request', entityId: id },
    this.ctx,
  );
  return updated as OrderRequestRow;
}
```

- [ ] **Step 2.2: Add the action**

Append to `apps/web/src/server/actions/order-requests.ts`:

```ts
const generatePickSlipSchema = z.object({ id: z.string().uuid() });

export async function generatePickSlipAction(
  input: z.input<typeof generatePickSlipSchema>,
): Promise<ActionResult<void>> {
  const parsed = generatePickSlipSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.generatePickSlip(parsed.data.id);
    revalidatePath('/dashboard/orders');
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
```

- [ ] **Step 2.3: Verify**

```bash
pnpm typecheck
pnpm test
```

- [ ] **Step 2.4: Commit**

```bash
git add apps/web/src/server/services/order-requests.ts apps/web/src/server/actions/order-requests.ts
git commit -m "feat(orders): generatePickSlip action + service method"
```

---

### Task 3: Pick slip PDF route

**File to create:** `apps/web/src/app/api/orders/[id]/pick-slip.pdf/route.tsx`

Reuse the existing PDF infrastructure (`@react-pdf/renderer` and the helpers under `apps/web/src/lib/pdf/`).

- [ ] **Step 3.1: Read the existing shipment PDF route for pattern**

```bash
cat apps/web/src/app/api/shipments/\[id\]/pdf/route.tsx | head -40
ls apps/web/src/lib/pdf/
```

Use the same Stream-to-Buffer pattern, the same `requireOrgContext()` auth, the same `OrderRequestsService.get` for data + warehouse-access enforcement.

- [ ] **Step 3.2: Write the route**

Create `apps/web/src/app/api/orders/[id]/pick-slip.pdf/route.tsx`:

```tsx
import { NextResponse, type NextRequest } from 'next/server';

import { OrderRequestsService } from '@/server/services/order-requests';
import { renderPickSlipPdf } from '@/lib/pdf/pick-slip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    const detail = await svc.get(id);
    if (
      detail.request.status !== 'pick_slip_generated' &&
      detail.request.status !== 'picking_in_progress' &&
      detail.request.status !== 'picking_complete'
    ) {
      return NextResponse.json(
        { error: 'not_yet_generated', message: 'Generate the pick slip first.' },
        { status: 400 },
      );
    }
    const pdf = await renderPickSlipPdf(detail);
    return new NextResponse(pdf, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="pick-slip-${detail.request.id.slice(0, 8)}.pdf"`,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'internal_error', message: e instanceof Error ? e.message : 'pdf failed' },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 3.3: Create the PDF renderer module**

Create `apps/web/src/lib/pdf/pick-slip.tsx`:

```tsx
import { renderToStream, Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

import type { OrderRequestDetail } from '@/server/services/order-requests';

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 11, fontFamily: 'Helvetica' },
  h1: { fontSize: 18, fontWeight: 700, marginBottom: 4 },
  subtle: { color: '#666', fontSize: 10 },
  section: { marginTop: 14 },
  row: { flexDirection: 'row', borderBottom: '1pt solid #ddd', paddingVertical: 6 },
  th: { fontWeight: 700, backgroundColor: '#f0f0f0' },
  cellQty: { width: 60, textAlign: 'right' },
  cellSku: { width: 100, fontFamily: 'Courier' },
  cellName: { flex: 1 },
  cellBin: { width: 80 },
});

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function renderPickSlipPdf(detail: OrderRequestDetail): Promise<Buffer> {
  const { request, lines, warehouseName } = detail;
  const stream = await renderToStream(
    <Document>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.h1}>Pick slip</Text>
        <Text style={styles.subtle}>
          Order #{request.id.slice(0, 8).toUpperCase()} · {warehouseName ?? '—'}
        </Text>

        <View style={styles.section}>
          <Text>
            Requester:{' '}
            {request.requester_name ?? '—'}
            {request.requester_email ? ` · ${request.requester_email}` : ''}
          </Text>
          <Text style={styles.subtle}>
            Fulfillment: {request.fulfillment_type === 'pickup' ? 'Pickup' : 'Delivery'} ·
            Generated:{' '}
            {request.pick_slip_generated_at
              ? new Date(request.pick_slip_generated_at).toLocaleString()
              : '—'}
          </Text>
        </View>

        <View style={styles.section}>
          <View style={[styles.row, styles.th]}>
            <Text style={styles.cellSku}>SKU</Text>
            <Text style={styles.cellName}>Item</Text>
            <Text style={styles.cellBin}>Bin</Text>
            <Text style={styles.cellQty}>Qty</Text>
          </View>
          {lines.map((l) => (
            <View key={l.id} style={styles.row}>
              <Text style={styles.cellSku}>{l.item?.sku ?? '—'}</Text>
              <Text style={styles.cellName}>{l.item?.name ?? '—'}</Text>
              <Text style={styles.cellBin}>{'—' /* bin shown in phase 4 */}</Text>
              <Text style={styles.cellQty}>{l.quantity_requested}</Text>
            </View>
          ))}
        </View>

        {request.notes ? (
          <View style={styles.section}>
            <Text style={styles.subtle}>Requester notes:</Text>
            <Text>{request.notes}</Text>
          </View>
        ) : null}
      </Page>
    </Document>,
  );
  return streamToBuffer(stream as NodeJS.ReadableStream);
}
```

- [ ] **Step 3.4: Commit**

```bash
git add apps/web/src/app/api/orders/\[id\]/pick-slip.pdf/route.tsx \
        apps/web/src/lib/pdf/pick-slip.tsx
git commit -m "feat(orders): pick slip PDF route"
```

---

### Task 4: Digital pick page + recordPickedLine + completePicking actions

**Files:**
- Modify: `apps/web/src/server/services/order-requests.ts` (add `recordPickedLine` + `completePicking` methods)
- Modify: `apps/web/src/server/actions/order-requests.ts` (matching actions)
- Create: `apps/web/src/app/(dashboard)/dashboard/orders/[id]/pick/page.tsx`
- Create: `apps/web/src/components/orders/digital-pick.tsx`

- [ ] **Step 4.1: Service methods**

Add to `apps/web/src/server/services/order-requests.ts`:

```ts
async recordPickedLine(lineId: string, qty: number): Promise<void> {
  assertPermission(this.ctx, 'items:update');
  const { error } = await this.ctx.supabase.rpc('partial_pick_line', {
    p_line_id: lineId,
    p_qty: qty,
  });
  if (error) {
    const msg = error.message ?? '';
    if (msg.includes('over_pick'))
      throw new ServiceError('validation_error', 'Picked quantity exceeds requested.');
    if (msg.includes('order_request_line_not_found'))
      throw new ServiceError('not_found', 'Line not found.');
    if (msg.includes('forbidden'))
      throw new ServiceError('forbidden', 'Not allowed to pick on this order.');
    if (msg.includes('invalid_status_transition'))
      throw new ServiceError('validation_error', 'Order is not in a pickable status.');
    throw new ServiceError('internal_error', msg);
  }
}

async completePicking(id: string): Promise<OrderRequestRow> {
  assertPermission(this.ctx, 'items:update');
  await this.requireWarehouseAccess(id, 'write');
  const { data, error } = await this.ctx.supabase.rpc('complete_picking', {
    p_order_id: id,
  });
  if (error) {
    const msg = error.message ?? '';
    if (msg.includes('insufficient_stock'))
      throw new ServiceError(
        'validation_error',
        'Not enough stock to complete picking. Reduce picked quantities or top up the short items.',
      );
    if (msg.includes('invalid_status_transition'))
      throw new ServiceError('validation_error', 'Order is no longer being picked.');
    if (msg.includes('forbidden'))
      throw new ServiceError('forbidden', 'Not allowed to complete picking on this order.');
    throw new ServiceError('internal_error', msg);
  }
  const row = data as OrderRequestRow;
  await audit(
    { event: 'order.picking_complete', entityType: 'order_request', entityId: id },
    this.ctx,
  );
  return row;
}
```

- [ ] **Step 4.2: Server actions**

Append to `apps/web/src/server/actions/order-requests.ts`:

```ts
const recordPickedLineSchema = z.object({
  orderId: z.string().uuid(),
  lineId: z.string().uuid(),
  quantity: z.coerce.number().min(0).max(10_000),
});

export async function recordPickedLineAction(
  input: z.input<typeof recordPickedLineSchema>,
): Promise<ActionResult<void>> {
  const parsed = recordPickedLineSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.recordPickedLine(parsed.data.lineId, parsed.data.quantity);
    revalidatePath(`/dashboard/orders/${parsed.data.orderId}`);
    revalidatePath(`/dashboard/orders/${parsed.data.orderId}/pick`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const completePickingSchema = z.object({ id: z.string().uuid() });

export async function completePickingAction(
  input: z.input<typeof completePickingSchema>,
): Promise<ActionResult<void>> {
  const parsed = completePickingSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.completePicking(parsed.data.id);
    revalidatePath('/dashboard/orders');
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    revalidatePath(`/dashboard/orders/${parsed.data.id}/pick`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
```

- [ ] **Step 4.3: Digital pick page (server)**

Create `apps/web/src/app/(dashboard)/dashboard/orders/[id]/pick/page.tsx`:

```tsx
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { DigitalPick } from '@/components/orders/digital-pick';
import { OrderRequestsService } from '@/server/services/order-requests';

export const dynamic = 'force-dynamic';

export default async function DigitalPickPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const svc = await OrderRequestsService.forCurrentUser();
  const detail = await svc.get(id).catch(() => null);
  if (!detail) notFound();

  if (
    detail.request.status !== 'pick_slip_generated' &&
    detail.request.status !== 'picking_in_progress'
  ) {
    // If already complete or never started, send them to the detail page.
    redirect(`/dashboard/orders/${id}`);
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <Link
        href={`/dashboard/orders/${id}`}
        className="text-muted-foreground hover:text-foreground text-sm"
      >
        ← Back to order
      </Link>
      <header className="mt-3">
        <h1 className="font-display text-2xl">Pick slip</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Order #{id.slice(0, 8).toUpperCase()} ·{' '}
          {detail.request.requester_name ?? detail.request.requester_email ?? '—'}
        </p>
      </header>
      <div className="mt-6">
        <DigitalPick orderId={id} initialLines={detail.lines} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4.4: Digital pick client component**

Create `apps/web/src/components/orders/digital-pick.tsx`:

```tsx
'use client';

import { Check, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  completePickingAction,
  recordPickedLineAction,
} from '@/server/actions/order-requests';
import type { OrderRequestLineWithItem } from '@/server/services/order-requests';

interface DigitalPickProps {
  orderId: string;
  initialLines: OrderRequestLineWithItem[];
}

export function DigitalPick({ orderId, initialLines }: DigitalPickProps) {
  const router = useRouter();
  const [picked, setPicked] = React.useState<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const l of initialLines) {
      out[l.id] = Number(l.quantity_picked ?? 0);
    }
    return out;
  });
  const [savingLine, setSavingLine] = React.useState<string | null>(null);
  const [completing, setCompleting] = React.useState(false);

  async function save(lineId: string, qty: number) {
    setSavingLine(lineId);
    const res = await recordPickedLineAction({ orderId, lineId, quantity: qty });
    setSavingLine(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return false;
    }
    return true;
  }

  async function complete() {
    setCompleting(true);
    const res = await completePickingAction({ id: orderId });
    setCompleting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Picking complete. Stock decremented.');
    router.push(`/dashboard/orders/${orderId}`);
  }

  const allLinesPicked = initialLines.every((l) => (picked[l.id] ?? 0) > 0);
  const anyLinePicked = initialLines.some((l) => (picked[l.id] ?? 0) > 0);

  return (
    <div className="space-y-3">
      {initialLines.map((line) => {
        const requested = Number(line.quantity_requested);
        const current = picked[line.id] ?? 0;
        const isSaving = savingLine === line.id;
        return (
          <div
            key={line.id}
            className="border-border bg-card rounded-xl border p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{line.item?.name ?? '—'}</div>
                <div className="text-muted-foreground font-mono text-xs">
                  {line.item?.sku ?? '—'}
                </div>
              </div>
              <div className="text-muted-foreground shrink-0 text-xs">
                requested {requested}
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={requested}
                value={current}
                onChange={(e) =>
                  setPicked((p) => ({
                    ...p,
                    [line.id]: Math.max(0, Math.min(requested, Number(e.target.value) || 0)),
                  }))
                }
                className="w-24"
              />
              <Button
                type="button"
                size="sm"
                variant={current === requested ? 'default' : 'outline'}
                disabled={isSaving}
                onClick={async () => {
                  const ok = await save(line.id, current);
                  if (ok) toast.success(`Saved ${current} / ${requested}`);
                }}
              >
                {isSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Check className="mr-1 h-4 w-4" />
                    Save
                  </>
                )}
              </Button>
            </div>
          </div>
        );
      })}

      <div className="flex justify-end pt-2">
        <Button
          onClick={complete}
          disabled={completing || !anyLinePicked}
          variant="gradient"
          size="lg"
        >
          {completing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>Complete picking{allLinesPicked ? '' : ' (partial)'}</>
          )}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4.5: Verify**

```bash
pnpm typecheck
pnpm test
```

- [ ] **Step 4.6: Commit**

```bash
git add apps/web/src/server/services/order-requests.ts \
        apps/web/src/server/actions/order-requests.ts \
        apps/web/src/app/\(dashboard\)/dashboard/orders/\[id\]/pick/page.tsx \
        apps/web/src/components/orders/digital-pick.tsx
git commit -m "feat(orders): digital pick page + completePicking RPC wiring"
```

---

### Task 5: Wire actions into the order detail page

**File:** `apps/web/src/app/(dashboard)/dashboard/orders/[id]/page.tsx`

The existing detail page already imports `availableOrderActions` from `@stockpilot/core` (phase 1 helper). Now the page needs to render buttons for `generate_pick_slip`, `open_digital_pick`, `print_pick_slip`, `mark_picking_complete`.

- [ ] **Step 5.1: Read the current detail page** to understand the existing button area.

```bash
grep -n "availableOrderActions\|approve\|deny\|generatePickSlip\|completePicking" apps/web/src/app/\(dashboard\)/dashboard/orders/\[id\]/page.tsx apps/web/src/components/orders/manager-actions-panel.tsx
```

- [ ] **Step 5.2: Add the new buttons**

In `manager-actions-panel.tsx` (the existing client component that renders the action buttons), add handlers for:
- `generate_pick_slip` → calls `generatePickSlipAction({ id })`, toast success, refresh.
- `open_digital_pick` → navigates to `/dashboard/orders/[id]/pick`.
- `print_pick_slip` → opens `/api/orders/[id]/pick-slip.pdf` in a new tab.
- `mark_picking_complete` → calls `completePickingAction({ id })`.

Use the existing `BusyKey` union pattern in the file; mirror how `Mark packing slip generated` is wired so the new buttons match style.

The exact JSX additions depend on the file's structure — read it first, then surgical-add.

- [ ] **Step 5.3: Verify**

```bash
pnpm typecheck
pnpm test
```

- [ ] **Step 5.4: Commit + push**

```bash
git add apps/web/src/components/orders/manager-actions-panel.tsx
git commit -m "feat(orders): wire pick-slip + complete-picking buttons on order detail"
git push
```

---

### Task 6: Push + manual smoke test

- [ ] **Step 6.1: Confirm migration 0111 is applied**

Reply to the user: "Phase 3 implementation pushed. Apply migration 0111 in Supabase Studio if you haven't yet, then reply '0111 good' and smoke-test:"

1. Approve a pending order. Verify `assigned_picker_id = approverId` in DB.
2. Click "Generate pick slip" — status flips to `pick_slip_generated`, timestamps populated.
3. Open `/dashboard/orders/<id>/pick` on a phone. Enter qty on a line, hit Save. Verify status flips to `picking_in_progress` after first save.
4. Click "Print pick slip" — PDF opens, renders the lines and requester info.
5. Click "Complete picking". Verify status → `picking_complete`, `quantity_fulfilled` populated on lines, `stock_levels` decremented, `stock_reservations` released.
6. Try to over-pick (enter qty > requested) — should be rejected with friendly error.

---

## Phase 3 Self-Review

- **Spec coverage:** §1.5 RPC (Task 1), §2.3 pick slip PDF + digital UI (Tasks 3, 4), §4 phase-3 entry (auto-picker assign + email_log) covered. §5 email pipeline integration is partial — `order_email_log` table ships but the helper that uses it lands in phase 6.
- **Placeholder scan:** No "TBD"/"TODO". Every SQL block + TS function has actual code.
- **Type consistency:** `OrderStatus` literals match between TS state machine, DB transition guard, and the new RPCs. `OrderRequestRow.assigned_picker_id` was added in phase 1 (commit `7ace167`).
- **No spec gap:** Bin column in the pick slip PDF is intentionally `—` for phase 3; bins arrive in phase 4 alongside the packing slips.

## Migration applied

- 0111_orders_pick_slip_rpcs.sql — one new table (`order_email_log`), one updated function (`approve_order_request`), two new functions (`partial_pick_line`, `complete_picking`).

## Test count after Phase 3

- Before: 396
- After: 396 (no new unit tests this phase — RPCs require live DB, smoke-tested manually per Step 6.1; phase 6 adds the auto-action / email-log unit tests)

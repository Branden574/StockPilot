# Orders Workflow Refactor — Phase 4: Packing Slips + Staging + Delivery Assignment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** After picking is complete, generate two packing-slip PDFs (customer + warehouse with QR), let staff mark the order staged for pickup or delivery, and let managers assign a driver for staged deliveries.

**Architecture:** One migration (`0112`) introduces the `confirm_order_signature` RPC and a partial unique index on `signature_token`. TS adds `generatePackingSlipsAction`, `stageOrderAction`, `assignDeliveryAction`, two new PDF routes (customer + warehouse), and the manager-only assign-delivery dialog. Signature token is minted at packing-slip generation; the actual signature page lives in Phase 5.

**Tech Stack:** Postgres SECURITY DEFINER · `@react-pdf/renderer` + `qrcode` npm dep (already in repo, used by shipment slip route) · Next.js 16 server actions.

---

## Reference

- Spec: §2.4, §2.5 (staging + delivery assignment), §4 phase-4 entry
- Phase 3 pick slip PDF + RPC pattern: `apps/web/src/lib/pdf/pick-slip.tsx`, `supabase/migrations/0111_orders_pick_slip_rpcs.sql`
- Existing QR-on-PDF pattern: `apps/web/src/app/api/shipments/[id]/pdf/route.tsx` line 83 (`QRCode.toDataURL(...)`)
- `orders:assign_delivery` permission (manager+) already exists in `packages/core/src/constants/permissions.ts` (added in commit `bb1ce13`)
- State machine already exports the right transitions (commit `c42925a`): `picking_complete → packing_slip_generated`, `packing_slip_generated → staged_for_pickup | staged_for_delivery`

---

### Task 1: Migration 0112 — confirm_order_signature RPC + signature token index

**File to create:** `supabase/migrations/0112_orders_signature_rpc.sql`

This phase mints the `signature_token` on the order row when packing slips are generated. Phase 5 will consume it via the new `confirm_order_signature` RPC — we land the RPC + index now so the columns are ready.

- [ ] **Step 1.1: Write the migration**

```sql
-- 0112_orders_signature_rpc.sql
--
-- Phase 4 of the orders workflow refactor: introduces the atomic
-- signature-confirmation RPC consumed by /orders/sign/<token> in
-- phase 5. The signature_token column itself was added in 0109 and
-- is minted in this phase when packing slips are generated; this
-- migration adds the partial unique index on the column (so a
-- collision is impossible) and the RPC that the public signature
-- page calls.
--
-- The RPC pattern (atomic state flip + replay protection inside the
-- WHERE clause) mirrors confirm_public_order_request from 0108.

begin;

-- ────────────────────────────────────────────────────────────────────
-- 1. Partial unique index on signature_token.
--
-- Migration 0109 already adds `order_requests_signature_token_idx`
-- as a partial unique index; this is a no-op restate via
-- `create unique index if not exists` to make the migration
-- idempotent if anyone re-runs it during testing.
-- ────────────────────────────────────────────────────────────────────
create unique index if not exists order_requests_signature_token_idx
  on public.order_requests(signature_token)
  where signature_token is not null;

-- ────────────────────────────────────────────────────────────────────
-- 2. confirm_order_signature — public signature submission endpoint.
--
-- Called from /orders/sign/<token> in phase 5. Validates the token,
-- ensures the order is in a signable status, atomically flips it to
-- 'completed' and writes the signature fields. Replay protection is
-- the `signed_at IS NULL` guard inside the WHERE — a second click
-- after success returns zero rows and the caller renders the
-- "already used / invalid" panel.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.confirm_order_signature(
  p_id                uuid,
  p_signature_token   text,
  p_signer_name       text,
  p_signer_email      text,
  p_signature_data_url text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if p_id is null
     or coalesce(length(p_signature_token), 0) = 0
     or coalesce(length(trim(p_signer_name)), 0) = 0
     or coalesce(length(trim(p_signer_email)), 0) = 0
     or coalesce(length(p_signature_data_url), 0) = 0
  then
    return null;
  end if;

  update public.order_requests
     set status              = 'completed',
         signed_by_name      = p_signer_name,
         signed_by_email     = p_signer_email,
         signature_data_url  = p_signature_data_url,
         signed_at           = now(),
         completed_at        = now(),
         completed_by        = null
   where id = p_id
     and signature_token = p_signature_token
     and signed_at is null
     and status in ('staged_for_pickup', 'in_transit', 'signature_requested')
     and (
       signature_token_expires_at is null
       or signature_token_expires_at > now()
     )
   returning organization_id into v_org;

  return v_org;
end;
$$;

revoke all on function public.confirm_order_signature(uuid, text, text, text, text)
  from public, anon, authenticated;

grant execute on function public.confirm_order_signature(uuid, text, text, text, text)
  to service_role;

comment on function public.confirm_order_signature(uuid, text, text, text, text) is
  'Validates a signature token + signer details and atomically promotes the '
  'order from staged_for_pickup / in_transit / signature_requested to '
  'completed. Service-role only — phase 5 public page hashes the URL token '
  'before calling. The signed_at IS NULL clause inside WHERE guarantees '
  'no double-completion on replay clicks.';

commit;
```

- [ ] **Step 1.2: Commit + push (DO NOT apply)**

```bash
git add supabase/migrations/0112_orders_signature_rpc.sql
git commit -m "feat(orders): migration 0112 — confirm_order_signature RPC + token index

Lands the signature-confirmation RPC consumed by /orders/sign/<token>
in phase 5. The signature_token column itself was added in 0109; this
phase will mint it when packing slips are generated. The RPC's
replay protection (signed_at IS NULL inside WHERE) mirrors
confirm_public_order_request from 0108.

Token index is a no-op restate of 0109's index — re-stated here for
idempotent re-runs during testing."
git push
```

- [ ] **Step 1.3: STOP**

Wait for user to apply 0112 and confirm "0112 good" before proceeding.

---

### Task 2: `generatePackingSlipsAction` + service method

**Files:**
- Modify: `apps/web/src/server/services/order-requests.ts`
- Modify: `apps/web/src/server/actions/order-requests.ts`

- [ ] **Step 2.1: Add `generatePackingSlips` method to `OrderRequestsService`**

After the `completePicking` method:

```ts
async generatePackingSlips(id: string): Promise<OrderRequestRow> {
  assertPermission(this.ctx, 'orders:approve');
  await this.requireWarehouseAccess(id, 'write');

  const { data: row, error } = await this.ctx.supabase
    .from('order_requests')
    .select('status, signature_token')
    .eq('organization_id', this.ctx.organizationId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new ServiceError('internal_error', error.message);
  if (!row) throw new ServiceError('not_found', 'Order not found');

  // Accept BOTH first-time generation (picking_complete) AND re-
  // generation (packing_slip_generated). Regenerating mints a new
  // signature_token, which invalidates any QR already printed.
  if (
    row.status !== 'picking_complete' &&
    row.status !== 'packing_slip_generated'
  ) {
    throw new ServiceError(
      'validation_error',
      'Packing slips can only be generated after picking is complete.',
    );
  }

  // 256-bit hex token, distinct from the public-request token
  // namespace (those live on organizations.public_request_token).
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

  const { data: updated, error: updErr } = await this.ctx.supabase
    .from('order_requests')
    .update({
      status: 'packing_slip_generated',
      packing_slip_generated_at: new Date().toISOString(),
      packing_slip_generated_by: this.ctx.userId,
      signature_token: token,
      signature_token_expires_at: expiresAt,
    })
    .eq('organization_id', this.ctx.organizationId)
    .eq('id', id)
    .select('*')
    .single();
  if (updErr) throw new ServiceError('internal_error', updErr.message);
  await audit(
    { event: 'order.packing_slip_generated', entityType: 'order_request', entityId: id },
    this.ctx,
  );
  return updated as OrderRequestRow;
}
```

- [ ] **Step 2.2: Add `stageOrder` method**

```ts
async stageOrder(
  id: string,
  target: 'staged_for_pickup' | 'staged_for_delivery',
): Promise<OrderRequestRow> {
  assertPermission(this.ctx, 'orders:approve');
  await this.requireWarehouseAccess(id, 'write');

  const { data: row, error } = await this.ctx.supabase
    .from('order_requests')
    .select('status, fulfillment_type')
    .eq('organization_id', this.ctx.organizationId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new ServiceError('internal_error', error.message);
  if (!row) throw new ServiceError('not_found', 'Order not found');
  if (row.status !== 'packing_slip_generated') {
    throw new ServiceError(
      'validation_error',
      'Order must be packing-slip-generated before staging.',
    );
  }
  if (target === 'staged_for_pickup' && row.fulfillment_type !== 'pickup') {
    throw new ServiceError(
      'validation_error',
      'Only pickup orders can be staged for pickup.',
    );
  }
  if (target === 'staged_for_delivery' && row.fulfillment_type !== 'delivery') {
    throw new ServiceError(
      'validation_error',
      'Only delivery orders can be staged for delivery.',
    );
  }

  const { data: updated, error: updErr } = await this.ctx.supabase
    .from('order_requests')
    .update({
      status: target,
      staged_at: new Date().toISOString(),
      staged_by: this.ctx.userId,
    })
    .eq('organization_id', this.ctx.organizationId)
    .eq('id', id)
    .select('*')
    .single();
  if (updErr) throw new ServiceError('internal_error', updErr.message);
  await audit(
    {
      event: target === 'staged_for_pickup'
        ? 'order.staged_for_pickup'
        : 'order.staged_for_delivery',
      entityType: 'order_request',
      entityId: id,
    },
    this.ctx,
  );
  return updated as OrderRequestRow;
}
```

- [ ] **Step 2.3: Add `assignDelivery` method**

```ts
async assignDelivery(id: string, deliveryUserId: string): Promise<OrderRequestRow> {
  assertPermission(this.ctx, 'orders:assign_delivery');
  await this.requireWarehouseAccess(id, 'write');

  // Confirm the assignee is actually in this org (defense-in-depth
  // against a manipulated client posting an unrelated UUID).
  const { data: member } = await this.ctx.supabase
    .from('organization_members')
    .select('user_id')
    .eq('organization_id', this.ctx.organizationId)
    .eq('user_id', deliveryUserId)
    .not('accepted_at', 'is', null)
    .maybeSingle();
  if (!member) {
    throw new ServiceError(
      'validation_error',
      'That user is not an active member of this organization.',
    );
  }

  const { data: row } = await this.ctx.supabase
    .from('order_requests')
    .select('status')
    .eq('organization_id', this.ctx.organizationId)
    .eq('id', id)
    .maybeSingle();
  if (!row) throw new ServiceError('not_found', 'Order not found');
  if (row.status !== 'staged_for_delivery') {
    throw new ServiceError(
      'validation_error',
      'Delivery can only be assigned to staged-for-delivery orders.',
    );
  }

  const { data: updated, error } = await this.ctx.supabase
    .from('order_requests')
    .update({
      assigned_delivery_user_id: deliveryUserId,
      assigned_delivery_by: this.ctx.userId,
      assigned_delivery_at: new Date().toISOString(),
    })
    .eq('organization_id', this.ctx.organizationId)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new ServiceError('internal_error', error.message);
  await audit(
    {
      event: 'order.delivery_assigned',
      entityType: 'order_request',
      entityId: id,
      extra: { assigned_delivery_user_id: deliveryUserId },
    },
    this.ctx,
  );
  return updated as OrderRequestRow;
}
```

- [ ] **Step 2.4: Add the three actions**

Append to `apps/web/src/server/actions/order-requests.ts`:

```ts
const generatePackingSlipsSchema = z.object({ id: z.string().uuid() });

export async function generatePackingSlipsAction(
  input: z.input<typeof generatePackingSlipsSchema>,
): Promise<ActionResult<void>> {
  const parsed = generatePackingSlipsSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.generatePackingSlips(parsed.data.id);
    revalidatePath('/dashboard/orders');
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const stageOrderSchema = z.object({
  id: z.string().uuid(),
  target: z.enum(['staged_for_pickup', 'staged_for_delivery']),
});

export async function stageOrderAction(
  input: z.input<typeof stageOrderSchema>,
): Promise<ActionResult<void>> {
  const parsed = stageOrderSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.stageOrder(parsed.data.id, parsed.data.target);
    revalidatePath('/dashboard/orders');
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const assignDeliverySchema = z.object({
  id: z.string().uuid(),
  deliveryUserId: z.string().uuid(),
});

export async function assignDeliveryAction(
  input: z.input<typeof assignDeliverySchema>,
): Promise<ActionResult<void>> {
  const parsed = assignDeliverySchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.assignDelivery(parsed.data.id, parsed.data.deliveryUserId);
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
```

- [ ] **Step 2.5: Verify + commit**

```bash
pnpm typecheck
pnpm test
git add apps/web/src/server/services/order-requests.ts apps/web/src/server/actions/order-requests.ts
git commit -m "feat(orders): generate packing slips + stage + assign delivery (service+action)"
```

---

### Task 3: Packing slip PDFs — customer + warehouse (with QR)

**Files to create:**
- `apps/web/src/lib/pdf/packing-slip-customer.tsx`
- `apps/web/src/lib/pdf/packing-slip-warehouse.tsx`
- `apps/web/src/app/api/orders/[id]/packing-slip-customer.pdf/route.tsx`
- `apps/web/src/app/api/orders/[id]/packing-slip-warehouse.pdf/route.tsx`

Both PDFs share the `streamToBuffer` helper pattern from `pick-slip.tsx`. The warehouse copy generates a QR code via `qrcode` (already in deps).

- [ ] **Step 3.1: Customer copy renderer**

`apps/web/src/lib/pdf/packing-slip-customer.tsx`:

```tsx
import { renderToStream, Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

import type { OrderRequestDetail } from '@/server/services/order-requests';

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 11, fontFamily: 'Helvetica' },
  h1: { fontSize: 20, fontWeight: 700 },
  subtle: { color: '#666', fontSize: 10 },
  section: { marginTop: 16 },
  row: { flexDirection: 'row', borderBottom: '1pt solid #eee', paddingVertical: 6 },
  th: { fontWeight: 700, color: '#444' },
  cellQty: { width: 50, textAlign: 'right' },
  cellName: { flex: 1 },
});

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function renderCustomerPackingSlipPdf(
  detail: OrderRequestDetail,
): Promise<Buffer> {
  const { request, lines, warehouseName } = detail;
  const stream = await renderToStream(
    <Document>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.h1}>Packing slip</Text>
        <Text style={styles.subtle}>
          Order #{request.id.slice(0, 8).toUpperCase()} ·{' '}
          {request.fulfillment_type === 'pickup' ? 'Pickup' : 'Delivery'} ·
          {' '}{warehouseName ?? '—'}
        </Text>

        <View style={styles.section}>
          <Text>For: {request.requester_name ?? request.requester_email ?? '—'}</Text>
          <Text style={styles.subtle}>
            Packed:{' '}
            {request.packing_slip_generated_at
              ? new Date(request.packing_slip_generated_at).toLocaleDateString()
              : '—'}
          </Text>
        </View>

        <View style={styles.section}>
          <View style={[styles.row, styles.th]}>
            <Text style={styles.cellName}>Item</Text>
            <Text style={styles.cellQty}>Qty</Text>
          </View>
          {lines.map((l) => (
            <View key={l.id} style={styles.row}>
              <Text style={styles.cellName}>{l.item?.name ?? '—'}</Text>
              <Text style={styles.cellQty}>
                {String(l.quantity_picked ?? l.quantity_requested)}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.section}>
          <Text style={styles.subtle}>
            Questions? Reply to the email this slip came with.
          </Text>
        </View>
      </Page>
    </Document>,
  );
  return streamToBuffer(stream as NodeJS.ReadableStream);
}
```

- [ ] **Step 3.2: Warehouse copy renderer (with QR)**

`apps/web/src/lib/pdf/packing-slip-warehouse.tsx`:

```tsx
import { renderToStream, Document, Page, Text, View, Image, StyleSheet } from '@react-pdf/renderer';

import type { OrderRequestDetail } from '@/server/services/order-requests';

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 11, fontFamily: 'Helvetica' },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  h1: { fontSize: 18, fontWeight: 700 },
  subtle: { color: '#666', fontSize: 10 },
  section: { marginTop: 14 },
  row: { flexDirection: 'row', borderBottom: '1pt solid #ddd', paddingVertical: 6 },
  th: { fontWeight: 700, backgroundColor: '#f5f5f5' },
  cellSku: { width: 100, fontFamily: 'Courier' },
  cellName: { flex: 1 },
  cellQty: { width: 60, textAlign: 'right' },
  qr: { width: 110, height: 110 },
  qrLabel: { fontSize: 9, color: '#666', textAlign: 'center', marginTop: 4 },
});

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

interface WarehouseInput {
  detail: OrderRequestDetail;
  qrDataUrl: string | null;
  charterName: string | null;
}

export async function renderWarehousePackingSlipPdf(
  input: WarehouseInput,
): Promise<Buffer> {
  const { detail, qrDataUrl, charterName } = input;
  const { request, lines, warehouseName } = detail;
  const stream = await renderToStream(
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.topRow}>
          <View>
            <Text style={styles.h1}>Packing slip (warehouse)</Text>
            <Text style={styles.subtle}>
              Order #{request.id.slice(0, 8).toUpperCase()} ·{' '}
              {request.fulfillment_type === 'pickup' ? 'Pickup' : 'Delivery'}
            </Text>
            <Text style={styles.subtle}>
              From: {warehouseName ?? '—'}
              {request.fulfillment_type === 'delivery' && charterName
                ? ` → ${charterName}`
                : ''}
            </Text>
          </View>
          {qrDataUrl ? (
            <View>
              <Image src={qrDataUrl} style={styles.qr} />
              <Text style={styles.qrLabel}>Scan to collect signature</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text>
            Requester:{' '}
            {request.requester_name ?? '—'}
            {request.requester_email ? ` · ${request.requester_email}` : ''}
            {request.requester_phone ? ` · ${request.requester_phone}` : ''}
          </Text>
          {request.fulfillment_type === 'pickup' && request.pickup_location_notes ? (
            <Text style={styles.subtle}>
              Pickup notes: {request.pickup_location_notes}
            </Text>
          ) : null}
          <Text style={styles.subtle}>
            Packed:{' '}
            {request.packing_slip_generated_at
              ? new Date(request.packing_slip_generated_at).toLocaleString()
              : '—'}
          </Text>
          {request.internal_notes ? (
            <Text style={styles.subtle}>Internal: {request.internal_notes}</Text>
          ) : null}
        </View>

        <View style={styles.section}>
          <View style={[styles.row, styles.th]}>
            <Text style={styles.cellSku}>SKU</Text>
            <Text style={styles.cellName}>Item</Text>
            <Text style={styles.cellQty}>Qty</Text>
          </View>
          {lines.map((l) => (
            <View key={l.id} style={styles.row}>
              <Text style={styles.cellSku}>{l.item?.sku ?? '—'}</Text>
              <Text style={styles.cellName}>{l.item?.name ?? '—'}</Text>
              <Text style={styles.cellQty}>
                {String(l.quantity_picked ?? l.quantity_requested)}
              </Text>
            </View>
          ))}
        </View>
      </Page>
    </Document>,
  );
  return streamToBuffer(stream as NodeJS.ReadableStream);
}
```

- [ ] **Step 3.3: Customer PDF route**

`apps/web/src/app/api/orders/[id]/packing-slip-customer.pdf/route.tsx`:

```tsx
import { NextResponse, type NextRequest } from 'next/server';

import { OrderRequestsService } from '@/server/services/order-requests';
import { renderCustomerPackingSlipPdf } from '@/lib/pdf/packing-slip-customer';

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
    if (!['packing_slip_generated', 'staged_for_pickup', 'staged_for_delivery', 'in_transit', 'signature_requested', 'completed'].includes(detail.request.status)) {
      return NextResponse.json(
        { error: 'not_yet_generated', message: 'Generate packing slips first.' },
        { status: 400 },
      );
    }
    const pdf = await renderCustomerPackingSlipPdf(detail);
    const bytes = new Uint8Array(pdf);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="packing-slip-${detail.request.id.slice(0, 8)}.pdf"`,
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

- [ ] **Step 3.4: Warehouse PDF route**

`apps/web/src/app/api/orders/[id]/packing-slip-warehouse.pdf/route.tsx`:

```tsx
import QRCode from 'qrcode';
import { NextResponse, type NextRequest } from 'next/server';

import { OrderRequestsService } from '@/server/services/order-requests';
import { renderWarehousePackingSlipPdf } from '@/lib/pdf/packing-slip-warehouse';
import { env } from '@/lib/env';
import { createClient } from '@/lib/supabase/server';

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
    if (!['packing_slip_generated', 'staged_for_pickup', 'staged_for_delivery', 'in_transit', 'signature_requested', 'completed'].includes(detail.request.status)) {
      return NextResponse.json(
        { error: 'not_yet_generated', message: 'Generate packing slips first.' },
        { status: 400 },
      );
    }

    const token = detail.request.signature_token;
    let qrDataUrl: string | null = null;
    if (token) {
      const url = `${env.NEXT_PUBLIC_APP_URL ?? ''}/orders/sign/${token}`;
      try {
        qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 });
      } catch {
        qrDataUrl = null;
      }
    }

    // Pull charter name when present, for the warehouse slip header.
    let charterName: string | null = null;
    if (detail.request.delivery_charter_id) {
      const supabase = await createClient();
      const { data } = await supabase
        .from('charters')
        .select('name')
        .eq('id', detail.request.delivery_charter_id)
        .maybeSingle();
      charterName = (data as { name?: string } | null)?.name ?? null;
    }

    const pdf = await renderWarehousePackingSlipPdf({ detail, qrDataUrl, charterName });
    const bytes = new Uint8Array(pdf);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="packing-slip-warehouse-${detail.request.id.slice(0, 8)}.pdf"`,
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

- [ ] **Step 3.5: Verify + commit**

```bash
pnpm typecheck
pnpm test
git add apps/web/src/lib/pdf/packing-slip-customer.tsx \
        apps/web/src/lib/pdf/packing-slip-warehouse.tsx \
        apps/web/src/app/api/orders/\[id\]/packing-slip-customer.pdf/route.tsx \
        apps/web/src/app/api/orders/\[id\]/packing-slip-warehouse.pdf/route.tsx
git commit -m "feat(orders): customer + warehouse packing slip PDFs (warehouse has QR)"
```

---

### Task 4: Assign-delivery dialog UI

**Files to create:**
- `apps/web/src/components/orders/assign-delivery-dialog.tsx`

**Files to modify:**
- `apps/web/src/components/orders/manager-actions-panel.tsx` (wire the dialog)
- `apps/web/src/app/(dashboard)/dashboard/orders/[id]/page.tsx` (load eligible drivers list)

- [ ] **Step 4.1: Dialog component**

`apps/web/src/components/orders/assign-delivery-dialog.tsx`:

```tsx
'use client';

import { Loader2, Truck } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { assignDeliveryAction } from '@/server/actions/order-requests';

export interface DriverOption {
  userId: string;
  fullName: string | null;
  email: string;
}

interface Props {
  orderId: string;
  drivers: DriverOption[];
  currentDriverId: string | null;
  trigger: React.ReactNode;
}

export function AssignDeliveryDialog({
  orderId,
  drivers,
  currentDriverId,
  trigger,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<string>(currentDriverId ?? '');
  const [pending, setPending] = React.useState(false);

  async function submit() {
    if (!selected) {
      toast.error('Pick a driver.');
      return;
    }
    setPending(true);
    const res = await assignDeliveryAction({ id: orderId, deliveryUserId: selected });
    setPending(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Delivery assigned.');
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !pending && setOpen(v)}>
      <span onClick={() => setOpen(true)} className="inline-block">
        {trigger}
      </span>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign delivery</DialogTitle>
          <DialogDescription>
            Pick the staff member who'll drive this order. They'll be able to mark
            it in-transit and collect the signature.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="driver">Driver</Label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger id="driver">
              <SelectValue placeholder="Pick someone" />
            </SelectTrigger>
            <SelectContent>
              {drivers.map((d) => (
                <SelectItem key={d.userId} value={d.userId}>
                  {d.fullName ?? d.email}
                  {d.fullName ? ` (${d.email})` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !selected}>
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Truck className="mr-1 h-4 w-4" /> Assign
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4.2: Page-level driver list query**

In `apps/web/src/app/(dashboard)/dashboard/orders/[id]/page.tsx`, in the server component, fetch eligible drivers (any active member of the org) and pass to `<ManagerActionsPanel />`. The existing page already builds the panel — extend it.

Pattern:

```ts
import type { DriverOption } from '@/components/orders/assign-delivery-dialog';

// inside the page server component:
const { data: members } = await supabase
  .from('organization_members')
  .select('user_id, user:user_profiles!user_id (id, full_name, email)')
  .eq('organization_id', ctx.organizationId)
  .not('accepted_at', 'is', null);

const drivers: DriverOption[] = (members ?? []).flatMap((m) => {
  const u = Array.isArray((m as any).user)
    ? (m as any).user[0]
    : (m as any).user;
  if (!u || !u.email) return [];
  return [{ userId: u.id as string, fullName: (u.full_name as string | null) ?? null, email: u.email as string }];
});

// pass to panel:
<ManagerActionsPanel
  // ...existing props
  drivers={drivers}
/>
```

- [ ] **Step 4.3: Wire the dialog into manager-actions-panel**

Inside the existing `staged_for_delivery` JSX block in `apps/web/src/components/orders/manager-actions-panel.tsx`:

```tsx
{order.status === 'staged_for_delivery' && (
  <>
    <AssignDeliveryDialog
      orderId={order.id}
      drivers={drivers}
      currentDriverId={order.assigned_delivery_user_id}
      trigger={
        <Button variant="default" disabled={busy !== null}>
          <Truck className="mr-1 h-4 w-4" /> Assign delivery
        </Button>
      }
    />
    {/* ... existing 'Mark in transit' button (added in Phase 5) */}
  </>
)}
```

Pass `drivers: DriverOption[]` through `ManagerActionsPanelProps`. Import `AssignDeliveryDialog` from `@/components/orders/assign-delivery-dialog`.

- [ ] **Step 4.4: Verify + commit + push**

```bash
pnpm typecheck
pnpm test
git add apps/web/src/components/orders/assign-delivery-dialog.tsx \
        apps/web/src/components/orders/manager-actions-panel.tsx \
        apps/web/src/app/\(dashboard\)/dashboard/orders/\[id\]/page.tsx
git commit -m "feat(orders): assign-delivery dialog (manager+, staged_for_delivery only)"
git push
```

---

### Task 5: Wire generate-packing + stage buttons into the panel

Same file (`manager-actions-panel.tsx`) — add three more buttons:

- `Generate packing slips` (visible when status === 'picking_complete')
- `Print customer slip` (visible from `packing_slip_generated` onward)
- `Print warehouse slip` (visible from `packing_slip_generated` onward)
- `Mark staged for pickup` (visible when status === 'packing_slip_generated' && fulfillment_type === 'pickup')
- `Mark staged for delivery` (visible when status === 'packing_slip_generated' && fulfillment_type === 'delivery')

Mirror the existing Phase 3 wiring pattern (busy key, toast on success, router.refresh).

- [ ] **Step 5.1: Add busy keys + handlers**

In `BusyKey` union: `'generate-packing-slips'`, `'stage-pickup'`, `'stage-delivery'`. Add three handlers calling the matching actions.

- [ ] **Step 5.2: Add the JSX**

Slot the new buttons into the existing status-conditional blocks. The Print buttons open `/api/orders/<id>/packing-slip-customer.pdf` and `/api/orders/<id>/packing-slip-warehouse.pdf` via `window.open`, mirroring the Phase 3 `Print pick slip` handler.

- [ ] **Step 5.3: Verify + commit + push**

```bash
pnpm typecheck
pnpm test
git add apps/web/src/components/orders/manager-actions-panel.tsx
git commit -m "feat(orders): wire generate packing slips + print + stage buttons"
git push
```

---

### Task 6: Push + smoke test

After everything ships, prompt the user to:
1. Apply migration 0112 in Supabase Studio (if not done at Task 1).
2. From an order in `picking_complete`, click "Generate packing slips" — status flips to `packing_slip_generated`, `signature_token` populated.
3. Click "Print customer slip" — minimal PDF opens.
4. Click "Print warehouse slip" — full PDF with QR code in top-right.
5. Scan the QR with a phone — should resolve to `/orders/sign/<token>` (Phase 5 builds this page; for now it 404s, which is expected).
6. Click "Mark staged for pickup" (or delivery) — status flips correctly. Try staging a pickup order as delivery — should reject.
7. As manager, on a `staged_for_delivery` order, click "Assign delivery" — dialog lists drivers, picking + submitting writes `assigned_delivery_user_id`.

---

## Phase 4 Self-Review

- **Spec coverage:** §1 token columns (already exist), §2.4 packing slips + QR (Tasks 2+3), §2.5 staging + assign (Tasks 2+4), §4 phase-4 migration (Task 1).
- **Placeholder scan:** No "TBD". Every SQL block + TS function has actual code.
- **Type consistency:** New actions follow the same `ActionResult<void>` + `revalidatePath` pattern.
- **No spec gap:** The `staged_for_delivery → in_transit` transition + `/orders/sign/<token>` page are intentionally deferred to Phase 5.

## Migration applied

- 0112_orders_signature_rpc.sql — `confirm_order_signature` SECURITY DEFINER RPC + token-index restate.

## Test count after Phase 4

- Before: 396
- After: 396 (no new unit tests; smoke-test path per Step 6)

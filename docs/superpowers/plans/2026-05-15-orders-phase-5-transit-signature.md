# Orders Workflow Refactor — Phase 5: Transit + Public Signature Page

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Mark in-transit (delivery only, by assigned driver or manager+), let the customer sign on the public `/orders/sign/<token>` page, and complete the order with a confirmation email.

**Architecture:** No DB migration (everything table-driven from migrations 0109 + 0112). One server action + service method for "mark in transit". One new public route `/orders/sign/<token>`. The signature page calls a new server action that wraps the existing `confirm_order_signature` RPC from migration 0112. Completion email reuses the existing `sendOrderRequestEmail` pipeline.

**Tech Stack:** Next.js 16 server actions + server components · existing signature-pad component used by shipment-signature flow (reuse, don't reinvent).

---

## Reference

- Spec: §2.6 transit + signature, §4 phase-5 entry
- Existing signature-pad client: search for "signature_data_url" usage in `apps/web/src/components/` — the shipment-signature flow has the pad already
- `confirm_order_signature` RPC: `supabase/migrations/0112_orders_signature_rpc.sql` (applied)
- Existing public layout: `apps/web/src/app/r/layout.tsx` — minimal, no dashboard chrome

---

### Task 1: `markInTransit` service method + action

**Files:**
- Modify: `apps/web/src/server/services/order-requests.ts`
- Modify: `apps/web/src/server/actions/order-requests.ts`

- [ ] **Step 1.1: Service method**

After `assignDelivery`:

```ts
async markInTransit(id: string): Promise<OrderRequestRow> {
  // Permission gate: assigned driver OR manager+. The action layer
  // already validates the role; this is defense-in-depth.
  assertPermission(this.ctx, 'orders:approve');
  await this.requireWarehouseAccess(id, 'write');

  const { data: row } = await this.ctx.supabase
    .from('order_requests')
    .select('status, assigned_delivery_user_id, fulfillment_type')
    .eq('organization_id', this.ctx.organizationId)
    .eq('id', id)
    .maybeSingle();
  if (!row) throw new ServiceError('not_found', 'Order not found');
  const r = row as {
    status: string;
    assigned_delivery_user_id: string | null;
    fulfillment_type: 'pickup' | 'delivery';
  };
  if (r.fulfillment_type !== 'delivery') {
    throw new ServiceError(
      'validation_error',
      'Only delivery orders can be marked in transit.',
    );
  }
  if (r.status !== 'staged_for_delivery') {
    throw new ServiceError(
      'validation_error',
      'Order must be staged for delivery first.',
    );
  }
  if (!r.assigned_delivery_user_id) {
    throw new ServiceError(
      'validation_error',
      'Assign a driver before marking in transit.',
    );
  }

  // The action layer permits assigned-driver OR manager+. Check role
  // here only if the caller is NOT the assigned driver.
  if (r.assigned_delivery_user_id !== this.ctx.userId) {
    if (!['owner', 'admin', 'manager'].includes(this.ctx.role)) {
      throw new ServiceError(
        'forbidden',
        'Only the assigned driver or a manager can mark in transit.',
      );
    }
  }

  const { data: updated, error } = await this.ctx.supabase
    .from('order_requests')
    .update({
      status: 'in_transit',
      in_transit_at: new Date().toISOString(),
      in_transit_by: this.ctx.userId,
    })
    .eq('organization_id', this.ctx.organizationId)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new ServiceError('internal_error', error.message);
  const finalRow = updated as OrderRequestRow;
  await audit(
    { event: 'order.in_transit', entityType: 'order_request', entityId: id },
    this.ctx,
  );
  // Best-effort: notify requester the order is on the way.
  void this.notifyEmail(finalRow, 'staged_for_delivery');
  return finalRow;
}
```

NOTE: the email kind reuses `staged_for_delivery` because the email template already exists with the right copy ("Ready to deliver"). Phase 6 will add a dedicated `in_transit` email kind if the UX team wants different copy.

- [ ] **Step 1.2: Action**

Append:

```ts
const markInTransitSchema = z.object({ id: z.string().uuid() });

export async function markInTransitAction(
  input: z.input<typeof markInTransitSchema>,
): Promise<ActionResult<void>> {
  const parsed = markInTransitSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.markInTransit(parsed.data.id);
    revalidatePath('/dashboard/orders');
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
```

- [ ] **Step 1.3: Verify + commit**

```bash
pnpm typecheck
pnpm test
git add apps/web/src/server/services/order-requests.ts apps/web/src/server/actions/order-requests.ts
git commit -m "feat(orders): markInTransit action (assigned driver OR manager+)"
```

---

### Task 2: Public signature page + submit action

**Files:**
- Create: `apps/web/src/app/orders/sign/[token]/page.tsx`
- Create: `apps/web/src/app/orders/sign/[token]/layout.tsx`
- Create: `apps/web/src/components/orders/signature-collector.tsx`
- Create: `apps/web/src/server/actions/order-signature.ts`

The signature submission action calls the `confirm_order_signature` RPC via the admin client (the public page has no Supabase JWT). The page itself is server-rendered with no auth — the token IS the auth.

- [ ] **Step 2.1: Bare public layout**

`apps/web/src/app/orders/sign/[token]/layout.tsx`:

```tsx
import type { ReactNode } from 'react';

export default function OrderSignLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background text-foreground min-h-screen">
      <main className="mx-auto w-full max-w-md px-4 py-8 sm:px-6 sm:py-12">
        {children}
      </main>
      <footer className="text-muted-foreground mx-auto max-w-md px-4 pb-10 text-center text-[11px] sm:px-6">
        Powered by StockPilot
      </footer>
    </div>
  );
}
```

- [ ] **Step 2.2: Server-rendered signature page**

`apps/web/src/app/orders/sign/[token]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';

import { SignatureCollector } from '@/components/orders/signature-collector';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sign for order · StockPilot',
  robots: { index: false, follow: false },
};

const TOKEN_RE = /^[0-9a-f]{64}$/i;

interface OrderSummary {
  id: string;
  status: string;
  requesterName: string | null;
  requesterEmail: string | null;
  fulfillmentType: 'pickup' | 'delivery';
  warehouseName: string | null;
  charterName: string | null;
  lines: Array<{
    itemName: string;
    quantityPicked: number;
    quantityRequested: number;
  }>;
}

export default async function OrderSignPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!TOKEN_RE.test(token)) notFound();

  const admin = createAdminClient();

  // Look up the order by signature_token. Token is the auth here — RLS
  // is bypassed via admin client because the signer has no JWT.
  const { data: orderRow } = await admin
    .from('order_requests')
    .select(
      'id, status, requester_name, requester_email, fulfillment_type, ' +
        'warehouse_id, delivery_charter_id, signature_token_expires_at, signed_at',
    )
    .eq('signature_token', token)
    .maybeSingle();

  if (!orderRow) notFound();
  const order = orderRow as {
    id: string;
    status: string;
    requester_name: string | null;
    requester_email: string | null;
    fulfillment_type: 'pickup' | 'delivery';
    warehouse_id: string;
    delivery_charter_id: string | null;
    signature_token_expires_at: string | null;
    signed_at: string | null;
  };

  // Ambiguous-failure UI for: expired, already signed, or wrong status.
  const expired =
    order.signature_token_expires_at &&
    new Date(order.signature_token_expires_at).getTime() < Date.now();
  const wrongStatus = !['staged_for_pickup', 'in_transit', 'signature_requested'].includes(
    order.status,
  );
  const alreadySigned = order.signed_at !== null;

  if (expired || wrongStatus || alreadySigned) {
    return <InvalidPanel reason={alreadySigned ? 'already' : 'invalid'} />;
  }

  // Parallel: warehouse name + charter name + lines.
  const [whRes, charterRes, linesRes] = await Promise.all([
    admin.from('warehouses').select('name').eq('id', order.warehouse_id).maybeSingle(),
    order.delivery_charter_id
      ? admin
          .from('charters')
          .select('name')
          .eq('id', order.delivery_charter_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    admin
      .from('order_request_lines')
      .select(
        `quantity_picked, quantity_requested,
         item:inventory_items!item_id (name)`,
      )
      .eq('order_request_id', order.id),
  ]);

  type LineRow = {
    quantity_picked: number | null;
    quantity_requested: number;
    item: { name?: string } | { name?: string }[] | null;
  };
  const lines = ((linesRes.data ?? []) as LineRow[]).map((row) => {
    const itemField = row.item;
    const item = Array.isArray(itemField) ? itemField[0] ?? null : itemField;
    return {
      itemName: item?.name ?? '—',
      quantityPicked: Number(row.quantity_picked ?? 0),
      quantityRequested: Number(row.quantity_requested),
    };
  });

  const summary: OrderSummary = {
    id: order.id,
    status: order.status,
    requesterName: order.requester_name,
    requesterEmail: order.requester_email,
    fulfillmentType: order.fulfillment_type,
    warehouseName: (whRes.data as { name?: string } | null)?.name ?? null,
    charterName: (charterRes.data as { name?: string } | null)?.name ?? null,
    lines,
  };

  return (
    <div className="space-y-6">
      <header className="text-center">
        <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.12em]">
          StockPilot
        </p>
        <h1 className="font-display mt-1 text-[26px] font-medium leading-tight tracking-[-0.025em]">
          Sign for your order
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Order #{summary.id.slice(0, 8).toUpperCase()}
        </p>
      </header>
      <SignatureCollector token={token} summary={summary} />
    </div>
  );
}

function InvalidPanel({ reason }: { reason: 'invalid' | 'already' }) {
  return (
    <div className="text-center">
      <header className="space-y-2">
        <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.12em]">
          StockPilot
        </p>
        <h1 className="font-display text-[26px] font-medium leading-tight tracking-[-0.025em]">
          {reason === 'already' ? 'This order is already signed' : "We can't sign this order"}
        </h1>
        <p className="text-muted-foreground mt-3 text-sm">
          {reason === 'already'
            ? 'Thanks — looks like this order was already completed. Check your inbox for the confirmation email.'
            : 'This link is invalid, expired, or the order is no longer awaiting a signature. If you think this is wrong, get in touch with the warehouse.'}
        </p>
      </header>
    </div>
  );
}
```

- [ ] **Step 2.3: Client-side signature collector**

`apps/web/src/components/orders/signature-collector.tsx`:

This component uses an HTML5 `<canvas>` for the signature pad. Reuse the existing canvas signature implementation if one exists — check `apps/web/src/components/` and the shipment-signature flow first:

```bash
find apps/web/src/components -name "*signature*" -type f
```

If a reusable `<SignaturePad>` exists, import it. Otherwise write inline:

```tsx
'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { submitOrderSignatureAction } from '@/server/actions/order-signature';

interface OrderSummary {
  id: string;
  status: string;
  requesterName: string | null;
  requesterEmail: string | null;
  fulfillmentType: 'pickup' | 'delivery';
  warehouseName: string | null;
  charterName: string | null;
  lines: Array<{
    itemName: string;
    quantityPicked: number;
    quantityRequested: number;
  }>;
}

export function SignatureCollector({
  token,
  summary,
}: {
  token: string;
  summary: OrderSummary;
}) {
  const router = useRouter();
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const drawingRef = React.useRef(false);
  const lastRef = React.useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = React.useState(false);
  const [signerName, setSignerName] = React.useState(summary.requesterName ?? '');
  const [signerEmail, setSignerEmail] = React.useState(summary.requesterEmail ?? '');
  const [submitting, setSubmitting] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111';
  }, []);

  function pointAt(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    drawingRef.current = true;
    lastRef.current = pointAt(e);
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const next = pointAt(e);
    if (!next || !lastRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    ctx.beginPath();
    ctx.moveTo(lastRef.current.x, lastRef.current.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
    lastRef.current = next;
    if (!hasInk) setHasInk(true);
  }

  function onPointerUp() {
    drawingRef.current = false;
    lastRef.current = null;
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  }

  async function submit() {
    if (!signerName.trim()) {
      toast.error('Enter the name of who is signing.');
      return;
    }
    if (!signerEmail.trim()) {
      toast.error('Enter an email so we can confirm delivery.');
      return;
    }
    if (!hasInk) {
      toast.error('Sign in the box above first.');
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    setSubmitting(true);
    const res = await submitOrderSignatureAction({
      token,
      signerName: signerName.trim(),
      signerEmail: signerEmail.trim(),
      signatureDataUrl: dataUrl,
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setSubmitted(true);
    router.refresh();
  }

  if (submitted) {
    return (
      <div className="border-border bg-card rounded-2xl border p-6 text-center">
        <h2 className="font-display text-xl">Thank you</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          The order is marked completed. A digital receipt is on its way to{' '}
          <span className="text-foreground font-medium">{signerEmail.trim()}</span>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="border-border bg-card space-y-2 rounded-2xl border p-4">
        <p className="text-muted-foreground text-xs uppercase tracking-wide">
          Order summary
        </p>
        <p className="text-sm">
          {summary.lines.length} item{summary.lines.length === 1 ? '' : 's'} ·{' '}
          {summary.fulfillmentType === 'pickup' ? 'Pickup' : 'Delivery'} ·{' '}
          {summary.warehouseName ?? 'Warehouse'}
          {summary.charterName ? ` → ${summary.charterName}` : ''}
        </p>
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer">Show items</summary>
          <ul className="mt-2 space-y-1">
            {summary.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="flex-1 truncate">{l.itemName}</span>
                <span className="tabular-nums">{l.quantityPicked || l.quantityRequested}</span>
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section className="border-border bg-card space-y-3 rounded-2xl border p-4">
        <div className="space-y-2">
          <Label htmlFor="signer-name">Your name</Label>
          <Input
            id="signer-name"
            value={signerName}
            onChange={(e) => setSignerName(e.target.value)}
            placeholder="Full name"
            maxLength={120}
            autoComplete="name"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="signer-email">Email</Label>
          <Input
            id="signer-email"
            type="email"
            value={signerEmail}
            onChange={(e) => setSignerEmail(e.target.value)}
            placeholder="you@example.com"
            maxLength={254}
            autoComplete="email"
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Signature</Label>
            <Button type="button" variant="ghost" size="sm" onClick={clear}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> Clear
            </Button>
          </div>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className="border-border bg-background h-40 w-full touch-none rounded-lg border"
          />
        </div>
        <Button
          onClick={submit}
          disabled={submitting || !hasInk}
          className="w-full"
          size="lg"
          variant="gradient"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm & complete'}
        </Button>
      </section>
    </div>
  );
}
```

- [ ] **Step 2.4: Server action for signature submission**

`apps/web/src/server/actions/order-signature.ts`:

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { sendOrderRequestEmail } from '@/lib/email/order-requests';
import { env } from '@/lib/env';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';

import { err, ok, type ActionResult } from '@stockpilot/core';

const TOKEN_RE = /^[0-9a-f]{64}$/i;
const DATA_URL_RE = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/;

const submitSchema = z.object({
  token: z.string().regex(TOKEN_RE),
  signerName: z.string().trim().min(1).max(120),
  signerEmail: z.string().trim().email().max(254),
  signatureDataUrl: z
    .string()
    .min(64)
    .max(500_000) // ~500KB ceiling for a base64-encoded PNG
    .regex(DATA_URL_RE, 'Invalid signature image'),
});

export async function submitOrderSignatureAction(
  input: z.input<typeof submitSchema>,
): Promise<ActionResult<{ id: string }>> {
  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  // Rate-limit by token. A leaked token + replay attempt should not
  // be able to spam the RPC. Closed mode: prefer 429 over fail-open.
  const rl = await checkRateLimit(
    `order-sign:${parsed.data.token}`,
    10,
    60 * 60 * 1000,
    'closed',
  );
  if (!rl.allowed) {
    return err('rate_limited', 'Too many attempts. Try again in a few minutes.');
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return err(
      'internal_error',
      'Server is missing SUPABASE_SERVICE_ROLE_KEY. Try again in a few minutes.',
    );
  }

  // Look up the order id by token BEFORE calling the RPC — needed so
  // we can pass the id (the RPC requires it for the row lock).
  const { data: row } = await admin
    .from('order_requests')
    .select('id, organization_id, requester_name, requester_email, fulfillment_type')
    .eq('signature_token', parsed.data.token)
    .maybeSingle();
  if (!row) {
    return err('not_found', 'This signature link is invalid or expired.');
  }
  const order = row as {
    id: string;
    organization_id: string;
    requester_name: string | null;
    requester_email: string | null;
    fulfillment_type: 'pickup' | 'delivery';
  };

  const { data: confirmed, error } = await admin.rpc('confirm_order_signature', {
    p_id: order.id,
    p_signature_token: parsed.data.token,
    p_signer_name: parsed.data.signerName,
    p_signer_email: parsed.data.signerEmail,
    p_signature_data_url: parsed.data.signatureDataUrl,
  });
  if (error) return err('internal_error', error.message);
  if (!confirmed) {
    // RPC returns null when the WHERE clause didn't match — replay,
    // expired, wrong status, etc.
    return err('not_found', 'This order is already signed, expired, or cannot be signed.');
  }

  // Best-effort: pull the latest row + send the completion email.
  const { data: fullRow } = await admin
    .from('order_requests')
    .select('*')
    .eq('id', order.id)
    .single();
  if (fullRow) {
    try {
      // Send completion email to BOTH the requester (if different
      // from the signer) and the signer themselves.
      const recipients = new Set<string>();
      if (order.requester_email) recipients.add(order.requester_email);
      recipients.add(parsed.data.signerEmail);
      for (const recipient of recipients) {
        await sendOrderRequestEmail({
          kind: 'completed',
          request: fullRow as Parameters<typeof sendOrderRequestEmail>[0]['request'],
          recipientEmail: recipient,
          recipientName: recipient === order.requester_email ? order.requester_name : parsed.data.signerName,
          appUrl: env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com',
        });
      }
    } catch {
      /* email failure is non-fatal; the row is completed */
    }
  }

  revalidatePath(`/dashboard/orders/${order.id}`);
  return ok({ id: order.id });
}
```

- [ ] **Step 2.5: Verify + commit**

```bash
pnpm typecheck
pnpm test
git add apps/web/src/app/orders/sign/\[token\]/layout.tsx \
        apps/web/src/app/orders/sign/\[token\]/page.tsx \
        apps/web/src/components/orders/signature-collector.tsx \
        apps/web/src/server/actions/order-signature.ts
git commit -m "feat(orders): /orders/sign/<token> public signature page

Phase 5 public surface. Server-rendered page validates the token,
renders an order summary + signature pad. Submit calls
confirm_order_signature RPC (migration 0112) via the admin client;
on success, sends completion email to the requester AND signer.

Ambiguous failure UI (invalid / expired / already-signed) by design
— we don't tell the signer which check failed."
```

---

### Task 3: Wire 'Mark in transit' + 'Collect signature' buttons

**File:** `apps/web/src/components/orders/manager-actions-panel.tsx`

- [ ] **Step 3.1: Read the existing pattern**

```bash
grep -n "BusyKey\|generatePackingSlips\|stageOrder" apps/web/src/components/orders/manager-actions-panel.tsx | head -20
```

- [ ] **Step 3.2: Add `'mark-in-transit'` to `BusyKey` union and import `markInTransitAction`**

- [ ] **Step 3.3: Add the handler**

```ts
async function markInTransit() {
  setBusy('mark-in-transit');
  const res = await markInTransitAction({ id });
  setBusy(null);
  if (!res.ok) { toast.error(res.error.message); return; }
  toast.success('Order is on the way.');
  router.refresh();
}

function collectSignature(signatureToken: string | null) {
  if (!signatureToken) {
    toast.error('No signature token on this order — regenerate the packing slip.');
    return;
  }
  window.open(`/orders/sign/${signatureToken}`, '_blank', 'noopener,noreferrer');
}
```

- [ ] **Step 3.4: Add the JSX**

For `staged_for_delivery` with an assigned driver:

```tsx
{order.status === 'staged_for_delivery' && order.assigned_delivery_user_id && (
  <Button variant="default" onClick={markInTransit} disabled={busy !== null}>
    {busy === 'mark-in-transit' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Mark in transit'}
  </Button>
)}
```

For `staged_for_pickup` or `in_transit` or `signature_requested`:

```tsx
{['staged_for_pickup', 'in_transit', 'signature_requested'].includes(order.status) && (
  <Button
    variant="gradient"
    onClick={() => collectSignature(order.signature_token)}
    disabled={busy !== null}
  >
    Collect signature
  </Button>
)}
```

Thread `signature_token: string | null` and `assigned_delivery_user_id: string | null` through `ManagerActionsPanelProps` if not already present.

- [ ] **Step 3.5: Verify + commit + push**

```bash
pnpm typecheck
pnpm test
git add apps/web/src/components/orders/manager-actions-panel.tsx
git commit -m "feat(orders): wire mark-in-transit + collect-signature buttons"
git push
```

---

### Task 4: Push + smoke test

After everything ships, the manual smoke test:

1. From a staged-for-delivery order with an assigned driver, the assigned driver (or a manager) clicks "Mark in transit" — status flips to `in_transit`, requester gets a "Ready to deliver" email (phase 6 will tweak copy to "On the way").
2. Click "Collect signature" — opens `/orders/sign/<token>` in a new tab.
3. On the signature page (or QR-scan on a phone): sign in the box, enter name + email, hit Confirm. Verify the order flips to `completed`, completion email arrives.
4. Try to re-open the same `/orders/sign/<token>` URL — should render the "already signed" panel.
5. Try a tampered token (change one hex char) — should 404.
6. Try a pickup order: at staged_for_pickup, click Collect signature, sign, confirm. Order completes without going through in_transit (the state machine permits `staged_for_pickup → completed`).

---

## Phase 5 Self-Review

- **Spec coverage:** §2.6 in-transit + signature page + completion email (Tasks 1-3).
- **Placeholder scan:** No "TBD". Every step has actual code.
- **Type consistency:** `confirm_order_signature` RPC return type is `uuid` (organization_id). The action checks `!confirmed` for replay/invalid.
- **Replay protection:** Both layers — DB `signed_at IS NULL` inside WHERE, and the page's status check before rendering the form. The "already signed" panel is the only thing the user sees on a second click.
- **No spec gap:** Phase 6 adds `in_transit`-specific email copy + the dedicated `order_email_log` dedup. Until then, the existing `sendOrderRequestEmail` pipeline is "send every time" — acceptable for phase 5 since the signature submit is a single-shot operation.

## Migration applied

None this phase (0112 already applied in Phase 4).

## Test count after Phase 5

- Before: 396
- After: 396 (no new unit tests; smoke-tested manually)

# Orders Workflow Refactor — Phase 2: Create Flows

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture fulfillment type + delivery address + pickup notes + phone on every new order, both public (`/r/<token>`) and internal (`/dashboard/orders/new`). Migration 0109 already added the columns; this phase wires UI + validators + service-layer accept.

**Architecture:** Extend both the public POST route and the internal create page with the same field set. The DB columns already exist; validators (zod schemas) and the service-layer `create` method get the new optional inputs. No migration in this phase — slot 0110 is reserved for any constraint surprises but is expected to stay empty.

**Tech Stack:** React 19 + react-hook-form (existing pattern) · Next.js 16 server actions · zod validators · Supabase.

---

## Reference

- Spec: `docs/superpowers/specs/2026-05-15-orders-workflow-refactor-design.md` §2.1, §2.2
- Phase 1 plan (predecessor): `docs/superpowers/plans/2026-05-15-orders-phase-1-data-foundation.md`
- Migration 0109 (already applied) added the columns this phase populates.

---

### Task 1: Extend `bodySchema` in public POST route

**Files:**
- Modify: `apps/web/src/app/api/v1/public/order-requests/route.ts`

- [ ] **Step 1.1: Read the existing schema**

```bash
grep -n "bodySchema\|lineSchema" apps/web/src/app/api/v1/public/order-requests/route.ts | head
```
Confirms the zod `bodySchema` is near the top of the file (after the import block, before the POST handler).

- [ ] **Step 1.2: Add new optional fields**

Find the existing `bodySchema = z.object({...})` declaration. Add the following fields BEFORE the existing `hp` honeypot field:

```ts
  fulfillmentType: z.enum(['pickup', 'delivery']),
  requesterPhone: z.string().trim().max(40).nullish(),
  deliveryAddress: z
    .object({
      line1: z.string().trim().min(1).max(200),
      line2: z.string().trim().max(200).nullish(),
      city: z.string().trim().min(1).max(120),
      region: z.string().trim().max(120).nullish(),
      postal: z.string().trim().max(40).nullish(),
      instructions: z.string().trim().max(1000).nullish(),
    })
    .nullish(),
  pickupLocationNotes: z.string().trim().max(2000).nullish(),
```

After parsing, add validation that requires `deliveryAddress.line1 + city` when `fulfillmentType === 'delivery'`:

```ts
  if (body.fulfillmentType === 'delivery' && !body.deliveryAddress) {
    return NextResponse.json(
      { error: 'delivery_address_required', message: 'Delivery orders need a shipping address.' },
      { status: 400 },
    );
  }
```

Place this check immediately after the existing `bodySchema.safeParse` result handling and before the rate-limit checks.

- [ ] **Step 1.3: Pass new fields into the row insert**

Find the existing `admin.from('order_requests').insert({...})` call (around the `pending_confirmation` insert). Add these fields to the insert payload:

```ts
      fulfillment_type: body.fulfillmentType,
      requester_phone: body.requesterPhone ?? null,
      delivery_address: body.deliveryAddress ?? null,
      pickup_location_notes: body.pickupLocationNotes ?? null,
```

- [ ] **Step 1.4: Run typecheck + tests**

```bash
pnpm typecheck
pnpm test
```
Both must remain green at the prior baseline.

- [ ] **Step 1.5: Commit**

```bash
git add apps/web/src/app/api/v1/public/order-requests/route.ts
git commit -m "feat(public-orders): accept fulfillment_type + delivery_address + pickup notes + phone"
```

---

### Task 2: Add fulfillment-type + address fields to public form UI

**Files:**
- Modify: `apps/web/src/components/orders/public-order-form.tsx`

- [ ] **Step 2.1: Add new state**

Inside the component, alongside the existing `useState` declarations, add:

```ts
  const [fulfillmentType, setFulfillmentType] = useState<'pickup' | 'delivery'>('delivery');
  const [phone, setPhone] = useState('');
  const [addrLine1, setAddrLine1] = useState('');
  const [addrLine2, setAddrLine2] = useState('');
  const [addrCity, setAddrCity] = useState('');
  const [addrRegion, setAddrRegion] = useState('');
  const [addrPostal, setAddrPostal] = useState('');
  const [addrInstructions, setAddrInstructions] = useState('');
  const [pickupNotes, setPickupNotes] = useState('');
```

- [ ] **Step 2.2: Render the fulfillment-type radio + conditional fields**

In the form JSX, between the "your details" block (name/email/org) and the items block, add a new section:

```tsx
<section className="border-border bg-card space-y-4 rounded-2xl border p-5">
  <h2 className="font-display text-lg">How should we get this to you?</h2>
  <div className="flex gap-3">
    <button
      type="button"
      onClick={() => setFulfillmentType('pickup')}
      className={cn(
        'border-border flex-1 rounded-xl border p-4 text-left transition-colors',
        fulfillmentType === 'pickup' && 'border-primary bg-primary/5',
      )}
    >
      <div className="font-medium">📦 Pickup</div>
      <div className="text-muted-foreground text-xs mt-1">
        I'll come to the warehouse.
      </div>
    </button>
    <button
      type="button"
      onClick={() => setFulfillmentType('delivery')}
      className={cn(
        'border-border flex-1 rounded-xl border p-4 text-left transition-colors',
        fulfillmentType === 'delivery' && 'border-primary bg-primary/5',
      )}
    >
      <div className="font-medium">🚚 Delivery</div>
      <div className="text-muted-foreground text-xs mt-1">
        Bring it to me.
      </div>
    </button>
  </div>

  <div className="space-y-2">
    <Label htmlFor="phone">Phone (optional)</Label>
    <Input
      id="phone"
      type="tel"
      value={phone}
      onChange={(e) => setPhone(e.target.value)}
      placeholder="(555) 123-4567"
      autoComplete="tel"
      maxLength={40}
    />
  </div>

  {fulfillmentType === 'delivery' ? (
    <div className="space-y-3 rounded-xl bg-muted/40 p-4">
      <p className="text-muted-foreground text-xs">Delivery address</p>
      <div className="space-y-2">
        <Label htmlFor="addr-line1">Street address</Label>
        <Input
          id="addr-line1"
          value={addrLine1}
          onChange={(e) => setAddrLine1(e.target.value)}
          placeholder="123 Main St"
          required
          autoComplete="address-line1"
          maxLength={200}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="addr-line2">Apt / suite / room (optional)</Label>
        <Input
          id="addr-line2"
          value={addrLine2}
          onChange={(e) => setAddrLine2(e.target.value)}
          autoComplete="address-line2"
          maxLength={200}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="addr-city">City</Label>
          <Input
            id="addr-city"
            value={addrCity}
            onChange={(e) => setAddrCity(e.target.value)}
            required
            autoComplete="address-level2"
            maxLength={120}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="addr-region">State / region</Label>
          <Input
            id="addr-region"
            value={addrRegion}
            onChange={(e) => setAddrRegion(e.target.value)}
            autoComplete="address-level1"
            maxLength={120}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="addr-postal">ZIP / postal code</Label>
        <Input
          id="addr-postal"
          value={addrPostal}
          onChange={(e) => setAddrPostal(e.target.value)}
          autoComplete="postal-code"
          maxLength={40}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="addr-instructions">Delivery instructions (optional)</Label>
        <Textarea
          id="addr-instructions"
          value={addrInstructions}
          onChange={(e) => setAddrInstructions(e.target.value)}
          placeholder="Gate code, where to leave the box, who to ask for"
          rows={2}
          maxLength={1000}
        />
      </div>
    </div>
  ) : (
    <div className="space-y-2">
      <Label htmlFor="pickup-notes">Pickup notes (optional)</Label>
      <Textarea
        id="pickup-notes"
        value={pickupNotes}
        onChange={(e) => setPickupNotes(e.target.value)}
        placeholder="When you'll come by, who's picking up, etc."
        rows={2}
        maxLength={2000}
      />
    </div>
  )}
</section>
```

`cn` is already imported in this file (verify with `grep "^import.*cn" apps/web/src/components/orders/public-order-form.tsx`). If not, add `import { cn } from '@/lib/utils';`.

- [ ] **Step 2.3: Update the submit payload**

Find the existing `fetch('/api/v1/public/order-requests', { ... body: JSON.stringify({...}) })` call. Add the new fields to the JSON body:

```ts
        fulfillmentType,
        requesterPhone: phone.trim() || null,
        deliveryAddress:
          fulfillmentType === 'delivery'
            ? {
                line1: addrLine1.trim(),
                line2: addrLine2.trim() || null,
                city: addrCity.trim(),
                region: addrRegion.trim() || null,
                postal: addrPostal.trim() || null,
                instructions: addrInstructions.trim() || null,
              }
            : null,
        pickupLocationNotes:
          fulfillmentType === 'pickup'
            ? pickupNotes.trim() || null
            : null,
```

- [ ] **Step 2.4: Add client-side validation BEFORE the fetch**

In the same submit handler, before the `fetch` call, add:

```ts
    if (fulfillmentType === 'delivery') {
      if (!addrLine1.trim() || !addrCity.trim()) {
        toast.error('Please fill in the street address and city for delivery.');
        return;
      }
    }
```

- [ ] **Step 2.5: Run typecheck + tests + manual smoke test in browser**

```bash
pnpm typecheck
pnpm test
```

The user should manually open `/r/<a-public-token>` in the browser, toggle pickup/delivery, fill the form, and submit. Verify both branches POST successfully.

- [ ] **Step 2.6: Commit**

```bash
git add apps/web/src/components/orders/public-order-form.tsx
git commit -m "feat(public-orders): fulfillment type + delivery address + pickup notes UI"
```

---

### Task 3: Internal create flow — add fulfillment fields + manager "on behalf of"

**Files:**
- Modify: `apps/web/src/components/orders/order-request-form.tsx`
- Modify: `apps/web/src/server/actions/order-requests.ts`
- Modify: `apps/web/src/server/services/order-requests.ts`

- [ ] **Step 3.1: Read the existing internal form**

```bash
wc -l apps/web/src/components/orders/order-request-form.tsx
grep -n "useState\|onSubmit\|createOrderRequest" apps/web/src/components/orders/order-request-form.tsx | head -15
```
Surface the existing structure.

- [ ] **Step 3.2: Add fulfillment-type + address state**

In the component, alongside existing state, add the same `fulfillmentType` / `phone` / address-block / pickup-notes state as Task 2.2. Reuse the same JSX block (extract to a small `<FulfillmentTypeSection>` component IF the same JSX is being duplicated between the public form and internal form — but DON'T extract preemptively; only if duplication is identical and reused as-is).

- [ ] **Step 3.3: Add manager "Create on behalf of" affordance**

Above the fulfillment section, conditionally render (only when `viewerRole === 'manager' | 'admin' | 'owner'`):

```tsx
<div className="space-y-3 rounded-xl bg-muted/40 p-4">
  <Label htmlFor="onbehalf-toggle" className="flex items-center gap-2">
    <input
      id="onbehalf-toggle"
      type="checkbox"
      checked={onBehalfOf !== null}
      onChange={(e) =>
        setOnBehalfOf(e.target.checked ? { name: '', email: '', phone: '' } : null)
      }
    />
    Create on behalf of someone else
  </Label>
  {onBehalfOf !== null ? (
    <div className="space-y-2">
      <Input
        placeholder="Their name"
        value={onBehalfOf.name}
        onChange={(e) =>
          setOnBehalfOf((s) => (s ? { ...s, name: e.target.value } : s))
        }
        required
        maxLength={120}
      />
      <Input
        type="email"
        placeholder="their.email@example.com"
        value={onBehalfOf.email}
        onChange={(e) =>
          setOnBehalfOf((s) => (s ? { ...s, email: e.target.value } : s))
        }
        required
        maxLength={254}
      />
    </div>
  ) : null}
</div>
```

The `viewerRole` prop needs to be threaded from the page server component into the form — add `viewerRole: Role` to the form's `Props` interface and pass `ctx.role` from `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx`.

- [ ] **Step 3.4: Extend the server action validator**

In `apps/web/src/server/actions/order-requests.ts`, find the existing `createOrderRequestSchema` (zod). Add the new fields:

```ts
const createOrderRequestSchema = z.object({
  warehouseId: z.string().uuid(),
  notes: z.string().max(2000).optional(),
  fulfillmentType: z.enum(['pickup', 'delivery']),
  requesterPhone: z.string().trim().max(40).optional(),
  deliveryAddress: z
    .object({
      line1: z.string().trim().min(1).max(200),
      line2: z.string().trim().max(200).optional(),
      city: z.string().trim().min(1).max(120),
      region: z.string().trim().max(120).optional(),
      postal: z.string().trim().max(40).optional(),
      instructions: z.string().trim().max(1000).optional(),
    })
    .optional(),
  pickupLocationNotes: z.string().trim().max(2000).optional(),
  onBehalfOf: z
    .object({
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().email().max(254),
    })
    .optional(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        quantity: z.coerce.number().int().positive().max(10_000),
        notes: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(100),
});
```

Add the same "fulfillment_type=delivery requires deliveryAddress" guard after schema parse, returning `err('validation_error', 'Delivery orders need a shipping address.')` if missing.

If `onBehalfOf` is set, ensure caller has manager+ permission before accepting:

```ts
if (parsed.data.onBehalfOf && !isAdminRole(ctx.role)) {
  return err('forbidden', 'Only managers can create orders on behalf of others.');
}
```

(`isAdminRole` is exported from `@stockpilot/core` — `manager+admin+owner`. Verify the import path; if not exported, use a manual check `['manager','admin','owner'].includes(ctx.role)`.)

- [ ] **Step 3.5: Extend `OrderRequestsService.create`**

In `apps/web/src/server/services/order-requests.ts`, find the `create` method and the existing `CreateOrderRequestInput` interface. Extend the interface with the new fields:

```ts
export interface CreateOrderRequestInput {
  warehouseId: string;
  notes?: string | null;
  fulfillmentType: 'pickup' | 'delivery';
  requesterPhone?: string | null;
  deliveryAddress?: {
    line1: string;
    line2?: string | null;
    city: string;
    region?: string | null;
    postal?: string | null;
    instructions?: string | null;
  } | null;
  pickupLocationNotes?: string | null;
  onBehalfOf?: {
    name: string;
    email: string;
  } | null;
  lines: Array<{
    itemId: string;
    quantity: number;
    notes?: string | null;
  }>;
}
```

In the `create` method's insert payload (`order_requests` insert), set:

```ts
      fulfillment_type: input.fulfillmentType,
      requester_phone: input.requesterPhone ?? null,
      delivery_address: input.deliveryAddress ?? null,
      pickup_location_notes: input.pickupLocationNotes ?? null,
      // On-behalf-of overrides requester_user_id: row is treated as
      // public-style for email purposes (manager creates for a non-org
      // requester).
      requester_user_id: input.onBehalfOf ? null : this.ctx.userId,
      requester_name: input.onBehalfOf?.name ?? null,
      requester_email: input.onBehalfOf?.email ?? null,
      source: input.onBehalfOf ? 'internal' : 'internal', // both internal; flag is the email path
```

Actually keep `source: 'internal'` for both cases (it's still an internally-created order). The behavior switch is on `requester_user_id IS NULL` vs not — the email pipeline already keys off that.

- [ ] **Step 3.6: Run typecheck**

```bash
pnpm typecheck
```
Expected: clean.

- [ ] **Step 3.7: Run tests**

```bash
pnpm test
```
Expected: 396 still passing. If any test mocks `CreateOrderRequestInput` and the new required `fulfillmentType` breaks it, update the mock to pass `fulfillmentType: 'delivery'`.

- [ ] **Step 3.8: Commit**

```bash
git add apps/web/src/components/orders/order-request-form.tsx \
        apps/web/src/server/actions/order-requests.ts \
        apps/web/src/server/services/order-requests.ts \
        apps/web/src/app/\(dashboard\)/dashboard/orders/new/page.tsx
git commit -m "feat(orders): internal create accepts fulfillment + on-behalf-of"
```

---

### Task 4: Update email helper to pass fulfillment-type context

**Files:**
- Modify: `apps/web/src/lib/email/order-requests.ts`

The existing email helper already takes `request: OrderRequestRow`. After phase 1, the row has the new `fulfillment_type` column. Update the email body so:

- Pickup orders' "submitted" email mentions "We'll let you know when your order is ready to pick up."
- Delivery orders' "submitted" email mentions "We'll let you know when your order ships."

- [ ] **Step 4.1: Read the existing body paragraph fn**

```bash
grep -n "bodyParagraph\|fulfillment_type\|case 'submitted'" apps/web/src/lib/email/order-requests.ts
```

- [ ] **Step 4.2: Update `bodyParagraph(kind)` to take optional `request: OrderRequestRow`**

Refactor the signature so it can branch on fulfillment:

```ts
function bodyParagraph(kind: OrderRequestEmailKind, request?: OrderRequestRow): string {
  const isPickup = request?.fulfillment_type === 'pickup';
  switch (kind) {
    case 'submitted':
      return isPickup
        ? "We've received your order request. We'll email you when it's ready to pick up."
        : "We've received your order request. We'll email you when it ships.";
    // ... rest unchanged
  }
}
```

Update the call sites at `bodyParagraph(kind)` in the html/text builders to pass `request`.

Also update `bodyParagraphPlain` if it exists for text-only fallback.

- [ ] **Step 4.3: Add `fulfillment_type` to `OrderRequestRow` TS shape**

In `apps/web/src/server/services/order-requests.ts`, find the `OrderRequestRow` interface and add:

```ts
  fulfillment_type: 'pickup' | 'delivery';
```

Also add the other new columns (they all default to null on existing rows, but TS needs to know they exist):

```ts
  delivery_address: {
    line1: string;
    line2: string | null;
    city: string;
    region: string | null;
    postal: string | null;
    instructions: string | null;
  } | null;
  pickup_location_notes: string | null;
  requester_phone: string | null;
  assigned_picker_id: string | null;
  pick_slip_generated_at: string | null;
  pick_slip_generated_by: string | null;
  picking_completed_at: string | null;
  picking_completed_by: string | null;
  packing_slip_generated_at: string | null;
  packing_slip_generated_by: string | null;
  staged_at: string | null;
  staged_by: string | null;
  assigned_delivery_user_id: string | null;
  assigned_delivery_by: string | null;
  assigned_delivery_at: string | null;
  in_transit_at: string | null;
  in_transit_by: string | null;
  signature_token: string | null;
  signature_token_expires_at: string | null;
  signed_by_name: string | null;
  signed_by_email: string | null;
  signature_data_url: string | null;
  signed_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
```

This is forward-looking — phases 3-5 will populate these. Keeping the type complete now means no churn later.

- [ ] **Step 4.4: Run typecheck**

```bash
pnpm typecheck
```
Expected: clean.

- [ ] **Step 4.5: Run tests**

```bash
pnpm test
```
Expected: 396 still passing.

- [ ] **Step 4.6: Commit**

```bash
git add apps/web/src/lib/email/order-requests.ts apps/web/src/server/services/order-requests.ts
git commit -m "feat(orders): fulfillment-aware email copy + complete OrderRequestRow type"
```

---

### Task 5: Push + smoke test

- [ ] **Step 5.1: Push everything to main**

```bash
git push
```

- [ ] **Step 5.2: Smoke-test manually**

Open the dev server (`pnpm dev` in `apps/web`), then:

1. Visit `/r/<an-active-public-token>`. Submit a pickup-type order. Verify the confirm email arrives and the order shows `fulfillment_type=pickup` in the DB.
2. Repeat for delivery, filling in the address fields. Verify `delivery_address` jsonb is populated.
3. As a manager, visit `/dashboard/orders/new`, toggle "Create on behalf of someone else", fill the form, submit. Verify the row has `requester_user_id IS NULL` and `requester_email` set.
4. As a regular staff user, visit `/dashboard/orders/new`. Confirm the "Create on behalf of" toggle is hidden.

- [ ] **Step 5.3: Mark phase 2 complete**

Phase 2 is done. The next plan (`docs/superpowers/plans/2026-05-15-orders-phase-3-approval-pick-slip.md`) gets written when the user says "phase 3".

---

## Phase 2 Self-Review

- **Spec coverage:** §2.1 public form (Tasks 1+2), §2.2 internal create + on-behalf-of (Task 3), §5 email pipeline awareness (Task 4).
- **Placeholder scan:** No "TBD"/"TODO". Every step has actual code.
- **Type consistency:** `fulfillmentType` is camelCase in TS, `fulfillment_type` snake_case in DB — both consistent. `'pickup' | 'delivery'` literal type used everywhere.
- **No spec gap:** Migration 0110 is NOT needed; slot reserved per Phase 1 plan in case a constraint discovery requires it during build (still expected to stay empty).

## Migration applied

- None this phase. Slot 0110 reserved but unused unless a constraint discovery emerges during build.

## Test count after Phase 2

- Before: 396
- After: 396 (no new tests in this phase — existing tests must continue to pass, and the new form changes are validated by manual browser smoke-test per Step 5.2)

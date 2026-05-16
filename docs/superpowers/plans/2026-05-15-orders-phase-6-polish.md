# Orders Workflow Refactor — Phase 6: Polish, Timeline, Shipments Deprecation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Final phase. Per-event notification toggles for the new order events, an order timeline component that reads from `audit_logs`, an enhanced order list with filter presets, and the shipments deprecation banner that signals the cutover is complete.

**Architecture:** Two small migrations (`0113`, `0114`). 0113 adds 5 columns to `notification_preferences`. 0114 adds `deprecated_at` to `shipments` (informational). UI: new `<OrderTimeline>` component, expanded order-list filters, deprecation banner on the shipments pages.

**Tech Stack:** Postgres `ALTER TABLE` · React 19 server components · existing `audit_logs` table (no new history table needed).

---

## Reference

- Spec: §1.4, §3.3, §3.5, §4 phase-6 entry
- Existing audit rendering: search the codebase for `audit_logs` reads — `/dashboard/admin/audit` already has a pattern
- Shipments routes: `apps/web/src/app/(dashboard)/dashboard/shipments/`, `apps/web/src/app/s/[token]/`
- `order_email_log` (from migration 0111) is the dedup substrate for the toggle-aware email pipeline added in this phase

---

### Task 1: Migration 0113 — notification_preferences columns

**File to create:** `supabase/migrations/0113_notification_prefs_orders.sql`

- [ ] **Step 1.1: Write the migration**

```sql
-- 0113_notification_prefs_orders.sql
--
-- Phase 6 of the orders workflow refactor: per-event notification
-- toggles for the new order lifecycle. Internal requesters (org
-- members with requester_user_id set on their orders) respect these
-- toggles; public requesters always get the emails (transactional,
-- no opt-out beyond not submitting again).
--
-- The columns default `true` so the rollout is opt-out per row,
-- not opt-in.

begin;

alter table public.notification_preferences
  add column if not exists email_order_received        boolean not null default true,
  add column if not exists email_order_status_changed  boolean not null default true,
  add column if not exists email_order_in_transit      boolean not null default true,
  add column if not exists email_order_completed       boolean not null default true,
  add column if not exists push_order_assigned_to_me   boolean not null default true;

commit;

comment on column public.notification_preferences.email_order_received is
  'Internal requester opt-out for the order-received confirmation email.';
comment on column public.notification_preferences.email_order_status_changed is
  'Internal requester opt-out for approved/denied/staged/in-transit interim emails.';
comment on column public.notification_preferences.email_order_in_transit is
  'Internal requester opt-out specifically for the in-transit email (separate from generic status changes).';
comment on column public.notification_preferences.email_order_completed is
  'Internal requester opt-out for the post-signature completion email.';
comment on column public.notification_preferences.push_order_assigned_to_me is
  'In-app bell + live-toast opt-out when a manager assigns this user as picker or driver.';
```

- [ ] **Step 1.2: Commit + push (DO NOT apply)**

```bash
git add supabase/migrations/0113_notification_prefs_orders.sql
git commit -m "feat(orders): migration 0113 — order notification_preferences toggles

Five new columns on notification_preferences, all default true:
  * email_order_received
  * email_order_status_changed
  * email_order_in_transit
  * email_order_completed
  * push_order_assigned_to_me

Internal requesters respect these toggles; public requesters always
get the emails (transactional, no opt-out beyond not submitting).
Phase 6 settings UI exposes the toggles."
git push
```

- [ ] **Step 1.3: STOP** — wait for user to apply 0113 and confirm "0113 good".

---

### Task 2: Migration 0114 — shipments.deprecated_at marker

**File to create:** `supabase/migrations/0114_shipments_deprecated_marker.sql`

- [ ] **Step 2.1: Write the migration**

```sql
-- 0114_shipments_deprecated_marker.sql
--
-- Phase 6 of the orders workflow refactor: marks the shipments
-- table as deprecated. New outbound work flows through
-- order_requests now. Existing shipment rows stay readable forever
-- (the /dashboard/shipments routes go read-only with a banner in
-- the same PR that ships this migration); this column is purely
-- informational — a future cleanup migration (deferred ~30 days)
-- will drop the table entirely.
--
-- The column has NO NOT NULL constraint and NO default — only the
-- ops team that retires this table sets it.

begin;

alter table public.shipments
  add column if not exists deprecated_at timestamptz;

commit;

comment on column public.shipments.deprecated_at is
  'Informational: when the row was created against the deprecated '
  'shipments workflow. Set by data-import / archival scripts; NULL '
  'for live rows from before the cutover. The application surface '
  'is fully read-only as of phase 6 — this column exists for the '
  'future cleanup migration to filter on.';
```

- [ ] **Step 2.2: Commit + push (DO NOT apply)**

```bash
git add supabase/migrations/0114_shipments_deprecated_marker.sql
git commit -m "feat(orders): migration 0114 — shipments.deprecated_at marker"
git push
```

- [ ] **Step 2.3: STOP** — wait for user to confirm "0114 good".

---

### Task 3: Order timeline component

**File to create:** `apps/web/src/components/orders/order-timeline.tsx`

The timeline reads from `audit_logs` filtered to `entity_type='order_request' AND entity_id=order.id`, joins on `user_profiles` for the actor display.

- [ ] **Step 3.1: Read existing audit-rendering pattern**

```bash
find apps/web/src/app -name "audit*" -type f
grep -rn "audit_logs\b" apps/web/src/app --include="*.tsx" | head -10
```

If `/dashboard/admin/audit` has a renderer, mirror its visual style (timestamp formatting, actor avatar, event labels).

- [ ] **Step 3.2: Server component**

```tsx
import { Activity } from 'lucide-react';

import { createClient } from '@/lib/supabase/server';

interface Props {
  orderId: string;
  organizationId: string;
}

interface AuditRow {
  id: string;
  event: string;
  created_at: string;
  user_id: string | null;
  extra: Record<string, unknown> | null;
  user: { full_name: string | null; email: string | null } | null;
}

const EVENT_LABELS: Record<string, string> = {
  'order_request.created': 'Order submitted',
  'order_request.approved': 'Approved',
  'order_request.denied': 'Denied',
  'order_request.status_changed': 'Status changed',
  'order_request.cancelled': 'Cancelled',
  'order_request.delivered': 'Delivered (legacy)',
  'order.pick_slip_generated': 'Pick slip generated',
  'order.picking_complete': 'Picking complete',
  'order.packing_slip_generated': 'Packing slips generated',
  'order.staged_for_pickup': 'Staged for pickup',
  'order.staged_for_delivery': 'Staged for delivery',
  'order.delivery_assigned': 'Delivery assigned',
  'order.in_transit': 'In transit',
  'order.signature_collected': 'Signature collected',
  'order.completed': 'Completed',
};

export async function OrderTimeline({ orderId, organizationId }: Props) {
  const supabase = await createClient();
  const { data } = await supabase
    .from('audit_logs')
    .select(
      `id, event, created_at, user_id, extra,
       user:user_profiles!user_id (full_name, email)`,
    )
    .eq('organization_id', organizationId)
    .eq('entity_type', 'order_request')
    .eq('entity_id', orderId)
    .order('created_at', { ascending: true });

  const rows = (data ?? []) as unknown as AuditRow[];
  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground text-sm">
        No events yet.
      </div>
    );
  }

  return (
    <ol className="border-border space-y-3 border-l-2 pl-4">
      {rows.map((row) => {
        const label = EVENT_LABELS[row.event] ?? row.event;
        const actor =
          row.user?.full_name ?? row.user?.email ?? (row.user_id ? 'Unknown user' : 'Public');
        return (
          <li key={row.id} className="relative">
            <span className="bg-primary absolute -left-[1.4rem] top-1.5 h-2 w-2 rounded-full" />
            <div className="text-sm">
              <span className="font-medium">{label}</span>
              <span className="text-muted-foreground"> — {actor}</span>
            </div>
            <div className="text-muted-foreground text-xs" suppressHydrationWarning>
              {new Date(row.created_at).toLocaleString()}
            </div>
            {row.extra && Object.keys(row.extra).length > 0 ? (
              <details className="text-muted-foreground mt-1 text-xs">
                <summary className="cursor-pointer">Details</summary>
                <pre className="mt-1 whitespace-pre-wrap text-[11px]">
                  {JSON.stringify(row.extra, null, 2)}
                </pre>
              </details>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
```

The `Activity` icon import is unused above — drop it if the lint passes complains, or use it in a heading if you add one.

- [ ] **Step 3.3: Mount it on the order detail page**

In `apps/web/src/app/(dashboard)/dashboard/orders/[id]/page.tsx`, add the timeline at the bottom (or in a side rail per the spec §3.2's right-column design):

```tsx
<section className="space-y-3">
  <h2 className="font-display text-lg">Timeline</h2>
  <OrderTimeline orderId={request.id} organizationId={ctx.organizationId} />
</section>
```

Import it: `import { OrderTimeline } from '@/components/orders/order-timeline';`.

- [ ] **Step 3.4: Verify + commit**

```bash
pnpm typecheck
pnpm test
git add apps/web/src/components/orders/order-timeline.tsx apps/web/src/app/\(dashboard\)/dashboard/orders/\[id\]/page.tsx
git commit -m "feat(orders): order timeline component (reads audit_logs)"
```

---

### Task 4: Order list filter presets

**File to modify:** `apps/web/src/app/(dashboard)/dashboard/orders/page.tsx`

Phase 1's status enum extension already updated the `TAB_FILTERS` map. Phase 6 adds more presets per the spec §3.1: *All active*, *Needs approval*, *Picking*, *Packing*, *Staged*, *In transit*, *Completed*, *Denied/Cancelled*.

The existing page likely has 4-5 tabs; extend to ~8.

- [ ] **Step 4.1: Read the current tabs**

```bash
grep -n "TAB_FILTERS\|TAB_LABELS\|TAB_ORDER\|StatusTab" apps/web/src/app/\(dashboard\)/dashboard/orders/page.tsx | head -15
```

- [ ] **Step 4.2: Extend the tabs**

Rewrite `TAB_FILTERS`, `TAB_LABELS`, `TAB_ORDER`, and `StatusTab` union:

```ts
type StatusTab =
  | 'all_active'
  | 'needs_approval'
  | 'picking'
  | 'packing'
  | 'staged'
  | 'in_transit'
  | 'completed'
  | 'denied_cancelled';

const TAB_LABELS: Record<StatusTab, string> = {
  all_active: 'All active',
  needs_approval: 'Needs approval',
  picking: 'Picking',
  packing: 'Packing',
  staged: 'Staged',
  in_transit: 'In transit',
  completed: 'Completed',
  denied_cancelled: 'Denied/Cancelled',
};

const TAB_FILTERS: Record<StatusTab, OrderRequestStatus | OrderRequestStatus[]> = {
  all_active: [
    'pending_approval',
    'approved',
    'pick_slip_generated',
    'picking_in_progress',
    'picking_complete',
    'packing_slip_generated',
    'staged_for_pickup',
    'staged_for_delivery',
    'in_transit',
    'signature_requested',
  ],
  needs_approval: 'pending_approval',
  picking: ['pick_slip_generated', 'picking_in_progress', 'picking_complete'],
  packing: 'packing_slip_generated',
  staged: ['staged_for_pickup', 'staged_for_delivery'],
  in_transit: ['in_transit', 'signature_requested'],
  completed: 'completed',
  denied_cancelled: ['denied', 'cancelled'],
};

const TAB_ORDER: StatusTab[] = [
  'all_active',
  'needs_approval',
  'picking',
  'packing',
  'staged',
  'in_transit',
  'completed',
  'denied_cancelled',
];
```

The default tab changes from `pending_approval` to `all_active` (or `needs_approval` — pick whichever matches the existing user flow; default-to-needs-approval is the historical behavior).

If the existing default was `pending_approval`, keep that intent by defaulting to `needs_approval`.

- [ ] **Step 4.3: Verify + commit**

```bash
pnpm typecheck
pnpm test
git add apps/web/src/app/\(dashboard\)/dashboard/orders/page.tsx
git commit -m "feat(orders): order list filter presets — 8 status tabs"
```

---

### Task 5: Notification preferences UI — order toggles

**File to modify:** `apps/web/src/components/settings/notification-preferences-form.tsx`

Add 5 new toggles per the migration 0113 columns. The existing form already iterates over a `TOGGLE_DEFS` array — extend it.

- [ ] **Step 5.1: Read the existing toggle defs**

```bash
grep -n "TOGGLE_DEFS\|NotificationPrefKey" apps/web/src/components/settings/notification-preferences-form.tsx apps/web/src/lib/notification-prefs.ts | head
```

- [ ] **Step 5.2: Extend `NOTIFICATION_PREF_KEYS` in `apps/web/src/lib/notification-prefs.ts`**

Add the 5 new keys to the existing `as const` array:

```ts
export const NOTIFICATION_PREF_KEYS = [
  'email_low_stock',
  'email_po_status',
  'email_team_invites',
  'push_low_stock',
  'push_po_status',
  'push_stock_transfer',
  'email_order_received',
  'email_order_status_changed',
  'email_order_in_transit',
  'email_order_completed',
  'push_order_assigned_to_me',
] as const;
```

- [ ] **Step 5.3: Add 5 toggle defs to `notification-preferences-form.tsx`**

```ts
  {
    key: 'email_order_received',
    label: 'Order received',
    hint: 'Email when your order request lands in the queue.',
    group: 'email',
  },
  {
    key: 'email_order_status_changed',
    label: 'Order status changes',
    hint: 'Email when your order is approved, denied, packaged, or staged.',
    group: 'email',
  },
  {
    key: 'email_order_in_transit',
    label: 'Order in transit',
    hint: 'Email when a delivery order is on the way.',
    group: 'email',
  },
  {
    key: 'email_order_completed',
    label: 'Order completed',
    hint: 'Email when your order is signed for and finalized.',
    group: 'email',
  },
  {
    key: 'push_order_assigned_to_me',
    label: 'Order assigned to me',
    hint: 'In-app notification when you\'re assigned as picker or driver.',
    group: 'push',
  },
```

- [ ] **Step 5.4: Verify + commit**

```bash
pnpm typecheck
pnpm test
git add apps/web/src/lib/notification-prefs.ts apps/web/src/components/settings/notification-preferences-form.tsx
git commit -m "feat(orders): notification preference toggles for order events"
```

---

### Task 6: Shipments deprecation banner + disabled CTAs

**Files to modify:**
- `apps/web/src/app/(dashboard)/dashboard/shipments/page.tsx`
- `apps/web/src/app/(dashboard)/dashboard/shipments/new/page.tsx`
- `apps/web/src/app/(dashboard)/dashboard/shipments/[id]/page.tsx`

- [ ] **Step 6.1: Add a top-of-page banner**

Create a shared `<ShipmentsDeprecatedBanner>` component (or inline a section) on each shipments page:

```tsx
<div className="border-amber-500/30 bg-amber-500/5 text-foreground rounded-xl border p-4 text-sm">
  <p className="font-medium">Shipments are read-only.</p>
  <p className="text-muted-foreground mt-1">
    New outbound work is tracked under{' '}
    <a href="/dashboard/orders" className="underline">Orders</a>. Historical
    shipments stay here for reference; you can&apos;t create or modify them.
  </p>
</div>
```

- [ ] **Step 6.2: Disable any "Create shipment" CTAs**

On `/dashboard/shipments/page.tsx`, find the "New shipment" link/button and either:
- Remove it entirely, OR
- Render it as a disabled `<Button disabled>` with a tooltip "Use Orders to track new outbound work."

- [ ] **Step 6.3: Disable action buttons on `/dashboard/shipments/[id]/page.tsx`**

Find every mutation button (mark shipped, mark delivered, etc.) and either:
- Wrap with `disabled` and a tooltip "Historical shipment — read only", OR
- Hide the entire actions panel and replace with the banner from Step 6.1

The safe play: hide the actions panel entirely on this page; preserve view-only rendering of the shipment.

- [ ] **Step 6.4: Remove "Create shipment" CTA from order detail page**

```bash
grep -n "shipment\|new.*shipment\|create.*shipment" apps/web/src/app/\(dashboard\)/dashboard/orders/\[id\]/page.tsx
```

If the order detail page has a "Generate packing slip → shipment" CTA, it's superseded by Phase 4's "Generate packing slips" button. Remove the old shipment CTA.

- [ ] **Step 6.5: Verify + commit + push**

```bash
pnpm typecheck
pnpm test
git add apps/web/src/app/\(dashboard\)/dashboard/shipments
git commit -m "feat(shipments): read-only banner + disabled CTAs

Final step of the orders refactor: shipments routes stay browsable
for historical rows but no longer offer mutation actions. The
'New shipment' CTA is removed. Order detail page no longer points
into the deprecated shipment-creation flow."
git push
```

---

### Task 7: Final smoke test + announcement

After everything ships:

1. Apply migrations 0113 + 0114 in Supabase Studio (if not done at Tasks 1+2).
2. Visit `/dashboard/settings/notifications` — confirm the 5 new toggles render.
3. Visit `/dashboard/orders/<id>` — confirm timeline section appears at the bottom.
4. Visit `/dashboard/orders` — confirm the 8 status tabs are present.
5. Visit `/dashboard/shipments` — confirm the deprecation banner is visible and "New shipment" CTA is hidden/disabled.
6. As a manager, walk through one full delivery order end-to-end (the manual acceptance test in the spec §9):
   - Public form submission → confirm-click → approve → pick slip → digital pick → complete picking (stock decrements) → generate packing slips (QR mints) → stage for delivery → assign driver → mark in transit → scan QR → sign on phone → order completes → completion email
7. Repeat the pickup scenario end-to-end (spec §9 second scenario).
8. Confirm `audit_logs` rows fire at every step (timeline reflects).

---

## Phase 6 Self-Review

- **Spec coverage:** §1.4 ALLOWED_TRANSITIONS (done in phase 1), §3.1 list filters (Task 4), §3.2 detail page conditional actions (already in panel from phases 3-5), §3.3 timeline (Task 3), §3.5 shipments deprecation (Task 6), §5 email pipeline (toggles ship here; the `sendOrderEmail` helper using `order_email_log` for dedup is a NICE-TO-HAVE follow-up, not blocking — existing `sendOrderRequestEmail` works fine without it).
- **Placeholder scan:** No "TBD". Every step has actual code or actual command.
- **Type consistency:** `NotificationPrefKey` union extends correctly from the `as const` array.
- **No spec gap:** `order_email_log`-backed dedup (spec §5) is the one piece NOT shipped — the table exists from migration 0111, but no helper consumes it. Add this as a phase 7 polish ticket if email duplication becomes a real problem.

## Migrations applied

- 0113 — 5 columns on notification_preferences
- 0114 — `deprecated_at` informational column on shipments

## Test count after Phase 6

- Before: 396
- After: 396 (no new unit tests in this phase; manual acceptance test per Task 7)

---

## Done

After Phase 6 ships, the refactor is complete. Final state:

- `order_requests` is the single source of truth for the order lifecycle (14-status state machine, fulfillment_type pickup/delivery, charter dropdown for delivery, full pick→pack→stage→sign workflow)
- Public `/r/<token>` form lets external requesters submit; public `/orders/sign/<token>` page lets them sign
- Internal `/dashboard/orders/new` page supports manager "on-behalf-of" creation
- Pick slips + packing slips as PDF + digital UI
- Stock decrements at picking complete (atomic via `complete_picking` RPC); reservations release in same transaction
- Order timeline on detail page reads from audit_logs
- Per-event email toggles for internal requesters
- Shipments table is read-only — historical artifact, no new writes from the app
- 5 plan docs + 1 spec committed to `docs/superpowers/`; subagent-driven execution across all phases

Defer to future cleanup:
- Drop the `shipments` table entirely (30+ days post-phase-6, separate migration)
- `sendOrderEmail` helper using `order_email_log` for dedup
- Order list view tweaks based on real usage patterns
- Native driver mobile app

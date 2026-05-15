# Orders Workflow Refactor — Phase 1: Data Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the schema changes, centralized state machine, audit-event types, and `orders:assign_delivery` permission needed for phases 2–6, with zero user-facing UI changes and zero breaking changes to the existing orders page.

**Architecture:** Extend `order_requests` (not rename) with every new column needed across the 6-phase rollout. Centralize the status state machine in `@stockpilot/core/order-state-machine.ts` and mirror the same transitions in the Postgres `_validate_order_request_status_transition` trigger. Data-rewrite the three legacy statuses (`packaging`, `ready_for_delivery`, `delivered`) inline in the migration.

**Tech Stack:** Postgres + Supabase migrations · TypeScript strict mode · Vitest · `pnpm` workspaces.

---

## Reference: spec doc

Read alongside `docs/superpowers/specs/2026-05-15-orders-workflow-refactor-design.md` sections 1 (data model) and 4 phase 1 entry.

---

### Task 1: Centralized state-machine module — types + transition table

**Files:**

- Create: `packages/core/src/order-state-machine.ts`
- Test: `packages/core/src/order-state-machine.test.ts`

- [ ] **Step 1.1: Write the failing test for `ALLOWED_TRANSITIONS`**

Create `packages/core/src/order-state-machine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_TRANSITIONS,
  type OrderStatus,
} from './order-state-machine';

describe('ALLOWED_TRANSITIONS', () => {
  it('covers every OrderStatus value as a key', () => {
    const statuses: OrderStatus[] = [
      'pending_confirmation',
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
      'completed',
      'denied',
      'cancelled',
    ];
    for (const s of statuses) {
      expect(ALLOWED_TRANSITIONS).toHaveProperty(s);
    }
  });

  it('terminal states have no outgoing transitions', () => {
    expect(ALLOWED_TRANSITIONS.denied).toEqual([]);
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
    expect(ALLOWED_TRANSITIONS.completed).toEqual([]);
  });

  it('approval branches to pick_slip_generated or cancelled', () => {
    expect(ALLOWED_TRANSITIONS.approved).toEqual(
      expect.arrayContaining(['pick_slip_generated', 'cancelled']),
    );
  });

  it('pending_approval can branch to approved, denied, or cancelled', () => {
    expect(ALLOWED_TRANSITIONS.pending_approval).toEqual(
      expect.arrayContaining(['approved', 'denied', 'cancelled']),
    );
  });

  it('packing_slip_generated can branch to either staging type', () => {
    expect(ALLOWED_TRANSITIONS.packing_slip_generated).toEqual(
      expect.arrayContaining(['staged_for_pickup', 'staged_for_delivery']),
    );
  });

  it('staged_for_delivery must go through in_transit before completion', () => {
    expect(ALLOWED_TRANSITIONS.staged_for_delivery).toContain('in_transit');
    expect(ALLOWED_TRANSITIONS.staged_for_delivery).not.toContain('completed');
  });

  it('staged_for_pickup can go straight to completed (no transit step)', () => {
    expect(ALLOWED_TRANSITIONS.staged_for_pickup).toEqual(
      expect.arrayContaining(['signature_requested', 'completed']),
    );
  });
});
```

- [ ] **Step 1.2: Run the test, expect a module-not-found failure**

Run: `pnpm --filter @stockpilot/core test -- order-state-machine`
Expected: FAIL — `Cannot find module './order-state-machine'`.

- [ ] **Step 1.3: Create the state-machine module with the transition table**

Create `packages/core/src/order-state-machine.ts`:

```ts
/**
 * Single source of truth for the order_requests status state machine.
 * The Postgres trigger `_validate_order_request_status_transition`
 * (migration 0109+) mirrors this exactly — any change here MUST be
 * reflected in the next migration's trigger body, or the DB will
 * reject a transition the TS layer accepts (or vice versa).
 */

export type OrderStatus =
  | 'pending_confirmation'
  | 'pending_approval'
  | 'approved'
  | 'pick_slip_generated'
  | 'picking_in_progress'
  | 'picking_complete'
  | 'packing_slip_generated'
  | 'staged_for_pickup'
  | 'staged_for_delivery'
  | 'in_transit'
  | 'signature_requested'
  | 'completed'
  | 'denied'
  | 'cancelled';

export type FulfillmentType = 'pickup' | 'delivery';

/**
 * Legal `from → to` transitions. Terminal states (`completed`,
 * `denied`, `cancelled`) have empty arrays — once entered, no path
 * out. Cancellation is permitted from every non-terminal status.
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_confirmation:   ['pending_approval', 'cancelled'],
  pending_approval:       ['approved', 'denied', 'cancelled'],
  approved:               ['pick_slip_generated', 'cancelled'],
  pick_slip_generated:    ['picking_in_progress', 'picking_complete', 'cancelled'],
  picking_in_progress:    ['picking_complete', 'cancelled'],
  picking_complete:       ['packing_slip_generated', 'cancelled'],
  packing_slip_generated: ['staged_for_pickup', 'staged_for_delivery', 'cancelled'],
  staged_for_pickup:      ['signature_requested', 'completed', 'cancelled'],
  staged_for_delivery:    ['in_transit', 'cancelled'],
  in_transit:             ['signature_requested', 'completed', 'cancelled'],
  signature_requested:    ['completed', 'cancelled'],
  denied:                 [],
  cancelled:              [],
  completed:              [],
};
```

- [ ] **Step 1.4: Run the test, expect PASS**

Run: `pnpm --filter @stockpilot/core test -- order-state-machine`
Expected: 7 tests passing.

- [ ] **Step 1.5: Commit**

```bash
git add packages/core/src/order-state-machine.ts packages/core/src/order-state-machine.test.ts
git commit -m "feat(core): introduce order state machine + ALLOWED_TRANSITIONS"
```

---

### Task 2: `assertTransition` helper with fulfillment-type guards

**Files:**

- Modify: `packages/core/src/order-state-machine.ts`
- Modify: `packages/core/src/order-state-machine.test.ts`

- [ ] **Step 2.1: Write the failing test**

Append to `packages/core/src/order-state-machine.test.ts`:

```ts
import { assertTransition, OrderTransitionError } from './order-state-machine';

describe('assertTransition', () => {
  const baseCtx = {
    fulfillmentType: 'delivery' as const,
    hasAssignedDelivery: false,
  };

  it('accepts a legal transition', () => {
    expect(() =>
      assertTransition('pending_approval', 'approved', baseCtx),
    ).not.toThrow();
  });

  it('rejects an illegal transition', () => {
    expect(() =>
      assertTransition('completed', 'pending_approval', baseCtx),
    ).toThrow(OrderTransitionError);
  });

  it('rejects same-status transitions as no-ops (throws with code=no_op)', () => {
    expect(() =>
      assertTransition('approved', 'approved', baseCtx),
    ).toThrow(/no_op/);
  });

  it('rejects staged_for_delivery on a pickup order', () => {
    expect(() =>
      assertTransition('packing_slip_generated', 'staged_for_delivery', {
        ...baseCtx,
        fulfillmentType: 'pickup',
      }),
    ).toThrow(/fulfillment_type/);
  });

  it('rejects staged_for_pickup on a delivery order', () => {
    expect(() =>
      assertTransition('packing_slip_generated', 'staged_for_pickup', {
        ...baseCtx,
        fulfillmentType: 'delivery',
      }),
    ).toThrow(/fulfillment_type/);
  });

  it('rejects in_transit when no delivery user is assigned', () => {
    expect(() =>
      assertTransition('staged_for_delivery', 'in_transit', {
        ...baseCtx,
        hasAssignedDelivery: false,
      }),
    ).toThrow(/assigned_delivery/);
  });

  it('accepts in_transit when delivery is assigned', () => {
    expect(() =>
      assertTransition('staged_for_delivery', 'in_transit', {
        ...baseCtx,
        hasAssignedDelivery: true,
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2.2: Run the test, expect failure**

Run: `pnpm --filter @stockpilot/core test -- order-state-machine`
Expected: `assertTransition is not a function`, all 7 new tests fail.

- [ ] **Step 2.3: Implement `assertTransition` + `OrderTransitionError`**

Append to `packages/core/src/order-state-machine.ts`:

```ts
export interface OrderTransitionContext {
  fulfillmentType: FulfillmentType;
  /**
   * Whether `assigned_delivery_user_id` is non-null on the row.
   * Required by the `staged_for_delivery → in_transit` rule.
   */
  hasAssignedDelivery: boolean;
}

export class OrderTransitionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'illegal_transition'
      | 'no_op'
      | 'fulfillment_type_mismatch'
      | 'assigned_delivery_required',
    public readonly from: OrderStatus,
    public readonly to: OrderStatus,
  ) {
    super(message);
    this.name = 'OrderTransitionError';
  }
}

/**
 * Throws `OrderTransitionError` when the proposed transition is not
 * legal. Returns silently when it is. The action layer wraps this
 * around every status mutation; the DB trigger applies the same
 * rules a second time as defense-in-depth.
 */
export function assertTransition(
  from: OrderStatus,
  to: OrderStatus,
  ctx: OrderTransitionContext,
): void {
  if (from === to) {
    throw new OrderTransitionError(
      `Same-status transition (${from}) — likely a no-op or race.`,
      'no_op',
      from,
      to,
    );
  }
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new OrderTransitionError(
      `Cannot move order from ${from} to ${to}.`,
      'illegal_transition',
      from,
      to,
    );
  }
  if (to === 'staged_for_delivery' && ctx.fulfillmentType !== 'delivery') {
    throw new OrderTransitionError(
      `staged_for_delivery requires fulfillment_type='delivery' (got '${ctx.fulfillmentType}').`,
      'fulfillment_type_mismatch',
      from,
      to,
    );
  }
  if (to === 'staged_for_pickup' && ctx.fulfillmentType !== 'pickup') {
    throw new OrderTransitionError(
      `staged_for_pickup requires fulfillment_type='pickup' (got '${ctx.fulfillmentType}').`,
      'fulfillment_type_mismatch',
      from,
      to,
    );
  }
  if (to === 'in_transit' && !ctx.hasAssignedDelivery) {
    throw new OrderTransitionError(
      `in_transit requires assigned_delivery_user_id to be set first.`,
      'assigned_delivery_required',
      from,
      to,
    );
  }
}
```

- [ ] **Step 2.4: Run tests, expect PASS**

Run: `pnpm --filter @stockpilot/core test -- order-state-machine`
Expected: all 14 tests passing (7 transition table + 7 assertTransition).

- [ ] **Step 2.5: Commit**

```bash
git add packages/core/src/order-state-machine.ts packages/core/src/order-state-machine.test.ts
git commit -m "feat(core): assertTransition + fulfillment-type guards"
```

---

### Task 3: `availableOrderActions` helper for UI button computation

**Files:**

- Modify: `packages/core/src/order-state-machine.ts`
- Modify: `packages/core/src/order-state-machine.test.ts`

- [ ] **Step 3.1: Write the failing test**

Append to `packages/core/src/order-state-machine.test.ts`:

```ts
import { availableOrderActions } from './order-state-machine';

describe('availableOrderActions', () => {
  const base = {
    status: 'approved' as const,
    fulfillmentType: 'delivery' as const,
    hasAssignedDelivery: false,
    viewerRole: 'manager' as const,
    viewerUserId: 'u-mgr',
    assignedPickerId: null as string | null,
    assignedDeliveryUserId: null as string | null,
  };

  it('returns generate_pick_slip on approved orders', () => {
    expect(availableOrderActions(base)).toContain('generate_pick_slip');
  });

  it('returns approve+deny on pending_approval', () => {
    const actions = availableOrderActions({ ...base, status: 'pending_approval' });
    expect(actions).toContain('approve');
    expect(actions).toContain('deny');
  });

  it('returns assign_delivery on staged_for_delivery for manager+', () => {
    const actions = availableOrderActions({
      ...base,
      status: 'staged_for_delivery',
    });
    expect(actions).toContain('assign_delivery');
  });

  it('does NOT return assign_delivery for staff role', () => {
    const actions = availableOrderActions({
      ...base,
      status: 'staged_for_delivery',
      viewerRole: 'staff',
    });
    expect(actions).not.toContain('assign_delivery');
  });

  it('returns mark_in_transit only when delivery is assigned', () => {
    const without = availableOrderActions({
      ...base,
      status: 'staged_for_delivery',
      hasAssignedDelivery: false,
    });
    const withAssigned = availableOrderActions({
      ...base,
      status: 'staged_for_delivery',
      hasAssignedDelivery: true,
      assignedDeliveryUserId: 'u-driver',
      viewerUserId: 'u-driver',
      viewerRole: 'staff',
    });
    expect(without).not.toContain('mark_in_transit');
    expect(withAssigned).toContain('mark_in_transit');
  });

  it('terminal states return only view-only actions', () => {
    const actions = availableOrderActions({ ...base, status: 'completed' });
    expect(actions).not.toContain('generate_pick_slip');
    expect(actions).toContain('view_signature');
  });

  it('denied state offers only view_denial_reason', () => {
    expect(availableOrderActions({ ...base, status: 'denied' })).toEqual([
      'view_denial_reason',
    ]);
  });
});
```

- [ ] **Step 3.2: Run the test, expect failure**

Run: `pnpm --filter @stockpilot/core test -- order-state-machine`
Expected: `availableOrderActions is not a function`.

- [ ] **Step 3.3: Implement `availableOrderActions`**

Append to `packages/core/src/order-state-machine.ts`:

```ts
import type { Role } from './types/role';

export type OrderAction =
  | 'approve'
  | 'deny'
  | 'cancel'
  | 'generate_pick_slip'
  | 'reassign_picker'
  | 'open_digital_pick'
  | 'print_pick_slip'
  | 'mark_picking_complete'
  | 'generate_packing_slips'
  | 'print_customer_slip'
  | 'print_warehouse_slip'
  | 'mark_staged_pickup'
  | 'mark_staged_delivery'
  | 'assign_delivery'
  | 'mark_in_transit'
  | 'collect_signature'
  | 'view_signature'
  | 'view_denial_reason'
  | 'view_final_packing_slip';

export interface AvailableActionsInput {
  status: OrderStatus;
  fulfillmentType: FulfillmentType;
  hasAssignedDelivery: boolean;
  viewerRole: Role;
  viewerUserId: string;
  assignedPickerId: string | null;
  assignedDeliveryUserId: string | null;
}

const MANAGER_OR_ABOVE: Role[] = ['owner', 'admin', 'manager'];

/**
 * Compute the list of UI actions available for the given order +
 * viewer combination. This is the single source of truth that the
 * order-detail page reads; never branch on status anywhere else.
 */
export function availableOrderActions(input: AvailableActionsInput): OrderAction[] {
  const isManagerOrAbove = MANAGER_OR_ABOVE.includes(input.viewerRole);
  const isAssignedDriver =
    input.assignedDeliveryUserId !== null &&
    input.assignedDeliveryUserId === input.viewerUserId;

  const actions: OrderAction[] = [];

  switch (input.status) {
    case 'pending_confirmation':
      // The requester confirms via email; staff just wait.
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'pending_approval':
      actions.push('approve', 'deny');
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'approved':
      actions.push('generate_pick_slip');
      if (isManagerOrAbove) actions.push('reassign_picker', 'cancel');
      break;
    case 'pick_slip_generated':
    case 'picking_in_progress':
      actions.push('open_digital_pick', 'print_pick_slip', 'mark_picking_complete');
      if (isManagerOrAbove) actions.push('reassign_picker', 'cancel');
      break;
    case 'picking_complete':
      actions.push('generate_packing_slips');
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'packing_slip_generated':
      actions.push('print_customer_slip', 'print_warehouse_slip');
      if (input.fulfillmentType === 'pickup') actions.push('mark_staged_pickup');
      else actions.push('mark_staged_delivery');
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'staged_for_pickup':
      actions.push('collect_signature', 'print_warehouse_slip');
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'staged_for_delivery':
      if (isManagerOrAbove) actions.push('assign_delivery');
      if (input.hasAssignedDelivery && (isAssignedDriver || isManagerOrAbove)) {
        actions.push('mark_in_transit');
      }
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'in_transit':
    case 'signature_requested':
      actions.push('collect_signature');
      if (isManagerOrAbove) actions.push('cancel');
      break;
    case 'completed':
      actions.push('view_signature', 'view_final_packing_slip');
      break;
    case 'denied':
      actions.push('view_denial_reason');
      break;
    case 'cancelled':
      // Truly terminal: no actions.
      break;
  }

  return actions;
}
```

- [ ] **Step 3.4: Run tests, expect PASS**

Run: `pnpm --filter @stockpilot/core test -- order-state-machine`
Expected: all 21 tests passing.

- [ ] **Step 3.5: Commit**

```bash
git add packages/core/src/order-state-machine.ts packages/core/src/order-state-machine.test.ts
git commit -m "feat(core): availableOrderActions helper for UI button computation"
```

---

### Task 4: Export state machine from `@stockpilot/core`

**Files:**

- Modify: `packages/core/src/index.ts`

- [ ] **Step 4.1: Read the file to find the correct export section**

Run: `grep -n "^export" packages/core/src/index.ts`
Expected: a list of existing `export * from './x'` lines.

- [ ] **Step 4.2: Add the export**

Append a new `export *` line in the appropriate section (alphabetical / grouped with other domain exports):

```ts
export * from './order-state-machine';
```

- [ ] **Step 4.3: Run typecheck**

Run: `pnpm typecheck`
Expected: 3 successful tasks, no errors.

- [ ] **Step 4.4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export order-state-machine from @stockpilot/core"
```

---

### Task 5: Add `orders:assign_delivery` permission

**Files:**

- Modify: `packages/core/src/constants/permissions.ts`

- [ ] **Step 5.1: Read the file**

Run: `wc -l packages/core/src/constants/permissions.ts && grep -n "ai:manage\|orders:" packages/core/src/constants/permissions.ts | head -20`
Expected: confirms the file structure (`PERMISSIONS` array, `ROLE_PERMISSIONS`, `PERMISSION_META`).

- [ ] **Step 5.2: Add the permission key to the `PERMISSIONS` array**

Find the existing line declaring `'orders:request'` or `'orders:approve'` and add the new key in the same block:

```ts
  'orders:request',
  'orders:approve',
  'orders:assign_delivery',  // NEW: manager+ assigns staged-for-delivery to a driver
```

- [ ] **Step 5.3: Add it to `ROLE_PERMISSIONS`**

Manager block:

```ts
manager: [
  // ...existing
  'orders:request',
  'orders:approve',
  'orders:assign_delivery', // NEW
  // ...
],
```

`admin` already gets it via `ALL_PERMISSIONS.filter((p) => p !== 'billing:manage')`. `owner` gets `ALL_PERMISSIONS`. Staff/viewer do NOT get this permission. Do NOT add it to staff/viewer.

- [ ] **Step 5.4: Add it to `PERMISSION_META`**

```ts
  'orders:assign_delivery': {
    group: 'Orders',
    label: 'Assign deliveries',
    description: 'Assign a staged delivery to a driver. Manager+ only.',
  },
```

- [ ] **Step 5.5: Run typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5.6: Commit**

```bash
git add packages/core/src/constants/permissions.ts
git commit -m "feat(rbac): add orders:assign_delivery permission (manager+)"
```

---

### Task 6: Add 9 new audit event types

**Files:**

- Modify: `apps/web/src/server/services/audit.ts`

- [ ] **Step 6.1: Read the audit-event union definition**

Run: `grep -n "AuditEvent\|^  | '" apps/web/src/server/services/audit.ts | head -40`
Expected: shows the existing `AuditEvent` string-literal union (the union we extended in commit `b1c27aa`).

- [ ] **Step 6.2: Add the new event types**

Find the existing block of `'order_request.*'` events and add these new literals:

```ts
  | 'order.pick_slip_generated'
  | 'order.picking_complete'
  | 'order.packing_slip_generated'
  | 'order.staged_for_pickup'
  | 'order.staged_for_delivery'
  | 'order.delivery_assigned'
  | 'order.in_transit'
  | 'order.signature_collected'
  | 'order.completed'
```

These coexist with the existing `order_request.*` events so historical audit logs stay readable. New code emits the new `order.*` events; old code keeps emitting the legacy ones until phase-by-phase migration.

- [ ] **Step 6.3: Run typecheck**

Run: `pnpm typecheck`
Expected: clean. (No call sites yet; just the union type expanded.)

- [ ] **Step 6.4: Commit**

```bash
git add apps/web/src/server/services/audit.ts
git commit -m "feat(audit): add 9 order.* event types for new workflow"
```

---

### Task 7: Extend `OrderRequestStatus` TS type to include new statuses

**Files:**

- Modify: `apps/web/src/server/services/order-requests.ts`

- [ ] **Step 7.1: Locate the type definition**

Run: `grep -n "OrderRequestStatus" apps/web/src/server/services/order-requests.ts | head`
Expected: shows the type union (around line 15).

- [ ] **Step 7.2: Replace the type with the extended union**

Edit the `OrderRequestStatus` declaration to include every new status:

```ts
export type OrderRequestStatus =
  | 'pending_confirmation'
  | 'pending_approval'
  | 'approved'
  | 'pick_slip_generated'
  | 'picking_in_progress'
  | 'picking_complete'
  | 'packing_slip_generated'
  | 'staged_for_pickup'
  | 'staged_for_delivery'
  | 'in_transit'
  | 'signature_requested'
  | 'completed'
  | 'denied'
  | 'cancelled';
```

Migration 0109 rewrites legacy `'packaging' | 'ready_for_delivery' | 'delivered'` rows to the new values, so this union no longer needs to carry the legacy literals after the migration runs. Phase 1 commits the type change BEFORE the migration applies — that is intentional because the type is more permissive than the DB until 0109 applies, then they reconverge.

- [ ] **Step 7.3: Run typecheck across the repo**

Run: `pnpm typecheck`
Expected: clean. If any call site narrows on a removed literal (`status === 'packaging'`), fix it inline — replace with `status === 'packing_slip_generated'`. Spot-check with: `grep -rn "'packaging'\|'ready_for_delivery'\|'delivered'" apps/web/src --include='*.ts' --include='*.tsx' | grep -v ".test."`.

- [ ] **Step 7.4: Fix any call sites that broke**

If grep showed hits:
- `'packaging'` → replace with `'packing_slip_generated'`
- `'ready_for_delivery'` → replace with `'staged_for_delivery'`
- `'delivered'` → replace with `'completed'`

These are byte-for-byte string replacements; the surrounding context stays the same.

- [ ] **Step 7.5: Run typecheck again**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 7.6: Run the existing test suite**

Run: `pnpm test`
Expected: all 375 tests still pass (21 new core tests + 354 previously existing — adjust if count drifted).

- [ ] **Step 7.7: Commit**

```bash
git add apps/web/src/server/services/order-requests.ts apps/web/src/server/services/*.ts apps/web/src/components/**/*.tsx
git commit -m "refactor(orders): extend OrderRequestStatus with new workflow statuses

Aligns the TS type with the upcoming migration 0109 enum. Existing
call sites that branched on 'packaging' / 'ready_for_delivery' /
'delivered' are remapped to the new equivalents
(packing_slip_generated / staged_for_delivery / completed)."
```

---

### Task 8: Write migration 0109 — schema additions

**Files:**

- Create: `supabase/migrations/0109_orders_workflow_foundation.sql`

This migration is large but mechanical. It runs in one transaction; if any step fails the whole thing rolls back.

- [ ] **Step 8.1: Create the migration file with the column additions**

```sql
-- 0109_orders_workflow_foundation.sql
--
-- Data foundation for the orders-workflow refactor. Adds every column
-- needed across phases 1-6, extends the status enum, rewrites the
-- transition guard, and migrates legacy status values to the new
-- canonical set. Zero user-facing UI changes ship in phase 1 — this
-- migration plus phase-1 TS code is the platform on which phases 2-6
-- build.
--
-- One transaction; any failure rolls back the entire change.

begin;

-- ────────────────────────────────────────────────────────────────────
-- 1. New columns on order_requests
-- ────────────────────────────────────────────────────────────────────

alter table public.order_requests
  add column if not exists fulfillment_type              text,
  add column if not exists delivery_address              jsonb,
  add column if not exists pickup_location_notes         text,
  add column if not exists requester_phone               text,
  add column if not exists assigned_picker_id            uuid references public.user_profiles(id) on delete set null,
  add column if not exists pick_slip_generated_at        timestamptz,
  add column if not exists pick_slip_generated_by        uuid references public.user_profiles(id) on delete set null,
  add column if not exists picking_completed_at          timestamptz,
  add column if not exists picking_completed_by          uuid references public.user_profiles(id) on delete set null,
  add column if not exists packing_slip_generated_at     timestamptz,
  add column if not exists packing_slip_generated_by     uuid references public.user_profiles(id) on delete set null,
  add column if not exists staged_at                     timestamptz,
  add column if not exists staged_by                     uuid references public.user_profiles(id) on delete set null,
  add column if not exists assigned_delivery_user_id     uuid references public.user_profiles(id) on delete set null,
  add column if not exists assigned_delivery_by          uuid references public.user_profiles(id) on delete set null,
  add column if not exists assigned_delivery_at          timestamptz,
  add column if not exists in_transit_at                 timestamptz,
  add column if not exists in_transit_by                 uuid references public.user_profiles(id) on delete set null,
  add column if not exists signature_token               text,
  add column if not exists signature_token_expires_at    timestamptz,
  add column if not exists signed_by_name                text,
  add column if not exists signed_by_email               citext,
  add column if not exists signature_data_url            text,
  add column if not exists signed_at                     timestamptz,
  add column if not exists completed_at                  timestamptz,
  add column if not exists completed_by                  uuid references public.user_profiles(id) on delete set null;
```

- [ ] **Step 8.2: Continue with line columns + the fulfillment_type backfill + check constraint**

Append:

```sql
-- ────────────────────────────────────────────────────────────────────
-- 2. New columns on order_request_lines (picked/packed tracking)
-- ────────────────────────────────────────────────────────────────────

alter table public.order_request_lines
  add column if not exists quantity_picked  numeric(14,4),
  add column if not exists picked_at        timestamptz,
  add column if not exists picked_by        uuid references public.user_profiles(id) on delete set null,
  add column if not exists quantity_packed  numeric(14,4),
  add column if not exists packed_at        timestamptz,
  add column if not exists packed_by        uuid references public.user_profiles(id) on delete set null;

-- ────────────────────────────────────────────────────────────────────
-- 3. Backfill fulfillment_type and enforce NOT NULL + default
--    Every pre-existing row assumed delivery (shipments existed for them).
-- ────────────────────────────────────────────────────────────────────

update public.order_requests
   set fulfillment_type = 'delivery'
 where fulfillment_type is null;

alter table public.order_requests
  alter column fulfillment_type set default 'delivery',
  alter column fulfillment_type set not null,
  add constraint order_requests_fulfillment_type_chk
    check (fulfillment_type in ('pickup', 'delivery'));

-- ────────────────────────────────────────────────────────────────────
-- 4. Status enum: rewrite legacy values + extend the check constraint
-- ────────────────────────────────────────────────────────────────────

update public.order_requests
   set status = 'packing_slip_generated'
 where status = 'packaging';

update public.order_requests
   set status = 'staged_for_delivery'
 where status = 'ready_for_delivery';

update public.order_requests
   set status = 'completed',
       completed_at = coalesce(delivered_at, updated_at)
 where status = 'delivered';

alter table public.order_requests
  drop constraint if exists order_requests_status_check;

alter table public.order_requests
  add constraint order_requests_status_check
  check (status in (
    'pending_confirmation',
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
    'completed',
    'denied',
    'cancelled'
  ));
```

- [ ] **Step 8.3: Rewrite the transition guard trigger function**

Append:

```sql
-- ────────────────────────────────────────────────────────────────────
-- 5. Rewrite _validate_order_request_status_transition to mirror the
--    centralized state machine in @stockpilot/core/order-state-machine.ts
-- ────────────────────────────────────────────────────────────────────

create or replace function public._validate_order_request_status_transition()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old text := old.status;
  v_new text := new.status;
  v_ok  boolean := false;
begin
  if v_old is not distinct from v_new then
    return new;
  end if;

  v_ok := case v_old
    when 'pending_confirmation'    then v_new in ('pending_approval', 'cancelled')
    when 'pending_approval'        then v_new in ('approved', 'denied', 'cancelled')
    when 'approved'                then v_new in ('pick_slip_generated', 'cancelled')
    when 'pick_slip_generated'     then v_new in ('picking_in_progress', 'picking_complete', 'cancelled')
    when 'picking_in_progress'     then v_new in ('picking_complete', 'cancelled')
    when 'picking_complete'        then v_new in ('packing_slip_generated', 'cancelled')
    when 'packing_slip_generated'  then v_new in ('staged_for_pickup', 'staged_for_delivery', 'cancelled')
    when 'staged_for_pickup'       then v_new in ('signature_requested', 'completed', 'cancelled')
    when 'staged_for_delivery'     then v_new in ('in_transit', 'cancelled')
    when 'in_transit'              then v_new in ('signature_requested', 'completed', 'cancelled')
    when 'signature_requested'     then v_new in ('completed', 'cancelled')
    when 'completed'               then false
    when 'denied'                  then false
    when 'cancelled'               then false
    else false
  end;

  if not v_ok then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001',
            detail  = format('Cannot move order_request from %s to %s', v_old, v_new);
  end if;

  -- Fulfillment-type guards (mirrored from assertTransition in TS).
  if v_new = 'staged_for_delivery' and new.fulfillment_type <> 'delivery' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001',
            detail  = 'staged_for_delivery requires fulfillment_type=delivery';
  end if;
  if v_new = 'staged_for_pickup' and new.fulfillment_type <> 'pickup' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001',
            detail  = 'staged_for_pickup requires fulfillment_type=pickup';
  end if;
  if v_new = 'in_transit' and new.assigned_delivery_user_id is null then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001',
            detail  = 'in_transit requires assigned_delivery_user_id to be set first';
  end if;

  return new;
end;
$$;
```

- [ ] **Step 8.4: Update the notify trigger so new transitions don't break notifications**

Append:

```sql
-- ────────────────────────────────────────────────────────────────────
-- 6. Update _notify_order_request_changes to handle the new status set
--    Phase 1 only needs to ensure the new statuses don't trigger
--    notification errors — phase 6 will add per-status notification
--    bodies. For now, transitions to the new operational statuses
--    (pick_slip_generated, picking_in_progress, picking_complete,
--    packing_slip_generated, staged_for_*, in_transit, signature_requested)
--    fire NO requester-side notification. Approved / denied / completed
--    keep their existing copy (mapped from 'approved'/'denied'/'delivered').
-- ────────────────────────────────────────────────────────────────────

create or replace function public._notify_order_request_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link text;
  v_title text;
  v_body text;
  v_recipient uuid;
  v_recipients_loop record;
  v_metadata jsonb;
begin
  v_link := '/dashboard/orders/' || new.id::text;
  v_metadata := jsonb_build_object(
    'order_request_id', new.id,
    'warehouse_id', new.warehouse_id,
    'source', new.source,
    'requester_user_id', new.requester_user_id,
    'requester_email', new.requester_email
  );

  if (tg_op = 'INSERT') then
    if new.status = 'pending_confirmation' then
      return new;
    end if;
    v_title := 'New order request' ||
               case when new.requester_name is not null
                    then ' from ' || new.requester_name else '' end;
    v_body := 'A request is waiting for approval.';
    for v_recipients_loop in
      select user_id from public._notify_recipients(new.organization_id)
    loop
      insert into public.notifications (
        organization_id, user_id, type, title, body, link, metadata
      ) values (
        new.organization_id, v_recipients_loop.user_id,
        'order_request.created', v_title, v_body, v_link, v_metadata
      );
    end loop;
    return new;
  end if;

  if (tg_op = 'UPDATE') then
    if old.status is not distinct from new.status then
      return new;
    end if;

    -- pending_confirmation → pending_approval is the manager-visible
    -- "real creation" event (carries over from migration 0108).
    if old.status = 'pending_confirmation' and new.status = 'pending_approval' then
      v_title := 'New order request' ||
                 case when new.requester_name is not null
                      then ' from ' || new.requester_name else '' end;
      v_body := 'A request is waiting for approval.';
      for v_recipients_loop in
        select user_id from public._notify_recipients(new.organization_id)
      loop
        insert into public.notifications (
          organization_id, user_id, type, title, body, link, metadata
        ) values (
          new.organization_id, v_recipients_loop.user_id,
          'order_request.created', v_title, v_body, v_link, v_metadata
        );
      end loop;
      return new;
    end if;

    -- New operational statuses (pick_slip_generated, picking_*,
    -- packing_slip_generated, staged_*, in_transit, signature_requested)
    -- do NOT trigger a requester-side bell ping in phase 1. Phase 6
    -- will revisit this when notification_preferences toggles ship.
    if new.status in (
      'pick_slip_generated',
      'picking_in_progress',
      'picking_complete',
      'packing_slip_generated',
      'staged_for_pickup',
      'staged_for_delivery',
      'in_transit',
      'signature_requested'
    ) then
      return new;
    end if;

    -- Cancel-after-approval routes to managers (unchanged from 0044).
    if new.status = 'cancelled'
       and old.status in ('approved','packing_slip_generated','staged_for_pickup','staged_for_delivery','in_transit')
       and new.cancelled_by is not null
       and not public.has_org_role(new.organization_id, 'manager')
    then
      v_title := 'Order request cancelled after approval';
      v_body := 'Stop preparing this order if you started.';
      for v_recipients_loop in
        select user_id from public._notify_recipients(new.organization_id)
      loop
        insert into public.notifications (
          organization_id, user_id, type, title, body, link, metadata
        ) values (
          new.organization_id, v_recipients_loop.user_id,
          'order_request.cancelled_after_approval',
          v_title, v_body, v_link, v_metadata
        );
      end loop;
      return new;
    end if;

    -- Requester-side notifications.
    v_recipient := new.requester_user_id;
    if v_recipient is null then
      return new;
    end if;

    case new.status
      when 'approved' then
        v_title := 'Your order request was approved';
        v_body := 'Stock has been reserved.';
      when 'denied' then
        v_title := 'Your order request was denied';
        v_body := coalesce(new.denied_reason, 'See the order page for details.');
      when 'completed' then
        v_title := 'Your order was completed';
        v_body := 'Pickup or delivery is finalized.';
      when 'cancelled' then
        v_title := 'Your order was cancelled';
        v_body := coalesce(new.denied_reason, 'See the order page for details.');
      else
        return new;
    end case;

    insert into public.notifications (
      organization_id, user_id, type, title, body, link, metadata
    ) values (
      new.organization_id, v_recipient,
      'order_request.' || new.status,
      v_title, v_body, v_link, v_metadata
    );
  end if;
  return new;
end;
$$;
```

- [ ] **Step 8.5: Add a partial unique index on signature_token + close the transaction**

Append:

```sql
-- ────────────────────────────────────────────────────────────────────
-- 7. Indexes for the new columns we'll query in phases 3-5.
-- ────────────────────────────────────────────────────────────────────

create unique index if not exists order_requests_signature_token_idx
  on public.order_requests(signature_token)
  where signature_token is not null;

create index if not exists order_requests_assigned_picker_idx
  on public.order_requests(assigned_picker_id)
  where assigned_picker_id is not null;

create index if not exists order_requests_assigned_delivery_idx
  on public.order_requests(assigned_delivery_user_id)
  where assigned_delivery_user_id is not null;

commit;

comment on column public.order_requests.fulfillment_type is
  'pickup | delivery. Defaults to delivery; backfilled at migration time. Drives the state machine branch at packing_slip_generated → staged_for_*.';
comment on column public.order_requests.signature_token is
  'Random hex-64 token minted at packing_slip_generated. Hashed match drives /orders/sign/<token> public signature page.';
```

- [ ] **Step 8.6: Validate the SQL is parseable (no DB required)**

Run: `cat supabase/migrations/0109_orders_workflow_foundation.sql | head -5 && wc -l supabase/migrations/0109_orders_workflow_foundation.sql`
Expected: file starts with the comment header, ~200+ lines.

- [ ] **Step 8.7: Commit**

```bash
git add supabase/migrations/0109_orders_workflow_foundation.sql
git commit -m "feat(orders): migration 0109 — workflow data foundation

Adds 25 columns to order_requests + 6 to order_request_lines for the
upcoming pick/pack/stage/sign flow. Extends the status enum, rewrites
the transition-guard trigger to mirror the centralized state machine,
updates the notify trigger so the new operational statuses don't ping
the requester (phase 6 will revisit), and migrates legacy
'packaging'/'ready_for_delivery'/'delivered' rows to the new
canonical statuses.

One transaction; failures roll back the whole thing."
```

---

### Task 9: Push the phase-1 branch + wait for user to apply migration

- [ ] **Step 9.1: Push all phase-1 commits to main**

```bash
git push
```
Expected: tasks 1-8's commits land on `main`.

- [ ] **Step 9.2: Inform the user**

Send a single message back to the user:

> "Phase 1 committed and pushed (commits across tasks 1–8). Migration `0109_orders_workflow_foundation.sql` is the only DB change. Please apply it in Supabase Studio (paste the SQL and run) and confirm with **'0109 good'** before I start phase 2."

- [ ] **Step 9.3: WAIT for user confirmation**

Do NOT proceed to phase 2 until the user explicitly confirms the migration applied. This honors the user's standing rule from `feedback_pause_for_migrations`.

---

### Task 10: Post-apply verification (after user confirms 0109 good)

- [ ] **Step 10.1: Verify the build is still green**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean, all tests pass (375 prior + 21 new = ≥396).

- [ ] **Step 10.2: Smoke-test the existing orders page**

Run the dev server (`pnpm dev` in `apps/web`), open `http://localhost:3000/dashboard/orders`, and verify:
- The orders list renders without errors
- Pre-existing orders show with sensible status pills (any `delivered` rows are now `completed`)
- The order detail page for at least one pre-existing order loads
- No console errors in the browser devtools

If anything is broken, stop and triage before proceeding.

- [ ] **Step 10.3: Mark phase 1 complete; prepare phase 2 plan**

Phase 1 is done. The next plan (`docs/superpowers/plans/2026-05-15-orders-phase-2-create-flows.md`) gets written when the user says "phase 2".

---

## Phase 1 Self-Review

- **Spec coverage:** §1.1 columns (Task 8), §1.2 line columns (Task 8), §1.3 status enum (Tasks 7, 8), §1.4 state machine (Tasks 1-3), §1.5 RPC (deferred to phase 3 per spec §4 phase 1 entry — out of phase 1 scope).
- **Placeholder scan:** No "TBD"/"TODO"/"similar to". Every SQL block, every TS function body, every test body is complete.
- **Type consistency:** `OrderStatus` (core) and `OrderRequestStatus` (web) are deliberately separate names that resolve to the same union; the rename in phase 2+ harmonizes them. `OrderTransitionError.code` values match the cases tested in Task 2.
- **No spec gap:** The `complete_picking` RPC is correctly deferred to phase 3 (per spec §4 phase 3 entry); phase 1 stays purely data-foundation.

## Test count after Phase 1

- Before phase 1: 375 tests
- After phase 1: ≥396 (21 new state-machine tests)

## Migration applied

- 0109_orders_workflow_foundation.sql (one migration, applied once)

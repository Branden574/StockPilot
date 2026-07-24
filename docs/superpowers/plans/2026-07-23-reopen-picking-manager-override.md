# Reopen Picking (manager override) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a manager send a picked or packed (pre-signature) order back to `picking_in_progress` to fix a miscount — reason-required, audited, refused once signed.

**Architecture:** A new backward edge in the shared order state machine (`picking_complete`/`packing_slip_generated → picking_in_progress`), enforced identically in TS and in the DB transition trigger; a `SECURITY DEFINER` `reopen_picking(p_id, p_reason)` RPC that reverses `complete_picking`'s per-line stock draw (`adjust_stock +quantity_picked`), restores the released reservations, preserves `quantity_picked`/`assigned_picker_id`, and clears the packing-slip/signature-token fields; a web service + server action + manager-actions button with a reason modal; and mobile parity through the existing `/api/v1/orders/[id]/transition` endpoint. Mirrors the existing `resume_fulfillment` backward transition and the cycle-count `release` reason/audit discipline.

**Tech Stack:** TypeScript, Next.js 16 (App Router, server actions), React, Supabase Postgres (plpgsql RPCs, pgTAP), Expo/React Native (apps/mobile), vitest.

## Global Constraints

- Migrations applied to prod via `supabase db push --linked` BEFORE deploying web that reads the new behavior; pgTAP required for the migration.
- Web + mobile parity ship together (the state machine is shared by both).
- `signed_at IS NOT NULL` is the ONLY correct "is signed" predicate — never `signature_data_url` (physical signatures leave the data-url NULL).
- Reopen is allowed from `picking_complete` AND `packing_slip_generated`; refused when `signed_at IS NOT NULL`.
- Reopen REVERSES `complete_picking`'s stock draw with a visible movement: `adjust_stock(item_id, +quantity_picked, 'transfer', null, 'Reopen picking (order_request …)', null)` and restores reservations (`released_at = NULL`; fall back to re-reserve only if the round-trip pgTAP proves un-release unsafe).
- Preserve `quantity_picked` and `assigned_picker_id`; land on `picking_in_progress`.
- When reopening from `packing_slip_generated`, clear `signature_token`, `signature_token_expires_at`, `packing_slip_generated_at`, `packing_slip_generated_by`.
- Manager gate: `orders:approve` (service) + `has_org_role(org,'manager')` (RPC). No new permission.
- No emojis in any copy, commit message, or PR body. No Claude co-author trailer.
- Live Demo Co verification (org `71b27a4a-7948-4638-bc3f-535974713bd2`), web + mobile, before done.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/core/src/order-state-machine.ts` | Add the two backward edges, `reopen_picking` action, availableOrderActions wiring | 1 |
| `packages/core/src/order-state-machine.test.ts` | Unit tests for the new edges + action | 1 |
| `supabase/migrations/0289_reopen_picking.sql` | Re-define the transition trigger (2 new edges) + `reopen_picking` RPC | 2 |
| `supabase/tests/0289_reopen_picking.test.sql` | pgTAP: guards + field-clearing + stock round-trip | 2 |
| `apps/web/src/server/services/order-requests.ts` | `reopenPicking(id, reason)` service method | 3 |
| `apps/web/src/server/services/audit.ts` | `order.picking_reopened` audit event | 3 |
| `apps/web/src/server/services/order-requests.test.ts` (or nearest existing) | Service unit tests | 3 |
| `apps/web/src/server/actions/order-requests.ts` | `reopenPickingAction(id, reason)` | 4 |
| `apps/web/src/components/orders/manager-actions-panel.tsx` | "Reopen picking" button + reason modal | 4 |
| `apps/web/src/app/api/v1/orders/[id]/transition/route.ts` | `reopen_picking` action case + reason validation | 5 |
| `apps/mobile/src/lib/orders-api.ts` | `{action:'reopen_picking', reason}` union variant | 6 |
| `apps/mobile/app/order/[id].tsx` | "Reopen picking" actionBtn + reason modal | 6 |

---

### Task 1: Shared state machine — backward edges + reopen_picking action

**Files:**
- Modify: `packages/core/src/order-state-machine.ts` (ALLOWED_TRANSITIONS ~:39-59, OrderAction union ~:151-175, availableOrderActions ~:257-266)
- Test: `packages/core/src/order-state-machine.test.ts`

**Interfaces:**
- Produces: `OrderAction` gains `'reopen_picking'`; `ALLOWED_TRANSITIONS.picking_complete` and `.packing_slip_generated` each gain `'picking_in_progress'`; `availableOrderActions` returns `'reopen_picking'` for manager+ in those two states.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/order-state-machine.test.ts`:

```typescript
import { ALLOWED_TRANSITIONS, availableOrderActions } from './order-state-machine';

describe('reopen picking (manager override)', () => {
  it('allows picking_complete → picking_in_progress', () => {
    expect(ALLOWED_TRANSITIONS.picking_complete).toContain('picking_in_progress');
  });
  it('allows packing_slip_generated → picking_in_progress', () => {
    expect(ALLOWED_TRANSITIONS.packing_slip_generated).toContain('picking_in_progress');
  });
  it('offers reopen_picking to a manager at picking_complete', () => {
    const actions = availableOrderActions({
      status: 'picking_complete',
      viewerRole: 'manager',
      viewerUserId: 'u1',
      assignedPickerId: null,
      assignedDeliveryUserId: null,
      hasAssignedDelivery: false,
      isShortStock: false,
      hasFulfillableStock: false,
      fulfillmentType: 'pickup',
    });
    expect(actions).toContain('reopen_picking');
  });
  it('offers reopen_picking to a manager at packing_slip_generated', () => {
    const actions = availableOrderActions({
      status: 'packing_slip_generated',
      viewerRole: 'admin',
      viewerUserId: 'u1',
      assignedPickerId: null,
      assignedDeliveryUserId: null,
      hasAssignedDelivery: false,
      isShortStock: false,
      hasFulfillableStock: false,
      fulfillmentType: 'pickup',
    });
    expect(actions).toContain('reopen_picking');
  });
  it('does NOT offer reopen_picking to a non-manager (staff)', () => {
    const actions = availableOrderActions({
      status: 'picking_complete',
      viewerRole: 'staff',
      viewerUserId: 'u1',
      assignedPickerId: null,
      assignedDeliveryUserId: null,
      hasAssignedDelivery: false,
      isShortStock: false,
      hasFulfillableStock: false,
      fulfillmentType: 'pickup',
    });
    expect(actions).not.toContain('reopen_picking');
  });
});
```

> Note: match the exact `AvailableActionsInput` shape used by the existing tests in this file — copy a passing test's input object and only change `status`/`viewerRole`. If a field name differs, use the file's actual field names.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stockpilot/core test -- --run order-state-machine`
Expected: FAIL — `picking_in_progress` not in the arrays; `reopen_picking` not returned.

- [ ] **Step 3: Add the backward edges**

In `packages/core/src/order-state-machine.ts`, in `ALLOWED_TRANSITIONS`:

```typescript
  // WAS: picking_complete: ['packing_slip_generated', 'cancelled'],
  picking_complete: ['packing_slip_generated', 'picking_in_progress', 'cancelled'],
  // WAS: packing_slip_generated: ['staged_for_pickup', 'staged_for_delivery', 'cancelled'],
  packing_slip_generated: ['staged_for_pickup', 'staged_for_delivery', 'picking_in_progress', 'cancelled'],
```

- [ ] **Step 4: Add the action to the union**

In the `OrderAction` union, after `'mark_picking_complete'`:

```typescript
  | 'mark_picking_complete'
  // Manager override: send a picked/packed (pre-signature) order back to
  // picking_in_progress to fix a miscount. Reason-required + audited; the RPC
  // refuses once signed. Reverses complete_picking's stock draw.
  | 'reopen_picking'
```

- [ ] **Step 5: Surface it in availableOrderActions**

In `availableOrderActions`, extend the two branches (add the manager push):

```typescript
    case 'picking_complete':
      actions.push('generate_packing_slips');
      if (isManagerOrAbove) actions.push('reopen_picking', 'cancel');
      break;
    case 'packing_slip_generated':
      actions.push('print_customer_slip', 'print_warehouse_slip');
      if (input.fulfillmentType === 'pickup') actions.push('mark_staged_pickup');
      else actions.push('mark_staged_delivery');
      if (isManagerOrAbove) actions.push('reopen_picking', 'cancel');
      break;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @stockpilot/core test -- --run order-state-machine`
Expected: PASS. Then `pnpm --filter @stockpilot/core test -- --run` (whole core suite) stays green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/order-state-machine.ts packages/core/src/order-state-machine.test.ts
git commit -m "feat(orders): allow manager to reopen picking (state machine edges)"
```

---

### Task 2: DB migration — transition trigger + reopen_picking RPC + pgTAP

**Files:**
- Create: `supabase/migrations/0289_reopen_picking.sql`
- Create: `supabase/tests/0289_reopen_picking.test.sql`

**Interfaces:**
- Produces: RPC `public.reopen_picking(p_id uuid, p_reason text) RETURNS order_requests`. Raises `unauthenticated`, `reopen_reason_required`, `order_request_not_found`, `forbidden`, `already_signed`, `invalid_status_transition`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0289_reopen_picking.sql`:

```sql
-- Manager reopen-picking override: send a picked/packed (pre-signature) order
-- back to picking_in_progress to fix a miscount. Two parts:
--   1. Extend the transition trigger with the two backward edges (must match
--      packages/core/src/order-state-machine.ts, edited in the same change-set).
--   2. reopen_picking(p_id, p_reason) RPC that reverses complete_picking's
--      per-line stock draw, restores the released reservations, preserves
--      quantity_picked, and clears the packing-slip / signature-token cycle.

-- 1. Transition trigger — add picking_complete → picking_in_progress and
--    packing_slip_generated → picking_in_progress. Full re-definition (the live
--    body verified against prod on 2026-07-23).
create or replace function public._validate_order_request_status_transition()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
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
    -- Manager reopen: picking_complete may rewind to picking_in_progress.
    when 'picking_complete'        then v_new in ('packing_slip_generated', 'picking_in_progress', 'cancelled')
    -- Manager reopen: packing_slip_generated may rewind to picking_in_progress.
    when 'packing_slip_generated'  then v_new in ('staged_for_pickup', 'staged_for_delivery', 'picking_in_progress', 'cancelled')
    when 'staged_for_pickup'       then v_new in ('completed', 'backordered', 'cancelled')
    when 'staged_for_delivery'     then v_new in ('in_transit', 'cancelled')
    when 'in_transit'              then v_new in ('completed', 'backordered', 'cancelled')
    when 'backordered'             then v_new in ('pick_slip_generated', 'completed', 'cancelled')
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

  return new;
end;
$function$;

-- 2. reopen_picking RPC.
create or replace function public.reopen_picking(p_id uuid, p_reason text)
returns order_requests
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_req  public.order_requests%rowtype;
  v_user uuid := auth.uid();
  v_line record;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'reopen_reason_required' using errcode = 'P0001';
  end if;

  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_req.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- signed_at is the ONLY correct is-signed predicate (physical signatures
  -- leave signature_data_url NULL). Defence in depth: these statuses are
  -- pre-signature already, but never let a signed order rewind.
  if v_req.signed_at is not null then
    raise exception 'already_signed' using errcode = 'P0001';
  end if;
  if v_req.status not in ('picking_complete', 'packing_slip_generated') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- Reverse complete_picking's per-line stock draw. quantity_picked holds the
  -- exact drawn amount (complete_picking sets quantity_picked = v_batch after
  -- adjust_stock(-v_batch)). This writes a visible +movement, the inverse of
  -- the "Order pick" movement.
  for v_line in
    select l.id as line_id, l.item_id, coalesce(l.quantity_picked, 0) as picked
    from public.order_request_lines l
    where l.order_request_id = p_id
    order by l.item_id
  loop
    if v_line.picked > 0 then
      perform public.adjust_stock(
        v_line.item_id,
        v_line.picked,
        'transfer',
        null,
        'Reopen picking (order_request ' || p_id::text || ')',
        null
      );
    end if;
  end loop;

  -- Restore the reservations complete_picking released for this order.
  update public.stock_reservations
    set released_at = null
    where order_request_id = p_id
      and released_at is not null;

  -- Rewind to picking_in_progress; preserve quantity_picked + assigned_picker_id;
  -- clear the packing-slip / signature-token cycle (voids the packing slip when
  -- reopening from packing_slip_generated; no-op columns are already NULL when
  -- reopening from picking_complete).
  update public.order_requests
    set status                     = 'picking_in_progress',
        picking_completed_at       = null,
        picking_completed_by       = null,
        packing_slip_generated_at  = null,
        packing_slip_generated_by  = null,
        signature_token            = null,
        signature_token_expires_at = null
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;

grant execute on function public.reopen_picking(uuid, text) to authenticated;

comment on function public.reopen_picking(uuid, text) is
  'Manager override: rewind a picked/packed (pre-signature) order to '
  'picking_in_progress to fix a miscount. Reverses complete_picking''s stock '
  'draw (adjust_stock +quantity_picked), restores released reservations, '
  'preserves quantity_picked + assigned_picker_id, clears packing-slip/token '
  'fields. Refuses when signed_at is set. Reason required.';
```

- [ ] **Step 2: Write the pgTAP test**

Create `supabase/tests/0289_reopen_picking.test.sql` (model on `supabase/tests/0245_backorder_resume_close_partial.test.sql` for order/stock setup). It MUST cover: manager-gate, reason-required, wrong-status, signed-refuse, field-clearing, and the stock round-trip. Skeleton with the round-trip as the load-bearing test:

```sql
-- supabase/tests/0289_reopen_picking.test.sql
-- Proves reopen_picking: manager-only, reason-required, refused when signed or
-- at the wrong status, and — the load-bearing invariant — that pick →
-- complete_picking → reopen_picking → re-complete does NOT double-decrement
-- stock. Run via `supabase test db`. begin/rollback so nothing leaks.
begin;
select plan(9);

\set org  '\'e0000000-0000-0000-0000-0000000000e1\''
\set mgr  '\'e0000000-0000-0000-0000-0000000000e2\''
\set staff '\'e0000000-0000-0000-0000-0000000000e3\''
\set wh   '\'e0000000-0000-0000-0000-0000000000e7\''
\set item '\'e0000000-0000-0000-0000-0000000000e8\''
\set ord  '\'e0000000-0000-0000-0000-0000000000e9\''
\set line '\'e0000000-0000-0000-0000-0000000000ea\''

-- Seed org, users, warehouse, item (on_hand 10), order in picking_in_progress
-- with one line requested 10. (Follow 0245's exact insert columns for
-- organizations / organization_members / warehouses / inventory_items /
-- order_requests / order_request_lines / stock_reservations. Reserve 10 for
-- the order so complete_picking has a reservation to release.)
-- ... seed inserts here (copy 0245 column lists) ...

-- Act as the manager for the RPC calls.
select set_config('request.jwt.claim.sub', :mgr, true);

-- 1. Pick 10 on the line, complete picking → on_hand 0, reservation released.
update public.order_request_lines set quantity_picked = 10 where id = :line;
select public.complete_picking(:ord);
select is(
  (select quantity_on_hand from public.inventory_items where id = :item),
  0::numeric(14,4),
  'complete_picking drew on_hand to 0');
select is(
  (select status from public.order_requests where id = :ord),
  'picking_complete',
  'order is picking_complete');

-- 2. Blank reason is refused.
select throws_like(
  $$ select public.reopen_picking(:ord::uuid, '   ') $$,
  '%reopen_reason_required%',
  'blank reason refused');

-- 3. Reopen restores on_hand to 10, reservation active, status back, picks kept.
select public.reopen_picking(:ord, 'Miscount on line 1');
select is(
  (select quantity_on_hand from public.inventory_items where id = :item),
  10::numeric(14,4),
  'reopen restored on_hand to 10 (no orphaned draw)');
select is(
  (select status from public.order_requests where id = :ord),
  'picking_in_progress',
  'order rewound to picking_in_progress');
select is(
  (select quantity_picked from public.order_request_lines where id = :line),
  10::numeric(14,4),
  'quantity_picked preserved');
select isnt(
  (select released_at from public.stock_reservations
     where order_request_id = :ord order by created_at desc limit 1),
  null,
  'reservation restored (released_at NULL)');

-- 4. Fix the line to 8, re-complete → on_hand 2 (NOT -6: no double-decrement).
update public.order_request_lines set quantity_picked = 8 where id = :line;
select public.complete_picking(:ord);
select is(
  (select quantity_on_hand from public.inventory_items where id = :item),
  2::numeric(14,4),
  'round-trip: on_hand 2 after corrected re-pick, no double-decrement');

-- 5. Non-manager (staff) is refused.
select set_config('request.jwt.claim.sub', :staff, true);
select throws_like(
  $$ select public.reopen_picking(:ord::uuid, 'x') $$,
  '%forbidden%',
  'non-manager refused');

select * from finish();
rollback;
```

> The `isnt(released_at, null)` assertion encodes the un-release approach. If, when running, the reservation model turns out to release+recreate rather than mark `released_at`, adjust the RPC to re-create reservations (mirror `resume_fulfillment`'s reserve loop) and update this assertion — the round-trip on_hand assertions (steps 3 and 4) are the invariant that must hold regardless.

- [ ] **Step 3: Apply the migration locally and run pgTAP**

Run:
```bash
supabase db reset   # local: replays all migrations incl. 0289
pnpm db:test        # runs supabase/tests/*.test.sql via `supabase test db`
```
Expected: `0289_reopen_picking.test.sql` reports `ok` for all 9; no regressions in the rest of the suite.

- [ ] **Step 4: Fix until green**

If the round-trip on_hand assertions fail, the reversal or reservation handling is wrong — do NOT proceed. The `on_hand 2` (step 4) assertion is the correctness gate: a failure means double-decrement or a bad reversal.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0289_reopen_picking.sql supabase/tests/0289_reopen_picking.test.sql
git commit -m "feat(orders): reopen_picking RPC + transition edge, with stock round-trip pgTAP"
```

- [ ] **Step 6: Apply to prod (owner-gated)**

Run: `supabase db push --linked` (project `xizpqmhhslgzbuqtjubv`). Confirm 0289 applied:
```bash
supabase migration list --linked   # 0289 shows as applied remote
```
This MUST land before any web deploy that calls `reopen_picking`.

---

### Task 3: Web service `reopenPicking` + audit event

**Files:**
- Modify: `apps/web/src/server/services/audit.ts` (AuditEvent union, order.* block near `order.fulfillment_resumed`)
- Modify: `apps/web/src/server/services/order-requests.ts` (new method after `resumeFulfillment`)
- Test: `apps/web/src/server/services/order-requests.test.ts` (or the nearest existing service test file — search for one that tests `resumeFulfillment`; if none, create `order-requests.reopen.test.ts` beside the service)

**Interfaces:**
- Consumes: RPC `reopen_picking(p_id, p_reason)` (Task 2).
- Produces: `OrderRequestsService.reopenPicking(id: string, reason: string): Promise<OrderRequestRow>`; audit event `'order.picking_reopened'`.

- [ ] **Step 1: Add the audit event**

In `apps/web/src/server/services/audit.ts`, in the `AuditEvent` union order.* block (beside `'order.fulfillment_resumed'`):

```typescript
  | 'order.fulfillment_resumed'
  | 'order.picking_reopened'
```

- [ ] **Step 2: Write the failing service test**

Model on the existing `resumeFulfillment` service test (find it: `grep -rn "resumeFulfillment" apps/web/src/server/services/*.test.ts`). Copy its supabase-rpc mock harness and assert:

```typescript
describe('reopenPicking', () => {
  it('requires a non-blank reason (no RPC call)', async () => {
    const svc = makeService(/* manager ctx */);
    await expect(svc.reopenPicking('ord-1', '   ')).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('calls reopen_picking with the reason and audits on success', async () => {
    rpcMock.mockResolvedValue({ data: { id: 'ord-1', status: 'picking_in_progress' }, error: null });
    const svc = makeService(/* manager ctx */);
    const row = await svc.reopenPicking('ord-1', 'Miscount on line 1');
    expect(rpcMock).toHaveBeenCalledWith('reopen_picking', { p_id: 'ord-1', p_reason: 'Miscount on line 1' });
    expect(row.status).toBe('picking_in_progress');
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'order.picking_reopened', entityId: 'ord-1', reason: 'Miscount on line 1' }),
      expect.anything(),
    );
  });

  it('maps already_signed to a friendly conflict', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'already_signed' } });
    const svc = makeService(/* manager ctx */);
    await expect(svc.reopenPicking('ord-1', 'x')).rejects.toMatchObject({ code: 'conflict' });
  });
});
```

> Use the exact mock-construction helpers the sibling `resumeFulfillment` test uses. If the file has no such helper, replicate its `ctx.supabase.rpc` mock inline.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @stockpilot/web test -- --run order-requests`
Expected: FAIL — `reopenPicking` is not a function.

- [ ] **Step 4: Implement the service method**

In `apps/web/src/server/services/order-requests.ts`, immediately after the `resumeFulfillment` method, add (mirrors `resumeFulfillment` + cycle-count `release` reason discipline):

```typescript
  /**
   * Reopen picking on a picked/packed (pre-signature) order — rewind to
   * picking_in_progress so a manager can fix a miscount. Reason-required +
   * audited; the RPC reverses complete_picking's stock draw, restores
   * reservations, preserves quantity_picked, and refuses once signed. Manager+
   * only (orders:approve, which also enforces the org MFA/AAL2 step-up).
   */
  async reopenPicking(id: string, reason: string): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'orders:approve');
    if (!reason || reason.trim() === '') {
      throw new ServiceError('validation_error', 'A reason is required to reopen picking.', {
        reason: 'reopen_reason_required',
      });
    }
    await this.requireWarehouseAccess(id, 'write');
    const { data, error } = await this.ctx.supabase.rpc('reopen_picking', {
      p_id: id,
      p_reason: reason.trim(),
    });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('order_request_not_found'))
        throw new ServiceError('not_found', 'Order not found.');
      if (msg.includes('reopen_reason_required'))
        throw new ServiceError('validation_error', 'A reason is required to reopen picking.', {
          reason: 'reopen_reason_required',
        });
      if (msg.includes('already_signed'))
        throw new ServiceError('conflict', "This order has been signed for and can't be reopened.");
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'Only a manager can reopen picking.');
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError(
          'validation_error',
          "This order isn't at a stage that can be reopened.",
        );
      throw new ServiceError('internal_error', 'Could not reopen picking.');
    }
    const row = data as OrderRequestRow;
    await audit(
      {
        event: 'order.picking_reopened',
        entityType: 'order_request',
        entityId: id,
        reason: reason.trim(),
      },
      this.ctx,
    );
    void broadcastOrderChanged(this.ctx.organizationId, id);
    return row;
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @stockpilot/web test -- --run order-requests`
Expected: PASS. Then `pnpm typecheck` clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/services/order-requests.ts apps/web/src/server/services/audit.ts apps/web/src/server/services/order-requests.test.ts
git commit -m "feat(orders): reopenPicking service method + order.picking_reopened audit"
```

---

### Task 4: Server action + web "Reopen picking" button + reason modal

**Files:**
- Modify: `apps/web/src/server/actions/order-requests.ts` (new `reopenPickingAction`)
- Modify: `apps/web/src/components/orders/manager-actions-panel.tsx` (state, handler, buttons in the two branches, reason dialog)

**Interfaces:**
- Consumes: `OrderRequestsService.reopenPicking(id, reason)` (Task 3).
- Produces: `reopenPickingAction(input: { id: string; reason: string }): Promise<ActionResult<void>>`.

- [ ] **Step 1: Add the action**

In `apps/web/src/server/actions/order-requests.ts`, add a schema + action (mirror `resumeFulfillmentAction`, but with a `reason`):

```typescript
const reopenPickingSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().trim().min(1, 'A reason is required.').max(500),
});

export async function reopenPickingAction(
  input: z.input<typeof reopenPickingSchema>,
): Promise<ActionResult<void>> {
  const parsed = reopenPickingSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    await svc.reopenPicking(parsed.data.id, parsed.data.reason);
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    revalidatePath(`/dashboard/orders/${parsed.data.id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
```

- [ ] **Step 2: Wire the panel — imports, state, handler**

In `apps/web/src/components/orders/manager-actions-panel.tsx`:
- Add `reopenPickingAction` to the `@/server/actions/order-requests` import (beside `resumeFulfillmentAction`).
- Add state beside `denyReason` (~:224-227):

```typescript
  const [reopenOpen, setReopenOpen] = React.useState(false);
  const [reopenReason, setReopenReason] = React.useState('');
```

- Add a handler beside `resumeFulfillment` (~:369):

```typescript
  async function reopenPicking() {
    const reason = reopenReason.trim();
    if (!reason) {
      toast.error('Enter a reason before reopening.');
      return;
    }
    setBusy('reopen-picking');
    const res = await reopenPickingAction({ id: orderId, reason });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setReopenOpen(false);
    setReopenReason('');
    toast.success('Picking reopened — the pick is editable again.');
    router.refresh();
  }
```

> `BusyKey` is a union of string literals — add `'reopen-picking'` to its definition (search `type BusyKey`).

- [ ] **Step 3: Add the buttons to the two branches**

In the `status === 'picking_complete'` branch (~:611), after "Generate packing slips":

```tsx
              {actions.includes('reopen_picking') && (
                <Button variant="outline" onClick={() => setReopenOpen(true)} disabled={busy !== null}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reopen picking
                </Button>
              )}
```

Add the same block inside the `status === 'packing_slip_generated'` branch group (near the stage buttons ~:667-710). Import `RotateCcw` from `lucide-react` if not already imported.

> `actions` is the `availableOrderActions(...)` result already computed in this component (gates by manager+); reuse it so the button appears only when the server would accept it.

- [ ] **Step 4: Add the reason dialog**

Beside the deny-reason `<Dialog>` (~:823), add (copy that dialog's structure — iOS-webview-safe, not `window.prompt`):

```tsx
      <Dialog
        open={reopenOpen}
        onOpenChange={(v) => {
          if (busy === 'reopen-picking') return;
          setReopenOpen(v);
          if (!v) setReopenReason('');
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reopen picking?</DialogTitle>
            <DialogDescription>
              Sends this order back to picking so the count can be corrected. The already-picked
              quantities are kept, the stock draw is reversed, and this is recorded in the audit log.
              A signed order can&apos;t be reopened.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reopen-reason">Reason</Label>
            <Textarea
              id="reopen-reason"
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Why is this being reopened? (e.g. miscount on line 3)"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenOpen(false)} disabled={busy === 'reopen-picking'}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={reopenPicking} disabled={busy === 'reopen-picking' || !reopenReason.trim()}>
              {busy === 'reopen-picking' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Reopen picking
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

- [ ] **Step 5: Write a component test**

If there's a `manager-actions-panel.test.tsx`, add tests mirroring the deny-flow test: (a) reopen button shows for a manager at `picking_complete`; (b) clicking it opens the dialog; (c) confirm is disabled until a reason is typed; (d) confirming calls `reopenPickingAction` with `{ id, reason }`. Mock `@/server/actions/order-requests`.

Run: `pnpm --filter @stockpilot/web test -- --run manager-actions-panel`
Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/actions/order-requests.ts apps/web/src/components/orders/manager-actions-panel.tsx
git commit -m "feat(orders): web Reopen picking button + reason modal + action"
```

---

### Task 5: Bearer transition route — reopen_picking action

**Files:**
- Modify: `apps/web/src/app/api/v1/orders/[id]/transition/route.ts`

**Interfaces:**
- Consumes: `OrderRequestsService.reopenPicking(id, reason)` (Task 3).
- Produces: `POST /api/v1/orders/[id]/transition` accepts `{ action: 'reopen_picking', reason }`.

- [ ] **Step 1: Add to the action enum**

In `bodySchema`'s `z.enum([...])`, add `'reopen_picking'` (beside `'complete_picking'`). The body already has an optional `reason` field.

- [ ] **Step 2: Add the dispatch case**

In the `switch (a.action)` (beside `complete_picking` ~:115), add:

```typescript
      case 'reopen_picking':
        if (!a.reason || a.reason.trim() === '') {
          return NextResponse.json(
            { error: 'validation_error', message: 'A reason is required to reopen picking.' },
            { status: 400 },
          );
        }
        order = await svc.reopenPicking(id, a.reason.trim());
        break;
```

- [ ] **Step 3: Include it in the inventory-cache revalidation**

reopen restocks (adjust_stock +) — it changes the Items/Books views. Extend the guard (~:167):

```typescript
    if (a.action === 'complete_picking' || a.action === 'cancel' || a.action === 'reopen_picking') {
      revalidateInventoryList(ctx.organizationId);
    }
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck` (route is type-checked). Manual: after Task 2's migration is on prod, `curl -X POST .../api/v1/orders/<uuid>/transition -d '{"action":"reopen_picking"}'` unauth → 401; with a manager bearer + reason on a `picking_complete` order → 200. (Full manual check happens in Task 7.)

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/api/v1/orders/[id]/transition/route.ts"
git commit -m "feat(orders): Bearer transition route handles reopen_picking"
```

---

### Task 6: Mobile — orders-api variant + Reopen picking actionBtn + reason modal

**Files:**
- Modify: `apps/mobile/src/lib/orders-api.ts` (OrderAction union)
- Modify: `apps/mobile/app/order/[id].tsx` (state, handler, buttons in the two branches, reason modal)

**Interfaces:**
- Consumes: `POST /api/v1/orders/[id]/transition` `{ action: 'reopen_picking', reason }` (Task 5).

- [ ] **Step 1: Add the union variant**

In `apps/mobile/src/lib/orders-api.ts`, in the `OrderAction` union (beside `complete_picking`):

```typescript
  | { action: 'complete_picking' }
  // Manager override: rewind a picked/packed (pre-signature) order to picking
  // so a miscount can be fixed. Reason required; the server refuses once signed.
  | { action: 'reopen_picking'; reason: string }
```

- [ ] **Step 2: Add the reason-modal state + handler**

In `apps/mobile/app/order/[id].tsx`, mirror the deny-reason flow (`denyOpen`/`denyReason`/`deny()` at ~:731). Add:

```typescript
  const [reopenOpen, setReopenOpen] = React.useState(false);
  const [reopenReason, setReopenReason] = React.useState('');
```

Handler (beside `deny` ~:731):

```typescript
  async function reopenPicking() {
    const reason = reopenReason.trim();
    if (!reason) {
      Alert.alert('Reason required', 'Enter a reason before reopening picking.');
      return;
    }
    setReopenOpen(false);
    await act({ action: 'reopen_picking', reason }, 'reopen');
    setReopenReason('');
  }
```

> `act(body, key)` is the existing dispatch helper; it POSTs the transition and refreshes. Use the same busy-key pattern as the other actions.

- [ ] **Step 3: Add the actionBtn to the two branches**

In the `picking_complete` branch (~:1354, beside "Generate packing slips") and in the `packing_slip_generated` branch (~:1360-1368, beside the stage buttons), add — gated on manager+ (use the same manager check the screen already computes; search `isManager`/`canApprove` in this file):

```tsx
{order.status === 'picking_complete' && isManager
  ? actionBtn('Reopen picking', 'reopen', () => setReopenOpen(true), 'danger')
  : null}
```

and the equivalent for `packing_slip_generated && isManager`.

- [ ] **Step 4: Add the reason modal**

Copy the deny-reason `Modal`/dialog markup (search the deny modal at the bottom of the file ~:1726) and bind it to `reopenOpen`/`reopenReason`/`reopenPicking`, with title "Reopen picking?" and the same body copy as web (kept picks, reversed draw, audited, refused once signed).

- [ ] **Step 5: Typecheck + lint**

Run:
```bash
pnpm --filter @stockpilot/mobile typecheck
pnpm --filter @stockpilot/mobile exec eslint app/order/\[id\].tsx src/lib/orders-api.ts
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add "apps/mobile/app/order/[id].tsx" apps/mobile/src/lib/orders-api.ts
git commit -m "feat(mobile): Reopen picking action on the order screen"
```

---

### Task 7: Live verification (Demo Co) + OTA

**Files:** none (verification + deploy).

- [ ] **Step 1: Confirm the migration is on prod** (from Task 2 Step 6). If not, `supabase db push --linked` first.

- [ ] **Step 2: Push web** — `git push origin main`; wait for the Vercel deploy; probe the route exists:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'content-type: application/json' -d '{"action":"reopen_picking"}' \
  https://stockpilotusa.com/api/v1/orders/00000000-0000-0000-0000-000000000000/transition
```
Expected: 401 (deployed, auth-gated) — not 404.

- [ ] **Step 3: Web hand-test in Demo Co** — sign in as demo, take an order to `picking_complete` (and separately to `packing_slip_generated`), click "Reopen picking", confirm the reason gate blocks empty, submit, and verify via SQL: `status='picking_in_progress'`, `quantity_picked` preserved, on-hand restored (the pick's `adjust_stock +` movement present), an `order.picking_reopened` row in `/dashboard/audit` carrying the reason. Then re-complete and confirm no double-decrement.

- [ ] **Step 4: Mobile hand-test in the simulator** (idb, as with the write-off) — reopen from `picking_complete`, verify the reason modal, submit, DB-verify the same invariants.

- [ ] **Step 5: OTA** — `pnpm release:ota -m "Reopen picking (manager override)"` from `apps/mobile`.

- [ ] **Step 6: Final** — full suites green (`pnpm --filter @stockpilot/core test -- --run`, `pnpm --filter @stockpilot/web test -- --run`, `pnpm --filter @stockpilot/mobile test`), `pnpm typecheck` clean.

---

## Self-Review

- **Spec coverage:** scope (picking_complete + packing_slip_generated, refuse signed) → Task 1/2; keep picked counts + resume in picking_in_progress → Task 2 RPC; reverse stock draw + restore reservations → Task 2 RPC + round-trip pgTAP; manager gate + reason + audit → Task 2/3; web UI → Task 4; Bearer + mobile parity → Task 5/6; Demo Co verify + OTA → Task 7. All spec sections mapped.
- **Placeholder scan:** the pgTAP seed inserts are described as "copy 0245's column lists" rather than reproduced — this is the one spot the implementer must fill from the sibling test; every logic assertion and all production code is given in full.
- **Type consistency:** `reopenPicking(id, reason)` (service) ↔ `reopenPickingAction({id, reason})` (action) ↔ `{action:'reopen_picking', reason}` (route + mobile) ↔ `'reopen_picking'` (OrderAction). Audit event `'order.picking_reopened'` consistent across Task 3 uses. `BusyKey` gains `'reopen-picking'`.
</content>

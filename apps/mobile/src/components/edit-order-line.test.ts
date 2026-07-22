import type { Permission, Role } from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

import { ADD_LINES_BLOCKED_STATUSES } from './add-order-items';
import {
  canEditOrderLines,
  canRemoveOrderLine,
  describeLineEditError,
  describeQuantityFloor,
  LINE_EDIT_MAX_QUANTITY,
  lineEditErrorIsIndeterminate,
  lineEditErrorIsStale,
  lineQuantityFloor,
  lineQuantitySummary,
  lineRemovedSummary,
  parseLineQuantity,
  removeLineConfirmCopy,
  stepLineQuantity,
  validateLineQuantity,
  type EditableOrderLine,
} from './edit-order-line';

/** An untouched line on a live order — nothing picked, shipped or returned. */
const CLEAN: EditableOrderLine = {
  orderRequestLineId: 'line-1',
  itemId: 'item-1',
  name: 'Blue folders',
  requested: 10,
  fulfilled: 0,
  picked: 0,
  returned: 0,
};

const APPROVER = {
  status: 'pending_approval',
  requesterUserId: 'requester-1',
  viewerUserId: 'manager-1',
  viewerRole: 'manager' as Role,
  permissions: undefined,
  ordersModuleEnabled: true,
};

describe('canEditOrderLines — the SAME gate as adding (server shares one helper)', () => {
  it('is hidden on every status that freezes the order', () => {
    // loadEditableOrderHeader refuses these for add, update and remove alike.
    for (const status of ADD_LINES_BLOCKED_STATUSES) {
      expect(canEditOrderLines({ ...APPROVER, status })).toBe(false);
    }
  });

  it('is offered mid-pipeline, including during picking and staging', () => {
    for (const status of [
      'pending_approval',
      'approved',
      'pick_slip_generated',
      'picking_in_progress',
      'picking_complete',
      'packing_slip_generated',
      'staged_for_pickup',
      'staged_for_delivery',
      'backordered',
    ]) {
      expect(canEditOrderLines({ ...APPROVER, status })).toBe(true);
    }
  });

  it('lets the REQUESTER correct their own order without orders:approve', () => {
    expect(
      canEditOrderLines({
        ...APPROVER,
        viewerRole: 'viewer',
        permissions: new Set<Permission>([]),
        viewerUserId: 'requester-1',
      }),
    ).toBe(true);
  });

  it('hides it from a staffer who is neither requester nor approver', () => {
    expect(
      canEditOrderLines({
        ...APPROVER,
        viewerRole: 'staff',
        permissions: new Set<Permission>(['orders:request']),
        viewerUserId: 'someone-else',
      }),
    ).toBe(false);
  });

  it('hides it when the orders module is off', () => {
    expect(canEditOrderLines({ ...APPROVER, ordersModuleEnabled: false })).toBe(false);
  });
});

describe('lineQuantityFloor / describeQuantityFloor (U2, U3)', () => {
  it('floors an untouched line at one — zero means REMOVE, a different operation', () => {
    expect(lineQuantityFloor(CLEAN)).toBe(1);
    expect(describeQuantityFloor(CLEAN)).toBeNull();
  });

  it('floors at what was handed over', () => {
    const line = { ...CLEAN, fulfilled: 4 };
    expect(lineQuantityFloor(line)).toBe(4);
    expect(describeQuantityFloor(line)).toContain('handed over');
  });

  it('floors at what is staged, and says to unstage', () => {
    const line = { ...CLEAN, picked: 6 };
    expect(lineQuantityFloor(line)).toBe(6);
    expect(describeQuantityFloor(line)).toContain('Unstage');
  });

  it('takes the HIGHER of the two and explains that one', () => {
    // Staged above handed-over: the binding constraint is the staging, and the
    // note has to name it or the disabled "−" looks broken.
    const staged = { ...CLEAN, fulfilled: 2, picked: 7 };
    expect(lineQuantityFloor(staged)).toBe(7);
    expect(describeQuantityFloor(staged)).toContain('7 of these are already picked');

    const shipped = { ...CLEAN, fulfilled: 7, picked: 2 };
    expect(lineQuantityFloor(shipped)).toBe(7);
    expect(describeQuantityFloor(shipped)).toContain('7 of these have already been handed over');
  });
});

describe('stepLineQuantity', () => {
  it('never steps below the floor', () => {
    expect(stepLineQuantity(4, -1, 4)).toBe(4);
    expect(stepLineQuantity(5, -1, 4)).toBe(4);
  });

  it('clamps at the route cap so a pointless 400 is never round-tripped', () => {
    expect(stepLineQuantity(LINE_EDIT_MAX_QUANTITY, 1, 1)).toBe(LINE_EDIT_MAX_QUANTITY);
  });
});

describe('parseLineQuantity', () => {
  it('rejects everything the route would reject', () => {
    for (const bad of ['', '  ', '0', '-3', '2.5', 'abc', '1e3', '100001']) {
      expect(parseLineQuantity(bad)).toBeNull();
    }
  });

  it('accepts a whole number, ignoring surrounding space', () => {
    expect(parseLineQuantity(' 12 ')).toBe(12);
    expect(parseLineQuantity(String(LINE_EDIT_MAX_QUANTITY))).toBe(LINE_EDIT_MAX_QUANTITY);
  });
});

describe('validateLineQuantity — mirror of updateLineQuantity U1-U4', () => {
  it('REFUSES zero or negative (U1)', () => {
    const zero = validateLineQuantity(CLEAN, 0);
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.reason).toContain('remove the line instead');
    expect(validateLineQuantity(CLEAN, -2).ok).toBe(false);
  });

  it('REFUSES dropping below what was handed over, naming the amount (U2)', () => {
    const res = validateLineQuantity({ ...CLEAN, fulfilled: 6 }, 5);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('6');
  });

  it('REFUSES dropping below what is staged, and says to unstage (U3)', () => {
    const res = validateLineQuantity({ ...CLEAN, picked: 8 }, 7);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('unstage');
  });

  it('ALLOWS raising even on a line that is partly shipped and staged (U4)', () => {
    // Raising is the same act as adding more, so the floors must not apply.
    expect(validateLineQuantity({ ...CLEAN, fulfilled: 6, picked: 8 }, 25).ok).toBe(true);
  });

  it('allows lowering down TO the floor, not past it', () => {
    const line = { ...CLEAN, fulfilled: 3, picked: 5 };
    expect(validateLineQuantity(line, 5).ok).toBe(true);
    expect(validateLineQuantity(line, 4).ok).toBe(false);
  });
});

describe('canRemoveOrderLine — mirror of removeLine R1-R5', () => {
  const base = { line: CLEAN, totalLines: 3, itemHasOpenReservation: false };

  it('allows removing an untouched line from a multi-line order (R6)', () => {
    expect(canRemoveOrderLine(base).ok).toBe(true);
  });

  it('REFUSES when units were handed over (R1)', () => {
    const res = canRemoveOrderLine({ ...base, line: { ...CLEAN, fulfilled: 2 } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('handed over');
  });

  it('REFUSES when units are staged, and says to unstage (R2)', () => {
    const res = canRemoveOrderLine({ ...base, line: { ...CLEAN, picked: 2 } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('unstage them first');
  });

  it('REFUSES when returns are recorded against it (R3)', () => {
    const res = canRemoveOrderLine({ ...base, line: { ...CLEAN, returned: 1 } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('returns recorded');
  });

  it('REFUSES while stock is still reserved for the item (R4)', () => {
    // Reservations are keyed by (order, item) — deleting the line would leave
    // the hold dangling, which is invisible shrinkage.
    const res = canRemoveOrderLine({ ...base, itemHasOpenReservation: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('reserved');
  });

  it('REFUSES removing the LAST line — cancel the order instead (R5)', () => {
    const res = canRemoveOrderLine({ ...base, totalLines: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('cancel the order');
  });

  it('refuses in the SERVER ORDER when several rules bite at once', () => {
    // Staged AND reserved AND last: removeLine reports the staging first,
    // because that is the one the user can act on directly.
    const res = canRemoveOrderLine({
      line: { ...CLEAN, picked: 4 },
      totalLines: 1,
      itemHasOpenReservation: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('picked and staged');
  });

  it('refuses a line whose id never loaded — there is nothing to address', () => {
    expect(canRemoveOrderLine({ ...base, line: { ...CLEAN, orderRequestLineId: null } }).ok).toBe(
      false,
    );
  });
});

describe('removeLineConfirmCopy', () => {
  it('names the item and the quantity coming off', () => {
    const copy = removeLineConfirmCopy(CLEAN);
    expect(copy.title).toContain('Blue folders');
    expect(copy.message).toContain('10');
  });
});

describe('result copy', () => {
  it('states the before and after of a quantity change', () => {
    const msg = lineQuantitySummary(CLEAN, { quantity: 4, pickSlipStale: false });
    expect(msg).toContain('now 4');
    expect(msg).toContain('was 10');
  });

  it('appends the reprint instruction when a slip was already printed', () => {
    // A quantity change moves no created_at, so the screen's derived rule can
    // never see this — the route's verdict is the only signal.
    const msg = lineQuantitySummary(CLEAN, { quantity: 4, pickSlipStale: true });
    expect(msg).toContain('Generate it again');
    expect(lineRemovedSummary(CLEAN, { removedItemId: 'item-1', pickSlipStale: true })).toContain(
      'Generate it again',
    );
  });

  it('does not claim a change happened on a no-op', () => {
    expect(lineQuantitySummary(CLEAN, { quantity: 10, pickSlipStale: false })).toContain(
      'unchanged',
    );
  });
});

describe('describeLineEditError', () => {
  it('passes the service message straight through — it already says what to do', () => {
    expect(
      describeLineEditError(
        new Error(
          'API 409: {"error":"conflict","message":"3 of these are already picked and staged — unstage them or finish fulfilling this line before lowering the quantity below 3."}',
        ),
      ),
    ).toContain('unstage them');
  });

  it('translates a BARE code, which is all a 500 or 401 carries', () => {
    expect(describeLineEditError(new Error('API 500: {"error":"internal_error"}'))).toContain(
      'on our side',
    );
    expect(describeLineEditError(new Error('API 401: {"error":"unauthenticated"}'))).toContain(
      'Sign in again',
    );
  });
});

describe('lineEditErrorIsStale / lineEditErrorIsIndeterminate', () => {
  it('treats a dead session, a revoked grant and a vanished line as stale', () => {
    for (const status of [401, 403, 404]) {
      expect(lineEditErrorIsStale(new Error(`API ${status}: {"error":"x"}`))).toBe(true);
    }
  });

  it('keeps a 409 IN the sheet — it is usually a floor the user can answer', () => {
    // "3 of these are already picked" is fixed by typing a different number.
    // Closing the sheet would take the instruction away with it.
    expect(lineEditErrorIsStale(new Error('API 409: {"error":"conflict"}'))).toBe(false);
  });

  it('flags a request that never got an answer', () => {
    expect(lineEditErrorIsIndeterminate(new Error('Request timed out.'))).toBe(true);
    expect(lineEditErrorIsIndeterminate(new Error('API 409: {"error":"conflict"}'))).toBe(false);
  });
});

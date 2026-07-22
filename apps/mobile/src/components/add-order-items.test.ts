import type { Permission, Role } from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

import { listStatusPredicate } from '../lib/expected-items';
import {
  ADD_ITEMS_PAGE_SIZE,
  ADD_LINES_BLOCKED_STATUSES,
  ADD_LINES_MAX_LINES,
  ADD_LINES_MAX_QUANTITY,
  addedSummary,
  addItemsPickerPlan,
  addLinesErrorIsIndeterminate,
  addLinesErrorIsTerminal,
  addLinesErrorStatus,
  buildAddLinesPayload,
  canAddOrderItems,
  describeAddLinesError,
  derivePickSlipStale,
  isAddLinesBlockedStatus,
  shouldShowStalePickSlip,
  stepAddQuantity,
} from './add-order-items';

/** Baseline: an approver on a live order. Each test perturbs ONE field. */
const APPROVER = {
  status: 'pending_approval',
  requesterUserId: 'requester-1',
  viewerUserId: 'manager-1',
  viewerRole: 'manager' as Role,
  permissions: undefined,
  ordersModuleEnabled: true,
};

describe('canAddOrderItems — cosmetic mirror of OrderRequestsService.addLines', () => {
  it('hides the control on every status that freezes the order', () => {
    // These are exactly the statuses addLines answers with `conflict`.
    expect([...ADD_LINES_BLOCKED_STATUSES]).toEqual([
      'in_transit',
      'completed',
      'denied',
      'cancelled',
    ]);
    for (const status of ADD_LINES_BLOCKED_STATUSES) {
      expect(canAddOrderItems({ ...APPROVER, status })).toBe(false);
    }
  });

  it('shows the control mid-pipeline, including during picking and staging', () => {
    // Owner decision: adding IS allowed right up until the goods ship — the
    // already-printed pick slip just goes stale, which the screen surfaces.
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
      expect(canAddOrderItems({ ...APPROVER, status })).toBe(true);
    }
  });

  it('lets the REQUESTER add to their own order even without orders:approve', () => {
    // A viewer-role requester holds no approve grant, but addLines still
    // accepts them, so the button must appear.
    expect(
      canAddOrderItems({
        ...APPROVER,
        viewerRole: 'viewer',
        permissions: new Set<Permission>([]),
        viewerUserId: 'requester-1',
      }),
    ).toBe(true);
  });

  it('hides it from a non-requester who cannot approve orders', () => {
    // orders:request alone must NOT let someone grow another person's order.
    expect(
      canAddOrderItems({
        ...APPROVER,
        viewerRole: 'staff',
        permissions: new Set<Permission>(['orders:request']),
      }),
    ).toBe(false);
  });

  it('honors an override that GRANTS orders:approve to a non-requester', () => {
    expect(
      canAddOrderItems({
        ...APPROVER,
        viewerRole: 'staff',
        permissions: new Set<Permission>(['orders:approve']),
      }),
    ).toBe(true);
  });

  it('honors an override that REVOKES orders:approve from a manager', () => {
    // Effective permissions win over the static role default — the same rule
    // `can()` applies everywhere else.
    expect(
      canAddOrderItems({ ...APPROVER, permissions: new Set<Permission>(['orders:request']) }),
    ).toBe(false);
  });

  it('never matches a null requester against a null viewer', () => {
    // An external (non-member) order has requester_user_id = null. Treating
    // null === null as "you are the requester" would hand the control to a
    // signed-out/unknown viewer.
    expect(
      canAddOrderItems({
        ...APPROVER,
        requesterUserId: null,
        viewerUserId: null,
        viewerRole: 'viewer',
        permissions: new Set<Permission>([]),
      }),
    ).toBe(false);
  });

  it('hides it while the order is still loading, and when orders is off', () => {
    expect(canAddOrderItems({ ...APPROVER, status: null })).toBe(false);
    expect(canAddOrderItems({ ...APPROVER, ordersModuleEnabled: false })).toBe(false);
  });
});

describe('isAddLinesBlockedStatus', () => {
  it('treats an unknown/unloaded status as blocked (fail closed)', () => {
    expect(isAddLinesBlockedStatus(null)).toBe(true);
    expect(isAddLinesBlockedStatus('completed')).toBe(true);
    expect(isAddLinesBlockedStatus('approved')).toBe(false);
  });
});

describe('derivePickSlipStale', () => {
  it('is false when no pick slip was ever printed', () => {
    expect(
      derivePickSlipStale(null, [{ createdAt: '2026-07-22T10:00:00Z' }]),
    ).toBe(false);
  });

  it('is false when every line predates the slip', () => {
    expect(
      derivePickSlipStale('2026-07-22T12:00:00Z', [
        { createdAt: '2026-07-22T10:00:00Z' },
        { createdAt: '2026-07-22T11:59:59Z' },
      ]),
    ).toBe(false);
  });

  it('is true as soon as ONE line was created after the slip', () => {
    expect(
      derivePickSlipStale('2026-07-22T12:00:00Z', [
        { createdAt: '2026-07-22T10:00:00Z' },
        { createdAt: '2026-07-22T12:00:01Z' },
      ]),
    ).toBe(true);
  });

  it('ignores lines with an unreadable created_at rather than guessing stale', () => {
    expect(derivePickSlipStale('2026-07-22T12:00:00Z', [{ createdAt: null }])).toBe(false);
  });
});

describe('addItemsPickerPlan — the picker pre-empts every addLines rejection', () => {
  it('carries the default visibility predicate: active, never an unreceived phantom', () => {
    // Locked to listStatusPredicate('all') so the picker cannot drift from the
    // Items tabs. addLines explicitly rejects awaiting_first_receipt items, so
    // offering one would be a guaranteed 400.
    const pred = listStatusPredicate('all');
    const plan = addItemsPickerPlan('', 0);
    expect(plan.awaitingFirstReceipt).toBe(pred.awaitingFirstReceipt);
    expect(plan.awaitingFirstReceipt).toBe(false);
    expect(plan.lifecycle).toBe(pred.lifecycle);
    expect(plan.lifecycle).toBe('active');
  });

  it('pages 50 at a time from the given offset', () => {
    expect(ADD_ITEMS_PAGE_SIZE).toBe(50);
    expect(addItemsPickerPlan('', 0).range).toEqual({ from: 0, to: 49 });
    expect(addItemsPickerPlan('', 50).range).toEqual({ from: 50, to: 99 });
  });

  it('builds word-AND search groups across name/sku/barcode', () => {
    expect(addItemsPickerPlan('purple shirt', 0).orGroups).toEqual([
      'name.ilike."%purple%",sku.ilike."%purple%",barcode.ilike."%purple%"',
      'name.ilike."%shirt%",sku.ilike."%shirt%",barcode.ilike."%shirt%"',
    ]);
    expect(addItemsPickerPlan('   ', 0).orGroups).toEqual([]);
  });
});

describe('stepAddQuantity', () => {
  it('clamps at zero — stepping down past it deselects rather than going negative', () => {
    expect(stepAddQuantity(0, -1)).toBe(0);
    expect(stepAddQuantity(1, -1)).toBe(0);
  });

  it('clamps at the route zod ceiling so an over-max draft never round-trips', () => {
    expect(ADD_LINES_MAX_QUANTITY).toBe(100_000);
    expect(stepAddQuantity(ADD_LINES_MAX_QUANTITY, 1)).toBe(ADD_LINES_MAX_QUANTITY);
  });
});

describe('buildAddLinesPayload', () => {
  it('drops zero-quantity rows and emits one line per selected item', () => {
    expect(buildAddLinesPayload({ a: 2, b: 0, c: 1 })).toEqual({
      ok: true,
      lines: [
        { itemId: 'a', quantity: 2 },
        { itemId: 'c', quantity: 1 },
      ],
    });
  });

  it('refuses an empty selection locally instead of round-tripping a 400', () => {
    const res = buildAddLinesPayload({ a: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/at least one item/i);
  });

  it('refuses more than the 200-line route cap, telling the user what to do', () => {
    const draft: Record<string, number> = {};
    for (let i = 0; i < ADD_LINES_MAX_LINES + 1; i += 1) draft[`item-${i}`] = 1;
    const res = buildAddLinesPayload(draft);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('200');
  });

  it('floors and clamps quantities so the body always satisfies the zod schema', () => {
    const res = buildAddLinesPayload({ a: 2.7, b: ADD_LINES_MAX_QUANTITY + 5, c: -3 });
    expect(res).toEqual({
      ok: true,
      lines: [
        { itemId: 'a', quantity: 2 },
        { itemId: 'b', quantity: ADD_LINES_MAX_QUANTITY },
      ],
    });
  });
});

describe('addedSummary', () => {
  it('names new lines and topped-up lines separately', () => {
    // Without the merged count a user cannot tell why the line count did not
    // grow after adding an item that was already on the order.
    expect(addedSummary({ added: 2, merged: 1, pickSlipStale: false })).toBe(
      'Added 2 new lines and 1 existing line topped up.',
    );
    expect(addedSummary({ added: 1, merged: 0, pickSlipStale: false })).toBe('Added 1 new line.');
    expect(addedSummary({ added: 0, merged: 2, pickSlipStale: false })).toBe(
      'Added 2 existing lines topped up.',
    );
  });

  it('appends the reprint instruction when a pick slip is now stale', () => {
    const msg = addedSummary({ added: 1, merged: 0, pickSlipStale: true });
    expect(msg).toContain('Generate it again before picking.');
  });

  it('never appends the reprint instruction when no slip was printed', () => {
    expect(addedSummary({ added: 1, merged: 0, pickSlipStale: false })).not.toContain('pick slip');
  });
});

describe('describeAddLinesError', () => {
  it('prefers the server message, which names the offending item', () => {
    const e = new Error(
      'API 400: {"error":"validation_error","message":"Blue Pen isn\'t stocked at this order\'s warehouse."}',
    );
    expect(describeAddLinesError(e)).toBe("Blue Pen isn't stocked at this order's warehouse.");
  });

  it('replaces a BARE error code with actionable copy instead of leaking the slug', () => {
    // 500 responds {"error":"internal_error"} with NO message, so the raw
    // extractor would put the literal slug in front of the user.
    expect(describeAddLinesError(new Error('API 500: {"error":"internal_error"}'))).toBe(
      'Something went wrong on our side. Try again in a moment.',
    );
    expect(describeAddLinesError(new Error('API 401: {"error":"unauthenticated"}'))).toMatch(
      /Sign in again/,
    );
  });

  it('passes a network/timeout message through unchanged', () => {
    expect(
      describeAddLinesError(new Error('Request timed out. Check your connection and try again.')),
    ).toBe('Request timed out. Check your connection and try again.');
  });

  it('falls back to actionable copy when the thrown value carries nothing', () => {
    expect(describeAddLinesError(null)).toBe('Could not add the items. Please try again.');
  });
});

describe('addLinesErrorStatus / addLinesErrorIsTerminal', () => {
  it('reads the HTTP status out of the api() error string', () => {
    expect(addLinesErrorStatus(new Error('API 409: {"error":"conflict"}'))).toBe(409);
    expect(addLinesErrorStatus(new Error('Request timed out.'))).toBeNull();
    expect(addLinesErrorStatus(null)).toBeNull();
  });

  it('closes the sheet only when the viewer\'s picture of the order is stale', () => {
    // 401/403/404/409 cannot be fixed by editing the draft — the order shipped,
    // vanished, or the grant changed — so the screen must reload and re-gate.
    for (const status of [401, 403, 404, 409]) {
      expect(addLinesErrorIsTerminal(new Error(`API ${status}: {"error":"x"}`))).toBe(true);
    }
    // 400/429/500/timeout are recoverable in place, so the draft is preserved.
    for (const status of [400, 429, 500]) {
      expect(addLinesErrorIsTerminal(new Error(`API ${status}: {"error":"x"}`))).toBe(false);
    }
    expect(addLinesErrorIsTerminal(new Error('Request timed out.'))).toBe(false);
  });

  it('flags a status-less failure as indeterminate, never as a plain retry', () => {
    // addLines is NOT idempotent (one UPDATE per merged item plus one INSERT,
    // no transaction). api() aborts at 20s, which can land AFTER the server
    // committed, so re-submitting the same draft would apply every quantity a
    // second time. The sheet must close and send the user to the order.
    expect(addLinesErrorIsIndeterminate(new Error('Request timed out. Check your connection and try again.'))).toBe(
      true,
    );
    expect(addLinesErrorIsIndeterminate(new TypeError('Network request failed'))).toBe(true);
    // Anything that carried a status DID reach the server, so it is decided.
    for (const status of [400, 401, 409, 429, 500]) {
      expect(addLinesErrorIsIndeterminate(new Error(`API ${status}: {"error":"x"}`))).toBe(false);
    }
  });
});

describe('shouldShowStalePickSlip', () => {
  const BASE = {
    derived: false,
    pickSlipGeneratedAt: '2026-07-22T10:00:00Z',
    staleReportedForSlipAt: null as string | null,
    status: 'picking_in_progress' as string | null,
  };

  it('keeps the warning up after a merge-only add, which no line created_at can show', () => {
    // addLines UPDATEs quantity_requested on the existing row and inserts
    // nothing, so derivePickSlipStale reads false on the very next load and the
    // banner used to vanish one second after the success alert said to reprint.
    expect(
      shouldShowStalePickSlip({ ...BASE, staleReportedForSlipAt: '2026-07-22T10:00:00Z' }),
    ).toBe(true);
  });

  it('clears once the slip is actually regenerated', () => {
    // A reprint is the ONLY thing that moves pick_slip_generated_at, so the
    // carried-forward warning expires on its own rather than sticking forever.
    expect(
      shouldShowStalePickSlip({
        ...BASE,
        pickSlipGeneratedAt: '2026-07-22T11:30:00Z',
        staleReportedForSlipAt: '2026-07-22T10:00:00Z',
      }),
    ).toBe(false);
  });

  it('still shows for a genuinely newer line', () => {
    expect(shouldShowStalePickSlip({ ...BASE, derived: true })).toBe(true);
  });

  it('says nothing on an order whose contents are frozen', () => {
    // A reprint is moot once the goods are out the door or the order is dead.
    for (const status of ADD_LINES_BLOCKED_STATUSES) {
      expect(shouldShowStalePickSlip({ ...BASE, derived: true, status })).toBe(false);
      expect(
        shouldShowStalePickSlip({
          ...BASE,
          staleReportedForSlipAt: '2026-07-22T10:00:00Z',
          status,
        }),
      ).toBe(false);
    }
  });

  it('stays quiet when no slip was ever printed', () => {
    expect(
      shouldShowStalePickSlip({ ...BASE, pickSlipGeneratedAt: null, staleReportedForSlipAt: null }),
    ).toBe(false);
  });
});

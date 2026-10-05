import { describe, expect, it } from 'vitest';

import type { RestockOptionsLine } from '@stockpilot/core';

import type { MobileReturnListRow, MobileReturnWorkbench } from './returns-api';
import {
  allChoicesOffered,
  approvalDecision,
  changedDecisions,
  initialChoices,
  processButtonLabel,
  processingHint,
  returnRowItems,
  returnRowMeta,
  returnRowTitle,
  returnRowWaiting,
  returnStatusTone,
  stepOutcomeMessage,
  whatHappensLines,
  workbenchActions,
} from './returns-view';

const R31 = '44444444-4444-4444-8444-444444444444';

function row(over: Partial<MobileReturnListRow> = {}): MobileReturnListRow {
  return {
    id: 'abcdef12-0000-4000-8000-000000000000',
    returnNumber: 'RMA-1',
    status: 'approved',
    source: 'requester',
    reasonCode: null,
    orderRequestId: 'ffffffff-0000-4000-8000-000000000000',
    orderNumber: 103,
    requesterName: 'Pat Lee',
    requesterEmail: null,
    createdAt: '2026-10-01T00:00:00Z',
    approvedAt: '2026-10-02T00:00:00Z',
    waitingDays: 9,
    lineCount: 3,
    unitCount: 3,
    items: [
      { itemId: 'i1', name: 'Walk Shirt', variant: 'Size M', quantity: 1, thumbUrl: null },
      { itemId: 'i2', name: 'Cap', variant: null, quantity: 2, thumbUrl: null },
    ],
    moreItems: 1,
    type: 'return',
    ...over,
  };
}

function restock(over: Partial<RestockOptionsLine> = {}): RestockOptionsLine {
  return {
    returnLineId: 'l1',
    itemId: 'i1',
    quantity: 1,
    disposition: 'restock',
    applied: false,
    plan: null,
    case: 'single_source',
    notRecordedReason: null,
    sources: [{ locationId: R31, name: '31-C', kind: 'rack', type: 'shelf', drawn: 1, restored: 0, remaining: 1, valid: true, reason: null }],
    offerOriginal: true,
    offerSourceIds: [],
    preselect: 'original',
    ...over,
  };
}

function wb(status: string, line: Partial<RestockOptionsLine> = {}, manage = true): MobileReturnWorkbench {
  return {
    organizationId: 'o',
    return: {
      id: 'r1',
      returnNumber: 'RMA-1',
      status,
      source: 'internal',
      reasonCode: null,
      notes: null,
      denialReason: null,
      orderRequestId: 'o1',
      orderNumber: 103,
      warehouseId: null,
      warehouseName: null,
      requesterName: null,
      requesterEmail: null,
      createdAt: '',
      approvedAt: null,
      receivedAt: null,
      closedAt: null,
      deniedAt: null,
      requestedByName: null,
      approvedByName: null,
      receivedByName: 'Dana',
      closedByName: 'Dana',
      deniedByName: null,
    },
    revision: 0,
    planSeq: 2,
    createdOnCounter: false,
    lines: [
      {
        id: 'l1',
        orderRequestLineId: 'ol1',
        itemId: 'i1',
        quantity: 1,
        disposition: 'restock',
        applied: false,
        item: { name: 'Walk Shirt', sku: null, variant: 'Size M', deleted: false, imageUrl: null, thumbUrl: null },
        restock: restock(line),
        legs: [],
        inboundState: 'Waiting',
      },
    ],
    chain: [],
    viewer: { canManageReturns: manage, canApproveOrders: true, canReadDecisions: true },
    actions: { primary: null, secondary: [], readOnlyReason: null },
  };
}

describe('list rows', () => {
  it('title, meta, items and the waiting age', () => {
    expect(returnRowTitle(row())).toBe('RMA-1');
    expect(returnRowTitle(row({ returnNumber: null }))).toBe('ABCDEF12');
    expect(returnRowMeta(row())).toBe('SO-000103 · Pat Lee');
    expect(returnRowMeta(row({ orderNumber: null, requesterName: null, source: 'internal' }))).toBe('FFFFFFFF · Staff');
    expect(returnRowItems(row())).toBe('Walk Shirt · Size M ×1, Cap ×2 +1');
    expect(returnRowWaiting(row())).toEqual({ label: 'waiting 9 days', overdue: false });
    expect(returnRowWaiting(row({ waitingDays: 14 }))).toEqual({ label: 'waiting 14 days', overdue: true });
    expect(returnRowWaiting(row({ status: 'requested' }))).toBeNull();
    expect(returnStatusTone('requested')).toBe('warn');
    expect(returnStatusTone('denied')).toBe('crit');
  });
});

describe('workbench actions under the connection state', () => {
  it('offline disables every action with "Needs a connection."', () => {
    const a = workbenchActions(wb('approved'), { itemIsHere: false, online: false, busy: false });
    expect(a.primary).toBe('receive');
    expect(a.disabledReason).toBe('Needs a connection.');
  });

  it('online with the switch on offers "Approve and receive"', () => {
    const a = workbenchActions(wb('requested'), { itemIsHere: true, online: true, busy: false });
    expect(a.primary).toBe('approve_and_receive');
    expect(a.disabledReason).toBeNull();
  });

  it('a closed RMA has nothing to disable; a reader without manage sees why', () => {
    expect(workbenchActions(wb('closed'), { itemIsHere: false, online: false, busy: false }).disabledReason).toBeNull();
    expect(workbenchActions(wb('approved', {}, false), { itemIsHere: false, online: true, busy: false }).readOnlyReason).toBe(
      "You don't have permission to manage returns.",
    );
  });
});

describe('destinations and bodies', () => {
  it('preselects the original rack (C1, valid) and approves every line explicitly', () => {
    const w = wb('requested');
    const choices = initialChoices(w);
    expect(choices.l1).toEqual({ disposition: 'restock', target: 'original', locationId: null });
    expect(allChoicesOffered(w, choices)).toBe(true);
    expect(approvalDecision(w, choices)).toEqual({ lines: [{ returnLineId: 'l1', disposition: 'restock', restock: { target: 'original' } }] });
    expect(whatHappensLines(w, choices)).toEqual([
      'Nothing moves now. The returned item stays out until it is received.',
      'When processed, the returned item goes back to 31-C.',
    ]);
  });

  it('process sends only a changed destination, and names the rack on its button', () => {
    const w = wb('received', { plan: { disposition: 'restock', target: 'original', locationId: null, basis: 'single_source', seq: 2 } });
    const same = initialChoices(w);
    expect(changedDecisions(w, same)).toEqual([]);
    expect(processButtonLabel(w, same)).toBe('Return to 31-C');
    expect(processingHint(w.lines[0]!, same.l1!)).toBe('Put it back on 31-C now. StockPilot records it there when you tap this.');
    const staging = { l1: { disposition: 'restock' as const, target: 'staging' as const, locationId: null } };
    expect(changedDecisions(w, staging)).toEqual([{ returnLineId: 'l1', disposition: 'restock', restock: { target: 'staging' } }]);
    expect(processButtonLabel(w, staging)).toBe('Leave in Staging');
  });

  it('a rack that failed revalidation is not offered: Staging opens preselected and the rack choice blocks submit', () => {
    const w = wb('received', {
      plan: { disposition: 'restock', target: 'original', locationId: null, basis: 'single_source', seq: 2 },
      offerOriginal: false,
      sources: [{ locationId: R31, name: '31-C', kind: 'rack', type: 'shelf', drawn: 1, restored: 0, remaining: 1, valid: false, reason: 'archived' }],
    });
    const choices = initialChoices(w);
    expect(choices.l1!.target).toBe('staging');
    expect(allChoicesOffered(w, { l1: { disposition: 'restock', target: 'original', locationId: null } })).toBe(false);
  });
});

describe('step outcome words', () => {
  it('done, already and refused', () => {
    const w = wb('received');
    expect(stepOutcomeMessage({ step: 'approve', outcome: 'done' }, w, true)).toBe('Approved and received.');
    expect(stepOutcomeMessage({ step: 'receive', outcome: 'already' }, w, false)).toBe('Already marked received by Dana.');
    expect(stepOutcomeMessage({ step: 'process', outcome: 'already' }, w, false)).toBe('Already closed by Dana.');
    expect(stepOutcomeMessage({ step: 'process', outcome: 'refused', message: 'Original rack is no longer available.' }, w, false)).toBe(
      'Original rack is no longer available.',
    );
  });
});

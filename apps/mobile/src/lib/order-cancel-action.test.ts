import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { cancelReasonForPost, phoneOrderCancel } from './order-cancel-action';

/**
 * L93: on the phone a requester could not cancel their own order while it
 * waited for approval (the web could), and an approver could cancel only a
 * backordered order. The phone now offers Cancel by core's orderCancelOffer,
 * the web order page's rule (and the service's): an approver at every open
 * status, the requester only while their order waits for approval. Both go
 * through /api/v1/orders/[id]/transition with the web's optional reason.
 */

const OPEN = [
  'pending_approval',
  'approved',
  'pick_slip_generated',
  'picking_in_progress',
  'picking_complete',
  'packing_slip_generated',
  'staged_for_pickup',
  'staged_for_delivery',
  'in_transit',
  'backordered',
];

describe('phoneOrderCancel', () => {
  it('the requester: Cancel request, only while their order waits for approval, in the web words', () => {
    const c = phoneOrderCancel({ status: 'pending_approval', canApproveOrders: false, isOwnRequest: true, canRequestOrders: true });
    expect(c).toEqual({
      label: 'Cancel request',
      confirmTitle: 'Cancel this order request?',
      confirmMessage:
        'The request is marked cancelled and any stock reservations attached to it are released back to available stock. The request stays on the record for the audit trail. Reason (optional):',
      confirmLabel: 'Cancel request',
      keepLabel: 'Keep request',
    });
    for (const status of OPEN.filter((s) => s !== 'pending_approval')) {
      expect(phoneOrderCancel({ status, canApproveOrders: false, isOwnRequest: true, canRequestOrders: true })).toBeNull();
    }
  });

  it('an approver: Cancel order at every open status, never on a closed one', () => {
    for (const status of OPEN) {
      const c = phoneOrderCancel({ status, canApproveOrders: true, isOwnRequest: false, canRequestOrders: true });
      expect(c?.label).toBe('Cancel order');
      expect(c?.keepLabel).toBe('Keep order');
    }
    for (const status of ['completed', 'denied', 'cancelled']) {
      expect(phoneOrderCancel({ status, canApproveOrders: true, isOwnRequest: true, canRequestOrders: true })).toBeNull();
    }
  });

  it('a backordered order keeps its own words: delivered items are not restocked', () => {
    expect(phoneOrderCancel({ status: 'backordered', canApproveOrders: true, isOwnRequest: false, canRequestOrders: true })?.confirmMessage).toBe(
      'The order is voided. Already-delivered items are NOT restocked; the hold on the remaining items is released. Reason (optional):',
    );
  });

  // Desk check F3: every cancel needs orders:request (svc.cancel asserts it
  // before any rule), so without it nothing is offered, to anyone.
  it('without orders:request: nothing, for an approver or the requester', () => {
    for (const status of OPEN) {
      expect(
        phoneOrderCancel({ status, canApproveOrders: true, isOwnRequest: true, canRequestOrders: false }),
      ).toBeNull();
    }
    expect(
      phoneOrderCancel({
        status: 'pending_approval',
        canApproveOrders: false,
        isOwnRequest: true,
        canRequestOrders: false,
      }),
    ).toBeNull();
  });

  it('someone else, or no status yet: nothing', () => {
    expect(phoneOrderCancel({ status: 'pending_approval', canApproveOrders: false, isOwnRequest: false, canRequestOrders: true })).toBeNull();
    expect(phoneOrderCancel({ status: null, canApproveOrders: true, isOwnRequest: true, canRequestOrders: true })).toBeNull();
  });
});

describe('cancelReasonForPost', () => {
  it('trimmed, left out when empty, at most 500 characters (the route takes 500)', () => {
    expect(cancelReasonForPost('  wrong items  ')).toBe('wrong items');
    expect(cancelReasonForPost('   ')).toBeUndefined();
    expect(cancelReasonForPost(undefined)).toBeUndefined();
    expect(cancelReasonForPost('x'.repeat(600))).toHaveLength(500);
  });
});

describe('order/[id].tsx wiring (L93)', () => {
  const screen = readFileSync(path.resolve(__dirname, '../../app/order/[id].tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // Mutation caught: the offer decided on the screen again (by status or
  // role), or the effective orders:request left out (desk check F3).
  it('offers Cancel through the tested rule, with the effective approve, request and the requester', () => {
    expect(screen).toMatch(
      /const cancelOffer = phoneOrderCancel\(\{\s*status: st,\s*canApproveOrders: rpApprove,\s*isOwnRequest: !!order\?\.requesterUserId && order\.requesterUserId === userId,\s*canRequestOrders: role !== null && can\(\{ role: role as Role, permissions \}, 'orders:request'\),\s*\}\);/,
    );
    expect(screen).toMatch(/\{cancelOffer \? \(/);
    expect(screen).toContain("actionBtn(cancelOffer.label, 'cancelorder', () => promptCancel(cancelOffer), 'danger')");
  });

  // Mutation caught: the reason dropped, or a second Cancel left in the backordered block.
  it('confirms with the optional reason and posts the transition once', () => {
    expect(screen).toMatch(/action: 'cancel', reason: cancelReasonForPost\(reason\)/);
    expect(screen.match(/action: 'cancel'/g)).toHaveLength(1);
  });

  // Review (2026-10-05, Medium): at AX5 the new Cancel request read "Cancel
  // reque" on the iPhone, with the lower half of every glyph cut on both
  // devices (s1-test AX5 shots), and Add items above it the same. actionBtn
  // draws every order action through styles.addBtn, which had a FIXED
  // `height: 44` around an uncapped Mono label. The Dynamic Type policy pairs
  // text with a minimum height, never a fixed one, and lets the label wrap.
  it('the order action buttons grow with the text: a minimum height, never a fixed one, and a label that wraps', () => {
    const addBtn = screen.match(/\n {2}addBtn: \{[^}]*\}/)?.[0] ?? '';
    expect(addBtn).toMatch(/minHeight: 44,/);
    expect(addBtn).toMatch(/paddingVertical: 10,/);
    expect(addBtn).not.toMatch(/[^A-Za-z]height: 44/);
    const helper = screen.slice(screen.indexOf('const actionBtn = ('), screen.indexOf('async function uploadOne('));
    expect(helper).toContain('styles.addBtn');
    expect(helper).toMatch(
      /<Mono size=\{13\} color=\{fg\} style=\{\{ flexShrink: 1, textAlign: 'center' \}\}>\s*\{label\}\s*<\/Mono>/,
    );
  });
});

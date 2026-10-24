import { describe, expect, it } from 'vitest';

import { ROLES, type Role } from '../constants/roles';

import {
  RECEIVE_GATE_CHECKING_COPY,
  RECEIVE_GATE_OFFLINE_COPY,
  RECEIVE_GATE_UNKNOWN_COPY,
  RECEIVE_MANAGER_POSTS_COPY,
  RECEIVE_POST_MANAGER_ONLY_COPY,
  receivingGate,
} from './receiving-gate';

const MANAGERS: Role[] = ['owner', 'admin', 'manager'];
const BELOW: Role[] = ['staff', 'viewer'];

/** Every combination of the four flags, for one role. */
function combos(role: Role) {
  const out: Array<{
    role: Role;
    canAdjust: boolean;
    canReadPo: boolean;
    canManagePo: boolean;
    receivingOn: boolean;
  }> = [];
  for (const canAdjust of [false, true])
    for (const canReadPo of [false, true])
      for (const canManagePo of [false, true])
        for (const receivingOn of [false, true])
          out.push({ role, canAdjust, canReadPo, canManagePo, receivingOn });
  return out;
}

describe('receivingGate', () => {
  it('covers every role and every combination of the four flags (80 cases)', () => {
    const all = ROLES.flatMap(combos);
    expect(all).toHaveLength(80);
    for (const input of all) {
      const manager = MANAGERS.includes(input.role);
      const g = receivingGate(input);
      expect(g.canPostReceipt, JSON.stringify(input)).toBe(manager && input.canAdjust);
      expect(g.canRecordChecklist, JSON.stringify(input)).toBe(
        manager && input.canAdjust && input.canReadPo && input.receivingOn,
      );
      expect(g.canPublishChecklist, JSON.stringify(input)).toBe(
        manager && input.canManagePo && input.receivingOn,
      );
      expect(g.canAddPoFile, JSON.stringify(input)).toBe(input.canManagePo);
    }
  });

  // Mutation caught: posting gated on stock:adjust alone (the old web and
  // phone rule). Staff hold stock:adjust by default, so they saw Receive and
  // the ledger refused them.
  it('staff and viewers never post a receipt or record a checklist, whatever their permissions', () => {
    for (const role of BELOW) {
      for (const input of combos(role)) {
        const g = receivingGate(input);
        expect(g.canPostReceipt).toBe(false);
        expect(g.canRecordChecklist).toBe(false);
        expect(g.canPublishChecklist).toBe(false);
      }
    }
  });

  // Mutation caught: the publisher floor on stock:adjust (Design A's single
  // floor). Publishing is purchasing configuration: purchase_orders:manage.
  it('publishing follows purchase_orders:manage, not stock:adjust', () => {
    expect(
      receivingGate({
        role: 'manager',
        canAdjust: true,
        canReadPo: true,
        canManagePo: false,
        receivingOn: true,
      }).canPublishChecklist,
    ).toBe(false);
    expect(
      receivingGate({
        role: 'manager',
        canAdjust: false,
        canReadPo: true,
        canManagePo: true,
        receivingOn: true,
      }).canPublishChecklist,
    ).toBe(true);
  });

  it('a viewer granted purchase_orders:manage may add PO files but never posts, records or publishes', () => {
    expect(
      receivingGate({
        role: 'viewer',
        canAdjust: false,
        canReadPo: true,
        canManagePo: true,
        receivingOn: true,
      }),
    ).toEqual({
      canPostReceipt: false,
      canRecordChecklist: false,
      canPublishChecklist: false,
      canAddPoFile: true,
    });
  });

  it('with receiving off a manager may still post (the receive flow gates the module) but not record or publish', () => {
    expect(
      receivingGate({
        role: 'admin',
        canAdjust: true,
        canReadPo: true,
        canManagePo: true,
        receivingOn: false,
      }),
    ).toEqual({
      canPostReceipt: true,
      canRecordChecklist: false,
      canPublishChecklist: false,
      canAddPoFile: true,
    });
  });

  it('a manager whose purchase_orders:read was revoked posts but does not record', () => {
    const g = receivingGate({
      role: 'manager',
      canAdjust: true,
      canReadPo: false,
      canManagePo: true,
      receivingOn: true,
    });
    expect(g.canPostReceipt).toBe(true);
    expect(g.canRecordChecklist).toBe(false);
  });

  it('says who posts in plain words', () => {
    expect(RECEIVE_MANAGER_POSTS_COPY).toBe('A manager posts receipts.');
    // Review 2026-10-24: the refusal said the same thing twice ("Only a
    // manager can post a receipt. A manager posts receipts.").
    expect(RECEIVE_POST_MANAGER_ONLY_COPY).toBe('Only a manager can post a receipt.');
    expect(RECEIVE_POST_MANAGER_ONLY_COPY).not.toContain(RECEIVE_MANAGER_POSTS_COPY);
    expect(RECEIVE_GATE_CHECKING_COPY).toBe('Checking who can post receipts…');
    // Desk check F10(c): shown to anyone offline with nothing remembered, a
    // manager included, so it never says who posts.
    expect(RECEIVE_GATE_OFFLINE_COPY).toBe('Posting needs a connection.');
    expect(RECEIVE_GATE_OFFLINE_COPY).not.toContain(RECEIVE_MANAGER_POSTS_COPY);
    expect(RECEIVE_GATE_UNKNOWN_COPY).toMatch(/^Could not check/);
  });
});

import { describe, expect, it } from 'vitest';

import {
  ITEM_HOLDS_STOCK_COPY,
  ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY,
  ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
  ORDER_WAREHOUSE_WRITE_REFUSED_COPY,
  dbGuardHint,
  dbPermissionFor,
  dbPermissionRefusedCopy,
  type DbPermissionAction,
} from './db-guard-copy';
import * as core from '../index';

describe('dbGuardHint', () => {
  it('names each 0395 refusal by its SQLSTATE and hint together', () => {
    expect(dbGuardHint({ code: '42501', hint: 'requester_pending_only' })).toBe('requester_pending_only');
    expect(dbGuardHint({ code: '42501', hint: 'permission' })).toBe('permission');
    expect(dbGuardHint({ code: '23514', hint: 'item_holds_stock' })).toBe('item_holds_stock');
  });

  it('is null for a hint under another SQLSTATE, another hint, or no error', () => {
    expect(dbGuardHint({ code: 'P0001', hint: 'permission' })).toBeNull();
    expect(dbGuardHint({ code: '23514', hint: 'permission' })).toBeNull();
    expect(dbGuardHint({ code: '42501', hint: 'item_holds_stock' })).toBeNull();
    expect(dbGuardHint({ code: '42501', hint: 'warehouse_write' })).toBeNull();
    expect(dbGuardHint({ code: '42501', hint: null })).toBeNull();
    expect(dbGuardHint(null)).toBeNull();
    expect(dbGuardHint(undefined)).toBeNull();
  });
});

describe('the 0395 refusal words', () => {
  it('names the permission each gated action needs, as Settings > Roles names it', () => {
    const actions: DbPermissionAction[] = [
      'adjust',
      'transfer',
      'count_post',
      'receipt_post',
      'receipt_reverse',
      'kit_assemble',
    ];
    expect(actions.map((a) => `${a}=${dbPermissionFor(a)}`)).toEqual([
      'adjust=stock:adjust',
      'transfer=stock:transfer',
      'count_post=stock:adjust',
      'receipt_post=stock:adjust',
      'receipt_reverse=stock:adjust',
      'kit_assemble=bundles:manage',
    ]);
    expect(dbPermissionRefusedCopy('adjust')).toBe(
      'Adjusting stock needs the Adjust on-hand permission. Ask an admin if you need it.',
    );
    expect(dbPermissionRefusedCopy('transfer')).toBe(
      'Moving stock needs the Transfer stock permission. Ask an admin if you need it.',
    );
    expect(dbPermissionRefusedCopy('kit_assemble')).toBe(
      'Assembling a kit needs the Manage bundles permission. Ask an admin if you need it.',
    );
  });

  it('says what to do in plain words, with no code word and never "book"', () => {
    const all = [
      ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY,
      ORDER_WAREHOUSE_WRITE_REFUSED_COPY,
      ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
      ITEM_HOLDS_STOCK_COPY,
      ...(['adjust', 'transfer', 'count_post', 'receipt_post', 'receipt_reverse', 'kit_assemble'] as const).map(
        dbPermissionRefusedCopy,
      ),
    ];
    for (const s of all) {
      expect(s).toMatch(/^[A-Z].*\.$/);
      expect(s).not.toMatch(/_|forbidden|42501|23514|\bbook\b/i);
    }
    // What makes the item deletable, as the trigger decides it: nothing on
    // record and nothing on any location. Moving stock keeps it on the item,
    // so a move is never offered; and an item with 0 on record can still
    // hold stock on a location, so the sentence never says "still has stock
    // on record".
    expect(ITEM_HOLDS_STOCK_COPY).toBe(
      'This item still holds stock, so it cannot be deleted. It can be deleted once it has no stock on record and none on any location: adjust its stock to zero or write it off first.',
    );
    expect(ITEM_HOLDS_STOCK_COPY).not.toMatch(/\bmove\b|still has stock on record/i);
    expect(ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY).toBe(
      'Only a pending order can be cancelled by the person who placed it. Ask someone who approves orders to cancel it.',
    );
    // L129a (test stage): an approver outside the order's warehouse was told
    // "User does not have write access to warehouse <uuid>." The sentence names
    // no id. Review (2026-10-05): it names someone the person can find (they
    // cannot see the order's warehouse, so "someone who works there" named
    // nobody they could reach), and "you can't change it" holds for every
    // change, Cancel included: the order service now checks the warehouse on
    // an approver's cancel too.
    expect(ORDER_WAREHOUSE_WRITE_REFUSED_COPY).toBe(
      "This order is in a warehouse you don't work in, so you can't change it. Ask a manager.",
    );
    expect(ORDER_WAREHOUSE_WRITE_REFUSED_COPY).not.toMatch(/[0-9a-f]{8}-|access to warehouse|works there/i);
    // Review (2026-10-05): a failed read of the caller's own warehouse access
    // is not a refusal. It claims no scope ("a warehouse you don't work in"
    // would be false for someone acting in their own) and asks for another try.
    expect(ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY).toBe(
      "Your warehouse access couldn't be checked just now, so nothing was changed. Try again.",
    );
    expect(ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY).not.toMatch(/don't work in|can't change/i);
  });

  it('is exported from the package entry point', () => {
    expect(core.dbGuardHint).toBe(dbGuardHint);
    expect(core.ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY).toBe(ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY);
    expect(core.ITEM_HOLDS_STOCK_COPY).toBe(ITEM_HOLDS_STOCK_COPY);
    expect(core.ORDER_WAREHOUSE_WRITE_REFUSED_COPY).toBe(ORDER_WAREHOUSE_WRITE_REFUSED_COPY);
    expect(core.ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY).toBe(ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY);
    expect(core.dbPermissionRefusedCopy).toBe(dbPermissionRefusedCopy);
  });
});

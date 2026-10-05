import { describe, expect, it } from 'vitest';

import {
  ITEM_HOLDS_STOCK_COPY,
  ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY,
  dbGuardHint,
  dbPermissionFor,
  dbPermissionRefusedCopy,
  type DbPermissionAction,
} from './db-guard-copy';
import * as core from '../index';

describe('dbGuardHint', () => {
  it('names each 0396 refusal by its SQLSTATE and hint together', () => {
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

describe('the 0396 refusal words', () => {
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
      ITEM_HOLDS_STOCK_COPY,
      ...(['adjust', 'transfer', 'count_post', 'receipt_post', 'receipt_reverse', 'kit_assemble'] as const).map(
        dbPermissionRefusedCopy,
      ),
    ];
    for (const s of all) {
      expect(s).toMatch(/^[A-Z].*\.$/);
      expect(s).not.toMatch(/_|forbidden|42501|23514|\bbook\b/i);
    }
    expect(ITEM_HOLDS_STOCK_COPY).toContain('stock on record');
    expect(ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY).toBe(
      'Only a pending order can be cancelled by the person who placed it. Ask someone who approves orders to cancel it.',
    );
  });

  it('is exported from the package entry point', () => {
    expect(core.dbGuardHint).toBe(dbGuardHint);
    expect(core.ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY).toBe(ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY);
    expect(core.ITEM_HOLDS_STOCK_COPY).toBe(ITEM_HOLDS_STOCK_COPY);
    expect(core.dbPermissionRefusedCopy).toBe(dbPermissionRefusedCopy);
  });
});

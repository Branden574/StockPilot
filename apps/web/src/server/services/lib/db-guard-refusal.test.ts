import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  ITEM_HOLDS_STOCK_COPY,
  ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY,
  dbPermissionRefusedCopy,
} from '@stockpilot/core';

import { ServiceError } from '../context';
import { dbGuardRefusal } from './db-guard-refusal';

describe('dbGuardRefusal (0396 hints)', () => {
  it('maps the requester window to a 403 with the cancel sentence', () => {
    const e = dbGuardRefusal({ code: '42501', hint: 'requester_pending_only' });
    expect(e).toBeInstanceOf(ServiceError);
    expect(e?.code).toBe('forbidden');
    expect(e?.message).toBe(ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY);
  });

  it('maps a missing permission to a 403 naming what the action needs', () => {
    const e = dbGuardRefusal({ code: '42501', hint: 'permission' }, 'receipt_post');
    expect(e?.code).toBe('forbidden');
    expect(e?.message).toBe(dbPermissionRefusedCopy('receipt_post'));
    expect(e?.message).toBe('Receiving stock needs the Adjust on-hand permission. Ask an admin if you need it.');
    expect(dbGuardRefusal({ code: '42501', hint: 'permission' })?.message).toBe(
      "You don't have permission to do this.",
    );
  });

  it('maps an item that holds stock to a 400 with the stock-on-record sentence', () => {
    const e = dbGuardRefusal({ code: '23514', hint: 'item_holds_stock' });
    expect(e?.code).toBe('validation_error');
    expect(e?.message).toBe(ITEM_HOLDS_STOCK_COPY);
  });

  it('leaves every other error to the call site', () => {
    expect(dbGuardRefusal({ code: '42501', hint: 'warehouse_write' })).toBeNull();
    expect(dbGuardRefusal({ code: '42501', hint: null })).toBeNull();
    expect(dbGuardRefusal({ code: 'P0001', hint: 'permission' })).toBeNull();
    expect(dbGuardRefusal(null)).toBeNull();
  });
});

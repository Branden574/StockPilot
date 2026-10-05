import { describe, expect, it } from 'vitest';

import { mapReturnError, RETURN_ERROR_TABLE, returnErrorKey, restockProblemWords } from './return-error-map';

describe('the returns error map', () => {
  // One row per arm: each hint maps to its own entry, and only to it.
  it.each(Object.entries(RETURN_ERROR_TABLE))('maps hint %s to its entry', (hint, entry) => {
    const mapped = mapReturnError({ code: 'P0001', hint, message: 'anything at all' });
    expect(mapped.reason).toBe(hint);
    expect(mapped.code).toBe(entry.code);
    expect(mapped.status).toBe(entry.status);
    expect(mapped.message).toBe(entry.message);
  });

  it('pins the plan 3.11 statuses for the main arms', () => {
    const status = (hint: string) => mapReturnError({ hint }).status;
    expect(status('unauthenticated')).toBe(401);
    expect(status('return_not_found')).toBe(404);
    expect(status('returns_manage')).toBe(403);
    expect(status('orders_approve')).toBe(403);
    expect(status('warehouse_write')).toBe(403);
    expect(status('invalid_status_transition')).toBe(409);
    expect(status('return_changed')).toBe(409);
    expect(status('return_plan_changed')).toBe(409);
    expect(status('idempotency_conflict')).toBe(409);
    expect(status('restock_location_unavailable')).toBe(400);
    expect(status('restock_location_not_offered')).toBe(400);
    expect(status('exchange_not_available')).toBe(400);
    expect(status('return_close_through_rpc')).toBe(403);
    expect(mapReturnError({ hint: 'return_number_unavailable' }).retryable).toBe(true);
  });

  it('prefers the hint over the SQLSTATE (specific before general)', () => {
    expect(mapReturnError({ code: '55P03', hint: 'return_changed' }).reason).toBe('return_changed');
    expect(mapReturnError({ code: '42501', hint: 'warehouse_write', message: 'forbidden' }).reason).toBe('warehouse_write');
  });

  it('never maps by message text: a bare token with no hint is an internal error (desk check F7)', () => {
    // The frozen paths' bare tokens reach the app only with a hint now
    // (close_return and the create raise them again); without one, nothing
    // is guessed from the words.
    expect(returnErrorKey({ code: 'P0001', message: 'return_exceeds_fulfilled' })).toBeNull();
    expect(returnErrorKey({ code: '42501', message: 'forbidden' })).toBeNull();
    expect(returnErrorKey({ code: 'P0001', message: 'invalid_status_transition' })).toBeNull();
    expect(mapReturnError({ code: '42501', message: 'forbidden' })).toMatchObject({ reason: 'internal_error', status: 500 });
    expect(returnErrorKey({ message: 'new row violates return_exceeds_fulfilled' })).toBeNull();
    expect(returnErrorKey({ hint: 'something_new', message: 'return_changed' })).toBeNull();
    // The re-raised forms map by their hint.
    expect(returnErrorKey({ code: '42501', hint: 'returns_manage', message: 'forbidden' })).toBe('returns_manage');
    expect(returnErrorKey({ code: 'P0001', hint: 'return_exceeds_fulfilled', message: 'return_exceeds_fulfilled' })).toBe('return_exceeds_fulfilled');
  });

  it('a rack the closer may not stock is its own refusal, never "no permission to manage returns" (desk check F7)', () => {
    const m = mapReturnError({
      code: '42501',
      hint: 'restock_location_forbidden',
      message: 'restock_location_forbidden',
      details: '{"rule": "location_write", "locationId": "00000000-0000-4000-8000-000000000001"}',
    });
    expect(m).toMatchObject({ reason: 'restock_location_forbidden', code: 'forbidden', status: 403 });
    expect(m.message).toBe("That rack is in a warehouse you can't stock. Leave the item in Staging or ask a manager.");
    expect(m.message).not.toBe(mapReturnError({ hint: 'returns_manage' }).message);
    expect(m.detail).toEqual({ rule: 'location_write', locationId: '00000000-0000-4000-8000-000000000001' });
    expect(restockProblemWords('location_write')).toBe("(in a warehouse you can't stock)");
    // The bare permission token is no longer a key of its own.
    expect(Object.prototype.hasOwnProperty.call(RETURN_ERROR_TABLE, 'forbidden')).toBe(false);
  });

  it('answers busy for a lock wait or a statement timeout with no known hint', () => {
    expect(mapReturnError({ code: '55P03', message: 'canceling statement due to lock timeout' })).toMatchObject({
      reason: 'busy',
      status: 409,
      retryable: true,
    });
    expect(mapReturnError({ code: '57014' }).reason).toBe('busy');
  });

  it('answers a generic internal error for anything else, never the raw text', () => {
    const m = mapReturnError({ code: '23505', message: 'duplicate key value violates unique constraint "returns_pkey"' });
    expect(m.reason).toBe('internal_error');
    expect(m.status).toBe(500);
    expect(m.message).not.toMatch(/returns_pkey/);
    expect(mapReturnError(null).reason).toBe('internal_error');
  });

  it('parses a JSON detail (the rule and location of a failed revalidation)', () => {
    const m = mapReturnError({
      hint: 'restock_location_unavailable',
      details: '{"rule": "archived", "locationId": "00000000-0000-4000-8000-000000000001"}',
    });
    expect(m.detail).toEqual({ rule: 'archived', locationId: '00000000-0000-4000-8000-000000000001' });
    expect(mapReturnError({ hint: 'invalid_status_transition', details: 'approved' }).detail).toBeNull();
    expect(restockProblemWords('archived')).toBe('(archived)');
    expect(restockProblemWords('moved_warehouse')).toBe('(moved to another warehouse)');
    expect(restockProblemWords('nope')).toBeNull();
  });
});

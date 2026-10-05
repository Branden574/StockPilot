import { describe, expect, it, vi } from 'vitest';

import { ORDER_WAREHOUSE_WRITE_REFUSED_COPY } from '@stockpilot/core';

import { ApiError } from '../lib/api';
import { REQUEST_TIMED_OUT_COPY } from '../lib/connection-copy';

import {
  addLinesErrorIsIndeterminate,
  addLinesErrorIsTerminal,
  addLinesErrorStatus,
  describeAddLinesError,
} from './add-order-items';
import {
  describeLineEditError,
  lineEditErrorIsIndeterminate,
  lineEditErrorIsReservationSync,
  lineEditErrorIsStale,
} from './edit-order-line';

/**
 * Small fixes slice 2 review (walked on the iPhone simulator): an approver
 * outside the order's warehouse raised a line's quantity and the phone said
 * "We did not hear back from the server, so this change may already have been
 * applied." The server had answered 403 with "This order is in a warehouse you
 * don't work in, so you can't change it. Ask a manager."
 *
 * The add-items and edit-line sheets read the HTTP status by parsing
 * "API <status>:" off the error's message, the shape api() threw when they
 * were written (2026-07-22). Since 2026-07-31 (typed ApiError) api() throws an
 * ApiError whose message is the server's sentence and whose `status` is a
 * field, so every refusal (403, a 409 floor such as "3 of these are already
 * picked", a 400) was read as no answer at all: the wrong sentence, the sheet
 * closed, and the reason the server gave never shown.
 *
 * These use the REAL ApiError class (the api-error-details.test.ts mocks), so
 * the classification is pinned against what api() actually throws.
 */

// vitest hoists vi.hoisted and vi.mock above the imports: the API client
// reads __DEV__ and its native dependencies at load.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('../lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } } }));
vi.mock('../lib/account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('../lib/request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));


const FLOOR =
  '3 of these are already picked and staged — unstage them or finish fulfilling this line before lowering the quantity below 3.';
const SYNC =
  'The stock reserved for this item changed while you were editing. Refresh and check the order before trying again.';

describe('the line sheets read the status api() really throws', () => {
  it('a 403 from the server: its status, its sentence, and the sheet closes on it (stale), never "no answer"', () => {
    const e = new ApiError(ORDER_WAREHOUSE_WRITE_REFUSED_COPY, 403, 'forbidden');
    expect(addLinesErrorStatus(e)).toBe(403);
    expect(lineEditErrorIsIndeterminate(e)).toBe(false);
    expect(lineEditErrorIsStale(e)).toBe(true);
    expect(describeLineEditError(e)).toBe(ORDER_WAREHOUSE_WRITE_REFUSED_COPY);
    expect(addLinesErrorIsIndeterminate(e)).toBe(false);
    expect(addLinesErrorIsTerminal(e)).toBe(true);
    expect(describeAddLinesError(e)).toBe(ORDER_WAREHOUSE_WRITE_REFUSED_COPY);
  });

  it('a 409 floor stays in the edit sheet with the server\'s sentence', () => {
    const e = new ApiError(FLOOR, 409, 'conflict');
    expect(lineEditErrorIsIndeterminate(e)).toBe(false);
    expect(lineEditErrorIsStale(e)).toBe(false);
    expect(lineEditErrorIsReservationSync(e)).toBe(false);
    expect(describeLineEditError(e)).toBe(FLOOR);
  });

  it('the reservation re-sync 409 is still told apart (the write committed)', () => {
    expect(lineEditErrorIsReservationSync(new ApiError(SYNC, 409, 'conflict'))).toBe(true);
  });

  it('only a request with no answer is "no answer": the timeout and a dropped socket', () => {
    for (const e of [new Error(REQUEST_TIMED_OUT_COPY), new TypeError('Network request failed')]) {
      expect(addLinesErrorStatus(e)).toBeNull();
      expect(lineEditErrorIsIndeterminate(e)).toBe(true);
      expect(addLinesErrorIsIndeterminate(e)).toBe(true);
    }
  });

  it('the legacy "API <status>:" text still parses (nothing that throws it is left, but it costs nothing)', () => {
    expect(addLinesErrorStatus(new Error('API 409: {"error":"conflict"}'))).toBe(409);
  });
});

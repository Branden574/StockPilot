import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceError } from '@/server/services/context';

/**
 * Add items on the web reads WHY a refusal happened from `details.reason`
 * (returns RX-3 fix round 2, F1 on the web): busy wrote nothing and keeps the
 * picks, a partial answer saved the top-ups and must close and reload. The
 * order actions' toResult dropped the details, so the dialog could not tell
 * them apart. It passes them through now, as actions/returns.ts does; an
 * internal error still carries none (its public message is generic and its
 * details are the server's).
 */

const addLines = vi.fn();

vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: { forCurrentUser: vi.fn(async () => ({ addLines })) },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(async () => undefined),
}));
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { revalidatePath } from 'next/cache';

import { addOrderRequestLinesAction } from './order-requests';

const ORDER = '55555555-5555-4555-8555-555555555555';
const ITEM = '66666666-6666-4666-8666-666666666666';
const PARTIAL = 'Part of this change was saved. Reload the order to see it before adding again.';

function run() {
  return addOrderRequestLinesAction({ id: ORDER, lines: [{ itemId: ITEM, quantity: 2 }] });
}

beforeEach(() => vi.clearAllMocks());

describe('addOrderRequestLinesAction passes the refusal reason through', () => {
  it('a partial answer reaches the dialog as not retryable', async () => {
    addLines.mockRejectedValueOnce(
      new ServiceError('conflict', PARTIAL, { reason: 'partial', retryable: false }),
    );
    await expect(run()).resolves.toEqual({
      ok: false,
      error: { code: 'conflict', message: PARTIAL, details: { reason: 'partial', retryable: false } },
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('busy reaches the dialog as retryable', async () => {
    addLines.mockRejectedValueOnce(
      new ServiceError('conflict', 'Busy. Try again.', { reason: 'busy', retryable: true }),
    );
    await expect(run()).resolves.toEqual({
      ok: false,
      error: { code: 'conflict', message: 'Busy. Try again.', details: { reason: 'busy', retryable: true } },
    });
  });

  it('a refusal with no details answers as before', async () => {
    addLines.mockRejectedValueOnce(
      new ServiceError('conflict', 'This order is already out for delivery — create a new order for the extra items.'),
    );
    await expect(run()).resolves.toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: 'This order is already out for delivery — create a new order for the extra items.',
      },
    });
  });

  it('an internal error carries no details and no database text', async () => {
    addLines.mockRejectedValueOnce(
      new ServiceError('internal_error', 'relation "order_request_lines" secret', { table: 'secret' }),
    );
    const res = await run();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('internal_error');
    expect(res.error).not.toHaveProperty('details');
    expect(JSON.stringify(res)).not.toMatch(/secret|order_request_lines/);
  });
});

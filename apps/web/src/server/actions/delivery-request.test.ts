import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The global test setup mocks @/server/services/audit to a no-op
 * (src/test/setup.ts:13-16), so a file that ASSERTS on audit must declare its
 * own per-file mock. This is that declaration.
 *
 * The rest param (rather than the brief's literal zero-arg `() => {}`) keeps
 * `Parameters<typeof auditSpy>` as `unknown[]`, not `[]` — with
 * noUncheckedIndexedAccess on, a zero-arg mock's `mock.calls[0]` is an empty
 * tuple and `mock.calls[0]![0]` fails to typecheck (TS2493), the same landmine
 * already documented for `stubOpen` in delivery-request-action.test.tsx.
 */
const auditSpy = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@/server/services/audit', () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));

import { recordDeliveryRequestDraftedAction } from './delivery-request';

const ORDER = 'b3f1c2d4-1111-2222-3333-444455556666';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordDeliveryRequestDraftedAction', () => {
  it('records that a DRAFT was opened, under the order.* event group', async () => {
    await recordDeliveryRequestDraftedAction({ orderId: ORDER, isCondensed: false });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const payload = auditSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.event).toBe('order.delivery_request_drafted');
    expect(payload.entityType).toBe('order_request');
    expect(payload.entityId).toBe(ORDER);
  });

  it('stores ONLY the safe metadata allow-list', async () => {
    await recordDeliveryRequestDraftedAction({ orderId: ORDER, isCondensed: true });

    const payload = auditSpy.mock.calls[0]![0] as { extra: Record<string, unknown> };
    expect(payload.extra).toEqual({
      recipient_type: 'dc4-delivery-request',
      included_cc_recipient: true,
      is_condensed: true,
    });
  });

  it('never stores the body, the URL, the address, the notes or a phone number', async () => {
    await recordDeliveryRequestDraftedAction({ orderId: ORDER, isCondensed: false });

    const serialized = JSON.stringify(auditSpy.mock.calls[0]![0]);
    for (const forbidden of [
      'outlook.office.com',
      'mailto:',
      'DELIVERY REQUEST',
      'Shaw Ave',
      'body',
      'compose_url',
      'notes',
      'phone',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('never stores either email address — analytics and audit record the FACT, not the recipient', async () => {
    await recordDeliveryRequestDraftedAction({ orderId: ORDER, isCondensed: false });

    const serialized = JSON.stringify(auditSpy.mock.calls[0]![0]);
    expect(serialized).not.toContain('dc4@learn4life.org');
    expect(serialized).not.toContain('arosas@cvwest.org');
  });

  it('never claims a ticket was created or assigned', async () => {
    await recordDeliveryRequestDraftedAction({ orderId: ORDER, isCondensed: false });

    const serialized = JSON.stringify(auditSpy.mock.calls[0]![0]).toLowerCase();
    expect(serialized).not.toContain('ticket');
    expect(serialized).not.toContain('assigned');
    expect(serialized).not.toContain('sent');
  });

  it('rejects a non-uuid order id without calling audit', async () => {
    await recordDeliveryRequestDraftedAction({ orderId: 'not-a-uuid', isCondensed: false });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('never throws, whatever audit does — a logging failure must not break the UI', async () => {
    auditSpy.mockRejectedValueOnce(new Error('audit exploded'));
    await expect(
      recordDeliveryRequestDraftedAction({ orderId: ORDER, isCondensed: false }),
    ).resolves.toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ServiceError } from './context';
import { ReceivingService } from './receiving';

import type { PostReceiptInput } from '@stockpilot/core';

/**
 * post_receipt_v2 refuses a line that accepts a kit's pre-assembled stock
 * (0366, errcode 22023, hint po_line_bundle): receiving one would add kits
 * with no component drawn. The message is written for people and names the
 * kit, so postReceipt maps the refusal by its hint and passes the message on
 * as a validation error, instead of the masked internal error an unmapped
 * raise becomes (recurring pattern #28).
 */

const input: PostReceiptInput = {
  purchaseOrderId: 'po-1',
  warehouseId: 'wh-1',
  idempotencyKey: 'idem-1',
  lines: [{ poLineId: 'pol-kit', qtyReceived: 2, qtyAccepted: 2, qtyRejected: 0, unitCost: 1 }],
};

const KIT_MESSAGE =
  '"Reading Kit" is a pre-assembled kit, so it can\'t be received: receiving it would add kits without using any of their components. Leave this line at 0 and receive the rest; kits are built from their components.';

function serviceWithRpcError(error: { message: string; code?: string; hint?: string }) {
  const stub = makeSupabaseStub({
    'rpc:post_receipt_v2': { data: null, error },
    'purchase_order_items.select': { data: [], error: null },
    'inventory_items.select': { data: [], error: null },
  });
  return new ReceivingService(makeServiceContext(stub.client));
}

describe('ReceivingService.postReceipt — kit stock (0366 po_line_bundle)', () => {
  it('maps the refusal to a validation_error carrying the database message', async () => {
    const svc = serviceWithRpcError({ message: KIT_MESSAGE, code: '22023', hint: 'po_line_bundle' });

    const err = await svc.postReceipt(input).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    expect((err as ServiceError).message).toBe(KIT_MESSAGE);
  });

  it('is matched by the hint, so a kit whose name holds a mapped token is still reported as kit stock', async () => {
    const message = KIT_MESSAGE.replace('Reading Kit', 'Snacks (forbidden in class) kit');
    const svc = serviceWithRpcError({ message, code: '22023', hint: 'po_line_bundle' });

    const err = await svc.postReceipt(input).catch((e: unknown) => e);

    expect((err as ServiceError).code).toBe('validation_error');
    expect((err as ServiceError).message).toBe(message);
  });
});

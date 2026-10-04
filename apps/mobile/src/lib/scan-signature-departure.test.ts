import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { departureConfirmButtons } from './order-departure';
import {
  readSignatureOrder,
  scanSignatureDeparture,
  SIGNATURE_LOOKUP_PATH,
  type ScannedSignatureOrder,
  type SignatureLookupPost,
} from './scan-signature-departure';

// F2-2 review 2026-09-28: a packing slip scanned on the Scan tab opened the
// signature pad (a hand-over) without the departure confirm the order screen's
// Collect signature and Physical signature show. The scan tab now reads the
// slip's order and asks first, in the same words; it never blocks the pad for
// want of facts.
//
// Migration 0389: the order row holds the token's sha256, not the token, so
// the read goes through POST /api/v1/orders/signature-lookup, which hashes the
// scanned token on the server. It used to be `.eq('signature_token', token)`
// with the member's own client, which finds nothing for a token minted since
// 0389 (the departure confirm was then silently skipped).

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const TOKEN = 'f'.repeat(64);

/** api()'s refusal shape: an Error carrying the HTTP status. */
function apiError(status: number): Error {
  return Object.assign(new Error(`Request failed (${status}).`), { status });
}

function post(answer: () => Promise<unknown>) {
  const calls: { path: string; body: { token: string } }[] = [];
  const fn: SignatureLookupPost = async (path, body) => {
    calls.push({ path, body });
    return answer();
  };
  return { fn, calls };
}

const SO100 = {
  orderId: 'o-100',
  status: 'staged_for_pickup',
  lines: [
    { orderRequestLineId: 'l-nb', name: 'Notebook', requested: 30, fulfilled: 0, picked: 30 },
    {
      orderRequestLineId: 'l-pen',
      name: 'L4L - Pen Black & Rose Gold',
      requested: 60,
      fulfilled: 0,
      picked: 0,
    },
  ],
};

describe('readSignatureOrder', () => {
  it("asks the server for the slip's order with the scanned token, and answers its lines as the server listed them", async () => {
    const p = post(async () => SO100);
    await expect(readSignatureOrder(p.fn, TOKEN)).resolves.toEqual(SO100);
    expect(p.calls).toEqual([{ path: SIGNATURE_LOOKUP_PATH, body: { token: TOKEN } }]);
    expect(SIGNATURE_LOOKUP_PATH).toBe('/api/v1/orders/signature-lookup');
    expect(warn).not.toHaveBeenCalled();
  });

  it('normalises the numbers and a missing line id (null), as the order screen does', async () => {
    const p = post(async () => ({
      orderId: 'o',
      status: 'staged_for_delivery',
      lines: [{ orderRequestLineId: 7, name: 'Item', requested: '4', fulfilled: null, picked: undefined }],
    }));
    const order = await readSignatureOrder(p.fn, TOKEN);
    expect(order?.lines[0]).toEqual({
      orderRequestLineId: null,
      name: 'Item',
      requested: 4,
      fulfilled: 0,
      picked: 0,
    });
  });

  it("another organization's slip, or one no longer valid (404), is null without a device log line", async () => {
    const p = post(async () => {
      throw apiError(404);
    });
    expect(await readSignatureOrder(p.fn, TOKEN)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws, and never blocks for want of facts: a refusal, a server error, no connection or an unreadable answer is null, said in the device log', async () => {
    for (const answer of [
      async () => {
        throw apiError(401);
      },
      async () => {
        throw apiError(500);
      },
      async () => {
        throw new Error('Network request failed');
      },
      async () => null,
      async () => ({ orderId: 'o', status: 'staged_for_pickup' }),
      async () => ({ orderId: 'o', status: 'staged_for_pickup', lines: [{ requested: 1 }] }),
    ]) {
      expect(await readSignatureOrder(post(answer).fn, TOKEN)).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(6);
  });
});

describe('scanSignatureDeparture', () => {
  const order = (status: string, pickedPen: number): ScannedSignatureOrder => ({
    orderId: 'o-100',
    status,
    lines: [
      { orderRequestLineId: 'l-nb', name: 'Notebook', requested: 30, fulfilled: 0, picked: 30 },
      {
        orderRequestLineId: 'l-pen',
        name: 'L4L - Pen Black & Rose Gold',
        requested: 60,
        fulfilled: 0,
        picked: pickedPen,
      },
    ],
  });

  it("SO-000100 at pickup: asks first, in the order screen's words, and Fix the order hands over the short line", () => {
    const risk = scanSignatureDeparture(order('staged_for_pickup', 0));
    expect(risk).not.toBeNull();
    expect(risk!.message).toContain('0 of 60 L4L - Pen Black & Rose Gold');
    expect(risk!.confirmLabel).toBe('Record signature anyway');
    const onFix = vi.fn();
    const onProceed = vi.fn();
    const [fix, go] = departureConfirmButtons(risk!, { onFix, onProceed });
    fix!.onPress!();
    expect(onFix).toHaveBeenCalledWith('l-pen');
    go!.onPress!();
    expect(onProceed).toHaveBeenCalledTimes(1);
  });

  it('out for delivery the lines are final: "Go back" hands over no line', () => {
    const risk = scanSignatureDeparture(order('in_transit', 0));
    expect(risk!.cancelLabel).toBe('Go back');
    const onFix = vi.fn();
    departureConfirmButtons(risk!, { onFix, onProceed: () => {} })[0]!.onPress!();
    expect(onFix).toHaveBeenCalledWith(null);
  });

  it('nothing short, or an order it could not read: no confirm, the pad opens at once', () => {
    expect(scanSignatureDeparture(order('staged_for_pickup', 60))).toBeNull();
    expect(scanSignatureDeparture(null)).toBeNull();
  });
});

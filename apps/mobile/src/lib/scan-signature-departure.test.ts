import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { departureConfirmButtons } from './order-departure';
import {
  readSignatureOrder,
  scanSignatureDeparture,
  type ScannedSignatureOrder,
  type SignatureOrderClient,
} from './scan-signature-departure';

// F2-2 review 2026-09-28: a packing slip scanned on the Scan tab opened the
// signature pad (a hand-over) without the departure confirm the order screen's
// Collect signature and Physical signature show. The scan tab now reads the
// slip's order and asks first, in the same words; it never blocks the pad for
// want of facts.

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

type Answer = { data: unknown; error: unknown };

function client(header: () => Promise<Answer>, lines: () => Promise<Answer>) {
  const seen: string[] = [];
  const headChain = {
    select(c: string) {
      seen.push(`select:${c}`);
      return headChain;
    },
    eq(c: string, v: string) {
      seen.push(`eq:${c}=${v}`);
      return headChain;
    },
    maybeSingle: header,
  };
  const linesChain = {
    select(c: string) {
      seen.push(`select:${c}`);
      return linesChain;
    },
    eq(c: string, v: string) {
      seen.push(`eq:${c}=${v}`);
      return linesChain;
    },
    order(c: string, o: { ascending: boolean }) {
      seen.push(`order:${c}:${o.ascending ? 'asc' : 'desc'}`);
      return linesChain;
    },
    then<T>(resolve: (v: Answer) => T, reject?: (e: unknown) => T) {
      return lines().then(resolve, reject);
    },
  };
  const c: SignatureOrderClient & { seen: string[] } = {
    seen,
    from(t: string) {
      seen.push(`from:${t}`);
      return t === 'order_requests' ? headChain : linesChain;
    },
  };
  return c;
}

const SO100_LINES = [
  {
    id: 'l-nb',
    quantity_requested: 30,
    quantity_fulfilled: 0,
    quantity_picked: 30,
    item: { name: 'Notebook' },
  },
  {
    id: 'l-pen',
    quantity_requested: 60,
    quantity_fulfilled: 0,
    quantity_picked: 0,
    item: { name: 'L4L - Pen Black & Rose Gold' },
  },
];

describe('readSignatureOrder', () => {
  it("reads the slip's order in the signed-in organization, then its lines in the order screen's order", async () => {
    const c = client(
      async () => ({ data: { id: 'o-100', status: 'staged_for_pickup' }, error: null }),
      async () => ({ data: SO100_LINES, error: null }),
    );
    await expect(readSignatureOrder(c, 'org-1', 'tok-abc')).resolves.toEqual({
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
    });
    expect(c.seen).toEqual([
      'from:order_requests',
      'select:id, status',
      'eq:organization_id=org-1',
      'eq:signature_token=tok-abc',
      'from:order_request_lines',
      'select:id, quantity_requested, quantity_fulfilled, quantity_picked, item:inventory_items(name)',
      'eq:order_request_id=o-100',
      'order:created_at:asc',
      'order:id:asc',
    ]);
  });

  it("a line whose item the viewer cannot read is named in core's words, and a null pick is 0", async () => {
    const c = client(
      async () => ({ data: { id: 'o', status: 'staged_for_delivery' }, error: null }),
      async () => ({
        data: [
          {
            id: 'l',
            quantity_requested: '4',
            quantity_fulfilled: null,
            quantity_picked: null,
            item: null,
          },
        ],
        error: null,
      }),
    );
    const order = await readSignatureOrder(c, 'org', 'tok');
    expect(order?.lines[0]).toMatchObject({ requested: 4, fulfilled: 0, picked: 0 });
    expect(order?.lines[0]!.name).not.toBe('');
  });

  it("never throws, and never blocks for want of facts: another org's slip, a failed read, no connection are null", async () => {
    const ok = async () => ({ data: SO100_LINES, error: null });
    expect(
      await readSignatureOrder(
        client(async () => ({ data: null, error: null }), ok),
        'o',
        't',
      ),
    ).toBeNull();
    expect(
      await readSignatureOrder(
        client(async () => ({ data: null, error: { message: 'x' } }), ok),
        'o',
        't',
      ),
    ).toBeNull();
    expect(
      await readSignatureOrder(
        client(
          async () => ({ data: { id: 'o', status: 'staged_for_pickup' }, error: null }),
          async () => ({
            data: null,
            error: { message: 'boom' },
          }),
        ),
        'o',
        't',
      ),
    ).toBeNull();
    expect(
      await readSignatureOrder(
        client(async () => {
          throw new Error('Network request failed');
        }, ok),
        'o',
        't',
      ),
    ).toBeNull();
    // A failure is said in the device log, never silent.
    expect(warn).toHaveBeenCalled();
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

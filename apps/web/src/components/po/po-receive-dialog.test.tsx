// @vitest-environment happy-dom
/**
 * The Task 16 REGRESSION guard.
 *
 * Size-run receiving changes only how lines are LAID OUT. `post_receipt_v2` is
 * on its sixth rewrite (0296) and is the most prod-hardened seam in the app, so
 * the one thing that must be provable is that the dialog still emits the exact
 * same `p_lines` recordset shape — grouped or not.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const postReceiptAction = vi.fn();

vi.mock('@/server/actions/receiving', () => ({
  postReceiptAction: (...args: unknown[]) => postReceiptAction(...args),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { PoReceiveDialog } from './po-receive-dialog';
import type { SizeRunGroup } from './size-run-receive-grid';

interface DialogLine {
  id: string;
  name: string;
  sku: string;
  quantityOrdered: number;
  quantityReceived: number;
  trackingType: 'none' | 'lot' | 'serial' | 'serial_optional';
  groupId?: string | null;
  variantSize?: string | null;
}

function line(over: Partial<DialogLine> & { id: string }): DialogLine {
  return {
    name: `Item ${over.id}`,
    sku: `SKU-${over.id}`,
    quantityOrdered: 10,
    quantityReceived: 0,
    trackingType: 'none',
    ...over,
  };
}

const shoes: Record<string, SizeRunGroup> = {
  g1: {
    name: 'Nike Mercurial',
    countingUnit: 'pair',
    sizeOrder: new Map([
      ['9', 0],
      ['10', 1],
      ['11', 2],
    ]),
  },
};

async function openDialog(lines: DialogLine[], groups?: Record<string, SizeRunGroup>) {
  const user = userEvent.setup();
  render(
    <PoReceiveDialog
      poId="po-1"
      poNumber="PO-0001"
      warehouseId="wh-1"
      lines={lines}
      groups={groups}
    />,
  );
  await user.click(screen.getByRole('button', { name: /receive items/i }));
  return user;
}

beforeEach(() => {
  postReceiptAction.mockReset();
  postReceiptAction.mockResolvedValue({ ok: true, data: { receiptNumber: 'RC-1' } });
});

describe('PoReceiveDialog — payload shape', () => {
  it('emits the same per-line payload for a size run as for flat lines', async () => {
    const user = await openDialog(
      [
        line({ id: 'a', groupId: 'g1', variantSize: '9', quantityOrdered: 4 }),
        line({ id: 'b', groupId: 'g1', variantSize: '10', quantityOrdered: 6 }),
        line({ id: 'c', groupId: 'g1', variantSize: '11', quantityOrdered: 14 }),
      ],
      shoes,
    );

    // The run renders as ONE block...
    expect(screen.getByTestId('size-run')).toBeInTheDocument();
    // ...and "Receive all ordered" fills every size.
    await user.click(screen.getByRole('button', { name: /receive all ordered/i }));
    await user.click(screen.getByRole('button', { name: /post receipt/i }));

    expect(postReceiptAction).toHaveBeenCalledTimes(1);
    const payload = postReceiptAction.mock.calls[0]?.[0] as {
      purchaseOrderId: string;
      warehouseId: string;
      idempotencyKey: string;
      lines: Array<Record<string, unknown>>;
    };

    expect(payload.purchaseOrderId).toBe('po-1');
    expect(payload.warehouseId).toBe('wh-1');
    expect(typeof payload.idempotencyKey).toBe('string');
    // ONE p_lines entry per size — never one merged "run" entry.
    expect(payload.lines).toEqual([
      { poLineId: 'a', qtyReceived: 4, qtyAccepted: 4, qtyRejected: 0, notes: undefined, lots: undefined, serials: undefined },
      { poLineId: 'b', qtyReceived: 6, qtyAccepted: 6, qtyRejected: 0, notes: undefined, lots: undefined, serials: undefined },
      { poLineId: 'c', qtyReceived: 14, qtyAccepted: 14, qtyRejected: 0, notes: undefined, lots: undefined, serials: undefined },
    ]);
    // The payload carries NO group or variant field — grouping is presentation
    // only and the RPC's recordset is untouched.
    for (const l of payload.lines) {
      expect(Object.keys(l).sort()).toEqual(
        ['lots', 'notes', 'poLineId', 'qtyAccepted', 'qtyReceived', 'qtyRejected', 'serials'],
      );
    }
  });

  it('posts only the sizes that were actually entered', async () => {
    const user = await openDialog(
      [
        line({ id: 'a', groupId: 'g1', variantSize: '9' }),
        line({ id: 'b', groupId: 'g1', variantSize: '10' }),
      ],
      shoes,
    );

    const rows = screen.getAllByTestId('size-run-row');
    const firstRow = rows[0];
    if (!firstRow) throw new Error('expected a size-run row');
    await user.type(within(firstRow).getByRole('spinbutton'), '3');
    await user.click(screen.getByRole('button', { name: /post receipt/i }));

    const payload = postReceiptAction.mock.calls[0]?.[0] as {
      lines: Array<{ poLineId: string; qtyReceived: number }>;
    };
    expect(payload.lines).toEqual([
      { poLineId: 'a', qtyReceived: 3, qtyAccepted: 3, qtyRejected: 0, notes: undefined, lots: undefined, serials: undefined },
    ]);
  });

  it('keeps the flat renderer and its payload for ungrouped lines', async () => {
    const user = await openDialog([line({ id: 'a', quantityOrdered: 5 })]);
    expect(screen.queryByTestId('size-run')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^all$/i }));
    await user.click(screen.getByRole('button', { name: /post receipt/i }));

    const payload = postReceiptAction.mock.calls[0]?.[0] as {
      lines: Array<{ poLineId: string; qtyReceived: number }>;
    };
    expect(payload.lines).toEqual([
      { poLineId: 'a', qtyReceived: 5, qtyAccepted: 5, qtyRejected: 0, notes: undefined, lots: undefined, serials: undefined },
    ]);
  });
});

describe('PoReceiveDialog — serial capture survives inside a run', () => {
  it('shows the serial grid for a `serial` item inside a size run and sends the serials', async () => {
    const user = await openDialog(
      [
        line({ id: 'a', groupId: 'g1', variantSize: '9', trackingType: 'serial', quantityOrdered: 2 }),
        line({ id: 'b', groupId: 'g1', variantSize: '10', quantityOrdered: 1 }),
      ],
      shoes,
    );

    await user.click(screen.getByRole('button', { name: /receive all ordered/i }));
    // The capture grid appears inside the run, exactly as it does on a flat row.
    const serialInputs = screen.getAllByPlaceholderText(/^Serial #/);
    expect(serialInputs).toHaveLength(2);
    const [s1, s2] = serialInputs;
    if (!s1 || !s2) throw new Error('expected two serial inputs');
    await user.type(s1, 'SN-1');
    await user.type(s2, 'SN-2');

    await user.click(screen.getByRole('button', { name: /post receipt/i }));

    const payload = postReceiptAction.mock.calls[0]?.[0] as {
      lines: Array<{ poLineId: string; serials?: string[] }>;
    };
    expect(payload.lines[0]).toMatchObject({ poLineId: 'a', serials: ['SN-1', 'SN-2'] });
    // A quantity variant in the same run still sends no serials at all — never
    // a placeholder.
    expect(payload.lines[1]).toMatchObject({ poLineId: 'b', serials: undefined });
  });

  it('refuses to post a `serial` line in a run with a missing serial (R1)', async () => {
    const { toast } = await import('sonner');
    const user = await openDialog(
      [
        line({ id: 'a', groupId: 'g1', variantSize: '9', trackingType: 'serial', quantityOrdered: 2 }),
        line({ id: 'b', groupId: 'g1', variantSize: '10', quantityOrdered: 1 }),
      ],
      shoes,
    );

    await user.click(screen.getByRole('button', { name: /receive all ordered/i }));
    const serialInputs = screen.getAllByPlaceholderText(/^Serial #/);
    const first = serialInputs[0];
    if (!first) throw new Error('expected a serial input');
    await user.type(first, 'SN-1'); // second left blank
    await user.click(screen.getByRole('button', { name: /post receipt/i }));

    expect(postReceiptAction).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('every serial number must be non-empty'),
    );
  });
});

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrderReadinessResult } from '@stockpilot/core';

import { completePickingAction, recordPickedLineAction } from '@/server/actions/order-requests';
import type { OrderRequestLineWithItem } from '@/server/services/order-requests';
import { orderReadinessFacts, READINESS_FAILED, readinessOk, visibleItemFacts } from '@/test/order-readiness-facts';

import { DigitalPick } from './digital-pick';

// F2-2: the digital pick's completion confirm is core's
// (digitalPickCompletionConfirm: complete_picking projected over the order's
// readiness with what the picker entered; the phone's digital pick says the
// same), never skipped when stock could not be checked, and "Review short
// lines" goes back to the first short line. Call-site pin: deleting the
// confirm's call from Complete makes it complete on the first click, and the
// first test fails.

const routerPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: routerPush }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/server/actions/order-requests', () => ({
  completePickingAction: vi.fn(),
  recordPickedLineAction: vi.fn(),
}));
vi.mock('@/components/orders/fefo-lot-hint', () => ({ FefoLotHint: () => null }));

const complete = vi.mocked(completePickingAction);
const record = vi.mocked(recordPickedLineAction);

const ORDER = '11111111-1111-4111-8111-111111111111';

function line(id: string, name: string, requested: number, picked: number | null): OrderRequestLineWithItem {
  return {
    id,
    order_request_id: ORDER,
    item_id: `item-${id}`,
    quantity_requested: requested,
    quantity_fulfilled: 0,
    quantity_picked: picked,
    returned_quantity: 0,
    unit_cost_at_request: 0,
    notes: null,
    item: {
      id: `item-${id}`,
      name,
      sku: `SKU-${id}`,
      quantity_on_hand: 100,
      barcode: null,
      model_number: null,
      item_type: 'product',
      custom_fields: null,
      tracking_type: 'none',
      charter_name: null,
      charter_code: null,
    },
  } as unknown as OrderRequestLineWithItem;
}

/** SO-000100: the notebooks picked, the pens not at all. */
const LINES = [line('notebooks', 'Notebook', 60, 60), line('pens', 'L4L - Pen Black & Rose Gold', 60, null)];

/** The order's readiness: notebooks and pens both on the rack and held. */
const READY: OrderReadinessResult = readinessOk(
  orderReadinessFacts(
    ORDER,
    'picking_in_progress',
    [
      { lineId: 'notebooks', itemId: 'item-notebooks', requested: 60, picked: 60 },
      { lineId: 'pens', itemId: 'item-pens', requested: 60 },
    ],
    [
      visibleItemFacts('item-notebooks', { name: 'Notebook', here: { rack: 60 }, heldOwn: 60 }),
      visibleItemFacts('item-pens', { name: 'L4L - Pen Black & Rose Gold', here: { rack: 60 }, heldOwn: 60 }),
    ],
  ),
);

function renderPick(readiness: OrderReadinessResult | null = READY, lines = LINES) {
  const user = userEvent.setup();
  const { unmount } = render(
    <DigitalPick orderId={ORDER} initialLines={lines} canPick assignedPickerName={null} readiness={readiness} />,
  );
  return Object.assign(user, { unmount });
}

beforeEach(() => {
  complete.mockReset();
  complete.mockResolvedValue({ ok: true, data: undefined });
  record.mockReset();
  record.mockResolvedValue({ ok: true, data: undefined });
  routerPush.mockReset();
});

const SO100_SENTENCE =
  'Not everything will be picked. L4L - Pen Black & Rose Gold: 0 of 60. It will be owed at hand-over, or you can remove it from the order first.';

describe('DigitalPick — the confirm before completing a short pick (F2-2)', () => {
  it('names the short line in core\'s words INSTEAD of completing, and completes on "Complete picking"', async () => {
    const user = renderPick();

    await user.click(screen.getByRole('button', { name: /Complete picking/ }));

    // Mutation "delete the call": completing on the first click fails here.
    expect(complete).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Before you complete picking')).toBeInTheDocument();
    expect(dialog).toHaveTextContent(SO100_SENTENCE);
    expect(dialog).not.toHaveTextContent("Stock couldn't be checked");

    await user.click(within(dialog).getByRole('button', { name: 'Complete picking' }));
    expect(complete).toHaveBeenCalledWith({ id: ORDER });
    expect(routerPush).toHaveBeenCalledWith(`/dashboard/orders/${ORDER}`);
  });

  it('"Review short lines" completes nothing and lands on the first short line\'s quantity', async () => {
    const user = renderPick();

    await user.click(screen.getByRole('button', { name: /Complete picking/ }));
    await user.click(screen.getByRole('button', { name: 'Review short lines' }));

    expect(complete).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Picked quantity for L4L - Pen Black & Rose Gold')).toHaveFocus();
  });

  it('uses what the picker entered: raising the pens to 60 leaves nothing to confirm', async () => {
    const user = renderPick();

    const pens = screen.getByLabelText('Picked quantity for L4L - Pen Black & Rose Gold');
    await user.type(pens, '60');
    await user.click(screen.getByRole('button', { name: /Complete picking/ }));

    expect(screen.queryByRole('dialog')).toBeNull();
    // The unsaved 60 is saved first, then picking completes.
    expect(record).toHaveBeenCalledWith({ orderId: ORDER, lineId: 'pens', quantity: 60 });
    expect(complete).toHaveBeenCalledWith({ id: ORDER });
  });

  it('is never skipped when readiness could not be read: what was entered short, and that stock was not checked', async () => {
    for (const readiness of [null, READINESS_FAILED]) {
      const user = renderPick(readiness);
      await user.click(screen.getByRole('button', { name: /Complete picking/ }));
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(SO100_SENTENCE);
      expect(dialog).toHaveTextContent("Stock couldn't be checked. Picking may come up short.");
      expect(complete).not.toHaveBeenCalled();
      user.unmount();
    }
  });

  it('says when the pick would fail because units are still in Staging, even with every line entered', async () => {
    const staged = readinessOk(
      orderReadinessFacts(ORDER, 'picking_in_progress', [{ lineId: 'pens', itemId: 'item-pens', requested: 10 }], [
        visibleItemFacts('item-pens', { name: 'Maus I', here: { rack: 6, staging: 4 }, heldOwn: 10 }),
      ]),
    );
    const user = renderPick(staged, [line('pens', 'Maus I', 10, 10)]);

    await user.click(screen.getByRole('button', { name: /Complete picking/ }));

    expect(screen.getByRole('dialog')).toHaveTextContent("Picking can't finish until 4 of Maus I in Staging are put away.");
    expect(complete).not.toHaveBeenCalled();
  });
});

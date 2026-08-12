import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { mockTransferStockAction } = vi.hoisted(() => ({
  mockTransferStockAction: vi.fn(),
}));

vi.mock('@/server/actions/inventory', () => ({
  transferStockAction: mockTransferStockAction,
}));

import { StockTransferDialog } from './stock-transfer-dialog';

// ---------------------------------------------------------------------------
// Field regression 2026-07-07: a rejected transfer (plan_limit_exceeded from
// the inline new-rack path) produced ZERO visible feedback — the only signal
// was a bottom-right toast that auto-dismisses outside the modal. The dialog
// now ALSO renders the server error inline (role="alert"), persistently,
// until the next attempt. These tests pin that.
// ---------------------------------------------------------------------------

const LOC_A = { id: 'loc-a', name: 'Receiving Dock', kind: null, warehouse_id: 'wh-1' };
const LOC_B = { id: 'loc-b', name: 'Aisle A', kind: null, warehouse_id: 'wh-1' };

function renderDialog() {
  return render(
    <StockTransferDialog
      itemId="item-1"
      itemName="Countertop Blender"
      currentQuantity={40}
      currentLocationId={null}
      locations={[LOC_A, LOC_B] as never}
      holdings={
        [{ locationId: 'loc-a', locationName: 'Receiving Dock', quantity: 40, kind: null, warehouseId: 'wh-1' }] as never
      }
      itemType="asset"
      canManageLocations
    />,
  );
}

async function openAndSubmitToExisting(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /transfer/i }));
  // Destination select (second combobox; the source select auto-picks the
  // only holding). Radix triggers carry no label-derived accessible name.
  const destination = screen.getAllByRole('combobox')[1]!;
  await user.click(destination);
  await user.click(await screen.findByRole('option', { name: /aisle a/i }));
  await user.click(screen.getByRole('button', { name: /transfer stock/i }));
}

describe('StockTransferDialog server-error surfacing', () => {
  it('renders a persistent inline alert when the action rejects, and stays open', async () => {
    mockTransferStockAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'plan_limit_exceeded', message: 'Upgrade to add more.' },
    });
    const user = userEvent.setup();
    renderDialog();
    await openAndSubmitToExisting(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Upgrade to add more.');
    // Dialog still open (title visible) so the user can correct and retry.
    expect(screen.getByText('Transfer stock', { selector: 'h2' })).toBeInTheDocument();
  });

  it('clears the inline error on the next attempt and closes on success', async () => {
    mockTransferStockAction
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'insufficient_stock', message: 'Not enough stock.' },
      })
      .mockResolvedValueOnce({ ok: true, data: { toLocationId: 'loc-b' } });
    const user = userEvent.setup();
    renderDialog();
    await openAndSubmitToExisting(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not enough stock.');

    await user.click(screen.getByRole('button', { name: /transfer stock/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Transfer stock', { selector: 'h2' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The "+ New location" branch — rack XOR crate, and a number-only crate.
//
// This form used to render "Rack number *" plus an optional free-text crate
// pair with no toggle, and always send the rack number ALONGSIDE the crate
// fields. Two consequences, both live:
//
//   • a NUMBER-ONLY crate was unreachable — submit was disabled without a rack
//     number, and one was always sent;
//   • rack "A1" + row "Row 3" + crate "9" produced name "Crate #9", kind
//     'crate', and DROPPED the row (REPRO B) — on a surface with no
//     confirmation step of any kind.
// ---------------------------------------------------------------------------

const BOOK_LOCS = [
  { id: 'loc-a', name: 'Receiving Dock', kind: null, warehouse_id: 'wh-1' },
  { id: 'loc-b', name: '22-B', kind: 'rack', warehouse_id: 'wh-1' },
];

function renderBookDialog() {
  return render(
    <StockTransferDialog
      itemId="item-1"
      itemName="Persepolis"
      currentQuantity={40}
      currentLocationId={null}
      locations={BOOK_LOCS as never}
      holdings={
        [
          {
            locationId: 'loc-a',
            name: 'Receiving Dock',
            quantity: 40,
            kind: null,
            warehouseId: 'wh-1',
          },
        ] as never
      }
      itemType="book"
      bookStorage={
        {
          rackNumber: null,
          rackRow: null,
          crateColor: 'blue',
          crateNumber: '4',
          grade: null,
          rackLabel: null,
          crateLabel: 'Blue 4',
        } as never
      }
      canManageLocations
    />,
  );
}

async function openNewLocation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /transfer/i }));
  const destination = screen.getAllByRole('combobox')[1]!;
  await user.click(destination);
  await user.click(await screen.findByRole('option', { name: /new location/i }));
}

describe('StockTransferDialog — new rack / crate', () => {
  it('offers an EXPLICIT Rack|Crate choice for a book', async () => {
    const user = userEvent.setup();
    renderBookDialog();
    await openNewLocation(user);
    expect(screen.getByRole('radio', { name: 'Rack' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Crate' })).toBeInTheDocument();
  });

  it('a NUMBER-ONLY crate is reachable, and sends NO rack number', async () => {
    mockTransferStockAction.mockResolvedValueOnce({ ok: true, data: { toLocationId: 'new' } });
    const user = userEvent.setup();
    renderBookDialog();
    await openNewLocation(user);

    await user.click(screen.getByRole('radio', { name: 'Crate' }));
    // The rack number box is GONE in this branch — there is nothing to fill in
    // that could travel alongside the crate.
    expect(screen.queryByLabelText(/rack number/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/crate number/i), '9');

    await user.click(screen.getByRole('button', { name: /transfer stock/i }));
    // "Crate #9" does not exist in this warehouse, so it is a creation and the
    // confirmation names EXACTLY what will be made.
    expect(await screen.findByText('Create new crate Crate #9?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create and transfer/i }));

    expect(mockTransferStockAction).toHaveBeenCalledOnce();
    const arg = mockTransferStockAction.mock.calls[0]![0] as {
      destination: { newRack: Record<string, unknown> };
    };
    expect(arg.destination.newRack).toEqual({ warehouseId: 'wh-1', crateNumber: '9' });
  });

  it('the RACK branch sends no crate fields, row and all', async () => {
    mockTransferStockAction.mockResolvedValueOnce({ ok: true, data: { toLocationId: 'new' } });
    const user = userEvent.setup();
    renderBookDialog();
    await openNewLocation(user);

    await user.type(screen.getByLabelText(/rack number/i), 'A1');
    await user.type(screen.getByLabelText(/^row/i), 'Row 3');
    // …and the crate boxes are not rendered at all in this branch.
    expect(screen.queryByLabelText(/crate number/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /transfer stock/i }));
    // REPRO B produced "Crate #9" for this input. The confirmation now names
    // the rack, and the payload carries only rack fields.
    expect(await screen.findByText('Create new rack A1-Row 3?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create and transfer/i }));

    const arg = mockTransferStockAction.mock.calls[0]![0] as {
      destination: { newRack: Record<string, unknown> };
    };
    expect(arg.destination.newRack).toEqual({
      warehouseId: 'wh-1',
      rackNumber: 'A1',
      rackRow: 'Row 3',
    });
  });

  it('the crate colour is the CRATE_COLORS registry, not a free-text box', async () => {
    const user = userEvent.setup();
    renderBookDialog();
    await openNewLocation(user);
    await user.click(screen.getByRole('radio', { name: 'Crate' }));
    // A Select trigger, not an <input>: typing "navy" used to mint a colour no
    // swatch, filter or label sheet can render.
    expect(screen.getByRole('combobox', { name: /crate color/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The book-crate confirmation, driven ENTIRELY by the server's refusal.
//
// transferStockAction used to move crated stock and never touch the summary,
// with a comment saying the Transfer modal had no way to ask. This is that way.
// The dialog deliberately does NOT predict from its own render-time snapshot —
// the only thing a stale snapshot can do here is ask the wrong question.
// ---------------------------------------------------------------------------

describe('StockTransferDialog — the crate confirmation', () => {
  const REFUSAL = {
    ok: false,
    error: {
      code: 'conflict',
      message: 'Persepolis is recorded in Blue 4. Placing it here will change that to no crate.',
      details: {
        reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
        items: [
          {
            itemId: 'item-1',
            itemName: 'Persepolis',
            currentLabel: 'Blue 4',
            nextLabel: null,
            currentFingerprint: '["blue","4"]',
          },
        ],
      },
    },
  };

  async function submitToExistingRack(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: /transfer/i }));
    const destination = screen.getAllByRole('combobox')[1]!;
    await user.click(destination);
    await user.click(await screen.findByRole('option', { name: '22-B' }));
    await user.click(screen.getByRole('button', { name: /transfer stock/i }));
  }

  it('renders the server payload and retries with a SCOPED acknowledgement', async () => {
    mockTransferStockAction
      .mockResolvedValueOnce(REFUSAL)
      .mockResolvedValueOnce({ ok: true, data: { toLocationId: 'loc-b' } });
    const user = userEvent.setup();
    renderBookDialog();
    await submitToExistingRack(user);

    // The question names the crate the SERVER just read, not the snapshot.
    expect(await screen.findByText('Change this book’s crate?')).toBeInTheDocument();
    // The aggregated summary names the crate the server just read. (The
    // "Current storage" panel behind the confirmation also says Blue 4 — that
    // one is the render-time snapshot, and it is context only.)
    expect(screen.getByRole('alertdialog')).toHaveTextContent('now in Blue 4');

    await user.click(screen.getByRole('button', { name: /continue transfer/i }));

    expect(mockTransferStockAction).toHaveBeenCalledTimes(2);
    // The FIRST request carried no acknowledgement — the gate is what asked.
    expect(mockTransferStockAction.mock.calls[0]![0]).not.toHaveProperty(
      'acknowledgedCrateChanges',
    );
    // The retry acknowledges EXACTLY the change that was displayed.
    expect(mockTransferStockAction.mock.calls[1]![0]).toMatchObject({
      acknowledgedCrateChanges: [{ itemId: 'item-1', currentFingerprint: '["blue","4"]' }],
    });
  });

  it('a refusal that survives the acknowledgement falls back to the inline error', async () => {
    // Not a staleness loop: the payload is identical to the one already
    // answered, so re-asking would offer a Continue button that can only fail.
    mockTransferStockAction.mockResolvedValue(REFUSAL);
    const user = userEvent.setup();
    renderBookDialog();
    await submitToExistingRack(user);
    await user.click(await screen.findByRole('button', { name: /continue transfer/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('recorded in Blue 4');
    expect(screen.queryByRole('button', { name: /continue transfer/i })).not.toBeInTheDocument();
  });

  it('a CREATION confirmation never answers a crate question nobody asked', async () => {
    mockTransferStockAction.mockResolvedValueOnce({ ok: true, data: { toLocationId: 'new' } });
    const user = userEvent.setup();
    renderBookDialog();
    await openNewLocation(user);
    await user.type(screen.getByLabelText(/rack number/i), 'A1');
    await user.click(screen.getByRole('button', { name: /transfer stock/i }));
    await user.click(await screen.findByRole('button', { name: /create and transfer/i }));

    expect(mockTransferStockAction.mock.calls[0]![0]).not.toHaveProperty(
      'acknowledgedCrateChanges',
    );
  });
});

import type { BookStorageInfo } from '@stockpilot/core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { mockPlaceStockAction, mockToast } = vi.hoisted(() => ({
  mockPlaceStockAction: vi.fn(),
  mockToast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/server/actions/inventory', () => ({
  placeStockAction: mockPlaceStockAction,
}));
vi.mock('sonner', () => ({ toast: mockToast }));

import { PlaceFromStagingDialog } from './place-from-staging-dialog';

// The warehouse from the 2026-07-23 incident: 1-A and 10-A exist, no 100-A.
// Plus two real crates, which is what the dialog could never see before the
// destination rows carried migration 0188's crate columns.
const DESTINATIONS = [
  { id: 'r-1a', name: '1-A', kind: 'rack', rackNumber: '1', rackRow: 'A', crateColor: null, crateNumber: null },
  { id: 'r-10a', name: '10-A', kind: 'rack', rackNumber: '10', rackRow: 'A', crateColor: null, crateNumber: null },
  { id: 'r-22b', name: '22-B', kind: 'rack', rackNumber: '22', rackRow: 'B', crateColor: null, crateNumber: null },
  { id: 'c-blue4', name: 'Blue #4', kind: 'crate', rackNumber: null, rackRow: null, crateColor: 'blue', crateNumber: '4' },
  { id: 'c-blue42', name: 'Blue #42', kind: 'crate', rackNumber: null, rackRow: null, crateColor: 'blue', crateNumber: '42' },
];

/** A book recorded in Blue 4 on rack 38-A — the summary the row carries. */
const IN_BLUE_4: BookStorageInfo = {
  rackNumber: '38',
  rackRow: 'A',
  crateColor: 'blue',
  crateNumber: '4',
  grade: null,
  rackLabel: '38-A',
  crateLabel: 'Blue 4',
};

function renderDialog() {
  return render(
    <PlaceFromStagingDialog
      itemId="item-1"
      itemName="Trail Runner"
      itemType="asset"
      sourceLocationId="stg-1"
      sourceKind="staging"
      warehouseId="wh-1"
      warehouseName="Main Warehouse"
      availableQuantity={242}
      destinations={DESTINATIONS}
    />,
  );
}

function renderBookDialog(
  opts: { bookStorage?: BookStorageInfo | null; availableQuantity?: number } = {},
) {
  return render(
    <PlaceFromStagingDialog
      itemId="book-1"
      itemName="The Outsiders"
      itemType="book"
      sourceLocationId="stg-1"
      sourceKind="staging"
      warehouseId="wh-1"
      warehouseName="Main Warehouse"
      availableQuantity={opts.availableQuantity ?? 10}
      destinations={DESTINATIONS}
      bookStorage={opts.bookStorage === undefined ? IN_BLUE_4 : opts.bookStorage}
    />,
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^place$/i }));
}

async function chooseDestination(user: ReturnType<typeof userEvent.setup>, name: string | RegExp) {
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name }));
}

async function openNewRackForm(user: ReturnType<typeof userEvent.setup>) {
  await openDialog(user);
  await chooseDestination(user, /new rack \/ crate/i);
}

beforeEach(() => {
  mockPlaceStockAction.mockReset();
  mockPlaceStockAction.mockResolvedValue({ ok: true, data: { toLocationId: 'x' } });
  mockToast.success.mockReset();
  mockToast.error.mockReset();
  mockToast.warning.mockReset();
});

describe('PlaceFromStagingDialog — new-rack confirmation', () => {
  it('placing into an EXISTING rack never asks — the common path is unchanged', async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await chooseDestination(user, '22-B');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    // Went straight through — no confirmation dialog was interposed.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      existingLocationId: 'r-22b',
    });
  });

  it('typing a genuinely new rack pauses for confirmation before creating it', async () => {
    const user = userEvent.setup();
    renderDialog();
    await openNewRackForm(user);
    await user.type(screen.getByLabelText(/rack number/i), '100-A');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    // Nothing created yet — the write is withheld until confirmation.
    expect(mockPlaceStockAction).not.toHaveBeenCalled();
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Create new rack 100-A?');
    expect(confirm).toHaveTextContent('does not exist in Main Warehouse yet');
    expect(confirm).toHaveTextContent('242 units');
    // Near-match offered as a one-tap alternative.
    expect(confirm).toHaveTextContent(/Did you mean/i);
    expect(within(confirm).getByRole('button', { name: /use 10-A instead/i })).toBeInTheDocument();

    // Confirming creates the rack and places into it.
    await user.click(screen.getByRole('button', { name: /create and place/i }));
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      newRack: { warehouseId: 'wh-1', rackNumber: '100-A' },
    });
  });

  it('the near-match one-tap places into the EXISTING rack, creating nothing', async () => {
    const user = userEvent.setup();
    renderDialog();
    await openNewRackForm(user);
    await user.type(screen.getByLabelText(/rack number/i), '100-A');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    await user.click(screen.getByRole('button', { name: /use 10-A instead/i }));
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    // Existing-location path — no rack is minted.
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      existingLocationId: 'r-10a',
    });
  });

  it('typing the name of an existing rack in the new-rack form does not ask', async () => {
    const user = userEvent.setup();
    renderDialog();
    await openNewRackForm(user);
    // "22-b " — same rack to a human; the server reuses it, so no confirmation.
    await user.type(screen.getByLabelText(/rack number/i), '22-b ');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BOOK CRATES
// ═══════════════════════════════════════════════════════════════════════════

describe('PlaceFromStagingDialog — book crate controls', () => {
  it('a BOOK shows its current storage; a non-book shows none', async () => {
    const user = userEvent.setup();
    const { unmount } = renderBookDialog();
    await openDialog(user);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/current storage/i)).toBeInTheDocument();
    // The crate is named, never signalled by color alone.
    expect(dialog).toHaveTextContent('Blue');
    expect(dialog).toHaveTextContent('38-A');
    unmount();

    renderDialog();
    await openDialog(user);
    expect(screen.queryByText(/current storage/i)).not.toBeInTheDocument();
  });

  it('a BOOK can choose Crate explicitly; a non-book gets the rack form only', async () => {
    const user = userEvent.setup();
    const { unmount } = renderBookDialog();
    await openNewRackForm(user);
    // Rack vs crate is an EXPLICIT choice now, not a side effect of typing a color.
    expect(screen.getByRole('radio', { name: 'Rack' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'Crate' }));
    expect(screen.getByLabelText(/crate number/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/rack number/i)).not.toBeInTheDocument();
    unmount();

    renderDialog();
    await openNewRackForm(user);
    expect(screen.queryByRole('radio', { name: 'Crate' })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/rack number/i)).toBeInTheDocument();
  });

  it('an EXISTING crate destination shows its own metadata — nothing to retype', async () => {
    const user = userEvent.setup();
    renderBookDialog();
    await openDialog(user);
    await chooseDestination(user, 'Blue #42');

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('This crate is');
    expect(dialog).toHaveTextContent('42');
    // No crate inputs are rendered for an existing destination at all.
    expect(screen.queryByLabelText(/crate number/i)).not.toBeInTheDocument();
  });

  it('placing into the SAME crate does NOT warn', async () => {
    const user = userEvent.setup();
    renderBookDialog();
    await openDialog(user);
    await chooseDestination(user, 'Blue #4');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    // Nothing is being overwritten, so nothing is acknowledged.
    expect(mockPlaceStockAction.mock.calls[0]![0].acknowledgeCrateChange).toBeUndefined();
  });

  it('a DIFFERENT crate warns naming the OLD and the NEW value, and Go back returns to the form', async () => {
    const user = userEvent.setup();
    renderBookDialog();
    await openDialog(user);
    await chooseDestination(user, 'Blue #42');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Crate number will change from 4 to 42.');
    // Same color both sides — it must not claim a color change.
    expect(confirm).not.toHaveTextContent(/crate color/i);
    // NOTHING has been sent: the question comes before the write.
    expect(mockPlaceStockAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /go back/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockPlaceStockAction).not.toHaveBeenCalled();
    // Back on the form, with the destination still selected.
    expect(screen.getByRole('button', { name: /place stock/i })).toBeInTheDocument();
  });

  it('Continue placement sends the acknowledgement', async () => {
    const user = userEvent.setup();
    renderBookDialog();
    await openDialog(user);
    await chooseDestination(user, 'Blue #42');
    await user.click(screen.getByRole('button', { name: /place stock/i }));
    await user.click(screen.getByRole('button', { name: /continue placement/i }));

    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(mockPlaceStockAction.mock.calls[0]![0]).toMatchObject({
      destination: { existingLocationId: 'c-blue42' },
      acknowledgeCrateChange: true,
    });
  });

  it('a rack destination warns that the recorded crate is CLEARED', async () => {
    const user = userEvent.setup();
    renderBookDialog();
    await openDialog(user);
    await chooseDestination(user, '22-B');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Crate color Blue will be cleared.');
    expect(confirm).toHaveTextContent('Crate number 4 will be cleared.');
    // The rack this ALSO changes belongs in the same dialog, not a second one.
    expect(confirm).toHaveTextContent('Rack will change from 38-A to 22-B.');
  });

  it('ONE dialog asks both questions when a new crate is created over a recorded one', async () => {
    const user = userEvent.setup();
    renderBookDialog();
    await openNewRackForm(user);
    await user.click(screen.getByRole('radio', { name: 'Crate' }));
    await user.click(screen.getByLabelText(/crate color/i));
    await user.click(await screen.findByRole('option', { name: 'Green' }));
    await user.type(screen.getByLabelText(/crate number/i), '7');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Create new crate Green #7?');
    expect(confirm).toHaveTextContent('Crate color will change from Blue to Green.');
    expect(confirm).toHaveTextContent('Crate number will change from 4 to 7.');

    await user.click(screen.getByRole('button', { name: /create and place/i }));
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(mockPlaceStockAction.mock.calls[0]![0]).toMatchObject({
      destination: { newRack: { warehouseId: 'wh-1', crateColor: 'green', crateNumber: '7' } },
      acknowledgeCrateChange: true,
    });
  });

  it('a crate identified by its NUMBER ALONE is created as a crate, with no rack number', async () => {
    const user = userEvent.setup();
    renderBookDialog({ bookStorage: null });
    await openNewRackForm(user);
    await user.click(screen.getByRole('radio', { name: 'Crate' }));
    await user.type(screen.getByLabelText(/crate number/i), '9');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Create new crate Crate #9?');
    await user.click(screen.getByRole('button', { name: /create and place/i }));
    // No rackNumber in the payload: sending one is what used to make the
    // server resolve a colorless crate as a RACK.
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      newRack: { warehouseId: 'wh-1', crateNumber: '9' },
    });
  });

  it('a partial placement says what stays behind before it commits', async () => {
    const user = userEvent.setup();
    renderBookDialog({ availableQuantity: 17 });
    await openDialog(user);
    await chooseDestination(user, 'Blue #42');
    const qty = screen.getByLabelText(/quantity/i);
    await user.clear(qty);
    await user.type(qty, '5');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      '12 of 17 will stay in staging, so this title will sit in more than one place.',
    );
  });

  it("the SERVER's refusal is rendered and retried with the acknowledgement", async () => {
    const user = userEvent.setup();
    // No local summary, so the dialog cannot predict — exactly the case the
    // structured payload exists for (and the case a stale snapshot produces).
    mockPlaceStockAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message: 'The Outsiders is recorded in Blue 4. Placing it here will change that to Blue 42.',
        details: {
          reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
          items: [
            {
              itemId: 'book-1',
              itemName: 'The Outsiders',
              currentLabel: 'Blue 4',
              nextLabel: 'Blue 42',
            },
          ],
        },
      },
    });
    renderBookDialog({ bookStorage: null });
    await openDialog(user);
    await chooseDestination(user, 'Blue #42');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(mockPlaceStockAction.mock.calls[0]![0].acknowledgeCrateChange).toBeUndefined();
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('1 title will be recorded in Blue 42');
    expect(confirm).toHaveTextContent('1 title now in Blue 4');

    await user.click(screen.getByRole('button', { name: /continue placement/i }));
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(2);
    expect(mockPlaceStockAction.mock.calls[1]![0].acknowledgeCrateChange).toBe(true);
  });

  it('disables both confirmation buttons while the placement is in flight', async () => {
    const user = userEvent.setup();
    mockPlaceStockAction.mockReturnValue(new Promise(() => {}));
    renderBookDialog();
    await openDialog(user);
    await chooseDestination(user, 'Blue #42');
    await user.click(screen.getByRole('button', { name: /place stock/i }));
    await user.click(screen.getByRole('button', { name: /continue placement/i }));

    // A second click cannot double-place.
    const confirm = screen.getByRole('alertdialog');
    expect(within(confirm).getByRole('button', { name: /go back/i })).toBeDisabled();
    expect(within(confirm).getByRole('button', { name: /continue placement/i })).toBeDisabled();
    await user.click(within(confirm).getByRole('button', { name: /continue placement/i }));
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
  });

  it('names the quantity and the crate on success', async () => {
    const user = userEvent.setup();
    renderBookDialog({ availableQuantity: 10 });
    await openDialog(user);
    await chooseDestination(user, 'Blue #42');
    await user.click(screen.getByRole('button', { name: /place stock/i }));
    await user.click(screen.getByRole('button', { name: /continue placement/i }));

    expect(mockToast.success).toHaveBeenCalledWith(
      'Placed 10 copies of The Outsiders into Blue crate 42.',
    );
  });

  it('says so when the summary was left alone because the title is now split', async () => {
    const user = userEvent.setup();
    mockPlaceStockAction.mockResolvedValue({
      ok: true,
      data: { toLocationId: 'c-blue4', crateSyncSkipped: true },
    });
    renderBookDialog();
    await openDialog(user);
    await chooseDestination(user, 'Blue #4');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(mockToast.warning).toHaveBeenCalledWith(
      'The Outsiders now has stock in more than one location, so its crate label was left unchanged.',
    );
  });
});

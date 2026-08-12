import { bookCrateFingerprint, type BookStorageInfo } from '@stockpilot/core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { mockBulkPlace, mockToast } = vi.hoisted(() => ({
  mockBulkPlace: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/server/actions/inventory', () => ({
  bulkPlaceStockAction: mockBulkPlace,
}));
vi.mock('sonner', () => ({ toast: mockToast }));

import { BulkPlaceDialog, type BulkPlaceRow } from './bulk-place-dialog';

// The 2026-07-23 incident warehouse: 1-A and 10-A exist, no 100-A. Plus a crate.
const DESTINATIONS_MAP = {
  'wh-1': [
    { id: 'r-1a', name: '1-A', kind: 'rack', rackNumber: '1', rackRow: 'A', crateColor: null, crateNumber: null },
    { id: 'r-10a', name: '10-A', kind: 'rack', rackNumber: '10', rackRow: 'A', crateColor: null, crateNumber: null },
    { id: 'c-red7', name: 'Red #7', kind: 'crate', rackNumber: null, rackRow: null, crateColor: 'red', crateNumber: '7' },
  ],
};

function storage(color: string | null, number: string | null): BookStorageInfo {
  return {
    rackNumber: null,
    rackRow: null,
    crateColor: color,
    crateNumber: number,
    grade: null,
    rackLabel: null,
    crateLabel: number ? `${color ? color[0]!.toUpperCase() + color.slice(1) : ''} ${number}`.trim() : null,
  };
}

// Books with NOTHING recorded — a first assignment is never a confirmation, so
// these keep the rack-guard tests measuring only the rack guard.
const ROWS: BulkPlaceRow[] = [
  { itemId: 'i-1', name: 'Persepolis', itemType: 'book', sourceLocationId: 'stg-1', quantity: 140, warehouseId: 'wh-1', bookStorage: storage(null, null) },
  { itemId: 'i-2', name: 'Maus I', itemType: 'book', sourceLocationId: 'stg-1', quantity: 40, warehouseId: 'wh-1', bookStorage: storage(null, null) },
];

/** 8 books: 4 in Blue 4, 2 in Green 2, 2 with nothing recorded. */
const EIGHT_BOOKS: BulkPlaceRow[] = [
  ...Array.from({ length: 4 }, (_, i) => ({
    itemId: `blue-${i}`, name: `Blue book ${i}`, itemType: 'book',
    sourceLocationId: 'stg-1', quantity: 1, warehouseId: 'wh-1', bookStorage: storage('blue', '4'),
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    itemId: `green-${i}`, name: `Green book ${i}`, itemType: 'book',
    sourceLocationId: 'stg-1', quantity: 1, warehouseId: 'wh-1', bookStorage: storage('green', '2'),
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    itemId: `none-${i}`, name: `Unrecorded book ${i}`, itemType: 'book',
    sourceLocationId: 'stg-1', quantity: 1, warehouseId: 'wh-1', bookStorage: storage(null, null),
  })),
];

function renderDialog(rows: BulkPlaceRow[] = ROWS) {
  return render(
    <BulkPlaceDialog
      rows={rows}
      destinationsMap={DESTINATIONS_MAP}
      warehouseNames={{ 'wh-1': 'Main Warehouse' }}
      onPlaced={() => {}}
      trigger={<button>Place selected</button>}
    />,
  );
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /place selected/i }));
}

async function chooseDestination(user: ReturnType<typeof userEvent.setup>, name: string | RegExp) {
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name }));
}

beforeEach(() => {
  mockBulkPlace.mockReset();
  mockBulkPlace.mockResolvedValue({ ok: true, data: { placed: 2, failed: [] } });
  mockToast.success.mockReset();
  mockToast.error.mockReset();
  mockToast.warning.mockReset();
});

describe('BulkPlaceDialog — new-rack confirmation (2026-07-23 incident)', () => {
  it('placing into an EXISTING rack never asks — the common path is unchanged', async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);
    await chooseDestination(user, '1-A');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockBulkPlace).toHaveBeenCalledTimes(1);
    expect(mockBulkPlace.mock.calls[0]![0].destination).toEqual({ existingLocationId: 'r-1a' });
  });

  it('typing a genuinely new rack PAUSES for confirmation before creating it — the bug', async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);
    await chooseDestination(user, /new rack/i);
    await user.type(screen.getByLabelText(/rack number/i), '100-A');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    // Nothing placed yet — this is the exact silent-create the incident hit.
    expect(mockBulkPlace).not.toHaveBeenCalled();
    const confirm = screen.getByRole('alertdialog');
    expect(within(confirm).getByText(/create new rack 100-A/i)).toBeInTheDocument();
    // The near-match from the incident is offered.
    expect(within(confirm).getByRole('button', { name: /use 1-A instead/i })).toBeInTheDocument();
  });

  it('confirming creates the rack and places every selected row into it', async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);
    await chooseDestination(user, /new rack/i);
    await user.type(screen.getByLabelText(/rack number/i), '100-A');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));
    await user.click(screen.getByRole('button', { name: /create and place/i }));

    expect(mockBulkPlace).toHaveBeenCalledTimes(1);
    expect(mockBulkPlace.mock.calls[0]![0].destination).toEqual({
      newRack: { warehouseId: 'wh-1', rackNumber: '100-A' },
    });
    expect(mockBulkPlace.mock.calls[0]![0].placements).toHaveLength(2);
  });

  it('the near-match one-tap places into the EXISTING rack, creating nothing', async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);
    await chooseDestination(user, /new rack/i);
    await user.type(screen.getByLabelText(/rack number/i), '100-A');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));
    await user.click(screen.getByRole('button', { name: /use 1-A instead/i }));

    expect(mockBulkPlace).toHaveBeenCalledTimes(1);
    expect(mockBulkPlace.mock.calls[0]![0].destination).toEqual({ existingLocationId: 'r-1a' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BOOK CRATES IN BULK
// ═══════════════════════════════════════════════════════════════════════════

const MIXED: BulkPlaceRow[] = [
  ROWS[0]!,
  { itemId: 'i-3', name: 'Acer Chromebook', itemType: 'product', sourceLocationId: 'stg-1', quantity: 5, warehouseId: 'wh-1', bookStorage: null },
];

describe('BulkPlaceDialog — book crates', () => {
  it('an ALL-BOOKS selection can create a crate', async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);
    await chooseDestination(user, /new rack \/ crate/i);
    await user.click(screen.getByRole('radio', { name: 'Crate' }));
    await user.type(screen.getByLabelText(/crate number/i), '9');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));
    await user.click(screen.getByRole('button', { name: /create and place 2/i }));

    expect(mockBulkPlace.mock.calls[0]![0].destination).toEqual({
      newRack: { warehouseId: 'wh-1', crateNumber: '9' },
    });
  });

  it('a MIXED selection is rack-only — no crate can be minted over non-books', async () => {
    const user = userEvent.setup();
    renderDialog(MIXED);
    await open(user);
    // The option itself no longer offers a crate.
    await user.click(screen.getByRole('combobox'));
    expect(await screen.findByRole('option', { name: '+ New rack' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: '+ New rack' }));

    expect(screen.queryByRole('radio', { name: 'Crate' })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/rack number/i)).toBeInTheDocument();
    expect(screen.getByText(/place books on their own to create a crate/i)).toBeInTheDocument();
  });

  it('a MIXED selection placed into an EXISTING crate says which rows get no crate', async () => {
    const user = userEvent.setup();
    renderDialog(MIXED);
    await open(user);
    await chooseDestination(user, 'Red #7');

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('This crate is');
    expect(dialog).toHaveTextContent('1 of the 2 selected rows is not a book');
  });

  it('warns ONCE for the whole selection, aggregated by the crate each title is in today', async () => {
    const user = userEvent.setup();
    renderDialog(EIGHT_BOOKS);
    await open(user);
    await chooseDestination(user, 'Red #7');
    await user.click(screen.getByRole('button', { name: /^place 8$/i }));

    // ONE dialog, not one per title.
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    const confirm = screen.getByRole('alertdialog');
    // The two titles with nothing recorded are NOT overwrites and never reach it.
    expect(confirm).toHaveTextContent('6 titles will be recorded in Red 7');
    expect(confirm).toHaveTextContent('4 titles now in Blue 4');
    expect(confirm).toHaveTextContent('2 titles now in Green 2');
    expect(mockBulkPlace).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /continue placement/i }));
    expect(mockBulkPlace).toHaveBeenCalledTimes(1);
    // One entry per LISTED title, each pinned to the crate it was listed in.
    // The two books with nothing recorded are not overwrites, so they are
    // absent — a click on Continue answers only the question that was asked.
    const ack = mockBulkPlace.mock.calls[0]![0].acknowledgedCrateChanges as Array<{
      itemId: string;
      currentFingerprint: string;
    }>;
    expect(ack).toHaveLength(6);
    expect(ack.filter((a) => a.currentFingerprint === bookCrateFingerprint('blue', '4'))).toHaveLength(4);
    expect(ack.filter((a) => a.currentFingerprint === bookCrateFingerprint('green', '2'))).toHaveLength(2);
    expect(ack.some((a) => a.itemId.startsWith('none-'))).toBe(false);
  });

  it('a RACK destination warns that every recorded crate is cleared', async () => {
    const user = userEvent.setup();
    renderDialog(ROWS.map((r) => ({ ...r, bookStorage: storage('blue', '4') })));
    await open(user);
    await chooseDestination(user, '1-A');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('2 titles will be recorded in no crate');
    expect(confirm).toHaveTextContent('2 titles now in Blue 4');
    expect(mockBulkPlace).not.toHaveBeenCalled();
  });

  it('does not warn when every selected book is already in that crate', async () => {
    const user = userEvent.setup();
    const inRed7 = ROWS.map((r) => ({ ...r, bookStorage: storage('red', '7') }));
    renderDialog(inRed7);
    await open(user);
    await chooseDestination(user, 'Red #7');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockBulkPlace).toHaveBeenCalledTimes(1);
    expect(mockBulkPlace.mock.calls[0]![0].acknowledgedCrateChanges).toBeUndefined();
  });

  it("re-renders the SERVER's refusal and retries it acknowledged", async () => {
    const user = userEvent.setup();
    mockBulkPlace.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message: '2 books are recorded in a different crate. Placing them here will change that.',
        details: {
          reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
          items: [
            {
              itemId: 'i-1',
              itemName: 'Persepolis',
              currentLabel: 'Blue 4',
              nextLabel: 'Red 7',
              currentFingerprint: bookCrateFingerprint('blue', '4'),
            },
            {
              itemId: 'i-2',
              itemName: 'Maus I',
              currentLabel: 'Green 2',
              nextLabel: 'Red 7',
              currentFingerprint: bookCrateFingerprint('green', '2'),
            },
          ],
        },
      },
    });
    // No local summaries, so nothing is predicted — the payload is the only source.
    renderDialog(ROWS.map((r) => ({ ...r, bookStorage: null })));
    await open(user);
    await chooseDestination(user, 'Red #7');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('2 titles will be recorded in Red 7');
    await user.click(screen.getByRole('button', { name: /continue placement/i }));
    expect(mockBulkPlace).toHaveBeenCalledTimes(2);
    expect(mockBulkPlace.mock.calls[1]![0].acknowledgedCrateChanges).toEqual([
      { itemId: 'i-1', currentFingerprint: bookCrateFingerprint('blue', '4') },
      { itemId: 'i-2', currentFingerprint: bookCrateFingerprint('green', '2') },
    ]);
  });

  it('the FIRST request from a PREDICTING bulk dialog carries no blanket waiver', async () => {
    const user = userEvent.setup();
    // Every row carries a summary, so the prediction fires — the case the
    // earlier retry test deliberately avoided by setting bookStorage: null.
    renderDialog(EIGHT_BOOKS);
    await open(user);
    await chooseDestination(user, 'Red #7');
    await user.click(screen.getByRole('button', { name: /^place 8$/i }));
    await user.click(screen.getByRole('button', { name: /continue placement/i }));

    const sent = mockBulkPlace.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.acknowledgeCrateChange).toBeUndefined();
    expect(Object.values(sent).some((v) => v === true)).toBe(false);
    expect(Array.isArray(sent.acknowledgedCrateChanges)).toBe(true);
  });

  it('ONE stale title refuses the batch and re-asks with the crate it really holds', async () => {
    const user = userEvent.setup();
    // The selection shows Persepolis in Blue 4. It is really in Red 7 now, so
    // the batch is refused even though the other five lines were accurate.
    mockBulkPlace.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message: '2 books are recorded in a different crate. Placing them here will change that.',
        details: {
          reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
          items: [
            {
              itemId: 'blue-0',
              itemName: 'Blue book 0',
              currentLabel: 'Red 7',
              nextLabel: 'Red 7',
              currentFingerprint: bookCrateFingerprint('red', '7'),
            },
            {
              itemId: 'green-0',
              itemName: 'Green book 0',
              currentLabel: 'Green 2',
              nextLabel: 'Red 7',
              currentFingerprint: bookCrateFingerprint('green', '2'),
            },
          ],
        },
      },
    });
    renderDialog(EIGHT_BOOKS);
    await open(user);
    await chooseDestination(user, 'Red #7');
    await user.click(screen.getByRole('button', { name: /^place 8$/i }));
    await user.click(screen.getByRole('button', { name: /continue placement/i }));

    // Nothing placed; asked again from the SERVER's list.
    expect(mockBulkPlace).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('1 title now in Red 7');

    await user.click(screen.getByRole('button', { name: /continue placement/i }));
    expect(mockBulkPlace).toHaveBeenCalledTimes(2);
    expect(mockBulkPlace.mock.calls[1]![0].acknowledgedCrateChanges).toEqual([
      { itemId: 'blue-0', currentFingerprint: bookCrateFingerprint('red', '7') },
      { itemId: 'green-0', currentFingerprint: bookCrateFingerprint('green', '2') },
    ]);
  });

  it('names the destination on success', async () => {
    const user = userEvent.setup();
    renderDialog(ROWS.map((r) => ({ ...r, bookStorage: storage('red', '7') })));
    await open(user);
    await chooseDestination(user, 'Red #7');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    expect(mockToast.success).toHaveBeenCalledWith('Placed 2 items into Red crate 7.');
  });
});

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

  it('an ALL-BOOKS selection can create a crate ON A RACK, and names both', async () => {
    // Bulk put-away is where five books land in "gray BIN" at once, so this is
    // the surface where a position-blind crate would merge two physical bins
    // fastest. The whole batch goes into ONE named row: "Gray #BIN on rack
    // 43-B".
    const user = userEvent.setup();
    renderDialog();
    await open(user);
    await chooseDestination(user, /new rack \/ crate/i);
    await user.click(screen.getByRole('radio', { name: 'Crate' }));
    await user.type(screen.getByLabelText(/crate number/i), 'BIN');
    await user.type(screen.getByLabelText(/on rack/i), '43');
    await user.type(screen.getByLabelText(/^row/i), 'B');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Create new crate Crate #BIN on rack 43-B?',
    );
    await user.click(screen.getByRole('button', { name: /create and place 2/i }));

    expect(mockBulkPlace.mock.calls[0]![0].destination).toEqual({
      newRack: { warehouseId: 'wh-1', crateNumber: 'BIN', rackNumber: '43', rackRow: 'B' },
    });
  });

  it('a crate whose Row has no "On rack" number cannot be submitted, and names nothing', async () => {
    // THE READINESS GATE IS THE PLANNER, OR IT DRIFTS FROM IT. The hand-rolled
    // gate checked `crateNumber` alone, so crate BIN + a Row with no "On rack"
    // number passed it — `planNewLocation` refuses that pair
    // (`rack_needs_number`), the name derived to '', and this dialog offered to
    // create "Create new crate ?" for the whole batch.
    //
    // Bulk is the worst place for it: one Continue would have taken every
    // selected row into a location nobody could name.
    const user = userEvent.setup();
    renderDialog();
    await open(user);
    await chooseDestination(user, /new rack \/ crate/i);
    await user.click(screen.getByRole('radio', { name: 'Crate' }));
    await user.type(screen.getByLabelText(/crate number/i), 'BIN');
    await user.type(screen.getByLabelText(/^row/i), 'B');

    expect(screen.getByText('Give the rack a number.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^place 2$/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /^place 2$/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/create new crate/i)).not.toBeInTheDocument();
    expect(mockBulkPlace).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/on rack/i), '43');
    expect(screen.queryByText('Give the rack a number.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^place 2$/i })).toBeEnabled();
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

  it('DEFERS the batch when the crate states no rack and a selected book records one', async () => {
    const user = userEvent.setup();
    // Same rule as the single put-away. What happens to each recorded rack is
    // decided from the live holdings after the move, which this dialog cannot
    // see — so it predicts nothing, sends no acknowledgement, and lets the gate
    // ask with the rack sentences it derived. Deferring is WHOLE-BATCH because
    // the gate is already all-or-nothing.
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
              currentLabel: 'Blue 4 on rack 38-A',
              nextLabel: 'Red 7',
              currentFingerprint: bookCrateFingerprint('blue', '4'),
              rackLine: 'Rack 38-A will be cleared.',
            },
            {
              itemId: 'i-2',
              itemName: 'Maus I',
              currentLabel: 'Blue 4 on rack 38-A',
              nextLabel: 'Red 7',
              currentFingerprint: bookCrateFingerprint('blue', '4'),
              // The SAME sentence as i-1: two books off one rack must read as
              // one line, not two identical ones.
              rackLine: 'Rack 38-A will be cleared.',
            },
          ],
        },
      },
    });
    const onRack38A = ROWS.map((r) => ({
      ...r,
      bookStorage: { ...storage('blue', '4'), rackNumber: '38', rackRow: 'A', rackLabel: '38-A' },
    }));
    renderDialog(onRack38A);
    await open(user);
    await chooseDestination(user, 'Red #7');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    // Nothing was predicted and nothing was waived.
    expect(mockBulkPlace).toHaveBeenCalledTimes(1);
    expect(mockBulkPlace.mock.calls[0]![0].acknowledgedCrateChanges).toBeUndefined();

    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Rack 38-A will be cleared.');
    // Deduped: the sentence appears once for the two books that share it.
    expect(within(confirm).getAllByText('Rack 38-A will be cleared.')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /continue placement/i }));
    expect(mockBulkPlace).toHaveBeenCalledTimes(2);
    expect(mockBulkPlace.mock.calls[1]![0].acknowledgedCrateChanges).toHaveLength(2);
  });

  it('MINTING a position-less crate defers too, so the gate names the racks it clears', async () => {
    // The single put-away's defect, in bulk. `!creating` in the deferral
    // condition kept the pre-acknowledgement alive on the branch that types a
    // brand-new crate, so a batch off rack 38-A into a new position-less crate
    // waived the gate and erased 38-A on every title with no sentence naming it.
    // Creating the location does not teach this dialog the holdings.
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
              currentLabel: 'Blue 4 on rack 38-A',
              nextLabel: '9',
              currentFingerprint: bookCrateFingerprint('blue', '4'),
              rackLine: 'Rack 38-A will be cleared.',
            },
            {
              itemId: 'i-2',
              itemName: 'Maus I',
              currentLabel: 'Blue 4 on rack 38-A',
              nextLabel: '9',
              currentFingerprint: bookCrateFingerprint('blue', '4'),
              rackLine: 'Rack 38-A will be cleared.',
            },
          ],
        },
      },
    });
    renderDialog(
      ROWS.map((r) => ({
        ...r,
        bookStorage: { ...storage('blue', '4'), rackNumber: '38', rackRow: 'A', rackLabel: '38-A' },
      })),
    );
    await open(user);
    await chooseDestination(user, /new rack \/ crate/i);
    await user.click(screen.getByRole('radio', { name: 'Crate' }));
    await user.type(screen.getByLabelText(/crate number/i), '9');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    // Only the creation question, and it claims nothing it cannot support.
    const creation = screen.getByRole('alertdialog');
    expect(creation).toHaveTextContent('Create new crate Crate #9?');
    expect(creation).not.toHaveTextContent(/now in Blue 4/i);
    expect(mockBulkPlace).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /create and place 2/i }));
    expect(mockBulkPlace).toHaveBeenCalledTimes(1);
    expect(mockBulkPlace.mock.calls[0]![0].acknowledgedCrateChanges).toBeUndefined();

    // The gate's answer replaces it, and it names 38-A once for both books.
    const gate = screen.getByRole('alertdialog');
    expect(within(gate).getAllByText('Rack 38-A will be cleared.')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /continue placement/i }));
    expect(mockBulkPlace).toHaveBeenCalledTimes(2);
    expect(mockBulkPlace.mock.calls[1]![0].acknowledgedCrateChanges).toHaveLength(2);
  });

  it('the non-book notice survives the deferral — the gate panel is the only panel', async () => {
    // Which rows get no crate label is a fact about the SELECTION, not about any
    // book's crate, so it must not disappear when the crate question is handed
    // to the server. It was built only inside the local-prediction branch.
    const user = userEvent.setup();
    mockBulkPlace.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message: 'Persepolis is recorded in Blue 4 on rack 38-A. Placing it here will change that to Red 7. Rack 38-A will be cleared.',
        details: {
          reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
          items: [
            {
              itemId: 'i-1',
              itemName: 'Persepolis',
              currentLabel: 'Blue 4 on rack 38-A',
              nextLabel: 'Red 7',
              currentFingerprint: bookCrateFingerprint('blue', '4'),
              rackLine: 'Rack 38-A will be cleared.',
            },
          ],
        },
      },
    });
    renderDialog([
      {
        ...ROWS[0]!,
        bookStorage: { ...storage('blue', '4'), rackNumber: '38', rackRow: 'A', rackLabel: '38-A' },
      },
      MIXED[1]!,
    ]);
    await open(user);
    await chooseDestination(user, 'Red #7');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    expect(mockBulkPlace).toHaveBeenCalledTimes(1);
    expect(mockBulkPlace.mock.calls[0]![0].acknowledgedCrateChanges).toBeUndefined();
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Rack 38-A will be cleared.');
    expect(confirm).toHaveTextContent(
      '1 of the 2 selected rows is not a book, so no crate is recorded for it.',
    );
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

  // ═══ THE SILENT SUCCESS — crateSyncStale ═══
  // The server refuses to overwrite a crate that was re-recorded WHILE the
  // batch was placing, and reports that as { ok: true, crateSyncStale: true }.
  // The stock landed; those summaries still name the crate the stock left. This
  // dialog branched only on crateSyncFailed/crateSyncSkipped, so the operator
  // got a plain green "Placed 2 items into Red crate 7." and nothing said the
  // labels were now wrong — while the Transfer dialog and the mobile Move-stock
  // modal both warned on exactly this flag.
  it('warns when someone else changed a crate while the batch was placing', async () => {
    const user = userEvent.setup();
    mockBulkPlace.mockResolvedValue({
      ok: true,
      data: { placed: 2, failed: [], crateSyncStale: true },
    });
    renderDialog(ROWS.map((r) => ({ ...r, bookStorage: storage('red', '7') })));
    await open(user);
    await chooseDestination(user, 'Red #7');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    // The green toast still fires — the stock DID move. The warning is what
    // stops that green toast from being the whole story.
    expect(mockToast.success).toHaveBeenCalledWith('Placed 2 items into Red crate 7.');
    expect(mockToast.warning).toHaveBeenCalledWith(
      'Someone else changed some titles’ crates while they were moving — those labels were left as they set them.',
    );
  });

  it('warns when a crate summary could not be written at all', async () => {
    const user = userEvent.setup();
    mockBulkPlace.mockResolvedValue({
      ok: true,
      data: { placed: 2, failed: [], crateSyncFailed: true },
    });
    renderDialog(ROWS.map((r) => ({ ...r, bookStorage: storage('red', '7') })));
    await open(user);
    await chooseDestination(user, 'Red #7');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    expect(mockToast.warning).toHaveBeenCalledWith(
      'Some crate labels could not be updated — check those books’ details.',
    );
  });

  // ═══ THE OTHER SILENT SUCCESS — crateSyncUnplaced ═══
  // A batch item whose stock ends up in NO rack or crate (a partial move that
  // left the rest staged, or a concurrent pick) gives the reconciliation
  // nothing authoritative to write. That branch used to be a bare `continue`:
  // no flag, plain green toast, labels still naming crates that hold none of
  // those titles.
  it('warns when a title has nothing left in a rack or crate for its label to follow', async () => {
    const user = userEvent.setup();
    mockBulkPlace.mockResolvedValue({
      ok: true,
      data: { placed: 2, failed: [], crateSyncUnplaced: true },
    });
    renderDialog(ROWS.map((r) => ({ ...r, bookStorage: storage('red', '7') })));
    await open(user);
    await chooseDestination(user, 'Red #7');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    expect(mockToast.success).toHaveBeenCalledWith('Placed 2 items into Red crate 7.');
    expect(mockToast.warning).toHaveBeenCalledWith(
      'Some titles have no stock in a rack or crate now, so their crate labels were left unchanged and may be wrong.',
    );
  });

  it('warns when a summary was left alone because the title is now split', async () => {
    const user = userEvent.setup();
    mockBulkPlace.mockResolvedValue({
      ok: true,
      data: { placed: 2, failed: [], crateSyncSkipped: true },
    });
    renderDialog(ROWS.map((r) => ({ ...r, bookStorage: storage('red', '7') })));
    await open(user);
    await chooseDestination(user, 'Red #7');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    expect(mockToast.warning).toHaveBeenCalledWith(
      'Some titles now hold stock in more than one location, so their crate labels were left unchanged.',
    );
  });
});

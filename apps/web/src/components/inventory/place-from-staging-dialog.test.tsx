import { bookCrateFingerprint, type BookStorageInfo } from '@stockpilot/core';
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

/**
 * The same book with NO rack recorded — equally real (a crate is not required to
 * sit on a rack, and plenty of books carry book_crate_* with a null rack pair).
 *
 * It exists because the two summaries now decide different things. When the
 * destination states no rack position, a book that HAS a recorded rack sends the
 * dialog down the DEFER path — the rack outcome depends on live holdings this
 * component cannot see, so it declines to predict and lets the gate ask (see
 * "defers to the server" below). A book with no rack has nothing to lose, so the
 * local prediction still fires.
 *
 * Every test whose subject is the PREDICTING path itself — what the first
 * request carries, the in-flight button state, the success toast — uses this
 * fixture, so it keeps testing the mechanism it names instead of silently
 * becoming another copy of the deferral test.
 */
const IN_BLUE_4_NO_RACK: BookStorageInfo = {
  ...IN_BLUE_4,
  rackNumber: null,
  rackRow: null,
  rackLabel: null,
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
  opts: {
    bookStorage?: BookStorageInfo | null;
    availableQuantity?: number;
    destinations?: typeof DESTINATIONS;
  } = {},
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
      destinations={opts.destinations ?? DESTINATIONS}
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
// BOOK CRATES — THE FOUR FIELDS ARE THE DESTINATION
//
// Maus I / The Joy Luck Club, L4L, 2026-08-17. This dialog offered a flat list
// of EXISTING location rows plus "+ New rack / crate", which hid the crate
// fields behind a Rack|Crate toggle. Most crates in that warehouse are label-
// only (113 of 124 books record a crate; the org has ONE crate row), so "Red 4
// on rack 38-B" — the crate the dialog had just said the book was in — was not
// in the list. The reachable choice was bare "38-B", which clears the crate;
// the gate asked; the operator pressed Continue because there was nowhere else
// to go; the label was gone.
//
// Now: for a BOOK the four fields (rack number, row, crate colour, crate
// number) are always visible, PRE-FILLED from the recorded storage, and the
// primary action places INTO exactly that crate on that rack — resolved or
// created by name on the server. The dropdown fills the fields. Blanking the
// crate is the explicit "no crate" choice, and that is when the gate asks.
// ═══════════════════════════════════════════════════════════════════════════

/** The Joy Luck Club as the owner screenshotted it: Red 4 on rack 38-B. */
const IN_RED_4_ON_38B: BookStorageInfo = {
  rackNumber: '38',
  rackRow: 'B',
  crateColor: 'red',
  crateNumber: '4',
  grade: null,
  rackLabel: '38-B',
  crateLabel: 'Red 4',
};

/** L4L's shape: rack 38-B has a row, crate Red 4 does NOT. */
const L4L_DESTINATIONS = [
  ...DESTINATIONS,
  { id: 'r-38b', name: '38-B', kind: 'rack', rackNumber: '38', rackRow: 'B', crateColor: null, crateNumber: null },
];

/** The books-only existing-location shortcut (the crate colour Select is a combobox too). */
async function chooseExisting(user: ReturnType<typeof userEvent.setup>, name: string | RegExp) {
  await user.click(screen.getByRole('combobox', { name: /existing rack \/ crate/i }));
  await user.click(await screen.findByRole('option', { name }));
}

async function chooseCrateColor(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('combobox', { name: /^crate color$/i }));
  await user.click(await screen.findByRole('option', { name }));
}

/** Blank the crate boxes — the explicit "place on the bare rack" choice. */
async function blankCrate(user: ReturnType<typeof userEvent.setup>) {
  await chooseCrateColor(user, 'No color');
  await user.clear(screen.getByLabelText(/crate number/i));
}

async function blankRack(user: ReturnType<typeof userEvent.setup>) {
  await user.clear(screen.getByLabelText(/rack number/i));
  await user.clear(screen.getByLabelText(/^row/i));
}

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

  it('a BOOK opens with the four fields PRE-FILLED from its recorded storage — no toggle, nothing hidden', async () => {
    const user = userEvent.setup();
    const { unmount } = renderBookDialog(); // Blue 4 on rack 38-A
    await openDialog(user);

    // THE PRE-FILL. "Where it already lives" is the default destination.
    expect(screen.getByLabelText(/rack number/i)).toHaveValue('38');
    expect(screen.getByLabelText(/^row/i)).toHaveValue('A');
    expect(screen.getByLabelText(/crate number/i)).toHaveValue('4');
    expect(screen.getByRole('combobox', { name: /^crate color$/i })).toHaveTextContent('Blue');
    // No Rack|Crate toggle, no "+ New" entry: the fields ARE the destination.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: /existing rack \/ crate/i }));
    expect(screen.queryByRole('option', { name: /new rack \/ crate/i })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    // Ready to place as opened — nothing to type for the common case.
    expect(screen.getByRole('button', { name: /place stock/i })).toBeEnabled();
    unmount();

    // A non-book keeps the older shape: dropdown, "+ New rack / crate", rack pair.
    renderDialog();
    await openDialog(user);
    expect(screen.queryByLabelText(/crate number/i)).not.toBeInTheDocument();
    await chooseDestination(user, /new rack \/ crate/i);
    expect(screen.getByLabelText(/rack number/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/crate number/i)).not.toBeInTheDocument();
  });

  it('a book with NOTHING recorded opens blank and cannot be placed until a place is named', async () => {
    const user = userEvent.setup();
    renderBookDialog({ bookStorage: null });
    await openDialog(user);
    expect(screen.getByLabelText(/rack number/i)).toHaveValue('');
    expect(screen.getByLabelText(/crate number/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: /place stock/i })).toBeDisabled();
    await user.type(screen.getByLabelText(/rack number/i), '22-B');
    expect(screen.getByRole('button', { name: /place stock/i })).toBeEnabled();
  });

  it('a recorded colour the registry does not know is left blank, and said so', async () => {
    const user = userEvent.setup();
    renderBookDialog({ bookStorage: { ...IN_BLUE_4, crateColor: 'taupe', crateLabel: 'taupe 4' } });
    await openDialog(user);
    expect(screen.getByRole('combobox', { name: /^crate color$/i })).toHaveTextContent(/no color/i);
    expect(screen.getByRole('dialog')).toHaveTextContent('“taupe”, is not one of the crate colors');
    expect(screen.getByLabelText(/crate number/i)).toHaveValue('4');
  });

  // ═════════════════════════════════════════════════════════════════════════
  // THE JOY LUCK CLUB — the default submit places INTO the recorded crate.
  // ═════════════════════════════════════════════════════════════════════════

  it('THE DEFAULT SUBMIT places into the exact recorded crate-on-rack: no gate, no acknowledgement, no typo guard', async () => {
    const user = userEvent.setup();
    // Red 4 on rack 38-B. Rack 38-B has a row; crate Red 4 does not — the L4L
    // shape. Before this fix "Red 4 on 38-B" was unreachable from this dialog.
    renderBookDialog({ bookStorage: IN_RED_4_ON_38B, destinations: L4L_DESTINATIONS });
    await openDialog(user);
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    // NO question of any kind — the crate pair does not change, the position
    // does not change, and the recorded truth is not a typo to guard against.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    // THE PAYLOAD, LITERALLY: the crate ON the rack, so the server resolves or
    // mints "Red #4 on rack 38-B" (0270's dedupe key, position embedded) once
    // and reuses it thereafter. No acknowledgement of anything.
    expect(mockPlaceStockAction.mock.calls[0]![0]).toEqual({
      itemId: 'book-1',
      fromLocationId: 'stg-1',
      quantity: 10,
      notes: undefined,
      destination: {
        newRack: { warehouseId: 'wh-1', crateNumber: '4', crateColor: 'red', rackNumber: '38', rackRow: 'B' },
      },
      acknowledgedRackChanges: [],
    });
    expect(mockToast.success).toHaveBeenCalledWith(
      'Placed 10 copies of The Outsiders into Red crate 4 on rack 38-B.',
    );
  });

  it('the recorded crate is minted WITHOUT the typo guard; a DIFFERENT new crate still gets it', async () => {
    const user = userEvent.setup();
    renderBookDialog(); // Blue 4 on rack 38-A — no such crate row, no such rack row
    await openDialog(user);
    await user.click(screen.getByRole('button', { name: /place stock/i }));
    // The record is not a typo: no "Create new crate Blue #4 on rack 38-A?".
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      newRack: { warehouseId: 'wh-1', crateNumber: '4', crateColor: 'blue', rackNumber: '38', rackRow: 'A' },
    });
  });

  it('typing a different crate number keeps BOTH guards — creation AND the crate change, in ONE dialog', async () => {
    const user = userEvent.setup();
    renderBookDialog(); // Blue 4 on rack 38-A
    await openDialog(user);
    const number = screen.getByLabelText(/crate number/i);
    await user.clear(number);
    await user.type(number, '7');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(mockPlaceStockAction).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Create new crate Blue #7 on rack 38-A?');
    expect(confirm).toHaveTextContent('Crate number will change from 4 to 7.');
    // Same rack both sides — no rack sentence.
    expect(confirm).not.toHaveTextContent(/rack will/i);
    await user.click(screen.getByRole('button', { name: /create and place/i }));
    expect(mockPlaceStockAction.mock.calls[0]![0]).toMatchObject({
      destination: {
        newRack: { warehouseId: 'wh-1', crateNumber: '7', crateColor: 'blue', rackNumber: '38', rackRow: 'A' },
      },
      acknowledgedCrateChanges: [
        { itemId: 'book-1', currentFingerprint: bookCrateFingerprint('blue', '4') },
      ],
    });
  });

  it('picking an existing option FILLS the four fields', async () => {
    const user = userEvent.setup();
    renderBookDialog(); // Blue 4 on rack 38-A
    await openDialog(user);
    await chooseExisting(user, 'Blue #42');
    expect(screen.getByLabelText(/crate number/i)).toHaveValue('42');
    expect(screen.getByRole('combobox', { name: /^crate color$/i })).toHaveTextContent('Blue');
    // A position-less crate row: the rack boxes go blank.
    expect(screen.getByLabelText(/rack number/i)).toHaveValue('');
    expect(screen.getByLabelText(/^row/i)).toHaveValue('');
    // An EXISTING crate already carries its metadata — shown, not retyped.
    expect(screen.getByRole('dialog')).toHaveTextContent('This crate is');

    // A bare rack row: the rack pair fills, the crate BLANKS — that is choosing
    // "no crate", and the gate will say so before the write.
    await chooseExisting(user, '22-B');
    expect(screen.getByLabelText(/rack number/i)).toHaveValue('22');
    expect(screen.getByLabelText(/^row/i)).toHaveValue('B');
    expect(screen.getByLabelText(/crate number/i)).toHaveValue('');
    expect(screen.getByRole('combobox', { name: /^crate color$/i })).toHaveTextContent(/no color/i);
  });

  it('while the fields still equal the picked row, the request goes by id — nothing is created', async () => {
    const user = userEvent.setup();
    renderBookDialog({ bookStorage: IN_BLUE_4_NO_RACK });
    await openDialog(user);
    await chooseExisting(user, 'Blue #4');
    await user.click(screen.getByRole('button', { name: /place stock/i }));
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      existingLocationId: 'c-blue4',
    });
  });

  it('typing over a picked row demotes it to the fields — the boxes win', async () => {
    const user = userEvent.setup();
    renderBookDialog({ bookStorage: IN_BLUE_4_NO_RACK });
    await openDialog(user);
    await chooseExisting(user, '22-B');
    // The operator picked 22-B and then put the crate back in.
    await user.type(screen.getByLabelText(/crate number/i), '4');
    await chooseCrateColor(user, 'Blue');
    await user.click(screen.getByRole('button', { name: /place stock/i }));
    // Blue 4 on 22-B: same crate as recorded (no crate question), a new
    // positioned row (typo guard, since 22-B is a rack row, not this crate).
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Create new crate Blue #4 on rack 22-B?');
    await user.click(screen.getByRole('button', { name: /create and place/i }));
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      newRack: { warehouseId: 'wh-1', crateNumber: '4', crateColor: 'blue', rackNumber: '22', rackRow: 'B' },
    });
    expect(mockPlaceStockAction.mock.calls[0]![0].acknowledgedCrateChanges).toBeUndefined();
  });

  it('placing into the SAME crate does NOT warn', async () => {
    const user = userEvent.setup();
    renderBookDialog();
    await openDialog(user);
    await chooseExisting(user, 'Blue #4');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    // Nothing is being overwritten, so nothing is acknowledged.
    expect(mockPlaceStockAction.mock.calls[0]![0].acknowledgedCrateChanges).toBeUndefined();
  });

  it('a DIFFERENT crate warns naming the OLD and the NEW value, and Go back returns to the form', async () => {
    const user = userEvent.setup();
    // No recorded rack — nothing about this placement is unknowable, so the
    // local prediction runs and the question is asked before the write, exactly
    // as it always has been.
    renderBookDialog({ bookStorage: IN_BLUE_4_NO_RACK });
    await openDialog(user);
    await chooseExisting(user, 'Blue #42');
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
    // Back on the form, with the destination still filled in.
    expect(screen.getByRole('button', { name: /place stock/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/crate number/i)).toHaveValue('42');
  });

  // ═════════════════════════════════════════════════════════════════════════
  // RACK-ONLY IS THE EXPLICIT "NO CRATE" CHOICE — and the one time the gate asks.
  // ═════════════════════════════════════════════════════════════════════════

  it('BLANKING the crate is the explicit no-crate choice: the gate asks, and Continue clears', async () => {
    const user = userEvent.setup();
    renderBookDialog({ bookStorage: IN_RED_4_ON_38B, destinations: L4L_DESTINATIONS });
    await openDialog(user);
    await blankCrate(user);
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    // Asked BEFORE the write, naming exactly what is being erased.
    expect(mockPlaceStockAction).not.toHaveBeenCalled();
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Change this book’s crate?');
    expect(confirm).toHaveTextContent('Crate color Red will be cleared.');
    expect(confirm).toHaveTextContent('Crate number 4 will be cleared.');
    // Same rack: no rack sentence, and no "Create new rack 38-B?" (it exists).
    expect(confirm).not.toHaveTextContent(/rack will/i);
    expect(confirm).not.toHaveTextContent(/create new/i);

    await user.click(screen.getByRole('button', { name: /continue placement/i }));
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(mockPlaceStockAction.mock.calls[0]![0]).toMatchObject({
      destination: { newRack: { warehouseId: 'wh-1', rackNumber: '38', rackRow: 'B' } },
      // The OLD-STYLE fingerprint, as a literal: this is what the server grants
      // the crate clear on, and every shipped client computes exactly this.
      acknowledgedCrateChanges: [{ itemId: 'book-1', currentFingerprint: '["red","4"]' }],
    });
  });

  it('a rack destination picked from the dropdown warns that the recorded crate is CLEARED', async () => {
    const user = userEvent.setup();
    renderBookDialog();
    await openDialog(user);
    await chooseExisting(user, '22-B');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Crate color Blue will be cleared.');
    expect(confirm).toHaveTextContent('Crate number 4 will be cleared.');
    // The rack this ALSO changes belongs in the same dialog, not a second one.
    expect(confirm).toHaveTextContent('Rack will change from 38-A to 22-B.');
    await user.click(screen.getByRole('button', { name: /continue placement/i }));
    // Picked from the dropdown and untouched: by id.
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      existingLocationId: 'r-22b',
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // THE OWNER'S WALK — a recorded rack, a POSITION-LESS crate.
  //
  // Book on rack 38-A, all its stock in staging, placed into "Blue #Shelf".
  // The dialog named both crate fields, said nothing about the rack, and
  // pre-acknowledged — so the gate, the one component that reads the holdings,
  // was satisfied and never spoke. At rest both rack keys were gone. Clearing
  // them was CORRECT (no stock remained on any rack); the silence was not.
  //
  // This dialog still cannot know whether the move is full or split, and
  // guessing would be a lie rather than a gap. So it declines to predict and
  // lets the gate ask — which is what StockTransferDialog has always done.
  // ═════════════════════════════════════════════════════════════════════════

  it('defers to the server when the destination states no rack and the book records one', async () => {
    const user = userEvent.setup();
    mockPlaceStockAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message:
          'The Outsiders is recorded in Blue 4 on rack 38-A. Placing it here will change that to Blue 42. Rack 38-A will be cleared.',
        details: {
          reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
          items: [
            {
              itemId: 'book-1',
              itemName: 'The Outsiders',
              currentLabel: 'Blue 4 on rack 38-A',
              nextLabel: 'Blue 42',
              currentFingerprint: bookCrateFingerprint('blue', '4'),
              rackLine: 'Rack 38-A will be cleared.',
            },
          ],
        },
      },
    });
    renderBookDialog(); // IN_BLUE_4 — rack 38-A recorded
    await openDialog(user);
    await chooseExisting(user, 'Blue #42');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    // No local dialog was interposed, and the first request carries NO
    // acknowledgement — this dialog did not describe the rack, so it has not
    // earned one.
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(mockPlaceStockAction.mock.calls[0]![0].acknowledgedCrateChanges).toBeUndefined();

    // The gate's answer is what the operator reads, and it names the rack.
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Rack 38-A will be cleared.');
    expect(confirm).toHaveTextContent('1 title now in Blue 4 on rack 38-A');

    await user.click(screen.getByRole('button', { name: /continue placement/i }));
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(2);
    expect(mockPlaceStockAction.mock.calls[1]![0].acknowledgedCrateChanges).toEqual([
      { itemId: 'book-1', currentFingerprint: bookCrateFingerprint('blue', '4') },
    ]);
  });

  it('a SPLIT is now asked about at all — the gate drops it and the placement runs', async () => {
    const user = userEvent.setup();
    // The holdings say this book keeps another placement, so the reconciliation
    // will leave its summary alone. The gate therefore raises no conflict, and
    // deferring means the operator is asked NOTHING for a change that provably
    // cannot happen — where the old local prediction always asked.
    renderBookDialog();
    await openDialog(user);
    await chooseExisting(user, 'Blue #42');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(mockToast.success).toHaveBeenCalled();
  });

  it('MINTING a position-less crate defers too, so the gate names the rack it clears', async () => {
    // ═════════════════════════════════════════════════════════════════════════
    // THE SAME DATA LOSS, ONE BRANCH OVER. Reproduced against the real dialog:
    // a book recorded in a crate ON RACK 38-A, all units in staging, sent to a
    // brand-new position-less "Crate #7". The confirmation named both crate
    // fields, never said 38-A, and PRE-ACKNOWLEDGED — so the gate, the one
    // component that reads the holdings, was waived and the rack pair was gone
    // at rest. `!creating` in the deferral condition was the whole cause.
    //
    // Creating a location does not teach this component the holdings, so the
    // mint branch defers as well: it asks only the question it can support
    // ("create it?"), sends NO acknowledgement, and the gate's refusal replaces
    // the content of the same confirmation with the rack sentence.
    // ═════════════════════════════════════════════════════════════════════════
    const user = userEvent.setup();
    mockPlaceStockAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message:
          'The Outsiders is recorded in Blue 4 on rack 38-A. Placing it here will change that to 7. Rack 38-A will be cleared.',
        details: {
          reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
          items: [
            {
              itemId: 'book-1',
              itemName: 'The Outsiders',
              currentLabel: 'Blue 4 on rack 38-A',
              nextLabel: '7',
              currentFingerprint: bookCrateFingerprint('blue', '4'),
              rackLine: 'Rack 38-A will be cleared.',
            },
          ],
        },
      },
    });
    renderBookDialog(); // rack 38-A recorded, and Crate #7 will be position-less
    await openDialog(user);
    await blankRack(user);
    await chooseCrateColor(user, 'No color');
    const number = screen.getByLabelText(/crate number/i);
    await user.clear(number);
    await user.type(number, '7');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    // STEP 1 — the one question only this dialog can ask. It claims nothing
    // about the crate or the rack, because it can support neither.
    expect(mockPlaceStockAction).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    const creation = screen.getByRole('alertdialog');
    expect(creation).toHaveTextContent('Create new crate Crate #7?');
    expect(creation).not.toHaveTextContent(/rack/i);
    expect(creation).not.toHaveTextContent(/will change from/i);

    // STEP 2 — the request goes out UNACKNOWLEDGED, so the gate gets to speak.
    await user.click(screen.getByRole('button', { name: /create and place/i }));
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(mockPlaceStockAction.mock.calls[0]![0].acknowledgedCrateChanges).toBeUndefined();
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      newRack: { warehouseId: 'wh-1', crateNumber: '7' },
    });

    // ONE dialog advancing, not two stacking — and it names 38-A.
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    const gate = screen.getByRole('alertdialog');
    expect(gate).toHaveTextContent('Rack 38-A will be cleared.');
    expect(gate).toHaveTextContent('1 title now in Blue 4 on rack 38-A');

    await user.click(screen.getByRole('button', { name: /continue placement/i }));
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(2);
    expect(mockPlaceStockAction.mock.calls[1]![0].acknowledgedCrateChanges).toEqual([
      { itemId: 'book-1', currentFingerprint: bookCrateFingerprint('blue', '4') },
    ]);
  });

  it('the rack sentence is printed ONCE, in the panel — not also in the lead paragraph', async () => {
    // The server carries it in BOTH the message (for surfaces that render
    // nothing else) and the change line (which this dialog renders in the amber
    // panel). Both are right; together they said it twice. The duplicate comes
    // out of the lead paragraph, never out of the panel.
    const user = userEvent.setup();
    mockPlaceStockAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message:
          'The Outsiders is recorded in Blue 4 on rack 38-A. Placing it here will change that to Blue 42. Rack 38-A will be cleared.',
        details: {
          reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
          items: [
            {
              itemId: 'book-1',
              itemName: 'The Outsiders',
              currentLabel: 'Blue 4 on rack 38-A',
              nextLabel: 'Blue 42',
              currentFingerprint: bookCrateFingerprint('blue', '4'),
              rackLine: 'Rack 38-A will be cleared.',
            },
          ],
        },
      },
    });
    renderBookDialog();
    await openDialog(user);
    await chooseExisting(user, 'Blue #42');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    const confirm = screen.getByRole('alertdialog');
    // COUNT THE SUBSTRING, not the elements. `getAllByText` matches a whole
    // element's text, so the copy buried at the end of the lead paragraph is
    // invisible to it — an assertion on it passes with or without the fix, which
    // is no assertion at all.
    const printed = (confirm.textContent ?? '').split('Rack 38-A will be cleared.').length - 1;
    expect(printed).toBe(1);
    // ...and the one that survived is the PANEL's, at full contrast, not the
    // muted description.
    expect(within(confirm).getAllByText('Rack 38-A will be cleared.')).toHaveLength(1);
    // The rest of the server's sentence is untouched — only the duplicate went.
    expect(confirm).toHaveTextContent(
      'The Outsiders is recorded in Blue 4 on rack 38-A. Placing it here will change that to Blue 42.',
    );
  });

  it('Continue placement sends the acknowledgement', async () => {
    const user = userEvent.setup();
    // NO recorded rack, so the local prediction still runs — this test is about
    // what the predicting path SENDS, and a book with a rack now defers to the
    // server instead (see "defers to the server" above).
    renderBookDialog({ bookStorage: IN_BLUE_4_NO_RACK });
    await openDialog(user);
    await chooseExisting(user, 'Blue #42');
    await user.click(screen.getByRole('button', { name: /place stock/i }));
    await user.click(screen.getByRole('button', { name: /continue placement/i }));

    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(mockPlaceStockAction.mock.calls[0]![0]).toMatchObject({
      destination: { existingLocationId: 'c-blue42' },
      // SCOPED to the crate the dialog just named — never a blanket "yes".
      acknowledgedCrateChanges: [
        { itemId: 'book-1', currentFingerprint: bookCrateFingerprint('blue', '4') },
      ],
    });
  });

  it('ONE dialog asks both questions when a new crate is created over a recorded one', async () => {
    const user = userEvent.setup();
    // NO recorded rack, so there is no rack outcome to defer and the local
    // prediction still fires — which is what this test is about: when the
    // dialog CAN state everything, the creation question and the crate question
    // are one dialog, not two. (A book that DOES record a rack now defers the
    // crate half to the gate; that is "MINTING a position-less crate defers
    // too" above.)
    renderBookDialog({ bookStorage: IN_BLUE_4_NO_RACK });
    await openDialog(user);
    await chooseCrateColor(user, 'Green');
    const number = screen.getByLabelText(/crate number/i);
    await user.clear(number);
    await user.type(number, '7');
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
      acknowledgedCrateChanges: [
        { itemId: 'book-1', currentFingerprint: bookCrateFingerprint('blue', '4') },
      ],
    });
  });

  it('a crate ON a rack is created as ONE positioned crate, named in full', async () => {
    // The owner's correction: rack 38-B + crate 13 is CRATE 13 LOCATED AT RACK
    // 38-B. Both halves reach the server, the confirmation names both, and the
    // created row's name is what migration 0270 dedupes on — which is what
    // keeps the five real "gray BIN" bins five rows.
    const user = userEvent.setup();
    renderBookDialog({ bookStorage: null });
    await openDialog(user);
    await user.type(screen.getByLabelText(/crate number/i), '13');
    await user.type(screen.getByLabelText(/rack number/i), '38');
    await user.type(screen.getByLabelText(/^row/i), 'B');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Create new crate Crate #13 on rack 38-B?',
    );
    await user.click(screen.getByRole('button', { name: /create and place/i }));
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      newRack: { warehouseId: 'wh-1', crateNumber: '13', rackNumber: '38', rackRow: 'B' },
    });
  });

  it('a positioned crate names the RACK CHANGE too — both comparisons, separately', async () => {
    // The book is recorded in Blue 4 on rack 38-A. Placing it into crate 13 on
    // rack 40-C moves BOTH facts, and the confirmation states each one in its
    // own sentence. The rack line used to be skipped entirely for any crate
    // destination (`!isCrateChoice(dest)`), so a crate that moved the rack said
    // nothing about it.
    const user = userEvent.setup();
    renderBookDialog();
    await openDialog(user);
    const number = screen.getByLabelText(/crate number/i);
    await user.clear(number);
    await user.type(number, '13');
    const rack = screen.getByLabelText(/rack number/i);
    await user.clear(rack);
    await user.type(rack, '40');
    const row = screen.getByLabelText(/^row/i);
    await user.clear(row);
    await user.type(row, 'C');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    const confirm = screen.getByRole('alertdialog');
    // The colour stays as seeded (Blue), so the crate is Blue #13.
    expect(confirm).toHaveTextContent('Create new crate Blue #13 on rack 40-C?');
    expect(confirm).toHaveTextContent('Crate number will change from 4 to 13.');
    expect(confirm).toHaveTextContent('Rack will change from 38-A to 40-C.');
  });

  it('a crate with NO position never promises to clear the rack', async () => {
    // THE REASON, CORRECTED. This used to read "the writer leaves the rack keys
    // alone for a position-less crate", which went stale with the holdings
    // derivation and migration 0336 — the writer DOES clear the pair on a full
    // move. The sentence is still withheld here, but for the reason that has
    // always actually applied: whether the move is full or split is decided from
    // the LIVE HOLDINGS, which this component cannot see. A promise that is
    // right half the time is the same class of lie as a silent overwrite.
    const user = userEvent.setup();
    renderBookDialog();
    await openDialog(user);
    await blankRack(user);
    const number = screen.getByLabelText(/crate number/i);
    await user.clear(number);
    await user.type(number, '13');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Create new crate Blue #13?');
    expect(confirm).not.toHaveTextContent(/rack/i);
  });

  it('a crate whose Row has no rack number cannot be submitted, and names nothing', async () => {
    // THE READINESS GATE IS THE PLANNER, OR IT DRIFTS FROM IT.
    //
    // The gate used to be a hand-rolled field check — `crateNumber` non-empty
    // on the crate branch — and this input walked straight through it: crate 13
    // plus a Row with no rack number. `planNewLocation` refuses that pair
    // (`rack_needs_number`: a row alone names no position), so the name derived
    // to '' and the confirmation rendered, verbatim:
    //
    //   "Create new crate ? does not exist in Main Warehouse yet. Continuing
    //    creates it and moves 10 units into it."
    //
    // A confirmation that NAMES NOTHING, in front of a server whose schema
    // refuses the same input — the 2026-07-23 rule (the string confirmed must be
    // the string created) failing in its emptiest possible form.
    const user = userEvent.setup();
    renderBookDialog(); // rack 38-A, row A seeded
    await openDialog(user);
    await user.clear(screen.getByLabelText(/rack number/i));
    const number = screen.getByLabelText(/crate number/i);
    await user.clear(number);
    await user.type(number, '13');

    // The planner's OWN words, inline — not a fourth hand-written string.
    expect(screen.getByText('Give the rack a number.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /place stock/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /place stock/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/create new crate/i)).not.toBeInTheDocument();
    expect(mockPlaceStockAction).not.toHaveBeenCalled();

    // Filling in the missing half clears the refusal and re-arms the button —
    // the message is a statement about the fields, not a dead end.
    await user.type(screen.getByLabelText(/rack number/i), '38');
    expect(screen.queryByText('Give the rack a number.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /place stock/i })).toBeEnabled();
  });

  it('a crate identified by its NUMBER ALONE is created as a crate, with no rack number', async () => {
    const user = userEvent.setup();
    renderBookDialog({ bookStorage: null });
    await openDialog(user);
    await user.type(screen.getByLabelText(/crate number/i), '9');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Create new crate Crate #9?');
    await user.click(screen.getByRole('button', { name: /create and place/i }));
    // No rack keys in the payload when none were typed — a crate on NO rack is
    // a legitimate permanent shape (production: blue "Blue Shelf", 5 books),
    // and the omission is what keeps the existing position-less row matched
    // and REUSED rather than duplicated.
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      newRack: { warehouseId: 'wh-1', crateNumber: '9' },
    });
  });

  it('a partial placement says what stays behind before it commits', async () => {
    const user = userEvent.setup();
    // No recorded rack: the subject here is the remainder notice, and it needs
    // the local dialog to render at all.
    renderBookDialog({ availableQuantity: 17, bookStorage: IN_BLUE_4_NO_RACK });
    await openDialog(user);
    await chooseExisting(user, 'Blue #42');
    const qty = screen.getByLabelText(/quantity/i);
    await user.clear(qty);
    await user.type(qty, '5');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      '12 of 17 will stay in staging, so this title will sit in more than one place.',
    );
  });

  it('a partial placement STILL says what stays behind when the crate question is deferred', async () => {
    // The remainder is a fact about the QUANTITY — independent of the crate, the
    // rack, and of which side answers. It was assembled only inside the
    // local-prediction branch, so the moment the deferral started returning
    // before that branch a 10-of-18 put-away showed the gate's crate panel and
    // never said the other 8 stay in staging. The gate's panel is the ONLY panel
    // on this path, so the sentence has to ride on it.
    const user = userEvent.setup();
    mockPlaceStockAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message:
          'The Outsiders is recorded in Blue 4 on rack 38-A. Placing it here will change that to Blue 42. Rack 38-A will be cleared.',
        details: {
          reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
          items: [
            {
              itemId: 'book-1',
              itemName: 'The Outsiders',
              currentLabel: 'Blue 4 on rack 38-A',
              nextLabel: 'Blue 42',
              currentFingerprint: bookCrateFingerprint('blue', '4'),
              rackLine: 'Rack 38-A will be cleared.',
            },
          ],
        },
      },
    });
    renderBookDialog({ availableQuantity: 18 }); // IN_BLUE_4 — rack 38-A recorded
    await openDialog(user);
    await chooseExisting(user, 'Blue #42');
    const qty = screen.getByLabelText(/quantity/i);
    await user.clear(qty);
    await user.type(qty, '10');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    const confirm = screen.getByRole('alertdialog');
    // Both truths, on the one panel the operator gets.
    expect(confirm).toHaveTextContent('Rack 38-A will be cleared.');
    expect(confirm).toHaveTextContent(
      '8 of 18 will stay in staging, so this title will sit in more than one place.',
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
              currentFingerprint: bookCrateFingerprint('blue', '4'),
            },
          ],
        },
      },
    });
    renderBookDialog({ bookStorage: null });
    await openDialog(user);
    await chooseExisting(user, 'Blue #42');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(mockPlaceStockAction.mock.calls[0]![0].acknowledgedCrateChanges).toBeUndefined();
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('1 title will be recorded in Blue 42');
    expect(confirm).toHaveTextContent('1 title now in Blue 4');

    await user.click(screen.getByRole('button', { name: /continue placement/i }));
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(2);
    // Built from the SERVER's payload, not from the client's own snapshot.
    expect(mockPlaceStockAction.mock.calls[1]![0].acknowledgedCrateChanges).toEqual([
      { itemId: 'book-1', currentFingerprint: bookCrateFingerprint('blue', '4') },
    ]);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // THE PREDICTING PATH — what the FIRST request actually carries.
  //
  // Every test above this block that exercised the retry set bookStorage:null
  // precisely so nothing was predicted, which left the predicting path — the
  // normal case for all 114 books carrying book_crate_* — untested for what it
  // sends. It sent a blanket `acknowledgeCrateChange: true` on its first and
  // only request, and the server skipped the comparison entirely.
  // ═════════════════════════════════════════════════════════════════════════

  it('the FIRST request from a PREDICTING dialog carries no blanket waiver', async () => {
    const user = userEvent.setup();
    // Blue 4 and NO rack, so the prediction DOES fire: with a rack recorded and
    // a position-less destination the dialog defers and sends nothing to waive.
    renderBookDialog({ bookStorage: IN_BLUE_4_NO_RACK });
    await openDialog(user);
    await chooseExisting(user, 'Blue #42');
    await user.click(screen.getByRole('button', { name: /place stock/i }));
    await user.click(screen.getByRole('button', { name: /continue placement/i }));

    const sent = mockPlaceStockAction.mock.calls[0]![0] as Record<string, unknown>;
    // No boolean off-switch of any spelling survives.
    expect(sent.acknowledgeCrateChange).toBeUndefined();
    expect(Object.values(sent).some((v) => v === true)).toBe(false);
    // What it does carry names the item AND the crate it displayed.
    expect(sent.acknowledgedCrateChanges).toEqual([
      { itemId: 'book-1', currentFingerprint: bookCrateFingerprint('blue', '4') },
    ]);
  });

  it('a rack-creation confirmation does NOT smuggle a crate acknowledgement', async () => {
    const user = userEvent.setup();
    // Nothing recorded, so the only question is "create rack 100-A?". Answering
    // it must not also answer a crate question the user was never asked.
    renderBookDialog({ bookStorage: null });
    await openDialog(user);
    await user.type(screen.getByLabelText(/rack number/i), '100-A');
    await user.click(screen.getByRole('button', { name: /place stock/i }));
    await user.click(screen.getByRole('button', { name: /create and place/i }));

    expect(mockPlaceStockAction.mock.calls[0]![0].acknowledgedCrateChanges).toBeUndefined();
  });

  it('a STALE snapshot is refused, re-confirmed against fresh truth, and Red 7 survives', async () => {
    const user = userEvent.setup();
    // Staging rendered "Blue 4". Since then the book was re-crated to Red 7
    // from the item screen, so the server refuses the pre-acknowledged request.
    mockPlaceStockAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message: 'The Outsiders is recorded in Red 7. Placing it here will change that to no crate.',
        details: {
          reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
          items: [
            {
              itemId: 'book-1',
              itemName: 'The Outsiders',
              currentLabel: 'Red 7',
              nextLabel: null,
              currentFingerprint: bookCrateFingerprint('red', '7'),
            },
          ],
        },
      },
    });
    renderBookDialog(); // snapshot says Blue 4
    await openDialog(user);
    await chooseExisting(user, '22-B');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    // The dialog first asks about the crate it can see.
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Crate number 4 will be cleared.');
    await user.click(screen.getByRole('button', { name: /continue placement/i }));

    // ...and that acknowledgement named Blue 4, which is not what the row says.
    expect(mockPlaceStockAction.mock.calls[0]![0].acknowledgedCrateChanges).toEqual([
      { itemId: 'book-1', currentFingerprint: bookCrateFingerprint('blue', '4') },
    ]);
    // Refused. RED 7 SURVIVES: the retry has not been sent yet, and the user is
    // being asked again — this time about Red 7.
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Red 7');
    expect(confirm).not.toHaveTextContent('Blue 4');

    // Only an explicit acknowledgement OF RED 7 lets it through.
    await user.click(screen.getByRole('button', { name: /continue placement/i }));
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(2);
    expect(mockPlaceStockAction.mock.calls[1]![0].acknowledgedCrateChanges).toEqual([
      { itemId: 'book-1', currentFingerprint: bookCrateFingerprint('red', '7') },
    ]);
  });

  it('a refusal that repeats what we ALREADY acknowledged is an error, not a loop', async () => {
    const user = userEvent.setup();
    const refusal = {
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
              currentFingerprint: bookCrateFingerprint('blue', '4'),
            },
          ],
        },
      },
    };
    mockPlaceStockAction.mockResolvedValue(refusal);
    // Predicting path: the acknowledgement it sends is the one the server then
    // repeats back, which is the loop this pins.
    renderBookDialog({ bookStorage: IN_BLUE_4_NO_RACK });
    await openDialog(user);
    await chooseExisting(user, 'Blue #42');
    await user.click(screen.getByRole('button', { name: /place stock/i }));
    await user.click(screen.getByRole('button', { name: /continue placement/i }));

    // The acknowledgement matched the payload exactly, so re-asking the same
    // question would spin forever. It surfaces the error instead.
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockToast.error).toHaveBeenCalledWith(refusal.error.message);
  });

  it('disables both confirmation buttons while the placement is in flight', async () => {
    const user = userEvent.setup();
    mockPlaceStockAction.mockReturnValue(new Promise(() => {}));
    renderBookDialog({ bookStorage: IN_BLUE_4_NO_RACK });
    await openDialog(user);
    await chooseExisting(user, 'Blue #42');
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
    renderBookDialog({ availableQuantity: 10, bookStorage: IN_BLUE_4_NO_RACK });
    await openDialog(user);
    await chooseExisting(user, 'Blue #42');
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
    await chooseExisting(user, 'Blue #4');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(mockToast.warning).toHaveBeenCalledWith(
      'The Outsiders now has stock in more than one location, so its crate label was left unchanged.',
    );
  });

  // ═══ THE SILENT SUCCESS — crateSyncStale ═══
  // The server refuses to overwrite a crate that was re-recorded WHILE the
  // stock was moving, and reports that as { ok: true, crateSyncStale: true }.
  // The stock landed; the summary still names the crate it left. This dialog
  // branched only on crateSyncFailed/crateSyncSkipped, so the operator got a
  // plain green "Placed 10 copies…" and nothing said the label was now wrong —
  // while the Transfer dialog and the mobile Move-stock modal both warned.
  it('warns when someone else changed the crate while the stock was moving', async () => {
    const user = userEvent.setup();
    mockPlaceStockAction.mockResolvedValue({
      ok: true,
      data: { toLocationId: 'c-blue4', crateSyncStale: true },
    });
    renderBookDialog();
    await openDialog(user);
    await chooseExisting(user, 'Blue #4');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    // The green toast still fires — the stock DID move. The warning is what
    // stops that green toast from being the whole story.
    expect(mockToast.success).toHaveBeenCalledWith(
      'Placed 10 copies of The Outsiders into Blue crate 4.',
    );
    expect(mockToast.warning).toHaveBeenCalledWith(
      'The Outsiders was placed, but someone else changed its crate while it was moving — its label was left as they set it.',
    );
  });

  // ═══ THE OTHER SILENT SUCCESS — crateSyncUnplaced ═══
  // The reconciliation writes only when a book's stock resolves to ONE
  // rack/crate. When it resolves to NONE — every unit still in a staging bucket
  // after a partial move, or the stock picked away underneath it — there is
  // nothing authoritative to write, and the service used to `continue` with no
  // bucket at all: no flag, plain green toast, item still naming a crate that
  // holds none of it.
  it('warns when nothing is left in a rack or crate for the label to follow', async () => {
    const user = userEvent.setup();
    mockPlaceStockAction.mockResolvedValue({
      ok: true,
      data: { toLocationId: 'c-blue4', crateSyncUnplaced: true },
    });
    renderBookDialog();
    await openDialog(user);
    await chooseExisting(user, 'Blue #4');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    // Green first — the stock really did move — then the caveat.
    expect(mockToast.success).toHaveBeenCalledWith(
      'Placed 10 copies of The Outsiders into Blue crate 4.',
    );
    expect(mockToast.warning).toHaveBeenCalledWith(
      'The Outsiders was placed, but none of its stock is in a rack or crate now — its crate label was left unchanged and may be wrong.',
    );
  });

  it('warns when the crate summary could not be written at all', async () => {
    const user = userEvent.setup();
    mockPlaceStockAction.mockResolvedValue({
      ok: true,
      data: { toLocationId: 'c-blue4', crateSyncFailed: true },
    });
    renderBookDialog();
    await openDialog(user);
    await chooseExisting(user, 'Blue #4');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(mockToast.warning).toHaveBeenCalledWith(
      'The Outsiders was placed, but its crate label could not be updated — check the book’s details.',
    );
  });

  // ═══ THE KEPT CRATE — crateSyncCratePreserved (Maus I) ═══
  it('warns when the crate label was KEPT because nobody was asked about clearing it', async () => {
    const user = userEvent.setup();
    mockPlaceStockAction.mockResolvedValue({
      ok: true,
      data: { toLocationId: 'r-38b', crateSyncCratePreserved: true },
    });
    renderBookDialog({ bookStorage: IN_RED_4_ON_38B, destinations: L4L_DESTINATIONS });
    await openDialog(user);
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(mockToast.warning).toHaveBeenCalledWith(
      'The Outsiders was placed, but its crate label was left as it was and may now be wrong — nobody was asked about clearing it.',
    );
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { mockTransferStockAction, mockToast } = vi.hoisted(() => ({
  mockTransferStockAction: vi.fn(),
  // Mocked so the crate/rack SUCCESS warnings can be asserted. Without this the
  // real sonner swallows them and a dialog that says nothing looks identical to
  // one that says the right thing — which is exactly how crateSyncRackPreserved
  // went unrendered here.
  mockToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/server/actions/inventory', () => ({
  transferStockAction: mockTransferStockAction,
}));
vi.mock('sonner', () => ({ toast: mockToast }));

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
      canMintDestination
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
// The BOOK destination — the four fields, always visible, seeded from the record.
//
// This form used to render "Rack number *" plus an optional free-text crate
// pair with no toggle, and always send the rack number ALONGSIDE the crate
// fields; then a Rack|Crate toggle behind "+ New location…". Both hid the crate
// from the operator moving a crated book — for a label-only crate (most of the
// L4L warehouse) the crate the book records was never in the dropdown, so the
// reachable destination was a bare rack, which clears the crate (Maus I,
// 2026-08-17). Now the four fields ARE the destination: rack number, row,
// crate colour, crate number — seeded from the recorded storage, filled by the
// dropdown, and the planner decides kind by what is filled in. A crate SITS ON
// a rack, so both facts are on screen at once and "Crate #9 on rack A1-Row 3"
// is one row named for both (REPRO B stays fixed).
// ---------------------------------------------------------------------------

const BOOK_LOCS = [
  { id: 'loc-a', name: 'Receiving Dock', kind: null, warehouse_id: 'wh-1' },
  { id: 'loc-b', name: '22-B', kind: 'rack', warehouse_id: 'wh-1', rackNumber: '22', rackRow: 'B' },
];

/** Blue 4, no rack recorded — the fixture every test in the next block seeds from. */
const BLUE_4_NO_RACK = {
  rackNumber: null,
  rackRow: null,
  crateColor: 'blue',
  crateNumber: '4',
  grade: null,
  rackLabel: null,
  crateLabel: 'Blue 4',
};

function renderBookDialog(
  opts: {
    bookStorage?: Record<string, unknown> | null;
    locations?: unknown[];
    holdings?: unknown[];
    canMintDestination?: boolean;
  } = {},
) {
  return render(
    <StockTransferDialog
      itemId="item-1"
      itemName="Persepolis"
      currentQuantity={40}
      currentLocationId={null}
      locations={(opts.locations ?? BOOK_LOCS) as never}
      holdings={
        (opts.holdings ?? [
          {
            locationId: 'loc-a',
            name: 'Receiving Dock',
            quantity: 40,
            kind: null,
            warehouseId: 'wh-1',
          },
        ]) as never
      }
      itemType="book"
      bookStorage={(opts.bookStorage === undefined ? BLUE_4_NO_RACK : opts.bookStorage) as never}
      canMintDestination={opts.canMintDestination ?? true}
    />,
  );
}

async function openBook(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /transfer/i }));
}

async function chooseCrateColor(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('combobox', { name: /^crate color$/i }));
  await user.click(await screen.findByRole('option', { name }));
}

async function retype(user: ReturnType<typeof userEvent.setup>, label: RegExp, value: string) {
  const box = screen.getByLabelText(label);
  await user.clear(box);
  if (value) await user.type(box, value);
}

describe('StockTransferDialog — the book destination fields', () => {
  it('a BOOK sees the four fields PRE-FILLED from its recorded storage — no toggle, no "+ New"', async () => {
    const user = userEvent.setup();
    renderBookDialog();
    await openBook(user);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/crate number/i)).toHaveValue('4');
    expect(screen.getByRole('combobox', { name: /^crate color$/i })).toHaveTextContent('Blue');
    expect(screen.getByLabelText(/rack number/i)).toHaveValue('');
    // The dropdown is a shortcut that fills the fields; no "+ New location…"
    // entry for a book — the fields ARE the destination.
    await user.click(screen.getAllByRole('combobox')[1]!);
    expect(await screen.findByRole('option', { name: '22-B' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /new location/i })).not.toBeInTheDocument();
  });

  it('a crate ON a rack sends BOTH, and the confirmation names both', async () => {
    mockTransferStockAction.mockResolvedValueOnce({ ok: true, data: { toLocationId: 'new' } });
    const user = userEvent.setup();
    renderBookDialog();
    await openBook(user);

    await retype(user, /crate number/i, '13');
    await user.type(screen.getByLabelText(/rack number/i), '38');
    await user.type(screen.getByLabelText(/^row/i), 'B');

    await user.click(screen.getByRole('button', { name: /transfer stock/i }));
    // The colour stays as seeded (Blue): Blue 13 on rack 38-B.
    expect(await screen.findByText('Create new crate Blue #13 on rack 38-B?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create and transfer/i }));

    const arg = mockTransferStockAction.mock.calls[0]![0] as {
      destination: { newRack: Record<string, unknown> };
    };
    expect(arg.destination.newRack).toEqual({
      warehouseId: 'wh-1',
      crateNumber: '13',
      crateColor: 'blue',
      rackNumber: '38',
      rackRow: 'B',
    });
  });

  it('a crate whose Row has no rack number cannot be submitted, and names nothing', async () => {
    // THE READINESS GATE IS THE PLANNER, OR IT DRIFTS FROM IT. This dialog's
    // gate checked `crateNumber` alone, so crate 13 + a Row with no rack
    // number passed it; `planNewLocation` refuses that pair
    // (`rack_needs_number`), the derived name was '', and the confirmation read
    // "Create new crate ? does not exist yet." — the string confirmed naming
    // nothing at all, ahead of a server schema that refuses the same input.
    const user = userEvent.setup();
    renderBookDialog();
    await openBook(user);

    await retype(user, /crate number/i, '13');
    await user.type(screen.getByLabelText(/^row/i), 'B');

    expect(screen.getByText('Give the rack a number.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /transfer stock/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /transfer stock/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/create new crate/i)).not.toBeInTheDocument();
    expect(mockTransferStockAction).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/rack number/i), '38');
    expect(screen.queryByText('Give the rack a number.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /transfer stock/i })).toBeEnabled();
  });

  it('a NUMBER-ONLY crate is reachable, and sends NO rack number', async () => {
    mockTransferStockAction.mockResolvedValueOnce({ ok: true, data: { toLocationId: 'new' } });
    const user = userEvent.setup();
    renderBookDialog();
    await openBook(user);

    await chooseCrateColor(user, 'No color');
    await retype(user, /crate number/i, '9');

    await user.click(screen.getByRole('button', { name: /transfer stock/i }));
    // "Crate #9" does not exist in this warehouse, so it is a creation and the
    // confirmation names EXACTLY what will be made. Rack boxes left blank make
    // it position-less, and the payload proves nothing is invented for it.
    expect(await screen.findByText('Create new crate Crate #9?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create and transfer/i }));

    expect(mockTransferStockAction).toHaveBeenCalledOnce();
    const arg = mockTransferStockAction.mock.calls[0]![0] as {
      destination: { newRack: Record<string, unknown> };
    };
    expect(arg.destination.newRack).toEqual({ warehouseId: 'wh-1', crateNumber: '9' });
  });

  it('a bare RACK (crate blanked) sends no crate fields, row and all', async () => {
    mockTransferStockAction.mockResolvedValueOnce({ ok: true, data: { toLocationId: 'new' } });
    const user = userEvent.setup();
    renderBookDialog();
    await openBook(user);

    await chooseCrateColor(user, 'No color');
    await retype(user, /crate number/i, '');
    await user.type(screen.getByLabelText(/rack number/i), 'A1');
    await user.type(screen.getByLabelText(/^row/i), 'Row 3');

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
    await openBook(user);
    // A Select trigger, not an <input>: typing "navy" used to mint a colour no
    // swatch, filter or label sheet can render.
    expect(screen.getByRole('combobox', { name: /crate color/i })).toBeInTheDocument();
  });

  // ═══ MAUS I — the repair is the default: loose stock on the rack INTO the crate ═══
  it('for stock sitting LOOSE on the recorded rack, the default moves it INTO the recorded crate on that rack', async () => {
    mockTransferStockAction.mockResolvedValueOnce({ ok: true, data: { toLocationId: 'new' } });
    const user = userEvent.setup();
    // Maus after the incident: label yellow 6 on 38-B, 79 units loose on the
    // plain rack "38-B", no crate row.
    renderBookDialog({
      bookStorage: { rackNumber: '38', rackRow: 'B', crateColor: 'yellow', crateNumber: '6', grade: null, rackLabel: '38-B', crateLabel: 'Yellow 6' },
      locations: [
        { id: 'loc-38b', name: '38-B', kind: 'rack', warehouse_id: 'wh-1', rackNumber: '38', rackRow: 'B' },
        { id: 'loc-b', name: '22-B', kind: 'rack', warehouse_id: 'wh-1', rackNumber: '22', rackRow: 'B' },
      ],
      holdings: [{ locationId: 'loc-38b', name: '38-B', quantity: 79, kind: 'rack', warehouseId: 'wh-1' }],
    });
    await openBook(user);
    // Pre-filled with the record.
    expect(screen.getByLabelText(/rack number/i)).toHaveValue('38');
    expect(screen.getByLabelText(/^row/i)).toHaveValue('B');
    expect(screen.getByLabelText(/crate number/i)).toHaveValue('6');
    expect(screen.getByRole('button', { name: /transfer stock/i })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /transfer stock/i }));
    // No typo guard (it is the recorded truth) — straight through, unacknowledged.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockTransferStockAction).toHaveBeenCalledOnce();
    expect(mockTransferStockAction.mock.calls[0]![0]).toMatchObject({
      fromLocationId: 'loc-38b',
      destination: {
        newRack: { warehouseId: 'wh-1', crateNumber: '6', crateColor: 'yellow', rackNumber: '38', rackRow: 'B' },
      },
      acknowledgedRackChanges: [],
    });
    expect(mockTransferStockAction.mock.calls[0]![0]).not.toHaveProperty('acknowledgedCrateChanges');
  });

  it('moving OUT of the recorded crate opens with the source as destination — and says so', async () => {
    const user = userEvent.setup();
    renderBookDialog({
      bookStorage: { rackNumber: '38', rackRow: 'B', crateColor: 'yellow', crateNumber: '6', grade: null, rackLabel: '38-B', crateLabel: 'Yellow 6' },
      locations: [
        { id: 'loc-y6', name: 'Yellow #6 on rack 38-B', kind: 'crate', warehouse_id: 'wh-1', rackNumber: '38', rackRow: 'B', crateColor: 'yellow', crateNumber: '6' },
        { id: 'loc-b', name: '22-B', kind: 'rack', warehouse_id: 'wh-1', rackNumber: '22', rackRow: 'B' },
      ],
      holdings: [{ locationId: 'loc-y6', name: 'Yellow #6 on rack 38-B', quantity: 20, kind: 'crate', warehouseId: 'wh-1' }],
    });
    await openBook(user);
    expect(screen.getByText(/that is where this stock already is/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /transfer stock/i })).toBeDisabled();
    // Picking 22-B fills the fields (rack 22-B, crate blank) and re-arms it.
    await user.click(screen.getAllByRole('combobox')[1]!);
    await user.click(await screen.findByRole('option', { name: '22-B' }));
    expect(screen.getByLabelText(/rack number/i)).toHaveValue('22');
    expect(screen.getByLabelText(/crate number/i)).toHaveValue('');
    expect(screen.queryByText(/that is where this stock already is/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /transfer stock/i })).toBeEnabled();
  });

  it('without the placement gate (stock:transfer / locations:manage), a destination that would have to be CREATED is said inline, not refused on submit', async () => {
    const user = userEvent.setup();
    renderBookDialog({ canMintDestination: false });
    await openBook(user);
    // Blue 4 (position-less) has no row in this warehouse.
    expect(screen.getByText(/needs the Transfer stock permission/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /transfer stock/i })).toBeDisabled();
    // An existing row is still fine.
    await user.click(screen.getAllByRole('combobox')[1]!);
    await user.click(await screen.findByRole('option', { name: '22-B' }));
    expect(screen.queryByText(/needs the Transfer stock permission/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /transfer stock/i })).toBeEnabled();
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

  // ═══ THE RACK HALF — its own question, its own acknowledgement ═══
  //
  // THE ORPHAN THIS CLOSES: `transferStockAction` has emitted
  // `crateSyncRackPreserved` since the rack channel shipped, and this dialog was
  // the one client of that action which neither sent `acknowledgedRackChanges`
  // nor rendered the flag. So every rack-clearing transfer here took the
  // fail-safe path — rack kept, nobody asked — and reported a bare success. No
  // data was lost; the operator was simply never told the label had gone stale,
  // which is the failure class this whole feature exists to eliminate.

  const RACK_REFUSAL = {
    ok: false,
    error: {
      code: 'conflict',
      message: 'Persepolis records rack 38-A. Rack 38-A will be cleared.',
      details: {
        reason: 'BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION',
        rackItems: [
          {
            itemId: 'item-1',
            itemName: 'Persepolis',
            currentLabel: '38-A',
            line: 'Rack 38-A will be cleared.',
            currentFingerprint: '["38","a"]',
          },
        ],
      },
    },
  };

  it('declares it can answer a rack question on the FIRST request, even with nothing to say', async () => {
    // `[]` and absent are DIFFERENT MESSAGES: the action reads an absent key as
    // "this caller cannot answer" and then preserves the rack instead of asking.
    // Spread conditionally the way the crate list is, this dialog would opt
    // itself out of the question on the one request that decides the erasure.
    mockTransferStockAction.mockResolvedValueOnce({ ok: true, data: { toLocationId: 'loc-b' } });
    const user = userEvent.setup();
    renderBookDialog();
    await submitToExistingRack(user);

    const body = mockTransferStockAction.mock.calls[0]![0];
    expect(Object.hasOwn(body, 'acknowledgedRackChanges')).toBe(true);
    expect(body.acknowledgedRackChanges).toEqual([]);
    // …and the crate list keeps the opposite rule: an empty answer is no answer.
    expect(body).not.toHaveProperty('acknowledgedCrateChanges');
  });

  it('asks about the RACK without claiming the crate is changing', async () => {
    // The reported defect: crate "Blue Shelf" into ('blue','Shelf') is the SAME
    // crate, so the crate gate is silent and only the rack question is live.
    // "Change this book's crate?" would name a change that is not happening.
    mockTransferStockAction
      .mockResolvedValueOnce(RACK_REFUSAL)
      .mockResolvedValueOnce({ ok: true, data: { toLocationId: 'loc-b' } });
    const user = userEvent.setup();
    renderBookDialog();
    await submitToExistingRack(user);

    expect(await screen.findByText('Clear this book’s rack?')).toBeInTheDocument();
    expect(screen.queryByText('Change this book’s crate?')).not.toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Rack 38-A will be cleared.');

    await user.click(screen.getByRole('button', { name: /continue transfer/i }));

    expect(mockTransferStockAction).toHaveBeenCalledTimes(2);
    // The retry acknowledges EXACTLY the erasure that was displayed, over the
    // RACK pair — never the crate fingerprint, and never a blanket yes.
    expect(mockTransferStockAction.mock.calls[1]![0]).toMatchObject({
      acknowledgedRackChanges: [{ itemId: 'item-1', currentFingerprint: '["38","a"]' }],
    });
  });

  it('says so when the rack label was PRESERVED rather than erased', async () => {
    // The flag with no client. The stock moved and the crate label followed it;
    // the rack label was kept because nobody was shown the erasure, so it may
    // now name a rack this stock has left. Keeping it is only the safe choice
    // because it is recoverable — and it is recoverable only if this fires.
    mockTransferStockAction.mockResolvedValueOnce({
      ok: true,
      data: { toLocationId: 'loc-b', crateSyncRackPreserved: true },
    });
    const user = userEvent.setup();
    renderBookDialog();
    await submitToExistingRack(user);

    expect(mockToast.warning).toHaveBeenCalledWith(
      'Persepolis was moved, but its rack label was left as it was and may now be wrong — nobody was asked about clearing it.',
    );
  });

  it('a CREATION confirmation never answers a crate question nobody asked', async () => {
    mockTransferStockAction.mockResolvedValueOnce({ ok: true, data: { toLocationId: 'new' } });
    const user = userEvent.setup();
    renderBookDialog();
    await openBook(user);
    // Blue 4 seeded; the operator adds a brand-new rack position: Blue 4 on
    // A1. Same crate (no crate question), a new row (creation question).
    await user.type(screen.getByLabelText(/rack number/i), 'A1');
    await user.click(screen.getByRole('button', { name: /transfer stock/i }));
    await user.click(await screen.findByRole('button', { name: /create and transfer/i }));

    expect(mockTransferStockAction.mock.calls[0]![0]).not.toHaveProperty(
      'acknowledgedCrateChanges',
    );
  });
});

// ---------------------------------------------------------------------------
// THE DESTINATION LIST NEVER OFFERS A SYSTEM BUCKET
//
// transferStockAction now refuses a staging/unplaced destination server-side,
// matching its three siblings. That refusal is only safe because no shipped
// surface offers one: this dialog filters them out of the destination select
// (the phone's Move stock sheet queries `.in('kind', ['rack','crate'])`), and
// stock that is IN staging is placed through the staging workflow instead —
// which this dialog says in as many words when every source is a bucket.
//
// Pinned here so a future "show every location" tidy-up cannot quietly hand
// operators a destination the server will reject.
// ---------------------------------------------------------------------------
describe('StockTransferDialog — Staging is not a destination, Unplaced is', () => {
  // ═══ THE TEST THAT PASSED FOR THE WRONG REASON ═══
  //
  // This block used to assert that BOTH buckets were absent, with
  // `/^unplaced$/i`. When Unplaced became a real destination its option label
  // grew an explanation, and the anchored regex stopped matching — so the
  // assertion went on "passing" while asserting nothing about the behaviour it
  // was named for. Every check below now pins the option by its ROLE and its
  // full accessible name, so a relabel fails loudly instead of silently
  // vacating the test.
  //
  // The rule these pin: Staging is the RECEIVING inbox and stays out; Unplaced
  // is "on hand, on no rack" and is the non-destructive way off a rack — the
  // affordance whose absence cost 220 books on 2026-07-23 (rack 100-A).
  const WITH_BUCKETS = [
    { id: 'loc-a', name: 'Receiving Dock', kind: null, warehouse_id: 'wh-1' },
    { id: 'loc-b', name: 'Aisle A', kind: null, warehouse_id: 'wh-1' },
    { id: 'loc-stg', name: 'Staging', kind: 'staging', warehouse_id: 'wh-1' },
    { id: 'loc-unp', name: 'Unplaced', kind: 'unplaced', warehouse_id: 'wh-1' },
  ];

  function renderWithBuckets(itemType: string) {
    return render(
      <StockTransferDialog
        itemId="item-1"
        itemName={itemType === 'book' ? 'Persepolis' : 'Countertop Blender'}
        currentQuantity={40}
        currentLocationId={null}
        locations={WITH_BUCKETS as never}
        holdings={
          [
            {
              locationId: 'loc-a',
              locationName: 'Receiving Dock',
              quantity: 40,
              kind: null,
              warehouseId: 'wh-1',
            },
          ] as never
        }
        itemType={itemType}
        canMintDestination
      />,
    );
  }

  async function openDestinations(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: /transfer/i }));
    await user.click(screen.getAllByRole('combobox')[1]!);
  }

  it('omits Staging, and offers Unplaced with what it does spelled out', async () => {
    const user = userEvent.setup();
    renderWithBuckets('asset');
    await openDestinations(user);

    // A real destination is offered...
    expect(await screen.findByRole('option', { name: /aisle a/i })).toBeInTheDocument();
    // ...Staging is not, in any spelling.
    expect(screen.queryByRole('option', { name: /staging/i })).not.toBeInTheDocument();
    // ...and Unplaced IS, saying in the option itself that the stock survives.
    // Pinned to the full string: "Unplaced" alone would pass on a bare relabel
    // and the reassurance is the entire reason this option exists.
    expect(
      screen.getByRole('option', { name: 'Unplaced — off the rack, stock kept' }),
    ).toBeInTheDocument();
  });

  it('lists Unplaced FIRST — the safe way off a rack is not buried under 48 racks', async () => {
    const user = userEvent.setup();
    renderWithBuckets('asset');
    await openDestinations(user);

    await screen.findByRole('option', { name: /aisle a/i });
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names[0]).toBe('Unplaced — off the rack, stock kept');
  });

  it('a BOOK can pick Unplaced — the four-fields destination model must not swallow it', async () => {
    // The risky path. For a book the destination is derived from the rack/crate
    // fields, not the dropdown, so an option that carries NO rack and NO crate
    // could easily resolve to "nothing chosen" and leave Transfer inert. It
    // must resolve to the picked row itself.
    mockTransferStockAction.mockResolvedValueOnce({ ok: true, data: {} });
    const user = userEvent.setup();
    renderWithBuckets('book');
    await openDestinations(user);
    await user.click(
      await screen.findByRole('option', { name: 'Unplaced — off the rack, stock kept' }),
    );
    await user.click(screen.getByRole('button', { name: /transfer stock/i }));

    expect(mockTransferStockAction).toHaveBeenCalledWith(
      expect.objectContaining({ destination: { existingLocationId: 'loc-unp' } }),
    );
  });

  it('un-placing a book surfaces the stale-label warning rather than a silent success', async () => {
    // The honest-reporting half that made allowing this destination safe: the
    // reconciliation has no placed holding left to follow, so the crate label
    // may now name a crate holding none of it. The operator must hear that.
    mockTransferStockAction.mockResolvedValueOnce({
      ok: true,
      data: { crateSyncUnplaced: true },
    });
    const user = userEvent.setup();
    renderWithBuckets('book');
    await openDestinations(user);
    await user.click(
      await screen.findByRole('option', { name: 'Unplaced — off the rack, stock kept' }),
    );
    await user.click(screen.getByRole('button', { name: /transfer stock/i }));

    // Pinned verbatim, not by substring: this sentence IS the safeguard that
    // replaced the blanket refusal, so a reword must come back through here.
    expect(mockToast.warning).toHaveBeenCalledWith(
      'Persepolis was moved, but none of its stock is in a rack or crate now — its crate label was left unchanged and may be wrong.',
    );
  });
});

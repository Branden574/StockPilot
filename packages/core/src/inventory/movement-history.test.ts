import { describe, expect, it } from 'vitest';

import {
  formatHistoryMovement,
  historyNote,
  movementTitle,
  type ItemHistoryMovement,
} from './movement-history';

// ---------------------------------------------------------------------------
// The shared formatter is the ONLY place web and mobile get their words from.
// Every test below pins one of the truthfulness rules that the two reverted
// "infer a source" attempts broke.
// ---------------------------------------------------------------------------

function row(overrides: Partial<ItemHistoryMovement> = {}): ItemHistoryMovement {
  return {
    id: 'm-1',
    at: '2026-07-22T21:16:28.910Z',
    movementType: 'add',
    quantityChange: 10,
    movedQuantity: null,
    previousQuantity: 134,
    newQuantity: 144,
    actorName: 'Peter Pete',
    actorEmail: 'pmathis@cvsouth.org',
    fromLocationName: null,
    toLocationName: null,
    note: null,
    receiptNumber: null,
    receiptStatus: null,
    poNumber: null,
    poStatus: null,
    reversalReason: null,
    reversal: null,
    ...overrides,
  };
}

describe('historyNote — rule 2: never render an internal token as a human note', () => {
  it('drops the machine-written reasons the receipt writers use', () => {
    expect(historyNote('receipt_line', 'b26190be-b6fc-4475-b1c5-fed997bf5814')).toBeNull();
    expect(historyNote('receipt_reversal', '5da7b8e2-7a17-4942-913a-93ba0aac1837')).toBeNull();
    expect(historyNote('duplicate_initial_count', null)).toBeNull();
  });

  // D1. The set used to hold only the three receipt tokens above, so every
  // OTHER machine-written reason reached the screen in curly quotes as though
  // an operator had typed it. `order_delivered` is written by
  // deliver_order_request (migs 0044/0045/0055/0057) and there are five of them
  // in the owner's org right now.
  it('drops every machine-written reason literal the writers in this repo set', () => {
    for (const token of [
      'order_delivered',
      'bundle_assembly',
      'bundle_distribution',
      'no_stock',
      'item_archived',
      'item_deleted',
    ]) {
      expect(historyNote(token, null)).toBeNull();
    }
  });

  it('drops a machine token regardless of surrounding whitespace or case', () => {
    expect(historyNote('  order_delivered  ', null)).toBeNull();
    expect(historyNote('ORDER_DELIVERED', null)).toBeNull();
    // …and from the notes column too, not just reason.
    expect(historyNote(null, 'order_delivered')).toBeNull();
  });

  it('drops an unknown lower_snake_case token — the shape rule, so the next writer is covered', () => {
    expect(historyNote('some_future_rpc_reason', null)).toBeNull();
    // Prose that merely CONTAINS an underscore is not a token and survives.
    expect(historyNote('moved to rack 37_B by hand', null)).toBe('moved to rack 37_B by hand');
  });

  it("drops a bare 'PO {number}' reason — the PO is carried structurally", () => {
    expect(historyNote('PO CVW-002201', '0bbed45a-857b-468c-ada4-353f31aff1a8')).toBeNull();
    expect(historyNote('PO PO-1784742395548', null)).toBeNull();
  });

  it('never returns a raw UUID, from reason or from notes', () => {
    expect(historyNote('5f3538ee-3fe8-4fe6-aecb-b88cde7e1c3a', null)).toBeNull();
    expect(historyNote(null, '5f3538ee-3fe8-4fe6-aecb-b88cde7e1c3a')).toBeNull();
  });

  it("keeps the operator's typed words, trimmed", () => {
    expect(historyNote('incorrectly moved inventory ', null)).toBe('incorrectly moved inventory');
    expect(historyNote('added incorrectly ', null)).toBe('added incorrectly');
    expect(historyNote('Adding new stock into inventory. ', null)).toBe(
      'Adding new stock into inventory.',
    );
  });

  it('strips the internal reference parenthetical but keeps the prose in front of it', () => {
    expect(historyNote('Order pick (order_request 51516354-4efe-40e5-89bd-95164cbef2f7)', null)).toBe(
      'Order pick',
    );
    expect(historyNote('Order cancelled (order_request 1d265b37-4b5c-49bb-bc12-07b0ad270cff)', null)).toBe(
      'Order cancelled',
    );
    expect(historyNote('Return restock (return ecbd03b4-2fbe-4e0a-8507-021a9bd3feed)', null)).toBe(
      'Return restock',
    );
  });

  // The item-history dialog and the Movements page used to describe the SAME
  // event differently: this formatter stripped the reference to a bare "Order
  // pick" while the Movements page printed the raw uuid. Given the page's
  // batched order-number map both now say the same words.
  it('renders the human order number when the caller resolved one', () => {
    const labels = new Map([['51516354-4efe-40e5-89bd-95164cbef2f7', 'SO-000060']]);
    expect(
      historyNote('Order pick (order_request 51516354-4efe-40e5-89bd-95164cbef2f7)', null, labels),
    ).toBe('Order pick (SO-000060)');
    expect(
      historyNote(
        'Order cancelled (order_request 51516354-4efe-40e5-89bd-95164cbef2f7)',
        null,
        labels,
      ),
    ).toBe('Order cancelled (SO-000060)');
  });

  // The resolved parenthetical is not a 36-char hex id, so TRAILING_REF_RE
  // must leave it alone — otherwise the number would be stripped right back
  // off and the fix would be invisible.
  it('does not strip an already-resolved order number off a 0306-era row', () => {
    expect(historyNote('Order pick (SO-000060)', null)).toBe('Order pick (SO-000060)');
  });

  it('falls back to today’s stripped text when nothing resolves', () => {
    expect(
      historyNote('Order pick (order_request 51516354-4efe-40e5-89bd-95164cbef2f7)', null, new Map()),
    ).toBe('Order pick');
  });

  // M1. historyNote used to be `cleanProse(reason) ?? cleanProse(notes)`, so an
  // operator who typed BOTH lost the note silently. The owner asked for "when
  // where notes why everything".
  it('shows BOTH the typed reason and the typed note when both exist', () => {
    expect(historyNote('incorrectly moved inventory', 'box was crushed on the pallet')).toBe(
      'incorrectly moved inventory (note: box was crushed on the pallet)',
    );
  });

  it('does not repeat itself when reason and note say the same thing', () => {
    expect(historyNote('Wrong count', 'wrong count')).toBe('Wrong count');
  });

  it('still shows the reason alone when the note is only a machine id', () => {
    // post_receipt_v2 stores receipts.id in notes; that must not become "(note:
    // <uuid>)" appended to real prose.
    expect(historyNote('Found extra', 'b26190be-b6fc-4475-b1c5-fed997bf5814')).toBe('Found extra');
  });

  it('falls back to notes only when they are human prose', () => {
    expect(
      historyNote(
        null,
        'Staging cleanup: stock mis-routed to Staging by the adjust bug, moved back to rack/Unplaced',
      ),
    ).toBe('Staging cleanup: stock mis-routed to Staging by the adjust bug, moved back to rack/Unplaced');
  });

  it('returns null when there is nothing to say', () => {
    expect(historyNote(null, null)).toBeNull();
    expect(historyNote('   ', '')).toBeNull();
  });
});

describe('movementTitle — rule 1: say what the record IS, never guess intent', () => {
  it('names each movement kind by its type, not by the sign of the delta', () => {
    expect(movementTitle('initial')).toBe('Opening count');
    expect(movementTitle('add')).toBe('Stock added');
    expect(movementTitle('remove')).toBe('Stock removed');
    expect(movementTitle('adjust')).toBe('Stock adjusted');
    expect(movementTitle('correction')).toBe('Correction');
    expect(movementTitle('transfer')).toBe('Stock transferred');
    expect(movementTitle('receive_po')).toBe('Stock received');
    expect(movementTitle('cycle_count')).toBe('Cycle count posted');
  });

  it("does NOT claim a customer returned anything for movement_type='return'", () => {
    // cancel_order_request writes movement_type='return' for an internally
    // cancelled pick. The second reverted attempt labelled these
    // "Customer return processed by X". This is the regression test.
    const title = movementTitle('return');
    expect(title).toBe('Returned to stock');
    expect(title.toLowerCase()).not.toContain('customer');
  });

  it('title-cases an unknown type rather than inventing a meaning', () => {
    expect(movementTitle('some_new_kind')).toBe('Some new kind');
  });
});

describe('formatHistoryMovement — quantities', () => {
  it('renders a signed delta for stock-changing movements', () => {
    expect(formatHistoryMovement(row({ quantityChange: 10 })).deltaLabel).toBe('+10');
    expect(formatHistoryMovement(row({ quantityChange: -10 })).deltaLabel).toBe('-10');
  });

  it('renders the physical qty (not the net-zero delta) for a transfer', () => {
    const f = formatHistoryMovement(
      row({ movementType: 'transfer', quantityChange: 0, movedQuantity: 10 }),
    );
    expect(f.deltaLabel).toBeNull();
    expect(f.movedLabel).toBe('10 moved');
  });

  it('shows no number at all for a pre-0231 transfer with no moved_quantity', () => {
    const f = formatHistoryMovement(
      row({ movementType: 'transfer', quantityChange: 0, movedQuantity: null }),
    );
    expect(f.deltaLabel).toBeNull();
    expect(f.movedLabel).toBeNull();
  });

  it("still shows the delta on an order pick, which is recorded as a 'transfer'", () => {
    // The fulfilment writer records an order pick as movement_type='transfer'
    // with a REAL negative delta and no moved_quantity (owner's 2026-07-06
    // pick of -5). Keying the number off the type would hide five units
    // leaving the building.
    const f = formatHistoryMovement(
      row({
        movementType: 'transfer',
        quantityChange: -5,
        movedQuantity: null,
        previousQuantity: 139,
        newQuantity: 134,
        note: 'Order pick',
      }),
    );
    expect(f.deltaLabel).toBe('-5');
    expect(f.movedLabel).toBeNull();
    expect(f.onHandLabel).toBe('139 -> 134 on hand');
  });

  it('always states the before/after on hand', () => {
    expect(formatHistoryMovement(row({ previousQuantity: 1340, newQuantity: 1440 })).onHandLabel).toBe(
      '1,340 -> 1,440 on hand',
    );
  });
});

describe('formatHistoryMovement — where', () => {
  it('renders whichever side(s) resolve to a NAME', () => {
    expect(
      formatHistoryMovement(row({ fromLocationName: 'Staging', toLocationName: '37-B' })).routeLabel,
    ).toBe('Staging -> 37-B');
    expect(formatHistoryMovement(row({ toLocationName: 'Staging' })).routeLabel).toBe('-> Staging');
    expect(formatHistoryMovement(row({ fromLocationName: 'Staging' })).routeLabel).toBe('Staging ->');
    expect(formatHistoryMovement(row()).routeLabel).toBeNull();
  });
});

describe('formatHistoryMovement — rule 5: say nothing you cannot support', () => {
  it('renders no actor for a system/trigger write', () => {
    const f = formatHistoryMovement(row({ actorName: null, actorEmail: null }));
    expect(f.actorLabel).toBeNull();
    expect(f.actorEmailLabel).toBeNull();
  });

  it('keeps the email only when it is a second fact', () => {
    expect(formatHistoryMovement(row()).actorEmailLabel).toBe('pmathis@cvsouth.org');
    const emailOnly = formatHistoryMovement(
      row({ actorName: 'pmathis@cvsouth.org', actorEmail: null }),
    );
    expect(emailOnly.actorLabel).toBe('pmathis@cvsouth.org');
    expect(emailOnly.actorEmailLabel).toBeNull();
  });
});

describe('formatHistoryMovement — rule 4: timestamps are left RAW for the viewer', () => {
  it('passes the ISO string through without formatting it', () => {
    // The formatter must never bake a server-timezone date into the words —
    // web renders it via <LocalDateTime>, mobile via toLocaleString.
    expect(formatHistoryMovement(row({ at: '2026-07-22T21:16:28.910Z' })).whenIso).toBe(
      '2026-07-22T21:16:28.910Z',
    );
  });
});

describe('formatHistoryMovement — receiving provenance', () => {
  it('names the receipt and the PO, including a PO status that matters', () => {
    const f = formatHistoryMovement(
      row({
        movementType: 'receive_po',
        receiptNumber: 'R-20260722-175600-e56648',
        receiptStatus: 'posted',
        poNumber: 'CVW-002201',
        poStatus: 'received',
      }),
    );
    // 'posted' is the ordinary case and adds nothing; the PO status is always
    // stated because stock received against a later-CANCELLED PO is exactly
    // what sent the owner to SQL.
    expect(f.sourceLabel).toBe('Receipt R-20260722-175600-e56648 - PO CVW-002201 (received)');
  });

  it('flags a non-posted receipt status', () => {
    const f = formatHistoryMovement(
      row({
        movementType: 'receive_po',
        receiptNumber: 'R-20260722-162027-e33333',
        receiptStatus: 'reversed',
        poNumber: 'CVW-002201',
        poStatus: 'cancelled',
      }),
    );
    expect(f.sourceLabel).toBe(
      'Receipt R-20260722-162027-e33333 (reversed) - PO CVW-002201 (cancelled)',
    );
  });

  it('says nothing about receiving for a movement that did not come from a receipt', () => {
    expect(formatHistoryMovement(row()).sourceLabel).toBeNull();
  });
});

describe('formatHistoryMovement — rule 3: a reversal pair is recognisable', () => {
  it('marks the received half as later reversed, naming the reversing receipt', () => {
    const f = formatHistoryMovement(
      row({
        movementType: 'receive_po',
        quantityChange: 20,
        receiptNumber: 'R-20260722-162027-e33333',
        receiptStatus: 'reversed',
        reversalReason: 'wrong input',
        reversal: {
          role: 'reversed',
          counterpartMovementId: 'm-2',
          counterpartReceiptNumber: 'R-20260722-162027-e33333-REV',
        },
      }),
    );
    expect(f.reversalLabel).toBe('Reversed later by R-20260722-162027-e33333-REV: wrong input');
    expect(f.tone).toBe('warn');
  });

  it('marks the undo half as the reversal, naming what it undid', () => {
    const f = formatHistoryMovement(
      row({
        movementType: 'correction',
        quantityChange: -20,
        receiptNumber: 'R-20260722-162027-e33333-REV',
        receiptStatus: 'reversal',
        reversalReason: 'wrong input',
        reversal: {
          role: 'reversal',
          counterpartMovementId: 'm-1',
          counterpartReceiptNumber: 'R-20260722-162027-e33333',
        },
      }),
    );
    expect(f.reversalLabel).toBe('Reverses R-20260722-162027-e33333: wrong input');
  });

  it('still states the role when the counterpart fell outside the loaded page', () => {
    const f = formatHistoryMovement(
      row({
        receiptStatus: 'reversed',
        reversal: { role: 'reversed', counterpartMovementId: null, counterpartReceiptNumber: null },
      }),
    );
    expect(f.reversalLabel).toBe('Reversed later');
  });

  it('leaves the reversal slot empty for an ordinary movement', () => {
    expect(formatHistoryMovement(row()).reversalLabel).toBeNull();
  });
});

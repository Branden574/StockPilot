import { describe, expect, it } from 'vitest';

import { buildReceiptRequestHash, canonicalReceiptRequest } from './receipt-request-hash';

const base = {
  purchaseOrderId: 'po-1',
  warehouseId: 'wh-1',
  notes: null,
  lines: [
    { po_line_id: 'b', qty_received: 2, qty_accepted: 2, qty_rejected: 0, unit_cost: 1.5, notes: null },
    { po_line_id: 'a', qty_received: 1, qty_accepted: 1, qty_rejected: 0, unit_cost: 2, notes: null },
  ],
};

describe('buildReceiptRequestHash (SP-077)', () => {
  it('is deterministic and independent of line order — a byte-identical retry must dedupe', () => {
    const reordered = { ...base, lines: [base.lines[1]!, base.lines[0]!] };
    expect(buildReceiptRequestHash(base)).toBe(buildReceiptRequestHash(reordered));
  });

  it('changes when a quantity changes — an EDITED retry must NOT be absorbed as the old receipt', () => {
    const edited = { ...base, lines: [{ ...base.lines[0]!, qty_received: 3, qty_accepted: 3 }, base.lines[1]!] };
    expect(buildReceiptRequestHash(edited)).not.toBe(buildReceiptRequestHash(base));
  });

  it('changes when a line is added, and when the warehouse changes', () => {
    const added = { ...base, lines: [...base.lines, { po_line_id: 'c', qty_received: 1, qty_accepted: 1 }] };
    expect(buildReceiptRequestHash(added)).not.toBe(buildReceiptRequestHash(base));
    expect(buildReceiptRequestHash({ ...base, warehouseId: 'wh-2' })).not.toBe(buildReceiptRequestHash(base));
  });

  it('treats 2 and 2.0000 as the same quantity (four-decimal normalisation, as the web does)', () => {
    const asFloat = { ...base, lines: base.lines.map((l) => ({ ...l, qty_received: l.qty_received + 0.00001 - 0.00001 })) };
    expect(buildReceiptRequestHash(asFloat)).toBe(buildReceiptRequestHash(base));
  });

  it('mirrors the web canonical shape (sorted lines, camelCase keys, fixed decimals)', () => {
    const c = JSON.parse(canonicalReceiptRequest(base)) as { lines: { poLineId: string; qtyReceived: string }[] };
    expect(c.lines.map((l) => l.poLineId)).toEqual(['a', 'b']);
    expect(c.lines[0]!.qtyReceived).toBe('1.0000');
  });

  it('is never the idempotency key shape', () => {
    expect(buildReceiptRequestHash(base)).toMatch(/^rcpt-[0-9a-f]{16}$/);
  });
});

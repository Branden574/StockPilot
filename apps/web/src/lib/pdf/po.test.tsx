import { describe, expect, it } from 'vitest';

import {
  PurchaseOrderPdf,
  RECEIVED_BY_MAX,
  SKU_CHARS_PER_LINE,
  type PoPdfBillToCharter,
  type PoPdfCharge,
  type PoPdfHeader,
  type PoPdfLine,
  type PoPdfReceipt,
} from './po';

/**
 * Lightweight tree-walker tests for PurchaseOrderPdf. We can't actually render
 * a PDF in vitest (no node-canvas, no real font fetcher), so we instead inspect
 * the React element tree returned by PurchaseOrderPdf and assert that the
 * three new polish features land in the right shapes.
 *
 * Walking the tree this way avoids loading the @react-pdf renderer + its
 * transitive native deps in unit tests, which is how the rest of the suite
 * keeps the PDF renderer out of the happy path.
 */

interface TreeNode {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function isElement(node: unknown): node is TreeNode {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node;
}

function flatten(node: unknown, out: TreeNode[] = []): TreeNode[] {
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (!isElement(node)) return out;
  out.push(node);
  flatten(node.props.children, out);
  return out;
}

function textOf(node: unknown): string {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isElement(node)) return textOf(node.props.children);
  return '';
}

function nameOf(node: TreeNode): string {
  if (typeof node.type === 'string') return node.type;
  if (typeof node.type === 'function') {
    const fn = node.type as { displayName?: string; name?: string };
    return fn.displayName ?? fn.name ?? '';
  }
  if (typeof node.type === 'object' && node.type !== null) {
    const obj = node.type as { displayName?: string };
    return obj.displayName ?? '';
  }
  return '';
}

const baseHeader: PoPdfHeader = {
  poNumber: 'PO-1234',
  status: 'ordered',
  notes: null,
  expectedAt: null,
  createdAt: '2026-05-01T00:00:00Z',
  subtotal: 100,
  total: 100,
};

const baseLines: PoPdfLine[] = [
  {
    sku: 'SKU-1',
    name: 'Widget',
    quantityOrdered: 2,
    quantityReceived: 0,
    unitCost: 50,
    lineTotal: 100,
  },
];

function render(opts: {
  status?: string;
  poTerms?: string | null;
  lines?: PoPdfLine[];
  charges?: PoPdfCharge[];
  header?: Partial<PoPdfHeader>;
  billToCharter?: PoPdfBillToCharter | null;
  receipts?: PoPdfReceipt[];
}): TreeNode[] {
  const tree = PurchaseOrderPdf({
    po: { ...baseHeader, status: opts.status ?? baseHeader.status, ...opts.header },
    lines: opts.lines ?? baseLines,
    charges: opts.charges,
    org: {
      name: 'Acme Co',
      logoUrl: null,
      poTerms: opts.poTerms ?? null,
    },
    supplier: null,
    destination: null,
    receipts: opts.receipts,
    billToCharter: opts.billToCharter ?? null,
  });
  return flatten(tree);
}

/** Every <Text> in the tree that renders in the Courier (mono) table style. */
function monoTexts(nodes: TreeNode[]): TreeNode[] {
  return nodes.filter(
    (n) =>
      Array.isArray(n.props.style) &&
      (n.props.style as Array<{ fontFamily?: string } | undefined>).some(
        (s) => s != null && s.fontFamily === 'Courier',
      ),
  );
}

describe('PurchaseOrderPdf', () => {
  it('omits the DRAFT watermark for non-draft statuses', () => {
    const nodes = render({ status: 'ordered' });
    const allText = nodes.map((n) => textOf(n.props.children)).join(' ');
    expect(allText).not.toContain('DRAFT');
  });

  it('renders the DRAFT watermark when status is draft', () => {
    const nodes = render({ status: 'draft' });
    const watermark = nodes.find(
      (n) => textOf(n.props.children).trim() === 'DRAFT',
    );
    expect(watermark).toBeDefined();
  });

  it('matches draft case-insensitively', () => {
    const nodes = render({ status: 'DRAFT' });
    const watermark = nodes.find(
      (n) => textOf(n.props.children).trim() === 'DRAFT',
    );
    expect(watermark).toBeDefined();
  });

  it('omits the terms block when org.poTerms is null', () => {
    const nodes = render({ poTerms: null });
    const heading = nodes.find(
      (n) => textOf(n.props.children).trim() === 'Terms & conditions',
    );
    expect(heading).toBeUndefined();
  });

  it('omits the terms block when org.poTerms is whitespace only', () => {
    const nodes = render({ poTerms: '   \n  ' });
    const heading = nodes.find(
      (n) => textOf(n.props.children).trim() === 'Terms & conditions',
    );
    expect(heading).toBeUndefined();
  });

  it('renders the terms heading + body when org.poTerms is non-empty', () => {
    const nodes = render({ poTerms: 'Net 30 days. Returns require RMA.' });
    const heading = nodes.find(
      (n) => textOf(n.props.children).trim() === 'Terms & conditions',
    );
    expect(heading).toBeDefined();
    const body = nodes.find((n) =>
      textOf(n.props.children).includes('Net 30 days. Returns require RMA.'),
    );
    expect(body).toBeDefined();
  });

  it('does NOT render the signature block (removed 2026-07-10 per owner)', () => {
    const nodes = render({});
    const captions = nodes
      .map((n) => textOf(n.props.children))
      .filter((t) => t.includes('Authorized by') || t.includes('Accepted by'));
    expect(captions).toHaveLength(0);
  });

  it('renders an Outstanding column header', () => {
    const nodes = render({});
    const header = nodes.find(
      (n) => textOf(n.props.children).trim() === 'Outstanding',
    );
    expect(header).toBeDefined();
  });

  it('shows the still-owed quantity (ordered − received) on a partially-received line', () => {
    const nodes = render({
      status: 'partially_received',
      lines: [
        { sku: 'SKU-1', name: 'Widget', quantityOrdered: 100, quantityReceived: 40, unitCost: 1, lineTotal: 100 },
      ],
    });
    // Outstanding cell = 100 - 40 = 60, bolded (still owed).
    const outstanding = nodes.find(
      (n) =>
        textOf(n.props.children).trim() === '60' &&
        Array.isArray(n.props.style) &&
        (n.props.style as Array<{ fontFamily?: string }>).some(
          (s) => s && s.fontFamily === 'Helvetica-Bold',
        ),
    );
    expect(outstanding).toBeDefined();
  });

  it('shows 0 outstanding once a line is fully received, and never goes negative on over-receipt', () => {
    const nodes = render({
      status: 'received',
      lines: [
        // exact fill
        { sku: 'A', name: 'A', quantityOrdered: 5, quantityReceived: 5, unitCost: 1, lineTotal: 5 },
        // over-receipt: 7 received vs 5 ordered → clamps to 0, not -2
        { sku: 'B', name: 'B', quantityOrdered: 5, quantityReceived: 7, unitCost: 1, lineTotal: 5 },
      ],
    });
    const allText = nodes.map((n) => textOf(n.props.children)).join(' ');
    expect(allText).not.toContain('-2');
    // Both lines' outstanding cells read 0.
    const zeros = nodes.filter((n) => textOf(n.props.children).trim() === '0');
    expect(zeros.length).toBeGreaterThanOrEqual(2);
  });

  it('renders the Bill-to charter block (name, code, address, contact) when provided', () => {
    const nodes = render({
      billToCharter: {
        name: 'North Region Campus',
        code: 'NRC',
        addressLines: ['100 Main St', 'Austin, TX 78701'],
        contactName: 'Jane Buyer',
        contactEmail: 'ap@nrc.example',
        contactPhone: '512-555-0100',
      },
    });
    const allText = nodes.map((n) => textOf(n.props.children)).join(' ');
    expect(allText).toContain('North Region Campus');
    expect(allText).toContain('(NRC)');
    expect(allText).toContain('100 Main St');
    expect(allText).toContain('Austin, TX 78701');
    expect(allText).toContain('Jane Buyer');
    expect(allText).toContain('ap@nrc.example');
    expect(allText).toContain('512-555-0100');
    // Still shows the org as the account holder.
    expect(allText).toContain('Acme Co');
  });

  it('omits the Bill-to charter block when none is set', () => {
    const nodes = render({ billToCharter: null });
    const allText = nodes.map((n) => textOf(n.props.children)).join(' ');
    expect(allText).not.toContain('North Region Campus');
    // The org line is still present under "Bill to".
    expect(allText).toContain('Acme Co');
  });

  it('keeps existing totals + line items intact', () => {
    const nodes = render({});
    const allText = nodes.map((n) => textOf(n.props.children)).join(' ');
    expect(allText).toContain('Subtotal');
    expect(allText).toContain('Total');
    expect(allText).toContain('Widget');
  });

  // The owner's real Microix PO (PO-KVAII-001690): $46,995 of goods + 4 charges
  // (Shipping 475, Sales tax 3999.23, White Glove 900, E-Waste 400) = $52,769.23.
  const ownerCharges: PoPdfCharge[] = [
    { label: 'Shipping', quantity: null, unitCost: null, amount: 475 },
    { label: 'Sales tax 8.35%', quantity: null, unitCost: null, amount: 3999.23 },
    { label: 'White Glove Service', quantity: 100, unitCost: 9, amount: 900 },
    { label: 'CA E-Waste Fee', quantity: 100, unitCost: 4, amount: 400 },
  ];

  it('renders each charge as a labeled line row and a Charges roll-up', () => {
    const nodes = render({
      header: { subtotal: 46995, total: 52769.23 },
      lines: [
        { sku: 'SP-EPOMX-QAN', name: 'Acer Chromebook 511', quantityOrdered: 100, quantityReceived: 0, unitCost: 469.95, lineTotal: 46995 },
      ],
      charges: ownerCharges,
    });
    const allText = nodes.map((n) => textOf(n.props.children)).join(' ');
    // Every charge label appears (as a line row in the table).
    for (const label of ['Shipping', 'Sales tax 8.35%', 'White Glove Service', 'CA E-Waste Fee']) {
      expect(allText).toContain(label);
    }
    // Roll-up row + the true grand total.
    expect(allText).toContain('Charges');
    expect(allText).toContain('$52,769.23');
    // The White Glove qty (100) shows on its charge row.
    expect(allText).toContain('100');
  });

  it('does NOT render a Charges roll-up when there are no charges', () => {
    const nodes = render({ charges: [] });
    const label = nodes.find((n) => textOf(n.props.children).trim() === 'Charges');
    expect(label).toBeUndefined();
  });

  it('preserves the legacy derived "Tax & shipping" line for older POs with no charge rows', () => {
    // total > subtotal but no explicit charges → the pre-0235 fallback still
    // shows the derived surcharge so historical PO PDFs are unchanged.
    const nodes = render({ header: { subtotal: 100, total: 125 }, charges: [] });
    const allText = nodes.map((n) => textOf(n.props.children)).join(' ');
    expect(allText).toContain('Tax & shipping');
    expect(allText).not.toContain('Charges');
  });

  // Receipts table. The column widths are asserted arithmetically in
  // table-fit.test.ts; these guard the SHAPE those widths were budgeted for,
  // so a future edit cannot invalidate the budget without going red.
  const postedReceipt: PoPdfReceipt = {
    receiptNumber: 'R-20260721-223330-e7a08b',
    receivedAt: '2026-07-21T18:00:00Z',
    receivedByName: 'Andrew Rosas',
    status: 'posted',
    totalAccepted: 12,
    totalRejected: 0,
  };

  it('omits the receipts table when nothing has been received', () => {
    const nodes = render({ receipts: [] });
    const heading = nodes.find((n) => textOf(n.props.children).trim() === 'Receipts');
    expect(heading).toBeUndefined();
  });

  it('renders a posted receipt with its number, date, receiver and totals', () => {
    const nodes = render({ receipts: [postedReceipt] });
    const allText = nodes.map((n) => textOf(n.props.children)).join(' ');
    expect(allText).toContain('Receipts');
    expect(allText).toContain('R-20260721-223330-e7a08b');
    expect(allText).toContain('Jul 21, 2026');
    expect(allText).toContain('Andrew Rosas');
  });

  it('never renders the status inline with the receipt number', () => {
    // The reported collision was made unfixable by ` (${status})` being
    // concatenated into the mono <Text>: the worst case became 39 Courier
    // characters, wider than any column a LETTER page can afford. The status
    // has to stay on its own non-mono line for the width budget to hold.
    const nodes = render({
      receipts: [
        { ...postedReceipt, receiptNumber: 'R-20260721-223330-e7a08b-REV', status: 'reversal' },
      ],
    });
    const mono = monoTexts(nodes).map((n) => textOf(n.props.children));
    expect(mono).toContain('R-20260721-223330-e7a08b-REV');
    // No mono cell carries the status, the parentheses, or the two glued together.
    for (const text of mono) {
      expect(text).not.toContain('reversal');
      expect(text).not.toContain('(');
    }
    // The status is still shown, just not in the mono run.
    const status = nodes.find((n) => textOf(n.props.children).trim() === 'reversal');
    expect(status).toBeDefined();
  });

  it('omits the status line entirely for a posted receipt', () => {
    // 'posted' is the norm and adds nothing; only exceptions are called out.
    const nodes = render({ receipts: [postedReceipt] });
    const status = nodes.find((n) => textOf(n.props.children).trim() === 'posted');
    expect(status).toBeUndefined();
  });

  // ── Itemized receipt breakdown — owner ask 2026-08-20 (CVLYII-001460) ──
  // A receipt row saying "Accepted 200" answers how much but not WHAT: a
  // five-size shirt receipt printed one opaque number. The breakdown under
  // each receipt is the traceability the printout exists for.

  it('itemizes what each receipt covered, under that receipt', () => {
    const nodes = render({
      receipts: [
        {
          ...postedReceipt,
          totalAccepted: 90,
          totalRejected: 4,
          lines: [
            { sku: 'SP-GILDAN-CBLUE-S', name: 'Gildan Softstyle T-Shirt Carolina Blue - S', accepted: 25, rejected: 0 },
            { sku: 'SP-GILDAN-CBLUE-M', name: 'Gildan Softstyle T-Shirt Carolina Blue - M', accepted: 65, rejected: 4 },
          ],
        },
      ],
    });
    const allText = nodes.map((n) => textOf(n.props.children)).join(' ');
    expect(allText).toContain('Gildan Softstyle T-Shirt Carolina Blue - S');
    expect(allText).toContain('Gildan Softstyle T-Shirt Carolina Blue - M');
    expect(allText).toContain('SP-GILDAN-CBLUE-S');
    // The per-line quantities render, not only the receipt totals.
    expect(allText).toContain('25');
    expect(allText).toContain('65');
  });

  it('renders totals-only when a receipt carries no lines — older callers keep working', () => {
    // `lines` is optional precisely so a caller built before the breakdown
    // (or a test fixture) does not crash the whole PDF export.
    const nodes = render({ receipts: [postedReceipt] });
    const allText = nodes.map((n) => textOf(n.props.children)).join(' ');
    expect(allText).toContain('R-20260721-223330-e7a08b');
  });

  it('caps an over-long item name instead of letting it run into Accepted', () => {
    const longName =
      'An Extremely Long Product Name That Would Absolutely Collide With The Accepted Column If Left Unbounded In This Layout';
    const nodes = render({
      receipts: [
        {
          ...postedReceipt,
          lines: [{ sku: 'SP-X', name: longName, accepted: 3, rejected: 0 }],
        },
      ],
    });
    const cell = nodes.find((n) => textOf(n.props.children).startsWith('An Extremely Long'));
    expect(cell).toBeDefined();
    // The pin is that truncation HAPPENED, asserted structurally rather than by
    // total cell length — textOf concatenates the nested sku <Text>, so a
    // length bound would really be testing the concatenation, not the cap.
    const cellText = textOf(cell!.props.children);
    expect(cellText).not.toContain(longName);
    expect(cellText).toContain('…');
    expect(cellText).toContain('SP-X');
  });

  it('caps an over-long received-by value instead of letting it run into Accepted', () => {
    const email = 'branden.vincent-walker@subdomain.example.com';
    const nodes = render({ receipts: [{ ...postedReceipt, receivedByName: email }] });
    const cell = nodes.find((n) => textOf(n.props.children).startsWith('branden.vincent-walker@'));
    expect(cell).toBeDefined();
    const text = textOf(cell?.props.children);
    expect(text.length).toBeLessThanOrEqual(RECEIVED_BY_MAX);
    expect(text).not.toBe(email);
  });

  it('falls back to an em dash when the receiver is unknown', () => {
    const nodes = render({ receipts: [{ ...postedReceipt, receivedByName: null }] });
    const dash = nodes.find((n) => textOf(n.props.children).trim() === '—');
    expect(dash).toBeDefined();
  });

  it('wraps an over-long SKU across lines instead of dropping characters', () => {
    // This replaces a test that asserted truncation. Truncating was the
    // regression: a supplier orders against this part number and the
    // disambiguating suffix is at the END, so the dropped characters were the
    // only thing telling two same-title items apart. The cell now stacks
    // SKU_CHARS_PER_LINE-character Courier lines, so the value stays whole.
    const sku = 'SP-ACER-CB511-TOUCH-32GB-EDU-BUNDLE';
    const nodes = render({
      lines: [
        { sku, name: 'Acer Chromebook 511 Touch 32GB', quantityOrdered: 1, quantityReceived: 0, unitCost: 1, lineTotal: 1 },
      ],
    });
    const chunks = monoTexts(nodes)
      .map((n) => textOf(n.props.children))
      .filter((t) => t !== '—');
    expect(chunks.join('')).toBe(sku);
    expect(chunks.length).toBe(Math.ceil(sku.length / SKU_CHARS_PER_LINE));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SKU_CHARS_PER_LINE);
      expect(chunk).not.toContain('…');
    }
    // The description is untouched.
    const allText = nodes.map((n) => textOf(n.props.children)).join(' ');
    expect(allText).toContain('Acer Chromebook 511 Touch 32GB');
  });

  it('leaves a normal-length SKU untouched', () => {
    const nodes = render({});
    const mono = monoTexts(nodes).map((n) => textOf(n.props.children));
    expect(mono).toContain('SKU-1');
  });

  it('still shows an em dash for a line with no SKU', () => {
    const nodes = render({
      lines: [
        { sku: '', name: 'Unlabeled item', quantityOrdered: 1, quantityReceived: 0, unitCost: 1, lineTotal: 1 },
      ],
    });
    const cell = monoTexts(nodes).find((n) => textOf(n.props.children).trim() === '—');
    expect(cell).toBeDefined();
  });

  it('does not blow up when the type guard helper sees plain elements', () => {
    // Sanity check on the flatten helper itself — the test suite depends on
    // it walking past primitive children (numbers, strings) without throwing.
    const nodes = render({ poTerms: 'short' });
    expect(nodes.length).toBeGreaterThan(0);
    // The root node from @react-pdf is the <Document>; component names get
    // mangled by bundlers so we identify it by the document `title` prop
    // we explicitly set in PurchaseOrderPdf.
    const docNode = nodes.find(
      (n) =>
        typeof n.props.title === 'string' &&
        (n.props.title as string).startsWith('Purchase Order '),
    );
    expect(docNode).toBeDefined();
    // Confirm nameOf doesn't throw on any tree element.
    for (const n of nodes) expect(typeof nameOf(n)).toBe('string');
  });
});

import { describe, expect, it } from 'vitest';

import {
  PurchaseOrderPdf,
  type PoPdfBillToCharter,
  type PoPdfCharge,
  type PoPdfHeader,
  type PoPdfLine,
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
    billToCharter: opts.billToCharter ?? null,
  });
  return flatten(tree);
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

  it('always renders both signature column captions', () => {
    const nodes = render({});
    const captions = nodes
      .map((n) => textOf(n.props.children))
      .filter((t) => t.includes('Authorized by') || t.includes('Accepted by'));
    expect(captions.some((t) => t.includes('Authorized by (StockPilot)'))).toBe(
      true,
    );
    expect(captions.some((t) => t.includes('Accepted by (Supplier)'))).toBe(
      true,
    );
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

import { describe, expect, it } from 'vitest';

import { COURIER_ADVANCE, width } from '@/test/pdf-font-metrics';

import {
  CELL_GUTTER,
  PO_COLS,
  RECEIPT_COLS,
  RECEIPT_NUMBER_MAX_CHARS,
  RECEIVED_BY_MAX,
  ROW_INNER_WIDTH,
  SKU_CHARS_PER_LINE,
  SKU_MAX_CHARS,
  truncate,
  wrapSku,
} from './po';
import { formatCurrencyForPdf, formatDateForPdf, formatNumberForPdf } from './styles';

/**
 * Column-fit invariants for the purchase-order PDF tables.
 *
 * WHY THIS EXISTS: the owner reported a receipts row rendering as
 * "R-20260721-223330-e7a08bJul 21, 2026" — the receipt number touching the
 * date with no gap. A rendered-text snapshot would not have caught it: both
 * strings were present and correct. The defect was purely geometric, and
 * @react-pdf silently overflows rather than erroring, so nothing downstream
 * complains. The only assertion that catches this class of bug is the
 * invariant itself:
 *
 *   for every column, the widest content it can ever hold must fit inside
 *   the content box its flex weight buys once every cell's gutter is reserved
 *
 * Font metrics live here rather than in po.tsx because production code never
 * measures anything — only this design-time check does.
 *
 * The advance widths below are the Adobe Core-14 AFM design widths (units per
 * 1000 em) for the glyph subset these two tables can emit, read out of the
 * bundled @react-pdf/pdfkit@5.1.1 metrics. To regenerate:
 *
 *   node --input-type=module -e "const { default: D } = await import(
 *     './node_modules/.pnpm/@react-pdf+pdfkit@5.1.1/node_modules/@react-pdf/pdfkit/lib/pdfkit.js');
 *     const d = new D({size:'LETTER'}); d.font('Helvetica').fontSize(1000);
 *     console.log(d.widthOfString('A'));"
 *
 * (@react-pdf/pdfkit is a transitive dependency and is not resolvable from
 * apps/web under pnpm's strict node_modules, so it cannot be imported here.)
 *
 * This model deliberately ignores AFM kern pairs, which pdfkit does apply.
 * Kerning only ever makes a string NARROWER, so every width computed here is
 * an upper bound on what the layout engine will produce. That biases each
 * assertion toward failing rather than silently passing, which is the right
 * direction for a fit check.
 */

// pdfStyles.tHeadCell: Helvetica-Bold 8pt, letterSpacing 0.6, and
// textTransform: 'uppercase'. @react-pdf applies the transform BEFORE the
// layout engine measures the string, so "OUTSTANDING" — not "Outstanding" —
// is what has to fit. That difference is 6.8pt on this label alone, which is
// exactly the kind of thing eyeballing a column weight gets wrong.
const HEAD_FONT_SIZE = 8;
const HEAD_LETTER_SPACING = 0.6;

function headerWidth(label: string): number {
  const shown = label.toUpperCase();
  return width(shown, 'Helvetica-Bold', HEAD_FONT_SIZE) + shown.length * HEAD_LETTER_SPACING;
}

// pdfStyles.tCell = Helvetica 9pt; pdfStyles.tCellMono = Courier 8.5pt.
const BODY_FONT_SIZE = 9;
const MONO_FONT_SIZE = 8.5;

/**
 * Usable CONTENT width of one column, in points.
 *
 * A cell's gutter is NOT carved out of its flex share — it is added to it.
 * `flex: N` resolves to flexBasis 0, so yoga distributes what is left after
 * every cell's padding is reserved, then adds each cell's padding back on:
 *
 *   content(i) = weight(i) / 100 * (ROW_INNER_WIDTH - cellCount * CELL_GUTTER)
 *
 * The intuitive model — (weight / 100) * ROW_INNER_WIDTH - CELL_GUTTER — is
 * wrong, and wrong in the dangerous direction on the wide columns. Both models
 * were checked against a real rendered PDF by reading absolute glyph x
 * positions out of the content stream; this one reproduced every measured cell
 * edge exactly (e.g. PO num 5 -> 23.80 + 6 = 29.80pt, matching the rendered
 * 73.80 − 44.00), the other did not.
 */
function contentWidth(cols: Readonly<Record<string, number>>, weight: number): number {
  const gutters = Object.keys(cols).length * CELL_GUTTER;
  return (weight / 100) * (ROW_INNER_WIDTH - gutters);
}

/** Assertion helper that reports the actual shortfall when it fails. */
function expectFits(
  label: string,
  width_: number,
  cols: Readonly<Record<string, number>>,
  weight: number,
): void {
  const available = contentWidth(cols, weight);
  expect(
    width_ <= available,
    `${label}: needs ${width_.toFixed(3)}pt but weight ${weight} ` +
      `buys only ${available.toFixed(3)}pt of content ` +
      `(gutter ${CELL_GUTTER}pt is reserved on top of this)`,
  ).toBe(true);
}

describe('PDF table column arithmetic', () => {
  it('PO_COLS weights sum to 100', () => {
    // contentWidth() treats a weight as a percentage, so any other sum makes
    // every assertion in this file measure against a width that does not exist.
    const sum = Object.values(PO_COLS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it('RECEIPT_COLS weights sum to 100', () => {
    const sum = Object.values(RECEIPT_COLS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it('ROW_INNER_WIDTH matches the LETTER page and row padding', () => {
    // 612pt page − 40pt page padding each side − 4pt tRow padding each side.
    expect(ROW_INNER_WIDTH).toBe(524);
  });
});

describe('receipts table fits its widest possible content', () => {
  // Built from the generator's grammar rather than a literal sample, so the
  // test documents where 28 comes from:
  //   post_receipt (migs 0013/0015/0069/0190/0231/0285):
  //     'R-' || YYYYMMDD || '-' || HH24MISS || '-' || 6 hex  = 24 chars
  //   reverse_receipt (mig 0195) appends '-REV' once        = 28 chars
  const WORST_RECEIPT_NUMBER = `R-${'0'.repeat(8)}-${'0'.repeat(6)}-${'a'.repeat(6)}-REV`;

  it('derives the same maximum length the database can produce', () => {
    expect(WORST_RECEIPT_NUMBER).toHaveLength(RECEIPT_NUMBER_MAX_CHARS);
    expect(RECEIPT_NUMBER_MAX_CHARS).toBe(28);
  });

  it('holds a full-length reversal receipt number without touching the Date column', () => {
    // This is the owner-reported defect. At the old weight of 22 the column
    // was 115.28pt and the number alone measured 142.80pt.
    expectFits(
      'receipt number',
      width(WORST_RECEIPT_NUMBER, 'Courier', MONO_FONT_SIZE),
      RECEIPT_COLS,
      RECEIPT_COLS.number,
    );
  });

  it('holds the owner-reported receipt number that collided in production', () => {
    expectFits(
      'receipt number (reported sample)',
      width('R-20260721-223330-e7a08b', 'Courier', MONO_FONT_SIZE),
      RECEIPT_COLS,
      RECEIPT_COLS.number,
    );
  });

  it('holds every status label the receipts check constraint allows', () => {
    // The status renders on its own line inside the number cell, so it is
    // bounded by that cell's inner width, not by the number's width.
    const statuses = ['draft', 'posted', 'reversed', 'reversal', 'canceled'];
    const usable = contentWidth(RECEIPT_COLS, RECEIPT_COLS.number);
    for (const status of statuses) {
      expect(width(status, 'Helvetica', 7.5)).toBeLessThanOrEqual(usable);
    }
  });

  it('holds the widest date formatDateForPdf can emit', () => {
    // Enumerate all twelve month abbreviations rather than hardcode one: the
    // widest is "May", which is not the guess most people make.
    let widest = 0;
    let widestText = '';
    for (let month = 0; month < 12; month += 1) {
      const text = formatDateForPdf(new Date(Date.UTC(2026, month, 20, 20, 0, 0)));
      const w = width(text, 'Helvetica', BODY_FONT_SIZE);
      if (w > widest) {
        widest = w;
        widestText = text;
      }
    }
    expect(widestText).toContain('May');
    expectFits(`date "${widestText}"`, widest, RECEIPT_COLS, RECEIPT_COLS.date);
    // The null case renders an em dash, which must also fit.
    expectFits(
      'date (none)',
      width(formatDateForPdf(null), 'Helvetica', BODY_FONT_SIZE),
      RECEIPT_COLS,
      RECEIPT_COLS.date,
    );
  });

  it('holds a capped received-by value, including the truncated worst case', () => {
    // received_by_name falls back to an email address: no spaces, so it cannot
    // wrap and the cap is the only defense.
    //
    // ASSUMPTION, stated so it can be argued with: names and emails are budgeted
    // at the Helvetica digit/lowercase design width of 556/1000. A pathological
    // all-"W" string would be 70% wider and is not defended — that is not a name.
    const DESIGN_ADVANCE = (556 / 1000) * BODY_FONT_SIZE;
    expectFits('received by (uncapped max)', RECEIVED_BY_MAX * DESIGN_ADVANCE, RECEIPT_COLS, RECEIPT_COLS.by);
    // truncate() replaces the final character with an ellipsis, and in
    // Helvetica the ellipsis is 1000/1000 em — nearly double a lowercase
    // letter. A cap derived from the design width alone would overflow here.
    const truncatedWorst = (RECEIVED_BY_MAX - 1) * DESIGN_ADVANCE + width('…', 'Helvetica', BODY_FONT_SIZE);
    expectFits('received by (truncated)', truncatedWorst, RECEIPT_COLS, RECEIPT_COLS.by);
    // Cross-check the budget against a real long email at real metrics.
    const email = truncate('branden.vincent-walker@subdomain.example.com', RECEIVED_BY_MAX);
    expect(email.length).toBeLessThanOrEqual(RECEIVED_BY_MAX);
    expectFits('received by (real email)', width(email, 'Helvetica', BODY_FONT_SIZE), RECEIPT_COLS, RECEIPT_COLS.by);
  });

  it('holds seven-figure accepted and rejected quantities', () => {
    const qty = formatNumberForPdf(1234567);
    expectFits('accepted', width(qty, 'Helvetica', BODY_FONT_SIZE), RECEIPT_COLS, RECEIPT_COLS.accepted);
    expectFits('rejected', width(qty, 'Helvetica', BODY_FONT_SIZE), RECEIPT_COLS, RECEIPT_COLS.rejected);
  });

  it('holds every receipts header label at its rendered uppercase width', () => {
    const headers: Array<[string, number]> = [
      ['Receipt', RECEIPT_COLS.number],
      ['Date', RECEIPT_COLS.date],
      ['Received by', RECEIPT_COLS.by],
      ['Accepted', RECEIPT_COLS.accepted],
      ['Rejected', RECEIPT_COLS.rejected],
    ];
    for (const [label, weight] of headers) {
      expectFits(`header "${label.toUpperCase()}"`, headerWidth(label), RECEIPT_COLS, weight);
    }
  });
});

describe('line items table fits its widest possible content', () => {
  it('fits one wrapped SKU line inside the SKU content box', () => {
    // Courier's ellipsis is the same 600/1000 advance as every other glyph, so
    // character count maps exactly to width here — which is what makes
    // SKU_CHARS_PER_LINE sound rather than approximate.
    const monoAdvance = (COURIER_ADVANCE / 1000) * MONO_FONT_SIZE;
    expectFits('sku (one wrapped line)', SKU_CHARS_PER_LINE * monoAdvance, PO_COLS, PO_COLS.sku);
  });

  it('derives SKU_CHARS_PER_LINE from the column content box, not its outer width', () => {
    // Deriving it from the cell's OUTER width instead spends the gutter on
    // glyphs, which leaves the SKU flush against the description — the exact
    // defect this file exists for.
    const monoAdvance = (COURIER_ADVANCE / 1000) * MONO_FONT_SIZE;
    expect(SKU_CHARS_PER_LINE).toBe(
      Math.floor(contentWidth(PO_COLS, PO_COLS.sku) / monoAdvance),
    );
  });

  it('wraps a schema-maximum SKU without dropping a single character', () => {
    // The regression this replaces: SKUs over 17 chars were truncated on a
    // document the supplier orders against, and generated SKUs carry their
    // disambiguating suffix LAST (books-import `${title}-${5}-${3}`), so the
    // dropped characters were the ones that tell two items apart.
    const sku = `SP-${'A'.repeat(SKU_MAX_CHARS - 3)}`;
    expect(sku).toHaveLength(SKU_MAX_CHARS);
    const lines = wrapSku(sku);
    expect(lines.join('')).toBe(sku);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(SKU_CHARS_PER_LINE);
      expectFits('sku (wrapped line)', width(line, 'Courier', MONO_FONT_SIZE), PO_COLS, PO_COLS.sku);
    }
  });

  it('wraps a real long SKU intact, suffix and all', () => {
    const sku = 'SP-ACER-CB511-TOUCH-32GB-EDU-BUNDLE';
    const lines = wrapSku(sku);
    expect(lines.join('')).toBe(sku);
    expect(lines.length).toBe(Math.ceil(sku.length / SKU_CHARS_PER_LINE));
    for (const line of lines) {
      expectFits('sku (wrapped line)', width(line, 'Courier', MONO_FONT_SIZE), PO_COLS, PO_COLS.sku);
    }
  });

  it('bounds a SKU longer than the schema allows rather than growing unbounded', () => {
    // Unreachable for data created through the app (packages/core caps sku at
    // 64); the guard exists so one malformed row cannot outgrow a page.
    const lines = wrapSku('X'.repeat(500));
    expect(lines.join('').length).toBeLessThanOrEqual(SKU_MAX_CHARS);
    expect(lines.length).toBeLessThanOrEqual(Math.ceil(SKU_MAX_CHARS / SKU_CHARS_PER_LINE));
  });

  it('returns no lines for an empty SKU so the caller can render its em dash', () => {
    expect(wrapSku('')).toEqual([]);
  });

  it('holds a four-digit line number', () => {
    // formatNumberForPdf groups thousands, so line 1000 prints as "1,000" —
    // wider than the three digits the old weight of 4 was sized for.
    expectFits('line number', width(formatNumberForPdf(1000), 'Helvetica', BODY_FONT_SIZE), PO_COLS, PO_COLS.num);
  });

  it('holds seven-figure quantities in Ordered, Recv and Outstanding', () => {
    // Seven digits, not six: the six-digit literal this used to carry made the
    // assertion weaker than its name, and it hid that recv (weight 8, 38.08pt)
    // could not hold "1,234,567" at 40.03pt. recv is now 9.
    const qty = formatNumberForPdf(1234567);
    expectFits('ordered', width(qty, 'Helvetica', BODY_FONT_SIZE), PO_COLS, PO_COLS.qty);
    expectFits('recv', width(qty, 'Helvetica', BODY_FONT_SIZE), PO_COLS, PO_COLS.recv);
    expectFits('outstanding', width(qty, 'Helvetica', BODY_FONT_SIZE), PO_COLS, PO_COLS.out);
  });

  it('holds seven-figure currency in Unit cost and Line total', () => {
    // Pins the money budget so a future weight trim cannot silently un-fund it.
    const money = formatCurrencyForPdf(1234567.89);
    expectFits('unit cost', width(money, 'Helvetica', BODY_FONT_SIZE), PO_COLS, PO_COLS.unit);
    expectFits('line total', width(money, 'Helvetica', BODY_FONT_SIZE), PO_COLS, PO_COLS.total);
    // Negative charge amounts (discounts) carry a leading minus sign.
    const negative = formatCurrencyForPdf(-1234567.89);
    expectFits('line total (negative)', width(negative, 'Helvetica', BODY_FONT_SIZE), PO_COLS, PO_COLS.total);
  });

  it('holds the em-dash placeholder used on charge rows', () => {
    const dash = width('—', 'Helvetica', BODY_FONT_SIZE);
    for (const weight of [PO_COLS.sku, PO_COLS.qty, PO_COLS.recv, PO_COLS.out, PO_COLS.unit]) {
      expectFits('charge-row placeholder', dash, PO_COLS, weight);
    }
  });

  it('holds every line-items header label at its rendered uppercase width', () => {
    // "Outstanding" is the one that was already overflowing before this fix:
    // 64.5pt uppercase against a 57.6pt column.
    const headers: Array<[string, number]> = [
      ['#', PO_COLS.num],
      ['SKU', PO_COLS.sku],
      ['Description', PO_COLS.name],
      ['Ordered', PO_COLS.qty],
      ['Recv', PO_COLS.recv],
      ['Outstanding', PO_COLS.out],
      ['Unit cost', PO_COLS.unit],
      ['Line total', PO_COLS.total],
    ];
    for (const [label, weight] of headers) {
      expectFits(`header "${label.toUpperCase()}"`, headerWidth(label), PO_COLS, weight);
    }
  });
});

describe('truncate() contract that the caps rest on', () => {
  it('never returns more characters than the cap', () => {
    const long = 'X'.repeat(200);
    expect(truncate(long, SKU_MAX_CHARS).length).toBeLessThanOrEqual(SKU_MAX_CHARS);
    expect(truncate(long, RECEIVED_BY_MAX).length).toBeLessThanOrEqual(RECEIVED_BY_MAX);
  });

  it('leaves values at or under the cap untouched', () => {
    expect(truncate('SKU-1', SKU_MAX_CHARS)).toBe('SKU-1');
    expect(truncate('X'.repeat(SKU_MAX_CHARS), SKU_MAX_CHARS)).toBe('X'.repeat(SKU_MAX_CHARS));
  });

  it('appends an ellipsis whose Courier advance equals any other glyph', () => {
    const out = truncate('X'.repeat(200), SKU_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(width('…', 'Courier', MONO_FONT_SIZE)).toBe(width('X', 'Courier', MONO_FONT_SIZE));
  });

  it('appends an ellipsis that is WIDER than a letter in Helvetica', () => {
    // Guards the assumption the received-by cap is built on: if this ever
    // stopped being true the truncated-worst-case budget above is wrong.
    expect(width('…', 'Helvetica', BODY_FONT_SIZE)).toBeGreaterThan(
      width('a', 'Helvetica', BODY_FONT_SIZE),
    );
  });
});

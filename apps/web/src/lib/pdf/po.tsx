import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import { BrandedHeader } from './branding';
import {
  PDF_COLORS,
  formatCurrencyForPdf,
  formatDateForPdf,
  formatNumberForPdf,
  pdfStyles,
} from './styles';

// Maximums for free-form fields rendered into the PDF. We cap here in
// the renderer (not the API) because the underlying columns allow long
// values, but @react-pdf gives no good defense against a 2 000-char
// description blowing out a single line row.
const DESCRIPTION_MAX = 140;
const NOTES_MAX = 1200;

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Adjacent @react-pdf flex cells share an edge: `tRow` only pads the row's
 * outer edges and `tCell` has no horizontal padding, so a cell whose content
 * fills its width paints straight into its neighbour. That is the
 * owner-reported 2026-07-22 defect on the receipts table —
 * "R-20260721-223330-e7a08bJul 21, 2026" with no gap at all.
 *
 * Padding alone does not fix it. Verified by rendering a real PDF and reading
 * glyph positions back out of the content stream: a cell whose ENTIRE content
 * is one unbreakable token — a receipt number, a SKU, an email address — is
 * laid out on a single line and simply overflows its box. (Multi-word content
 * is fine; textkit breaks a too-long word at the box edge once it has a line
 * break to work with, which is why the description column can safely donate
 * width.) At the pre-fix weights the 24-character receipt number ran from
 * x=44.0 to x=166.4 while the date started at x=156.64 — a 9.8pt overlap,
 * which is exactly what the screenshot showed.
 *
 * So the real fix is the column arithmetic below: every weight is budgeted
 * against the widest content that column can ever hold, and single-token
 * fields with no natural bound are truncated to a character count derived
 * from that budget. The gutter is what guarantees the whitespace stays
 * visible; the budget is what guarantees the content stops before the edge.
 *
 * 6pt is roughly 2.4 Helvetica-9 word spaces — unambiguous as a column break
 * without looking like a missing value.
 */
export const CELL_GUTTER = 6;

/**
 * Usable inner width of a table row, in points. LETTER is 612pt wide,
 * `pdfStyles.page` pads 40pt each side, and `tRow`/`tHeadRow` pad another 4pt
 * each side, so a row's cells divide 612 − 80 − 8 = 524pt.
 *
 * NOTE for anyone recomputing a weight: a cell's gutter is NOT carved out of
 * its flex share, it is added to it. `flex: N` resolves to flexBasis 0, so
 * yoga distributes (524 − total padding) in proportion to the weights and then
 * adds each cell's padding back on. A column's usable CONTENT width is
 * therefore (weight / 100) * (524 − cellCount * CELL_GUTTER), not
 * (weight / 100) * 524 − CELL_GUTTER. Verified against a real rendered PDF:
 * the two models differ by several points per column, enough to ship an
 * overflow while believing the arithmetic closed. table-fit.test.ts uses the
 * correct one.
 */
export const ROW_INNER_WIDTH = 612 - 2 * 40 - 2 * 4;

/**
 * Longest receipt number the database can produce, in characters.
 *
 * post_receipt builds it as
 *   'R-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-' || substr(uuid, 1, 6)
 * (migrations 0013/0015/0069/0190/0231/0285) = a fixed 24 characters, since
 * the first 6 characters of a uuid text are always hex. reverse_receipt
 * (migration 0195) appends '-REV' for the reversal row, and guards
 * `status <> 'posted'` first so a number can never take two '-REV' suffixes.
 * 24 + 4 = 28, and ReceivingService.listForPurchaseOrder applies no status
 * filter, so reversal rows really do reach this table.
 */
export const RECEIPT_NUMBER_MAX_CHARS = 28;

/**
 * `received_by_name` is unbounded user data with a single-token worst case: it
 * falls back to an email address, which has no spaces and so cannot wrap. It is
 * capped to what its column can actually paint (table-fit.test.ts derives the
 * number from the column width and fails if it drifts out of step).
 */
export const RECEIVED_BY_MAX = 33;

/**
 * Item-name budget for a receipt's itemized sub-row. The name cell spans the
 * number+date+by columns (flex 78); `by` paints ~33 chars at flex 35, so 78
 * scales to ~73 — minus the sub-row indent, 68 is what fits without wrapping.
 */
export const RECEIPT_ITEM_NAME_MAX = 68;

/**
 * Characters of SKU that fit on ONE line of the SKU column.
 *
 * A SKU never contains a space, so @react-pdf lays it out as a single
 * unbreakable token and simply overflows the cell — the same geometry that put
 * the receipt number on top of the Date column. Capping it by TRUNCATION (the
 * first fix here) is worse than the overflow it prevented: a purchase order is
 * an external commercial document and the supplier orders against this part
 * number. Generated SKUs put the disambiguating suffix LAST
 * (books-import.ts `${title}-${5}-${3}`, inventory.ts `${base}-${size}`), so
 * truncation drops exactly the characters that tell two items apart, and
 * packages/core allows 64 of them. Every neighbouring document (pick slip,
 * packing slip, cycle count, inventory snapshot) prints the SKU in full.
 *
 * So the cell WRAPS instead: the value is split into successive Courier lines,
 * costing row height rather than data. The arithmetic:
 *
 *   content box = PO_COLS.sku / 100 * (ROW_INNER_WIDTH - 8 * CELL_GUTTER)
 *               = 19 / 100 * (524 - 48) = 90.44pt
 *   Courier advance at 8.5pt = 600/1000 * 8.5 = 5.10pt
 *   floor(90.44 / 5.10) = 17 characters
 *
 * table-fit.test.ts re-derives this from PO_COLS and fails if the weight moves.
 */
export const SKU_CHARS_PER_LINE = 17;

/**
 * Last-resort bound on how much SKU is rendered at all.
 *
 * packages/core/src/schemas/inventory.ts caps `sku` at 64 characters, so a
 * longer value is data that never came through the app. 64 wraps to 4 lines,
 * which is already the tallest a legitimate row can get; leaving it unbounded
 * would let one malformed row grow past a page. For conforming data this
 * truncation is unreachable — that is the point of siting it at the schema max
 * rather than at a width.
 */
export const SKU_MAX_CHARS = 64;

/**
 * Split a SKU into lines that each fit the SKU column. Slicing (not truncating)
 * is what keeps the identifier complete and copy/searchable in the PDF text
 * layer. Returns [] for an empty SKU so the caller can render its em dash.
 */
export function wrapSku(sku: string, perLine: number = SKU_CHARS_PER_LINE): string[] {
  const value = truncate(sku, SKU_MAX_CHARS);
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += perLine) lines.push(value.slice(i, i + perLine));
  return lines;
}

// Gutters live beside the weights they were budgeted with rather than in
// styles.ts: adding padding to the shared `tCell` would narrow every content
// box in inventory-snapshot.tsx (whose rows are wrap={false}, so row heights
// and therefore pagination would shift) and cycle-count.tsx, neither of which
// has been re-measured against its own column budget.
const poTable = StyleSheet.create({
  // Left-aligned cells grow rightward, so their gutter sits on the right.
  cellGutter: { paddingRight: CELL_GUTTER },
  // Right-aligned cells grow leftward, so theirs sits on the left.
  cellGutterRight: { paddingLeft: CELL_GUTTER },
  // The receipt number is a two-line stack, not a run: concatenating the
  // status into the mono <Text> made the cell's worst case
  // "R-…-REV (reversal)" = 39 Courier characters, which no column on a LETTER
  // page can hold. Keeping the status on its own line keeps the mono line's
  // width bounded by RECEIPT_NUMBER_MAX_CHARS.
  receiptNumberCell: { paddingRight: CELL_GUTTER },
  receiptStatus: { fontSize: 7.5, color: PDF_COLORS.ink3, marginTop: 1 },
  // A receipt's itemized sub-row: indented under its parent receipt, no top
  // border (the border belongs to the receipt row that owns the group), sku in
  // small mono after the name so the pair stays one line high.
  receiptItemRow: { flexDirection: 'row', paddingLeft: 10, paddingTop: 1, paddingBottom: 1 },
  receiptItemSku: { fontSize: 7.5, fontFamily: 'Courier', color: PDF_COLORS.ink3 },
});

export interface PoPdfLine {
  sku: string;
  name: string;
  quantityOrdered: number;
  /** Cumulative quantity received against this line (post_receipt increments). */
  quantityReceived: number;
  unitCost: number;
  lineTotal: number;
}

/**
 * One item on a receipt — the itemized breakdown under a receipt row.
 *
 * The totals row alone ("Accepted 200") answers HOW MUCH but not WHAT: a
 * receipt covering five shirt sizes printed one opaque number, and the person
 * reading the PDF a month later could not reconstruct which items that receiver
 * actually signed for. Owner ask 2026-08-20 (CVLYII-001460): the breakdown is
 * the traceability, so it prints under every receipt.
 */
export interface PoPdfReceiptLine {
  sku: string;
  name: string;
  accepted: number;
  rejected: number;
}

export interface PoPdfReceipt {
  receiptNumber: string;
  receivedAt: string | null;
  receivedByName: string | null;
  status: string;
  totalAccepted: number;
  totalRejected: number;
  /** Itemized breakdown. Optional so older callers/tests keep compiling;
   *  the PDF route always supplies it. Empty = render totals only. */
  lines?: PoPdfReceiptLine[];
}

/**
 * A financial-only charge (tax, freight, White Glove service, e-waste fee,
 * discount…) — rendered as a line row in the PO's existing item table but with
 * no SKU and no receiving columns, since it never becomes stock.
 */
export interface PoPdfCharge {
  label: string;
  /** Optional qty + unit cost for a faithful "100 @ $9.00" row; null = flat. */
  quantity: number | null;
  unitCost: number | null;
  /** Signed line total (discounts negative). Rolls into the PO total. */
  amount: number;
}

export interface PoPdfHeader {
  poNumber: string;
  status: string;
  notes: string | null;
  expectedAt: string | null;
  createdAt: string | null;
  subtotal: number;
  total: number;
}

export interface PoPdfOrg {
  name: string;
  logoUrl: string | null;
  /**
   * Optional free-form terms string printed at the bottom of the PDF.
   * Sourced from organizations.po_terms. Null/empty = no terms block.
   */
  poTerms?: string | null;
}

export interface PoPdfSupplier {
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
}

export interface PoPdfDestination {
  warehouseName: string | null;
  locationName: string | null;
}

/** Bill-to charter for the "Bill to" block. Null = billed to the org only. */
export interface PoPdfBillToCharter {
  name: string;
  code: string | null;
  /** Pre-formatted, non-empty mailing-address lines (street, city/region/zip…). */
  addressLines: string[];
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

interface PurchaseOrderPdfProps {
  po: PoPdfHeader;
  lines: PoPdfLine[];
  /** Financial-only charges (tax/freight/service/fee/discount). Empty = none. */
  charges?: PoPdfCharge[];
  org: PoPdfOrg;
  supplier: PoPdfSupplier | null;
  destination: PoPdfDestination | null;
  /** Posted receipts (receiving history). Empty = nothing received yet. */
  receipts?: PoPdfReceipt[];
  /** Bill-to charter rendered under the org in the "Bill to" block. */
  billToCharter?: PoPdfBillToCharter | null;
}

/**
 * Column layout for the PO line table. Weights sum to 100 and, after the
 * eight 6pt gutters, divide 476pt of content. Each weight is budgeted as the
 * widest content that column can ever hold; table-fit.test.ts asserts it.
 *
 * Header labels are the binding constraint on half of these columns because
 * `tHeadCell` sets textTransform: 'uppercase' and @react-pdf applies the
 * transform BEFORE measuring — "OUTSTANDING" at Helvetica-Bold 8 plus 0.6
 * letterSpacing is 65.3pt, not the 53.7pt the mixed-case label measures, and
 * it is a single unbreakable word. `out` grew from 11 (57.6pt of content
 * under the old no-gutter layout) purely to stop its own header overflowing,
 * which it was already doing before this change. `name` donates because it is
 * the only column here that wraps on spaces, so losing width costs it row
 * height rather than legibility.
 *
 * `recv` went 8 -> 9 (paid for by `name` 18 -> 17) because the quantity columns
 * are budgeted for a seven-digit count: "1,234,567" is 7 * 556 + 2 * 278 =
 * 4448/1000 * 9pt = 40.03pt, and weight 8 bought only 38.08pt — the layout
 * engine was clamping the value to the content box's LEFT edge and painting it
 * into the gutter. `name` is the only column with room to give: at 17 it still
 * buys 80.92pt against a 61.27pt "DESCRIPTION" header, whereas qty (44.20pt
 * header), out (65.26pt header), unit ($1,234,567.89 = 57.55pt) and total (the
 * same with a minus sign, 60.54pt) are each within one weight unit of their own
 * worst case. `sku` keeps its 19 because the SKU now WRAPS (see
 * SKU_CHARS_PER_LINE) — narrowing it would only cost extra lines, never data.
 */
export const PO_COLS = {
  num: 5,
  sku: 19,
  name: 17,
  qty: 10,
  recv: 9,
  out: 14,
  unit: 13,
  total: 13,
} as const;

/**
 * Column layout for the receipts (receiving log) table. After the five 6pt
 * gutters the weights divide 494pt.
 *
 * `number` has to hold a 28-character Courier 8.5 receipt number (142.8pt);
 * at the old weight of 22 with no gutter it had 115.3pt, which is why the
 * number ran into the Date column. The width comes out of `date`, which was
 * carrying 26 units (136.2pt) for "May 30, 2026" — the widest date this
 * document can print — at 54.5pt. Slack is parked in `by` because
 * received_by_name is the only unbounded value here that breaks on spaces.
 */
export const RECEIPT_COLS = {
  number: 30,
  date: 13,
  by: 35,
  accepted: 11,
  rejected: 11,
} as const;

export function PurchaseOrderPdf({
  po,
  lines,
  charges = [],
  org,
  supplier,
  destination,
  receipts = [],
  billToCharter = null,
}: PurchaseOrderPdfProps) {
  const subtotal = Number(po.subtotal) || 0;
  const total = Number(po.total) || 0;
  const hasCharges = charges.length > 0;
  const chargesSum = charges.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
  // When explicit charges exist they are itemized as line rows AND rolled up in
  // the totals block, so the total reconciles as subtotal + charges. For POs
  // with NO charge rows (older/manual POs) fall back to the legacy derived
  // "Tax & shipping" / "Adjustments" split from (total − subtotal), so their
  // PDFs are unchanged.
  const rawAdjustment = total - subtotal;
  const taxAndShipping = !hasCharges && rawAdjustment > 0 ? rawAdjustment : 0;
  const negativeAdjustment = !hasCharges && rawAdjustment < 0 ? rawAdjustment : 0;
  // Defensive reconciliation: if the stored total doesn't equal subtotal +
  // itemized charges (data drift), surface the gap rather than print a total
  // that doesn't add up.
  const chargeResidual = hasCharges ? total - subtotal - chargesSum : 0;
  const isDraft = (po.status ?? '').toLowerCase() === 'draft';
  const terms = (org.poTerms ?? '').trim();
  const hasTerms = terms.length > 0;
  const truncatedNotes = po.notes ? truncate(po.notes, NOTES_MAX) : null;

  return (
    <Document title={`Purchase Order ${po.poNumber}`}>
      <Page size="LETTER" style={pdfStyles.page}>
        {/*
         * Watermark renders FIRST so it sits beneath every later sibling in
         * the page tree (siblings paint in order in @react-pdf). It's an
         * absolutely positioned overlay so it doesn't take up flow space.
         * 96pt + 10% opacity, rotated -30deg via the `transform` style —
         * confirmed supported by @react-pdf/render 4.5.x.
         */}
        {isDraft ? (
          <View style={pdfStyles.watermarkWrap} fixed>
            <Text style={pdfStyles.watermarkText}>DRAFT</Text>
          </View>
        ) : null}

        <BrandedHeader
          orgName={org.name}
          orgLogoUrl={org.logoUrl}
          title={`Purchase Order #${po.poNumber}`}
          subtitle={po.createdAt ? `Created ${formatDateForPdf(po.createdAt)}` : undefined}
          documentDate={new Date()}
        />

        <View style={[pdfStyles.section, pdfStyles.twoCol]}>
          <View style={pdfStyles.col}>
            <Text style={pdfStyles.sectionTitle}>Bill to</Text>
            <Text style={[pdfStyles.bold, pdfStyles.identityLine]}>{org.name}</Text>
            {/*
             * Bill-to charter (purchase_orders.charter_id) — the campus/entity
             * this PO is billed to. Renders its name, code, mailing address, and
             * contact beneath the org so the supplier sees who to invoice.
             */}
            {billToCharter ? (
              <>
                <Text style={[pdfStyles.bold, pdfStyles.identityLine]}>
                  {billToCharter.name}
                  {billToCharter.code ? ` (${billToCharter.code})` : ''}
                </Text>
                {billToCharter.addressLines.map((line, i) => (
                  <Text key={`bca-${i}`} style={[pdfStyles.muted, pdfStyles.identityLine]}>
                    {line}
                  </Text>
                ))}
                {billToCharter.contactName ? (
                  <Text style={[pdfStyles.muted, pdfStyles.identityLine]}>{billToCharter.contactName}</Text>
                ) : null}
                {billToCharter.contactEmail ? (
                  <Text style={[pdfStyles.muted, pdfStyles.identityLine]}>{billToCharter.contactEmail}</Text>
                ) : null}
                {billToCharter.contactPhone ? (
                  <Text style={[pdfStyles.muted, pdfStyles.identityLine]}>{billToCharter.contactPhone}</Text>
                ) : null}
              </>
            ) : null}
            {destination?.warehouseName ? (
              <Text style={[pdfStyles.muted, pdfStyles.identityLine]}>
                Ship to: {destination.warehouseName}
                {destination.locationName ? ` · ${destination.locationName}` : ''}
              </Text>
            ) : null}
          </View>
          <View style={pdfStyles.col}>
            <Text style={pdfStyles.sectionTitle}>Supplier</Text>
            {supplier ? (
              <>
                <Text style={[pdfStyles.bold, pdfStyles.identityLine]}>{supplier.name}</Text>
                {supplier.contactName ? (
                  <Text style={[pdfStyles.muted, pdfStyles.identityLine]}>{supplier.contactName}</Text>
                ) : null}
                {supplier.email ? (
                  <Text style={[pdfStyles.muted, pdfStyles.identityLine]}>{supplier.email}</Text>
                ) : null}
                {supplier.phone ? (
                  <Text style={[pdfStyles.muted, pdfStyles.identityLine]}>{supplier.phone}</Text>
                ) : null}
                {supplier.website ? (
                  <Text style={[pdfStyles.muted, pdfStyles.identityLine]}>{supplier.website}</Text>
                ) : null}
              </>
            ) : (
              <Text style={[pdfStyles.muted, pdfStyles.identityLine]}>No supplier assigned</Text>
            )}
          </View>
        </View>

        <View style={[pdfStyles.section, pdfStyles.twoCol]}>
          <View style={pdfStyles.col}>
            <Text style={pdfStyles.sectionTitle}>Status</Text>
            <Text>{po.status}</Text>
          </View>
          <View style={pdfStyles.col}>
            <Text style={pdfStyles.sectionTitle}>Expected delivery</Text>
            {/*
             * 'UTC' is deliberate and is NOT a missing org-timezone thread.
             * expected_at is a CALENDAR DATE, not an instant: the PO form
             * (components/po/po-form.tsx) and the import approval screens use
             * an <Input type="date"> whose 'YYYY-MM-DD' value goes through
             * `new Date(v).toISOString()`, and ECMAScript parses a date-only
             * string as UTC — so the column holds midnight UTC of the day the
             * buyer typed. formatDateForPdf's default zone
             * (America/Los_Angeles) walks that back 7-8 hours into the
             * PREVIOUS day, so a PO expected 2026-09-10 printed
             * "Sep 09, 2026" on the copy staff forward to the supplier, while
             * the edit form (which slices the UTC date back out) still showed
             * 09/10 — nobody could see why the supplier got the wrong day.
             * Reading it back in UTC returns the typed day unchanged.
             *
             * createdAt (BrandedHeader subtitle) and receipt receivedAt are
             * server-stamped INSTANTS and correctly stay on the org clock —
             * do not "consistency"-convert them to UTC.
             */}
            <Text>{formatDateForPdf(po.expectedAt, 'UTC')}</Text>
          </View>
        </View>

        {truncatedNotes ? (
          <View style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>Notes</Text>
            <Text style={pdfStyles.muted}>{truncatedNotes}</Text>
          </View>
        ) : null}

        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>Line items</Text>
          <View style={pdfStyles.table}>
            <View style={pdfStyles.tHeadRow} fixed>
              <Text style={[pdfStyles.tHeadCell, poTable.cellGutter, { flex: PO_COLS.num }]}>#</Text>
              <Text style={[pdfStyles.tHeadCell, poTable.cellGutter, { flex: PO_COLS.sku }]}>SKU</Text>
              <Text style={[pdfStyles.tHeadCell, poTable.cellGutter, { flex: PO_COLS.name }]}>
                Description
              </Text>
              <Text
                style={[pdfStyles.tHeadCell, pdfStyles.tRight, poTable.cellGutterRight, { flex: PO_COLS.qty }]}
              >
                Ordered
              </Text>
              <Text
                style={[pdfStyles.tHeadCell, pdfStyles.tRight, poTable.cellGutterRight, { flex: PO_COLS.recv }]}
              >
                Recv
              </Text>
              <Text
                style={[pdfStyles.tHeadCell, pdfStyles.tRight, poTable.cellGutterRight, { flex: PO_COLS.out }]}
              >
                Outstanding
              </Text>
              <Text
                style={[pdfStyles.tHeadCell, pdfStyles.tRight, poTable.cellGutterRight, { flex: PO_COLS.unit }]}
              >
                Unit cost
              </Text>
              <Text
                style={[pdfStyles.tHeadCell, pdfStyles.tRight, poTable.cellGutterRight, { flex: PO_COLS.total }]}
              >
                Line total
              </Text>
            </View>
            {lines.length === 0 && charges.length === 0 ? (
              <View style={pdfStyles.tRow}>
                <Text style={[pdfStyles.tCell, pdfStyles.muted, { flex: 1 }]}>
                  No line items.
                </Text>
              </View>
            ) : (
              <>
                {lines.map((l, i) => (
                // No `wrap={false}` here: long descriptions are pre-
                // truncated above, but if a single name still wraps onto
                // 2 lines we'd rather page-break the row than overflow
                // the page bottom.
                <View

                  key={`${l.sku}-${i}`}
                  style={pdfStyles.tRow}
                >
                  <Text style={[pdfStyles.tCell, pdfStyles.muted, poTable.cellGutter, { flex: PO_COLS.num }]}>
                    {i + 1}
                  </Text>
                  {/*
                   * SKUs have no spaces, so an over-long one cannot wrap on its
                   * own — it would paint over the description. It is split here
                   * into SKU_CHARS_PER_LINE-character lines instead of being
                   * truncated: the supplier orders against this identifier, and
                   * the disambiguating suffix is at the END, so dropping
                   * characters is worse than the overflow. The stack costs row
                   * height; the value stays complete and searchable in the
                   * text layer.
                   */}
                  <View style={[poTable.cellGutter, { flex: PO_COLS.sku }]}>
                    {l.sku ? (
                      wrapSku(l.sku).map((chunk, ci) => (
                        <Text key={`sku-${ci}`} style={[pdfStyles.tCell, pdfStyles.tCellMono]}>
                          {chunk}
                        </Text>
                      ))
                    ) : (
                      <Text style={[pdfStyles.tCell, pdfStyles.tCellMono]}>—</Text>
                    )}
                  </View>
                  <Text style={[pdfStyles.tCell, poTable.cellGutter, { flex: PO_COLS.name }]}>
                    {truncate(l.name, DESCRIPTION_MAX)}
                  </Text>
                  <Text
                    style={[pdfStyles.tCell, pdfStyles.tRight, poTable.cellGutterRight, { flex: PO_COLS.qty }]}
                  >
                    {formatNumberForPdf(l.quantityOrdered)}
                  </Text>
                  <Text
                    style={[pdfStyles.tCell, pdfStyles.tRight, poTable.cellGutterRight, { flex: PO_COLS.recv }]}
                  >
                    {formatNumberForPdf(l.quantityReceived)}
                  </Text>
                  {/*
                   * Outstanding = still-owed quantity (ordered − received),
                   * clamped at 0 so an over-receipt never prints a negative.
                   * Bolded while > 0 so a partially-received PO clearly shows
                   * what's still on the way; reads 0 once fully received.
                   */}
                  <Text
                    style={[
                      pdfStyles.tCell,
                      pdfStyles.tRight,
                      poTable.cellGutterRight,
                      Math.max(0, l.quantityOrdered - l.quantityReceived) > 0 ? pdfStyles.bold : pdfStyles.muted,
                      { flex: PO_COLS.out },
                    ]}
                  >
                    {formatNumberForPdf(Math.max(0, l.quantityOrdered - l.quantityReceived))}
                  </Text>
                  <Text
                    style={[pdfStyles.tCell, pdfStyles.tRight, poTable.cellGutterRight, { flex: PO_COLS.unit }]}
                  >
                    {formatCurrencyForPdf(l.unitCost)}
                  </Text>
                  <Text
                    style={[pdfStyles.tCell, pdfStyles.tRight, poTable.cellGutterRight, { flex: PO_COLS.total }]}
                  >
                    {formatCurrencyForPdf(l.lineTotal)}
                  </Text>
                </View>
                ))}
                {/*
                 * Financial-only charges (tax / freight / White Glove service /
                 * e-waste fee / discount) render as line rows in the SAME table,
                 * but with a dash for SKU and the receiving columns — they never
                 * become stock, so there is nothing to receive. Numbering
                 * continues after the inventory lines.
                 */}
                {charges.map((c, ci) => {
                  // Only show "qty @ unit cost" when it actually foots to the
                  // line amount (so a discount — qty 5 × $10 but a −$50 total —
                  // renders as a flat −$50 instead of a row that doesn't add up).
                  const foots =
                    c.quantity != null &&
                    c.unitCost != null &&
                    Math.abs(c.quantity * c.unitCost - c.amount) < 0.005;
                  return (
                    <View key={`charge-${ci}`} style={pdfStyles.tRow}>
                      <Text
                        style={[pdfStyles.tCell, pdfStyles.muted, poTable.cellGutter, { flex: PO_COLS.num }]}
                      >
                        {lines.length + ci + 1}
                      </Text>
                      <Text
                        style={[
                          pdfStyles.tCell,
                          pdfStyles.tCellMono,
                          pdfStyles.muted,
                          poTable.cellGutter,
                          { flex: PO_COLS.sku },
                        ]}
                      >
                        —
                      </Text>
                      <Text style={[pdfStyles.tCell, poTable.cellGutter, { flex: PO_COLS.name }]}>
                        {truncate(c.label, DESCRIPTION_MAX)}
                      </Text>
                      <Text
                        style={[pdfStyles.tCell, pdfStyles.tRight, poTable.cellGutterRight, { flex: PO_COLS.qty }]}
                      >
                        {foots ? formatNumberForPdf(c.quantity as number) : '—'}
                      </Text>
                      <Text
                        style={[
                          pdfStyles.tCell,
                          pdfStyles.tRight,
                          pdfStyles.muted,
                          poTable.cellGutterRight,
                          { flex: PO_COLS.recv },
                        ]}
                      >
                        —
                      </Text>
                      <Text
                        style={[
                          pdfStyles.tCell,
                          pdfStyles.tRight,
                          pdfStyles.muted,
                          poTable.cellGutterRight,
                          { flex: PO_COLS.out },
                        ]}
                      >
                        —
                      </Text>
                      <Text
                        style={[pdfStyles.tCell, pdfStyles.tRight, poTable.cellGutterRight, { flex: PO_COLS.unit }]}
                      >
                        {foots ? formatCurrencyForPdf(c.unitCost as number) : '—'}
                      </Text>
                      <Text
                        style={[pdfStyles.tCell, pdfStyles.tRight, poTable.cellGutterRight, { flex: PO_COLS.total }]}
                      >
                        {formatCurrencyForPdf(c.amount)}
                      </Text>
                    </View>
                  );
                })}
              </>
            )}
          </View>
        </View>

        <View style={pdfStyles.totalsWrap} wrap={false}>
          <View style={pdfStyles.totalsBox}>
            <View style={pdfStyles.totalsRow}>
              <Text style={pdfStyles.totalsLabel}>Subtotal</Text>
              <Text style={pdfStyles.totalsValue}>{formatCurrencyForPdf(subtotal)}</Text>
            </View>
            {hasCharges ? (
              // Roll-up of the itemized charge rows above (Subtotal + Charges =
              // Total). The individual charges are the line rows in the table.
              <View style={pdfStyles.totalsRow}>
                <Text style={pdfStyles.totalsLabel}>Charges</Text>
                <Text style={pdfStyles.totalsValue}>{formatCurrencyForPdf(chargesSum)}</Text>
              </View>
            ) : null}
            {Math.abs(chargeResidual) >= 0.005 ? (
              // Not an anonymous "Other": if the stored total doesn't equal
              // subtotal + itemized charges, the number is unreconciled — name
              // it so a reader never mistakes a data-drift gap for a real charge.
              <View style={pdfStyles.totalsRow}>
                <Text style={pdfStyles.totalsLabel}>Unreconciled difference</Text>
                <Text style={pdfStyles.totalsValue}>{formatCurrencyForPdf(chargeResidual)}</Text>
              </View>
            ) : null}
            {taxAndShipping > 0 ? (
              <View style={pdfStyles.totalsRow}>
                <Text style={pdfStyles.totalsLabel}>Tax & shipping</Text>
                <Text style={pdfStyles.totalsValue}>
                  {formatCurrencyForPdf(taxAndShipping)}
                </Text>
              </View>
            ) : null}
            {negativeAdjustment < 0 ? (
              // Surface a sub-zero (total - subtotal) line explicitly so
              // discounts / overrides don't get camouflaged into the
              // "Tax & shipping" label. Render the value as-is — Intl
              // will prepend a minus sign for negative currencies.
              <View style={pdfStyles.totalsRow}>
                <Text style={pdfStyles.totalsLabel}>Adjustments</Text>
                <Text style={pdfStyles.totalsValue}>
                  {formatCurrencyForPdf(negativeAdjustment)}
                </Text>
              </View>
            ) : null}
            <View style={pdfStyles.totalsRowFinal}>
              <Text>Total</Text>
              <Text>{formatCurrencyForPdf(total)}</Text>
            </View>
          </View>
        </View>

        {receipts.length > 0 ? (
          <View style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>Receipts</Text>
            <View style={pdfStyles.table}>
              <View style={pdfStyles.tHeadRow} fixed>
                <Text style={[pdfStyles.tHeadCell, poTable.cellGutter, { flex: RECEIPT_COLS.number }]}>
                  Receipt
                </Text>
                <Text style={[pdfStyles.tHeadCell, poTable.cellGutter, { flex: RECEIPT_COLS.date }]}>
                  Date
                </Text>
                <Text style={[pdfStyles.tHeadCell, poTable.cellGutter, { flex: RECEIPT_COLS.by }]}>
                  Received by
                </Text>
                <Text
                  style={[
                    pdfStyles.tHeadCell,
                    pdfStyles.tRight,
                    poTable.cellGutterRight,
                    { flex: RECEIPT_COLS.accepted },
                  ]}
                >
                  Accepted
                </Text>
                <Text
                  style={[
                    pdfStyles.tHeadCell,
                    pdfStyles.tRight,
                    poTable.cellGutterRight,
                    { flex: RECEIPT_COLS.rejected },
                  ]}
                >
                  Rejected
                </Text>
              </View>
              {receipts.map((r, i) => (
                <View key={`${r.receiptNumber}-${i}`}>
                  <View style={pdfStyles.tRow}>
                  {/*
                   * Two-line stack, not a run. The status used to be appended
                   * into this same mono <Text>, which made the worst case
                   * "R-…-REV (reversal)" — 39 Courier characters, wider than
                   * any column a LETTER page can afford. On its own line the
                   * mono width stays bounded by RECEIPT_NUMBER_MAX_CHARS, and
                   * only the rare non-posted row gains any height.
                   */}
                  <View style={[poTable.receiptNumberCell, { flex: RECEIPT_COLS.number }]}>
                    <Text style={[pdfStyles.tCell, pdfStyles.tCellMono]}>{r.receiptNumber}</Text>
                    {r.status && r.status !== 'posted' ? (
                      <Text style={poTable.receiptStatus}>{r.status}</Text>
                    ) : null}
                  </View>
                  <Text style={[pdfStyles.tCell, poTable.cellGutter, { flex: RECEIPT_COLS.date }]}>
                    {formatDateForPdf(r.receivedAt)}
                  </Text>
                  {/*
                   * received_by_name falls back to an email address, which has
                   * no spaces and therefore cannot wrap. Cap it at what this
                   * column can paint rather than let it run into Accepted.
                   */}
                  <Text style={[pdfStyles.tCell, poTable.cellGutter, { flex: RECEIPT_COLS.by }]}>
                    {r.receivedByName ? truncate(r.receivedByName, RECEIVED_BY_MAX) : '—'}
                  </Text>
                  <Text
                    style={[
                      pdfStyles.tCell,
                      pdfStyles.tRight,
                      poTable.cellGutterRight,
                      { flex: RECEIPT_COLS.accepted },
                    ]}
                  >
                    {formatNumberForPdf(r.totalAccepted)}
                  </Text>
                  <Text
                    style={[
                      pdfStyles.tCell,
                      pdfStyles.tRight,
                      poTable.cellGutterRight,
                      { flex: RECEIPT_COLS.rejected },
                    ]}
                  >
                    {formatNumberForPdf(r.totalRejected)}
                  </Text>
                  </View>
                  {(r.lines ?? []).map((rl, li) => (
                    <View key={`${r.receiptNumber}-line-${li}`} style={poTable.receiptItemRow}>
                      {/* Name + sku span the number/date/by columns so the
                          quantities land under the same Accepted/Rejected
                          headings as the receipt totals above them. */}
                      <View
                        style={[
                          poTable.cellGutter,
                          { flex: RECEIPT_COLS.number + RECEIPT_COLS.date + RECEIPT_COLS.by },
                        ]}
                      >
                        <Text style={pdfStyles.tCell}>
                          {truncate(rl.name, RECEIPT_ITEM_NAME_MAX)}
                          {rl.sku ? '  ' : ''}
                          {rl.sku ? <Text style={poTable.receiptItemSku}>{rl.sku}</Text> : null}
                        </Text>
                      </View>
                      <Text
                        style={[
                          pdfStyles.tCell,
                          pdfStyles.tRight,
                          poTable.cellGutterRight,
                          { flex: RECEIPT_COLS.accepted },
                        ]}
                      >
                        {formatNumberForPdf(rl.accepted)}
                      </Text>
                      <Text
                        style={[
                          pdfStyles.tCell,
                          pdfStyles.tRight,
                          poTable.cellGutterRight,
                          { flex: RECEIPT_COLS.rejected },
                        ]}
                      >
                        {formatNumberForPdf(rl.rejected)}
                      </Text>
                    </View>
                  ))}
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {hasTerms ? (
          <View style={pdfStyles.termsWrap} wrap={false}>
            <Text style={pdfStyles.termsHeading}>Terms & conditions</Text>
            {/*
             * pre-wrap preserves user-entered line breaks while still
             * letting @react-pdf wrap long paragraphs at the column edge.
             */}
            <Text style={pdfStyles.termsBody}>{terms}</Text>
          </View>
        ) : null}

        {/*
         * Signature block — two side-by-side lines. Sits below the terms
         * (when present) or below the totals box. wrap={false} keeps the
         * two columns on the same page.
         */}
        {/* Signature block removed 2026-07-10 (owner request — POs don't need
            the authorized-by / accepted-by sign-off lines). */}

        <View style={pdfStyles.footer} fixed>
          <Text>{org.name} · Generated by StockPilot</Text>
          <Text
            style={pdfStyles.pageNumber}
            render={({ pageNumber, totalPages }) =>
              `Page ${pageNumber} of ${totalPages}`
            }
          />
        </View>

        {/* Belt-and-suspenders: keep the linter quiet about PDF_COLORS being
            "imported but not used" if the totals colorway is later dropped. */}
        {PDF_COLORS ? null : null}
      </Page>
    </Document>
  );
}

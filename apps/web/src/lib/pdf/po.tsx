import { Document, Page, Text, View } from '@react-pdf/renderer';

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

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

export interface PoPdfLine {
  sku: string;
  name: string;
  quantityOrdered: number;
  /** Cumulative quantity received against this line (post_receipt increments). */
  quantityReceived: number;
  unitCost: number;
  lineTotal: number;
}

export interface PoPdfReceipt {
  receiptNumber: string;
  receivedAt: string | null;
  receivedByName: string | null;
  status: string;
  totalAccepted: number;
  totalRejected: number;
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

// Fixed-width column layout for the PO line table. Sum to ~100 so flex
// widths translate cleanly to the available row.
const PO_COLS = {
  num: 4,
  sku: 14,
  name: 26,
  qty: 9,
  recv: 9,
  out: 11,
  unit: 13,
  total: 14,
} as const;

// Column layout for the receipts (receiving log) table.
const RECEIPT_COLS = {
  number: 22,
  date: 26,
  by: 24,
  accepted: 14,
  rejected: 14,
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
            <Text style={pdfStyles.bold}>{org.name}</Text>
            {/*
             * Bill-to charter (purchase_orders.charter_id) — the campus/entity
             * this PO is billed to. Renders its name, code, mailing address, and
             * contact beneath the org so the supplier sees who to invoice.
             */}
            {billToCharter ? (
              <>
                <Text style={pdfStyles.bold}>
                  {billToCharter.name}
                  {billToCharter.code ? ` (${billToCharter.code})` : ''}
                </Text>
                {billToCharter.addressLines.map((line, i) => (
                  <Text key={`bca-${i}`} style={pdfStyles.muted}>
                    {line}
                  </Text>
                ))}
                {billToCharter.contactName ? (
                  <Text style={pdfStyles.muted}>{billToCharter.contactName}</Text>
                ) : null}
                {billToCharter.contactEmail ? (
                  <Text style={pdfStyles.muted}>{billToCharter.contactEmail}</Text>
                ) : null}
                {billToCharter.contactPhone ? (
                  <Text style={pdfStyles.muted}>{billToCharter.contactPhone}</Text>
                ) : null}
              </>
            ) : null}
            {destination?.warehouseName ? (
              <Text style={pdfStyles.muted}>
                Ship to: {destination.warehouseName}
                {destination.locationName ? ` · ${destination.locationName}` : ''}
              </Text>
            ) : null}
          </View>
          <View style={pdfStyles.col}>
            <Text style={pdfStyles.sectionTitle}>Supplier</Text>
            {supplier ? (
              <>
                <Text style={pdfStyles.bold}>{supplier.name}</Text>
                {supplier.contactName ? (
                  <Text style={pdfStyles.muted}>{supplier.contactName}</Text>
                ) : null}
                {supplier.email ? (
                  <Text style={pdfStyles.muted}>{supplier.email}</Text>
                ) : null}
                {supplier.phone ? (
                  <Text style={pdfStyles.muted}>{supplier.phone}</Text>
                ) : null}
                {supplier.website ? (
                  <Text style={pdfStyles.muted}>{supplier.website}</Text>
                ) : null}
              </>
            ) : (
              <Text style={pdfStyles.muted}>No supplier assigned</Text>
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
            <Text>{formatDateForPdf(po.expectedAt)}</Text>
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
              <Text style={[pdfStyles.tHeadCell, { flex: PO_COLS.num }]}>#</Text>
              <Text style={[pdfStyles.tHeadCell, { flex: PO_COLS.sku }]}>SKU</Text>
              <Text style={[pdfStyles.tHeadCell, { flex: PO_COLS.name }]}>Description</Text>
              <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: PO_COLS.qty }]}>Ordered</Text>
              <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: PO_COLS.recv }]}>Recv</Text>
              <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: PO_COLS.out }]}>
                Outstanding
              </Text>
              <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: PO_COLS.unit }]}>
                Unit cost
              </Text>
              <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: PO_COLS.total }]}>
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
                  <Text style={[pdfStyles.tCell, pdfStyles.muted, { flex: PO_COLS.num }]}>
                    {i + 1}
                  </Text>
                  <Text style={[pdfStyles.tCell, pdfStyles.tCellMono, { flex: PO_COLS.sku }]}>
                    {l.sku || '—'}
                  </Text>
                  <Text style={[pdfStyles.tCell, { flex: PO_COLS.name }]}>
                    {truncate(l.name, DESCRIPTION_MAX)}
                  </Text>
                  <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: PO_COLS.qty }]}>
                    {formatNumberForPdf(l.quantityOrdered)}
                  </Text>
                  <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: PO_COLS.recv }]}>
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
                      Math.max(0, l.quantityOrdered - l.quantityReceived) > 0 ? pdfStyles.bold : pdfStyles.muted,
                      { flex: PO_COLS.out },
                    ]}
                  >
                    {formatNumberForPdf(Math.max(0, l.quantityOrdered - l.quantityReceived))}
                  </Text>
                  <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: PO_COLS.unit }]}>
                    {formatCurrencyForPdf(l.unitCost)}
                  </Text>
                  <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: PO_COLS.total }]}>
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
                {charges.map((c, ci) => (
                  <View key={`charge-${ci}`} style={pdfStyles.tRow}>
                    <Text style={[pdfStyles.tCell, pdfStyles.muted, { flex: PO_COLS.num }]}>
                      {lines.length + ci + 1}
                    </Text>
                    <Text
                      style={[pdfStyles.tCell, pdfStyles.tCellMono, pdfStyles.muted, { flex: PO_COLS.sku }]}
                    >
                      —
                    </Text>
                    <Text style={[pdfStyles.tCell, { flex: PO_COLS.name }]}>
                      {truncate(c.label, DESCRIPTION_MAX)}
                    </Text>
                    <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: PO_COLS.qty }]}>
                      {c.quantity != null ? formatNumberForPdf(c.quantity) : '—'}
                    </Text>
                    <Text
                      style={[pdfStyles.tCell, pdfStyles.tRight, pdfStyles.muted, { flex: PO_COLS.recv }]}
                    >
                      —
                    </Text>
                    <Text
                      style={[pdfStyles.tCell, pdfStyles.tRight, pdfStyles.muted, { flex: PO_COLS.out }]}
                    >
                      —
                    </Text>
                    <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: PO_COLS.unit }]}>
                      {c.unitCost != null ? formatCurrencyForPdf(c.unitCost) : '—'}
                    </Text>
                    <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: PO_COLS.total }]}>
                      {formatCurrencyForPdf(c.amount)}
                    </Text>
                  </View>
                ))}
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
              <View style={pdfStyles.totalsRow}>
                <Text style={pdfStyles.totalsLabel}>Other</Text>
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
                <Text style={[pdfStyles.tHeadCell, { flex: RECEIPT_COLS.number }]}>Receipt</Text>
                <Text style={[pdfStyles.tHeadCell, { flex: RECEIPT_COLS.date }]}>Date</Text>
                <Text style={[pdfStyles.tHeadCell, { flex: RECEIPT_COLS.by }]}>Received by</Text>
                <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: RECEIPT_COLS.accepted }]}>
                  Accepted
                </Text>
                <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: RECEIPT_COLS.rejected }]}>
                  Rejected
                </Text>
              </View>
              {receipts.map((r, i) => (
                <View key={`${r.receiptNumber}-${i}`} style={pdfStyles.tRow}>
                  <Text style={[pdfStyles.tCell, pdfStyles.tCellMono, { flex: RECEIPT_COLS.number }]}>
                    {r.receiptNumber}
                    {r.status && r.status !== 'posted' ? ` (${r.status})` : ''}
                  </Text>
                  <Text style={[pdfStyles.tCell, { flex: RECEIPT_COLS.date }]}>
                    {formatDateForPdf(r.receivedAt)}
                  </Text>
                  <Text style={[pdfStyles.tCell, { flex: RECEIPT_COLS.by }]}>
                    {r.receivedByName ?? '—'}
                  </Text>
                  <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: RECEIPT_COLS.accepted }]}>
                    {formatNumberForPdf(r.totalAccepted)}
                  </Text>
                  <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: RECEIPT_COLS.rejected }]}>
                    {formatNumberForPdf(r.totalRejected)}
                  </Text>
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
        <View style={pdfStyles.signatureWrap} wrap={false}>
          <View style={pdfStyles.signatureCol}>
            <Text style={pdfStyles.signatureCaption}>
              Authorized by (StockPilot)
            </Text>
            <View style={pdfStyles.signatureLine} />
            <View style={pdfStyles.signatureMetaRow}>
              <Text style={pdfStyles.signatureMeta}>Name: ____________________</Text>
              <Text style={pdfStyles.signatureMeta}>Date: __________</Text>
            </View>
          </View>
          <View style={pdfStyles.signatureCol}>
            <Text style={pdfStyles.signatureCaption}>
              Accepted by (Supplier)
            </Text>
            <View style={pdfStyles.signatureLine} />
            <View style={pdfStyles.signatureMetaRow}>
              <Text style={pdfStyles.signatureMeta}>Name: ____________________</Text>
              <Text style={pdfStyles.signatureMeta}>Date: __________</Text>
            </View>
          </View>
        </View>

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

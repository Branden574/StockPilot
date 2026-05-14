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
  unitCost: number;
  lineTotal: number;
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

interface PurchaseOrderPdfProps {
  po: PoPdfHeader;
  lines: PoPdfLine[];
  org: PoPdfOrg;
  supplier: PoPdfSupplier | null;
  destination: PoPdfDestination | null;
}

// Fixed-width column layout for the PO line table. Sum to ~100 so flex
// widths translate cleanly to the available row.
const PO_COLS = {
  num: 5,
  sku: 18,
  name: 39,
  qty: 10,
  unit: 14,
  total: 14,
} as const;

export function PurchaseOrderPdf({
  po,
  lines,
  org,
  supplier,
  destination,
}: PurchaseOrderPdfProps) {
  const subtotal = Number(po.subtotal) || 0;
  const total = Number(po.total) || 0;
  const rawAdjustment = total - subtotal;
  // Tax + shipping is rendered as a positive surcharge line. Negative
  // adjustments (discounts, returns netted into the total) are shown
  // separately as "Adjustments" so the reader doesn't see a
  // "-$25.00" tucked into a label that says "Tax & shipping".
  const taxAndShipping = rawAdjustment > 0 ? rawAdjustment : 0;
  const negativeAdjustment = rawAdjustment < 0 ? rawAdjustment : 0;
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
              <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: PO_COLS.qty }]}>Qty</Text>
              <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: PO_COLS.unit }]}>
                Unit cost
              </Text>
              <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: PO_COLS.total }]}>
                Line total
              </Text>
            </View>
            {lines.length === 0 ? (
              <View style={pdfStyles.tRow}>
                <Text style={[pdfStyles.tCell, pdfStyles.muted, { flex: 1 }]}>
                  No line items.
                </Text>
              </View>
            ) : (
              lines.map((l, i) => (
                // No `wrap={false}` here: long descriptions are pre-
                // truncated above, but if a single name still wraps onto
                // 2 lines we'd rather page-break the row than overflow
                // the page bottom.
                <View
                  // eslint-disable-next-line react/no-array-index-key
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
                  <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: PO_COLS.unit }]}>
                    {formatCurrencyForPdf(l.unitCost)}
                  </Text>
                  <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: PO_COLS.total }]}>
                    {formatCurrencyForPdf(l.lineTotal)}
                  </Text>
                </View>
              ))
            )}
          </View>
        </View>

        <View style={pdfStyles.totalsWrap} wrap={false}>
          <View style={pdfStyles.totalsBox}>
            <View style={pdfStyles.totalsRow}>
              <Text style={pdfStyles.totalsLabel}>Subtotal</Text>
              <Text style={pdfStyles.totalsValue}>{formatCurrencyForPdf(subtotal)}</Text>
            </View>
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

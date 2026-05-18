import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import { BrandedHeader } from './branding';
import {
  formatCurrencyForPdf,
  formatDateForPdf,
  formatNumberForPdf,
  pdfStyles,
  PDF_COLORS,
} from './styles';

export interface SnapshotPdfRow {
  /** Internal — used by the route to attach imageDataUri after the
   *  row is built. Not rendered. */
  itemId?: string;
  sku: string;
  name: string;
  categoryName: string | null;
  /** Optional bin / primary-location label. Free-form. */
  location: string | null;
  quantityOnHand: number;
  unitCost: number;
  value: number;
  /** Optional pre-fetched data: URI for the item's primary thumb.
   *  Rows without an image render a placeholder square so column
   *  alignment stays consistent across pages. */
  imageDataUri?: string | null;
}

export interface SnapshotPdfWarehouseGroup {
  warehouseName: string;
  rows: SnapshotPdfRow[];
  subtotalUnits: number;
  subtotalValue: number;
}

export interface SnapshotPdfOrg {
  name: string;
  logoUrl: string | null;
}

interface InventorySnapshotPdfProps {
  org: SnapshotPdfOrg;
  groups: SnapshotPdfWarehouseGroup[];
  /** Org-wide totals across every group. */
  totals: { units: number; value: number; itemCount: number };
  /** ISO timestamp shown in the header / "as of" line. */
  asOf: string;
}

const SNAP_COLS = {
  sku: 16,
  name: 32,
  cat: 14,
  loc: 12,
  qty: 8,
  unit: 8,
  value: 10,
} as const;

const SNAP_IMAGE_WIDTH = 22; // pt

const snapImageStyles = StyleSheet.create({
  imageCell: {
    width: SNAP_IMAGE_WIDTH,
    marginRight: 4,
    flexShrink: 0,
  },
  thumb: {
    width: SNAP_IMAGE_WIDTH,
    height: SNAP_IMAGE_WIDTH,
    objectFit: 'cover',
    borderRadius: 2,
  },
  thumbPlaceholder: {
    width: SNAP_IMAGE_WIDTH,
    height: SNAP_IMAGE_WIDTH,
    backgroundColor: PDF_COLORS.bgSunk,
    borderRadius: 2,
    borderWidth: 0.5,
    borderColor: PDF_COLORS.line,
    borderStyle: 'solid',
  },
});

export function InventorySnapshotPdf({
  org,
  groups,
  totals,
  asOf,
}: InventorySnapshotPdfProps) {
  const generated = formatDateForPdf(asOf);
  const subtitle = `${org.name} · as of ${generated}`;
  return (
    <Document title="Inventory snapshot">
      <Page size="LETTER" orientation="landscape" style={pdfStyles.page}>
        <BrandedHeader
          orgName={org.name}
          orgLogoUrl={org.logoUrl}
          title="Inventory snapshot"
          subtitle={subtitle}
          documentDate={asOf}
        />

        <View style={[pdfStyles.section, pdfStyles.twoCol]}>
          <View style={pdfStyles.col}>
            <Text style={pdfStyles.sectionTitle}>Items</Text>
            <Text style={pdfStyles.bold}>{formatNumberForPdf(totals.itemCount)}</Text>
          </View>
          <View style={pdfStyles.col}>
            <Text style={pdfStyles.sectionTitle}>Units on hand</Text>
            <Text style={pdfStyles.bold}>{formatNumberForPdf(totals.units)}</Text>
          </View>
          <View style={pdfStyles.col}>
            <Text style={pdfStyles.sectionTitle}>Total value</Text>
            <Text style={pdfStyles.bold}>{formatCurrencyForPdf(totals.value)}</Text>
          </View>
        </View>

        {groups.length === 0 ? (
          <View style={pdfStyles.section}>
            <Text style={pdfStyles.muted}>No active inventory to report.</Text>
          </View>
        ) : (
          groups.map((g) => {
            // Render the image column for this warehouse only when at
            // least one row has a pre-fetched thumb. Orgs with zero
            // thumbnails get the previous look exactly (no orphan
            // empty column).
            const showImages = g.rows.some((r) => r.imageDataUri);
            return (
            <View key={g.warehouseName} style={pdfStyles.section}>
              <Text style={pdfStyles.sectionTitle}>
                Warehouse: {g.warehouseName}
              </Text>
              <View style={pdfStyles.table}>
                <View style={pdfStyles.tHeadRow} fixed>
                  {showImages ? (
                    <View style={snapImageStyles.imageCell} />
                  ) : null}
                  <Text style={[pdfStyles.tHeadCell, { flex: SNAP_COLS.sku }]}>SKU</Text>
                  <Text style={[pdfStyles.tHeadCell, { flex: SNAP_COLS.name }]}>Name</Text>
                  <Text style={[pdfStyles.tHeadCell, { flex: SNAP_COLS.cat }]}>Category</Text>
                  <Text style={[pdfStyles.tHeadCell, { flex: SNAP_COLS.loc }]}>Location</Text>
                  <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: SNAP_COLS.qty }]}>
                    On hand
                  </Text>
                  <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: SNAP_COLS.unit }]}>
                    Unit cost
                  </Text>
                  <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: SNAP_COLS.value }]}>
                    Value
                  </Text>
                </View>
                {g.rows.length === 0 ? (
                  <View style={pdfStyles.tRow}>
                    <Text style={[pdfStyles.tCell, pdfStyles.muted, { flex: 1 }]}>
                      No items in this warehouse.
                    </Text>
                  </View>
                ) : (
                  g.rows.map((r, i) => (
                    <View

                      key={`${r.sku}-${i}`}
                      style={pdfStyles.tRow}
                      wrap={false}
                    >
                      {showImages ? (
                        <View style={snapImageStyles.imageCell}>
                          {r.imageDataUri ? (
                            // eslint-disable-next-line jsx-a11y/alt-text
                            <Image src={r.imageDataUri} style={snapImageStyles.thumb} />
                          ) : (
                            <View style={snapImageStyles.thumbPlaceholder} />
                          )}
                        </View>
                      ) : null}
                      <Text style={[pdfStyles.tCell, pdfStyles.tCellMono, { flex: SNAP_COLS.sku }]}>
                        {r.sku || '—'}
                      </Text>
                      <Text style={[pdfStyles.tCell, { flex: SNAP_COLS.name }]}>{r.name}</Text>
                      <Text style={[pdfStyles.tCell, pdfStyles.muted, { flex: SNAP_COLS.cat }]}>
                        {r.categoryName ?? '—'}
                      </Text>
                      <Text style={[pdfStyles.tCell, pdfStyles.muted, { flex: SNAP_COLS.loc }]}>
                        {r.location ?? '—'}
                      </Text>
                      <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: SNAP_COLS.qty }]}>
                        {formatNumberForPdf(r.quantityOnHand)}
                      </Text>
                      <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: SNAP_COLS.unit }]}>
                        {formatCurrencyForPdf(r.unitCost)}
                      </Text>
                      <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: SNAP_COLS.value }]}>
                        {formatCurrencyForPdf(r.value)}
                      </Text>
                    </View>
                  ))
                )}
              </View>
              <View
                style={[pdfStyles.tHeadRow, { backgroundColor: pdfStyles.page.backgroundColor }]}
                wrap={false}
              >
                {showImages ? (
                  <View style={snapImageStyles.imageCell} />
                ) : null}
                <Text style={[pdfStyles.tCell, pdfStyles.bold, { flex: SNAP_COLS.sku + SNAP_COLS.name + SNAP_COLS.cat + SNAP_COLS.loc }]}>
                  Subtotal · {g.warehouseName}
                </Text>
                <Text style={[pdfStyles.tCell, pdfStyles.bold, pdfStyles.tRight, { flex: SNAP_COLS.qty }]}>
                  {formatNumberForPdf(g.subtotalUnits)}
                </Text>
                <Text style={[pdfStyles.tCell, pdfStyles.bold, pdfStyles.tRight, { flex: SNAP_COLS.unit }]} />
                <Text style={[pdfStyles.tCell, pdfStyles.bold, pdfStyles.tRight, { flex: SNAP_COLS.value }]}>
                  {formatCurrencyForPdf(g.subtotalValue)}
                </Text>
              </View>
            </View>
            );
          })
        )}

        <View style={pdfStyles.totalsWrap} wrap={false}>
          <View style={pdfStyles.totalsBox}>
            <View style={pdfStyles.totalsRow}>
              <Text style={pdfStyles.totalsLabel}>Total units</Text>
              <Text style={pdfStyles.totalsValue}>
                {formatNumberForPdf(totals.units)}
              </Text>
            </View>
            <View style={pdfStyles.totalsRowFinal}>
              <Text>Total value</Text>
              <Text>{formatCurrencyForPdf(totals.value)}</Text>
            </View>
          </View>
        </View>

        <View style={pdfStyles.footer} fixed>
          <Text>{org.name} · Inventory snapshot · {generated}</Text>
          <Text
            style={pdfStyles.pageNumber}
            render={({ pageNumber, totalPages }) =>
              `Page ${pageNumber} of ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}

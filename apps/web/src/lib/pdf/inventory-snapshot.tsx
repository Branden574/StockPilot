import { Document, Page, Text, View } from '@react-pdf/renderer';

import { BrandedHeader } from './branding';
import {
  formatCurrencyForPdf,
  formatDateForPdf,
  formatNumberForPdf,
  pdfStyles,
} from './styles';

export interface SnapshotPdfRow {
  sku: string;
  name: string;
  categoryName: string | null;
  /** Optional bin / primary-location label. Free-form. */
  location: string | null;
  quantityOnHand: number;
  unitCost: number;
  value: number;
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
          groups.map((g) => (
            <View key={g.warehouseName} style={pdfStyles.section}>
              <Text style={pdfStyles.sectionTitle}>
                Warehouse: {g.warehouseName}
              </Text>
              <View style={pdfStyles.table}>
                <View style={pdfStyles.tHeadRow} fixed>
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
                      // eslint-disable-next-line react/no-array-index-key
                      key={`${r.sku}-${i}`}
                      style={pdfStyles.tRow}
                      wrap={false}
                    >
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
          ))
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

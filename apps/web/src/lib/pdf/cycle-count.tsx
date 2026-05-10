import { Document, Page, Text, View } from '@react-pdf/renderer';

import { BrandedHeader } from './branding';
import { PDF_COLORS, formatDateForPdf, pdfStyles } from './styles';

export interface CycleCountPdfLine {
  sku: string;
  name: string;
  unitOfMeasure: string;
  /** Optional bin / location label. Free-form. */
  location: string | null;
  expectedQuantity: number;
}

export interface CycleCountPdfHeader {
  id: string;
  warehouseName: string | null;
  notes: string | null;
  startedAt: string | null;
  status: string;
}

export interface CycleCountPdfOrg {
  name: string;
  logoUrl: string | null;
}

interface CycleCountSheetPdfProps {
  cycle: CycleCountPdfHeader;
  lines: CycleCountPdfLine[];
  org: CycleCountPdfOrg;
}

const CC_COLS = {
  num: 5,
  sku: 18,
  name: 31,
  loc: 14,
  sysQty: 9,
  countQty: 11,
  notes: 12,
} as const;

export function CycleCountSheetPdf({
  cycle,
  lines,
  org,
}: CycleCountSheetPdfProps) {
  const idShort = cycle.id.slice(0, 8);
  const subtitle =
    [cycle.warehouseName ?? 'All warehouses', formatDateForPdf(cycle.startedAt)]
      .filter(Boolean)
      .join(' · ');

  return (
    <Document title={`Cycle count ${idShort}`}>
      <Page size="LETTER" style={pdfStyles.page}>
        <BrandedHeader
          orgName={org.name}
          orgLogoUrl={org.logoUrl}
          title={`Cycle count #${idShort}`}
          subtitle={subtitle}
          documentDate={new Date()}
        />

        {cycle.notes ? (
          <View style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>Notes</Text>
            <Text style={pdfStyles.muted}>{cycle.notes}</Text>
          </View>
        ) : null}

        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>
            Items to count · {lines.length}
          </Text>
          <View style={pdfStyles.table}>
            <View style={pdfStyles.tHeadRow} fixed>
              <Text style={[pdfStyles.tHeadCell, { flex: CC_COLS.num }]}>#</Text>
              <Text style={[pdfStyles.tHeadCell, { flex: CC_COLS.sku }]}>SKU</Text>
              <Text style={[pdfStyles.tHeadCell, { flex: CC_COLS.name }]}>Description</Text>
              <Text style={[pdfStyles.tHeadCell, { flex: CC_COLS.loc }]}>Location</Text>
              <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: CC_COLS.sysQty }]}>
                System
              </Text>
              <Text style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: CC_COLS.countQty }]}>
                Counted
              </Text>
              <Text style={[pdfStyles.tHeadCell, { flex: CC_COLS.notes }]}>Notes</Text>
            </View>
            {lines.length === 0 ? (
              <View style={pdfStyles.tRow}>
                <Text style={[pdfStyles.tCell, pdfStyles.muted, { flex: 1 }]}>
                  No items in this cycle count.
                </Text>
              </View>
            ) : (
              lines.map((l, i) => (
                <View
                  // eslint-disable-next-line react/no-array-index-key
                  key={`${l.sku}-${i}`}
                  style={[pdfStyles.tRow, { minHeight: 22 }]}
                  wrap={false}
                >
                  <Text style={[pdfStyles.tCell, pdfStyles.muted, { flex: CC_COLS.num }]}>
                    {i + 1}
                  </Text>
                  <Text style={[pdfStyles.tCell, pdfStyles.tCellMono, { flex: CC_COLS.sku }]}>
                    {l.sku || '—'}
                  </Text>
                  <Text style={[pdfStyles.tCell, { flex: CC_COLS.name }]}>{l.name}</Text>
                  <Text style={[pdfStyles.tCell, { flex: CC_COLS.loc }]}>{l.location ?? '—'}</Text>
                  <Text style={[pdfStyles.tCell, pdfStyles.tRight, { flex: CC_COLS.sysQty }]}>
                    {l.expectedQuantity}
                  </Text>
                  {/* Counted qty: deliberately blank — countee writes in pen.
                      The thin border + space is what the printed sheet needs. */}
                  <View
                    style={{
                      flex: CC_COLS.countQty,
                      borderBottomWidth: 0.5,
                      borderBottomColor: PDF_COLORS.lineStrong,
                      borderBottomStyle: 'solid',
                      marginHorizontal: 2,
                    }}
                  />
                  <View
                    style={{
                      flex: CC_COLS.notes,
                      borderBottomWidth: 0.5,
                      borderBottomColor: PDF_COLORS.lineStrong,
                      borderBottomStyle: 'solid',
                      marginHorizontal: 2,
                    }}
                  />
                </View>
              ))
            )}
          </View>
        </View>

        {/* Sign-off block — fits on the last page; non-fixed so it flows
            after the table instead of every page. */}
        <View
          style={{
            marginTop: 24,
            flexDirection: 'row',
            gap: 24,
          }}
          wrap={false}
        >
          <Signature label="Counted by" />
          <Signature label="Date" />
          <Signature label="Approved by" />
        </View>

        <View style={pdfStyles.footer} fixed>
          <Text>{org.name} · Cycle count sheet · Print and count by hand</Text>
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

function Signature({ label }: { label: string }) {
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          height: 28,
          borderBottomWidth: 1,
          borderBottomColor: PDF_COLORS.ink2,
          borderBottomStyle: 'solid',
        }}
      />
      <Text style={[pdfStyles.small, pdfStyles.muted, { marginTop: 4 }]}>
        {label}
      </Text>
    </View>
  );
}

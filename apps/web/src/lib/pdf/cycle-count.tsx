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
  /** Set on completed sheets so the PDF can render variance directly. */
  countedQuantity?: number | null;
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
  // Status pivots PDF behavior: 'in_progress' renders a printable count
  // sheet with blank Counted/Notes columns; everything else (completed,
  // canceled) renders a variance report so the printed artifact matches
  // the on-screen state. This kills hunter finding #22: closed counts
  // used to dump a blank sheet that didn't match reality.
  const isVarianceReport = cycle.status !== 'in_progress';
  const subtitle =
    [
      cycle.warehouseName ?? 'All warehouses',
      formatDateForPdf(cycle.startedAt),
      isVarianceReport ? 'Variance report' : null,
    ]
      .filter(Boolean)
      .join(' · ');

  const title = isVarianceReport
    ? `Cycle count variance #${idShort}`
    : `Cycle count #${idShort}`;

  // Pre-sort: SKU for count sheets so the printed list matches a
  // shelf-walk pass; variance-magnitude descending for variance
  // reports so the biggest discrepancies show first.
  const sortedLines = [...lines].sort((a, b) => {
    if (isVarianceReport) {
      const va = Math.abs((a.countedQuantity ?? a.expectedQuantity) - a.expectedQuantity);
      const vb = Math.abs((b.countedQuantity ?? b.expectedQuantity) - b.expectedQuantity);
      if (vb !== va) return vb - va;
    }
    return (a.sku ?? '').localeCompare(b.sku ?? '');
  });

  return (
    <Document title={title}>
      <Page size="LETTER" style={pdfStyles.page}>
        <BrandedHeader
          orgName={org.name}
          orgLogoUrl={org.logoUrl}
          title={title}
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
            {isVarianceReport ? 'Counted lines' : 'Items to count'} · {sortedLines.length}
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
              <Text style={[pdfStyles.tHeadCell, { flex: CC_COLS.notes }]}>
                {isVarianceReport ? 'Variance' : 'Notes'}
              </Text>
            </View>
            {sortedLines.length === 0 ? (
              <View style={pdfStyles.tRow}>
                <Text style={[pdfStyles.tCell, pdfStyles.muted, { flex: 1 }]}>
                  No items in this cycle count.
                </Text>
              </View>
            ) : (
              sortedLines.map((l, i) => {
                const counted = l.countedQuantity ?? null;
                const variance =
                  counted == null ? null : counted - l.expectedQuantity;
                return (
                  <View
                    // eslint-disable-next-line react/no-array-index-key
                    key={`${l.sku}-${i}`}
                    style={[pdfStyles.tRow, { minHeight: 22 }]}
                    // Allow row wrap so long descriptions don't truncate
                    // — react-pdf will paginate the row if it overflows.
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
                    {isVarianceReport ? (
                      <Text
                        style={[
                          pdfStyles.tCell,
                          pdfStyles.tRight,
                          { flex: CC_COLS.countQty },
                        ]}
                      >
                        {counted == null ? '—' : counted}
                      </Text>
                    ) : (
                      <View
                        style={{
                          flex: CC_COLS.countQty,
                          borderBottomWidth: 0.5,
                          borderBottomColor: PDF_COLORS.lineStrong,
                          borderBottomStyle: 'solid',
                          marginHorizontal: 2,
                        }}
                      />
                    )}
                    {isVarianceReport ? (
                      <Text style={[pdfStyles.tCell, { flex: CC_COLS.notes }]}>
                        {variance == null
                          ? '—'
                          : variance === 0
                            ? '0'
                            : `${variance > 0 ? '+' : ''}${variance}`}
                      </Text>
                    ) : (
                      <View
                        style={{
                          flex: CC_COLS.notes,
                          borderBottomWidth: 0.5,
                          borderBottomColor: PDF_COLORS.lineStrong,
                          borderBottomStyle: 'solid',
                          marginHorizontal: 2,
                        }}
                      />
                    )}
                  </View>
                );
              })
            )}
          </View>
        </View>

        {/* Sign-off block only on the printable count sheet — closed
            counts have already been signed off in-app. */}
        {!isVarianceReport && (
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
        )}

        <View style={pdfStyles.footer} fixed>
          <Text>
            {org.name} ·{' '}
            {isVarianceReport
              ? 'Cycle count variance report'
              : 'Cycle count sheet · Print and count by hand'}
          </Text>
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

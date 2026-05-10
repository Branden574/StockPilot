import { Document, Page, Text, View } from '@react-pdf/renderer';

import { BrandedHeader } from './branding';
import {
  PDF_COLORS,
  formatDateForPdf,
  formatNumberForPdf,
  pdfStyles,
} from './styles';

export interface ShipmentPdfLine {
  /** ISBN if barcode set, else SKU. */
  isbn: string;
  description: string;
  qtyShipped: number;
  qtyBackOrdered: number;
}

export interface ShipmentPdfWarehouse {
  name: string;
  /** Address as a denormalized list of lines (line1, line2, "City, State Zip"). */
  addressLines: string[];
  contactPhone: string | null;
  contactEmail: string | null;
}

export interface ShipmentPdfManagerBlock {
  fullName: string | null;
  role: string | null;
  warehouseAddressLines: string[];
  phone: string | null;
  email: string | null;
}

export interface ShipmentPdfHeader {
  workOrderNumber: string;
  shipDate: string;
  attentionToName: string | null;
  notes: string | null;
}

export interface ShipmentPdfOrg {
  name: string;
  logoUrl: string | null;
}

interface ShipmentPdfProps {
  org: ShipmentPdfOrg;
  shipment: ShipmentPdfHeader;
  source: ShipmentPdfWarehouse;
  destination: ShipmentPdfWarehouse;
  lines: ShipmentPdfLine[];
  manager: ShipmentPdfManagerBlock | null;
}

/**
 * Helper that flattens a Postgres jsonb address into the kind of
 * denormalized line list a packing slip wants. Missing pieces become
 * empty lines so we never render literal "null".
 */
export function addressJsonToLines(
  address: Record<string, unknown> | null,
): string[] {
  if (!address) return [];
  const line1 = (address.line1 as string | null) ?? '';
  const line2 = (address.line2 as string | null) ?? '';
  const city = (address.city as string | null) ?? '';
  const region = (address.region as string | null) ?? '';
  const postal = (address.postalCode as string | null) ?? '';
  const country = (address.country as string | null) ?? '';
  const cityLine = [city, region].filter(Boolean).join(', ');
  const cityZip = [cityLine, postal].filter(Boolean).join(' ').trim();
  return [line1, line2, cityZip, country].filter((s) => s.trim().length > 0);
}

const COLS = {
  num: 5,
  desc: 50,
  isbn: 19,
  qty: 13,
  bo: 13,
} as const;

export function ShipmentPdf({
  org,
  shipment,
  source,
  destination,
  lines,
  manager,
}: ShipmentPdfProps) {
  const totalShipped = lines.reduce((s, l) => s + (Number(l.qtyShipped) || 0), 0);
  const totalBo = lines.reduce((s, l) => s + (Number(l.qtyBackOrdered) || 0), 0);

  return (
    <Document title={`Packing slip ${shipment.workOrderNumber}`}>
      <Page size="LETTER" style={pdfStyles.page}>
        <BrandedHeader
          orgName={org.name}
          orgLogoUrl={org.logoUrl}
          title="PACKING SLIP"
          subtitle={shipment.workOrderNumber}
          documentDate={shipment.shipDate || new Date()}
        />

        <View style={[pdfStyles.section, pdfStyles.twoCol]}>
          <View style={pdfStyles.col}>
            <Text style={pdfStyles.sectionTitle}>Ship to</Text>
            <Text style={pdfStyles.bold}>{destination.name}</Text>
            <Text style={pdfStyles.muted}>WO# {shipment.workOrderNumber}</Text>
            <Text style={pdfStyles.muted}>
              Date: {formatDateForPdf(shipment.shipDate)}
            </Text>
            <Text style={pdfStyles.muted}>
              Attention: {shipment.attentionToName ?? ' '}
            </Text>
          </View>
          <View style={pdfStyles.col}>
            <Text style={pdfStyles.sectionTitle}>Ship from</Text>
            <Text style={pdfStyles.bold}>{source.name}</Text>
            {source.addressLines.map((l, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <Text key={`addr-${i}`} style={pdfStyles.muted}>
                {l}
              </Text>
            ))}
            {source.contactPhone ? (
              <Text style={pdfStyles.muted}>{source.contactPhone}</Text>
            ) : null}
            {source.contactEmail ? (
              <Text style={pdfStyles.muted}>{source.contactEmail}</Text>
            ) : null}
          </View>
        </View>

        {shipment.notes ? (
          <View style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>Notes</Text>
            <Text style={pdfStyles.muted}>{shipment.notes}</Text>
          </View>
        ) : null}

        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>Items</Text>
          <View style={pdfStyles.table}>
            <View style={pdfStyles.tHeadRow} fixed>
              <Text style={[pdfStyles.tHeadCell, { flex: COLS.num }]}>#</Text>
              <Text style={[pdfStyles.tHeadCell, { flex: COLS.desc }]}>
                Description
              </Text>
              <Text style={[pdfStyles.tHeadCell, { flex: COLS.isbn }]}>ISBN</Text>
              <Text
                style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: COLS.qty }]}
              >
                Qty shipped
              </Text>
              <Text
                style={[pdfStyles.tHeadCell, pdfStyles.tRight, { flex: COLS.bo }]}
              >
                B.O.
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
                <View
                  // eslint-disable-next-line react/no-array-index-key
                  key={`${l.isbn}-${i}`}
                  style={pdfStyles.tRow}
                  wrap={false}
                >
                  <Text
                    style={[pdfStyles.tCell, pdfStyles.muted, { flex: COLS.num }]}
                  >
                    {i + 1}
                  </Text>
                  <Text style={[pdfStyles.tCell, { flex: COLS.desc }]}>
                    {l.description}
                  </Text>
                  <Text
                    style={[pdfStyles.tCell, pdfStyles.tCellMono, { flex: COLS.isbn }]}
                  >
                    {l.isbn || '—'}
                  </Text>
                  <Text
                    style={[pdfStyles.tCell, pdfStyles.tRight, { flex: COLS.qty }]}
                  >
                    {formatNumberForPdf(l.qtyShipped)}
                  </Text>
                  <Text
                    style={[pdfStyles.tCell, pdfStyles.tRight, { flex: COLS.bo }]}
                  >
                    {formatNumberForPdf(l.qtyBackOrdered)}
                  </Text>
                </View>
              ))
            )}
            <View style={pdfStyles.tRow} wrap={false}>
              <Text style={[pdfStyles.tCell, { flex: COLS.num }]} />
              <Text
                style={[pdfStyles.tCell, pdfStyles.bold, { flex: COLS.desc + COLS.isbn }]}
              >
                Total
              </Text>
              <Text
                style={[
                  pdfStyles.tCell,
                  pdfStyles.bold,
                  pdfStyles.tRight,
                  { flex: COLS.qty },
                ]}
              >
                {formatNumberForPdf(totalShipped)}
              </Text>
              <Text
                style={[
                  pdfStyles.tCell,
                  pdfStyles.bold,
                  pdfStyles.tRight,
                  { flex: COLS.bo },
                ]}
              >
                {formatNumberForPdf(totalBo)}
              </Text>
            </View>
          </View>
        </View>

        <View style={[pdfStyles.section, { marginTop: 18 }]} wrap={false}>
          <Text style={pdfStyles.sectionTitle}>Receipt</Text>
          <View style={{ flexDirection: 'row', gap: 18, marginTop: 4 }}>
            <View style={{ flex: 1 }}>
              <Text style={pdfStyles.muted}>Received by</Text>
              <View
                style={{
                  marginTop: 18,
                  borderBottomWidth: 0.7,
                  borderBottomColor: PDF_COLORS.ink2,
                  borderBottomStyle: 'solid',
                }}
              />
            </View>
            <View style={{ flex: 0.7 }}>
              <Text style={pdfStyles.muted}>Date</Text>
              <View
                style={{
                  marginTop: 18,
                  borderBottomWidth: 0.7,
                  borderBottomColor: PDF_COLORS.ink2,
                  borderBottomStyle: 'solid',
                }}
              />
            </View>
          </View>
          <View style={{ marginTop: 14 }}>
            <Text style={pdfStyles.muted}>Print name</Text>
            <View
              style={{
                marginTop: 18,
                borderBottomWidth: 0.7,
                borderBottomColor: PDF_COLORS.ink2,
                borderBottomStyle: 'solid',
              }}
            />
          </View>
        </View>

        <View style={pdfStyles.footer} fixed>
          <View style={{ alignItems: 'center', flex: 1 }}>
            <Text>If you have questions regarding delivery, please contact:</Text>
            {manager ? (
              <>
                {manager.fullName ? <Text>{manager.fullName}</Text> : null}
                {manager.role ? <Text>{manager.role}</Text> : null}
                {manager.warehouseAddressLines.map((l, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <Text key={`mg-${i}`}>{l}</Text>
                ))}
                {manager.phone ? <Text>{manager.phone}</Text> : null}
                {manager.email ? <Text>{manager.email}</Text> : null}
              </>
            ) : null}
          </View>
        </View>
      </Page>
    </Document>
  );
}

import type { RackHoldingLike } from '@stockpilot/core';
import {
  renderToStream,
  Document,
  Page,
  StyleSheet,
  Text,
  View,
} from '@react-pdf/renderer';

import {
  Addresses,
  BrandBand,
  FooterCode,
  FooterContact,
  LinesTable,
  MetaGrid,
  formatOrderCode,
  styles,
  type PackingSlipInputCore,
} from './packing-slip-shared';

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export interface WarehousePackingSlipInput extends PackingSlipInputCore {
  /** PNG data URL of the signature-collection QR. Null when the order
   *  has no signature_token (legacy rows or odd state). */
  qrDataUrl: string | null;
  /** Rack/crate HOLDINGS (item_stock_levels), keyed by inventory_items.id
   *  — batch-fetched by the route (fetchRackHoldingsByItem), scoped to
   *  the order's warehouse. Drives the LOCATION column's split-item
   *  breakdown (see `locationFor` in packing-slip-shared.tsx); the
   *  customer-facing slip never shows the Location column so it has no
   *  equivalent field. */
  rackHoldingsByItemId?: Map<string, RackHoldingLike[]>;
}

/**
 * Warehouse-facing packing slip. Same brand band, meta grid, address
 * blocks, and line-item table as the customer variant, plus:
 *   * A Location column on each line showing rack (and crate for
 *     books) so the picker / packer can verify the bin at hand-off.
 *   * A QR code that, when scanned by the recipient on a phone,
 *     opens `/orders/sign/<token>` for the signature flow. Includes
 *     pickup_location_notes + internal_notes for the team.
 */
export async function renderWarehousePackingSlipPdf(
  input: WarehousePackingSlipInput,
): Promise<Buffer> {
  const {
    detail,
    warehouse,
    charterName,
    imageUrlByItemId,
    qrDataUrl,
    orgTimezone,
    rackHoldingsByItemId,
  } = input;
  const tz = orgTimezone ?? 'UTC';
  const { request, lines } = detail;
  const isPickup = request.fulfillment_type === 'pickup';
  const orderCode = formatOrderCode(request.id, request.order_number);
  // Resolved requester name (falls back to the joined user_profiles for
  // internal self-submit orders where request.requester_name is NULL).
  const shipToName = detail.requesterName ?? null;

  const stream = await renderToStream(
    <Document>
      <Page size="LETTER" style={styles.page}>
        <BrandBand
          tag="WAREHOUSE PACKING SLIP"
          whenIso={request.packing_slip_generated_at}
          orgTimezone={tz}
        />

        <MetaGrid
          request={request}
          totalLines={lines.length}
          showStatus={false}
          orgTimezone={tz}
        />

        <Addresses
          warehouse={warehouse}
          shipToName={
            charterName && !isPickup ? charterName : shipToName ?? '—'
          }
          shipToEmail={detail.requesterEmail}
          shipToPhone={request.requester_phone}
          attention={
            charterName && !isPickup && shipToName
              ? `Attention · ${shipToName}`
              : null
          }
          pickupNote={request.pickup_location_notes}
          isPickup={isPickup}
          qrDataUrl={qrDataUrl}
        />

        {request.internal_notes ? (
          <View
            style={{
              marginTop: 14,
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderTop: '1pt solid #e2e8f0',
              borderBottom: '1pt solid #e2e8f0',
              borderLeft: '1pt solid #e2e8f0',
              borderRight: '1pt solid #e2e8f0',
              backgroundColor: '#fffbeb',
            }}
          >
            <Text
              style={{
                fontSize: 8,
                fontFamily: 'Helvetica-Bold',
                letterSpacing: 1.2,
                color: '#92400e',
                marginBottom: 4,
              }}
            >
              INTERNAL NOTES
            </Text>
            <Text style={{ fontSize: 10, color: '#78350f', lineHeight: 1.45 }}>
              {request.internal_notes}
            </Text>
          </View>
        ) : null}

        <LinesTable
          lines={lines}
          options={{ showLocation: true, imageUrlByItemId, rackHoldingsByItemId }}
        />

        {/* Manual signature block — fallback for when the QR/digital
            flow isn't usable (no phone on hand, network down, etc.).
            The digital QR in the footer remains the preferred path;
            this is the ink-on-paper backup. */}
        <View style={signatureStyles.wrap}>
          <View style={signatureStyles.headerRow}>
            <Text style={signatureStyles.eyebrow}>RECEIVED BY</Text>
            <Text style={signatureStyles.hint}>
              {qrDataUrl
                ? 'Sign below OR scan the QR to sign digitally.'
                : 'Sign below to confirm receipt.'}
            </Text>
          </View>
          <View style={signatureStyles.row}>
            <View style={signatureStyles.col}>
              <View style={signatureStyles.line} />
              <Text style={signatureStyles.caption}>NAME (PRINT)</Text>
            </View>
            <View style={signatureStyles.col}>
              <View style={signatureStyles.line} />
              <Text style={signatureStyles.caption}>SIGNATURE</Text>
            </View>
            <View style={signatureStyles.colLast}>
              <View style={signatureStyles.line} />
              <Text style={signatureStyles.caption}>DATE / TIME</Text>
            </View>
          </View>
          {/* Print-only checkbox, ALWAYS rendered unchecked — the driver
              ticks it with a pen. When the receiver signs digitally instead
              (the QR flow -> order_requests.signature_data_url) the ink
              line above stays blank and the paper trail looks incomplete;
              this box lets the paper say where the signature actually
              lives. Right-aligned so it hangs under the DATE / TIME column,
              visually closing the signature block. */}
          <View style={signatureStyles.digitalRow}>
            <View style={signatureStyles.digitalBox} />
            <Text style={signatureStyles.digitalLabel}>
              Signature captured digitally in StockPilot
            </Text>
          </View>
        </View>

        <View style={styles.footer}>
          <View>
            <FooterCode code={`ORD-${orderCode}`} />
            <Text style={{ fontSize: 8.5, color: '#94a3b8', marginTop: 4 }}>
              For warehouse use · verify each line at hand-off
            </Text>
          </View>
          <FooterContact warehouse={warehouse} />
        </View>
      </Page>
    </Document>,
  );
  return streamToBuffer(stream as NodeJS.ReadableStream);
}

// Manual signature block — used as a paper fallback when the QR /
// digital signature flow can't be used. Kept local to the warehouse
// slip since the customer slip (which is a receipt) doesn't need it.
const signatureStyles = StyleSheet.create({
  wrap: {
    marginTop: 16,
    paddingTop: 10,
    borderTopWidth: 0.5,
    borderTopColor: '#dcd9cf',
    borderTopStyle: 'solid',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  eyebrow: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 8,
    letterSpacing: 2,
    color: '#5a5853',
  },
  hint: {
    fontSize: 8.5,
    color: '#8b887f',
    fontStyle: 'italic',
  },
  row: { flexDirection: 'row' },
  col: { flex: 1, marginRight: 16 },
  colLast: { flex: 1 },
  line: {
    borderBottomWidth: 0.8,
    borderBottomColor: '#0c0c0e',
    borderBottomStyle: 'solid',
    height: 26,
  },
  caption: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 7,
    letterSpacing: 1.8,
    color: '#8b887f',
    marginTop: 4,
  },
  // The digitally-signed checkbox row. Box ink matches the signature
  // lines (#0c0c0e); label sits at the hint's 8.5pt in the eyebrow's
  // muted ink so the row reads as part of the block, not a new section.
  digitalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 12,
  },
  digitalBox: {
    width: 9.5,
    height: 9.5,
    borderWidth: 0.9,
    borderColor: '#0c0c0e',
    borderStyle: 'solid',
    marginRight: 6,
  },
  digitalLabel: {
    fontSize: 8.5,
    color: '#5a5853',
  },
});

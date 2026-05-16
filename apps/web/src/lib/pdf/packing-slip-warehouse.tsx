import {
  renderToStream,
  Document,
  Image as PdfImage,
  Page,
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
  const { detail, warehouse, charterName, imageUrlByItemId, qrDataUrl } = input;
  const { request, lines } = detail;
  const isPickup = request.fulfillment_type === 'pickup';
  const orderCode = formatOrderCode(request.id);
  const shipToName = request.requester_name ?? null;

  const stream = await renderToStream(
    <Document>
      <Page size="LETTER" style={styles.page}>
        <BrandBand
          tag="WAREHOUSE PACKING SLIP"
          whenIso={request.packing_slip_generated_at}
        />

        <MetaGrid request={request} totalLines={lines.length} />

        <Addresses
          warehouse={warehouse}
          shipToName={
            charterName && !isPickup ? charterName : shipToName ?? '—'
          }
          shipToEmail={request.requester_email}
          shipToPhone={request.requester_phone}
          attention={
            charterName && !isPickup && shipToName
              ? `Attention · ${shipToName}`
              : null
          }
          pickupNote={request.pickup_location_notes}
          isPickup={isPickup}
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
          options={{ showLocation: true, imageUrlByItemId }}
        />

        <View style={styles.footer}>
          <View>
            <FooterCode code={`ORD-${orderCode}`} />
            <Text style={{ fontSize: 8.5, color: '#94a3b8', marginTop: 4 }}>
              For warehouse use · verify each line at hand-off
            </Text>
          </View>
          {qrDataUrl ? (
            <View style={styles.qrBlock}>
              <PdfImage src={qrDataUrl} style={styles.qr} />
              <Text style={styles.qrCaption}>SCAN TO SIGN</Text>
              <Text style={styles.qrSub}>
                Recipient scans on phone to confirm delivery and complete the
                order.
              </Text>
            </View>
          ) : (
            <FooterContact warehouse={warehouse} />
          )}
        </View>
      </Page>
    </Document>,
  );
  return streamToBuffer(stream as NodeJS.ReadableStream);
}

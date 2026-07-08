import {
  renderToStream,
  Document,
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

/**
 * Customer-facing packing slip. Same brand header + meta grid + ship-to
 * + line items as the warehouse variant, but without the signature QR
 * (customers don't need to sign their own slip) and without the
 * Location column (the rack/crate is internal pick-routing info).
 * Footer carries the order code as a monospace strip + the warehouse
 * contact card so the recipient knows who to reach.
 */
export async function renderCustomerPackingSlipPdf(
  input: PackingSlipInputCore,
): Promise<Buffer> {
  const { detail, warehouse, charterName, imageUrlByItemId, orgTimezone } = input;
  const tz = orgTimezone ?? 'UTC';
  const { request, lines } = detail;
  const isPickup = request.fulfillment_type === 'pickup';
  const orderCode = formatOrderCode(request.id);
  // Resolved requester name (falls back to the joined user_profiles for
  // internal self-submit orders where request.requester_name is NULL).
  const shipToName = detail.requesterName ?? null;

  const stream = await renderToStream(
    <Document>
      <Page size="LETTER" style={styles.page}>
        <BrandBand
          tag="PACKING SLIP"
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
        />

        <LinesTable
          lines={lines}
          options={{ showLocation: false, imageUrlByItemId }}
        />

        <View style={styles.footer}>
          <FooterCode code={`ORD-${orderCode}`} />
          <FooterContact warehouse={warehouse} />
        </View>

        <Text
          style={{
            fontSize: 8.5,
            color: '#94a3b8',
            marginTop: 12,
            textAlign: 'center',
          }}
        >
          Questions about this order? Reply to the email this slip came with —
          our team is on the other end.
        </Text>
      </Page>
    </Document>,
  );
  return streamToBuffer(stream as NodeJS.ReadableStream);
}

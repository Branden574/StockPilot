import { renderToStream, Document, Page, Text, View, Image, StyleSheet } from '@react-pdf/renderer';

import type { OrderRequestDetail } from '@/server/services/order-requests';

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 11, fontFamily: 'Helvetica' },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  h1: { fontSize: 18, fontWeight: 700 },
  subtle: { color: '#666', fontSize: 10 },
  section: { marginTop: 14 },
  row: { flexDirection: 'row', borderBottom: '1pt solid #ddd', paddingVertical: 6 },
  th: { fontWeight: 700, backgroundColor: '#f5f5f5' },
  cellSku: { width: 100, fontFamily: 'Courier' },
  cellName: { flex: 1 },
  cellQty: { width: 60, textAlign: 'right' },
  qr: { width: 110, height: 110 },
  qrLabel: { fontSize: 9, color: '#666', textAlign: 'center', marginTop: 4 },
});

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

interface WarehouseInput {
  detail: OrderRequestDetail;
  qrDataUrl: string | null;
  charterName: string | null;
}

export async function renderWarehousePackingSlipPdf(
  input: WarehouseInput,
): Promise<Buffer> {
  const { detail, qrDataUrl, charterName } = input;
  const { request, lines, warehouseName } = detail;
  const stream = await renderToStream(
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.topRow}>
          <View>
            <Text style={styles.h1}>Packing slip (warehouse)</Text>
            <Text style={styles.subtle}>
              Order #{request.id.slice(0, 8).toUpperCase()} ·{' '}
              {request.fulfillment_type === 'pickup' ? 'Pickup' : 'Delivery'}
            </Text>
            <Text style={styles.subtle}>
              From: {warehouseName ?? '—'}
              {request.fulfillment_type === 'delivery' && charterName
                ? ` → ${charterName}`
                : ''}
            </Text>
          </View>
          {qrDataUrl ? (
            <View>
              <Image src={qrDataUrl} style={styles.qr} />
              <Text style={styles.qrLabel}>Scan to collect signature</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text>
            Requester:{' '}
            {request.requester_name ?? '—'}
            {request.requester_email ? ` · ${request.requester_email}` : ''}
            {request.requester_phone ? ` · ${request.requester_phone}` : ''}
          </Text>
          {request.fulfillment_type === 'pickup' && request.pickup_location_notes ? (
            <Text style={styles.subtle}>
              Pickup notes: {request.pickup_location_notes}
            </Text>
          ) : null}
          <Text style={styles.subtle}>
            Packed:{' '}
            {request.packing_slip_generated_at
              ? new Date(request.packing_slip_generated_at).toLocaleString()
              : '—'}
          </Text>
          {request.internal_notes ? (
            <Text style={styles.subtle}>Internal: {request.internal_notes}</Text>
          ) : null}
        </View>

        <View style={styles.section}>
          <View style={[styles.row, styles.th]}>
            <Text style={styles.cellSku}>SKU</Text>
            <Text style={styles.cellName}>Item</Text>
            <Text style={styles.cellQty}>Qty</Text>
          </View>
          {lines.map((l) => (
            <View key={l.id} style={styles.row}>
              <Text style={styles.cellSku}>{l.item?.sku ?? '—'}</Text>
              <Text style={styles.cellName}>{l.item?.name ?? '—'}</Text>
              <Text style={styles.cellQty}>
                {String(l.quantity_picked ?? l.quantity_requested)}
              </Text>
            </View>
          ))}
        </View>
      </Page>
    </Document>,
  );
  return streamToBuffer(stream as NodeJS.ReadableStream);
}

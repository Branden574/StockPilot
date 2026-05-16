import { renderToStream, Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

import type { OrderRequestDetail } from '@/server/services/order-requests';

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 11, fontFamily: 'Helvetica' },
  h1: { fontSize: 18, fontWeight: 700, marginBottom: 4 },
  subtle: { color: '#666', fontSize: 10 },
  section: { marginTop: 14 },
  row: { flexDirection: 'row', borderBottom: '1pt solid #ddd', paddingVertical: 6 },
  th: { fontWeight: 700, backgroundColor: '#f0f0f0' },
  cellQty: { width: 60, textAlign: 'right' },
  cellSku: { width: 100, fontFamily: 'Courier' },
  cellName: { flex: 1 },
  cellBin: { width: 80 },
});

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function renderPickSlipPdf(detail: OrderRequestDetail): Promise<Buffer> {
  const { request, lines, warehouseName } = detail;
  const stream = await renderToStream(
    <Document>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.h1}>Pick slip</Text>
        <Text style={styles.subtle}>
          Order #{request.id.slice(0, 8).toUpperCase()} · {warehouseName ?? '—'}
        </Text>

        <View style={styles.section}>
          <Text>
            Requester:{' '}
            {request.requester_name ?? '—'}
            {request.requester_email ? ` · ${request.requester_email}` : ''}
          </Text>
          <Text style={styles.subtle}>
            Fulfillment: {request.fulfillment_type === 'pickup' ? 'Pickup' : 'Delivery'} ·
            Generated:{' '}
            {request.pick_slip_generated_at
              ? new Date(request.pick_slip_generated_at).toLocaleString()
              : '—'}
          </Text>
        </View>

        <View style={styles.section}>
          <View style={[styles.row, styles.th]}>
            <Text style={styles.cellSku}>SKU</Text>
            <Text style={styles.cellName}>Item</Text>
            <Text style={styles.cellBin}>Bin</Text>
            <Text style={styles.cellQty}>Qty</Text>
          </View>
          {lines.map((l) => (
            <View key={l.id} style={styles.row}>
              <Text style={styles.cellSku}>{l.item?.sku ?? '—'}</Text>
              <Text style={styles.cellName}>{l.item?.name ?? '—'}</Text>
              <Text style={styles.cellBin}>{'—'}</Text>
              <Text style={styles.cellQty}>{String(l.quantity_requested)}</Text>
            </View>
          ))}
        </View>

        {request.notes ? (
          <View style={styles.section}>
            <Text style={styles.subtle}>Requester notes:</Text>
            <Text>{request.notes}</Text>
          </View>
        ) : null}
      </Page>
    </Document>,
  );
  return streamToBuffer(stream as NodeJS.ReadableStream);
}

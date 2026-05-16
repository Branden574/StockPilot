import { renderToStream, Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

import type { OrderRequestDetail } from '@/server/services/order-requests';

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 11, fontFamily: 'Helvetica' },
  h1: { fontSize: 20, fontWeight: 700 },
  subtle: { color: '#666', fontSize: 10 },
  section: { marginTop: 16 },
  row: { flexDirection: 'row', borderBottom: '1pt solid #eee', paddingVertical: 6 },
  th: { fontWeight: 700, color: '#444' },
  cellQty: { width: 50, textAlign: 'right' },
  cellName: { flex: 1 },
});

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function renderCustomerPackingSlipPdf(
  detail: OrderRequestDetail,
): Promise<Buffer> {
  const { request, lines, warehouseName } = detail;
  const stream = await renderToStream(
    <Document>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.h1}>Packing slip</Text>
        <Text style={styles.subtle}>
          Order #{request.id.slice(0, 8).toUpperCase()} ·{' '}
          {request.fulfillment_type === 'pickup' ? 'Pickup' : 'Delivery'} ·
          {' '}{warehouseName ?? '—'}
        </Text>

        <View style={styles.section}>
          <Text>For: {request.requester_name ?? request.requester_email ?? '—'}</Text>
          <Text style={styles.subtle}>
            Packed:{' '}
            {request.packing_slip_generated_at
              ? new Date(request.packing_slip_generated_at).toLocaleDateString()
              : '—'}
          </Text>
        </View>

        <View style={styles.section}>
          <View style={[styles.row, styles.th]}>
            <Text style={styles.cellName}>Item</Text>
            <Text style={styles.cellQty}>Qty</Text>
          </View>
          {lines.map((l) => (
            <View key={l.id} style={styles.row}>
              <Text style={styles.cellName}>{l.item?.name ?? '—'}</Text>
              <Text style={styles.cellQty}>
                {String(l.quantity_picked ?? l.quantity_requested)}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.section}>
          <Text style={styles.subtle}>
            Questions? Reply to the email this slip came with.
          </Text>
        </View>
      </Page>
    </Document>,
  );
  return streamToBuffer(stream as NodeJS.ReadableStream);
}

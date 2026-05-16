import {
  renderToStream,
  Document,
  Image as PdfImage,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer';

import { readBookStorage, readItemRack } from '@/lib/book-storage';
import type { OrderRequestDetail, OrderRequestLineWithItem } from '@/server/services/order-requests';

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 11, fontFamily: 'Helvetica' },
  h1: { fontSize: 18, fontWeight: 700, marginBottom: 4 },
  subtle: { color: '#666', fontSize: 10 },
  section: { marginTop: 14 },
  row: {
    flexDirection: 'row',
    borderBottom: '1pt solid #ddd',
    paddingVertical: 8,
    alignItems: 'center',
  },
  headerRow: {
    flexDirection: 'row',
    borderBottom: '1pt solid #ddd',
    paddingVertical: 6,
    backgroundColor: '#f0f0f0',
  },
  th: { fontWeight: 700 },

  // Column widths sum to ~540pt (Letter page minus 72pt of side
  // padding). Wider Item column accommodates the now-stacked name +
  // SKU; rack/crate sits in its own column to the right of name.
  cellImg: { width: 56 },
  cellItem: { flex: 1, paddingRight: 8 },
  cellLocation: { width: 130, paddingRight: 8 },
  cellQty: { width: 50, textAlign: 'right' },

  thumb: { width: 48, height: 48, objectFit: 'cover', borderRadius: 4 },
  thumbPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 4,
    backgroundColor: '#f4f4f5',
    borderColor: '#e4e4e7',
    borderWidth: 1,
    borderStyle: 'solid',
  },

  itemName: { fontSize: 11, fontWeight: 700 },
  itemSku: { fontFamily: 'Courier', fontSize: 9, color: '#666', marginTop: 2 },

  locationPrimary: { fontSize: 11 },
  locationSecondary: { fontSize: 9, color: '#666', marginTop: 2 },
  locationMuted: { fontSize: 10, color: '#999' },
});

/**
 * Reads the location (rack ± crate) for a single pick-slip line.
 * Books carry their location in book_rack_* / book_crate_* keys; every
 * other item type uses neutral rack_* keys. The pick-slip column
 * shows a rack label, and — for books only — a second line with the
 * crate label so the picker grabs the right colored bin.
 */
function locationFor(line: OrderRequestLineWithItem): {
  primary: string | null;
  secondary: string | null;
} {
  const item = line.item;
  if (!item) return { primary: null, secondary: null };
  const cf = (item.custom_fields ?? {}) as Record<string, unknown>;
  if (item.item_type === 'book') {
    const info = readBookStorage(cf);
    return {
      primary: info.rackLabel ? `Rack ${info.rackLabel}` : null,
      secondary: info.crateLabel ? `Crate ${info.crateLabel}` : null,
    };
  }
  const info = readItemRack(cf);
  return {
    primary: info.rackLabel ? `Rack ${info.rackLabel}` : null,
    secondary: null,
  };
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface RenderPickSlipOptions {
  /** Pre-signed image URLs keyed by inventory_items.id. Items without
   *  an image fall back to a neutral placeholder square so the row
   *  stays vertically aligned with the rest. */
  imageUrlByItemId?: Map<string, string>;
}

export async function renderPickSlipPdf(
  detail: OrderRequestDetail,
  opts: RenderPickSlipOptions = {},
): Promise<Buffer> {
  const { request, lines, warehouseName } = detail;
  const imageUrlByItemId = opts.imageUrlByItemId ?? new Map<string, string>();
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
          <View style={styles.headerRow}>
            <Text style={[styles.cellImg, styles.th]}>{' '}</Text>
            <Text style={[styles.cellItem, styles.th]}>Item</Text>
            <Text style={[styles.cellLocation, styles.th]}>Location</Text>
            <Text style={[styles.cellQty, styles.th]}>Qty</Text>
          </View>
          {lines.map((l) => {
            const imgUrl = l.item ? imageUrlByItemId.get(l.item.id) : undefined;
            const loc = locationFor(l);
            return (
              <View key={l.id} style={styles.row} wrap={false}>
                <View style={styles.cellImg}>
                  {imgUrl ? (
                    <PdfImage src={imgUrl} style={styles.thumb} />
                  ) : (
                    <View style={styles.thumbPlaceholder} />
                  )}
                </View>
                <View style={styles.cellItem}>
                  <Text style={styles.itemName}>{l.item?.name ?? '—'}</Text>
                  <Text style={styles.itemSku}>{l.item?.sku ?? '—'}</Text>
                </View>
                <View style={styles.cellLocation}>
                  {loc.primary ? (
                    <Text style={styles.locationPrimary}>{loc.primary}</Text>
                  ) : (
                    <Text style={styles.locationMuted}>No rack set</Text>
                  )}
                  {loc.secondary ? (
                    <Text style={styles.locationSecondary}>{loc.secondary}</Text>
                  ) : null}
                </View>
                <Text style={styles.cellQty}>{String(l.quantity_requested)}</Text>
              </View>
            );
          })}
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

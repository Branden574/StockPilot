import {
  renderToStream,
  Document,
  Image as PdfImage,
  Page,
  Svg,
  Path,
  Rect,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer';

import { readBookStorage, readItemRack } from '@/lib/book-storage';
import type { OrderRequestDetail, OrderRequestLineWithItem } from '@/server/services/order-requests';

/**
 * Editorial palette mirrored from apps/web/src/app/globals.css. The
 * pick-slip carries the same ink/paper feel as the on-screen mockup,
 * with a single accent for the verified-state checkmarks.
 */
const INK = '#0c0c0e';
const INK_2 = '#2a2a2c';
const INK_3 = '#5a5853';
const INK_4 = '#8b887f';
const PAPER = '#f6f4ef';
const SUNK = '#eeece5';
const HAIR = '#dcd9cf';

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 40,
    paddingHorizontal: 36,
    fontFamily: 'Helvetica',
    fontSize: 10,
    color: INK,
    backgroundColor: PAPER,
  },

  // ── Brand strip (top) ───────────────────────────────────────────
  brandStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 10,
    borderBottomWidth: 1.5,
    borderBottomColor: INK,
    borderBottomStyle: 'solid',
  },
  brandWord: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 14,
    color: INK,
    marginLeft: 8,
  },
  brandWordFaded: {
    fontFamily: 'Helvetica',
    fontSize: 14,
    color: INK_3,
  },
  brandEyebrow: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 7.5,
    letterSpacing: 2,
    color: INK_4,
    marginLeft: 12,
    paddingLeft: 12,
    borderLeftWidth: 0.5,
    borderLeftColor: HAIR,
    borderLeftStyle: 'solid',
  },
  brandTimestamp: {
    marginLeft: 'auto',
    fontFamily: 'Courier',
    fontSize: 8.5,
    color: INK_3,
  },

  // ── Headline (order ID + status pill) ──────────────────────────
  headlineRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  eyebrow: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 7.5,
    letterSpacing: 2,
    color: INK_4,
    marginBottom: 4,
  },
  orderId: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 30,
    color: INK,
    letterSpacing: -1,
  },
  fullId: {
    fontFamily: 'Courier',
    fontSize: 7.5,
    color: INK_4,
    marginTop: 4,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    paddingHorizontal: 11,
    borderRadius: 999,
    backgroundColor: SUNK,
  },
  pillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: INK_4,
    marginRight: 6,
  },
  pillLabel: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: INK_2,
  },
  pillFraction: {
    fontFamily: 'Courier',
    fontSize: 9,
    color: INK_2,
    marginLeft: 8,
    paddingLeft: 8,
    borderLeftWidth: 0.5,
    borderLeftColor: HAIR,
    borderLeftStyle: 'solid',
  },

  // ── Meta grid (Requester / Destination / Fulfillment / Lines·Qty)
  metaGrid: {
    flexDirection: 'row',
    marginTop: 14,
    borderWidth: 0.5,
    borderColor: HAIR,
    borderStyle: 'solid',
    borderRadius: 3,
  },
  metaCell: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRightWidth: 0.5,
    borderRightColor: HAIR,
    borderRightStyle: 'solid',
  },
  metaCellLast: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  metaLabel: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 7,
    letterSpacing: 2,
    color: INK_4,
    marginBottom: 4,
  },
  metaValue: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
    color: INK,
  },
  metaSub: {
    fontFamily: 'Courier',
    fontSize: 7.5,
    color: INK_4,
    marginTop: 3,
  },

  // ── Pick-list table ────────────────────────────────────────────
  tableWrap: {
    marginTop: 14,
    borderWidth: 0.5,
    borderColor: HAIR,
    borderStyle: 'solid',
    borderRadius: 3,
    overflow: 'hidden',
  },
  thead: {
    flexDirection: 'row',
    backgroundColor: SUNK,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: HAIR,
    borderBottomStyle: 'solid',
  },
  th: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 7,
    letterSpacing: 1.5,
    color: INK_3,
  },

  // Column widths sum to 540pt printable width (Letter 612 - 72 padding).
  // paddingRight on every column except the last creates breathing room
  // between cells (gap on flex isn't supported in @react-pdf).
  colIdx: { width: 22, paddingRight: 6 },
  colItem: { width: 170, paddingRight: 10 },
  colLocation: { width: 78, paddingRight: 10 },
  colQty: { width: 40, paddingRight: 14, textAlign: 'right' },
  colTally: { flex: 1, paddingLeft: 6 },

  row: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: HAIR,
    borderBottomStyle: 'solid',
    alignItems: 'flex-start',
  },
  rowLast: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 10,
    alignItems: 'flex-start',
  },
  rowIndex: {
    fontFamily: 'Courier',
    fontSize: 8,
    color: INK_4,
    paddingTop: 14,
  },
  itemCell: { flexDirection: 'row', alignItems: 'flex-start' },
  thumb: {
    width: 38,
    height: 38,
    objectFit: 'cover',
    borderRadius: 3,
    marginRight: 10,
    borderWidth: 0.5,
    borderColor: HAIR,
    borderStyle: 'solid',
  },
  thumbPlaceholder: {
    width: 38,
    height: 38,
    borderRadius: 3,
    marginRight: 10,
    backgroundColor: SUNK,
    borderWidth: 0.5,
    borderColor: HAIR,
    borderStyle: 'solid',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbPlaceholderText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
    color: INK_3,
    letterSpacing: 1,
  },
  itemName: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 10.5,
    color: INK,
  },
  itemModel: {
    fontSize: 9,
    color: INK_3,
    marginTop: 2,
  },
  itemSku: {
    fontFamily: 'Courier',
    fontSize: 7.5,
    color: INK_4,
    marginTop: 3,
  },
  locationText: { fontSize: 9.5, color: INK },
  locationBin: {
    fontFamily: 'Courier',
    fontSize: 7.5,
    color: INK_4,
    marginTop: 3,
  },
  locationMuted: { fontSize: 9, color: INK_4 },
  qtyValue: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 15,
    color: INK,
    textAlign: 'right',
    lineHeight: 1,
  },
  qtyFraction: {
    fontFamily: 'Courier',
    fontSize: 7,
    color: INK_4,
    textAlign: 'right',
    marginTop: 4,
  },

  // ── Tally grid (numbered, printable boxes) ─────────────────────
  tallyWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  tallyBox: {
    width: 16,
    height: 16,
    borderWidth: 0.5,
    borderColor: '#0c0c0e',
    borderStyle: 'solid',
    borderRadius: 2,
    marginRight: 3,
    marginBottom: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tallyBoxOverflow: {
    width: 'auto',
    paddingHorizontal: 5,
    height: 16,
    borderWidth: 0.5,
    borderColor: '#0c0c0e',
    borderStyle: 'solid',
    borderRadius: 2,
    marginRight: 3,
    marginBottom: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tallyLabel: {
    fontFamily: 'Courier',
    fontSize: 7,
    color: INK_2,
  },

  // ── Totals row (dark) ──────────────────────────────────────────
  totalsRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: INK,
  },
  totalsLabel: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 7.5,
    letterSpacing: 1.5,
    color: PAPER,
  },
  totalsQty: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 13,
    color: PAPER,
    textAlign: 'right',
  },
  totalsCaption: {
    fontFamily: 'Courier',
    fontSize: 8,
    color: '#bfbcb1',
  },

  // ── Requester notes ────────────────────────────────────────────
  notesWrap: {
    flexDirection: 'row',
    marginTop: 14,
    padding: 12,
    backgroundColor: SUNK,
    borderWidth: 0.5,
    borderColor: HAIR,
    borderStyle: 'solid',
    borderRadius: 3,
  },
  notesLabelCol: { width: 110, marginRight: 12 },
  notesFrom: { fontSize: 8.5, color: INK_4 },
  notesBody: { flex: 1, fontSize: 10, color: INK_2, lineHeight: 1.45 },

  // ── Signature ─────────────────────────────────────────────────
  signatureRow: {
    flexDirection: 'row',
    marginTop: 18,
    paddingTop: 12,
    borderTopWidth: 0.5,
    borderTopColor: HAIR,
    borderTopStyle: 'solid',
  },
  signatureCol: { flex: 1, marginRight: 16 },
  signatureColLast: { flex: 1 },
  signatureLine: {
    borderBottomWidth: 0.8,
    borderBottomColor: INK,
    borderBottomStyle: 'solid',
    height: 24,
  },
  signatureCaption: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 7,
    letterSpacing: 1.8,
    color: INK_4,
    marginTop: 4,
  },

  // ── Footer ────────────────────────────────────────────────────
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 36,
    right: 36,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontFamily: 'Helvetica-Bold',
    fontSize: 6.5,
    letterSpacing: 1.8,
    color: INK_4,
  },
});

const PADLEFT_2 = (n: number) => String(n).padStart(2, '0');

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

/**
 * Brand mark — vector reproduction of the SVG used in the mock so the
 * PDF stays crisp at any zoom. The mask path is the stylized "S" used
 * across the editorial design.
 */
function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Rect x={12} y={12} width={76} height={76} rx={14} fill={INK} />
      <Path
        d="M 32 78 Q 72 78 72 66 Q 72 54 54 54 Q 32 54 32 42 Q 32 24 72 24"
        stroke={PAPER}
        strokeWidth={11}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

/**
 * Numbered tally boxes — one per requested unit. The picker ticks each
 * one by hand as they grab the unit. We render numbers up to 30 in
 * individual boxes; beyond that we fall through to a single "1-N"
 * overflow chip so the layout stays bounded. Most warehouse picks fall
 * well under 30 units; the rare big-qty line (e.g., 100 batteries) gets
 * a manual count line instead of a wall of checkboxes.
 */
function TallyGrid({ qty }: { qty: number }) {
  const MAX_INDIVIDUAL = 30;
  if (qty <= 0) return null;
  if (qty > MAX_INDIVIDUAL) {
    return (
      <View style={styles.tallyWrap}>
        <View style={styles.tallyBoxOverflow}>
          <Text style={styles.tallyLabel}>1–{qty}</Text>
        </View>
      </View>
    );
  }
  const boxes = Array.from({ length: qty }, (_, i) => i + 1);
  return (
    <View style={styles.tallyWrap}>
      {boxes.map((n) => (
        <View key={n} style={styles.tallyBox}>
          <Text style={styles.tallyLabel}>{n}</Text>
        </View>
      ))}
    </View>
  );
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

  const totalLines = lines.length;
  const totalUnits = lines.reduce((s, l) => s + (Number(l.quantity_requested) || 0), 0);
  const shortId = request.id.slice(0, 8).toUpperCase();
  const generatedAt = request.pick_slip_generated_at
    ? new Date(request.pick_slip_generated_at).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';
  const requesterName = request.requester_name ?? '—';
  const requesterEmail = request.requester_email ?? '';
  const fulfillmentLabel = request.fulfillment_type === 'pickup' ? 'Pickup' : 'Delivery';
  const destination = request.requester_org_label ?? warehouseName ?? '—';

  const stream = await renderToStream(
    <Document>
      <Page size="LETTER" style={styles.page}>
        {/* Brand strip */}
        <View style={styles.brandStrip}>
          <BrandMark size={22} />
          <Text style={styles.brandWord}>
            Stock<Text style={styles.brandWordFaded}>Pilot</Text>
          </Text>
          <Text style={styles.brandEyebrow}>PICK SLIP · WAREHOUSE</Text>
          <Text style={styles.brandTimestamp}>{generatedAt}</Text>
        </View>

        {/* Headline + status pill */}
        <View style={styles.headlineRow}>
          <View>
            <Text style={styles.eyebrow}>ORDER · {warehouseName ?? '—'}</Text>
            <Text style={styles.orderId}>#{shortId}</Text>
            <Text style={styles.fullId}>{request.id}</Text>
          </View>
          <View style={styles.pill}>
            <View style={styles.pillDot} />
            <Text style={styles.pillLabel}>To pick</Text>
            <Text style={styles.pillFraction}>
              0 / {totalUnits}
            </Text>
          </View>
        </View>

        {/* Meta grid */}
        <View style={styles.metaGrid}>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>REQUESTER</Text>
            <Text style={styles.metaValue}>{requesterName}</Text>
            {requesterEmail ? <Text style={styles.metaSub}>{requesterEmail}</Text> : null}
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>DESTINATION</Text>
            <Text style={styles.metaValue}>{destination}</Text>
            <Text style={styles.metaSub}>{fulfillmentLabel}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>FULFILLMENT</Text>
            <Text style={styles.metaValue}>{fulfillmentLabel}</Text>
            <Text style={styles.metaSub}>
              {request.fulfillment_type === 'pickup' ? 'At dock' : 'Driver hand-off'}
            </Text>
          </View>
          <View style={styles.metaCellLast}>
            <Text style={styles.metaLabel}>LINES · QTY</Text>
            <Text style={styles.metaValue}>
              {totalLines} · {totalUnits}
            </Text>
            <Text style={styles.metaSub}>Total units</Text>
          </View>
        </View>

        {/* Pick-list table */}
        <View style={styles.tableWrap}>
          <View style={styles.thead}>
            <Text style={[styles.th, styles.colIdx]}>#</Text>
            <Text style={[styles.th, styles.colItem]}>ITEM</Text>
            <Text style={[styles.th, styles.colLocation]}>LOCATION</Text>
            <Text style={[styles.th, styles.colQty]}>QTY</Text>
            <Text style={[styles.th, styles.colTally]}>
              VERIFIED · TICK EACH UNIT
            </Text>
          </View>
          {lines.map((l, i) => {
            const imgUrl = l.item ? imageUrlByItemId.get(l.item.id) : undefined;
            const loc = locationFor(l);
            const isLast = i === lines.length - 1;
            return (
              <View
                key={l.id}
                style={isLast ? styles.rowLast : styles.row}
                wrap={false}
              >
                <Text style={[styles.rowIndex, styles.colIdx]}>
                  {PADLEFT_2(i + 1)}
                </Text>
                <View style={[styles.colItem, styles.itemCell]}>
                  {imgUrl ? (
                    <PdfImage src={imgUrl} style={styles.thumb} />
                  ) : (
                    <View style={styles.thumbPlaceholder}>
                      <Text style={styles.thumbPlaceholderText}>
                        {(l.item?.sku ?? '?').slice(0, 2).toUpperCase()}
                      </Text>
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{l.item?.name ?? '—'}</Text>
                    {l.item?.model_number ? (
                      <Text style={styles.itemModel}>{l.item.model_number}</Text>
                    ) : null}
                    <Text style={styles.itemSku}>{l.item?.sku ?? '—'}</Text>
                  </View>
                </View>
                <View style={styles.colLocation}>
                  {loc.primary ? (
                    <Text style={styles.locationText}>{loc.primary}</Text>
                  ) : (
                    <Text style={styles.locationMuted}>No rack set</Text>
                  )}
                  {loc.secondary ? (
                    <Text style={styles.locationBin}>{loc.secondary}</Text>
                  ) : null}
                </View>
                <View style={styles.colQty}>
                  <Text style={styles.qtyValue}>{l.quantity_requested}</Text>
                  <Text style={styles.qtyFraction}>
                    0/{l.quantity_requested}
                  </Text>
                </View>
                <View style={styles.colTally}>
                  <TallyGrid qty={l.quantity_requested} />
                </View>
              </View>
            );
          })}
          {/* Totals row (dark) */}
          <View style={styles.totalsRow}>
            <View style={styles.colIdx} />
            <View style={[styles.colItem, { justifyContent: 'center' }]}>
              <Text style={styles.totalsLabel}>
                TOTAL · {totalLines} LINES
              </Text>
            </View>
            <View style={styles.colLocation} />
            <View style={styles.colQty}>
              <Text style={styles.totalsQty}>{totalUnits}</Text>
            </View>
            <View style={[styles.colTally, { justifyContent: 'center' }]}>
              <Text style={styles.totalsCaption}>
                0 of {totalUnits} verified
              </Text>
            </View>
          </View>
        </View>

        {/* Requester notes */}
        {request.notes ? (
          <View style={styles.notesWrap}>
            <View style={styles.notesLabelCol}>
              <Text style={styles.eyebrow}>REQUESTER NOTES</Text>
              <Text style={styles.notesFrom}>From {requesterName}</Text>
            </View>
            <Text style={styles.notesBody}>{request.notes}</Text>
          </View>
        ) : null}

        {/* Signature */}
        <View style={styles.signatureRow}>
          <View style={styles.signatureCol}>
            <View style={styles.signatureLine} />
            <Text style={styles.signatureCaption}>PICKER NAME</Text>
          </View>
          <View style={styles.signatureCol}>
            <View style={styles.signatureLine} />
            <Text style={styles.signatureCaption}>SIGNATURE</Text>
          </View>
          <View style={styles.signatureColLast}>
            <View style={styles.signatureLine} />
            <Text style={styles.signatureCaption}>DATE / TIME</Text>
          </View>
        </View>

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text>STOCKPILOT · STOCKPILOTUSA.COM</Text>
          <Text>
            {shortId} · {warehouseName ?? '—'}
          </Text>
        </View>
      </Page>
    </Document>,
  );
  return streamToBuffer(stream as NodeJS.ReadableStream);
}

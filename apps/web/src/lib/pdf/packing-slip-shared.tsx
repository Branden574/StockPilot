import {
  Image as PdfImage,
  Path,
  Rect,
  StyleSheet,
  Svg,
  Text,
  View,
} from '@react-pdf/renderer';

import { readBookStorage, readItemRack } from '@/lib/book-storage';
import type {
  OrderRequestDetail,
  OrderRequestLineWithItem,
  OrderRequestRow,
} from '@/server/services/order-requests';

/**
 * Shared layout primitives for the customer and warehouse packing
 * slips. Both share the same brand header, meta grid, address blocks,
 * and line-item table — they diverge only in the footer (customer:
 * thanks note; warehouse: QR + signature prompt).
 *
 * @react-pdf/renderer doesn't ship a gradient or web fonts out of the
 * box, so brand elements lean on filled rectangles + Helvetica. The
 * design tokens below match the cream + ink palette of the
 * marketing-side Claude design as closely as built-in primitives
 * allow.
 */

// ── Design tokens ─────────────────────────────────────────────────────
export const colors = {
  cream: '#fafaf6',
  ink: '#0f172a',
  inkSoft: '#334155',
  muted: '#64748b',
  hairline: '#e2e8f0',
  panel: '#f8fafc',
  brand: '#4f46e5',
  brandDeep: '#3730a3',
  pillBg: '#fff7ed',
  pillFg: '#9a3412',
  totalBg: '#0f172a',
  totalFg: '#ffffff',
};

export const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 36,
    paddingHorizontal: 40,
    fontSize: 10.5,
    fontFamily: 'Helvetica',
    color: colors.ink,
    backgroundColor: colors.cream,
  },

  // ── Brand band ──
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 14,
    borderBottom: `1pt solid ${colors.hairline}`,
  },
  brandLeft: { flexDirection: 'row', alignItems: 'center' },
  brandMarkBox: { width: 22, height: 22, marginRight: 9 },
  brandWord: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: -0.2,
    color: colors.ink,
  },
  brandDivider: {
    width: 1,
    height: 16,
    backgroundColor: colors.hairline,
    marginHorizontal: 14,
  },
  brandTag: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 1.5,
    color: colors.muted,
  },
  brandRight: { alignItems: 'flex-end' },
  brandDate: { fontSize: 10, color: colors.inkSoft },

  // ── Meta grid (4 cells) ──
  metaGrid: {
    flexDirection: 'row',
    marginTop: 18,
    borderTop: `1pt solid ${colors.hairline}`,
    borderLeft: `1pt solid ${colors.hairline}`,
  },
  metaCell: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRight: `1pt solid ${colors.hairline}`,
    borderBottom: `1pt solid ${colors.hairline}`,
  },
  metaLabel: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 1.2,
    color: colors.muted,
    marginBottom: 6,
  },
  metaValue: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    color: colors.ink,
  },
  metaSub: { fontSize: 8.5, color: colors.muted, marginTop: 3 },
  metaPill: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    color: colors.pillFg,
  },

  // ── Address blocks ──
  addresses: { flexDirection: 'row', marginTop: 18 },
  addressBlock: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderTop: `1pt solid ${colors.hairline}`,
    borderBottom: `1pt solid ${colors.hairline}`,
    borderRight: `1pt solid ${colors.hairline}`,
    borderLeft: `1pt solid ${colors.hairline}`,
  },
  addressBlockRight: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderTop: `1pt solid ${colors.hairline}`,
    borderBottom: `1pt solid ${colors.hairline}`,
    borderRight: `1pt solid ${colors.hairline}`,
  },
  addressLabel: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 1.2,
    color: colors.muted,
    marginBottom: 8,
  },
  addressName: {
    fontSize: 12.5,
    fontFamily: 'Helvetica-Bold',
    color: colors.ink,
    marginBottom: 4,
  },
  addressLine: { fontSize: 10, color: colors.inkSoft, lineHeight: 1.5 },
  addressAttention: {
    marginTop: 8,
    fontSize: 9.5,
    color: colors.inkSoft,
  },

  // ── Items table ──
  tableHeader: {
    flexDirection: 'row',
    marginTop: 20,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderTop: `1pt solid ${colors.hairline}`,
    borderBottom: `1pt solid ${colors.hairline}`,
    alignItems: 'center',
  },
  th: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 1.2,
    color: colors.muted,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottom: `1pt solid ${colors.hairline}`,
    alignItems: 'center',
  },

  // Column widths sum to fit ~515pt (Letter width minus 80pt padding).
  colIndex: { width: 26, fontSize: 9.5, color: colors.muted, fontFamily: 'Helvetica-Bold' },
  colImage: { width: 44 },
  colDescription: { flex: 1, paddingRight: 8 },
  colLocation: { width: 96, paddingRight: 6 },
  colQty: { width: 50, textAlign: 'right' },
  colBO: { width: 36, textAlign: 'right' },

  thumb: { width: 36, height: 36, objectFit: 'cover', borderRadius: 3 },
  thumbPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: 3,
    backgroundColor: '#f1f5f9',
    borderColor: colors.hairline,
    borderWidth: 0.5,
    borderStyle: 'solid',
  },

  itemName: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: colors.ink },
  itemSub: { fontSize: 9, color: colors.muted, marginTop: 2 },
  itemMonoSub: {
    fontSize: 9,
    fontFamily: 'Courier',
    color: colors.muted,
    marginTop: 2,
  },

  locPrimary: { fontSize: 10, color: colors.ink },
  locSecondary: { fontSize: 9, color: colors.muted, marginTop: 2 },
  locMuted: { fontSize: 9.5, color: '#94a3b8' },

  qtyValue: { fontSize: 11.5, fontFamily: 'Helvetica-Bold', color: colors.ink },
  boValue: { fontSize: 10.5, color: colors.muted },
  boValueWarn: { fontSize: 10.5, fontFamily: 'Helvetica-Bold', color: '#ea580c' },

  totalRow: {
    flexDirection: 'row',
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: colors.totalBg,
    alignItems: 'center',
    marginTop: -1,
  },
  totalLabel: {
    flex: 1,
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 1.4,
    color: '#cbd5e1',
  },
  totalQty: {
    width: 50,
    textAlign: 'right',
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    color: colors.totalFg,
  },
  totalBO: {
    width: 36,
    textAlign: 'right',
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    color: '#f59e0b',
  },

  // ── Footer ──
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginTop: 22,
    paddingTop: 18,
    borderTop: `1pt solid ${colors.hairline}`,
  },
  footerCode: {
    fontSize: 8.5,
    fontFamily: 'Courier',
    color: colors.muted,
    letterSpacing: 1,
  },
  footerContact: { alignItems: 'flex-end' },
  footerContactLabel: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 1.2,
    color: colors.muted,
    marginBottom: 4,
  },
  footerContactName: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: colors.ink,
  },
  footerContactLine: { fontSize: 9.5, color: colors.inkSoft, marginTop: 2 },

  // ── QR (warehouse only) ──
  qrBlock: { alignItems: 'flex-end' },
  qr: { width: 86, height: 86 },
  qrCaption: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 1,
    color: colors.muted,
    marginTop: 6,
    textAlign: 'right',
  },
  qrSub: {
    fontSize: 8.5,
    color: colors.muted,
    marginTop: 2,
    textAlign: 'right',
    maxWidth: 140,
  },
});

// ── Data helpers ──────────────────────────────────────────────────────

export function formatOrderCode(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

export function formatPackedDate(iso: string | null): {
  date: string;
  time: string;
} {
  if (!iso) return { date: '—', time: '' };
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
    }),
    time: d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    }),
  };
}

export function statusLabel(status: OrderRequestRow['status']): string {
  switch (status) {
    case 'packing_slip_generated':
      return 'Ready';
    case 'staged_for_pickup':
      return 'Staged · Pickup';
    case 'staged_for_delivery':
      return 'Staged · Delivery';
    case 'in_transit':
      return 'In transit';
    case 'completed':
      return 'Completed';
    default:
      return status;
  }
}

export function statusSubLabel(
  status: OrderRequestRow['status'],
  fulfillment: 'pickup' | 'delivery',
): string {
  switch (status) {
    case 'packing_slip_generated':
      return fulfillment === 'pickup'
        ? 'Awaiting pickup hand-off'
        : 'Awaiting carrier';
    case 'staged_for_pickup':
      return 'Ready for customer';
    case 'staged_for_delivery':
      return 'Ready to dispatch';
    case 'in_transit':
      return 'En route';
    case 'completed':
      return 'Signed for';
    default:
      return '';
  }
}

export interface WarehouseAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface WarehouseInfo {
  name: string | null;
  code: string | null;
  address: WarehouseAddress | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

export function addressLines(addr: WarehouseAddress | null): string[] {
  if (!addr) return [];
  const lines: string[] = [];
  if (addr.line1) lines.push(addr.line1);
  if (addr.line2) lines.push(addr.line2);
  const cityRow = [addr.city, addr.state].filter(Boolean).join(', ');
  const tail = [cityRow, addr.postalCode].filter(Boolean).join(' ');
  if (tail.trim()) lines.push(tail.trim());
  if (addr.country) lines.push(addr.country);
  return lines;
}

// ── Shared sub-components ─────────────────────────────────────────────

/**
 * Carved-S stencil mark from the brand sheet, drawn in @react-pdf/renderer
 * primitives. @react-pdf supports <Mask> in v3+ but the implementation
 * is fragile across version bumps, so we composite the same visual in
 * two passes:
 *   1. Solid rounded ink rect at viewBox 12..88 with rx=16.
 *   2. The S-curve and pip in the page-background color stroked over
 *      the rect, which carves the negative space visually.
 * Result is indistinguishable from the masked version when the
 * surrounding page bg matches.
 */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <View style={{ width: size, height: size, marginRight: 9 }}>
      <Svg viewBox="0 0 100 100" width="100%" height="100%">
        <Rect x={12} y={12} width={76} height={76} rx={16} fill={colors.ink} />
        <Path
          d="M 32 78 Q 72 78 72 66 Q 72 54 54 54 Q 32 54 32 42 Q 32 24 72 24"
          stroke={colors.cream}
          strokeWidth={11}
          strokeLinecap="round"
          fill="none"
        />
        <Rect x={66} y={18} width={12} height={12} rx={6} fill={colors.cream} />
      </Svg>
    </View>
  );
}

export function BrandBand({
  tag,
  whenIso,
}: {
  tag: string;
  whenIso: string | null;
}) {
  const { date, time } = formatPackedDate(whenIso);
  return (
    <View style={styles.brandRow}>
      <View style={styles.brandLeft}>
        <BrandMark size={22} />
        <Text style={styles.brandWord}>StockPilot</Text>
        <View style={styles.brandDivider} />
        <Text style={styles.brandTag}>{tag}</Text>
      </View>
      <View style={styles.brandRight}>
        <Text style={styles.brandDate}>
          {date}
          {time ? ` · ${time}` : ''}
        </Text>
      </View>
    </View>
  );
}

export function MetaGrid({
  request,
  totalLines,
  showStatus = true,
}: {
  request: OrderRequestRow;
  totalLines: number;
  /** Customer-facing receipts hide the internal status pill — "Ready /
   *  Awaiting carrier" is ops state and isn't useful to the recipient. */
  showStatus?: boolean;
}) {
  const packed = formatPackedDate(request.packing_slip_generated_at);
  const label = statusLabel(request.status);
  const sub = statusSubLabel(request.status, request.fulfillment_type);
  return (
    <View style={styles.metaGrid}>
      <View style={styles.metaCell}>
        <Text style={styles.metaLabel}>ORDER</Text>
        <Text style={styles.metaValue}>{formatOrderCode(request.id)}</Text>
        <Text style={styles.metaSub}>{totalLines} line{totalLines === 1 ? '' : 's'}</Text>
      </View>
      <View style={styles.metaCell}>
        <Text style={styles.metaLabel}>PACKED</Text>
        <Text style={styles.metaValue}>{packed.date}</Text>
        <Text style={styles.metaSub}>{packed.time || '—'}</Text>
      </View>
      <View style={styles.metaCell}>
        <Text style={styles.metaLabel}>FULFILLMENT</Text>
        <Text style={styles.metaValue}>
          {request.fulfillment_type === 'pickup' ? 'Pickup' : 'Delivery'}
        </Text>
        <Text style={styles.metaSub}>
          {request.fulfillment_type === 'pickup' ? 'Customer arrives' : 'Carrier out'}
        </Text>
      </View>
      {showStatus && (
        <View style={styles.metaCell}>
          <Text style={styles.metaLabel}>STATUS</Text>
          <Text style={styles.metaPill}>{label}</Text>
          <Text style={styles.metaSub}>{sub || '—'}</Text>
        </View>
      )}
    </View>
  );
}

export function Addresses({
  warehouse,
  shipToName,
  shipToEmail,
  shipToPhone,
  attention,
  pickupNote,
  isPickup,
}: {
  warehouse: WarehouseInfo;
  shipToName: string | null;
  shipToEmail: string | null;
  shipToPhone: string | null;
  attention: string | null;
  pickupNote: string | null;
  isPickup: boolean;
}) {
  const fromLines = addressLines(warehouse.address);
  return (
    <View style={styles.addresses}>
      <View style={styles.addressBlock}>
        <Text style={styles.addressLabel}>FROM</Text>
        <Text style={styles.addressName}>
          {warehouse.name ?? '—'}
          {warehouse.code ? ` · ${warehouse.code}` : ''}
        </Text>
        {fromLines.map((line, i) => (
          <Text key={i} style={styles.addressLine}>
            {line}
          </Text>
        ))}
        {fromLines.length === 0 ? (
          <Text style={styles.addressLine}>Address on file</Text>
        ) : null}
        {warehouse.contactName ? (
          <Text style={styles.addressAttention}>
            Contact · {warehouse.contactName}
          </Text>
        ) : null}
      </View>
      <View style={styles.addressBlockRight}>
        <Text style={styles.addressLabel}>
          {isPickup ? 'PICKUP FOR' : 'SHIP TO'}
        </Text>
        <Text style={styles.addressName}>{shipToName ?? '—'}</Text>
        {attention ? (
          <Text style={styles.addressLine}>{attention}</Text>
        ) : null}
        {shipToEmail ? (
          <Text style={styles.addressLine}>{shipToEmail}</Text>
        ) : null}
        {shipToPhone ? (
          <Text style={styles.addressLine}>{shipToPhone}</Text>
        ) : null}
        {isPickup && pickupNote ? (
          <Text style={styles.addressAttention}>{pickupNote}</Text>
        ) : null}
      </View>
    </View>
  );
}

export interface LinesTableOptions {
  /** Show the Location column (warehouse slip only). */
  showLocation?: boolean;
  /** Map of item.id → signed image URL for thumbnails. */
  imageUrlByItemId?: Map<string, string>;
}

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

export function LinesTable({
  lines,
  options,
}: {
  lines: OrderRequestLineWithItem[];
  options: LinesTableOptions;
}) {
  const { showLocation = false, imageUrlByItemId = new Map() } = options;
  let totalQty = 0;
  let totalBO = 0;
  for (const l of lines) {
    const picked = l.quantity_picked ?? l.quantity_requested;
    totalQty += Number(picked) || 0;
    const bo = Number(l.quantity_requested) - Number(picked ?? 0);
    if (bo > 0) totalBO += bo;
  }

  return (
    <View>
      <View style={styles.tableHeader}>
        <Text style={[styles.th, styles.colIndex]}>#</Text>
        <Text style={[styles.th, styles.colImage]}>{' '}</Text>
        <Text style={[styles.th, styles.colDescription]}>DESCRIPTION</Text>
        {showLocation ? (
          <Text style={[styles.th, styles.colLocation]}>LOCATION</Text>
        ) : null}
        <Text style={[styles.th, styles.colQty]}>QTY SHIP</Text>
        <Text style={[styles.th, styles.colBO]}>B/O</Text>
      </View>
      {lines.map((l, i) => {
        const picked = Number(l.quantity_picked ?? l.quantity_requested) || 0;
        const requested = Number(l.quantity_requested) || 0;
        const bo = Math.max(0, requested - picked);
        const imgUrl = l.item ? imageUrlByItemId.get(l.item.id) : undefined;
        const loc = locationFor(l);
        const cf = (l.item?.custom_fields ?? {}) as Record<string, unknown>;
        const author = typeof cf.book_author === 'string' ? cf.book_author : null;
        return (
          <View key={l.id} style={styles.tableRow} wrap={false}>
            <Text style={[styles.colIndex]}>{String(i + 1).padStart(2, '0')}</Text>
            <View style={styles.colImage}>
              {imgUrl ? (
                <PdfImage src={imgUrl} style={styles.thumb} />
              ) : (
                <View style={styles.thumbPlaceholder} />
              )}
            </View>
            <View style={styles.colDescription}>
              <Text style={styles.itemName}>{l.item?.name ?? '—'}</Text>
              {author ? (
                <Text style={styles.itemSub}>{author}</Text>
              ) : (
                <Text style={styles.itemMonoSub}>{l.item?.sku ?? '—'}</Text>
              )}
            </View>
            {showLocation ? (
              <View style={styles.colLocation}>
                {loc.primary ? (
                  <Text style={styles.locPrimary}>{loc.primary}</Text>
                ) : (
                  <Text style={styles.locMuted}>—</Text>
                )}
                {loc.secondary ? (
                  <Text style={styles.locSecondary}>{loc.secondary}</Text>
                ) : null}
              </View>
            ) : null}
            <Text style={[styles.colQty, styles.qtyValue]}>{picked}</Text>
            <Text
              style={[styles.colBO, bo > 0 ? styles.boValueWarn : styles.boValue]}
            >
              {bo > 0 ? bo : '0'}
            </Text>
          </View>
        );
      })}
      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>
          TOTAL · {lines.length} LINE{lines.length === 1 ? '' : 'S'}
        </Text>
        {showLocation ? <View style={{ width: 96 }} /> : null}
        <Text style={styles.totalQty}>{totalQty}</Text>
        <Text style={styles.totalBO}>{totalBO || '0'}</Text>
      </View>
    </View>
  );
}

export function FooterCode({ code }: { code: string }) {
  return <Text style={styles.footerCode}>{code}</Text>;
}

export function FooterContact({ warehouse }: { warehouse: WarehouseInfo }) {
  return (
    <View style={styles.footerContact}>
      <Text style={styles.footerContactLabel}>CONTACT</Text>
      {warehouse.contactName ? (
        <Text style={styles.footerContactName}>{warehouse.contactName}</Text>
      ) : (
        <Text style={styles.footerContactName}>Warehouse team</Text>
      )}
      {warehouse.contactPhone ? (
        <Text style={styles.footerContactLine}>{warehouse.contactPhone}</Text>
      ) : null}
      {warehouse.contactEmail ? (
        <Text style={styles.footerContactLine}>{warehouse.contactEmail}</Text>
      ) : null}
    </View>
  );
}

export interface PackingSlipInputCore {
  detail: OrderRequestDetail;
  warehouse: WarehouseInfo;
  charterName: string | null;
  imageUrlByItemId: Map<string, string>;
}

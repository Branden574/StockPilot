import { formatOrderNumber } from '@stockpilot/core';
import 'server-only';

import {
  assertEmailWeight,
  banner,
  bodyText,
  brandStrip,
  ctaNote,
  ctaRow,
  detailGrid,
  emailShell,
  escapeHtml,
  footer,
  headline,
  helpRow,
  heroSlot,
  infoCard,
  itemTable,
  linkFallback,
  MOBILE_GRID_RULES,
  orderTimeline,
  section,
  statusPill,
} from './es/components';
import { esEmailById } from './es/registry';
import { ES_LIGHT, esAssetUrl } from './es/tokens';
import { sendEmail } from './resend';
import {
  buildPublicUnsubscribeUrl,
  normalizeUnsubscribeEmail,
} from './unsubscribe';
import { createAdminClient } from '@/lib/supabase/admin';

import type {
  DetailCell,
  EmailShellStyles,
  TimelineStep,
} from './es/components';
import type { EsStatusVariant } from './es/tokens';
import type { OrderRequestRow } from '@/server/services/order-requests';

export type OrderRequestEmailKind =
  | 'submitted'
  | 'confirm_request'
  | 'approved'
  | 'denied'
  | 'packing_slip_generated'
  | 'staged_for_delivery'
  | 'in_transit'
  | 'completed'
  | 'cancelled';

interface SendInput {
  kind: OrderRequestEmailKind;
  request: OrderRequestRow;
  recipientEmail: string;
  recipientName: string | null;
  appUrl: string;
  /**
   * F2: org's `public_request_token`. Required for public-link
   * requesters so the email's "Track" CTA includes `&t=…` — the GET
   * /api/v1/public/order-requests/[id] handler scopes the lookup by
   * org public_request_token and silently 404s without it. Only
   * consulted when `request.requester_user_id` is null (public
   * submission). Optional/nullable so internal callers don't have
   * to supply it.
   */
  publicRequestToken?: string | null;
  /**
   * Plaintext confirmation token. Required ONLY for `kind ===
   * 'confirm_request'` — the CTA in that email points to
   * `/r/confirm?id=<id>&t=<plaintext>`. Hashing happens server-side
   * before storage so the email is the only place the raw value
   * lives.
   */
  confirmationToken?: string | null;
}

// ─── Registry wiring ─────────────────────────────────────────────────

/**
 * Existing dispatch kinds → es registry ids. The kind names are part of
 * this module's public contract (service, sign route, public confirm
 * route all pass them) and MUST NOT change; the registry ids drive
 * subject/preheader/badge/CTA copy and the sender.
 */
const REGISTRY_ID_BY_KIND: Record<OrderRequestEmailKind, string> = {
  submitted: 'received',
  confirm_request: 'confirm',
  approved: 'approved',
  denied: 'denied',
  // LATENT: dispatch decision pending (see policy audit). Nothing in the
  // codebase dispatches these two kinds; the templates exist and render,
  // but sendOrderRequestEmail refuses to send them unless the
  // ES_LATENT_ORDER_EMAILS flag is set (see the guard in the entry).
  packing_slip_generated: 'packing',
  staged_for_delivery: 'staged',
  in_transit: 'transit',
  completed: 'delivered',
  cancelled: 'cancelled',
};

/**
 * LATENT: dispatch decision pending (see policy audit). These kinds have
 * no dispatch path today (verified: no caller passes them). The guard
 * below keeps it that way — flipping them on is a product decision, not
 * a side effect of some future caller wiring a trigger.
 */
const LATENT_KINDS: ReadonlySet<OrderRequestEmailKind> = new Set([
  'packing_slip_generated',
  'staged_for_delivery',
]);

// ─── Data fetching ───────────────────────────────────────────────────

interface SummaryLineItem {
  name: string;
  sku: string;
  qty: number;
}

interface SummaryData {
  lineCount: number;
  unitCount: number;
  shipDate: string | null;
  shipFrom: string | null;
  shipTo: string | null;
  /** Line items (name/SKU/qty) for the delivered + packing item tables. */
  items: SummaryLineItem[];
  /** Resolved approver profile (approved_by), for "by {approver}" + Contact approver. */
  approverName: string | null;
  approverEmail: string | null;
}

const DEGRADED_SUMMARY: SummaryData = {
  lineCount: 0,
  unitCount: 0,
  shipDate: null,
  shipFrom: null,
  shipTo: null,
  items: [],
  approverName: null,
  approverEmail: null,
};

async function fetchSummary(row: OrderRequestRow): Promise<SummaryData> {
  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
  } catch {
    // No service-role key — return a degraded summary the template
    // can still render around (counts default to 0, shipDate/ships
    // omitted by the template when null).
    return DEGRADED_SUMMARY;
  }

  const [linesRes, whRes, charterRes, approverRes] = await Promise.all([
    admin
      .from('order_request_lines')
      .select(
        'quantity_picked, quantity_requested, item:inventory_items!item_id(name, sku)',
      )
      .eq('order_request_id', row.id),
    admin
      .from('warehouses')
      .select('name, code, address')
      .eq('id', row.warehouse_id)
      .maybeSingle(),
    row.delivery_charter_id
      ? admin
          .from('charters')
          .select('name, code')
          .eq('id', row.delivery_charter_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    row.approved_by
      ? admin
          .from('user_profiles')
          .select('full_name, email')
          .eq('id', row.approved_by)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  type ItemRef = { name?: string | null; sku?: string | null };
  type LineRow = {
    quantity_picked: number | null;
    quantity_requested: number | null;
    item: ItemRef | ItemRef[] | null;
  };
  const lines = (linesRes.data ?? []) as LineRow[];
  const lineCount = lines.length;
  const unitCount = lines.reduce((sum, l) => {
    const qty = l.quantity_picked ?? l.quantity_requested ?? 0;
    return sum + (Number(qty) || 0);
  }, 0);
  const items: SummaryLineItem[] = lines.map((l) => {
    const ref = Array.isArray(l.item) ? (l.item[0] ?? null) : l.item;
    return {
      name: ref?.name ?? 'Item',
      sku: ref?.sku ?? '—',
      qty: Number(l.quantity_picked ?? l.quantity_requested ?? 0) || 0,
    };
  });

  type Wh = {
    name?: string;
    code?: string;
    address?: { city?: string; state?: string } | null;
  };
  const wh = (whRes.data ?? null) as Wh | null;
  const shipFrom = wh
    ? `${wh.code ?? wh.name ?? '—'}${wh.address?.city ? ` — ${wh.address.city}` : ''}`
    : null;

  type Ch = { name?: string; code?: string };
  const ch = (charterRes.data ?? null) as Ch | null;
  const isPickup = row.fulfillment_type === 'pickup';
  const shipTo = isPickup
    ? (row.requester_name ?? 'Pickup customer')
    : ch
      ? (ch.code ?? ch.name ?? null)
      : (row.requester_name ?? null);

  type Approver = { full_name?: string | null; email?: string | null };
  const approver = (approverRes.data ?? null) as Approver | null;

  const shipDateIso =
    row.packing_slip_generated_at ?? row.approved_at ?? row.created_at;
  const shipDate = shipDateIso ? fmtDate(shipDateIso) : null;

  return {
    lineCount,
    unitCount,
    shipDate,
    shipFrom,
    shipTo,
    items,
    approverName: approver?.full_name ?? null,
    approverEmail: approver?.email ?? null,
  };
}

// ─── URL builders ────────────────────────────────────────────────────

function buildTrackUrl(
  row: OrderRequestRow,
  appUrl: string,
  recipientEmail: string,
  publicRequestToken: string | null,
): string {
  // B2B portal customers are authenticated but have NO dashboard access — send
  // them to their portal, where their order history lives.
  if (row.source === 'portal') {
    return `${appUrl}/portal`;
  }
  if (row.requester_user_id) {
    return `${appUrl}/dashboard/orders/${row.id}`;
  }
  const base = `${appUrl}/r/track?id=${row.id}&email=${encodeURIComponent(recipientEmail)}`;
  return publicRequestToken
    ? `${base}&t=${encodeURIComponent(publicRequestToken)}`
    : base;
}

/**
 * Where the footer "Manage email preferences"/"Unsubscribe" links and
 * the List-Unsubscribe header point.
 *
 * Signed-in requesters keep the in-app preferences page — they can log
 * in, and their per-event prefs (migration 0113) are the source of
 * truth there.
 *
 * Public-link requesters are ANONYMOUS: the dashboard page dead-ends
 * them on /signin, which broke the unsubscribe promise (and the
 * Gmail/Yahoo bulk-sender requirement). They get the PUBLIC
 * /unsubscribe route instead, signed with an HMAC of the address so
 * the link can't be forged to unsubscribe someone else — and that
 * signed URL supports the RFC 8058 one-click POST (`oneClick`). Falls
 * back to the in-app URL only when UNSUBSCRIBE_SECRET isn't configured
 * (the signer fails closed; see lib/email/unsubscribe.ts).
 */
function buildUnsubscribeUrl(
  row: OrderRequestRow,
  appUrl: string,
  recipientEmail: string,
): { url: string; oneClick: boolean } {
  const inApp = `${appUrl}/dashboard/settings/notifications?email=${encodeURIComponent(recipientEmail)}`;
  if (row.requester_user_id) {
    return { url: inApp, oneClick: false };
  }
  const publicUrl = buildPublicUnsubscribeUrl(appUrl, recipientEmail);
  return publicUrl ? { url: publicUrl, oneClick: true } : { url: inApp, oneClick: false };
}

/**
 * True when the address opted out via the public /unsubscribe page
 * (migration 0222). Fail-OPEN on infra errors — same posture as
 * OrderRequestsService.wantsEmail: silently dropping an order-status
 * email on a DB blip is worse than sending one the recipient opted out
 * of, and dev environments without a service-role key still send their
 * dry-run emails.
 */
async function isPublicEmailUnsubscribed(email: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('public_email_unsubscribes')
      .select('email')
      .eq('email', normalizeUnsubscribeEmail(email))
      .maybeSingle();
    if (error) return false;
    return data != null;
  } catch {
    return false;
  }
}

// ─── View model ──────────────────────────────────────────────────────

interface TemplateArgs {
  kind: OrderRequestEmailKind;
  request: OrderRequestRow;
  recipientEmail: string;
  recipientName: string | null;
  appUrl: string;
  summary: SummaryData;
  trackUrl: string;
  unsubscribeUrl: string;
  publicRequestToken: string | null;
  reasonText: string | null;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function truncateForPreheader(s: string, max = 80): string {
  const t = sanitizePlainText(s);
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Every merge value both renderers need, computed once. All values are
 * PLAIN text — the HTML renderer escapes at interpolation time.
 */
interface OrderEmailView {
  def: ReturnType<typeof esEmailById>;
  /** Work-order handle used in subjects — the existing `WO-` + 8-char pattern. */
  woId: string;
  /** Body display handle: SO-…| falls back to the WO- pattern (existing behavior). */
  displayId: string;
  subject: string;
  preheader: string;
  firstName: string; // '' when unknown → "Hi —" per the design's fallback rule
  isPickup: boolean;
  /** Warehouse label for prose (falls back to "the warehouse"). */
  wh: string;
  /** Warehouse label for grid cells (falls back to em dash). */
  whCell: string;
  /** Destination for prose (falls back to "its destination"). */
  dest: string;
  destCell: string;
  units: number;
  lines: number;
  submittedOn: string;
  approvedAt: string | null;
  dispatchedAt: string;
  eta: string;
  signer: string;
  signedAt: string;
  cancelledOn: string;
  cancelledBy: string;
  shipDate: string;
}

function buildView(a: TemplateArgs): OrderEmailView {
  const def = esEmailById(REGISTRY_ID_BY_KIND[a.kind]);
  const row = a.request;
  const isPickup = row.fulfillment_type === 'pickup';
  const woId = `WO-${row.id.slice(0, 8).toUpperCase()}`;
  const displayId = formatOrderNumber(row.order_number) ?? woId;
  const firstName = (a.recipientName ?? '').trim().split(/\s+/)[0] ?? '';

  const wh = a.summary.shipFrom ?? 'the warehouse';
  const whCell = a.summary.shipFrom ?? '—';
  const dest = a.summary.shipTo ?? 'its destination';
  const destCell = a.summary.shipTo ?? '—';

  const nowIso = new Date().toISOString();
  const submittedOn = fmtDate(row.created_at);
  const approvedAt = row.approved_at ? fmtDateTime(row.approved_at) : null;
  const dispatchedAt = fmtDateTime(row.in_transit_at ?? nowIso);
  // No dedicated ETA column exists; needed_by is the only arrival-shaped
  // date (it already drives the auto schedule event). Fall back to
  // "soon" so the registry preheader still reads as a sentence.
  const eta = row.needed_by ? fmtDate(row.needed_by) : 'soon';
  const signer = row.signed_by_name ?? 'the recipient';
  const signedAt = fmtDateTime(
    row.signed_at ?? row.completed_at ?? row.delivered_at ?? nowIso,
  );
  const cancelledOn = fmtDate(row.cancelled_at ?? nowIso);
  // "the requester" only when we can actually attribute the cancel to them:
  // a null cancelled_by (public self-cancel via tracking link) or an id that
  // matches requester_user_id. Any other authenticated canceller is staff —
  // public-link orders have requester_user_id null, so a team cancel there
  // must NOT read "by the requester".
  const cancelledBy =
    row.cancelled_by && row.cancelled_by !== row.requester_user_id
      ? 'the team'
      : 'the requester';
  const shipDate = a.summary.shipDate ?? 'soon';

  const units = a.summary.unitCount;
  const lines = a.summary.lineCount;

  const subject = def.subject({ orderId: woId });
  const preheader = (() => {
    switch (a.kind) {
      case 'confirm_request':
        return def.preheader({ warehouse: wh, window: '24 hours' });
      case 'submitted':
        return def.preheader({ submittedAt: submittedOn, warehouse: wh });
      case 'approved':
        return def.preheader({ units, lines, shipDate, warehouse: wh });
      case 'denied':
        return def.preheader({
          reasonSummary: a.reasonText
            ? truncateForPreheader(a.reasonText)
            : 'included below',
        });
      case 'in_transit':
        return def.preheader({
          warehouse: wh,
          departedAt: dispatchedAt,
          eta,
          destination: dest,
        });
      case 'completed':
        return def.preheader({ signer, destination: dest, signedAt });
      case 'cancelled':
        return def.preheader({ cancelledOn, by: cancelledBy });
      case 'packing_slip_generated':
        return def.preheader({ lines, warehouse: wh });
      case 'staged_for_delivery':
        return def.preheader({
          location: wh,
          // No pickup-window data exists yet (latent template — flag for
          // the dispatch decision).
          window: 'to be confirmed',
        });
    }
  })();

  return {
    def,
    woId,
    displayId,
    subject,
    preheader,
    firstName,
    isPickup,
    wh,
    whCell,
    dest,
    destCell,
    units,
    lines,
    submittedOn,
    approvedAt,
    dispatchedAt,
    eta,
    signer,
    signedAt,
    cancelledOn,
    cancelledBy,
    shipDate,
  };
}

// ─── HTML template (es-layer composition) ────────────────────────────

// Section paddings, per archetype-order-status.html.
const PAD_INTRO = '36px 36px 24px';
const PAD_HERO = '0 36px 24px';
const PAD_TIMELINE = '0 36px 26px';
const PAD_BANNER = '0 36px 20px';
const PAD_BLOCK = '0 36px 28px';
const PAD_CTA = '0 36px 30px';

const ORDER_STAGES = [
  'Received',
  'Approved',
  'Packing',
  'Ready',
  'In transit',
  'Delivered',
] as const;

/** Full lifecycle path with `current` highlighted; `ORDER_STAGES.length` = all done. */
function stagePath(current: number): TimelineStep[] {
  return ORDER_STAGES.map((label, i) => ({
    label,
    state: i < current ? 'done' : i === current ? 'current' : 'upcoming',
  }));
}

function strongHtml(s: string): string {
  return `<strong style="font-weight:600;color:${ES_LIGHT.ink}">${s}</strong>`;
}

/** "Hi Jane — …" / "Hi — …" (missing-name fallback per the design prompt). */
function hi(firstName: string, escaped: boolean): string {
  const name = escaped ? escapeHtml(firstName) : firstName;
  return firstName ? `Hi ${name} — ` : 'Hi — ';
}

interface KindBody {
  /** `<tr>` rows between the brand strip and the footer. */
  rows: string[];
  /** Shell style hooks (mobile grid rules, dark pill/card overrides). */
  styles: EmailShellStyles;
}

/** The shared Order/Contents/From/To detail grid (mockup `OrderGrid`). */
function orderGrid(
  a: TemplateArgs,
  v: OrderEmailView,
  opts: { reserved?: boolean; approvedSpan?: boolean } = {},
): string {
  const contents = `${v.units} units <span class="ink4" style="color:${ES_LIGHT.ink4};font-weight:400">&middot; ${v.lines} lines</span>`;
  const rows: [DetailCell, DetailCell][] = [
    [
      {
        label: 'Order',
        valueHtml: escapeHtml(v.displayId),
        // Long mono reference — the WO- work-order handle (never the raw
        // row UUID; the design prompt forbids rendering UUIDs). Omitted
        // when the display handle IS the WO- handle already.
        ...(v.displayId !== v.woId
          ? { subHtml: escapeHtml(v.woId), subMono: true }
          : {}),
        strong: true,
      },
      {
        label: opts.reserved ? 'Reserved' : 'Contents',
        valueHtml: contents,
        subHtml: opts.reserved
          ? `Ships ${escapeHtml(v.shipDate)}`
          : `Ships from ${escapeHtml(v.wh)}`,
        strong: true,
      },
    ],
    [
      { label: 'From', valueHtml: escapeHtml(v.whCell) },
      { label: v.isPickup ? 'Pickup' : 'To', valueHtml: escapeHtml(v.destCell) },
    ],
  ];
  const span =
    opts.approvedSpan && v.approvedAt
      ? {
          label: 'Approved',
          valueHtml: `${escapeHtml(v.approvedAt)}${
            a.summary.approverName
              ? ` &middot; by ${escapeHtml(a.summary.approverName)}`
              : ''
          }`,
        }
      : undefined;
  return detailGrid({ rows, span });
}

/**
 * Keep very long orders inside the Gmail clip budget (assertEmailWeight
 * THROWS over 102KB, and every dispatch path swallows that throw — an
 * uncapped table would make big orders silently un-sendable). Mirrors the
 * fulfillment family's MAX_TABLE_LINES.
 */
const MAX_TABLE_LINES = 30;

function itemsTable(a: TemplateArgs, totalLabel: string): string {
  const items = a.summary.items;
  const overflow =
    items.length > MAX_TABLE_LINES
      ? `\n      ${ctaNote(`+ ${items.length - MAX_TABLE_LINES} more lines — the full order is available online.`)}`
      : '';
  return `${itemTable({
    items: items.slice(0, MAX_TABLE_LINES).map((it) => ({
      nameHtml: escapeHtml(it.name),
      sku: escapeHtml(it.sku),
      qty: it.qty,
    })),
    total: { label: totalLabel, valueHtml: String(a.summary.unitCount) },
  })}${overflow}`;
}

function introSection(
  v: OrderEmailView,
  lead: string,
  turn: string,
  proseHtml: string,
): string {
  return section(
    PAD_INTRO,
    [
      statusPill({ variant: v.def.badge.variant, label: v.def.badge.label({}) }),
      headline({ lead, turn }),
      bodyText(proseHtml),
    ].join('\n      '),
  );
}

function motionSection(assetId: string, alt: string): string {
  return section(
    PAD_HERO,
    heroSlot({
      src: esAssetUrl(`motion/${assetId}@2x.gif`),
      alt,
      note: `motion asset: ${assetId}.gif · frame 1 = resting composition · alt text carries the message`,
    }),
  );
}

function ctaSection(
  label: string,
  href: string,
  extras: {
    secondary?: { label: string; href: string };
    noteHtml?: string;
    withLinkFallback?: boolean;
  } = {},
): string {
  const cta = ctaRow({
    primary: { label, href: escapeHtml(href) },
    secondary: extras.secondary
      ? { label: extras.secondary.label, href: escapeHtml(extras.secondary.href) }
      : undefined,
    noteHtml: extras.noteHtml,
  });
  const fallback = extras.withLinkFallback ? linkFallback(escapeHtml(href)) : '';
  return section(PAD_CTA, `${cta}${fallback ? `\n      ${fallback}` : ''}`);
}

function buildKindBody(a: TemplateArgs, v: OrderEmailView): KindBody {
  const supportUrl = `${a.appUrl}/support`;
  const showGrid = a.summary.lineCount > 0;
  const showItems = a.summary.items.length > 0;
  const gridStyles = (pills: EsStatusVariant[], cards = false): EmailShellStyles => ({
    mobileExtras: MOBILE_GRID_RULES,
    darkPills: pills,
    ...(cards ? { darkCards: '.card' } : {}),
  });

  switch (a.kind) {
    case 'confirm_request': {
      const prose = v.isPickup
        ? `${hi(v.firstName, true)}you drafted this request for pickup from ${strongHtml(escapeHtml(v.wh))}. Confirm it and the warehouse gets to work. Until then, nothing is reserved and nothing ships.`
        : `${hi(v.firstName, true)}you drafted this request for ${strongHtml(escapeHtml(v.dest))}. Confirm it and ${escapeHtml(v.wh)} gets to work. Until then, nothing is reserved and nothing ships.`;
      return {
        rows: [
          // Registry: motion "None · static hold state".
          introSection(v, `One tap sends ${escapeHtml(v.displayId)}.`, 'The warehouse hasn’t seen it yet.', prose),
          section(
            PAD_TIMELINE,
            orderTimeline({
              // Confirm precedes the warehouse lifecycle — the mockup's
              // shortened path (no Packing/Ready stages before receipt).
              steps: [
                { label: 'Confirm', state: 'current' },
                { label: 'Received', state: 'upcoming' },
                { label: 'Approved', state: 'upcoming' },
                { label: 'In transit', state: 'upcoming' },
                { label: 'Delivered', state: 'upcoming' },
              ],
              tone: 'warn',
            }),
          ),
          ...(showGrid ? [section(PAD_BLOCK, orderGrid(a, v))] : []),
          ctaSection(v.def.cta, a.trackUrl, {
            noteHtml: `Unconfirmed requests expire after <strong style="font-weight:600;color:${ES_LIGHT.ink2}">24 hours</strong> and nothing is sent to the warehouse.`,
            withLinkFallback: true,
          }),
          section(
            PAD_BLOCK,
            infoCard({
              titleHtml: 'Didn’t create this request?',
              bodyHtml: `Ignore this email and the draft expires on its own. If requests you didn’t draft keep appearing, <a href="${escapeHtml(supportUrl)}" style="color:${ES_LIGHT.ink2};text-decoration:underline">tell support</a>.`,
            }),
          ),
        ],
        styles: gridStyles(['warn'], true),
      };
    }

    case 'submitted': {
      // Registry motion "L2 · Timeline tick": the MOTION board never had a
      // timeline-tick asset, so one was produced in-house (motion/tick) —
      // an animated dot on the RECEIVED timeline step, not a hero slot.
      // This stays the email's ONLY motion (one asset per email).
      const prose = `${hi(v.firstName, true)}your request landed at ${strongHtml(escapeHtml(v.wh))} on ${escapeHtml(v.submittedOn)}. Next step: a quick approval, usually within one business day.`;
      return {
        rows: [
          introSection(v, `${escapeHtml(v.displayId)} received.`, 'We’re on it.', prose),
          section(
            PAD_TIMELINE,
            orderTimeline({
              steps: stagePath(0),
              tone: 'info',
              currentDotImgSrc: esAssetUrl('motion/tick@2x.gif'),
            }),
          ),
          ...(showGrid ? [section(PAD_BLOCK, orderGrid(a, v))] : []),
          ctaSection(v.def.cta, a.trackUrl, {
            noteHtml:
              'You’ll get one email per meaningful step — approval, dispatch, delivery. No noise in between.',
          }),
        ],
        styles: gridStyles(['info']),
      };
    }

    case 'approved': {
      const prose = `${hi(v.firstName, true)}we’ve reserved every unit on this request. You’ll get another note the moment it leaves the dock.`;
      return {
        rows: [
          introSection(v, `${escapeHtml(v.displayId)} is approved.`, 'Packing starts now.', prose),
          motionSection(
            'settle',
            'Three cartons settle into a row — your order is reserved and moving to packing',
          ),
          section(PAD_TIMELINE, orderTimeline({ steps: stagePath(1), tone: 'ok' })),
          ...(showGrid
            ? [section(PAD_BLOCK, orderGrid(a, v, { reserved: true, approvedSpan: true }))]
            : []),
          ctaSection(v.def.cta, a.trackUrl, { withLinkFallback: true }),
        ],
        styles: gridStyles(['ok']),
      };
    }

    case 'denied': {
      const prose = `${hi(v.firstName, true)}your request didn’t clear approval this time. Nothing was reserved or shipped. The reason is below, unedited, with two ways forward.`;
      return {
        rows: [
          // Registry: motion "None — intentionally static". Nothing
          // celebratory, nothing animated, on a negative state.
          introSection(v, `${escapeHtml(v.displayId)} wasn’t approved.`, 'Here’s exactly why.', prose),
          section(
            PAD_TIMELINE,
            orderTimeline({
              steps: [
                { label: 'Received', state: 'done' },
                { label: 'Review', state: 'done' },
                { label: 'Not approved', state: 'terminal' },
              ],
              tone: 'err',
            }),
          ),
          ...(a.reasonText
            ? [
                section(
                  PAD_BANNER,
                  // Reason VERBATIM (escaped only) in a tonal err banner —
                  // never full-red styling.
                  banner({
                    tone: 'err',
                    titleHtml: a.summary.approverName
                      ? `Reason — from ${escapeHtml(a.summary.approverName)}`
                      : 'Reason',
                    bodyHtml: escapeHtml(a.reasonText),
                  }),
                ),
              ]
            : []),
          ...(showGrid ? [section(PAD_BLOCK, orderGrid(a, v))] : []),
          ctaSection(v.def.cta, a.trackUrl, {
            secondary: a.summary.approverEmail
              ? { label: v.def.cta2 ?? 'Contact approver', href: `mailto:${a.summary.approverEmail}` }
              : undefined,
            noteHtml:
              'Revising keeps your line items — adjust quantities and resubmit in about a minute.',
          }),
        ],
        styles: gridStyles(['err']),
      };
    }

    case 'in_transit': {
      const prose = `${hi(v.firstName, true)}your order left ${strongHtml(escapeHtml(v.wh))} at ${escapeHtml(v.dispatchedAt)} and is headed to ${escapeHtml(v.dest)}.`;
      const grid = detailGrid({
        rows: [
          [
            {
              label: 'Dispatched',
              valueHtml: escapeHtml(v.dispatchedAt),
              subHtml: escapeHtml(v.whCell),
              strong: true,
            },
            {
              label: 'Method',
              valueHtml: v.isPickup ? 'Pickup' : 'Delivery',
              strong: true,
            },
          ],
          [
            { label: 'Destination', valueHtml: escapeHtml(v.destCell) },
            { label: 'Estimated arrival', valueHtml: escapeHtml(v.eta) },
          ],
        ],
      });
      return {
        rows: [
          introSection(v, `${escapeHtml(v.displayId)} is on the way.`, `Estimated ${escapeHtml(v.eta)}.`, prose),
          motionSection('route', `Route progress: package en route to ${escapeHtml(v.destCell)}`),
          section(PAD_TIMELINE, orderTimeline({ steps: stagePath(4), tone: 'info' })),
          section(PAD_BLOCK, grid),
          ctaSection(v.def.cta, a.trackUrl, { withLinkFallback: true }),
          section(
            PAD_BLOCK,
            helpRow(
              `Delivery question? Contact ${escapeHtml(v.wh)} dispatch from the order page — replies to this email aren’t monitored.`,
            ),
          ),
        ],
        styles: gridStyles(['info']),
      };
    }

    case 'completed': {
      const prose = `${hi(v.firstName, true)}the full order arrived at ${strongHtml(escapeHtml(v.dest))} and was signed for by ${escapeHtml(v.signer)} at ${escapeHtml(v.signedAt)}. Thanks for routing it through StockPilot.`;
      return {
        rows: [
          introSection(v, `${escapeHtml(v.displayId)} was delivered.`, 'Signed, received, done.', prose),
          motionSection('check', `Checkmark draws complete — ${v.displayId} was delivered`),
          section(
            PAD_TIMELINE,
            orderTimeline({ steps: stagePath(ORDER_STAGES.length), tone: 'ok' }),
          ),
          ...(showItems ? [section(PAD_BLOCK, itemsTable(a, 'Total units'))] : []),
          ctaSection(v.def.cta, a.trackUrl),
        ],
        styles: gridStyles(['ok'], showItems),
      };
    }

    case 'cancelled': {
      // Neutral, factual treatment — no motion, nothing celebratory.
      const releasedClause =
        v.units > 0
          ? `All ${v.units} reserved units went back to stock; nothing shipped and nothing partial is outstanding.`
          : 'Nothing was reserved, nothing shipped, and nothing partial is outstanding.';
      const prose = `${hi(v.firstName, true)}this request was cancelled on ${escapeHtml(v.cancelledOn)} by ${escapeHtml(v.cancelledBy)}. ${releasedClause}`;
      const newRequestHref = a.request.requester_user_id
        ? `${a.appUrl}/dashboard/orders/new`
        : a.publicRequestToken
          ? `${a.appUrl}/r/${a.publicRequestToken}`
          : null;
      const grid = detailGrid({
        rows: [
          [
            {
              label: 'Cancelled',
              valueHtml: escapeHtml(v.cancelledOn),
              subHtml: `By ${escapeHtml(v.cancelledBy)}`,
              strong: true,
            },
            v.units > 0
              ? {
                  label: 'Inventory impact',
                  valueHtml: 'Units released',
                  subHtml: 'Back to available stock',
                  strong: true,
                }
              : {
                  label: 'Inventory impact',
                  valueHtml: 'None',
                  subHtml: 'Nothing was reserved',
                  strong: true,
                },
          ],
        ],
      });
      return {
        rows: [
          introSection(v, `${escapeHtml(v.displayId)} was cancelled.`, 'Nothing further to do.', prose),
          section(
            PAD_TIMELINE,
            orderTimeline({
              // Only stages that actually happened — no Approved dot on a
              // request cancelled before approval.
              steps: [
                { label: 'Received', state: 'done' },
                ...(a.request.approved_at
                  ? [{ label: 'Approved', state: 'done' } satisfies TimelineStep]
                  : []),
                { label: 'Cancelled', state: 'terminal' },
              ],
              tone: 'neutral',
            }),
          ),
          section(PAD_BLOCK, grid),
          ctaSection(v.def.cta, a.trackUrl, {
            secondary: newRequestHref
              ? { label: v.def.cta2 ?? 'Start a new request', href: newRequestHref }
              : undefined,
          }),
        ],
        styles: gridStyles(['neutral']),
      };
    }

    case 'packing_slip_generated': {
      // LATENT: dispatch decision pending (see policy audit).
      const prose = `${hi(v.firstName, true)}${escapeHtml(v.wh)} is picking and packing your ${v.lines} lines now. Next you’ll hear from us when it’s staged for delivery.`;
      return {
        rows: [
          introSection(v, `${escapeHtml(v.displayId)} is being packaged.`, 'Boxes, labels, tape.', prose),
          motionSection(
            'scanner',
            'Scanner sweeps a carton barcode — your order is being picked and packed',
          ),
          section(PAD_TIMELINE, orderTimeline({ steps: stagePath(2), tone: 'info' })),
          ...(showItems ? [section(PAD_BLOCK, itemsTable(a, 'Units being prepared'))] : []),
          ctaSection(v.def.cta, a.trackUrl),
        ],
        styles: gridStyles(['info'], showItems),
      };
    }

    case 'staged_for_delivery': {
      // LATENT: dispatch decision pending (see policy audit).
      const locNote = a.request.pickup_location_notes;
      const prose = `${hi(v.firstName, true)}your order is packed, checked, and staged at ${strongHtml(escapeHtml(v.wh))}. It’s ready for the pickup window below.`;
      const grid = detailGrid({
        rows: [
          [
            {
              label: 'Location',
              valueHtml: `${escapeHtml(v.whCell)}${locNote ? ` &middot; ${escapeHtml(locNote)}` : ''}`,
              strong: true,
            },
            // No pickup-window data exists yet — placeholder until the
            // dispatch decision wires real scheduling in.
            { label: 'Pickup window', valueHtml: 'To be confirmed', strong: true },
          ],
          [
            {
              label: 'Bring',
              valueHtml: 'Work-order ID',
              subHtml: escapeHtml(v.woId),
              subMono: true,
            },
            {
              label: 'Contents',
              valueHtml: `${v.units} units <span class="ink4" style="color:${ES_LIGHT.ink4};font-weight:400">&middot; ${v.lines} lines</span>`,
            },
          ],
        ],
      });
      return {
        rows: [
          introSection(
            v,
            `${escapeHtml(v.displayId)} is ready.`,
            `Staged at ${escapeHtml(locNote ?? v.wh)}.`,
            prose,
          ),
          motionSection(
            'pin',
            'Location pin drops onto the dock line — your order is staged and ready',
          ),
          section(PAD_TIMELINE, orderTimeline({ steps: stagePath(3), tone: 'ok' })),
          section(PAD_BLOCK, grid),
          section(
            PAD_BANNER,
            banner({
              tone: 'warn',
              titleHtml: 'Signature required at the dock office',
              bodyHtml:
                'Whoever picks up signs against the work-order ID — they don’t need a StockPilot account.',
            }),
          ),
          ctaSection(v.def.cta, a.trackUrl),
        ],
        styles: gridStyles(['ok', 'warn']),
      };
    }
  }
}

function renderHtml(a: TemplateArgs): string {
  const v = buildView(a);
  const body = buildKindBody(a, v);
  const supportUrl = `${a.appUrl}/support`;

  const emailSpan = `<span class="ink2" style="color:${ES_LIGHT.ink2};text-decoration:underline">${escapeHtml(a.recipientEmail)}</span>`;
  const foot =
    v.def.footer === 'ess'
      ? footer({
          kind: 'ess',
          reasonHtml: `Confirmation requests are part of placing an order and are sent to the requester, ${emailSpan}.`,
          urls: {
            support: supportUrl,
            privacy: `${a.appUrl}/privacy`,
            terms: `${a.appUrl}/terms`,
          },
        })
      : footer({
          kind: 'pref',
          reasonHtml: `Order-status updates for requests placed by ${emailSpan}.`,
          urls: {
            manage: escapeHtml(a.unsubscribeUrl),
            unsubscribe: escapeHtml(a.unsubscribeUrl),
            support: supportUrl,
          },
        });

  return emailShell({
    title: escapeHtml(v.subject),
    preheader: escapeHtml(v.preheader),
    preheaderPad: 8,
    styles: body.styles,
    rows: [brandStrip({ tag: v.def.tag }), ...body.rows, foot].join('\n\n    '),
  });
}

// ─── Plaintext fallback ──────────────────────────────────────────────

function renderText(a: TemplateArgs): string {
  const v = buildView(a);
  const greet = hi(v.firstName, false);

  const heads: Record<OrderRequestEmailKind, [string, string]> = {
    confirm_request: [`One tap sends ${v.displayId}.`, 'The warehouse hasn’t seen it yet.'],
    submitted: [`${v.displayId} received.`, 'We’re on it.'],
    approved: [`${v.displayId} is approved.`, 'Packing starts now.'],
    denied: [`${v.displayId} wasn’t approved.`, 'Here’s exactly why.'],
    in_transit: [`${v.displayId} is on the way.`, `Estimated ${v.eta}.`],
    completed: [`${v.displayId} was delivered.`, 'Signed, received, done.'],
    cancelled: [`${v.displayId} was cancelled.`, 'Nothing further to do.'],
    packing_slip_generated: [`${v.displayId} is being packaged.`, 'Boxes, labels, tape.'],
    staged_for_delivery: [`${v.displayId} is ready.`, 'Staged and waiting.'],
  };
  const prose: Record<OrderRequestEmailKind, string> = {
    confirm_request: v.isPickup
      ? `${greet}you drafted this request for pickup from ${v.wh}. Confirm it and the warehouse gets to work. Until then, nothing is reserved and nothing ships.`
      : `${greet}you drafted this request for ${v.dest}. Confirm it and ${v.wh} gets to work. Until then, nothing is reserved and nothing ships.`,
    submitted: `${greet}your request landed at ${v.wh} on ${v.submittedOn}. Next step: a quick approval, usually within one business day.`,
    approved: `${greet}we’ve reserved every unit on this request. You’ll get another note the moment it leaves the dock.`,
    denied: `${greet}your request didn’t clear approval this time. Nothing was reserved or shipped. The reason is below, unedited.`,
    in_transit: `${greet}your order left ${v.wh} at ${v.dispatchedAt} and is headed to ${v.dest}.`,
    completed: `${greet}the full order arrived at ${v.dest} and was signed for by ${v.signer} at ${v.signedAt}. Thanks for routing it through StockPilot.`,
    cancelled: `${greet}this request was cancelled on ${v.cancelledOn} by ${v.cancelledBy}. ${
      v.units > 0
        ? `All ${v.units} reserved units went back to stock; nothing shipped and nothing partial is outstanding.`
        : 'Nothing was reserved, nothing shipped, and nothing partial is outstanding.'
    }`,
    packing_slip_generated: `${greet}${v.wh} is picking and packing your ${v.lines} lines now. Next you’ll hear from us when it’s staged for delivery.`,
    staged_for_delivery: `${greet}your order is packed, checked, and staged at ${v.wh}. It’s ready for pickup.`,
  };

  const [lead, turn] = heads[a.kind];
  const lines: string[] = [];
  lines.push(`StockPilot — ${lead} ${turn}`);
  lines.push('');
  lines.push(prose[a.kind]);

  if (a.kind === 'denied' && a.reasonText) {
    lines.push('');
    lines.push(
      `Reason${a.summary.approverName ? ` — from ${a.summary.approverName}` : ''}: ${sanitizePlainText(a.reasonText)}`,
    );
  }

  if (a.summary.lineCount > 0 && a.kind !== 'cancelled') {
    lines.push('');
    lines.push('— Order summary —');
    lines.push(`Order: ${v.displayId}${v.displayId !== v.woId ? ` (${v.woId})` : ''}`);
    lines.push(`Contents: ${v.units} units across ${v.lines} lines`);
    if (a.summary.shipDate) lines.push(`Ships: ${a.summary.shipDate}`);
    if (a.summary.shipFrom) lines.push(`From: ${a.summary.shipFrom}`);
    if (a.summary.shipTo) lines.push(`${v.isPickup ? 'Pickup' : 'To'}: ${a.summary.shipTo}`);
    if (a.kind === 'approved' && v.approvedAt) {
      lines.push(
        `Approved: ${v.approvedAt}${a.summary.approverName ? ` by ${a.summary.approverName}` : ''}`,
      );
    }
    if (a.kind === 'in_transit') {
      lines.push(`Dispatched: ${v.dispatchedAt}`);
      lines.push(`Estimated arrival: ${v.eta}`);
    }
  }

  if (
    (a.kind === 'completed' || a.kind === 'packing_slip_generated') &&
    a.summary.items.length > 0
  ) {
    lines.push('');
    lines.push('— Items —');
    for (const it of a.summary.items) {
      lines.push(`${it.name} (${it.sku}) × ${it.qty}`);
    }
    lines.push(`Total units: ${v.units}`);
  }

  lines.push('');
  lines.push(`${v.def.cta}: ${a.trackUrl}`);
  if (a.kind === 'confirm_request') {
    lines.push('');
    lines.push(
      'Unconfirmed requests expire after 24 hours and nothing is sent to the warehouse. If you didn’t create this request, you can safely ignore this email.',
    );
  }
  lines.push('');
  lines.push('—');
  lines.push('StockPilot · Inventory + Order Management · stockpilotusa.com');
  if (a.kind === 'confirm_request') {
    // Essential mail: no unsubscribe promise in the body (matches the
    // ess footer in the HTML twin).
    lines.push(`Support: ${a.appUrl}/support`);
  } else {
    lines.push(`Manage notifications: ${a.unsubscribeUrl}`);
  }
  return lines.join('\n');
}

// ─── Public entry ────────────────────────────────────────────────────

export async function sendOrderRequestEmail(input: SendInput): Promise<void> {
  const {
    kind,
    request,
    recipientEmail,
    recipientName,
    appUrl,
    publicRequestToken,
    confirmationToken,
  } = input;

  if (kind === 'confirm_request' && !confirmationToken) {
    throw new Error(
      'confirm_request email requires a confirmationToken — refusing to send empty CTA.',
    );
  }

  // LATENT: dispatch decision pending (see policy audit). The packing +
  // staged templates are fully designed and render (their tests exercise
  // them with the flag set), but NOTHING may dispatch them until product
  // decides — this guard keeps a future caller from flipping them on by
  // accident. Fail-closed: skip, loudly.
  if (LATENT_KINDS.has(kind) && process.env.ES_LATENT_ORDER_EMAILS !== '1') {
    console.warn(
      `[order-requests] email kind "${kind}" is LATENT (dispatch decision pending) — skipping send. Set ES_LATENT_ORDER_EMAILS=1 only after the policy decision.`,
    );
    return;
  }

  // Public-recipient suppression list (migration 0222). Anonymous
  // requesters have no notification_preferences row, so /unsubscribe
  // clicks land in public_email_unsubscribes — honor them here, the
  // single choke point every order-request email flows through.
  // `confirm_request` is exempt on purpose: it's the double-opt-in
  // consent email the requester just triggered by submitting the form,
  // and suppressing it would silently brick their request ("check your
  // email" … nothing ever arrives); nothing further can be sent unless
  // they DO confirm. Signed-in requesters are governed by their in-app
  // prefs instead (OrderRequestsService.wantsEmail).
  if (!request.requester_user_id && kind !== 'confirm_request') {
    if (await isPublicEmailUnsubscribed(recipientEmail)) return;
  }

  const summary = await fetchSummary(request);

  const trackUrl =
    kind === 'confirm_request' && confirmationToken
      ? `${appUrl}/r/confirm?id=${request.id}&t=${encodeURIComponent(confirmationToken)}`
      : buildTrackUrl(request, appUrl, recipientEmail, publicRequestToken ?? null);
  const unsubscribe = buildUnsubscribeUrl(request, appUrl, recipientEmail);

  const reasonText =
    (kind === 'denied' || kind === 'cancelled') && request.denied_reason
      ? request.denied_reason
      : null;

  const args: TemplateArgs = {
    kind,
    request,
    recipientEmail,
    recipientName,
    appUrl,
    summary,
    trackUrl,
    unsubscribeUrl: unsubscribe.url,
    publicRequestToken: publicRequestToken ?? null,
    reasonText,
  };

  const def = esEmailById(REGISTRY_ID_BY_KIND[kind]);
  const html = renderHtml(args);
  const text = renderText(args);
  // Subject: registry builder fed the existing `WO-` + 8-char handle —
  // byte-identical copy, unchanged id semantics.
  const subject = def.subject({
    orderId: `WO-${request.id.slice(0, 8).toUpperCase()}`,
  });

  // Gmail clips past ~102KB and hides the unsubscribe footer — refuse to
  // send an over-budget render (tests keep this from ever firing).
  assertEmailWeight(html);

  // RFC 2369/8058 unsubscribe headers. For public recipients the signed
  // /unsubscribe URL accepts the provider's one-click POST directly, so
  // advertise `List-Unsubscribe-Post`. The in-app (signed-in) link is a
  // page behind login that ignores POSTs — advertising one-click there
  // would make Gmail POST into the void and report success, so those
  // recipients get the plain header only.
  await sendEmail({
    to: recipientEmail,
    subject,
    html,
    text,
    from: def.from,
    headers: unsubscribe.oneClick
      ? {
          'List-Unsubscribe': `<${unsubscribe.url}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : { 'List-Unsubscribe': `<${unsubscribe.url}>` },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sanitizePlainText(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

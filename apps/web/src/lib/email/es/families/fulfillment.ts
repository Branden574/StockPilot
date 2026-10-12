/**
 * StockPilot email system — Fulfillment & Returns family (Unit E5).
 *
 * Four live templates composed EXCLUSIVELY from the es component layer:
 *
 *   partial          Partially Fulfilled       pref  · static (see flag)
 *   back-shipped     Backordered Items Shipped pref  · route motion
 *   partial-receipt  Partial Delivery Receipt  ext   · static (receipts)
 *   return-prompt    Return Prompt             pref  · reverse motion
 *
 * Subjects / preheaders / badges / CTA labels are produced through the
 * registry entries (lib/email/es/registry.ts) so they stay byte-identical
 * to the design package. Body copy follows docs/design/email-system/
 * es-fulfillment.jsx; every runtime merge value gets an elegant fallback
 * (missing first name → "Hi —", missing ETA → the clause is elided) and
 * is escaped before interpolation.
 *
 * FLAG (motion): the registry lists "L2 · Split progress" for `partial`,
 * but the MOTION asset board has no such asset — the email ships STATIC
 * until the board gains one (registry.ts carries the same flag).
 *
 * FLAG (suppression divergence, from the registry): public order emails
 * (this family) follow different suppression behavior than account
 * emails — the sendOrderRequestEmail choke point consults
 * public_email_unsubscribes, while the hand-over/back-order senders only
 * honor the requester's email_order_completed preference. Surfaced for
 * product; deliberately NOT changed here (wiring keeps the existing
 * suppression exactly).
 */

import { buildPublicUnsubscribeUrl } from '../../unsubscribe';
import {
  MOBILE_GRID_RULES,
  MOBILE_KPI_RULES,
  bodyText,
  brandStrip,
  ctaNote,
  ctaRow,
  detailGrid,
  detailRows,
  emailShell,
  escapeHtml,
  footer,
  headline,
  heroSlot,
  itemTable,
  kpiGrid,
  linkFallback,
  section,
  statusPill,
} from '../components';
import { esEmailById } from '../registry';
import { ES_LIGHT, esAssetUrl } from '../tokens';

import type { ItemTableRow } from '../components';

// ── Shared shapes ───────────────────────────────────────────────────

export interface RenderedEmail {
  subject: string;
  preheader: string;
  html: string;
  text: string;
}

/** One order line as the fulfillment templates consume it. */
export interface FulfillmentLineItem {
  name: string;
  sku: string | null;
  qtyRequested: number;
  qtyFulfilled: number;
}

/**
 * Keep very long orders inside the Gmail clip budget: the per-line table
 * renders at most this many rows, then a "+ N more lines" note.
 */
const MAX_TABLE_LINES = 30;

export interface PrefFooterUrls {
  manage: string;
  unsubscribe: string;
  support: string;
}

export interface PrefEmailDelivery {
  urls: PrefFooterUrls;
  /** RFC 2369/8058 headers for sendEmail (List-Unsubscribe[-Post]). */
  headers: Record<string, string>;
}

/**
 * Footer links + List-Unsubscribe headers for the preference-controlled
 * templates. Mirrors the order-request choke point's semantics
 * (lib/email/order-requests.ts buildUnsubscribeUrl) without reaching
 * into that module (Unit E4 owns its internals):
 *
 *   - account holders → the in-app notification settings page; plain
 *     List-Unsubscribe only (the page is behind login and ignores
 *     one-click POSTs — advertising RFC 8058 there would let Gmail POST
 *     into the void and report success);
 *   - public (anonymous) requesters → the signed public /unsubscribe
 *     URL with the one-click POST header pair. Falls back to the in-app
 *     link when UNSUBSCRIBE_SECRET is unset (the signer fails closed).
 */
export function buildPrefEmailDelivery(args: {
  appUrl: string;
  recipientEmail: string;
  isAccountHolder: boolean;
}): PrefEmailDelivery {
  const base = args.appUrl.replace(/\/+$/, '');
  const inApp = `${base}/dashboard/settings/notifications?email=${encodeURIComponent(args.recipientEmail)}`;
  const support = `${base}/support`;
  const publicUrl = args.isAccountHolder
    ? null
    : buildPublicUnsubscribeUrl(base, args.recipientEmail);
  const url = publicUrl ?? inApp;
  return {
    urls: { manage: url, unsubscribe: url, support },
    headers: publicUrl
      ? {
          'List-Unsubscribe': `<${publicUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : { 'List-Unsubscribe': `<${inApp}>` },
  };
}

export const FULFILLMENT_ORDERS_FROM = 'StockPilot <orders@stockpilotusa.com>';

/**
 * Display-from for the signer receipt — "<supplier> via StockPilot
 * <orders@stockpilotusa.com>" per the registry (whose sample world reads
 * "L4L North Region via StockPilot <...>"). Org names stay unquoted when
 * they are a plain RFC-5322 phrase (matching the registry byte-form) and
 * get display-name quoting only when they carry specials. Falls back to
 * the plain StockPilot sender when the org name is unavailable.
 *
 * FLAG (reply-to): the registry intent is "Replies go to the supplier",
 * but no supplier contact address exists in the data model — replies
 * default to the orders@ sender. Owner decision needed.
 */
export function buildViaStockPilotFrom(orgName: string | null | undefined): string {
  const cleaned = (orgName ?? '').replace(/[\r\n<>"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return FULFILLMENT_ORDERS_FROM;
  const display = `${cleaned} via StockPilot`;
  const needsQuoting = !/^[A-Za-z0-9 .\-']+$/.test(display);
  const phrase = needsQuoting ? `"${display}"` : display;
  return `${phrase} <orders@stockpilotusa.com>`;
}

// ── Local helpers ───────────────────────────────────────────────────

/**
 * First word of whatever the caller handed us — idempotent on a name that
 * is ALREADY a first name.
 *
 * WHY this family splits and the sibling family does not: every live
 * caller of these renderers passes a FULL name. server/lib/order-handover
 * -notify.ts sends `args.requesterName` and server/email/return-prompt.ts
 * sends `order.requester_name`, both into `recipientFirstName`. The
 * sibling es/families/maintenance.ts greeting takes the WHOLE string on
 * purpose (its callers pre-split with their own local `firstNameOf`), so
 * the two shapes look like drift but are not interchangeable: aligning
 * this family to that one would greet real people "Hi Jane Doe —" in
 * every handover and return-prompt email. Do not "simplify" it — the
 * greeting-contract tests in fulfillment.test.ts fail if you do.
 *
 * Single-sourced because the html and text greetings were two separate
 * copies of this line (recurring pattern #26: a fix or a change applied
 * to one copy of a duplicated function is not applied at all — the text
 * half in particular had no test covering it).
 */
function firstNameOf(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

/** "Hi Reggie —" / "Hi —" greeting (constraint: no first name → "Hi —"). */
function greeting(firstName: string | null | undefined): string {
  const first = firstNameOf(firstName);
  return first ? `Hi ${escapeHtml(first)} —` : 'Hi —';
}

/** Plain-text twin of `greeting` — same name rule, no escaping. */
function greetingText(firstName: string | null | undefined): string {
  const first = firstNameOf(firstName);
  return first ? `Hi ${first} —` : 'Hi —';
}

const strong = (html: string): string =>
  `<strong class="ink" style="font-weight:600;color:${ES_LIGHT.ink}">${html}</strong>`;

function lineBackordered(l: FulfillmentLineItem): number {
  return Math.max(0, l.qtyRequested - l.qtyFulfilled);
}

/** Per-line table rows; `pendingWord` = "backordered" (partial) | "pending" (receipt). */
function lineTableRows(
  items: FulfillmentLineItem[],
  okLabel: string,
  pendingWord: string,
): ItemTableRow[] {
  return items.slice(0, MAX_TABLE_LINES).map((l) => {
    const back = lineBackordered(l);
    return {
      nameHtml: escapeHtml(l.name),
      sku: escapeHtml(l.sku ?? '—'),
      qty: l.qtyFulfilled,
      status:
        back > 0
          ? { variant: 'warn' as const, label: `${back} ${pendingWord}` }
          : { variant: 'ok' as const, label: okLabel },
    };
  });
}

function lineTableSection(
  items: FulfillmentLineItem[] | undefined,
  okLabel: string,
  pendingWord: string,
): string {
  if (!items || items.length === 0) return '';
  const overflow =
    items.length > MAX_TABLE_LINES
      ? `\n      ${ctaNote(`+ ${items.length - MAX_TABLE_LINES} more lines — the full order is available online.`)}`
      : '';
  return section(
    '0 36px 28px',
    `${itemTable({ items: lineTableRows(items, okLabel, pendingWord) })}${overflow}`,
  );
}

function lineTextRows(
  items: FulfillmentLineItem[] | undefined,
  okLabel: string,
  pendingWord: string,
): string[] {
  if (!items || items.length === 0) return [];
  const rows = items.slice(0, MAX_TABLE_LINES).map((l) => {
    const back = lineBackordered(l);
    const status = back > 0 ? `${back} ${pendingWord}` : okLabel;
    return `- ${l.name}${l.sku ? ` (${l.sku})` : ''} x${l.qtyFulfilled} — ${status}`;
  });
  if (items.length > MAX_TABLE_LINES) {
    rows.push(`+ ${items.length - MAX_TABLE_LINES} more lines`);
  }
  return rows;
}

function prefFooterText(reason: string, urls: PrefFooterUrls): string {
  return [
    reason,
    'Unsubscribing stops this notification type only — security and account emails still arrive.',
    `Manage email preferences: ${urls.manage}`,
    `Unsubscribe: ${urls.unsubscribe}`,
  ].join('\n');
}

// ── 1 · Partially Fulfilled (`partial`) ─────────────────────────────

export interface PartialFulfilledParams {
  /** Display handle, e.g. "#7741-2205" / "#A1B2C3D4". */
  orderNumber: string;
  recipientFirstName?: string | null;
  recipientEmail: string;
  /**
   * Unit counts. All three null when the caller could not read the order's
   * line totals: the email then says part of the order arrived and the rest
   * is backordered, with no numbers and no stat cards. "0 of 0 delivered"
   * would be a wrong statement, not a degraded one.
   */
  delivered: number | null;
  requested: number | null;
  backordered: number | null;
  /** Short signed date for the Delivered stat card, e.g. "Apr 29". */
  deliveredOn?: string | null;
  /** Backorder ETA (no runtime source today — falls back gracefully). */
  backorderEta?: string | null;
  items?: FulfillmentLineItem[];
  orderUrl: string;
  urls: PrefFooterUrls;
}

export function renderPartialFulfilledEmail(p: PartialFulfilledParams): RenderedEmail {
  if (p.delivered == null || p.requested == null || p.backordered == null) {
    return renderPartialFulfilledWithoutCounts(p);
  }
  const def = esEmailById('partial');
  const subject = def.subject({ orderNumber: p.orderNumber });
  const preheader = p.backorderEta
    ? def.preheader({
        delivered: p.delivered,
        total: p.requested,
        back: p.backordered,
        eta: p.backorderEta,
      })
    : // Missing-ETA fallback: the registry preheader minus its ETA clause.
      `${p.delivered} of ${p.requested} units delivered. ${p.backordered} backordered.`;

  const hi = greeting(p.recipientFirstName);
  const backClause = p.backorderEta
    ? `The remaining ${p.backordered} units are backordered &mdash; expected ${escapeHtml(p.backorderEta)}.`
    : `The remaining ${p.backordered} units are backordered and will ship as soon as they&rsquo;re back in stock.`;
  const body = `${hi} ${strong(`${p.delivered} of ${p.requested} units`)} were delivered and signed for. ${backClause}`;

  const stats = kpiGrid([
    {
      label: 'Delivered',
      valueHtml: String(p.delivered),
      noteHtml: p.deliveredOn ? `units &middot; signed ${escapeHtml(p.deliveredOn)}` : 'units',
      tone: 'ok',
    },
    {
      label: 'Backordered',
      valueHtml: String(p.backordered),
      noteHtml: p.backorderEta ? `units &middot; expected ${escapeHtml(p.backorderEta)}` : 'units',
      tone: 'warn',
    },
  ]);

  const rows = [
    brandStrip({ tag: def.tag }),
    section(
      '36px 36px 24px',
      `${statusPill({ variant: def.badge.variant, label: def.badge.label({}) })}
      ${headline({ lead: `Most of ${escapeHtml(p.orderNumber)} has arrived.`, turn: 'The rest is on backorder.' })}
      ${bodyText(body)}`,
    ),
    // FLAG: registry motion "L2 · Split progress" has no MOTION-board
    // asset — static until one exists (see module header).
    section('0 36px 28px', stats),
    lineTableSection(p.items, 'Delivered', 'backordered'),
    section(
      '0 36px 30px',
      ctaRow({
        primary: { label: def.cta, href: p.orderUrl },
        noteHtml:
          'No action needed &mdash; backordered units ship automatically and you&rsquo;ll get a dispatch note with tracking.',
      }),
    ),
    footer({
      kind: def.footer,
      reasonHtml: `Order-status updates for orders placed by ${escapeHtml(p.recipientEmail)}.`,
      urls: p.urls,
    }),
  ].join('\n    ');

  const html = emailShell({
    title: escapeHtml(subject),
    preheader: escapeHtml(preheader),
    styles: {
      mobileExtras: MOBILE_KPI_RULES,
      darkPills: ['warn', 'ok'],
      darkCards: '.card',
    },
    rows,
  });

  const backClauseText = p.backorderEta
    ? `The remaining ${p.backordered} units are backordered — expected ${p.backorderEta}.`
    : `The remaining ${p.backordered} units are backordered and will ship as soon as they're back in stock.`;
  const text = [
    `${greetingText(p.recipientFirstName)}`,
    '',
    `${p.delivered} of ${p.requested} units were delivered and signed for. ${backClauseText}`,
    '',
    `Delivered: ${p.delivered} units${p.deliveredOn ? ` (signed ${p.deliveredOn})` : ''}`,
    `Backordered: ${p.backordered} units${p.backorderEta ? ` (expected ${p.backorderEta})` : ''}`,
    ...(p.items && p.items.length > 0 ? ['', ...lineTextRows(p.items, 'Delivered', 'backordered')] : []),
    '',
    `View order: ${p.orderUrl}`,
    '',
    "No action needed — backordered units ship automatically and you'll get a dispatch note with tracking.",
    '',
    prefFooterText(`Order-status updates for orders placed by ${p.recipientEmail}.`, p.urls),
  ].join('\n');

  return { subject, preheader, html, text };
}

/**
 * The `partial` email when the unit counts are unknown. Same subject, badge,
 * headline, item table (its own best-effort read), CTA and footer; the
 * numbers are left out of the preheader and body and the stat cards are
 * dropped, rather than printed as zeros.
 */
function renderPartialFulfilledWithoutCounts(p: PartialFulfilledParams): RenderedEmail {
  const def = esEmailById('partial');
  const subject = def.subject({ orderNumber: p.orderNumber });
  const preheader = p.backorderEta
    ? `Part of your order was delivered. The rest is backordered — expected ${p.backorderEta}.`
    : 'Part of your order was delivered. The rest is backordered.';

  const hi = greeting(p.recipientFirstName);
  const backClause = p.backorderEta
    ? `The remaining units are backordered &mdash; expected ${escapeHtml(p.backorderEta)}.`
    : 'The remaining units are backordered and will ship as soon as they&rsquo;re back in stock.';
  const body = `${hi} ${strong('Part of your order')} was delivered and signed for. ${backClause}`;

  const rows = [
    brandStrip({ tag: def.tag }),
    section(
      '36px 36px 24px',
      `${statusPill({ variant: def.badge.variant, label: def.badge.label({}) })}
      ${headline({ lead: `Most of ${escapeHtml(p.orderNumber)} has arrived.`, turn: 'The rest is on backorder.' })}
      ${bodyText(body)}`,
    ),
    lineTableSection(p.items, 'Delivered', 'backordered'),
    section(
      '0 36px 30px',
      ctaRow({
        primary: { label: def.cta, href: p.orderUrl },
        noteHtml:
          'No action needed &mdash; backordered units ship automatically and you&rsquo;ll get a dispatch note with tracking.',
      }),
    ),
    footer({
      kind: def.footer,
      reasonHtml: `Order-status updates for orders placed by ${escapeHtml(p.recipientEmail)}.`,
      urls: p.urls,
    }),
  ]
    .filter(Boolean)
    .join('\n    ');

  const html = emailShell({
    title: escapeHtml(subject),
    preheader: escapeHtml(preheader),
    styles: {
      darkPills: ['warn', 'ok'],
      darkCards: '.card',
    },
    rows,
  });

  const backClauseText = p.backorderEta
    ? `The remaining units are backordered — expected ${p.backorderEta}.`
    : "The remaining units are backordered and will ship as soon as they're back in stock.";
  const text = [
    `${greetingText(p.recipientFirstName)}`,
    '',
    `Part of your order was delivered and signed for. ${backClauseText}`,
    ...(p.items && p.items.length > 0 ? ['', ...lineTextRows(p.items, 'Delivered', 'backordered')] : []),
    '',
    `View order: ${p.orderUrl}`,
    '',
    "No action needed — backordered units ship automatically and you'll get a dispatch note with tracking.",
    '',
    prefFooterText(`Order-status updates for orders placed by ${p.recipientEmail}.`, p.urls),
  ].join('\n');

  return { subject, preheader, html, text };
}

// ── 2 · Backordered Items Shipped (`back-shipped`) ──────────────────

export interface BackorderShippedParams {
  orderNumber: string;
  recipientFirstName?: string | null;
  recipientEmail: string;
  /** How many units the remainder shipment carried (when known). */
  unitsShipped?: number | null;
  warehouse?: string | null;
  shipDate?: string | null;
  method?: string | null;
  destination?: string | null;
  trackUrl: string;
  urls: PrefFooterUrls;
}

export function renderBackorderShippedEmail(p: BackorderShippedParams): RenderedEmail {
  const def = esEmailById('back-shipped');
  const subject = def.subject({ orderNumber: p.orderNumber });
  const full = p.unitsShipped != null && p.warehouse && p.shipDate && p.method;
  const preheader = full
    ? def.preheader({
        units: p.unitsShipped,
        warehouse: p.warehouse,
        shipDate: p.shipDate,
        method: p.method,
      })
    : p.unitsShipped != null
      ? `The remaining ${p.unitsShipped} units are on the way.`
      : 'The remaining units are on the way.';

  const hi = greeting(p.recipientFirstName);
  // NOTE (flagged for product): the registry frames this email at
  // DISPATCH time ("left the warehouse… complete on arrival"), but the
  // production trigger fires when the remainder is SIGNED FOR — so the
  // body states the closed-out fact rather than the mockup's future
  // "when they land" tense. Subject/preheader stay registry-verbatim.
  const movement = p.shipDate
    ? `left ${escapeHtml(p.warehouse ?? 'the warehouse')} on ${escapeHtml(p.shipDate)}`
    : 'have shipped';
  const body = `${hi} the backordered units from ${strong(escapeHtml(p.orderNumber))} ${movement} &mdash; this order is now fully closed out.`;

  const lead =
    p.unitsShipped != null
      ? `The last ${p.unitsShipped} units are moving.`
      : 'The rest of your order is moving.';

  const heroAlt = p.destination
    ? `Route progress: package en route to ${escapeHtml(p.destination)}`
    : 'Route progress: the remaining units are on the way';

  const gridCells = [
    ...(p.shipDate
      ? [{ label: 'Shipped', valueHtml: escapeHtml(p.shipDate), subHtml: p.method ? escapeHtml(p.method) : undefined, strong: true }]
      : []),
    ...(p.warehouse ? [{ label: 'From', valueHtml: escapeHtml(p.warehouse), strong: true }] : []),
    ...(p.destination ? [{ label: 'To', valueHtml: escapeHtml(p.destination), strong: true }] : []),
  ];
  const gridRows: [typeof gridCells[number], typeof gridCells[number]][] = [];
  for (let i = 0; i < gridCells.length; i += 2) {
    // An odd trailing cell pairs with a blank half instead of being dropped:
    // shipDate + warehouse + destination is three cells, and "To" must not
    // silently vanish from the shipment grid.
    gridRows.push([
      gridCells[i]!,
      gridCells[i + 1] ?? { label: '', valueHtml: '', strong: false },
    ]);
  }
  const gridSection =
    gridRows.length > 0 ? section('0 36px 28px', detailGrid({ rows: gridRows })) : '';

  const rows = [
    brandStrip({ tag: def.tag }),
    section(
      '36px 36px 24px',
      `${statusPill({ variant: def.badge.variant, label: def.badge.label({}) })}
      ${headline({ lead, turn: 'Order complete on arrival.' })}
      ${bodyText(body)}`,
    ),
    section(
      '0 36px 24px',
      heroSlot({ src: esAssetUrl('motion/route@2x.gif'), alt: heroAlt }),
    ),
    gridSection,
    section(
      '0 36px 30px',
      `${ctaRow({ primary: { label: def.cta, href: p.trackUrl } })}${linkFallback(p.trackUrl)}`,
    ),
    footer({
      kind: def.footer,
      reasonHtml: `Order-status updates for orders placed by ${escapeHtml(p.recipientEmail)}.`,
      urls: p.urls,
    }),
  ]
    .filter(Boolean)
    .join('\n    ');

  const html = emailShell({
    title: escapeHtml(subject),
    preheader: escapeHtml(preheader),
    styles: {
      mobileExtras: gridRows.length > 0 ? MOBILE_GRID_RULES : [],
      darkPills: ['info'],
      darkCards: '.card',
    },
    rows,
  });

  const movementText = p.shipDate
    ? `left ${p.warehouse ?? 'the warehouse'} on ${p.shipDate}`
    : 'have shipped';
  const text = [
    `${greetingText(p.recipientFirstName)}`,
    '',
    `The backordered units from ${p.orderNumber} ${movementText} — this order is now fully closed out.`,
    '',
    `Track shipment: ${p.trackUrl}`,
    '',
    prefFooterText(`Order-status updates for orders placed by ${p.recipientEmail}.`, p.urls),
  ].join('\n');

  return { subject, preheader, html, text };
}

// ── 3 · Partial Delivery Receipt (`partial-receipt`) ────────────────

export interface PartialReceiptParams {
  orderNumber: string;
  /** Supplier (organization) display name — drives the via-StockPilot sender too. */
  supplierName?: string | null;
  signerName: string;
  /** Formatted signature time, e.g. "Apr 29, 2:12 PM UTC". */
  signedAt: string;
  destination?: string | null;
  unitsReceived: number;
  unitsTotal: number;
  unitsPending: number;
  pendingEta?: string | null;
  items?: FulfillmentLineItem[];
  /**
   * Signer-accessible receipt URL. FLAG: none exists today — the public
   * tracking page authenticates by REQUESTER email, and the signer may
   * be neither the requester nor a StockPilot user, so the registry's
   * "View receipt" CTA would dead-link. Omitted (the email IS the
   * receipt) until product provides a signer-facing surface.
   */
  receiptUrl?: string | null;
  /** Public origin for the external footer links (support/privacy/contact). */
  appUrl: string;
}

export function renderPartialReceiptEmail(p: PartialReceiptParams): RenderedEmail {
  const def = esEmailById('partial-receipt');
  const subject = def.subject({ orderNumber: p.orderNumber });
  const preheader = p.destination
    ? def.preheader({ units: p.unitsReceived, destination: p.destination, date: p.signedAt })
    : `Receipt for ${p.unitsReceived} units received and signed ${p.signedAt}.`;

  const base = p.appUrl.replace(/\/+$/, '');
  const supplier = p.supplierName?.trim() ? escapeHtml(p.supplierName.trim()) : null;

  // Receipt language, zero jargon — the signer may have never heard of
  // StockPilot and has no account.
  const body = `You signed for a delivery${p.destination ? ` at ${strong(escapeHtml(p.destination))}` : ''} on ${escapeHtml(p.signedAt)}. This receipt lists what was received and what the supplier still owes &mdash; no account or app needed.`;

  const receiptRows = detailRows([
    { k: 'Signed by', vHtml: escapeHtml(p.signerName), strong: true },
    { k: 'Signature time', vHtml: escapeHtml(p.signedAt) },
    ...(p.destination ? [{ k: 'Delivery location', vHtml: escapeHtml(p.destination) }] : []),
    ...(supplier ? [{ k: 'Supplier', vHtml: `${supplier} &middot; via StockPilot` }] : []),
    { k: 'Units received', vHtml: `${p.unitsReceived} of ${p.unitsTotal}`, strong: true },
    {
      k: 'Still pending',
      vHtml: `${p.unitsPending} units${p.pendingEta ? ` &middot; expected ${escapeHtml(p.pendingEta)}` : ''}`,
      last: true,
    },
  ]);

  const note =
    'The pending units ship separately &mdash; the supplier will notify the original requester.';
  const ctaSection = p.receiptUrl
    ? ctaRow({ primary: { label: def.cta, href: p.receiptUrl }, noteHtml: note })
    : ctaNote(note);

  const rows = [
    brandStrip({ tag: def.tag }),
    section(
      '36px 36px 24px',
      // Registry badge label ("Receipt") is normative; the mockup's
      // longer "Receipt · partial delivery" pill is noted for design.
      `${statusPill({ variant: def.badge.variant, label: def.badge.label({}) })}
      ${headline({ lead: `Delivery receipt for ${escapeHtml(p.orderNumber)}.`, turn: 'Keep it for your records.' })}
      ${bodyText(body)}`,
    ),
    // Receipts are static per the registry — no motion slot.
    section('0 36px 28px', receiptRows),
    lineTableSection(p.items, 'Received', 'pending'),
    section('0 36px 30px', ctaSection),
    footer({
      kind: def.footer,
      reasonHtml: supplier
        ? `You&rsquo;re receiving this one-time receipt because you signed for a delivery managed by ${supplier} through StockPilot.`
        : 'You&rsquo;re receiving this one-time receipt because you signed for a delivery managed through StockPilot.',
      urls: {
        contact: `${base}/contact`,
        support: `${base}/support`,
        privacy: `${base}/privacy`,
      },
    }),
  ].join('\n    ');

  const html = emailShell({
    title: escapeHtml(subject),
    preheader: escapeHtml(preheader),
    styles: { darkPills: ['neutral', 'warn', 'ok'], darkCards: '.card' },
    rows,
  });

  const text = [
    `Delivery receipt for ${p.orderNumber}`,
    '',
    `You signed for a delivery${p.destination ? ` at ${p.destination}` : ''} on ${p.signedAt}.`,
    '',
    `Signed by: ${p.signerName}`,
    `Signature time: ${p.signedAt}`,
    ...(p.destination ? [`Delivery location: ${p.destination}`] : []),
    ...(p.supplierName?.trim() ? [`Supplier: ${p.supplierName.trim()} (via StockPilot)`] : []),
    `Units received: ${p.unitsReceived} of ${p.unitsTotal}`,
    `Still pending: ${p.unitsPending} units${p.pendingEta ? ` (expected ${p.pendingEta})` : ''}`,
    ...(p.items && p.items.length > 0 ? ['', ...lineTextRows(p.items, 'Received', 'pending')] : []),
    '',
    'The pending units ship separately — the supplier will notify the original requester.',
    '',
    p.supplierName?.trim()
      ? `You're receiving this one-time receipt because you signed for a delivery managed by ${p.supplierName.trim()} through StockPilot.`
      : "You're receiving this one-time receipt because you signed for a delivery managed through StockPilot.",
  ].join('\n');

  return { subject, preheader, html, text };
}

// ── 4 · Return Prompt (`return-prompt`) ─────────────────────────────

export interface ReturnPromptParams {
  orderNumber: string;
  recipientFirstName?: string | null;
  recipientEmail: string;
  /** Short delivery date, e.g. "Apr 29" (the completion just happened). */
  deliveredOn: string;
  /** Return window end (no runtime source today — falls back gracefully). */
  returnBy?: string | null;
  destination?: string | null;
  /** The one-time self-service link: `${appUrl}/returns/request/${token}`. */
  startUrl: string;
  /**
   * FLAG: the registry lists a "Return policy" secondary CTA but no
   * policy page exists — omitted until one does.
   */
  policyUrl?: string | null;
  urls: PrefFooterUrls;
}

export function renderReturnPromptEmail(p: ReturnPromptParams): RenderedEmail {
  const def = esEmailById('return-prompt');
  // Subject stays 'Need to return anything from your order?' — the
  // registry's `rec:` refined subject is a comment awaiting product
  // sign-off (see registry.ts return-prompt entry).
  const subject = def.subject({});
  const preheader = p.returnBy
    ? def.preheader({ orderNumber: p.orderNumber, returnBy: p.returnBy })
    : `Order ${p.orderNumber} · unused items can be returned. Takes about a minute.`;

  const hi = greeting(p.recipientFirstName);
  const backClause = p.returnBy
    ? `unused items can go back through ${strong(escapeHtml(p.returnBy))}`
    : 'unused items can go back';
  const body = `${hi} everything from ${strong(escapeHtml(p.orderNumber))} landed ${escapeHtml(p.deliveredOn)}. If anything arrived wrong or surplus, ${backClause}.`;

  const grid = detailGrid({
    rows: [
      [
        {
          label: 'Order',
          valueHtml: escapeHtml(p.orderNumber),
          subHtml: p.destination
            ? `Delivered to ${escapeHtml(p.destination)}`
            : `Delivered ${escapeHtml(p.deliveredOn)}`,
          strong: true,
        },
        {
          label: 'Return window',
          valueHtml: p.returnBy ? escapeHtml(p.returnBy) : 'Open now',
          subHtml: 'Unused items only',
          strong: true,
        },
      ],
    ],
  });

  const rows = [
    brandStrip({ tag: def.tag }),
    section(
      '36px 36px 24px',
      `${statusPill({ variant: def.badge.variant, label: def.badge.label({ deliveredOn: escapeHtml(p.deliveredOn) }) })}
      ${headline({ lead: 'Need to return anything?', turn: 'It takes about a minute.' })}
      ${bodyText(body)}`,
    ),
    section(
      '0 36px 24px',
      heroSlot({
        src: esAssetUrl('motion/reverse@2x.gif'),
        alt: 'Reverse route: returned items travel back to the warehouse',
      }),
    ),
    section('0 36px 28px', grid),
    section(
      '0 36px 30px',
      ctaRow({
        primary: { label: def.cta, href: p.startUrl },
        ...(p.policyUrl ? { secondary: { label: def.cta2!, href: p.policyUrl } } : {}),
        noteHtml:
          'All good? Then you&rsquo;re done &mdash; this is the only nudge we&rsquo;ll send about returns for this order.',
      }),
    ),
    footer({
      kind: def.footer,
      reasonHtml: `A single post-delivery notice for orders placed by ${escapeHtml(p.recipientEmail)}.`,
      urls: p.urls,
    }),
  ].join('\n    ');

  const html = emailShell({
    title: escapeHtml(subject),
    preheader: escapeHtml(preheader),
    styles: {
      mobileExtras: MOBILE_GRID_RULES,
      darkPills: ['neutral'],
      darkCards: '.card',
    },
    rows,
  });

  const text = [
    `${greetingText(p.recipientFirstName)}`,
    '',
    `Everything from ${p.orderNumber} landed ${p.deliveredOn}. If anything arrived wrong or surplus, unused items can go back${p.returnBy ? ` through ${p.returnBy}` : ''}.`,
    '',
    `Start a return: ${p.startUrl}`,
    '',
    "All good? Then you're done — this is the only nudge we'll send about returns for this order.",
    '',
    prefFooterText(`A single post-delivery notice for orders placed by ${p.recipientEmail}.`, p.urls),
  ].join('\n');

  return { subject, preheader, html, text };
}

// ── 5 · Return Update (`return-update`, returns RX-1) ───────────────

/** What happened to the requester's return (RX-1) or exchange (RX-2). */
export type ReturnUpdateEvent =
  | 'request_received'
  | 'approved'
  | 'received'
  | 'denied'
  | 'cancelled'
  // RX-2: the exchange, from the RMA's functions (changed: true only).
  | 'exchange_approved'
  | 'exchange_approved_short'
  | 'replacement_changed'
  | 'replacement_cancelled'
  // RX-2: the replacement order's own edges (plan 3.6.7, reworded).
  | 'replacement_ready_pickup'
  | 'replacement_ready_delivery'
  | 'replacement_on_the_way'
  | 'replacement_partly_handed_over'
  | 'replacement_handed_over'
  | 'exchange_complete'
  // RX-2 review fix (P14): the replacement order closed with part of it
  // never sent (delivered-partial), and the hand-over receipt for a signer
  // who is not the requester (no button, never "your exchange").
  | 'replacement_closed_partial'
  | 'replacement_signed_for'
  // RX-2 review fixes P28 and P15 (core's in-app words): a return the
  // requester asked for, approved with a replacement staff added (not "your
  // exchange", they asked for none), and a return kept as a return only after
  // its replacement was cancelled. Sent once the web wires them.
  | 'return_approved_replacement_added'
  | 'return_approved_replacement_added_short'
  | 'replacement_closed_return_only'
  // RX-3: the requester's own exchange request, received; and an approval
  // that declined every exchange line the requester asked for (the return
  // goes on).
  | 'exchange_request_received'
  | 'exchange_declined';

export interface ReturnUpdateParams {
  event: ReturnUpdateEvent;
  /** "RMA-20261005-ABC123"; the order handle stands in when it is missing. */
  returnNumber: string | null;
  /** "SO-000103", or null for a legacy order with no number. */
  orderNumber: string | null;
  recipientFirstName?: string | null;
  recipientEmail: string;
  /** The requester's own page for this order (token page or portal), or null. */
  viewUrl: string | null;
  /** The button's words when not the registry's "View your return" (the
   *  replacement's completion email links the replacement's own return page:
   *  "Start a return"; a member's button opens the replacement order: "View
   *  your replacement"). */
  ctaLabel?: string | null;
  urls: PrefFooterUrls;
}

/**
 * Per event: the subject's summary, the badge, the headline and the one
 * sentence (core's returns copy: no rack, no disposition, no reason text,
 * no staff name ever reaches a requester). A sentence that points at the
 * button ("you can start a return here") has `withoutLink`, the words used
 * when the email carries no button, so no email points at a button it does
 * not have.
 */
const RETURN_UPDATE_WORDS: Record<
  ReturnUpdateEvent,
  { summary: string; badge: string; lead: string; sentence: string; withoutLink?: string }
> = {
  request_received: {
    summary: 'request received',
    badge: 'Request received',
    lead: 'We received your return request.',
    sentence: 'The warehouse will review it and let you know.',
  },
  approved: {
    summary: 'approved',
    badge: 'Approved',
    lead: 'Your return was approved.',
    sentence: 'Bring or send the item back as arranged with the warehouse.',
  },
  received: {
    summary: 'item received',
    badge: 'Item received',
    lead: 'We received your returned item.',
    sentence: 'Thank you. Nothing else is needed from you for this return.',
  },
  denied: {
    summary: 'declined',
    badge: 'Declined',
    lead: 'Your return request was declined.',
    sentence: 'Contact the warehouse if you have questions about this request.',
  },
  cancelled: {
    summary: 'cancelled',
    badge: 'Cancelled',
    lead: 'Your return request was cancelled.',
    sentence: 'Contact the warehouse if you have questions about this request.',
  },
  // RX-2 (plan 3.6.7, 3.6.8; core RETURNS_COPY requester words). No reason,
  // rack, quantity on record or staff name. An approved exchange says to
  // bring the item back: the replacement waits for it (review P14).
  exchange_approved: {
    summary: 'exchange approved',
    badge: 'Approved',
    lead: 'Your exchange was approved.',
    sentence:
      'Your replacement is reserved. Bring or send the returned item back as arranged with the warehouse; the replacement is prepared once it arrives.',
  },
  exchange_approved_short: {
    summary: 'exchange approved',
    badge: 'Approved',
    lead: 'Your exchange was approved.',
    sentence:
      'Your replacement is not in stock yet. The warehouse will follow up. Bring or send the returned item back as arranged with the warehouse.',
  },
  replacement_changed: {
    summary: 'replacement changed',
    badge: 'Replacement changed',
    lead: 'Your replacement was changed.',
    sentence: 'The warehouse will let you know when it is ready.',
  },
  replacement_cancelled: {
    summary: 'replacement cancelled',
    badge: 'Replacement cancelled',
    lead: 'Your replacement was cancelled.',
    sentence: 'The warehouse will follow up.',
  },
  replacement_ready_pickup: {
    summary: 'replacement ready',
    badge: 'Ready',
    lead: 'Your replacement is ready.',
    sentence: 'Ready for pickup.',
  },
  replacement_ready_delivery: {
    summary: 'replacement ready',
    badge: 'Ready',
    lead: 'Your replacement is ready.',
    sentence: 'Ready for delivery.',
  },
  replacement_on_the_way: {
    summary: 'replacement on the way',
    badge: 'On the way',
    lead: 'Your replacement is on the way.',
    sentence: 'It is out for delivery.',
  },
  replacement_partly_handed_over: {
    summary: 'part of your replacement handed over',
    badge: 'Partly handed over',
    lead: 'Part of your replacement was handed over.',
    sentence: 'The rest will follow.',
  },
  // The requester's completion email (the return prompt's replacement
  // branch): its button opens the replacement's own return page. After an
  // early release the requester may still owe the original, so the sentence
  // says the return is of the replacement (review P14).
  replacement_handed_over: {
    summary: 'replacement handed over',
    badge: 'Handed over',
    lead: 'Your replacement was handed over.',
    sentence: 'Thank you. If something is wrong with the replacement, you can start a return of it here.',
    withoutLink: 'Thank you.',
  },
  exchange_complete: {
    summary: 'exchange complete',
    badge: 'Complete',
    lead: 'Your exchange is complete.',
    sentence: 'Thank you. If something is wrong with the replacement, you can start a return from here.',
    withoutLink: 'Thank you.',
  },
  // A replacement completed with part of it never sent (closed as delivered-
  // partial): the notify trigger's in-app words, plus the return link.
  replacement_closed_partial: {
    summary: 'replacement order closed',
    badge: 'Closed',
    lead: 'Your replacement order was closed.',
    sentence:
      'Part of it was handed over. The rest will not be sent. If something is wrong with what you received, you can start a return here.',
    withoutLink: 'Part of it was handed over. The rest will not be sent.',
  },
  // To a signer who is not the requester: a receipt, never a link.
  replacement_signed_for: {
    summary: 'replacement handed over',
    badge: 'Handed over',
    lead: 'The exchange replacement was handed over.',
    sentence: 'Thank you for signing for it.',
  },
  // Review fix P28: every exchange line was added by staff on a return the
  // requester asked for.
  return_approved_replacement_added: {
    summary: 'approved',
    badge: 'Approved',
    lead: 'Your return was approved.',
    // Fix round 1 (verification M2): the replacement waits for the returned
    // item, so the requester is told to bring or send it back (core's words).
    sentence:
      'The warehouse added a replacement for you, and it is reserved. Bring or send the returned item back as arranged with the warehouse; the replacement is prepared once it arrives.',
  },
  return_approved_replacement_added_short: {
    summary: 'approved',
    badge: 'Approved',
    lead: 'Your return was approved.',
    sentence:
      'The warehouse added a replacement for you; it is not in stock yet, and the warehouse will follow up. Bring or send the returned item back as arranged with the warehouse.',
  },
  // Review fix P15: Close as return only after a replacement cancel.
  replacement_closed_return_only: {
    summary: 'return only',
    badge: 'Return only',
    lead: 'No replacement will be sent.',
    sentence: 'Your return goes on as a return only.',
  },
  // RX-3 (core RETURNS_COPY requesterReceivedExchangeRequest and
  // requesterExchangeDeclined).
  exchange_request_received: {
    summary: 'exchange request received',
    badge: 'Request received',
    lead: 'We received your exchange request.',
    sentence: 'The warehouse will review it and let you know.',
  },
  exchange_declined: {
    summary: 'exchange declined',
    badge: 'Return approved',
    lead: 'Exchange declined. Your return was approved.',
    sentence: 'Bring or send the item back as arranged with the warehouse.',
  },
};

export function renderReturnUpdateEmail(p: ReturnUpdateParams): RenderedEmail {
  const def = esEmailById('return-update');
  const words = RETURN_UPDATE_WORDS[p.event];
  const sentence = p.viewUrl ? words.sentence : (words.withoutLink ?? words.sentence);
  const handle = p.returnNumber ?? p.orderNumber ?? 'your return';
  const subject = def.subject({ returnNumber: handle, summary: words.summary });
  const preheader = def.preheader({ sentence: `${words.lead} ${sentence}` });
  const hi = greeting(p.recipientFirstName);
  const against = p.orderNumber ? ` from order ${strong(escapeHtml(p.orderNumber))}` : '';
  const body = `${hi} an update on return ${strong(escapeHtml(handle))}${against}. ${escapeHtml(sentence)}`;

  const rows = [
    brandStrip({ tag: def.tag }),
    section(
      '36px 36px 24px',
      `${statusPill({ variant: def.badge.variant, label: def.badge.label({ label: words.badge }) })}
      ${headline({ lead: escapeHtml(words.lead) })}
      ${bodyText(body)}`,
    ),
    ...(p.viewUrl
      ? [
          section(
            '0 36px 30px',
            ctaRow({ primary: { label: p.ctaLabel ?? def.cta, href: p.viewUrl } }),
          ),
          section('0 36px 24px', linkFallback(p.viewUrl)),
        ]
      : []),
    footer({
      kind: def.footer,
      reasonHtml: `Updates on a return requested for orders placed by ${escapeHtml(p.recipientEmail)}.`,
      urls: p.urls,
    }),
  ].join('\n    ');

  const html = emailShell({
    title: escapeHtml(subject),
    preheader: escapeHtml(preheader),
    styles: { darkPills: ['info'] },
    rows,
  });

  const text = [
    greetingText(p.recipientFirstName),
    '',
    words.lead,
    `Return ${handle}${p.orderNumber ? ` from order ${p.orderNumber}` : ''}. ${sentence}`,
    ...(p.viewUrl ? ['', `${p.ctaLabel ?? def.cta}: ${p.viewUrl}`] : []),
    '',
    prefFooterText(`Updates on a return requested for orders placed by ${p.recipientEmail}.`, p.urls),
  ].join('\n');

  return { subject, preheader, html, text };
}

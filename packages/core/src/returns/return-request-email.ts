/**
 * The return request email (F14): a prefilled draft about ONE return, for the
 * website and the phone. It is the third user of the shared compose helpers
 * (../email/outlook-compose), after the delivery request and the maintenance
 * request, and it keeps their rules:
 *
 *  - StockPilot opens a draft. It never sends the mail, never creates a
 *    ticket and never learns whether either happened, so no string here says
 *    so (RETURN_REQUEST_COPY, pinned by test).
 *  - The mail goes to the organization's saved delivery-request mailboxes
 *    (organizations.email_routing.delivery_request, migration 0337), the
 *    mailbox that already receives delivery and pickup requests. The
 *    recipients are the branded delivery pair, so nothing typed into a return
 *    can reach the To or Cc line.
 *  - The content type below is an allow-list. Return notes, the denial
 *    reason, costs, the decision log and photos have no field, so the builder
 *    cannot print them.
 *  - Every value passes toPlainTextLine, so a line break inside a value
 *    cannot forge a header-looking line.
 *  - A draft too long for a compose link opens shortened and says so; the
 *    copied text is always complete; when even the shortened draft does not
 *    fit, no link may be opened (linkFits false).
 */
import {
  DRAFT_URL_LIMIT,
  assertRoutableAddress,
  composeClipboardText,
  composeMailtoUrl,
  composeOutlookMobileUrl,
  composeOutlookWebUrl,
  type ComposeTransport,
} from '../email/outlook-compose';
import {
  formatSiteAddressLines,
  toPlainTextLine,
  type DeliveryRequestRecipients,
  type DeliveryRequestSite,
} from '../orders/delivery-request';
import { formatOrderNumber } from '../orders/order-number';
import { returnReasonLabel, returnStatusLabel } from '../orders/order-returns-view';
import { requesterTrackingLineWords, type RequesterTrackingReturn } from './requester-exchange-types';
import { itemQuantityLabel, returnLineLabel } from './returns-copy';

/** A return can be written about only while the warehouse still has work on it. */
export const RETURN_REQUEST_SENDABLE_STATUSES = ['requested', 'approved', 'received'] as const;

/** The one rule both apps and the server ask before offering or recording a draft. */
export function canSendReturnRequest(
  status: string | null | undefined,
  returnNumber: string | null | undefined,
): boolean {
  if (!status || !(RETURN_REQUEST_SENDABLE_STATUSES as readonly string[]).includes(status)) return false;
  return typeof returnNumber === 'string' && returnNumber.trim().length > 0;
}

/**
 * The shape a return number must have before the server looks it up: one
 * short line with no spaces around it. The number itself is the database's
 * (returns.return_number); this only keeps junk out of the lookup.
 */
export function isReturnNumberShape(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 64 &&
    value === value.trim() &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

/**
 * The delivery site as the draft prints it: its name, its code and its
 * address. No id: the draft never prints one, so no answer or prop that
 * feeds this builder has to carry one.
 */
export type ReturnRequestSite = Pick<DeliveryRequestSite, 'name' | 'code' | 'address'>;

/** One line of the item list, already in the words the sender's screen shows. */
export interface ReturnRequestEmailItem {
  /** "Staff Polo, M ×2" (core itemQuantityLabel over returnLineLabel). */
  text: string;
  /** The return page only: the requester's own view carries no SKU. */
  sku: string | null;
  /** "Staff Polo, L ×2" when a replacement is asked for or approved. */
  replacement: string | null;
}

/** Everything the draft may say. An allow-list: see the module note. */
export interface ReturnRequestEmailContent {
  returnNumber: string;
  /** "SO-000085", or null for an order with no number. */
  orderNumber: string | null;
  status: string;
  /** The return page only (the requester's view carries no reason). */
  reasonCode: string | null;
  requestedBy: string | null;
  requesterEmail: string | null;
  /** The order's delivery site, where the sender's screen already has it. */
  site: ReturnRequestSite | null;
  warehouseName: string | null;
  items: readonly ReturnRequestEmailItem[];
  /** A link back into StockPilot that the sender can open. */
  link: string | null;
}

export interface ReturnRequestEmailInput extends ReturnRequestEmailContent {
  recipients: DeliveryRequestRecipients;
}

export interface ReturnRequestEmailDraft {
  to: string;
  cc: string;
  toName?: string;
  ccName?: string;
  subject: string;
  body: string;
  /** True when the item list and the site address were left out to fit a link. */
  condensed: boolean;
}

/** The same shape as the maintenance email, so one phone transport opens both. */
export interface PreparedReturnRequestEmail {
  draft: ReturnRequestEmailDraft;
  outlookUrl: string;
  outlookMobileUrl: string;
  mailtoUrl: string;
  /** Which link the length check was made against. */
  transport: ComposeTransport;
  /** Always the complete message. */
  clipboardText: string;
  /** False: no link may be opened; only the copied text is whole. */
  linkFits: boolean;
}

export const RETURN_REQUEST_CONDENSED_DISCLOSURE =
  'This message was shortened because the full item list did not fit in a compose link. The complete return is in StockPilot under the return number above.';

/**
 * Every sentence the two apps show around the draft, in one place so the
 * website and the phone cannot drift and a test can pin them.
 */
export const RETURN_REQUEST_COPY = {
  title: 'Send return request',
  description:
    'It opens a prefilled draft in your mail client — nothing is sent until you press Send yourself.',
  primary: 'Email return request',
  copy: 'Copy details',
  defaultApp: 'Open in Default Email App',
  honesty:
    'This opens a draft email. StockPilot does not send it and does not create a ticket. Review the message and press Send in your mail app.',
  success: 'Outlook opened with your return request. Review the message and press Send yourself.',
  mailAppSuccess: 'Your email app opened with your return request. Review the message and press Send yourself.',
  duplicate:
    'You have already opened a draft for this return. Sending more than one creates duplicate requests for the warehouse.',
  duplicateTitle: 'Open another draft?',
  duplicateConfirm: 'Open Another Draft',
  blocked: 'Outlook could not be opened automatically.',
  mailAppBlocked: 'Your email app could not be opened automatically.',
  blockedRetry: 'Try again, or use Copy details instead.',
  retry: 'Try Outlook Again',
  oversized:
    'This return is too long for an email link, even shortened. Use Copy details — it always includes the full message.',
  condensed:
    'This email will open with a shortened summary — the full item list was too long for a compose link. Copy details always includes everything.',
  copyFailure: 'Could not copy the return request automatically. Select the text below and copy it manually.',
  copyHelper: 'Press and hold inside the box to select and copy.',
  manualLabel: 'Return request text to copy manually',
  eyebrow: 'RETURN REQUEST',
  timelineLabel: 'Return request drafted',
  /** Followed on each screen by "Set it in Settings → Email routing." (a link on the website). */
  noRoutingAdminLead:
    'Email routing for delivery requests is not configured for this organization, so the return request email is hidden.',
  noRoutingAdminWhere: 'Set it in Settings → Email routing.',
} as const;

/** "Return request copied. Create a new email to …, CC …, and paste the copied details." */
export function returnRequestCopiedMessage(recipients: { to: string; cc: string }): string {
  return `Return request copied. Create a new email to ${recipients.to}, CC ${recipients.cc}, and paste the copied details.`;
}

/** The order timeline's sentence for the audit row. */
export function returnRequestDraftedLine(returnNumber: string | null | undefined): string {
  const n = typeof returnNumber === 'string' ? toPlainTextLine(returnNumber) : '';
  return n
    ? `A prefilled draft was opened for ${n} — StockPilot did not send it.`
    : 'A prefilled draft was opened — StockPilot did not send it.';
}

const clean = (v: string | null | undefined): string => (typeof v === 'string' ? toPlainTextLine(v) : '');

function siteLabel(site: ReturnRequestSite): string {
  const name = clean(site.name);
  const code = clean(site.code);
  return code ? `${name} (${code})` : name;
}

/** The draft, whole or shortened. Pure: no clock, no DOM. */
export function buildReturnRequestDraft(
  input: ReturnRequestEmailInput,
  opts: { condensed?: boolean } = {},
): ReturnRequestEmailDraft {
  const condensed = opts.condensed === true;
  const returnNumber = clean(input.returnNumber);
  const orderNumber = clean(input.orderNumber);
  const subject = orderNumber
    ? `Return Request — ${returnNumber} (${orderNumber})`
    : `Return Request — ${returnNumber}`;

  const facts: string[] = [`Return: ${returnNumber}`];
  if (orderNumber) facts.push(`Order: ${orderNumber}`);
  facts.push(`Status: ${clean(returnStatusLabel(input.status))}`);
  if (input.reasonCode) facts.push(`Reason: ${clean(returnReasonLabel(input.reasonCode))}`);
  const who = [clean(input.requestedBy), clean(input.requesterEmail)].filter(Boolean).join(', ');
  if (who) facts.push(`Requested by: ${who}`);
  if (input.site && clean(input.site.name)) {
    facts.push(`Site: ${siteLabel(input.site)}`);
    if (!condensed) facts.push(...formatSiteAddressLines(input.site.address));
  }
  const warehouse = clean(input.warehouseName);
  if (warehouse) facts.push(`Warehouse: ${warehouse}`);

  const blocks: string[][] = [['Return request'], facts];
  const items = input.items.map((i) => ({
    text: clean(i.text),
    sku: clean(i.sku),
    replacement: clean(i.replacement),
  }));
  if (condensed) {
    blocks.push([`Items coming back: ${items.length}`], [RETURN_REQUEST_CONDENSED_DISCLOSURE]);
  } else {
    if (items.length > 0) {
      blocks.push([
        'Items coming back:',
        ...items.map((i) => (i.sku ? `- ${i.text} (SKU ${i.sku})` : `- ${i.text}`)),
      ]);
    }
    const replacements = items.filter((i) => i.replacement);
    if (replacements.length > 0) {
      blocks.push(['Replacement:', ...replacements.map((i) => `- ${i.replacement}`)]);
    }
  }
  const link = clean(input.link);
  if (link) blocks.push(['Open in StockPilot:', link]);

  const draft: ReturnRequestEmailDraft = {
    // Checked here as well as in the recipients factory, as the delivery
    // builder does: a value that reached this function by a cast still has to
    // be a routable address.
    to: assertRoutableAddress('to', input.recipients.to),
    cc: assertRoutableAddress('cc', input.recipients.cc),
    subject,
    body: blocks.map((b) => b.join('\n')).join('\n\n'),
    condensed,
  };
  if (input.recipients.toName) draft.toName = input.recipients.toName;
  if (input.recipients.ccName) draft.ccName = input.recipients.ccName;
  return draft;
}

/**
 * Measure, then shorten (the maintenance and delivery pattern). The length
 * check is made against the link the caller says it opens: the web link by
 * default, the longest of the three, so an undeclared caller is never cut off.
 */
export function prepareReturnRequestEmail(
  input: ReturnRequestEmailInput,
  opts: { transport?: ComposeTransport } = {},
): PreparedReturnRequestEmail {
  const transport = opts.transport ?? 'outlook-web';
  const measure = (draft: ReturnRequestEmailDraft) => {
    const outlookUrl = composeOutlookWebUrl({
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      body: draft.body,
      toName: draft.toName,
      ccName: draft.ccName,
    });
    const outlookMobileUrl = composeOutlookMobileUrl({
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      body: draft.body,
    });
    const mailtoUrl = composeMailtoUrl(draft);
    const composeUrl = transport === 'outlook-native' ? outlookMobileUrl : outlookUrl;
    return {
      draft,
      outlookUrl,
      outlookMobileUrl,
      mailtoUrl,
      fits: composeUrl.length <= DRAFT_URL_LIMIT && mailtoUrl.length <= DRAFT_URL_LIMIT,
    };
  };

  const full = measure(buildReturnRequestDraft(input));
  const clipboardText = composeClipboardText(full.draft);
  const chosen = full.fits ? full : measure(buildReturnRequestDraft(input, { condensed: true }));
  return {
    draft: chosen.draft,
    outlookUrl: chosen.outlookUrl,
    outlookMobileUrl: chosen.outlookMobileUrl,
    mailtoUrl: chosen.mailtoUrl,
    transport,
    clipboardText,
    linkFits: chosen.fits,
  };
}

// ── The two mappings (one per screen, shared by the website and the phone) ──

/** What the order screen adds to a requester's own tracking card. */
export interface ReturnRequestOrderFacts {
  orderNumber: string | null;
  requestedBy: string | null;
  requesterEmail: string | null;
  site: ReturnRequestSite | null;
  warehouseName: string | null;
  link: string | null;
}

/**
 * The requester's own request on their order ("Your requests on this order").
 * It says what the card says: the same item words, no SKU and no reason (the
 * tracking payload carries neither), and a replacement only while it is asked
 * for or approved and names an item. Null when the request has no number.
 */
export function returnRequestContentFromTracking(
  tracking: RequesterTrackingReturn,
  order: ReturnRequestOrderFacts,
): ReturnRequestEmailContent | null {
  if (!tracking.returnNumber || !tracking.returnNumber.trim()) return null;
  return {
    returnNumber: tracking.returnNumber,
    orderNumber: order.orderNumber,
    status: tracking.returnStatus,
    reasonCode: null,
    requestedBy: order.requestedBy,
    requesterEmail: order.requesterEmail,
    site: order.site,
    warehouseName: order.warehouseName,
    items: tracking.lines.map((line) => {
      const words = requesterTrackingLineWords(line);
      const x = line.exchange;
      const live = x !== null && (x.state === 'requested' || x.state === 'approved') && x.replacement !== null;
      return { text: words.returning, sku: null, replacement: live ? words.replacement : null };
    }),
    link: order.link,
  };
}

/** The fields of the return page's payload this mapping reads, and no others. */
export interface ReturnRequestWorkbenchSource {
  return: {
    returnNumber: string | null;
    status: string;
    reasonCode: string | null;
    orderNumber: number | null;
    warehouseName: string | null;
    requesterName: string | null;
    requesterEmail: string | null;
  };
  lines: ReadonlyArray<{
    id: string;
    quantity: number;
    item: { name: string | null; sku: string | null; variant: string | null };
  }>;
  exchange?: {
    lines: ReadonlyArray<{
      returnLineId: string;
      status: string;
      requestedQuantity: number;
      requestedItem: { name: string | null; variant: string | null } | null;
      approvedQuantity: number | null;
      approvedItem: { name: string | null; variant: string | null } | null;
    }>;
  } | null;
}

/**
 * The return page (returns:read or returns:manage). The header and the lines
 * the page already shows, with the SKU and the reason; never the notes or the
 * denial reason, which this function does not read.
 */
export function returnRequestContentFromWorkbench(
  wb: ReturnRequestWorkbenchSource,
  opts: { link: string | null },
): ReturnRequestEmailContent | null {
  const r = wb.return;
  if (!r.returnNumber || !r.returnNumber.trim()) return null;
  const exchangeByLine = new Map((wb.exchange?.lines ?? []).map((x) => [x.returnLineId, x]));
  return {
    returnNumber: r.returnNumber,
    orderNumber: formatOrderNumber(r.orderNumber),
    status: r.status,
    reasonCode: r.reasonCode,
    requestedBy: r.requesterName,
    requesterEmail: r.requesterEmail,
    site: null,
    warehouseName: r.warehouseName,
    items: wb.lines.map((l) => {
      const x = exchangeByLine.get(l.id);
      let replacement: string | null = null;
      if (x && (x.status === 'requested' || x.status === 'approved')) {
        const approved = x.status === 'approved' && x.approvedItem !== null;
        const item = approved ? x.approvedItem : x.requestedItem;
        const quantity = approved ? (x.approvedQuantity ?? x.requestedQuantity) : x.requestedQuantity;
        if (item) replacement = itemQuantityLabel(returnLineLabel(item.name, item.variant), quantity);
      }
      return {
        text: itemQuantityLabel(returnLineLabel(l.item.name, l.item.variant), l.quantity),
        sku: l.item.sku,
        replacement,
      };
    }),
    link: opts.link,
  };
}

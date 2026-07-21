/**
 * StockPilot email system — support family (E7).
 *
 * One live template: `support-ticket` (internal triage notification —
 * internal strip, compact int footer, reply-to set to the CUSTOMER via
 * sendEmail's `replyTo` so a direct reply starts the thread).
 *
 * Two CONCEPTS behind a disabled flag: `support-received` and
 * `support-resolved` — designed submitter-facing acknowledgment /
 * resolution notes. CONCEPT: not dispatched — product decision pending.
 * No production call site references them (a test enforces this).
 *
 * Normative sources: es-support.jsx (layout), the ES.EMAILS registry
 * (subjects/preheaders/senders), archetype markup conventions via the
 * shared component layer. No motion on any support email (triage speed).
 *
 * Honesty flags (mockup copy adapted to production reality — surfaced,
 * not solved in HTML):
 *  - The design shows a short ticket number (SUP-1187), workspace name,
 *    and plan; production tickets have only a UUID id and a nullable
 *    organization_id — no human ticket number or org/plan lookup exists
 *    at the notify call site, so those chips/segments are omitted
 *    rather than rendering a raw UUID.
 *  - The mockup's CTA note claims replies "log to the ticket" and the
 *    footer cites routing rules; no inbound-reply pipeline or routing
 *    rules exist, so both lines say what actually happens.
 *  - The registry badge fixes the `err` pill for the priority chip; the
 *    label carries the real priority (Low/Normal/High/Urgent).
 */

import type {
  TicketCategory,
  TicketPriority,
} from '@/server/services/support-tickets';

import {
  MOBILE_COMPACT_H1_RULES,
  assertEmailWeight,
  bodyText,
  brandStrip,
  compactHeadline,
  ctaRow,
  detailRows,
  emailShell,
  escapeHtml,
  eyebrow,
  footer,
  headline,
  internalStrip,
  section,
  statusPill,
  verbatimMessage,
} from '../components';
import { esEmailById } from '../registry';
import { ES_LIGHT } from '../tokens';

import type { DetailRowOptions } from '../components';

const TICKET_DEF = esEmailById('support-ticket');
const RECEIVED_DEF = esEmailById('support-received');
const RESOLVED_DEF = esEmailById('support-resolved');

/** Registry sender — `StockPilot Support <tickets@stockpilotusa.com>`. */
export const SUPPORT_TICKET_FROM = TICKET_DEF.from;

/** Subject, verbatim from the registry (`[StockPilot support] {subject}`). */
export function supportTicketSubject(subject: string): string {
  return TICKET_DEF.subject({ subject });
}

const CATEGORY_DISPLAY: Record<TicketCategory, string> = {
  bug: 'Bug report',
  billing: 'Billing',
  account: 'Account',
  feature: 'Feature request',
  other: 'Other',
};

const PRIORITY_DISPLAY: Record<TicketPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

const SUBMITTED_DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'America/Los_Angeles',
});
const SUBMITTED_TIME_FMT = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/Los_Angeles',
});

/** "Jun 12, 2026 · 2:41 PM PT" — the design's timestamp shape. */
function formatSubmittedAt(d: Date): string {
  return `${SUBMITTED_DATE_FMT.format(d)} &middot; ${SUBMITTED_TIME_FMT.format(d)} PT`;
}

export interface SupportTicketEmailParams {
  name?: string | null;
  email: string;
  category: TicketCategory;
  priority: TicketPriority;
  subject: string;
  message: string;
  pageUrl?: string | null;
  /** Triage console URL (`{SITE_URL}/dashboard/admin/support`). */
  triageUrl: string;
  /** Injectable clock for deterministic renders in tests. */
  now?: Date;
}

export function renderSupportTicketEmailHtml(
  params: SupportTicketEmailParams,
): string {
  const now = params.now ?? new Date();
  const priority = PRIORITY_DISPLAY[params.priority];
  const category = CATEGORY_DISPLAY[params.category];

  // FLAG: the registry preheader also carries the workspace name — not
  // available at this call site (see module header).
  const preheader = `${priority} &middot; ${category} &middot; in-app. Full message inside.`;

  const detail: DetailRowOptions[] = [
    {
      k: 'Submitter',
      vHtml: params.name?.trim() ? escapeHtml(params.name.trim()) : '&mdash;',
      strong: true,
    },
    { k: 'Email', vHtml: escapeHtml(params.email) },
    { k: 'Submitted', vHtml: formatSubmittedAt(now) },
  ];
  if (params.pageUrl) {
    detail.push({
      k: 'Reported from',
      vHtml: `<span style="word-break:break-all">${escapeHtml(params.pageUrl)}</span>`,
    });
  }

  const messageHtml = escapeHtml(params.message).replace(/\r?\n/g, '<br>');

  const rows = [
    brandStrip({ tag: TICKET_DEF.tag }),
    internalStrip(),
    section(
      '28px 36px 20px',
      [
        `${statusPill({
          variant: TICKET_DEF.badge.variant,
          label: TICKET_DEF.badge.label({ priority }),
        })}&nbsp;&nbsp;${statusPill({
          variant: 'neutral',
          label: category,
          dot: false,
        })}`,
        compactHeadline({
          lead: escapeHtml(params.subject),
          subHtml: 'Submitted via the in-app support form',
        }),
      ].join('\n      '),
    ),
    section('0 36px 20px', detailRows(detail)),
    section(
      '0 36px 20px',
      [
        eyebrow('Message &mdash; verbatim'),
        `<div style="height:8px;font-size:0;line-height:0">&nbsp;</div>`,
        verbatimMessage(messageHtml),
      ].join('\n      '),
    ),
    section(
      '0 36px 30px',
      ctaRow({
        primary: { label: TICKET_DEF.cta, href: params.triageUrl },
        secondary: {
          label: TICKET_DEF.cta2!,
          href: `mailto:${encodeURIComponent(params.email)}`,
        },
        noteHtml:
          'Reply-to on this email is set to the customer &mdash; a direct reply goes straight to them.',
      }),
    ),
    footer({
      kind: 'int',
      reasonHtml:
        'Sent to the StockPilot support inbox whenever a customer submits a ticket.',
      urls: {
        console: params.triageUrl,
        // FLAG: no routing-rules surface exists yet — pointed at the
        // console so the int footer never ships a dead link.
        routing: params.triageUrl,
      },
    }),
  ].join('\n    ');

  const html = emailShell({
    title: escapeHtml(supportTicketSubject(params.subject)),
    preheader,
    preheaderPad: 4,
    styles: {
      darkPills: ['err', 'neutral'],
      darkCards: '.card',
      darkRaise: true,
      mobileExtras: MOBILE_COMPACT_H1_RULES,
    },
    rows,
  });
  assertEmailWeight(html);
  return html;
}

// ── Concepts — NOT live ─────────────────────────────────────────────
// CONCEPT: not dispatched — product decision pending. Submitters today
// get no acknowledgment and no resolution email (registry flag on
// support-ticket). Both templates are fully built and tested so product
// can flip the flag; NOTHING dispatches them and no wiring exists in
// createSupportTicket.

/**
 * Master switch for the two concept emails. Stays `false` until product
 * signs off; any future dispatch path MUST call
 * `assertConceptEmailsEnabled()` before sending.
 */
export const ES_CONCEPT_EMAILS_ENABLED = false;

/** Dispatch gate for the concept templates — throws while the flag is off. */
export function assertConceptEmailsEnabled(): void {
  if (!ES_CONCEPT_EMAILS_ENABLED) {
    throw new Error(
      '[es] support-received / support-resolved are concept emails — not dispatched (product decision pending)',
    );
  }
}

/** Registry sender — `StockPilot Support <support@stockpilotusa.com>`. */
export const SUPPORT_CONCEPT_FROM = RECEIVED_DEF.from;

export function supportReceivedSubject(summary: string): string {
  return RECEIVED_DEF.subject({ summary });
}

export function supportResolvedSubject(subject: string): string {
  return RESOLVED_DEF.subject({ subject });
}

export interface SupportReceivedEmailParams {
  /** Submitter's first name; missing → "Hi —". */
  firstName?: string | null;
  /** Submitter's address (footer reason). */
  email: string;
  /** The ticket subject line. */
  subject: string;
  /** Human-readable ticket reference (NOT a raw UUID). */
  ticketRef: string;
  priority: TicketPriority;
  /** Already-formatted submission timestamp. */
  submittedAt: string;
  /** First-response expectation, e.g. "4 business hours". */
  sla: string;
  ticketUrl: string;
  supportUrl?: string;
}

/** CONCEPT: not dispatched — product decision pending. */
export function renderSupportReceivedEmailHtml(
  params: SupportReceivedEmailParams,
): string {
  const L = ES_LIGHT;
  // Missing first name → the design's "Hi —" fallback (the dash IS the
  // greeting separator; never "Hi — —").
  const greeting = params.firstName?.trim()
    ? `Hi ${escapeHtml(params.firstName.trim())} —`
    : 'Hi —';
  const priority = PRIORITY_DISPLAY[params.priority];

  const rows = [
    brandStrip({ tag: RECEIVED_DEF.tag }),
    section(
      '36px 36px 24px',
      [
        statusPill({
          variant: RECEIVED_DEF.badge.variant,
          label: RECEIVED_DEF.badge.label({}),
        }),
        headline({ lead: 'We got your request.', turn: 'A human will read it.' }),
        bodyText(
          `${greeting} your message about <strong class="ink" style="font-weight:600;color:${L.ink}">&ldquo;${escapeHtml(params.subject)}&rdquo;</strong> is logged as ${escapeHtml(params.ticketRef)}. Typical first response for ${priority.toLowerCase()}-priority reports: within ${escapeHtml(params.sla)}.`,
        ),
      ].join('\n      '),
    ),
    section(
      '0 36px 24px',
      detailRows([
        { k: 'Ticket', vHtml: escapeHtml(params.ticketRef), strong: true },
        { k: 'Submitted', vHtml: escapeHtml(params.submittedAt) },
        { k: 'Priority', vHtml: priority },
      ]),
    ),
    section(
      '0 36px 30px',
      ctaRow({
        primary: { label: RECEIVED_DEF.cta, href: params.ticketUrl },
        noteHtml:
          'Add screenshots or details any time by replying to this email &mdash; replies append to the ticket.',
      }),
    ),
    footer({
      kind: 'ess',
      reasonHtml: `A one-time acknowledgment for the support request submitted from <span class="ink2" style="color:${L.ink2};text-decoration:underline">${escapeHtml(params.email)}</span>.`,
      urls: { support: params.supportUrl ?? '#' },
    }),
  ].join('\n    ');

  const html = emailShell({
    title: escapeHtml(supportReceivedSubject(params.subject)),
    preheader: RECEIVED_DEF.preheader({
      ticketId: escapeHtml(params.ticketRef),
      sla: escapeHtml(params.sla),
    }),
    preheaderPad: 5,
    styles: { darkPills: ['info'], darkCards: '.card' },
    rows,
  });
  assertEmailWeight(html);
  return html;
}

export interface SupportResolvedEmailParams {
  firstName?: string | null;
  email: string;
  /** The ticket subject line. */
  subject: string;
  /** Short human summary for the headline ("label printing"). */
  summary: string;
  /** Human-readable ticket reference (NOT a raw UUID). */
  ticketRef: string;
  /** Close date for the serif turn / preheader, e.g. "Jun 13". */
  closedOn: string;
  /** Detail-row value, e.g. "Jun 13, 2026 · build 2026.6.13". */
  resolvedLine: string;
  /** Reopen window, e.g. "7 days". */
  reopenWindow: string;
  /** Plain-text resolution note for the body copy. */
  resolutionNote: string;
  resolutionUrl: string;
  supportUrl?: string;
}

/** CONCEPT: not dispatched — product decision pending. */
export function renderSupportResolvedEmailHtml(
  params: SupportResolvedEmailParams,
): string {
  const L = ES_LIGHT;
  const greeting = params.firstName?.trim()
    ? `Hi ${escapeHtml(params.firstName.trim())} —`
    : 'Hi —';

  const rows = [
    brandStrip({ tag: RESOLVED_DEF.tag }),
    section(
      '36px 36px 24px',
      [
        statusPill({
          variant: RESOLVED_DEF.badge.variant,
          label: RESOLVED_DEF.badge.label({}),
        }),
        headline({
          lead: `Fixed: ${escapeHtml(params.summary)}.`,
          turn: `Closed ${escapeHtml(params.closedOn)}.`,
        }),
        bodyText(`${greeting} ${escapeHtml(params.resolutionNote)}`),
      ].join('\n      '),
    ),
    section(
      '0 36px 24px',
      detailRows([
        {
          k: 'Ticket',
          vHtml: `${escapeHtml(params.ticketRef)} &mdash; ${escapeHtml(params.subject)}`,
          strong: true,
        },
        { k: 'Resolved', vHtml: escapeHtml(params.resolvedLine) },
        {
          k: 'Reopen window',
          vHtml: `Reply within ${escapeHtml(params.reopenWindow)}`,
        },
      ]),
    ),
    section(
      '0 36px 30px',
      ctaRow({
        primary: { label: RESOLVED_DEF.cta, href: params.resolutionUrl },
        noteHtml: `Still seeing it? Reply to this email within ${escapeHtml(params.reopenWindow)} and the ticket reopens with full history.`,
      }),
    ),
    footer({
      kind: 'ess',
      reasonHtml: `A one-time resolution notice for the support request submitted from <span class="ink2" style="color:${L.ink2};text-decoration:underline">${escapeHtml(params.email)}</span>.`,
      urls: { support: params.supportUrl ?? '#' },
    }),
  ].join('\n    ');

  const html = emailShell({
    title: escapeHtml(supportResolvedSubject(params.subject)),
    preheader: RESOLVED_DEF.preheader({
      ticketId: escapeHtml(params.ticketRef),
      closedOn: escapeHtml(params.closedOn),
      window: escapeHtml(params.reopenWindow),
    }),
    preheaderPad: 5,
    styles: { darkPills: ['ok'], darkCards: '.card' },
    rows,
  });
  assertEmailWeight(html);
  return html;
}

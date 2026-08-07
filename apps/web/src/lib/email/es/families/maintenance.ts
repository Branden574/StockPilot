/**
 * StockPilot email system — maintenance family (2026-08-06, Maintenance
 * Resolved program).
 *
 * One live template: `maintenance-resolved` — the at-most-once resolution
 * notice sent to a maintenance request's requester when a manage-holder
 * marks the request resolved (docs/superpowers/plans/2026-08-06-
 * maintenance-resolved.md, spec §6.1-§6.2). Composed EXCLUSIVELY from the
 * shared es component layer (`support.ts` is the structural template) —
 * no private one-off markup, and the archetype's dark-block / no-ink-on-
 * tonal-fill rules apply exactly as everywhere else in `es/`.
 *
 * THIS FILE IS TEMPLATE ONLY. It imports no transport function and makes
 * no outbound network call — nothing here can dispatch an email. The
 * at-most-once sender (`server/email/maintenance-resolved.ts`) lands in
 * Task 6 and is the ONLY place this renderer is meant to be called from
 * production code.
 *
 * The non-negotiable honesty line: StockPilot recorded this close-out
 * locally, but it has no visibility into (and no ability to touch)
 * Zendesk — the copy here and the vocabulary sweep in the test suite
 * both guard against ever implying otherwise (spec §11).
 */

import {
  assertEmailWeight,
  bodyText,
  brandStrip,
  ctaRow,
  detailRows,
  emailShell,
  escapeHtml,
  eyebrow,
  footer,
  headline,
  section,
  statusPill,
  verbatimMessage,
} from '../components';
import { esEmailById } from '../registry';
import { ES_LIGHT } from '../tokens';

const DEF = esEmailById('maintenance-resolved');
const L = ES_LIGHT;

/** Registry sender — `StockPilot <maintenance@stockpilotusa.com>`. */
export const MAINTENANCE_RESOLVED_FROM = DEF.from;

/**
 * The non-negotiable honesty line (spec §6.2, GC 4). Verbatim, byte-exact,
 * rendered as its own body paragraph directly under the resolution note
 * AND repeated (first sentence) in the footer reason. Never reword —
 * StockPilot cannot see or touch the Zendesk ticket, and this sentence is
 * the only thing standing between "marked resolved" and a requester
 * believing their support ticket is closed.
 */
export const MAINTENANCE_RESOLVED_HONESTY_LINE =
  'This resolution was recorded by your team in StockPilot. It does not close or update the Zendesk ticket — replies and ticket status stay in the Outlook/Zendesk email conversation.';

/** First sentence of the honesty line, for the footer's shorter reason line. */
function honestyLineFirstSentence(): string {
  const idx = MAINTENANCE_RESOLVED_HONESTY_LINE.indexOf('. ');
  return idx === -1
    ? MAINTENANCE_RESOLVED_HONESTY_LINE
    : `${MAINTENANCE_RESOLVED_HONESTY_LINE.slice(0, idx)}.`;
}

/** Subject, verbatim from the registry (`Maintenance request {handle} marked resolved`). */
export function maintenanceResolvedSubject(handle: string): string {
  return DEF.subject({ handle });
}

export interface MaintenanceResolvedProofPhoto {
  /** ABSOLUTE share-proxy URL (`${appUrl}/m/{token}/photo/{n}`) — never a signed Storage URL. */
  src: string;
  alt: string;
}

export interface MaintenanceResolvedEmailParams {
  /** Display handle, e.g. "MR-2026-000123". */
  requestHandle: string;
  requestSubject: string;
  /** Requester's first name; missing → "Hi —" (support-family convention). */
  recipientFirstName?: string | null;
  /** Requester's address (footer reason only — never rendered as a link target here). */
  recipientEmail: string;
  /** The resolver's display-name snapshot. */
  resolverName: string;
  /** The resolution note, rendered VERBATIM — escaped, `\n` → `<br>`. Never truncated. */
  resolutionNote: string;
  /** Pre-formatted org-tz datetime, e.g. "Aug 6, 2026 · 2:41 PM PT". */
  resolvedOnDisplay: string;
  /** Up to 4 are shown; may be empty. Absolute share-proxy URLs only. */
  proofPhotos: MaintenanceResolvedProofPhoto[];
  /** Total kind='resolution' attachment count — drives the "+N more" / fallback line. */
  proofPhotoTotal: number;
  /** `${appUrl}/dashboard/maintenance/{id}`. */
  requestUrl: string;
}

const PROOF_IMG_WIDTH = 120;
const PROOF_IMG_MAX = 4;

/** "Hi Dana —" / "Hi —" — recipientFirstName is already a first name, no further splitting. */
function greetingHtml(firstName: string | null | undefined): string {
  const first = firstName?.trim();
  return first ? `Hi ${escapeHtml(first)} —` : 'Hi —';
}

function greetingText(firstName: string | null | undefined): string {
  const first = firstName?.trim();
  return first ? `Hi ${first} —` : 'Hi —';
}

/** "3 proof photos are on the request in StockPilot." (singular-aware). */
function proofFallbackLine(total: number): string {
  return total === 1
    ? '1 proof photo is on the request in StockPilot.'
    : `${total} proof photos are on the request in StockPilot.`;
}

/** 2-per-row table of `width=120` proof thumbnails — the components' img conventions (border:0, radius:8). */
function proofPhotoGridHtml(photos: MaintenanceResolvedProofPhoto[]): string {
  const rowsHtml: string[] = [];
  for (let i = 0; i < photos.length; i += 2) {
    const pair = [photos[i], photos[i + 1]].filter(
      (p): p is MaintenanceResolvedProofPhoto => Boolean(p),
    );
    const cells = pair
      .map(
        (p) =>
          `<td style="padding:0 8px 8px 0"><img src="${p.src}" width="${PROOF_IMG_WIDTH}" alt="${escapeHtml(p.alt)}" style="display:block;width:${PROOF_IMG_WIDTH}px;max-width:${PROOF_IMG_WIDTH}px;height:auto;border:0;border-radius:8px"></td>`,
      )
      .join('');
    rowsHtml.push(`<tr>${cells}</tr>`);
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody>\n        ${rowsHtml.join('\n        ')}\n      </tbody></table>`;
}

/**
 * Proof-photo block: up to 4 thumbnails from `proofPhotos` (share-proxy
 * URLs supplied by the caller — this template never mints one), a "+N
 * more" note when `proofPhotoTotal` exceeds what's shown, or — when no
 * share link exists (`proofPhotos` is empty) but photos DO exist — the
 * honest fallback line pointing at the CTA instead of images (spec §6.2).
 * Empty string (no row at all) when there is nothing to say.
 */
function proofPhotoBlockHtml(
  photos: MaintenanceResolvedProofPhoto[],
  total: number,
): string {
  if (photos.length > 0) {
    const shown = photos.slice(0, PROOF_IMG_MAX);
    const grid = proofPhotoGridHtml(shown);
    const remaining = total - shown.length;
    if (remaining <= 0) return grid;
    const more =
      remaining === 1 ? '+1 more photo on the request' : `+${remaining} more photos on the request`;
    return `${grid}\n      ${bodyText(more)}`;
  }
  if (total > 0) {
    return bodyText(escapeHtml(proofFallbackLine(total)));
  }
  return '';
}

/** Plain-text mirror of the proof block — text can't embed images, so it always reads as the fallback line. */
function proofPhotoTextLine(total: number): string | null {
  return total > 0 ? proofFallbackLine(total) : null;
}

export function renderMaintenanceResolvedEmail(
  params: MaintenanceResolvedEmailParams,
): { subject: string; html: string; text: string } {
  const subject = maintenanceResolvedSubject(params.requestHandle);
  const preheaderRaw = DEF.preheader({ resolverName: params.resolverName });

  const greeting = greetingHtml(params.recipientFirstName);
  const resolverNameHtml = escapeHtml(params.resolverName);
  const noteHtml = escapeHtml(params.resolutionNote).replace(/\r?\n/g, '<br>');
  const proofBlock = proofPhotoBlockHtml(params.proofPhotos, params.proofPhotoTotal);

  const rows = [
    brandStrip({ tag: DEF.tag }),
    section(
      '36px 36px 24px',
      [
        statusPill({ variant: DEF.badge.variant, label: DEF.badge.label({}) }),
        headline({ lead: 'Marked resolved.', turn: escapeHtml(params.requestSubject) }),
        bodyText(
          `${greeting} Marked resolved by <strong class="ink" style="font-weight:600;color:${L.ink}">${resolverNameHtml}</strong>.`,
        ),
      ].join('\n      '),
    ),
    section(
      '0 36px 24px',
      [
        eyebrow('Resolution note &mdash; verbatim'),
        `<div style="height:8px;font-size:0;line-height:0">&nbsp;</div>`,
        verbatimMessage(noteHtml),
      ].join('\n      '),
    ),
    section('0 36px 24px', bodyText(MAINTENANCE_RESOLVED_HONESTY_LINE)),
    proofBlock ? section('0 36px 24px', proofBlock) : '',
    section(
      '0 36px 24px',
      detailRows([
        {
          k: 'Request',
          vHtml: `${escapeHtml(params.requestHandle)} &mdash; ${escapeHtml(params.requestSubject)}`,
          strong: true,
        },
        { k: 'Resolved', vHtml: escapeHtml(params.resolvedOnDisplay) },
        { k: 'Recorded by', vHtml: resolverNameHtml, last: true },
      ]),
    ),
    section(
      '0 36px 30px',
      ctaRow({ primary: { label: DEF.cta, href: params.requestUrl } }),
    ),
    footer({
      kind: 'ess',
      reasonHtml: `${honestyLineFirstSentence()} Sent once when a request you submitted is marked resolved.`,
      urls: { support: params.requestUrl },
    }),
  ]
    .filter(Boolean)
    .join('\n    ');

  const html = emailShell({
    title: escapeHtml(subject),
    preheader: escapeHtml(preheaderRaw),
    styles: {
      darkPills: ['ok'],
      darkCards: '.card',
      darkRaise: true,
    },
    rows,
  });
  assertEmailWeight(html);

  const proofTextLine = proofPhotoTextLine(params.proofPhotoTotal);
  const text = [
    greetingText(params.recipientFirstName),
    '',
    `Marked resolved by ${params.resolverName}.`,
    '',
    'Resolution note:',
    params.resolutionNote,
    '',
    MAINTENANCE_RESOLVED_HONESTY_LINE,
    ...(proofTextLine ? ['', proofTextLine] : []),
    '',
    `Request: ${params.requestHandle} — ${params.requestSubject}`,
    `Resolved: ${params.resolvedOnDisplay}`,
    `Recorded by: ${params.resolverName}`,
    '',
    `View request: ${params.requestUrl}`,
    '',
    `${honestyLineFirstSentence()} Sent once when a request you submitted is marked resolved.`,
  ].join('\n');

  return { subject, html, text };
}

/**
 * Pure maintenance email builder. No React, no DOM, no network, no clock.
 * Takes NO recipient argument — it reads L4L_MAINTENANCE_EMAIL — so there is
 * no parameter through which client data could redirect the mail (the
 * delivery-request invariant, storefront-logic.ts:421-428).
 *
 * `submittedAtDisplay` arrives PRE-FORMATTED by the caller (server side,
 * likely via formatOrgDateTime — apps/web/src/lib/timezone.ts). This module
 * never calls `new Date()` / `Date.now()` itself: no clock, deterministic
 * output for a given input, matching the buildDeliveryRequestDraft precedent
 * (storefront-logic.ts:421-434) this builder mirrors.
 *
 * BODY FORMAT (real-file-vs-brief divergence, recorded per Task 4's
 * instruction to note these): the owner brief's section 15 illustrates the
 * body with a blank line after every heading and a greeting/instruction/
 * sign-off wrapper. Measuring that exact text through the REAL, tenant-
 * verified transport (`composeOutlookWebUrl` double-encodes the body — see
 * outlook-compose.ts's module doc) showed the fully-populated illustrative
 * example produces an Outlook URL of ~2,600 characters against the shared
 * `DRAFT_URL_LIMIT` of 1,800 — a fixed, real, already-shipped ceiling this
 * module must not change. None of that spacing/greeting/sign-off text is
 * covered by the plan's numbered test list (section 31): only the labelled
 * `Heading` / `Label: value` content, the reply-thread sentence and the
 * footer are ever asserted. So this module follows the DELIVERY-REQUEST
 * precedent's actual body convention instead (storefront-logic.ts:466-537:
 * `HEADING\nLabel: value` with no blank line after the heading, a blank
 * line only BETWEEN different top-level blocks, no greeting, no sign-off)
 * — same information, denser encoding. A maximally-detailed request (every
 * optional field populated at once, matching the brief's own worked
 * example) still legitimately exceeds the link budget and condenses; that
 * is the condense mechanism doing exactly its job, not a bug.
 *
 * Condense policy (audit Q13, mirrors prepareDeliveryRequest verbatim —
 * storefront-logic.ts:759-799): measure BOTH the Outlook URL and the mailto
 * URL against DRAFT_URL_LIMIT; if either overflows, rebuild with `condensed:
 * true` and re-measure. Audit Q13's preserve list is deliberately narrow —
 * request number, requester name + site, truncated description, one photo
 * link — everything else (category/priority/submitted timestamp, requester
 * email/phone/department, location detail, the related-record block,
 * access instructions, the reply-thread sentence) drops first. If the
 * condensed pair STILL overflows, `linkFits` is false and the caller must
 * refuse to open either link, falling back to the clipboard path, which
 * always carries the full, uncondensed body.
 */
import {
  composeOutlookWebUrl,
  composeMailtoUrl,
  composeClipboardText,
  DRAFT_URL_LIMIT,
} from '../email/outlook-compose';
import {
  L4L_MAINTENANCE_EMAIL,
  L4L_MAINTENANCE_EMAIL_NAMES,
  type MaintenancePriority,
} from './constants';
import { sanitizeSubjectLine, sanitizeDescriptionBlock } from './text';

export interface MaintenanceEmailInput {
  requestNumber: string;
  subject: string;
  description: string;
  category: string | null;
  priority: MaintenancePriority;
  submittedAtDisplay: string;
  requesterName: string;
  requesterEmail: string | null;
  requesterPhone: string | null;
  siteName: string | null;
  department: string | null;
  building: string | null;
  roomOrArea: string | null;
  accessInstructions: string | null;
  relatedItem: { name: string; sku: string | null; modelNumber: string | null; url: string | null } | null;
  relatedOrder: { handle: string; requestedFor: string | null; url: string | null } | null;
  relatedRental: { itemNames: string[]; borrowerName: string | null; url: string | null } | null;
  photoCount: number;
  shareUrl: string | null;
}

export interface MaintenanceEmailDraft {
  to: string;
  cc: string;
  subject: string;
  body: string;
  condensed: boolean;
}

export interface PreparedMaintenanceEmail {
  draft: MaintenanceEmailDraft;
  outlookUrl: string;
  mailtoUrl: string;
  /** ALWAYS the full draft — the clipboard has no URL-length limit. */
  clipboardText: string;
  /** False means NEITHER link may be opened (silent truncation). */
  linkFits: boolean;
}

export const MAINTENANCE_CONDENSED_DISCLOSURE =
  'This message was shortened because the full request details did not fit in a compose link. The complete request is in StockPilot under the request number above.';

const SUBJECT_PREFIX_RE = /^\[StockPilot Maintenance [^\]]*\]\s*/i;
const CONDENSED_DESCRIPTION_CHARS = 350;

const PRIORITY_LABELS: Record<MaintenancePriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

/** 'Label: value' only when the value is real — blocks omit empty lines
 *  entirely (never `undefined`, never `null`, never a bare label). */
function line(label: string, value: string | null | undefined): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  return v ? `${label}: ${v}` : null;
}

/** `HEADING\nLabel: value\n...` — the real delivery-request convention
 *  (storefront-logic.ts:466-537), not the brief's illustrative blank line
 *  after the heading. Returns null (not a heading with nothing under it)
 *  when every line was empty, so an omitted block leaves no trace. */
function section(heading: string, lines: (string | null)[]): string | null {
  const real = lines.filter((l): l is string => Boolean(l));
  return real.length ? [heading, ...real].join('\n') : null;
}

/** Never truncate mid-sentence: cut at the last word boundary inside the
 *  budget, falling back to a hard cut only when no space exists early
 *  enough to leave a reasonable amount of text. */
function condenseDescription(description: string): string {
  if (description.length <= CONDENSED_DESCRIPTION_CHARS) return description;
  const cut = description.slice(0, CONDENSED_DESCRIPTION_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  const safeCut = lastSpace > CONDENSED_DESCRIPTION_CHARS / 2 ? cut.slice(0, lastSpace) : cut;
  return `${safeCut}...`;
}

function photosSection(
  photoCount: number,
  shareUrl: string | null,
  condensed: boolean,
): string | null {
  if (photoCount <= 0) return null;
  if (condensed) {
    // Audit Q13's preserve list: "one link" — the count and the
    // attach-in-Outlook reminder are dropped first, along with everything
    // else not on that list.
    return shareUrl ? ['PHOTOS', 'View request photos:', shareUrl].join('\n') : null;
  }
  const lines: string[] = [
    `${photoCount} ${photoCount === 1 ? 'photo was' : 'photos were'} uploaded with this request.`,
  ];
  if (shareUrl) lines.push('', 'View request photos:', shareUrl);
  lines.push('', 'The requester may also attach the photos directly to this email before sending.');
  return ['PHOTOS', ...lines].join('\n');
}

export function buildMaintenanceEmailDraft(
  input: MaintenanceEmailInput,
  opts: { condensed?: boolean } = {},
): MaintenanceEmailDraft {
  const condensed = opts.condensed === true;
  const cleanSubject = sanitizeSubjectLine(input.subject).replace(SUBJECT_PREFIX_RE, '');
  const subject = `[StockPilot Maintenance ${input.requestNumber}] ${cleanSubject}`;

  const rawDescription = sanitizeDescriptionBlock(input.description);
  const description = condensed ? condenseDescription(rawDescription) : rawDescription;

  // Top-level blocks are assembled as an array and joined with a blank
  // line, so an omitted block (or one whose only lines were empty) leaves
  // no trace — no heading, no stray blank line, never three newlines in a
  // row.
  const blocks: (string | null)[] = [];

  blocks.push(
    section('MAINTENANCE REQUEST — StockPilot', [
      line('StockPilot Request', input.requestNumber),
      condensed ? null : line('Issue', cleanSubject),
      condensed ? null : line('Category', input.category),
      condensed ? null : line('Priority', PRIORITY_LABELS[input.priority]),
      condensed ? null : line('Submitted', input.submittedAtDisplay),
    ]),
  );

  blocks.push(
    section('REQUESTER', [
      line('Name', input.requesterName),
      condensed ? null : line('Email', input.requesterEmail),
      condensed ? null : line('Phone', input.requesterPhone),
      // Site stays even when condensed — it is on the audit Q13 preserve
      // list and is the one piece of LOCATION that survives condensing.
      line('Site', input.siteName),
      condensed ? null : line('Department', input.department),
    ]),
  );

  if (!condensed) {
    blocks.push(
      section('LOCATION', [line('Building', input.building), line('Room or Area', input.roomOrArea)]),
    );
  }

  blocks.push(section('ISSUE DESCRIPTION', [description]));
  if (condensed) blocks.push(MAINTENANCE_CONDENSED_DISCLOSURE);

  if (!condensed) {
    const related: (string | null)[] = [];
    if (input.relatedItem) {
      related.push(
        line('Item', input.relatedItem.name),
        line('SKU', input.relatedItem.sku),
        line('Model Number', input.relatedItem.modelNumber),
        line('StockPilot Item', input.relatedItem.url),
      );
    }
    if (input.relatedOrder) {
      related.push(
        line('Order', input.relatedOrder.handle),
        line('Requested for', input.relatedOrder.requestedFor),
        line('StockPilot Order', input.relatedOrder.url),
      );
    }
    if (input.relatedRental) {
      related.push(
        line('Rental of', input.relatedRental.itemNames.filter(Boolean).join(', ') || null),
        line('Borrower', input.relatedRental.borrowerName),
        line('StockPilot Rental', input.relatedRental.url),
      );
    }
    blocks.push(section('RELATED STOCKPILOT RECORD', related));
  }

  blocks.push(photosSection(input.photoCount, input.shareUrl, condensed));

  if (!condensed) {
    blocks.push(
      section('ADDITIONAL ACCESS INFORMATION', [input.accessInstructions?.trim() || null]),
    );
    blocks.push(
      'Please reply to this email thread for updates so the responses remain attached to the same Zendesk ticket.',
    );
  }

  blocks.push(['Generated from StockPilot.', `StockPilot Request: ${input.requestNumber}`].join('\n'));

  const body = blocks.filter((b): b is string => Boolean(b)).join('\n\n');

  return {
    to: L4L_MAINTENANCE_EMAIL.to,
    cc: L4L_MAINTENANCE_EMAIL.cc,
    subject,
    body,
    condensed,
  };
}

function urlsFor(draft: MaintenanceEmailDraft): { outlookUrl: string; mailtoUrl: string } {
  return {
    outlookUrl: composeOutlookWebUrl({
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      body: draft.body,
      // ONLY the frozen L4L_MAINTENANCE_EMAIL_NAMES constants ever reach a
      // display-name slot — requester/site strings are BODY content only
      // (Task 4 forward-note: composeOutlookWebUrl throws on unsafe names).
      toName: L4L_MAINTENANCE_EMAIL_NAMES.to,
      ccName: L4L_MAINTENANCE_EMAIL_NAMES.cc,
    }),
    mailtoUrl: composeMailtoUrl(draft),
  };
}

/** Measure-then-degrade, the prepareDeliveryRequest pattern verbatim
 *  (storefront-logic.ts:770-799). */
export function prepareMaintenanceEmail(input: MaintenanceEmailInput): PreparedMaintenanceEmail {
  const full = buildMaintenanceEmailDraft(input);
  const fullUrls = urlsFor(full);
  // ALWAYS the full draft — the clipboard has no URL-length limit, so this
  // is computed once, before any condensing decision, and reused verbatim
  // in both return paths below.
  const clipboardText = composeClipboardText(full);

  if (fullUrls.outlookUrl.length <= DRAFT_URL_LIMIT && fullUrls.mailtoUrl.length <= DRAFT_URL_LIMIT) {
    return { draft: full, ...fullUrls, clipboardText, linkFits: true };
  }

  const condensed = buildMaintenanceEmailDraft(input, { condensed: true });
  const condensedUrls = urlsFor(condensed);
  return {
    draft: condensed,
    ...condensedUrls,
    clipboardText,
    linkFits:
      condensedUrls.outlookUrl.length <= DRAFT_URL_LIMIT &&
      condensedUrls.mailtoUrl.length <= DRAFT_URL_LIMIT,
  };
}

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
 * precedent's actual body convention (storefront-logic.ts:466-537: a blank
 * line only BETWEEN different top-level blocks, no greeting, no sign-off)
 * — same information, denser encoding than the brief's greeting/sign-off
 * wrapper — EXCEPT for one piece of §15's own sectioning that the review's
 * fix wave restored at zero net cost: a blank line after every heading
 * (`section()` below), which the delivery precedent omits but which costs
 * exactly as many characters as the also-restored §15 plain 'MAINTENANCE
 * REQUEST' heading (dropping the '— StockPilot' suffix) saves — see the
 * fix-wave-1 report entry for the exact wash. A maximally-detailed request
 * (every optional field populated at once, matching the brief's own worked
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
  relatedItem: {
    name: string;
    sku: string | null;
    barcode: string | null;
    modelNumber: string | null;
    warehouseName: string | null;
    locationName: string | null;
    url: string | null;
  } | null;
  relatedOrder: {
    handle: string;
    requestedFor: string | null;
    /** Fix wave 2 (I2) — master brief §8's order field list is "order
     *  number, requester, delivery site, relevant item names, StockPilot
     *  order link"; this and `itemNames` were the two missing fields. */
    deliverySiteName: string | null;
    /** Capped BEFORE it ever reaches this builder — see
     *  maintenance-requests.ts's emailInput() for where and why. */
    itemNames: string[];
    url: string | null;
  } | null;
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

// Leading Re:/Fwd: reply-chain markers (case-insensitive, allowed to repeat —
// "Re: Fwd: Re:") are stripped along with the bracket itself, and the space
// between 'Maintenance' and the bracket's contents is optional so a
// requestNumber-less prefix (`[StockPilot Maintenance]`, Fix 2b) still
// dedupes. This regex is applied in a LOOP (see `stripSubjectPrefix` below),
// not once, so a prefix pasted twice collapses to exactly one.
const SUBJECT_PREFIX_RE = /^(?:(?:re|fwd):\s*)*\[StockPilot Maintenance ?[^\]]*\]\s*/i;
// Brief says 400; the file previously shipped 350 as a measured, tighter
// budget. Re-measured at 400 through the REAL, double-encoding
// composeOutlookWebUrl transport after the fix-wave-1 formatting changes
// above (post Fix 1/2): condensed FULL_INPUT (short description, doesn't
// even reach the 350 truncation point) -> outlookUrl 1,262; condensed LONG
// (brief's ~5,200-char oversized fixture) -> outlookUrl 1,707 / mailtoUrl
// 1,263 — both comfortably under the shared 1,800 `DRAFT_URL_LIMIT`. Since
// neither overflows at 400, the brief's number governs (see fix-wave-1
// report for the full measurement table, including the 350 baseline).
const CONDENSED_DESCRIPTION_CHARS = 400;

/** Strip `SUBJECT_PREFIX_RE` repeatedly until nothing more matches, so a
 *  requester who pastes an already-prefixed subject twice (or replies to a
 *  reply) still ends up with exactly ONE `[StockPilot Maintenance ...]`
 *  prefix in the final built subject. */
function stripSubjectPrefix(subject: string): string {
  let result = subject;
  for (;;) {
    const next = result.replace(SUBJECT_PREFIX_RE, '');
    if (next === result) return next;
    result = next;
  }
}

const PRIORITY_LABELS: Record<MaintenancePriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

/** Trims a nullable/undefined value down to a real string, or ''. Shared by
 *  `line()` and by the subject/footer's requestNumber guard so every field
 *  omits itself under the same rule: no `undefined`, no `null`, no bare
 *  label/prefix for a blank value. */
function cleanValue(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 'Label: value' only when the value is real — blocks omit empty lines
 *  entirely (never `undefined`, never `null`, never a bare label). */
function line(label: string, value: string | null | undefined): string | null {
  const v = cleanValue(value);
  return v ? `${label}: ${v}` : null;
}

/** `HEADING\n\nLabel: value\n...` — §15's own sectioning (a blank line after
 *  every heading). Returns null (not a heading with nothing under it) when
 *  every line was empty, so an omitted block leaves no trace. */
function section(heading: string, lines: (string | null)[]): string | null {
  const real = lines.filter((l): l is string => Boolean(l));
  return real.length ? [heading, '', ...real].join('\n') : null;
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
  // `!(photoCount > 0)` rather than `photoCount <= 0`: every comparison
  // against NaN is false, so a NaN/undefined `photoCount` (Task 8 feeds this
  // from DB data) makes `photoCount <= 0` false too — failing OPEN and
  // rendering 'NaN photos were uploaded...'. Negating `> 0` instead makes the
  // NaN/undefined case fail CLOSED (section omitted).
  if (!(photoCount > 0)) return null;
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
  const cleanSubject = stripSubjectPrefix(sanitizeSubjectLine(input.subject));
  // Same guard as every other field (`cleanValue`/`line`): a blank
  // requestNumber omits the bracket prefix entirely rather than emitting a
  // bare '[StockPilot Maintenance ] ' label.
  const requestNumber = cleanValue(input.requestNumber);
  const subject = requestNumber
    ? `[StockPilot Maintenance ${requestNumber}] ${cleanSubject}`
    : cleanSubject;

  const rawDescription = sanitizeDescriptionBlock(input.description);
  const description = condensed ? condenseDescription(rawDescription) : rawDescription;

  // Top-level blocks are assembled as an array and joined with a blank
  // line, so an omitted block (or one whose only lines were empty) leaves
  // no trace — no heading, no stray blank line, never three newlines in a
  // row.
  const blocks: (string | null)[] = [];

  blocks.push(
    section('MAINTENANCE REQUEST', [
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
    // Each related-record type (item/order/rental) is its own GROUP,
    // separated from the next by a blank line under the shared heading —
    // never glued line-to-line the way REQUESTER/LOCATION's flat field lists
    // are, since item/order/rental are logically distinct records that can
    // all be present at once.
    const groups: (string | null)[] = [];
    if (input.relatedItem) {
      groups.push(
        [
          line('Item', input.relatedItem.name),
          line('SKU', input.relatedItem.sku),
          // Master brief §8's field list — deliberately NO Asset Tag line:
          // no `inventory_items.asset_tag` column exists anywhere and the
          // CSV importer validates-then-drops that header (audit Q6).
          line('Barcode', input.relatedItem.barcode),
          line('Model Number', input.relatedItem.modelNumber),
          line('Warehouse', input.relatedItem.warehouseName),
          line('Location', input.relatedItem.locationName),
          line('StockPilot Item', input.relatedItem.url),
        ]
          .filter((l): l is string => Boolean(l))
          .join('\n') || null,
      );
    }
    if (input.relatedOrder) {
      groups.push(
        [
          line('Order', input.relatedOrder.handle),
          line('Requested for', input.relatedOrder.requestedFor),
          // Fix wave 2 (I2) — §8's remaining two order fields, inserted
          // BEFORE the StockPilot Order link line (mirroring how the
          // relatedItem block above was extended with Warehouse/Location
          // before ITS own StockPilot Item link line) so the byte-pinned
          // "StockPilot Order: ...\n\nRental of: ..." group-boundary test
          // (email.test.ts) stays true: StockPilot Order remains the LAST
          // line of this group either way.
          line('Delivery Site', input.relatedOrder.deliverySiteName),
          line('Items', input.relatedOrder.itemNames.filter(Boolean).join(', ') || null),
          line('StockPilot Order', input.relatedOrder.url),
        ]
          .filter((l): l is string => Boolean(l))
          .join('\n') || null,
      );
    }
    if (input.relatedRental) {
      groups.push(
        [
          line('Rental of', input.relatedRental.itemNames.filter(Boolean).join(', ') || null),
          line('Borrower', input.relatedRental.borrowerName),
          line('StockPilot Rental', input.relatedRental.url),
        ]
          .filter((l): l is string => Boolean(l))
          .join('\n') || null,
      );
    }
    const realGroups = groups.filter((g): g is string => Boolean(g));
    blocks.push(realGroups.length ? section('RELATED STOCKPILOT RECORD', [realGroups.join('\n\n')]) : null);
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

  // Same guard as the subject prefix: a blank requestNumber omits the
  // footer's 'StockPilot Request: ' line entirely rather than printing a
  // bare, valueless label. 'Generated from StockPilot.' always survives.
  blocks.push(
    ['Generated from StockPilot.', line('StockPilot Request', input.requestNumber)]
      .filter((l): l is string => Boolean(l))
      .join('\n'),
  );

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

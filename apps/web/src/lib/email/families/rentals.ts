/**
 * StockPilot email system — rentals family (rental-out / rental-returned /
 * rental-overdue).
 *
 * Pure renderers composed ONLY from the shared es component layer
 * (`lib/email/es/*`) per the visual reference `docs/design/email-system/
 * es-rentals.jsx`. Subjects, preheaders, badge labels, and CTA labels come
 * from the es registry — byte-identical to the design package. Dispatch
 * (data loading, recipient checks, best-effort semantics) stays in
 * `lib/email/rentals.ts`; these functions are deterministic string→string:
 * NO Date.now(), no I/O — the overdue day count and every date label
 * arrive as parameters.
 *
 * FOOTER POLICY — "rental classification decision" (pinned decision 6,
 * IMPLEMENTATION_PROMPT.md policy flags): the registry marks all three
 * rental emails `foot:'pref'`, but rentals have NO preference backend —
 * no notification_preferences column, no suppression table consulted by
 * the rental senders, nothing an "Unsubscribe" link could actually do.
 * Rendering the preference footer would link to a control that does not
 * exist (the same broken-promise class as the pre-0222 unsubscribe
 * dead-end). So these templates ship with the ESSENTIAL footer (no
 * unsubscribe, Support/Privacy/Terms links) and an honest delivery
 * reason, until product classifies each rental email (essential
 * transactional vs. preference-controlled) and a real preference exists.
 * The category-boilerplate note is overridden to empty because the
 * essential note's "Security and account emails…" copy is written for
 * account mail and would be false here (external borrowers may have no
 * account at all).
 *
 * Copy deviations from the mockup (sample-world claims that are not true
 * of the product today — flagged for the owner, not silently shipped):
 *  - rental-out CTA note "Need it longer? Extend from the rental page…"
 *    is omitted: rental extension does not exist.
 *  - rental-returned CTA note "…the record open for 48 hours" is omitted:
 *    no such 48-hour window exists.
 *  - rental-overdue "…or extend the rental if you still need it" and the
 *    "Counted in workdays" grid sub-line are replaced (no extension
 *    feature; the count is calendar days), and the "stops automatically"
 *    CTA note is omitted (the cron sends exactly one nudge).
 *  - The "Contact equipment desk" secondary CTA renders only when a
 *    contact URL is supplied — no equipment-desk contact exists yet.
 *  - The primary CTA renders only when a view URL is supplied: external
 *    borrowers have no public rental surface, and linking them into
 *    /dashboard dead-ends on /signin.
 */

import {
  assertEmailWeight,
  banner,
  bodyText,
  brandStrip,
  ctaRow,
  detailGrid,
  emailShell,
  escapeHtml,
  footer,
  headline,
  heroSlot,
  itemTable,
  MOBILE_GRID_RULES,
  rentalAssetCard,
  section,
  statusPill,
} from '../es/components';
import { esEmailById } from '../es/registry';
import { ES_LIGHT, esAssetUrl } from '../es/tokens';

import type { DetailCell } from '../es/components';

// Archetype emphasized-text pattern (archetype-security.html:48).
function strongInk(html: string): string {
  return `<strong class="ink" style="font-weight:600;color:${ES_LIGHT.ink}">${html}</strong>`;
}

/** "Hi {first} — " with the design's missing-first-name fallback ("Hi —"). */
function greeting(firstName: string | null | undefined): string {
  const name = (firstName ?? '').trim();
  return name ? `Hi ${escapeHtml(name)} &mdash; ` : 'Hi &mdash; ';
}

function greetingText(firstName: string | null | undefined): string {
  const name = (firstName ?? '').trim();
  return name ? `Hi ${name} — ` : 'Hi — ';
}

export interface RentalEmailItem {
  name: string;
  qty: number;
  /** Inventory SKU, shown as the asset tag when present. */
  sku: string | null;
}

export interface RentalFooterUrls {
  support: string;
  privacy: string;
  terms: string;
}

export interface RentalBaseParams {
  /** Borrower first name; empty/null renders the "Hi —" fallback. */
  firstName: string | null;
  /** Full borrower name for the asset-card Borrower cell. */
  borrowerName: string;
  borrowerEmail: string;
  orgName: string;
  /** Return-to location label (warehouse name); '—' when unknown. */
  location: string;
  items: RentalEmailItem[];
  /** Checked-out timestamp label, e.g. "Jun 2, 10:15 AM". */
  checkedOutAt: string;
  /** Due date label, e.g. "Jun 9, 2026". */
  due: string;
  /** Short due label for headlines, e.g. "Jun 9". */
  dueShort: string;
  /** Rental detail URL for signed-in borrowers; null omits the CTA row. */
  viewUrl: string | null;
  urls: RentalFooterUrls;
}

export interface RentalOutParams extends RentalBaseParams {
  /** Checkout notes rendered in the "Condition at checkout" banner. */
  conditionNote?: string | null;
}

export interface RentalReturnedParams extends RentalBaseParams {
  /** Checked-in timestamp label, e.g. "Jun 8, 4:05 PM". */
  returnedAt: string;
}

export interface RentalOverdueParams extends RentalBaseParams {
  /** Whole calendar days past due — computed by the dispatcher, ≥ 1. */
  overdueDays: number;
  /** Today's date label, e.g. "Jun 13, 2026". */
  today: string;
  /** Optional equipment-desk contact URL (secondary CTA). */
  contactUrl?: string | null;
}

export interface RenderedRentalEmail {
  subject: string;
  html: string;
  text: string;
  /** RFC-5322 sender, verbatim from the registry. */
  from: string;
}

// ── Shared fragments ────────────────────────────────────────────────

function itemsLabel(items: RentalEmailItem[]): string {
  const first = items[0];
  if (items.length === 1 && first) return first.name;
  return `${items.length} items`;
}

function totalUnits(items: RentalEmailItem[]): number {
  return items.reduce((sum, it) => sum + (Number.isFinite(it.qty) ? it.qty : 0), 0);
}

/**
 * The rental summary block as fully-wrapped container rows: the
 * purpose-built asset card for the common single-line rental; the shared
 * item table + detail grid for multi-line rentals (the asset card is a
 * one-asset design).
 */
function rentalSummaryRows(
  p: RentalBaseParams,
  secondCell: { label: string; valueHtml: string },
): string[] {
  const first = p.items[0];
  if (p.items.length === 1 && first) {
    return [
      section(
        '0 36px 28px',
        rentalAssetCard({
          nameHtml: escapeHtml(first.name),
          qty: first.qty,
          assetTag: first.sku ? escapeHtml(first.sku) : '—',
          cells: [
            { label: 'Checked out', valueHtml: escapeHtml(p.checkedOutAt) },
            { label: secondCell.label, valueHtml: secondCell.valueHtml, strong: true },
            { label: 'Borrower', valueHtml: escapeHtml(p.borrowerName) },
            { label: 'Return to', valueHtml: escapeHtml(p.location) },
          ],
        }),
      ),
    ];
  }
  return [
    section(
      '0 36px 28px',
      itemTable({
        items: p.items.map((it) => ({
          nameHtml: escapeHtml(it.name),
          sku: escapeHtml(it.sku ?? '—'),
          qty: it.qty,
        })),
      }),
    ),
    section(
      '0 36px 28px',
      detailGrid({
        rows: [
          [
            { label: 'Checked out', valueHtml: escapeHtml(p.checkedOutAt), strong: true },
            { label: secondCell.label, valueHtml: secondCell.valueHtml, strong: true },
          ],
          [
            { label: 'Borrower', valueHtml: escapeHtml(p.borrowerName) },
            { label: 'Return to', valueHtml: escapeHtml(p.location) },
          ],
        ],
      }),
    ),
  ];
}

function rentalFooter(p: RentalBaseParams): string {
  // ESSENTIAL footer per the rental classification decision (see module
  // header). Empty note: the ess boilerplate is account-mail copy.
  return footer({
    kind: 'ess',
    note: '',
    reasonHtml: `You&rsquo;re getting this because a rental from ${strongInk(escapeHtml(p.orgName))} is linked to ${escapeHtml(p.borrowerEmail)}.`,
    urls: p.urls,
  });
}

function rentalTextFooter(p: RentalBaseParams): string[] {
  return [
    '—',
    `You're getting this because a rental from ${p.orgName} is linked to ${p.borrowerEmail}.`,
    'StockPilot · Inventory + Order Mgmt · stockpilotusa.com',
  ];
}

function itemTextLines(p: RentalBaseParams): string[] {
  if (p.items.length === 0) return [];
  return [
    '',
    ...p.items.map((it) => `${it.name} × ${it.qty}${it.sku ? ` (${it.sku})` : ''}`),
  ];
}

const SHELL_STYLES = {
  mobileExtras: MOBILE_GRID_RULES,
  darkCards: '.card',
};

// ── rental-out ──────────────────────────────────────────────────────

export function renderRentalOut(p: RentalOutParams): RenderedRentalEmail {
  const def = esEmailById('rental-out');
  const subject = def.subject({});
  const first = p.items[0];
  const single = p.items.length === 1 && first;
  const preheader = def.preheader({
    item: escapeHtml(itemsLabel(p.items)),
    qty: single ? first.qty : totalUnits(p.items),
    due: escapeHtml(p.due),
    location: escapeHtml(p.location),
  });

  const condition = (p.conditionNote ?? '').trim();

  const rows = [
    brandStrip({ tag: def.tag }),
    section(
      '36px 36px 24px',
      `${statusPill({ variant: def.badge.variant, label: def.badge.label({}) })}
      ${headline({
        lead: single ? `${escapeHtml(first.name)} is yours.` : 'Your rental is checked out.',
        turn: `Due back ${escapeHtml(p.dueShort)}.`,
      })}
      ${bodyText(
        `${greeting(p.firstName)}everything below is checked out to you. Bring it back to ${strongInk(escapeHtml(p.location))} by the due date and you&rsquo;re square.`,
      )}`,
    ),
    section(
      '0 36px 28px',
      heroSlot({
        src: esAssetUrl('motion/tag@2x.gif'),
        alt: escapeHtml(`Rental tag: ${itemsLabel(p.items)} checked out — due back ${p.due}`),
      }),
    ),
    ...rentalSummaryRows(p, { label: 'Due back', valueHtml: escapeHtml(p.due) }),
    ...(condition
      ? [
          section(
            '0 36px 20px',
            banner({
              tone: 'neutral',
              titleHtml: 'Condition at checkout',
              bodyHtml: escapeHtml(condition),
            }),
          ),
        ]
      : []),
    ...(p.viewUrl
      ? [
          section(
            '0 36px 28px',
            ctaRow({ primary: { label: def.cta, href: p.viewUrl } }),
          ),
        ]
      : []),
    rentalFooter(p),
  ].join('\n    ');

  const html = emailShell({
    title: escapeHtml(subject),
    preheader,
    styles: { ...SHELL_STYLES, darkPills: ['info'] },
    rows,
  });
  assertEmailWeight(html);

  const text = [
    `StockPilot — ${subject}`,
    '',
    `${greetingText(p.firstName)}everything below is checked out to you. Bring it back to ${p.location} by the due date and you're square.`,
    ...itemTextLines(p),
    '',
    `Checked out: ${p.checkedOutAt}`,
    `Due back: ${p.due}`,
    `Return to: ${p.location}`,
    ...(condition ? ['', `Condition at checkout: ${condition}`] : []),
    ...(p.viewUrl ? ['', `View rental: ${p.viewUrl}`] : []),
    '',
    ...rentalTextFooter(p),
  ].join('\n');

  return { subject, html, text, from: def.from };
}

// ── rental-returned ─────────────────────────────────────────────────

export function renderRentalReturned(p: RentalReturnedParams): RenderedRentalEmail {
  const def = esEmailById('rental-returned');
  const subject = def.subject({});
  const first = p.items[0];
  const single = p.items.length === 1 && first;
  const preheader = def.preheader({
    item: escapeHtml(itemsLabel(p.items)),
    qty: single ? first.qty : totalUnits(p.items),
    at: escapeHtml(p.returnedAt),
  });

  const rows = [
    brandStrip({ tag: def.tag }),
    section(
      '36px 36px 24px',
      `${statusPill({ variant: def.badge.variant, label: def.badge.label({}) })}
      ${headline({ lead: 'Returned &mdash; thanks.', turn: 'All checked in.' })}
      ${bodyText(
        `${greeting(p.firstName)}everything was checked in on ${strongInk(escapeHtml(p.returnedAt))}. This closes out the rental.`,
      )}`,
    ),
    section(
      '0 36px 28px',
      heroSlot({
        src: esAssetUrl('motion/check@2x.gif'),
        alt: escapeHtml(`Checkmark: ${itemsLabel(p.items)} returned — all checked in`),
      }),
    ),
    ...rentalSummaryRows(p, { label: 'Returned', valueHtml: escapeHtml(p.returnedAt) }),
    ...(p.viewUrl
      ? [
          section(
            '0 36px 28px',
            ctaRow({ primary: { label: def.cta, href: p.viewUrl } }),
          ),
        ]
      : []),
    rentalFooter(p),
  ].join('\n    ');

  const html = emailShell({
    title: escapeHtml(subject),
    preheader,
    styles: { ...SHELL_STYLES, darkPills: ['ok'] },
    rows,
  });
  assertEmailWeight(html);

  const text = [
    `StockPilot — ${subject}`,
    '',
    `${greetingText(p.firstName)}everything was checked in on ${p.returnedAt}. This closes out the rental.`,
    ...itemTextLines(p),
    '',
    `Checked out: ${p.checkedOutAt}`,
    `Returned: ${p.returnedAt}`,
    ...(p.viewUrl ? ['', `View record: ${p.viewUrl}`] : []),
    '',
    ...rentalTextFooter(p),
  ].join('\n');

  return { subject, html, text, from: def.from };
}

// ── rental-overdue ──────────────────────────────────────────────────

/** "4 days" / "1 day" — grammatical day-count for copy this module owns. */
function dayCount(days: number): string {
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function renderRentalOverdue(p: RentalOverdueParams): RenderedRentalEmail {
  const def = esEmailById('rental-overdue');
  const subject = def.subject({});
  const first = p.items[0];
  const single = p.items.length === 1 && first;
  const preheader = def.preheader({
    due: escapeHtml(p.due),
    overdueFor: dayCount(p.overdueDays),
  });

  const equipmentCell: DetailCell = single
    ? {
        label: 'Equipment',
        valueHtml: `${escapeHtml(first.name)} &times;${first.qty}`,
        ...(first.sku ? { subHtml: `Asset ${escapeHtml(first.sku)}`, subMono: true } : {}),
      }
    : {
        label: 'Equipment',
        valueHtml: `${p.items.length} items &middot; ${totalUnits(p.items)} units`,
      };

  const rows = [
    brandStrip({ tag: def.tag }),
    section(
      '36px 36px 24px',
      `${statusPill({
        variant: def.badge.variant,
        // Registry badge builder is normative ("Overdue · N days") — the
        // "1 days" singular is a registry nit flagged for the owner.
        label: def.badge.label({ overdueDays: p.overdueDays }),
      })}
      ${headline({
        lead: single
          ? `${escapeHtml(first.name)} was due ${escapeHtml(p.dueShort)}.`
          : `Your rental was due ${escapeHtml(p.dueShort)}.`,
        turn: `That was ${dayCount(p.overdueDays)} ago.`,
      })}
      ${bodyText(
        `${greeting(p.firstName)}this equipment is still checked out to you. Others book against it, so please return it to ${strongInk(escapeHtml(p.location))} as soon as you can.`,
      )}`,
    ),
    section(
      '0 36px 28px',
      heroSlot({
        src: esAssetUrl('motion/clock-arc@2x.gif'),
        alt: escapeHtml(`Overdue clock: due ${p.due} — ${dayCount(p.overdueDays)} ago`),
      }),
    ),
    section(
      '0 36px 28px',
      detailGrid({
        rows: [
          [
            {
              label: 'Was due',
              valueHtml: escapeHtml(p.due),
              subHtml: `Today is ${escapeHtml(p.today)}`,
              strong: true,
            },
            {
              label: 'Days overdue',
              valueHtml: String(p.overdueDays),
              subHtml: 'Calendar days',
              strong: true,
            },
          ],
          [equipmentCell, { label: 'Return to', valueHtml: escapeHtml(p.location) }],
        ],
      }),
    ),
    ...(p.items.length > 1
      ? [
          section(
            '0 36px 28px',
            itemTable({
              items: p.items.map((it) => ({
                nameHtml: escapeHtml(it.name),
                sku: escapeHtml(it.sku ?? '—'),
                qty: it.qty,
              })),
            }),
          ),
        ]
      : []),
    ...(p.viewUrl
      ? [
          section(
            '0 36px 28px',
            ctaRow({
              primary: { label: def.cta, href: p.viewUrl },
              ...(p.contactUrl && def.cta2
                ? { secondary: { label: def.cta2, href: p.contactUrl } }
                : {}),
              noteHtml: 'Already returned it? It may not have been checked in yet.',
            }),
          ),
        ]
      : []),
    rentalFooter(p),
  ].join('\n    ');

  const html = emailShell({
    title: escapeHtml(subject),
    preheader,
    styles: { ...SHELL_STYLES, darkPills: ['err'] },
    rows,
  });
  assertEmailWeight(html);

  const text = [
    `StockPilot — ${subject}`,
    '',
    `${greetingText(p.firstName)}this equipment is still checked out to you. Others book against it, so please return it to ${p.location} as soon as you can.`,
    '',
    `Was due: ${p.due} (today is ${p.today})`,
    `Days overdue: ${p.overdueDays} (calendar days)`,
    ...itemTextLines(p),
    `Return to: ${p.location}`,
    ...(p.viewUrl ? ['', `Review rental: ${p.viewUrl}`] : []),
    '',
    ...rentalTextFooter(p),
  ].join('\n');

  return { subject, html, text, from: def.from };
}

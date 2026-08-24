/**
 * StockPilot email system — schedule family (sched-tmrw / sched-hour).
 *
 * Pure renderers composed ONLY from the shared es component layer, per
 * the visual reference in `docs/design/email-system/es-digest.jsx`
 * (SchedTomorrowEmail / SchedHourEmail — the schedule mockups live in the
 * digest canvas file). Subjects, badges, and CTA labels come from the es
 * registry byte-for-byte. Deterministic string→string: no Date.now(), no
 * I/O — every date/time label arrives pre-formatted from the cron.
 *
 * These replace the raw one-line `<p><strong>` body the schedule-reminders
 * cron previously inlined. The cron's two-horizon dedupe stamps and
 * recipient selection are untouched — only the rendering and send
 * envelope (sender, headers) changed.
 *
 * PREFERENCE FOOTER: email_schedule_reminders exists (mig 0258), so this
 * family renders the preference footer. The manage/unsubscribe links
 * point at /dashboard/settings/notifications — recipients are signed-in
 * org members, and the public mig-0222 suppression table is NOT consulted
 * by this cron, so a public one-click unsubscribe link would be a broken
 * promise (digest precedent: settings URL in List-Unsubscribe, no
 * List-Unsubscribe-Post since RFC 8058 one-click requires a POST
 * endpoint that actually suppresses). FLAG: the plan's blanket
 * "List-Unsubscribe + List-Unsubscribe-Post on every preference-
 * controlled email" is not satisfiable for signed-in-only preferences
 * without new backend — surfaced, not solved here.
 *
 * Copy adaptation (mockup sample-world → real data, flagged):
 *  - "Assigned to you" renders only for the assignee — the cron also
 *    notifies org managers, for whom the claim would be false.
 *  - The mockup CTA note "Reassign or decline from the schedule…" is
 *    omitted (no decline feature exists).
 *  - Location and end-time are optional in the real schema; every label
 *    degrades elegantly when absent.
 */

import {
  assertEmailWeight,
  bodyText,
  brandStrip,
  ctaRow,
  emailShell,
  escapeHtml,
  eventCard,
  footer,
  headline,
  heroSlot,
  section,
  statusPill,
} from '../es/components';
import { esEmailById } from '../es/registry';
import { ES_LIGHT, esAssetUrl } from '../es/tokens';

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

export interface ScheduleFooterUrls {
  /** Notification-preferences page (the pref footer's manage link). */
  manage: string;
  /** Unsubscribe link — same settings page for signed-in recipients. */
  unsubscribe: string;
  support: string;
}

export interface ScheduleReminderParams {
  eventTitle: string;
  /**
   * The day the event falls on, RELATIVE TO SEND TIME and lowercase:
   * "today", "tomorrow", or a weekday name.
   *
   * REQUIRED ON PURPOSE. This template used to hardcode "tomorrow" everywhere
   * — subject, badge, headline and image alt — because it only ever ran from
   * a 24h-ahead cron. That cron's window is now..+24h, which also contains
   * events LATER TODAY, so it announced a 2:30pm delivery as "tomorrow" at
   * 1:20pm the same afternoon. Making this a required field means the next
   * caller cannot silently inherit the same assumption; the compiler asks.
   */
  dayWord: string;
  /** Date-rail cells, e.g. "Jun" / "11" / "Thu". */
  month: string;
  day: string;
  dow: string;
  /** Start time label, e.g. "9:00 AM". */
  startTime: string;
  /** Card time line, e.g. "9:00 AM – 11:00 AM" or "All day". */
  timeLabel: string;
  /** Preheader "when", e.g. "Thu, Jun 11, 9:00 AM". */
  whenLabel: string;
  location: string | null;
  /** Optional event details (rendered on the day-ahead card only). */
  details?: string | null;
  /** True only for the assigned user — gates the "Assigned to you" copy. */
  assignedToYou: boolean;
  /** Recipient first name; empty renders the "Hi —" fallback. */
  firstName: string | null;
  recipientEmail: string;
  /** Event link, e.g. `${appUrl}/dashboard/schedule/${id}`. */
  scheduleUrl: string;
  urls: ScheduleFooterUrls;
}

export interface RenderedScheduleEmail {
  subject: string;
  html: string;
  text: string;
  /** RFC-5322 sender, verbatim from the registry. */
  from: string;
  /** RFC-822 headers for sendEmail (List-Unsubscribe). */
  headers: Record<string, string>;
}

// ── Shared fragments ────────────────────────────────────────────────

function scheduleFooter(p: ScheduleReminderParams): string {
  return footer({
    kind: 'pref',
    reasonHtml: `Schedule reminders are on for ${escapeHtml(p.recipientEmail)} &mdash; they&rsquo;re preference-controlled.`,
    urls: p.urls,
  });
}

function scheduleHeaders(p: ScheduleReminderParams): Record<string, string> {
  // Digest precedent (cron/weekly-digest): the settings page satisfies
  // the Gmail/Yahoo List-Unsubscribe requirement; no -Post header since
  // there is no one-click POST suppression endpoint for these prefs.
  return { 'List-Unsubscribe': `<${p.urls.unsubscribe}>` };
}

function scheduleEventCard(p: ScheduleReminderParams, compact: boolean): string {
  const metaParts = [
    ...(p.location ? [escapeHtml(p.location)] : []),
    ...(p.assignedToYou ? ['Assigned to you'] : []),
  ];
  const details = (p.details ?? '').trim();
  return eventCard({
    month: escapeHtml(p.month),
    day: escapeHtml(p.day),
    dow: escapeHtml(p.dow),
    titleHtml: escapeHtml(p.eventTitle),
    timeHtml: escapeHtml(p.timeLabel),
    metaHtml: metaParts.join(' &middot; '),
    ...(!compact && details ? { descHtml: escapeHtml(details) } : {}),
  });
}

/** "today" -> "Today". Sentence-case for the headline and badge slots, which
 *  read as labels rather than prose. */
function capitalize(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Registry preheader when all merge values exist; honest fallbacks otherwise. */
function tomorrowPreheader(p: ScheduleReminderParams): string {
  const def = esEmailById('sched-tmrw');
  if (p.location && p.assignedToYou) {
    return def.preheader({ when: escapeHtml(p.whenLabel), where: escapeHtml(p.location) });
  }
  const base = p.location
    ? `${escapeHtml(p.whenLabel)} &middot; ${escapeHtml(p.location)}.`
    : `${escapeHtml(p.whenLabel)}.`;
  return p.assignedToYou ? `${base} Assigned to you.` : base;
}

function hourPreheader(p: ScheduleReminderParams): string {
  // Registry: `Starts ${start} · ${where}. ${note}` — the real schema has
  // no note field; compose the same shape with optional parts.
  const where = p.location ? ` &middot; ${escapeHtml(p.location)}` : '';
  return `Starts ${escapeHtml(p.startTime)}${where}.`;
}

function textLines(p: ScheduleReminderParams, subject: string, lead: string): string {
  return [
    `StockPilot — ${subject}`,
    '',
    lead,
    '',
    `${p.whenLabel}${p.location ? ` · ${p.location}` : ''}`,
    ...(p.assignedToYou ? ['Assigned to you.'] : []),
    '',
    `Open schedule: ${p.scheduleUrl}`,
    '',
    '—',
    `Schedule reminders are on for ${p.recipientEmail} — they're preference-controlled.`,
    `Manage email preferences: ${p.urls.manage}`,
  ].join('\n');
}

// ── sched-tmrw ──────────────────────────────────────────────────────

export function renderSchedTomorrow(p: ScheduleReminderParams): RenderedScheduleEmail {
  const def = esEmailById('sched-tmrw');
  const subject = def.subject({ event: p.eventTitle, when: p.dayWord });
  const preheader = tomorrowPreheader(p);

  const eventPhrase = p.assignedToYou ? 'your assigned event' : 'this event';
  const at = p.location ? ` at ${strongInk(escapeHtml(p.location))}` : '';

  const rows = [
    brandStrip({ tag: def.tag }),
    section(
      '36px 36px 24px',
      `${statusPill({
        variant: def.badge.variant,
        label: def.badge.label({ day: capitalize(p.dayWord) }),
      })}
      ${headline({
        lead: escapeHtml(p.eventTitle),
        turn: `${escapeHtml(capitalize(p.dayWord))}, ${escapeHtml(p.startTime)}.`,
      })}
      ${bodyText(
        `${greeting(p.firstName)}a heads-up for ${eventPhrase}${at}. Details below; nothing to confirm.`,
      )}`,
    ),
    section(
      '0 36px 28px',
      heroSlot({
        src: esAssetUrl('motion/calendar@2x.gif'),
        alt: escapeHtml(`Calendar: ${p.eventTitle} — ${p.dayWord}, ${p.startTime}`),
      }),
    ),
    section('0 36px 28px', scheduleEventCard(p, false)),
    section('0 36px 28px', ctaRow({ primary: { label: def.cta, href: p.scheduleUrl } })),
    scheduleFooter(p),
  ].join('\n    ');

  const html = emailShell({
    title: escapeHtml(subject),
    preheader,
    styles: { darkPills: ['info'], darkCards: '.card' },
    rows,
  });
  assertEmailWeight(html);

  const text = textLines(
    p,
    subject,
    `${greetingText(p.firstName)}a heads-up for ${p.assignedToYou ? 'your assigned event' : 'this event'}${p.location ? ` at ${p.location}` : ''}. Details below; nothing to confirm.`,
  );

  return { subject, html, text, from: def.from, headers: scheduleHeaders(p) };
}

// ── sched-hour ──────────────────────────────────────────────────────

export function renderSchedHour(p: ScheduleReminderParams): RenderedScheduleEmail {
  const def = esEmailById('sched-hour');
  const subject = def.subject({ event: p.eventTitle });
  const preheader = hourPreheader(p);

  const turnWhere = p.location ? ` &middot; ${escapeHtml(p.location)}` : '';

  const rows = [
    brandStrip({ tag: def.tag }),
    section(
      '36px 36px 24px',
      `${statusPill({ variant: def.badge.variant, label: def.badge.label({}) })}
      ${headline({
        lead: 'Starting soon.',
        turn: `${escapeHtml(p.startTime)}${turnWhere}.`,
      })}
      ${bodyText(
        `${greeting(p.firstName)}${strongInk(escapeHtml(p.eventTitle))} starts in an hour.`,
      )}`,
    ),
    section(
      '0 36px 28px',
      heroSlot({
        src: esAssetUrl('motion/clock@2x.gif'),
        alt: escapeHtml(`Clock: ${p.eventTitle} starts in 1 hour — ${p.startTime}`),
      }),
    ),
    section('0 36px 28px', scheduleEventCard(p, true)),
    section('0 36px 28px', ctaRow({ primary: { label: def.cta, href: p.scheduleUrl } })),
    scheduleFooter(p),
  ].join('\n    ');

  const html = emailShell({
    title: escapeHtml(subject),
    preheader,
    styles: { darkPills: ['warn'], darkCards: '.card' },
    rows,
  });
  assertEmailWeight(html);

  const text = textLines(
    p,
    subject,
    `${greetingText(p.firstName)}${p.eventTitle} starts in an hour.`,
  );

  return { subject, html, text, from: def.from, headers: scheduleHeaders(p) };
}

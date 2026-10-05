/**
 * StockPilot email system — digest family (E7).
 *
 * Two registry rows: `digest` (Monday briefing) and `digest-preview`
 * (settings "Send me a preview" — same template, purple preview strip,
 * NO motion per the registry's "None in preview banner").
 *
 * Normative sources: archetype-digest.html (markup pattern), es-digest.jsx
 * (section order: intro → bars hero → KPI grid → Needs action → rows card
 * → CTA), the ES.EMAILS registry (subjects/preheaders/senders). The
 * archetype uses the standard 600px shell — the legacy digest's 640px
 * container is retired with this swap.
 *
 * Data honesty — the production digest payload (lib: server/services/
 * digest.ts) carries low stock, open POs, and in-progress cycle counts;
 * the design's sample world shows order/rental KPIs and a schedule feed
 * the payload does not collect. Mapping (flagged for the owner, not
 * silently invented):
 *   - KPI cards      ← per-section headline counts (non-empty sections only,
 *                      so per-user section opt-outs never leak a number).
 *                      The counts are the payload's TOTALS: the lists stop
 *                      at 20, the counts do not.
 *   - Needs action   ← exception rows: low stock + open/overdue POs.
 *   - rows card      ← in-progress cycle counts under an honest
 *                      "In progress" eyebrow (the mockup's "This week"
 *                      schedule feed would need a new query — a behavior
 *                      change this unit must not make).
 *   - preheader      ← registry cadence ("N x · N y · N z. Two-minute
 *                      read.") over the sections that actually exist.
 *   - range pill     ← "As of <date>": the payload is current state (low
 *                      stock now, open POs, counts in progress), not last
 *                      week's activity, so the design's date range and its
 *                      "what moved last week" copy would misdescribe it.
 *   - footer         ← the real send time (the vercel.json cron, 14:00 UTC
 *                      Mondays) in the workspace's time zone.
 * Rendering-only swap: empty-skip, membership/opt-in rechecks,
 * List-Unsubscribe headers, and digest_section_* gating all stay in the
 * cron/action wiring, byte-identical.
 */

import { formatCycleCountNumber, resolveOrgTimezone } from '@stockpilot/core';

import type { DigestPayload } from '@/server/services/digest';

import {
  MOBILE_KPI_RULES,
  actionList,
  assertEmailWeight,
  banner,
  bodyText,
  brandStrip,
  ctaRow,
  emailShell,
  escapeHtml,
  eyebrow,
  footer,
  headline,
  heroSlot,
  kpiGrid,
  previewBanner,
  scheduleRows,
  section,
  statusPill,
} from '../components';
import { esEmailById } from '../registry';
import { ES_LIGHT, esAssetUrl } from '../tokens';

import type { ActionListItem, KpiCardOptions, ScheduleRowItem } from '../components';

/** " CC-000042" after "Cycle count", or nothing when the count has no number
 *  (a database before 0358): never a made-up reference. */
function cycleCountRefSuffix(n: number | null | undefined): string {
  const ref = formatCycleCountNumber(n);
  return ref ? ` ${ref}` : '';
}

const DIGEST_DEF = esEmailById('digest');
const DIGEST_PREVIEW_DEF = esEmailById('digest-preview');

/** Registry sender — `StockPilot <digest@stockpilotusa.com>`. */
export const DIGEST_FROM = DIGEST_DEF.from;

/**
 * Subject dateline format, unchanged from the legacy template
 * ("Monday, July 20, 2026") so cron subjects stay byte-identical
 * across the redesign.
 */
export const DIGEST_DATE_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

const MONTH_DAY_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});
const MONTH_DAY_YEAR_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export function weeklyDigestSubject(now: Date = new Date()): string {
  // Accept an explicit `now` so callers can lock the subject to the
  // cron-start time even if rendering individual emails takes a long
  // time. Default to the current wall clock for preview / one-shot use.
  return DIGEST_DEF.subject({ date: DIGEST_DATE_FMT.format(now) });
}

export function weeklyDigestPreviewSubject(now: Date = new Date()): string {
  return DIGEST_PREVIEW_DEF.subject({ date: DIGEST_DATE_FMT.format(now) });
}

/**
 * Pill label: the day the digest's numbers were read ("As of Jun 15"), on the
 * same clock as the subject's dateline. The registry badge is the design's
 * date range ("Jun 8 – 14"); the payload is current state, not a week of
 * activity, so a range would say something the email does not show.
 */
export function digestAsOfLabel(now: Date = new Date()): string {
  return `As of ${MONTH_DAY_FMT.format(now)}`;
}

/**
 * The weekly-digest cron in apps/web/vercel.json: Mondays at 14:00 UTC, one
 * instant for every org. A test holds the two equal; change both together.
 */
export const DIGEST_CRON_SCHEDULE = '0 14 * * 1';
const DIGEST_SEND_HOUR_UTC = 14;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The cron run an email belongs to. 'this-week': the run of `now`'s week
 * (weeks start on Monday, UTC), which is the run sending a Monday digest.
 * 'next': the first run at or after `now`, the one a preview stands in for.
 */
export function digestSendAt(now: Date, which: 'this-week' | 'next'): Date {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7; // getUTCDay: 0 = Sunday
  const monday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysSinceMonday,
    DIGEST_SEND_HOUR_UTC,
  );
  if (which === 'this-week' || monday >= now.getTime()) return new Date(monday);
  return new Date(monday + WEEK_MS);
}

/**
 * When the digest goes out, in the workspace's time zone: "Mondays at 7:00
 * AM PDT" (6:00 AM PST in winter, 2:00 PM UTC for an org on the UTC default,
 * "Tuesdays at ..." east of UTC+10). The zone goes through resolveOrgTimezone,
 * like every other surface that prints an org-local time.
 */
export function digestScheduleLabel(timeZone: string | null | undefined, sendAt: Date): string {
  const tz = resolveOrgTimezone(timeZone);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(sendAt);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(sendAt);
  return `${weekday}s at ${time}`;
}

export interface WeeklyDigestRenderOptions {
  orgName: string;
  appUrl: string;
  settingsUrl: string;
  /** Recipient's full name; missing → the design's "Hi —" fallback. */
  recipientName?: string | null;
  /** Preview variant: purple strip before the brand row, no motion. */
  preview?: boolean;
  /** Injectable clock for deterministic subjects/ranges in tests. */
  now?: Date;
  /** organizations.timezone, for the send time the footer states. */
  timeZone?: string | null;
}

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

/** Cap on rendered "In progress" rows — the digest is an executive
 *  summary and Gmail clips HTML past ~102KB; overflow collapses into a
 *  final "N more" row. */
const IN_PROGRESS_ROW_CAP = 8;

export function renderWeeklyDigestHtml(
  payload: DigestPayload,
  opts: WeeklyDigestRenderOptions,
): string {
  const { orgName, appUrl, settingsUrl, preview = false } = opts;
  const now = opts.now ?? new Date();
  const L = ES_LIGHT;

  const lowItems = payload.lowStock.flatMap((g) =>
    g.items.map((it) => ({ ...it, warehouseName: g.warehouseName })),
  );
  const outItems = lowItems.filter((it) => it.qty <= 0);
  const overduePos = payload.openPos.filter((po) => po.isOverdue);
  const cycleCounts = payload.openCycleCounts;
  // The lists stop at 20; the counts are the totals behind them.
  const lowTotal = payload.lowStockTotal;
  const outTotal = payload.outOfStockTotal;
  const poTotal = payload.openPosTotal;
  const overdueTotal = payload.overduePosTotal;

  // ── Needs action (exceptions only — in-progress counts are not
  //    exceptions and live in their own rows card below) ─────────────
  const actions: ActionListItem[] = [];
  if (lowItems.length > 0) {
    const exemplar = outItems[0] ?? lowItems[0]!;
    actions.push({
      tone: outItems.length > 0 ? 'err' : 'warn',
      titleHtml: `${plural(lowTotal, 'item')} at or below reorder point`,
      detailHtml:
        outItems.length > 0
          ? `${escapeHtml(exemplar.name)} is out at ${escapeHtml(exemplar.warehouseName)}`
          : `${escapeHtml(exemplar.name)} &middot; ${exemplar.qty} on hand at ${escapeHtml(exemplar.warehouseName)}`,
    });
  }
  if (payload.openPos.length > 0) {
    const exemplar = overduePos[0] ?? payload.openPos[0]!;
    const supplier = escapeHtml(exemplar.supplierName ?? 'No supplier');
    const expected = exemplar.expectedAt
      ? `expected ${MONTH_DAY_YEAR_FMT.format(new Date(exemplar.expectedAt))}`
      : 'no expected date';
    actions.push({
      tone: overduePos.length > 0 ? 'err' : 'info',
      titleHtml:
        overduePos.length > 0
          ? `${plural(overdueTotal, 'purchase order')} overdue`
          : `${plural(poTotal, 'purchase order')} open`,
      detailHtml: `${escapeHtml(exemplar.poNumber)} &middot; ${supplier} &middot; ${expected}`,
    });
  }
  const allClear = actions.length === 0;

  // ── KPI cards — only sections that are present after opt-in gating ─
  const kpis: KpiCardOptions[] = [];
  if (lowItems.length > 0) {
    kpis.push({
      label: 'Low stock',
      valueHtml: String(lowTotal),
      noteHtml: outTotal > 0 ? `${outTotal} out of stock` : 'none out of stock',
    });
  }
  if (payload.openPos.length > 0) {
    kpis.push({
      label: 'Open POs',
      valueHtml: String(poTotal),
      noteHtml: overdueTotal > 0 ? `${overdueTotal} overdue` : 'none overdue',
    });
  }
  if (cycleCounts.length > 0) {
    const totalLines = cycleCounts.reduce((sum, cc) => sum + cc.totalLines, 0);
    const countedLines = cycleCounts.reduce((sum, cc) => sum + cc.countedLines, 0);
    kpis.push({
      label: 'Cycle counts',
      valueHtml: String(cycleCounts.length),
      noteHtml:
        totalLines > 0
          ? `${Math.round((countedLines / totalLines) * 100)}% counted overall`
          : 'in progress',
    });
  }

  // ── In-progress rows (cycle counts) ────────────────────────────────
  const progressRows: ScheduleRowItem[] = cycleCounts
    .slice(0, IN_PROGRESS_ROW_CAP)
    .map((cc) => ({
      titleHtml: `Cycle count${cycleCountRefSuffix(cc.countNumber)} — ${escapeHtml(cc.scopeLabel)}`,
      detailHtml: `${cc.countedLines}/${cc.totalLines} counted &middot; started ${MONTH_DAY_FMT.format(new Date(cc.startedAt))}`,
    }));
  if (cycleCounts.length > IN_PROGRESS_ROW_CAP) {
    progressRows.push({
      titleHtml: `${cycleCounts.length - IN_PROGRESS_ROW_CAP} more in progress`,
      detailHtml: 'full list on the dashboard',
    });
  }

  // ── Copy ───────────────────────────────────────────────────────────
  // Missing first name → the design's "Hi —" fallback (the dash IS the
  // greeting separator; never "Hi — —").
  const firstName = opts.recipientName?.trim().split(/\s+/)[0] || null;
  const greeting = firstName ? `Hi ${escapeHtml(firstName)} —` : 'Hi —';
  const orgStrong = `<strong class="ink" style="font-weight:600;color:${L.ink}">${escapeHtml(orgName)}</strong>`;
  // Current state, not last week's activity: low stock now, open POs and
  // counts in progress are what the payload holds.
  const intro = allClear
    ? `${greeting} here&rsquo;s where ${orgStrong} stands right now. Nothing needs a hand.`
    : `${greeting} here&rsquo;s where ${orgStrong} stands right now, and the ${
        actions.length === 1
          ? 'one thing that needs a hand'
          : `${actions.length} things that need a hand`
      }.`;

  // Registry preheader cadence over the sections production collects.
  // FLAG: the registry's sample preheader counts orders received and
  // overdue rentals — data the digest pipeline does not gather.
  const preheaderSegments: string[] = [];
  if (lowItems.length > 0)
    preheaderSegments.push(`${plural(lowTotal, 'item')} low on stock`);
  if (payload.openPos.length > 0)
    preheaderSegments.push(`${plural(poTotal, 'open purchase order')}`);
  if (cycleCounts.length > 0)
    preheaderSegments.push(`${plural(cycleCounts.length, 'cycle count')} in progress`);
  const preheader = preview
    ? DIGEST_PREVIEW_DEF.preheader({})
    : preheaderSegments.length > 0
      ? `${preheaderSegments.join(' &middot; ')}. Two-minute read.`
      : 'All clear — nothing needs your attention this week.';

  const subject = preview
    ? weeklyDigestPreviewSubject(now)
    : weeklyDigestSubject(now);

  // ── Compose ────────────────────────────────────────────────────────
  const rows: string[] = [];
  if (preview) rows.push(previewBanner());
  rows.push(brandStrip({ tag: DIGEST_DEF.tag }));
  rows.push(
    section(
      '36px 36px 24px',
      [
        statusPill({
          variant: 'info',
          label: digestAsOfLabel(now),
          dot: false,
        }),
        headline({
          lead: 'Your week, in order.',
          turn: 'Monday briefing &middot; two minutes.',
        }),
        bodyText(intro),
      ].join('\n      '),
    ),
  );
  if (!preview) {
    // Registry motion: "L2 · Bars rise". The preview row is explicitly
    // motion-free ("None in preview banner").
    rows.push(
      section(
        '0 36px 24px',
        heroSlot({
          src: esAssetUrl('motion/bars@2x.gif'),
          alt: `Five bars rise — a snapshot of ${escapeHtml(orgName)}`,
          note: 'motion asset: bars.gif · L2 · plays once · frame 1 = resting composition',
        }),
      ),
    );
  }
  if (kpis.length > 0) {
    rows.push(section('0 36px 24px', kpiGrid(kpis)));
  }
  rows.push(
    section('0 36px 8px', eyebrow(allClear ? 'Exceptions' : 'Needs action')),
  );
  rows.push(
    section(
      '8px 36px 24px',
      allClear
        ? banner({
            tone: 'ok',
            titleHtml: 'All clear.',
            bodyHtml:
              'Nothing needs your attention this week. See you next Monday.',
          })
        : actionList(actions),
    ),
  );
  if (progressRows.length > 0) {
    rows.push(section('0 36px 8px', eyebrow('In progress')));
    rows.push(section('8px 36px 24px', scheduleRows(progressRows)));
  }
  rows.push(
    section(
      '0 36px 30px',
      ctaRow({ primary: { label: DIGEST_DEF.cta, href: `${appUrl}/dashboard` } }),
    ),
  );
  rows.push(
    footer({
      kind: 'pref',
      // The real send time: the cron's run, in the workspace's zone. A
      // preview names the run after it.
      reasonHtml: `The weekly digest goes to workspace members who opted in — ${escapeHtml(
        digestScheduleLabel(opts.timeZone, digestSendAt(now, preview ? 'next' : 'this-week')),
      )}.`,
      // The digest archetype shortens the pref boilerplate (see the
      // FOOTER_NOTES flag in components.ts) — passed explicitly so the
      // bytes match archetype-digest.html:118.
      note: 'Unsubscribing stops this notification type only.',
      urls: {
        manage: settingsUrl,
        unsubscribe: settingsUrl,
        support: `${appUrl}/dashboard/support`,
      },
    }),
  );

  const html = emailShell({
    title: escapeHtml(subject),
    preheader,
    preheaderPad: 3,
    styles: {
      darkPills: ['info'],
      darkCards: '.card,.cell',
      mobileExtras: MOBILE_KPI_RULES,
    },
    rows: rows.join('\n    '),
  });
  // Defensive Gmail-clip guard (the render tests assert this too, with
  // a maximal seed payload).
  assertEmailWeight(html);
  return html;
}

// ── Plain-text part ─────────────────────────────────────────────────
// The text part is outside the design package; keeping it stable
// preserves the multipart behavior for text-preferring clients.

export interface WeeklyDigestTextOptions {
  orgName: string;
  appUrl: string;
  settingsUrl: string;
}

export function weeklyDigestText(
  payload: DigestPayload,
  opts: WeeklyDigestTextOptions,
): string {
  const { orgName, appUrl, settingsUrl } = opts;
  const date = DIGEST_DATE_FMT.format(new Date());
  const blocks: string[] = [`StockPilot weekly digest`, `${orgName} · ${date}`, ''];

  if (payload.lowStock.length > 0) {
    blocks.push('LOW / OUT OF STOCK');
    for (const group of payload.lowStock) {
      blocks.push(`  ${group.warehouseName}`);
      for (const it of group.items) {
        blocks.push(
          `    ${it.sku.padEnd(16, ' ')} ${it.name}  (qty ${it.qty}, reorder at ${it.reorderPoint})`,
        );
      }
    }
    const shown = payload.lowStock.reduce((n, g) => n + g.items.length, 0);
    if (payload.lowStockTotal > shown) {
      blocks.push(`  Showing the first ${shown} of ${payload.lowStockTotal}.`);
    }
    blocks.push(`  → ${appUrl}/dashboard/inventory?stock=low&type=all`, '');
  }
  if (payload.openPos.length > 0) {
    blocks.push('OPEN PURCHASE ORDERS');
    for (const po of payload.openPos) {
      const overdue = po.isOverdue ? ' [OVERDUE]' : '';
      const exp = po.expectedAt
        ? new Date(po.expectedAt).toLocaleDateString('en-US')
        : 'no date';
      blocks.push(
        `  ${po.poNumber}  ${po.supplierName ?? 'No supplier'}  expected ${exp}${overdue}`,
      );
    }
    if (payload.openPosTotal > payload.openPos.length) {
      blocks.push(`  Showing the first ${payload.openPos.length} of ${payload.openPosTotal}.`);
    }
    blocks.push(`  → ${appUrl}/dashboard/purchase-orders`, '');
  }
  if (payload.openCycleCounts.length > 0) {
    blocks.push('CYCLE COUNTS IN PROGRESS');
    for (const cc of payload.openCycleCounts) {
      const started = new Date(cc.startedAt).toLocaleDateString('en-US');
      const wh = cc.scopeLabel;
      const ref = formatCycleCountNumber(cc.countNumber);
      const pct =
        cc.totalLines > 0
          ? `${Math.round((cc.countedLines / cc.totalLines) * 100)}%`
          : '—';
      blocks.push(
        `  ${ref ? `${ref} · ` : ''}${started} · ${wh} · ${cc.countedLines}/${cc.totalLines} counted (${pct})`,
      );
    }
    blocks.push(`  → ${appUrl}/dashboard/cycle-counts`, '');
  }
  blocks.push(`Manage preferences: ${settingsUrl}`);
  return blocks.join('\n');
}

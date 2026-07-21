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
 *   - Needs action   ← exception rows: low stock + open/overdue POs.
 *   - rows card      ← in-progress cycle counts under an honest
 *                      "In progress" eyebrow (the mockup's "This week"
 *                      schedule feed would need a new query — a behavior
 *                      change this unit must not make).
 *   - preheader      ← registry cadence ("N x · N y · N z. Two-minute
 *                      read.") over the sections that actually exist.
 * Rendering-only swap: empty-skip, membership/opt-in rechecks,
 * List-Unsubscribe headers, and digest_section_* gating all stay in the
 * cron/action wiring, byte-identical.
 */

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

const MONTH_SHORT_FMT = new Intl.DateTimeFormat('en-US', { month: 'short' });
const DAY_FMT = new Intl.DateTimeFormat('en-US', { day: 'numeric' });
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
 * Range pill label for the week the digest covers — the seven days
 * ending yesterday, in the registry badge's format ("Jun 8 – 14",
 * cross-month "Jun 28 – Jul 4").
 */
export function digestRangeLabel(now: Date = new Date()): string {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const start = new Date(now.getTime() - 7 * DAY_MS);
  const end = new Date(now.getTime() - 1 * DAY_MS);
  const startMonth = MONTH_SHORT_FMT.format(start);
  const endMonth = MONTH_SHORT_FMT.format(end);
  return startMonth === endMonth
    ? `${startMonth} ${DAY_FMT.format(start)} – ${DAY_FMT.format(end)}`
    : `${startMonth} ${DAY_FMT.format(start)} – ${endMonth} ${DAY_FMT.format(end)}`;
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

  // ── Needs action (exceptions only — in-progress counts are not
  //    exceptions and live in their own rows card below) ─────────────
  const actions: ActionListItem[] = [];
  if (lowItems.length > 0) {
    const exemplar = outItems[0] ?? lowItems[0]!;
    actions.push({
      tone: outItems.length > 0 ? 'err' : 'warn',
      titleHtml: `${plural(lowItems.length, 'item')} at or below reorder point`,
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
          ? `${plural(overduePos.length, 'purchase order')} overdue`
          : `${plural(payload.openPos.length, 'purchase order')} open`,
      detailHtml: `${escapeHtml(exemplar.poNumber)} &middot; ${supplier} &middot; ${expected}`,
    });
  }
  const allClear = actions.length === 0;

  // ── KPI cards — only sections that are present after opt-in gating ─
  const kpis: KpiCardOptions[] = [];
  if (lowItems.length > 0) {
    kpis.push({
      label: 'Low stock',
      valueHtml: String(lowItems.length),
      noteHtml:
        outItems.length > 0
          ? `${outItems.length} out of stock`
          : 'none out of stock',
    });
  }
  if (payload.openPos.length > 0) {
    kpis.push({
      label: 'Open POs',
      valueHtml: String(payload.openPos.length),
      noteHtml:
        overduePos.length > 0 ? `${overduePos.length} overdue` : 'none overdue',
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
      titleHtml: `Cycle count — ${escapeHtml(cc.warehouseName ?? 'Unassigned')}`,
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
  const intro = allClear
    ? `${greeting} here&rsquo;s what moved across ${orgStrong} last week. It was a clean one.`
    : `${greeting} here&rsquo;s what moved across ${orgStrong} last week, and the ${
        actions.length === 1
          ? 'one thing that needs a hand'
          : `${actions.length} things that need a hand`
      }.`;

  // Registry preheader cadence over the sections production collects.
  // FLAG: the registry's sample preheader counts orders received and
  // overdue rentals — data the digest pipeline does not gather.
  const preheaderSegments: string[] = [];
  if (lowItems.length > 0)
    preheaderSegments.push(`${plural(lowItems.length, 'item')} low on stock`);
  if (payload.openPos.length > 0)
    preheaderSegments.push(`${plural(payload.openPos.length, 'open purchase order')}`);
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
          label: digestRangeLabel(now),
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
          src: esAssetUrl('bars@2x.gif'),
          alt: `Five weekly bars rise — activity across ${orgName} last week`,
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
      reasonHtml:
        'The weekly digest goes to workspace members who opted in — Mondays at 7:00 AM workspace time.',
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
// Byte-identical to the legacy templates.tsx renderer — the text part is
// outside the design package, and keeping it stable preserves the
// multipart behavior for text-preferring clients.

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
    blocks.push(`  → ${appUrl}/dashboard/purchase-orders`, '');
  }
  if (payload.openCycleCounts.length > 0) {
    blocks.push('CYCLE COUNTS IN PROGRESS');
    for (const cc of payload.openCycleCounts) {
      const started = new Date(cc.startedAt).toLocaleDateString('en-US');
      const wh = cc.warehouseName ?? 'Unassigned';
      const pct =
        cc.totalLines > 0
          ? `${Math.round((cc.countedLines / cc.totalLines) * 100)}%`
          : '—';
      blocks.push(
        `  ${started} · ${wh} · ${cc.countedLines}/${cc.totalLines} counted (${pct})`,
      );
    }
    blocks.push(`  → ${appUrl}/dashboard/cycle-counts`, '');
  }
  blocks.push(`Manage preferences: ${settingsUrl}`);
  return blocks.join('\n');
}

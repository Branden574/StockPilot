import { describe, expect, it } from 'vitest';

import { applySectionOptIns, isDigestEmpty } from '@/server/services/digest';

import { ES_MAX_HTML_BYTES } from '../tokens';
import { esEmailById } from '../registry';
import {
  DIGEST_FROM,
  digestRangeLabel,
  renderWeeklyDigestHtml,
  weeklyDigestPreviewSubject,
  weeklyDigestSubject,
  weeklyDigestText,
} from './digest';

import type { DigestPayload } from '@/server/services/digest';

/**
 * Digest family (E7) — the Monday briefing + its settings preview.
 * Pins: registry-byte-equal subjects, archetype composition (KPI grid /
 * action list / rows card / short pref footer note), the preview strip
 * with NO motion, an intentional all-clear state, section gating that
 * EXTENDS the legacy behavior (opted-out sections vanish entirely), and
 * the Gmail 102KB clip budget under a maximal seed payload.
 */

// 18:00Z renders as July 20 in UTC and every US timezone — keeps the
// literal-subject assertions timezone-stable on CI.
const NOW = new Date('2026-07-20T18:00:00Z');

const UUIDS = {
  item: '3f2a8c1e-1111-4222-8333-944444444444',
  po: '5b6c7d8e-2222-4333-8444-955555555555',
  cc: '7d8e9fa0-3333-4444-8555-966666666666',
};

function fullPayload(): DigestPayload {
  return {
    lowStock: [
      {
        warehouseName: 'DCIV — Fresno',
        items: [
          {
            id: UUIDS.item,
            sku: 'DRK-BTL-024',
            name: 'Insulated Bottle 24 oz',
            qty: 0,
            reorderPoint: 12,
          },
          {
            id: '3f2a8c1e-1111-4222-8333-944444444445',
            sku: 'DRK-TMB-016',
            name: 'Tumbler 16 oz',
            qty: 3,
            reorderPoint: 10,
          },
        ],
      },
    ],
    openPos: [
      {
        id: UUIDS.po,
        poNumber: 'PO-2041',
        supplierName: 'Meridian Supply Co',
        expectedAt: '2026-07-10T00:00:00Z',
        status: 'ordered',
        isOverdue: true,
      },
      {
        id: '5b6c7d8e-2222-4333-8444-955555555556',
        poNumber: 'PO-2042',
        supplierName: null,
        expectedAt: '2026-07-28T00:00:00Z',
        status: 'expected_inbound',
        isOverdue: false,
      },
    ],
    openCycleCounts: [
      {
        id: UUIDS.cc,
        warehouseName: 'CVW — Manchester',
        startedAt: '2026-07-16T09:00:00Z',
        totalLines: 44,
        countedLines: 18,
      },
    ],
  };
}

function emptyPayload(): DigestPayload {
  return { lowStock: [], openPos: [], openCycleCounts: [] };
}

const OPTS = {
  orgName: 'L4L North Region',
  appUrl: 'https://app.test',
  settingsUrl: 'https://app.test/dashboard/settings/notifications',
  recipientName: 'Dana Whitfield',
  now: NOW,
};

function assertNoBrokenMerge(html: string) {
  expect(html).not.toMatch(/\bundefined\b/);
  expect(html).not.toMatch(/\bnull\b/);
  expect(html).not.toContain('{{');
  for (const uuid of Object.values(UUIDS)) {
    expect(html).not.toContain(uuid);
  }
}

describe('digest subjects and sender (registry byte-equality)', () => {
  it('keeps the production subject byte-identical across the redesign', () => {
    expect(weeklyDigestSubject(NOW)).toBe(
      'StockPilot weekly digest — Monday, July 20, 2026',
    );
    expect(weeklyDigestSubject(NOW)).toBe(
      esEmailById('digest').subject({ date: 'Monday, July 20, 2026' }),
    );
  });

  it('preview subject carries the registry [Preview] prefix', () => {
    expect(weeklyDigestPreviewSubject(NOW)).toBe(
      '[Preview] StockPilot weekly digest — Monday, July 20, 2026',
    );
    expect(weeklyDigestPreviewSubject(NOW)).toBe(
      esEmailById('digest-preview').subject({ date: 'Monday, July 20, 2026' }),
    );
  });

  it('sends from the registry digest sender', () => {
    expect(DIGEST_FROM).toBe('StockPilot <digest@stockpilotusa.com>');
    expect(DIGEST_FROM).toBe(esEmailById('digest').from);
  });

  it('formats the range pill like the registry badge', () => {
    expect(digestRangeLabel(new Date('2026-06-15T18:00:00Z'))).toBe('Jun 8 – 14');
    expect(digestRangeLabel(new Date('2026-07-03T18:00:00Z'))).toBe(
      'Jun 26 – Jul 2',
    );
  });
});

describe('weekly digest — full payload', () => {
  const html = renderWeeklyDigestHtml(fullPayload(), OPTS);

  it('composes headline, KPI cards, action list, and in-progress rows', () => {
    expect(html).toContain('Your week, in order.');
    expect(html).toContain('Monday briefing &middot; two minutes.');
    expect(html).toContain('Jul 13 – 19');
    expect(html).toContain('Hi Dana —');
    // KPI cards for all three non-empty sections.
    expect(html).toContain('Low stock');
    expect(html).toContain('Open POs');
    expect(html).toContain('Cycle counts');
    expect(html).toContain('1 out of stock');
    expect(html).toContain('1 overdue');
    // Exceptions.
    expect(html).toContain('Needs action');
    expect(html).toContain('2 items at or below reorder point');
    expect(html).toContain('Insulated Bottle 24 oz is out at DCIV — Fresno');
    expect(html).toContain('1 purchase order overdue');
    expect(html).toContain('PO-2041');
    // In-progress rows (cycle counts).
    expect(html).toContain('In progress');
    expect(html).toContain('Cycle count — CVW — Manchester');
    expect(html).toContain('18/44 counted');
    // Single CTA to the dashboard.
    expect(html).toContain('Open dashboard &rarr;');
    expect(html).toContain('https://app.test/dashboard');
    assertNoBrokenMerge(html);
  });

  it('embeds the bars motion hero with reserved dimensions', () => {
    expect(html).toContain('https://stockpilotusa.com/email/bars@2x.gif');
    expect(html).toContain('width="528" height="194"');
    expect(html).toContain('Five weekly bars rise');
  });

  it('uses the pref footer with the digest archetype short note', () => {
    expect(html).toContain('>Manage email preferences</a>');
    expect(html).toContain('>Unsubscribe</a>');
    expect(html).toContain('workspace members who opted in — Mondays at 7:00 AM');
    expect(html).toContain('Unsubscribing stops this notification type only.');
    // The digest archetype SHORTENS the pref boilerplate — the long
    // variant must not appear.
    expect(html).not.toContain('security and account emails still arrive');
  });

  it('escapes user-derived merge values', () => {
    const spicy = renderWeeklyDigestHtml(fullPayload(), {
      ...OPTS,
      orgName: 'Meridian & Sons <Test>',
      recipientName: '<b>Dana</b>',
    });
    expect(spicy).toContain('Meridian &amp; Sons &lt;Test&gt;');
    expect(spicy).not.toContain('<b>Dana</b>');
  });
});

describe('weekly digest — all-clear state', () => {
  it('renders an intentional all-clear (never an empty shell)', () => {
    const html = renderWeeklyDigestHtml(emptyPayload(), OPTS);
    expect(html).toContain('All clear.');
    expect(html).toContain(
      'Nothing needs your attention this week. See you next Monday.',
    );
    expect(html).toContain('Exceptions');
    expect(html).toContain('It was a clean one.');
    // No KPI cards, action rows, or progress rows for empty sections.
    expect(html).not.toContain('Low stock');
    expect(html).not.toContain('Open POs');
    expect(html).not.toContain('In progress');
    // Still a complete email: hero, CTA, footer.
    expect(html).toContain('bars@2x.gif');
    expect(html).toContain('Open dashboard &rarr;');
    expect(html).toContain('>Unsubscribe</a>');
    assertNoBrokenMerge(html);
  });

  it('falls back to the design greeting when the name is missing', () => {
    const html = renderWeeklyDigestHtml(emptyPayload(), {
      ...OPTS,
      recipientName: null,
    });
    expect(html).toContain('Hi — ');
  });
});

describe('digest preview variant', () => {
  const html = renderWeeklyDigestHtml(fullPayload(), { ...OPTS, preview: true });

  it('prepends the purple preview strip', () => {
    expect(html).toContain(
      'Sent only to you — not the scheduled Monday digest.',
    );
    expect(html).toContain('background:#eae4f1');
    expect(html).toContain('>Preview.</strong>');
  });

  it('carries NO motion (registry: "None in preview banner")', () => {
    expect(html).not.toContain('bars@2x.gif');
    expect(html).not.toContain('.gif');
  });

  it('renders the all-clear preview without looking broken', () => {
    const empty = renderWeeklyDigestHtml(emptyPayload(), {
      ...OPTS,
      preview: true,
    });
    expect(empty).toContain('Sent only to you — not the scheduled Monday digest.');
    expect(empty).toContain('All clear.');
    expect(empty).toContain('Open dashboard &rarr;');
    expect(empty).toContain('Test render sent only to you — not the scheduled digest.');
    assertNoBrokenMerge(empty);
  });
});

describe('section gating — extended, not replaced', () => {
  it('drops every trace of an opted-out section', () => {
    const gated = applySectionOptIns(fullPayload(), {
      lowStock: true,
      openPos: false,
      cycleCounts: true,
    });
    const html = renderWeeklyDigestHtml(gated, OPTS);
    expect(html).not.toContain('Open POs');
    expect(html).not.toContain('purchase order');
    expect(html).not.toContain('PO-2041');
    // Enabled sections still render.
    expect(html).toContain('Low stock');
    expect(html).toContain('Cycle count — CVW — Manchester');
  });

  it('keeps the cron empty-skip contract intact when everything is opted out', () => {
    const gated = applySectionOptIns(fullPayload(), {
      lowStock: false,
      openPos: false,
      cycleCounts: false,
    });
    expect(isDigestEmpty(gated)).toBe(true);
  });
});

describe('weight budget (Gmail clip)', () => {
  it('stays under 102KB with a maximal seed payload', () => {
    const longName = (i: number) =>
      `Ultra Heavy Duty Industrial Warehouse Rack Component Model ${i} — Extended Description Edition`;
    const maximal: DigestPayload = {
      lowStock: Array.from({ length: 5 }, (_, g) => ({
        warehouseName: `Distribution Center ${g + 1} — Extremely Long Warehouse Location Name (Annex ${g + 1})`,
        items: Array.from({ length: 4 }, (_, i) => ({
          id: `00000000-0000-4000-8000-${String(g * 10 + i).padStart(12, '0')}`,
          sku: `SKU-${g}-${i}-EXTRA-LONG-IDENTIFIER-0001`,
          name: longName(g * 4 + i),
          qty: i === 0 ? 0 : i,
          reorderPoint: 25,
        })),
      })),
      openPos: Array.from({ length: 20 }, (_, i) => ({
        id: `11111111-0000-4000-8000-${String(i).padStart(12, '0')}`,
        poNumber: `PO-${9000 + i}-EXTENDED-NUMBERING-SCHEME`,
        supplierName: `Supplier ${i} International Consolidated Holdings & Partners LLC`,
        expectedAt: '2026-07-01T00:00:00Z',
        status: 'ordered',
        isOverdue: i % 2 === 0,
      })),
      openCycleCounts: Array.from({ length: 80 }, (_, i) => ({
        id: `22222222-0000-4000-8000-${String(i).padStart(12, '0')}`,
        warehouseName: `Distribution Center ${i} — Extremely Long Warehouse Location Name`,
        startedAt: '2026-07-01T00:00:00Z',
        totalLines: 500,
        countedLines: 250,
      })),
    };
    const html = renderWeeklyDigestHtml(maximal, {
      ...OPTS,
      orgName: 'The Longest Conceivable Organization Name For A Workspace, Incorporated',
    });
    const bytes = Buffer.byteLength(html, 'utf8');
    console.info(`[digest weight] maximal seed payload renders at ${bytes} bytes`);
    expect(bytes).toBeLessThan(ES_MAX_HTML_BYTES);
    // The in-progress rows cap keeps unbounded cycle counts from
    // clipping the unsubscribe footer.
    expect(html).toContain('72 more in progress');
  });
});

describe('plain-text part (unchanged from the legacy renderer)', () => {
  it('keeps the legacy multipart text structure', () => {
    const text = weeklyDigestText(fullPayload(), {
      orgName: OPTS.orgName,
      appUrl: OPTS.appUrl,
      settingsUrl: OPTS.settingsUrl,
    });
    expect(text).toContain('StockPilot weekly digest');
    expect(text).toContain('LOW / OUT OF STOCK');
    expect(text).toContain('OPEN PURCHASE ORDERS');
    expect(text).toContain('CYCLE COUNTS IN PROGRESS');
    expect(text).toContain('Manage preferences: https://app.test/dashboard/settings/notifications');
  });
});

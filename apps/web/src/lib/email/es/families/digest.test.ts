import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { applySectionOptIns, isDigestEmpty } from '@/server/services/digest';

import { ES_MAX_HTML_BYTES } from '../tokens';
import { esEmailById } from '../registry';
import {
  DIGEST_CRON_SCHEDULE,
  DIGEST_FROM,
  digestAsOfLabel,
  digestScheduleLabel,
  digestSendAt,
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
    lowStockTotal: 2,
    outOfStockTotal: 1,
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
    openPosTotal: 2,
    overduePosTotal: 1,
    openCycleCounts: [
      {
        id: UUIDS.cc,
        countNumber: 18,
        scopeLabel: 'CVW — Manchester',
        warehouseName: 'CVW — Manchester',
        startedAt: '2026-07-16T09:00:00Z',
        totalLines: 44,
        countedLines: 18,
      },
    ],
  };
}

function emptyPayload(): DigestPayload {
  return {
    lowStock: [],
    lowStockTotal: 0,
    outOfStockTotal: 0,
    openPos: [],
    openPosTotal: 0,
    overduePosTotal: 0,
    openCycleCounts: [],
  };
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

  it('dates the pill as of the send, not as a past week (the payload is current state)', () => {
    expect(digestAsOfLabel(new Date('2026-06-15T18:00:00Z'))).toBe('As of Jun 15');
    expect(digestAsOfLabel(new Date('2026-07-03T18:00:00Z'))).toBe('As of Jul 3');
  });
});

describe('when the digest says it is sent', () => {
  // The footer used to promise "Mondays at 7:00 AM workspace time". The cron
  // runs at one instant for every org: vercel.json "0 14 * * 1", 14:00 UTC.
  // That is 7:00 AM in Pacific summer, 6:00 AM in Pacific winter, 10:00 AM
  // Eastern, 2:00 PM for an org on the UTC default, and already Tuesday in
  // Sydney. The footer now states that instant in the workspace's zone.
  it('keeps the schedule the footer states equal to the cron in vercel.json', () => {
    const vercel = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../../../vercel.json'), 'utf8'),
    ) as { crons: Array<{ path: string; schedule: string }> };
    const cron = vercel.crons.find((c) => c.path === '/api/cron/weekly-digest');
    expect(cron?.schedule).toBe(DIGEST_CRON_SCHEDULE);
    expect(DIGEST_CRON_SCHEDULE).toBe('0 14 * * 1');
  });

  it('finds the run an email belongs to: this week for the Monday digest, the next one for a preview', () => {
    // Monday 14:00:45Z, the cron's own run.
    const run = new Date('2026-10-05T14:00:45Z');
    expect(digestSendAt(run, 'this-week').toISOString()).toBe('2026-10-05T14:00:00.000Z');
    // A preview on Wednesday is followed by next Monday's run.
    const wed = new Date('2026-10-07T09:00:00Z');
    expect(digestSendAt(wed, 'next').toISOString()).toBe('2026-10-12T14:00:00.000Z');
    // A preview on Monday morning is followed by that day's run.
    const monMorning = new Date('2026-10-05T08:00:00Z');
    expect(digestSendAt(monMorning, 'next').toISOString()).toBe('2026-10-05T14:00:00.000Z');
    // Sunday belongs to the week that started the Monday before.
    const sun = new Date('2026-10-11T20:00:00Z');
    expect(digestSendAt(sun, 'this-week').toISOString()).toBe('2026-10-05T14:00:00.000Z');
  });

  it('states the send time in the workspace time zone, daylight time included', () => {
    const summer = new Date('2026-07-20T14:00:00Z');
    const winter = new Date('2026-11-02T14:00:00Z');
    expect(digestScheduleLabel('America/Los_Angeles', summer)).toBe('Mondays at 7:00 AM PDT');
    expect(digestScheduleLabel('America/Los_Angeles', winter)).toBe('Mondays at 6:00 AM PST');
    expect(digestScheduleLabel('America/New_York', summer)).toBe('Mondays at 10:00 AM EDT');
    expect(digestScheduleLabel('UTC', summer)).toBe('Mondays at 2:00 PM UTC');
    // East of UTC+10 the run is already Tuesday.
    expect(digestScheduleLabel('Australia/Sydney', summer)).toMatch(/^Tuesdays at 12:00 AM /);
    // A zone this runtime does not know falls back like every other surface.
    expect(digestScheduleLabel('America/Fresno', summer)).toBe('Mondays at 7:00 AM PDT');
  });

  it('prints it in the footer, for the Monday digest and for a preview', () => {
    expect(renderWeeklyDigestHtml(fullPayload(), { ...OPTS, timeZone: 'UTC' })).toContain(
      'workspace members who opted in — Mondays at 2:00 PM UTC.',
    );
    // No zone passed: the documented fallback (resolveOrgTimezone).
    expect(renderWeeklyDigestHtml(fullPayload(), OPTS)).toContain(
      'workspace members who opted in — Mondays at 7:00 AM PDT.',
    );
    // A preview on Saturday Oct 31 (PDT) names the run after it, on Nov 2 (PST).
    const preview = renderWeeklyDigestHtml(fullPayload(), {
      ...OPTS,
      timeZone: 'America/Los_Angeles',
      preview: true,
      now: new Date('2026-10-31T18:00:00Z'),
    });
    expect(preview).toContain('Mondays at 6:00 AM PST.');
    expect(renderWeeklyDigestHtml(fullPayload(), OPTS)).not.toContain('workspace time');
  });
});

describe('counts are totals, not the twenty listed', () => {
  // The service lists the 20 lowest items and the first 20 open POs. The
  // email used to count those lists, so an org with more than 20 of either
  // read exactly "20" every week. The payload now carries the real totals.
  function capped(): DigestPayload {
    return {
      ...fullPayload(),
      lowStockTotal: 57,
      outOfStockTotal: 12,
      openPosTotal: 31,
      overduePosTotal: 9,
    };
  }

  it('prints the totals in the action list, the KPI cards and the preheader', () => {
    const html = renderWeeklyDigestHtml(capped(), OPTS);
    expect(html).toContain('57 items at or below reorder point');
    expect(html).toContain('12 out of stock');
    expect(html).toContain('9 purchase orders overdue');
    expect(html).toContain('9 overdue');
    expect(html).toContain('57 items low on stock &middot; 31 open purchase orders');
    expect(html).not.toContain('2 items at or below reorder point');
  });

  it('says how many the plain-text lists show of how many', () => {
    const text = weeklyDigestText(capped(), {
      orgName: OPTS.orgName,
      appUrl: OPTS.appUrl,
      settingsUrl: OPTS.settingsUrl,
    });
    expect(text).toContain('Showing the first 2 of 57.');
    expect(text).toContain('Showing the first 2 of 31.');
    // Nothing to add when the list is whole.
    const whole = weeklyDigestText(fullPayload(), {
      orgName: OPTS.orgName,
      appUrl: OPTS.appUrl,
      settingsUrl: OPTS.settingsUrl,
    });
    expect(whole).not.toContain('Showing the first');
  });
});

describe('weekly digest — full payload', () => {
  const html = renderWeeklyDigestHtml(fullPayload(), OPTS);

  it('composes headline, KPI cards, action list, and in-progress rows', () => {
    expect(html).toContain('Your week, in order.');
    expect(html).toContain('Monday briefing &middot; two minutes.');
    expect(html).toContain('As of Jul 20');
    // Current state, not last week's activity.
    expect(html).toContain('here&rsquo;s where');
    expect(html).not.toMatch(/last week/i);
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
    expect(html).toContain('Cycle count CC-000018 — CVW — Manchester');
    expect(html).toContain('18/44 counted');
    // Single CTA to the dashboard.
    expect(html).toContain('Open dashboard &rarr;');
    expect(html).toContain('https://app.test/dashboard');
    assertNoBrokenMerge(html);
  });

  it('embeds the bars motion hero with reserved dimensions', () => {
    expect(html).toContain('https://stockpilotusa.com/email/motion/bars@2x.gif');
    expect(html).toContain('width="528" height="194"');
    expect(html).toContain('Five bars rise');
  });

  it('uses the pref footer with the digest archetype short note', () => {
    expect(html).toContain('>Manage email preferences</a>');
    expect(html).toContain('>Unsubscribe</a>');
    expect(html).toContain('workspace members who opted in — Mondays at 7:00 AM PDT.');
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
    // The hero alt is attribute context — orgName must be escaped there too.
    expect(spicy).toContain('a snapshot of Meridian &amp; Sons &lt;Test&gt;');
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
    expect(html).toContain('Nothing needs a hand.');
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
    expect(html).toContain('Cycle count CC-000018 — CVW — Manchester');
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
      lowStockTotal: 20,
      outOfStockTotal: 5,
      openPosTotal: 20,
      overduePosTotal: 10,
      openCycleCounts: Array.from({ length: 80 }, (_, i) => ({
        id: `22222222-0000-4000-8000-${String(i).padStart(12, '0')}`,
        countNumber: 1_000_000 + i,
        scopeLabel: `Distribution Center ${i} — Extremely Long Warehouse Location Name`,
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

  it('names each open count by its reference and its real scope', () => {
    const payload = fullPayload();
    payload.openCycleCounts = [
      { ...payload.openCycleCounts[0]!, countNumber: 18, scopeLabel: 'CVW — Manchester' },
      { ...payload.openCycleCounts[0]!, id: 'cc-sel', countNumber: 19, scopeLabel: 'Selected items', warehouseName: null },
      { ...payload.openCycleCounts[0]!, id: 'cc-old', countNumber: null, scopeLabel: 'All warehouses', warehouseName: null },
    ];
    const text = weeklyDigestText(payload, {
      orgName: OPTS.orgName,
      appUrl: OPTS.appUrl,
      settingsUrl: OPTS.settingsUrl,
    });
    expect(text).toMatch(/ {2}CC-000018 · .* · CVW — Manchester · 18\/44 counted/);
    expect(text).toMatch(/ {2}CC-000019 · .* · Selected items · /);
    // No number: no made-up reference, and never the old "Unassigned".
    expect(text).toMatch(/\n {2}\d+\/\d+\/\d+ · All warehouses · /);
    expect(text).not.toContain('Unassigned');
  });
});

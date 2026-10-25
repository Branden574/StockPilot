import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { endAccountEpoch } from './account-epoch';
import { exceptionTimeLabel, getException, listExceptions } from './exceptions-api';
import { forgetOrgTimeZones, knownOrgTimeZone, orgTimeZone, withOrgTimeZone } from './org-zone';
import { getItemVerification } from './verification-api';

/**
 * The phone prints count, exception and verification times in the
 * ORGANIZATION's zone, as the web does, never the device's (B25, the F1-3
 * follow-up "phone time labels fall back to the device zone against an older
 * server").
 *
 * THE DEFECT. The zone came with each server answer, and an answer without one
 * (a server older than the phone's bundle) was printed in the DEVICE's zone:
 * exceptionTimeLabel fell back to toLocaleString, and so did the count list
 * without its summary's zone (offline, or an older server). A phone set to
 * another zone named another clock time than the web for the same moment.
 *
 * Executed with the device set to Tokyo, so a device-zone time cannot pass for
 * an organization's.
 */

const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

/** organizations.timezone as the member read answers it. */
const orgs = vi.hoisted(() => ({
  zone: 'America/New_York' as string | null,
  fail: false,
  reads: [] as string[],
}));
vi.mock('./supabase', () => {
  const chain = {
    select: () => chain,
    eq: (_col: string, id: string) => {
      orgs.reads.push(id);
      return chain;
    },
    maybeSingle: async () =>
      orgs.fail
        ? { data: null, error: { message: 'permission denied' } }
        : { data: { timezone: orgs.zone }, error: null },
  };
  return { supabase: { from: () => chain } };
});

const ORG = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const OCC = '55555555-5555-4555-8555-555555555555';
const AT = '2026-09-24T23:42:00Z';
// The same moment in each zone (the device is Tokyo: "Sep 25, 8:42 AM").
const NEW_YORK = 'Sep 24, 7:42 PM';
const CHICAGO = 'Sep 24, 6:42 PM';
const DEFAULT_ZONE = 'Sep 24, 4:42 PM';

const occurrence = {
  id: OCC,
  number: 1,
  reference: 'EX-000001',
  rule: 'stale_staging',
  severity: 'warning',
  itemId: ITEM,
  locationId: null,
  firstSeenAt: AT,
  lastSeenAt: AT,
  resolvedAt: null,
  resolvedReason: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  facts: {},
  canAct: false,
};

function listBody(o: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    status: 'open',
    occurrences: [occurrence],
    truncated: false,
    syncState: null,
    canCheckNow: false,
    ...o,
  };
}

function itemBody(o: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    itemId: ITEM,
    summary: {
      itemId: ITEM,
      item: {
        status: 'active',
        isRental: false,
        isBundle: false,
        deleted: false,
        countable: true,
        quantityOnHand: 4,
      },
      lastCount: null,
      movementsSince: 0,
      outsideLedgerSince: 0,
      openCount: null,
    },
    openIssues: [],
    openIssuesTruncated: false,
    checkedAt: AT,
    canCount: false,
    countUnavailableReason: null,
    ...o,
  };
}

const deviceZone = process.env.TZ;
beforeEach(() => {
  process.env.TZ = 'Asia/Tokyo';
  apiMock.api.mockReset();
  orgs.zone = 'America/New_York';
  orgs.fail = false;
  orgs.reads = [];
  forgetOrgTimeZones();
});
afterEach(() => {
  if (deviceZone === undefined) delete process.env.TZ;
  else process.env.TZ = deviceZone;
});

describe('an answer from a server that sends no zone', () => {
  it("an exceptions list prints the organization's zone, read once and remembered", async () => {
    apiMock.api.mockResolvedValue(listBody());
    const list = await listExceptions('open');
    expect(list.timeZone).toBe('America/New_York');
    expect(exceptionTimeLabel(list.occurrences[0]!.firstSeenAt, list.timeZone)).toBe(NEW_YORK);

    await listExceptions('resolved');
    expect(orgs.reads).toEqual([ORG]);
  });

  it("an exception's detail too", async () => {
    apiMock.api.mockResolvedValue({
      organizationId: ORG,
      occurrence,
      timeline: [],
      history: [],
      historyTruncated: false,
      syncState: null,
    });
    const detail = await getException(OCC);
    expect(detail.timeZone).toBe('America/New_York');
    expect(exceptionTimeLabel(detail.occurrence.lastSeenAt, detail.timeZone)).toBe(NEW_YORK);
  });

  it("an item's verification too", async () => {
    apiMock.api.mockResolvedValue(itemBody());
    const v = await getItemVerification(ITEM, { orgId: ORG });
    expect(v.timeZone).toBe('America/New_York');
  });

  it("when the organization's zone cannot be read: core's default zone, and the next answer reads again", async () => {
    orgs.fail = true;
    apiMock.api.mockResolvedValue(listBody());
    const list = await listExceptions('open');
    expect(list.timeZone).toBeNull();
    expect(exceptionTimeLabel(AT, list.timeZone)).toBe(DEFAULT_ZONE);

    orgs.fail = false;
    expect((await listExceptions('open')).timeZone).toBe('America/New_York');
    expect(orgs.reads).toEqual([ORG, ORG]);
  });
});

describe('an answer that carries its zone', () => {
  it('is used as sent, the organization is not read, and the zone is remembered for its organization', async () => {
    apiMock.api.mockResolvedValueOnce(listBody({ timeZone: 'America/Chicago' }));
    const list = await listExceptions('open');
    expect(exceptionTimeLabel(AT, list.timeZone)).toBe(CHICAGO);
    expect(orgs.reads).toEqual([]);
    expect(knownOrgTimeZone(ORG)).toBe('America/Chicago');

    // A later answer without one (a route this server lacks the zone on).
    apiMock.api.mockResolvedValueOnce(itemBody());
    expect((await getItemVerification(ITEM, { orgId: ORG })).timeZone).toBe('America/Chicago');
    expect(orgs.reads).toEqual([]);
  });
});

describe('orgTimeZone / withOrgTimeZone', () => {
  it('an account change forgets every zone (the next account reads its own)', async () => {
    expect(await orgTimeZone(ORG)).toBe('America/New_York');
    endAccountEpoch();
    expect(knownOrgTimeZone(ORG)).toBeNull();
    orgs.zone = 'America/Denver';
    expect(await orgTimeZone(ORG)).toBe('America/Denver');
    expect(orgs.reads).toEqual([ORG, ORG]);
  });

  it('an unset zone is not remembered and leaves the answer as it was', async () => {
    orgs.zone = null;
    const answer = { organizationId: ORG, timeZone: null, n: 1 };
    expect(await withOrgTimeZone(answer)).toBe(answer);
    expect(knownOrgTimeZone(ORG)).toBeNull();
  });
});

describe("the count screens print in the organization's zone (source: app/ cannot load under node)", () => {
  const read = (rel: string) => readFileSync(path.join(__dirname, rel), 'utf8');
  const list = read('../../app/(drawer)/(tabs)/cycle-counts.tsx');
  const count = read('../../app/cycle-count/[id].tsx');

  it("the count list: the summary zone, else the organization's, remembered only from an answer for this workspace", () => {
    expect(list).toContain('const tz = useOrgTimeZone(orgId, summary?.timezone);');
    expect(list).toMatch(
      /if \(!isCurrentListAnswer\(res, orgRef\.current[\s\S]+?rememberOrgTimeZone\(res\.organizationId, res\.summary\?\.timezone\);/,
    );
    expect(list).toContain(
      "return formatOrgDateTime(iso, { dateStyle: 'medium', timeStyle: 'short' }, timeZone);",
    );
  });

  it("the count screen's offline capture label: the organization's zone, read through org-zone.ts", () => {
    expect(count).toContain('const orgTimeZone = useOrgTimeZone(orgId);');
    expect(count).toContain(
      'offlineCaptureLabel({ captured_at: l.offlineCapturedAt }, orgTimeZone)',
    );
    expect(count).not.toMatch(/\.from\('organizations'\)/);
  });

  it('no count, exception or verification time is printed in the device zone', () => {
    for (const [name, source] of [
      ['cycle-counts.tsx', list],
      ['cycle-count/[id].tsx', count],
      ['exceptions-api.ts', read('exceptions-api.ts')],
      ['verification-api.ts', read('verification-api.ts')],
    ] as const) {
      expect(source, name).not.toMatch(/\.toLocale(?:Date|Time)?String\(/);
    }
  });
});

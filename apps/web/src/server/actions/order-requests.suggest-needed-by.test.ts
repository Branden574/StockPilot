import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * SP-047 regression. `suggestNeededByAction` used to instruct the model to
 * return "a full ISO-8601 datetime with -07:00 offset (America/Los_Angeles)".
 * That offset is Pacific DAYLIGHT time, so a winter deadline came back an hour
 * early, and every org outside California got Pacific wall-clock times (3-4h
 * off for America/New_York). The manager applies the suggestion verbatim via
 * setOrderNeededByAction, and approve() builds the schedule event + reminder
 * cron from `needed_by`, so the drift reaches the requester's ping.
 *
 * The contract now: the model returns a ZONE-LESS wall clock and the server
 * interprets it in the ORG's timezone.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(async () => undefined),
  revalidateInventoryListForOrg: vi.fn(async () => undefined),
}));

vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: { forCurrentUser: vi.fn() },
}));

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = { stub: null };

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'user-1',
      role: 'admin',
      supabase: stubHolder.stub!.client,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set(),
    })),
    assertPermission: vi.fn(() => undefined),
  };
});

vi.mock('@/lib/ai/provider', () => ({ resolveAiProvider: vi.fn(() => 'claude') }));

const claudeGenerateJson = vi.fn();
vi.mock('@/lib/ai/claude', () => ({
  claudeGenerateJson: (...a: unknown[]) => claudeGenerateJson(...a),
}));

const orgTimezone = { value: 'America/New_York' };
vi.mock('@/lib/dashboard/cached-org', () => ({
  getCachedOrgTimezone: vi.fn(async () => orgTimezone.value),
}));

import { suggestNeededByAction } from './order-requests';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

function stubWithNote(note: string) {
  return makeSupabaseStub({
    'order_requests.select': {
      data: { notes: note, needed_by: null, created_at: '2026-12-20T15:00:00.000Z' },
      error: null,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  orgTimezone.value = 'America/New_York';
  stubHolder.stub = stubWithNote('needed by Jan 15 @ 1pm');
  vi.useFakeTimers({ toFake: ['Date'] });
  // Fixed "now" so the 1-year forward guard and the prompt's local-now line
  // are deterministic regardless of when CI runs.
  vi.setSystemTime(new Date('2026-12-20T15:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('suggestNeededByAction — org timezone', () => {
  it('tells the model the ORG timezone and never a hardcoded Pacific offset', async () => {
    claudeGenerateJson.mockResolvedValue({ iso: '2027-01-15T13:00' });

    await suggestNeededByAction(ORDER_ID);

    expect(claudeGenerateJson).toHaveBeenCalledTimes(1);
    const call = claudeGenerateJson.mock.calls[0]![0] as { system: string; prompt: string };
    const text = `${call.system}\n${call.prompt}`;
    expect(text).toContain('America/New_York');
    expect(text).not.toContain('-07:00');
    expect(text).not.toContain('America/Los_Angeles');
  });

  it('interprets a zone-less wall clock in the org timezone (EST, not -07:00)', async () => {
    claudeGenerateJson.mockResolvedValue({ iso: '2027-01-15T13:00' });

    const res = await suggestNeededByAction(ORDER_ID);

    expect(res.ok).toBe(true);
    // 13:00 EST (UTC-5) = 18:00Z. The old prompt's -07:00 would have made it 20:00Z.
    expect(res.ok && res.data.iso).toBe('2027-01-15T18:00:00.000Z');
  });

  it('uses standard time in winter for a Pacific org (13:00 PST = 21:00Z, not 20:00Z)', async () => {
    orgTimezone.value = 'America/Los_Angeles';
    claudeGenerateJson.mockResolvedValue({ iso: '2027-01-15T13:00' });

    const res = await suggestNeededByAction(ORDER_ID);

    expect(res.ok && res.data.iso).toBe('2027-01-15T21:00:00.000Z');
  });

  it('uses daylight time in summer for a Pacific org (13:00 PDT = 20:00Z)', async () => {
    orgTimezone.value = 'America/Los_Angeles';
    claudeGenerateJson.mockResolvedValue({ iso: '2027-07-15T13:00' });

    const res = await suggestNeededByAction(ORDER_ID);

    expect(res.ok && res.data.iso).toBe('2027-07-15T20:00:00.000Z');
  });

  it('still accepts an offset-bearing answer as an absolute instant (fallback)', async () => {
    claudeGenerateJson.mockResolvedValue({ iso: '2027-01-15T13:00:00-05:00' });

    const res = await suggestNeededByAction(ORDER_ID);

    expect(res.ok && res.data.iso).toBe('2027-01-15T18:00:00.000Z');
  });

  it('reads a date-only answer as 09:00 org-local, not UTC midnight', async () => {
    claudeGenerateJson.mockResolvedValue({ iso: '2027-01-15' });

    const res = await suggestNeededByAction(ORDER_ID);

    // 09:00 EST = 14:00Z. Bare `new Date('2027-01-15')` would be 00:00Z — in the
    // past-of-nothing sense fine, but it is a different DAY in the org's zone.
    expect(res.ok && res.data.iso).toBe('2027-01-15T14:00:00.000Z');
  });

  it('returns null for garbage or an out-of-range answer', async () => {
    claudeGenerateJson.mockResolvedValue({ iso: 'sometime next quarter' });
    expect(
      (await suggestNeededByAction(ORDER_ID)) as { data?: { iso: string | null } },
    ).toMatchObject({
      data: { iso: null },
    });

    // More than a year out — the existing sanity window still applies.
    claudeGenerateJson.mockResolvedValue({ iso: '2029-01-15T13:00' });
    expect(
      (await suggestNeededByAction(ORDER_ID)) as { data?: { iso: string | null } },
    ).toMatchObject({
      data: { iso: null },
    });
  });

  it('returns null (and never calls the model) when the order already has a needed_by', async () => {
    stubHolder.stub = makeSupabaseStub({
      'order_requests.select': {
        data: {
          notes: 'needed by Jan 15 @ 1pm',
          needed_by: '2027-01-15T18:00:00.000Z',
          created_at: '2026-12-20T15:00:00.000Z',
        },
        error: null,
      },
    });

    const res = await suggestNeededByAction(ORDER_ID);

    expect(res.ok && res.data.iso).toBeNull();
    expect(claudeGenerateJson).not.toHaveBeenCalled();
  });
});

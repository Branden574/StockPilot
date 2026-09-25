import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The Exception Center sync cron (F1-1): CRON_SECRET-gated, one org at a
 * time, least recently synced first, fail-open per org, and a soft deadline
 * so a slow run stops itself instead of being killed mid-sweep.
 */

const envHolder = { env: { CRON_SECRET: 'test-cron-secret' } as { CRON_SECRET?: string } };
vi.mock('@/lib/env', () => ({
  get env() {
    return envHolder.env;
  },
}));

const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', () => ({ reportError }));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

const syncOrg = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/exception-occurrences', () => ({
  ExceptionOccurrencesService: { syncOrg },
}));

import { GET } from './route';

function req(auth?: string): NextRequest {
  return new Request('https://test.local/api/cron/exception-occurrences', {
    headers: auth ? { authorization: auth } : {},
  }) as unknown as NextRequest;
}

function orgsStub(opts: {
  orgs: string[];
  synced?: Record<string, string>;
  stateError?: boolean;
}) {
  const stub = makeSupabaseStub({
    'organizations.select': { data: opts.orgs.map((id) => ({ id })), error: null },
    'exception_sync_state.select': opts.stateError
      ? { data: null, error: { message: 'boom' } }
      : {
          data: Object.entries(opts.synced ?? {}).map(([organization_id, last_synced_at]) => ({
            organization_id,
            last_synced_at,
          })),
          error: null,
        },
  });
  adminHolder.client = stub.client;
  return stub;
}

const APPLIED = { status: 'applied', raised: 0, seen: 0, resolved: 0, recountsClosed: 0, dropped: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  envHolder.env = { CRON_SECRET: 'test-cron-secret' };
  syncOrg.mockResolvedValue(APPLIED);
});

describe('GET /api/cron/exception-occurrences — secret gate', () => {
  it('refuses a missing header', async () => {
    orgsStub({ orgs: ['o1'] });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(syncOrg).not.toHaveBeenCalled();
  });

  it('refuses a wrong secret of the same length', async () => {
    orgsStub({ orgs: ['o1'] });
    const res = await GET(req('Bearer test-cron-secreT'));
    expect(res.status).toBe(401);
    expect(syncOrg).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when CRON_SECRET is not configured', async () => {
    envHolder.env = {};
    orgsStub({ orgs: ['o1'] });
    const res = await GET(req('Bearer '));
    expect(res.status).toBe(503);
    expect(syncOrg).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/exception-occurrences — the sweep', () => {
  it('syncs every org, least recently synced first, never-synced leading, unforced', async () => {
    orgsStub({
      orgs: ['a', 'b', 'c', 'd'],
      synced: { a: '2026-09-24T18:00:00Z', b: '2026-09-24T17:00:00Z', d: '2026-09-24T18:30:00Z' },
    });
    const res = await GET(req('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(syncOrg.mock.calls.map((c) => c[0])).toEqual(['c', 'b', 'a', 'd']);
    for (const call of syncOrg.mock.calls) expect(call[1]).toEqual({ reason: 'cron' });
    expect(await res.json()).toMatchObject({ orgs: 4, processed: 4, deferredForTime: 0, applied: 4 });
  });

  it('one failing org does not stop the rest, and the tally says so', async () => {
    orgsStub({ orgs: ['a', 'b', 'c'] });
    syncOrg
      .mockResolvedValueOnce(APPLIED)
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'throttled', lastSyncedAt: '2026-09-24T18:00:00Z' });
    const res = await GET(req('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(syncOrg).toHaveBeenCalledTimes(3);
    expect(await res.json()).toMatchObject({ processed: 3, applied: 1, failed: 1, throttled: 1 });
  });

  it('even a sync that THROWS does not stop the sweep (syncOrg promises never to; the route does not rely on it)', async () => {
    orgsStub({ orgs: ['a', 'b'] });
    syncOrg.mockRejectedValueOnce(new Error('unexpected')).mockResolvedValueOnce(APPLIED);
    const res = await GET(req('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(syncOrg.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(await res.json()).toMatchObject({ processed: 2, applied: 1, failed: 1 });
    const tags = reportError.mock.calls.map((c) => (c as unknown as [unknown, { tag: string }])[1].tag);
    expect(tags).toEqual(['exceptions.sync_failed']);
  });

  it('a failed ordering read still sweeps every org, in id order', async () => {
    orgsStub({ orgs: ['a', 'b'], stateError: true });
    const res = await GET(req('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(syncOrg.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('stops STARTING orgs at the soft deadline and reports how many it left', async () => {
    orgsStub({ orgs: ['a', 'b', 'c'] });
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    syncOrg.mockImplementation(async () => {
      now += 30_000; // each org takes 30 s
      return APPLIED;
    });
    const res = await GET(req('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    // a starts at 0 s, b at 30 s, c would start at 60 s: past the 45 s deadline.
    expect(syncOrg.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(await res.json()).toMatchObject({ processed: 2, deferredForTime: 1 });
    const tags = reportError.mock.calls.map((c) => (c as unknown as [unknown, { tag: string }])[1].tag);
    expect(tags).toContain('cron.exception-occurrences.deadline');
    vi.mocked(Date.now).mockRestore();
  });
});

describe('the cron imports the shared helpers', () => {
  it('uses the shared secretsEqual and pastes no copy of either helper', () => {
    // The daily-briefing guard caps the route copies (6 and 19, both at their
    // caps); a new cron must import server/services/lib/system-context.ts.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'route.ts'), 'utf8');
    expect(src).toMatch(/import \{ secretsEqual \} from '@\/server\/services\/lib\/system-context'/);
    expect(src).not.toMatch(/function\s+secretsEqual\s*\(/);
    expect(src).not.toMatch(/function\s+buildSystemContext\s*\(/);
  });
});

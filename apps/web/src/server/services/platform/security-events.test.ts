import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The platform console's read of security events (service client): named
 * columns only (never the source hash or the row key), newest first, every
 * organization and none, the organization's name from one batched read. A
 * failed read of the rows throws with the code only; a failed read of the
 * names degrades to no names, reported as a warning.
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; chain: Array<[string, unknown[]]> }>,
  answers: {} as Record<string, { data: unknown; error: unknown }>,
  degraded: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      const chain: Array<[string, unknown[]]> = [];
      h.calls.push({ table, chain });
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'limit', 'in', 'range', 'eq']) {
        q[m] = (...args: unknown[]) => {
          chain.push([m, args]);
          return q;
        };
      }
      q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve(h.answers[table] ?? { data: [], error: null }).then(ok, bad);
      return q;
    },
  }),
}));
vi.mock('@/server/services/lib/fetch-by-ids', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/lib/fetch-by-ids')>();
  return { ...real, reportDegradedRead: h.degraded };
});

import { listPlatformSecurityEvents, PLATFORM_SECURITY_EVENT_COLUMNS } from './security-events';

const ORG_A = '0f1e2d3c-4b5a-4968-8776-655443322110';

const ROW = {
  id: 'e1',
  minute: '2026-11-20T10:15:00+00:00',
  category: 'exploit',
  outcome: 'blocked',
  reason: 'env_file',
  source: 'web',
  organization_id: null,
  country: 'DE',
  city: 'Leipzig',
  event_count: 12,
  last_seen_at: '2026-11-20T10:15:31+00:00',
};

beforeEach(() => {
  h.calls = [];
  h.answers = {};
});

describe('listPlatformSecurityEvents', () => {
  it('reads named columns only: never the source hash or the row key', async () => {
    await listPlatformSecurityEvents();
    const select = h.calls[0]!.chain.find(([m]) => m === 'select')![1][0] as string;
    expect(h.calls[0]!.table).toBe('security_events');
    expect(select).toBe(PLATFORM_SECURITY_EVENT_COLUMNS);
    expect(select.split(',').map((c) => c.trim())).toEqual([
      'id',
      'minute',
      'category',
      'outcome',
      'reason',
      'source',
      'organization_id',
      'country',
      'city',
      'event_count',
      'last_seen_at',
    ]);
    expect(select).not.toMatch(/source_hash|dedupe_key|\*/);
  });

  it('newest first, 200 by default, at most 500', async () => {
    await listPlatformSecurityEvents();
    expect(h.calls[0]!.chain.filter(([m]) => m !== 'select')).toEqual([
      ['order', ['minute', { ascending: false }]],
      ['order', ['last_seen_at', { ascending: false }]],
      ['order', ['id']],
      ['limit', [200]],
    ]);
    await listPlatformSecurityEvents({ limit: 10_000 });
    expect(h.calls.at(-1)!.chain.at(-1)).toEqual(['limit', [500]]);
  });

  it('every organization and none, with the names from one batched read', async () => {
    h.answers.security_events = {
      data: [
        ROW,
        { ...ROW, id: 'e2', category: 'password_guessing', reason: 'wrong_password', organization_id: ORG_A, event_count: '3' },
        { ...ROW, id: 'e3', category: 'password_guessing', reason: 'over_minute_cap', organization_id: ORG_A, country: null, city: null },
      ],
      error: null,
    };
    h.answers.organizations = { data: [{ id: ORG_A, name: 'Example School District' }], error: null };
    const rows = await listPlatformSecurityEvents();
    expect(rows.map((r) => [r.id, r.organizationId, r.organizationName, r.count])).toEqual([
      ['e1', null, null, 12],
      ['e2', ORG_A, 'Example School District', 3],
      ['e3', ORG_A, 'Example School District', 12],
    ]);
    const names = h.calls.filter((c) => c.table === 'organizations');
    expect(names).toHaveLength(1);
    expect(names[0]!.chain).toContainEqual(['in', ['id', [ORG_A]]]);
    expect(names[0]!.chain).toContainEqual(['select', ['id, name']]);
  });

  it('a failed read of the rows throws with the code only', async () => {
    h.answers.security_events = { data: null, error: { code: '57014', message: 'timeout reading for 198.51.100.7' } };
    await expect(listPlatformSecurityEvents()).rejects.toThrow('security_events read failed (57014)');
  });

  it('a failed read of the names shows the rows without names, reported as degraded', async () => {
    h.answers.security_events = { data: [{ ...ROW, organization_id: ORG_A }], error: null };
    h.answers.organizations = { data: null, error: { code: '57014', message: 'timeout' } };
    const rows = await listPlatformSecurityEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: ORG_A, organizationName: null });
    expect(h.degraded).toHaveBeenCalledWith('platform-security-events.org-names', expect.anything(), {
      count: 1,
    });
  });
});

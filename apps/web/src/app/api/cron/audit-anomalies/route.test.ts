import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hourly audit-anomaly monitor also watches refused authenticator and
 * recovery codes (mfa.code_refused, mfa.recovery.failed): a burst for one
 * account or from one address is reported to the alerts feed. Every run logs
 * one summary line of counts, so a run that found nothing still shows in the
 * logs that the detectors ran.
 */

const { ROUTE_TEST_VALUE, reportError, query } = vi.hoisted(() => ({
  ROUTE_TEST_VALUE: 'route-test-value',
  reportError: vi.fn(),
  query: { events: [] as string[], rows: [] as unknown[] },
}));

vi.mock('@/lib/env', () => ({ env: { CRON_SECRET: ROUTE_TEST_VALUE } }));
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.in = (_column: string, values: string[]) => {
        query.events = values;
        return chain;
      };
      chain.gte = () => chain;
      chain.order = () => chain;
      chain.range = async () => ({ data: query.rows, error: null });
      return chain;
    },
  }),
}));

import { GET } from './route';

function request(authorization?: string) {
  return new Request('https://app.example.com/api/cron/audit-anomalies', {
    headers: authorization ? { authorization } : {},
  });
}

function row(event: string, userId: string | null, ip: string | null) {
  return {
    event,
    user_id: userId,
    organization_id: null,
    ip,
    metadata: null,
    created_at: '2026-11-02T00:00:00Z',
  };
}

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  query.events = [];
  query.rows = [];
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
});

describe('GET /api/cron/audit-anomalies', () => {
  it('refuses a request without the cron secret', async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
  });

  it('reads the refused authenticator and recovery codes with the other watched events', async () => {
    await GET(request(`Bearer ${ROUTE_TEST_VALUE}`));

    expect(query.events).toEqual(
      expect.arrayContaining(['mfa.code_refused', 'mfa.recovery.failed', 'user.sign_in_failed']),
    );
  });

  it('reports five refused codes for one account in the hour', async () => {
    query.rows = [
      row('mfa.code_refused', 'user-a', '198.51.100.1'),
      row('mfa.code_refused', 'user-a', '198.51.100.2'),
      row('mfa.code_refused', 'user-a', '198.51.100.3'),
      row('mfa.recovery.failed', 'user-a', '198.51.100.4'),
      row('mfa.code_refused', 'user-a', '198.51.100.5'),
    ];

    const res = await GET(request(`Bearer ${ROUTE_TEST_VALUE}`));
    const body = (await res.json()) as {
      flagged: number;
      byDetector: Record<string, number>;
    };

    expect(res.status).toBe(200);
    expect(body.flagged).toBe(1);
    expect(body.byDetector).toEqual(
      expect.objectContaining({ refusedCodeUser: 1, refusedCodeIp: 0 }),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tag: 'cron.audit-anomaly',
        level: 'warning',
        extra: expect.objectContaining({ kind: 'refused_code_user', userId: 'user-a', count: 5 }),
      }),
    );
  });

  it('reports fifteen refused codes from one address across accounts', async () => {
    query.rows = Array.from({ length: 15 }, (_, i) =>
      row('mfa.code_refused', `user-${i}`, '203.0.113.9'),
    );

    const res = await GET(request(`Bearer ${ROUTE_TEST_VALUE}`));
    const body = (await res.json()) as { byDetector: Record<string, number> };

    expect(body.byDetector).toEqual(
      expect.objectContaining({ refusedCodeUser: 0, refusedCodeIp: 1 }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        extra: expect.objectContaining({ kind: 'refused_code_ip', ip: '203.0.113.9', count: 15 }),
      }),
    );
  });

  it('logs one summary line of counts on every run, also when nothing is found', async () => {
    const res = await GET(request(`Bearer ${ROUTE_TEST_VALUE}`));
    expect(res.status).toBe(200);

    const lines = info.mock.calls.map((c: unknown[]) => c.map(String).join(' '));
    const summary = lines.filter((l: string) => l.includes('[cron.audit-anomaly]'));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain('"rowsScanned":0');
    expect(summary[0]).toContain('"flagged":0');
    expect(summary[0]).toContain('"refusedCodeUser":0');
    expect(summary[0]).toContain('"refusedCodeIp":0');
  });
});

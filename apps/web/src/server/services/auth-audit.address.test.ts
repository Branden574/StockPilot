import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * emitAuthAudit reads the request's IP by the one rule (lib/client-ip.ts):
 * x-forwarded-for only on Vercel, where the platform sets it, else x-real-ip,
 * and null for anything that is not an IP literal (audit_logs.ip is inet).
 *
 * Addresses are from the documentation ranges (RFC 5737).
 */

const h = vi.hoisted(() => ({
  headers: {} as Record<string, string>,
  insertAuditRowReported: vi.fn(async (_row: Record<string, unknown>) => true),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(h.headers),
}));
vi.mock('@/server/services/audit', () => ({
  insertAuditRowReported: h.insertAuditRowReported,
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { emitAuthAudit } from './auth-audit';

const USER = '11111111-1111-4111-8111-111111111111';

async function rowIp(): Promise<unknown> {
  h.insertAuditRowReported.mockClear();
  await emitAuthAudit({ event: 'user.signed_in', userId: USER, organizationId: null });
  return h.insertAuditRowReported.mock.calls[0]![0].ip;
}

beforeEach(() => {
  h.headers = { 'user-agent': 'test-agent/1.0' };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('emitAuthAudit — the row’s IP', () => {
  it('on Vercel: the first x-forwarded-for hop', async () => {
    vi.stubEnv('VERCEL', '1');
    h.headers['x-forwarded-for'] = '203.0.113.7, 10.0.0.1';
    expect(await rowIp()).toBe('203.0.113.7');
  });

  it('off Vercel: x-forwarded-for is not read; x-real-ip, else null', async () => {
    vi.stubEnv('VERCEL', '');
    h.headers['x-forwarded-for'] = '203.0.113.7';
    expect(await rowIp()).toBeNull();
    h.headers['x-real-ip'] = '198.51.100.2';
    expect(await rowIp()).toBe('198.51.100.2');
  });

  it('a value that is not an IP literal is null, never text in an inet column', async () => {
    vi.stubEnv('VERCEL', '1');
    h.headers['x-forwarded-for'] = 'not-an-address';
    expect(await rowIp()).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The phone's password-reset request keys its per-address bucket by the one
 * rule (lib/client-ip.ts): x-forwarded-for only on Vercel, where the platform
 * sets it, else x-real-ip, else the 'unknown' bucket. No email is sent here:
 * the sender is a mock.
 *
 * Addresses are from the documentation ranges (RFC 5737).
 */

const h = vi.hoisted(() => ({
  checkRateLimit: vi.fn(
    async (_key: string, _limit: number, _windowMs: number, _mode?: string) => ({
      allowed: true,
      count: 1,
      resetAt: 0,
    }),
  ),
  sendPasswordResetEmail: vi.fn(async (_email: string) => undefined),
}));

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock('@/lib/auth/password-reset-email', () => ({
  sendPasswordResetEmail: h.sendPasswordResetEmail,
}));

import { POST } from './route';

function post(headers: Record<string, string>) {
  return POST(
    new Request('http://localhost/api/v1/auth/password-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email: 'member@example.com' }),
    }) as unknown as Parameters<typeof POST>[0],
  );
}

const ipKey = () => h.checkRateLimit.mock.calls.find((c) => c[0].startsWith('pwreset-ip:'))?.[0];

beforeEach(() => {
  h.checkRateLimit.mockClear();
  h.sendPasswordResetEmail.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/v1/auth/password-reset — the per-address bucket', () => {
  it('on Vercel: the first x-forwarded-for hop, closed', async () => {
    vi.stubEnv('VERCEL', '1');
    await post({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
    expect(h.checkRateLimit).toHaveBeenCalledWith(
      'pwreset-ip:203.0.113.7',
      10,
      15 * 60_000,
      'closed',
    );
  });

  it('off Vercel: x-forwarded-for is not read; x-real-ip, else unknown', async () => {
    vi.stubEnv('VERCEL', '');
    await post({ 'x-forwarded-for': '203.0.113.7' });
    expect(ipKey()).toBe('pwreset-ip:unknown');
    h.checkRateLimit.mockClear();
    await post({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.2' });
    expect(ipKey()).toBe('pwreset-ip:198.51.100.2');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * checkRateLimit records a REFUSAL of an anonymous public endpoint as a
 * security event (bots / blocked / <family>_paused), through the one map in
 * server/security/limiter-events.ts. A refusal of any other key, a limiter
 * that could not count (`failed`), in either mode, and an allowed request
 * record nothing; the answer the caller gets is unchanged either way.
 */

const h = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));

import { recordSecurityEvent } from '@/server/security/events';
import {
  LIMITER_BOT_PREFIXES,
  LIMITER_NOT_SECURITY_EVENTS,
  limiterSecurityEvent,
} from '@/server/security/limiter-events';

import { checkRateLimit } from './rate-limit';

const refusedRow = { data: [{ allowed: false, count: 61, reset_at: '2026-11-21T10:16:00Z' }], error: null };
const allowedRow = { data: [{ allowed: true, count: 1, reset_at: '2026-11-21T10:16:00Z' }], error: null };

beforeEach(() => {
  h.rpc.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('checkRateLimit: a refusal of an anonymous endpoint is a security event', () => {
  it.each([
    ['public-order-request:203.0.113.7', 'public_order_paused', 'web'],
    ['public-order-request:token:abc', 'public_order_paused', 'web'],
    ['public-return-options:ip:203.0.113.7', 'public_return_paused', 'web'],
    ['maintenance:share:ip:203.0.113.7', 'share_link_paused', 'web'],
    ['order-sign:0123abcd', 'share_link_paused', 'web'],
    ['unsubscribe:link:0123abcd', 'unsubscribe_paused', 'web'],
    ['support:ip:203.0.113.7', 'support_paused', 'web'],
    ['pwreset-req:ada@example.com', 'password_reset_paused', 'web'],
    ['pwreset-ip:203.0.113.7', 'password_reset_paused', 'phone'],
    ['public-api-ip:203.0.113.7', 'public_api_paused', 'api'],
    ['easypost-webhook:203.0.113.7', 'webhook_paused', 'api'],
    ['books-lookup:203.0.113.7', 'isbn_lookup_paused', 'web'],
    ['public-catalog-thumbnails:ip:203.0.113.7', 'public_catalog_paused', 'web'],
  ])('%s -> %s from %s', async (key, reason, source) => {
    h.rpc.mockResolvedValue(refusedRow);
    expect(await checkRateLimit(key, 60, 60_000, 'closed')).toMatchObject({ allowed: false });
    expect(recordSecurityEvent).toHaveBeenCalledTimes(1);
    expect(recordSecurityEvent).toHaveBeenCalledWith({ category: 'bots', outcome: 'blocked', reason, source });
  });

  it.each([
    ['signin:ada@example.com', 'recorded by signInAction itself'],
    ['mfa-code:u1:203.0.113.7', 'recorded by the code check itself'],
    ['order-sign:member:u1', 'a signed-in member'],
    ['stock-adjust:u1', 'a signed-in member'],
    ['api-key:key-1', 'a working key'],
    ['return-request-write:u1', 'a signed-in member (a template prefix)'],
    ['never-listed:x', 'a prefix on neither list'],
  ])('%s (%s): nothing recorded, the refusal unchanged', async (key) => {
    h.rpc.mockResolvedValue(refusedRow);
    expect(await checkRateLimit(key, 5, 60_000, 'closed')).toMatchObject({ allowed: false });
    expect(recordSecurityEvent).not.toHaveBeenCalled();
  });

  it('an allowed request records nothing', async () => {
    h.rpc.mockResolvedValue(allowedRow);
    expect(await checkRateLimit('public-order-request:203.0.113.7', 60, 60_000, 'closed')).toMatchObject({
      allowed: true,
    });
    expect(recordSecurityEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['an error answer', () => h.rpc.mockResolvedValue({ data: null, error: { message: 'x' } })],
    ['no row', () => h.rpc.mockResolvedValue({ data: [], error: null })],
    ['a throw', () => h.rpc.mockRejectedValue(new Error('fetch failed'))],
  ])('a limiter that could not count (%s) records nothing, closed or open', async (_what, arrange) => {
    arrange();
    expect(await checkRateLimit('public-order-request:203.0.113.7', 60, 60_000, 'closed')).toMatchObject({
      allowed: false,
      failed: true,
    });
    expect(await checkRateLimit('public-order-request:203.0.113.7', 60, 60_000, 'open')).toMatchObject({
      allowed: true,
      failed: true,
    });
    expect(recordSecurityEvent).not.toHaveBeenCalled();
  });
});

describe('the map', () => {
  it('no prefix is on both lists', () => {
    const both = Object.keys(LIMITER_BOT_PREFIXES).filter((p) =>
      Object.prototype.hasOwnProperty.call(LIMITER_NOT_SECURITY_EVENTS, p),
    );
    expect(both).toEqual([]);
  });

  it('every "not" entry gives a reason', () => {
    for (const [prefix, reason] of Object.entries(LIMITER_NOT_SECURITY_EVENTS)) {
      expect(reason.length, prefix).toBeGreaterThan(20);
    }
  });

  it('the sign-in, authenticator and recovery prefixes are on the "not" list: their call sites record', () => {
    for (const prefix of [
      'signin:',
      'signin-ip:',
      'mfa-code:',
      'mfa-code-account:',
      'mfa-recovery:',
      'mfa-recovery-password:',
      'mfa-recovery-code:',
    ]) {
      expect(LIMITER_NOT_SECURITY_EVENTS[prefix], prefix).toMatch(/call site/);
    }
  });

  it('the longest prefix answers: a member’s signature key is not the public link’s', () => {
    expect(limiterSecurityEvent('order-sign:member:u1')).toBeNull();
    expect(limiterSecurityEvent('order-sign:9f86d081')).toMatchObject({ reason: 'share_link_paused' });
    expect(limiterSecurityEvent('mfa-code-account:u1')).toBeNull();
    expect(limiterSecurityEvent('')).toBeNull();
  });
});

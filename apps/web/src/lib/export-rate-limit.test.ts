// @vitest-environment node
// Node, not a DOM: a browser-like Request drops the header names a page may
// not set (Sec-Fetch-*), and the server receives them as sent.
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared export limiter's 429. Exports are never cached anywhere, answers
 * or refusals (lib/reports/export-errors.ts); the limiter's refusal carried
 * only retry-after (review nit, 2026-09-29), so it now says no-store too.
 */

const admin = vi.hoisted(() => ({ throws: false }));

vi.mock('./rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    // The 2026-07-21 outage class: an unset service-role key throws here.
    if (admin.throws) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
    return {
      from: () => ({
        insert: () => Promise.resolve({ error: null }),
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      }),
    };
  },
}));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

import { insertAuditRowReported } from '@/server/services/audit';
import { dispatchEvent } from '@/server/services/integration-events';

import { exportRateLimited } from './export-rate-limit';
import { checkRateLimit } from './rate-limit';

const EXPORT_URL = 'https://app.test/api/inventory/export.csv?status=active&q=secret-filter';

function req(headers: Record<string, string> = {}) {
  return new Request(EXPORT_URL, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  admin.throws = false;
});

describe('exportRateLimited', () => {
  it('under the limit: null (the export proceeds)', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 1000,
    });
    await expect(exportRateLimited(req(), 'user-1', 'org-1')).resolves.toBeNull();
  });

  it('over the limit: 429 rate_limited with retry-after, never cached', async () => {
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: false, count: 41, resetAt: Date.now() + 90_000 })
      .mockResolvedValue({ allowed: false, count: 2, resetAt: Date.now() + 90_000 });
    const res = await exportRateLimited(req(), 'user-1', 'org-1');
    expect(res?.status).toBe(429);
    expect(await res!.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(res!.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(res!.headers.get('cache-control')).toBe('no-store');
  });
});

describe('exportRateLimited: the trip row', () => {
  // Mutation caught: the bare `void createAdminClient().from('audit_logs')
  // .insert(...)` it replaced, which nothing kept alive past the 429 and
  // which never reported a lost row (insertAuditRowReported does both,
  // services/audit.test.ts and audit.keepalive.test.ts).
  it('goes through insertAuditRowReported, one row per refusal', async () => {
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: false, count: 41, resetAt: Date.now() + 90_000 })
      .mockResolvedValue({ allowed: false, count: 2, resetAt: Date.now() + 90_000 });
    await exportRateLimited(req(), 'user-1', 'org-1');
    expect(insertAuditRowReported).toHaveBeenCalledTimes(1);
    expect(insertAuditRowReported).toHaveBeenCalledWith({
      organization_id: 'org-1',
      user_id: 'user-1',
      event: 'security.export_rate_limited',
      metadata: {},
    });
  });

  // Mutation caught: createAdminClient() called outside any catch, so a
  // missing service key turned the 429 into a thrown error (a 500).
  it('a service client that cannot be made still answers the 429', async () => {
    admin.throws = true;
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: false, count: 41, resetAt: Date.now() + 90_000 })
      .mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 90_000 });
    const res = await exportRateLimited(req(), 'user-1', 'org-1');
    expect(res?.status).toBe(429);
  });

  it('no organization: no row', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 41,
      resetAt: Date.now() + 90_000,
    });
    expect((await exportRateLimited(req(), 'user-1'))?.status).toBe(429);
    expect(insertAuditRowReported).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AN EXPORT ANOTHER ORIGIN'S PAGE ASKED FOR (docket S14 review). The export
// routes are GETs, which the cross-site write rule never judges, and the
// browser sends the session cookie with a top-level navigation from any site
// (SameSite=Lax) and with an image a sibling subdomain loads (the same site).
// Each such request spent the person's one budget (40 an hour, fail closed),
// ran the export, and past the limit wrote a security.export_rate_limited
// audit row in their name and sent the organization's alert with their email:
// another page could lock them out of exports for an hour and make them look
// like they were pulling data. A navigation that turns into a download leaves
// the other page where it was, so it can repeat. Refused here, where the
// budget is spent, before any of that.
// ─────────────────────────────────────────────────────────────────────────
describe("an export another origin's page asked for", () => {
  it.each([
    [
      'a link or script navigation on another site',
      {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    ],
    [
      'an image on a sibling subdomain',
      { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
    ],
    [
      'a script tag on a sibling subdomain',
      { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' },
    ],
    ['an unknown Sec-Fetch-Site value (fail closed)', { 'sec-fetch-site': 'cross-origin' }],
  ])('%s: 403, the budget untouched, no audit row and no alert', async (_name, headers) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await exportRateLimited(req(headers), 'user-1', 'org-1');
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ error: 'cross_site_request' });
    expect(res!.headers.get('cache-control')).toBe('no-store');
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(insertAuditRowReported).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each([
    [
      "the app's own page (a download link, window.open, fetch)",
      { 'sec-fetch-site': 'same-origin' },
    ],
    ['the person typed the address or used a bookmark', { 'sec-fetch-site': 'none' }],
    ['no Fetch Metadata (the phone, a server-side fetch, an older browser)', {}],
    [
      'a Bearer caller from anywhere (the phone)',
      { authorization: 'Bearer phone-access-token', 'sec-fetch-site': 'cross-site' },
    ],
  ])('%s: the budget decides, as before', async (_name, headers) => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 1000,
    });
    await expect(exportRateLimited(req(headers), 'user-1', 'org-1')).resolves.toBeNull();
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it('a refusal is logged with the path and the Fetch Metadata only, never the query string', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await exportRateLimited(
      req({
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'image',
        cookie: 'sb-x-auth-token=live-session',
      }),
      'user-1',
      'org-1',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toEqual({
      path: '/api/inventory/export.csv',
      secFetchSite: 'same-site',
      secFetchMode: 'no-cors',
      secFetchDest: 'image',
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('secret-filter');
    expect(logged).not.toContain('live-session');
    expect(logged).not.toContain('user-1');
    warn.mockRestore();
  });
});

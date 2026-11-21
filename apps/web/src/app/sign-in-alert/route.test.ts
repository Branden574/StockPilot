// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NextRequest } from 'next/server';

/**
 * Part 3 (sign-in alerts): the page the "This was not me" button of an alert
 * email opens, outside the login wall.
 *   - GET shows what the alert was and one button, and changes NOTHING (mail
 *     scanners open links): no report, no limiter, no write.
 *   - POST (the page's own form) refuses a post from another site first, is
 *     limited by address and then by alert, and runs the report.
 *   - Every link that does not check out (malformed, past its 7 days, a
 *     changed tag, a tag for another account, an alert that does not exist)
 *     gets ONE plain page, the same bytes each time, so the page never tells
 *     a real alert id from a made-up one.
 *
 * The signing value is a dull one under a neutral name
 * (src/test/secret-shaped-fixtures.guard.test.ts); every id and address is
 * made up. The report itself is tested in
 * server/services/sign-in-alert-report.test.ts; here it is a mock.
 */

const h = vi.hoisted(() => ({
  read: vi.fn(),
  report: vi.fn(),
  limit: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  env: {
    SUPABASE_SERVICE_ROLE_KEY: 'test-only-signing-input',
    NEXT_PUBLIC_APP_URL: 'https://app.example.test',
  },
}));
vi.mock('@/server/services/sign-in-alert-report', () => ({
  readSignInAlert: (id: string) => h.read(id),
  reportSignInAlertNotMe: (a: unknown) => h.report(a),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...a: unknown[]) => h.limit(...a),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import { signInAlertLinkUrl } from '@/lib/auth/sign-in-alert-url';

import { GET, POST } from './route';

const BASE = 'https://app.example.test';
const MEMBER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const ALERT = 'a1e27000-0000-4000-8000-000000000001';

function alert(extra: Record<string, unknown> = {}) {
  return {
    id: ALERT,
    userId: MEMBER,
    sessionId: null,
    newDevice: true,
    newCountry: true,
    client: 'web',
    deviceLabel: 'Firefox on Windows',
    deviceFamily: 'Firefox on Windows',
    deviceHash: 'ab'.repeat(20),
    country: 'MX',
    city: 'Tijuana',
    status: 'open',
    createdAt: '2026-11-20T15:30:00.000Z',
    ...extra,
  };
}

/** The link's query as the email writes it, for `userId`, issued at `now`. */
function linkQuery(userId = MEMBER, now = new Date()): URLSearchParams {
  const url = signInAlertLinkUrl({ alertId: ALERT, userId, now })!;
  return new URL(url).searchParams;
}

function get(query: URLSearchParams | string): NextRequest {
  return new NextRequest(`${BASE}/sign-in-alert?${query.toString()}`);
}

function post(query: URLSearchParams, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${BASE}/sign-in-alert`, {
    method: 'POST',
    body: query.toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-for': '203.0.113.9',
      'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605.1.15',
      ...headers,
    },
  });
}

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VERCEL', '1');
  h.read.mockResolvedValue({ kind: 'found', alert: alert() });
  h.report.mockResolvedValue({ outcome: 'done', firstReport: true });
  h.limit.mockResolvedValue({ allowed: true, remaining: 1, resetAt: Date.now() + 60_000 });
});

async function badPageOf(res: Response): Promise<string> {
  expect(res.status).toBe(400);
  const html = await res.text();
  expect(html).toContain('This link has expired');
  expect(html).toContain('Open Settings &gt; Security to review your sessions.');
  return html;
}

describe('GET /sign-in-alert', () => {
  it('a valid link shows the alert and the button, and changes nothing', async () => {
    const q = linkQuery();
    const res = await GET(get(q));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await res.text();
    expect(html).toContain('Firefox on Windows');
    expect(html).toContain('Tijuana, Mexico (approximate)');
    expect(html).toContain('Nov 20, 2026');
    expect(html).toContain('New device and new country');
    expect(html).toContain('This was not me: sign me out everywhere');
    expect(html).toContain('<form method="post" action="/sign-in-alert">');
    expect(html).toContain(`name="a" value="${ALERT}"`);
    expect(html).toContain(`name="t" value="${q.get('t')}"`);
    expect(h.read).toHaveBeenCalledWith(ALERT);
    expect(h.report).not.toHaveBeenCalled();
    expect(h.limit).not.toHaveBeenCalled();
  });

  it('an alert already reported shows that it was, with the reset button and no form', async () => {
    h.read.mockResolvedValue({ kind: 'found', alert: alert({ status: 'not_me' }) });
    const res = await GET(get(linkQuery()));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('You already reported this sign-in');
    expect(html).toContain('href="/reset"');
    expect(html).not.toContain('<form');
    expect(h.report).not.toHaveBeenCalled();
  });

  it('every bad link gets the same page: malformed, expired, changed tag, another account, no such alert', async () => {
    const pages: string[] = [];
    // Malformed: no read at all.
    pages.push(await badPageOf(await GET(get('a=nope&i=2026&t=x'))));
    pages.push(await badPageOf(await GET(get(''))));
    expect(h.read).not.toHaveBeenCalled();
    // Past its seven days: turned away before the read.
    pages.push(await badPageOf(await GET(get(linkQuery(MEMBER, new Date(Date.now() - 9 * DAY))))));
    expect(h.read).not.toHaveBeenCalled();
    // A changed tag.
    const forged = linkQuery();
    const t = forged.get('t')!;
    forged.set('t', (t[0] === 'A' ? 'B' : 'A') + t.slice(1));
    pages.push(await badPageOf(await GET(get(forged))));
    // A tag made for another account's alert of the same id.
    pages.push(await badPageOf(await GET(get(linkQuery(OTHER)))));
    // No such alert.
    h.read.mockResolvedValue({ kind: 'missing' });
    pages.push(await badPageOf(await GET(get(linkQuery()))));
    expect(new Set(pages).size).toBe(1);
    expect(h.report).not.toHaveBeenCalled();
  });

  it('an alert that could not be read: a try-again page, nothing changed', async () => {
    h.read.mockResolvedValue({ kind: 'failed' });
    const res = await GET(get(linkQuery()));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Nothing changed');
  });

  it('a link issued yesterday still opens', async () => {
    const res = await GET(get(linkQuery(MEMBER, new Date(Date.now() - DAY))));
    expect(res.status).toBe(200);
  });
});

describe('POST /sign-in-alert', () => {
  it('a valid link: limited by address then by alert, both closed, then the report; the done page', async () => {
    const res = await POST(post(linkQuery()));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('You are signed out on every device.');
    expect(html).toContain('Reset your password now.');
    expect(html).toContain('href="/reset"');
    expect(h.limit.mock.calls.map((c) => [c[0], c[3]])).toEqual([
      ['sign-in-alert:ip:203.0.113.9', 'closed'],
      [`sign-in-alert:alert:${ALERT}`, 'closed'],
    ]);
    expect(h.report).toHaveBeenCalledWith({
      alert: alert(),
      via: 'link',
      auditFrom: { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15' },
    });
  });

  it('the same link again: the same done page (the report tells nobody twice)', async () => {
    await POST(post(linkQuery()));
    h.report.mockResolvedValue({ outcome: 'done', firstReport: false });
    const again = await POST(post(linkQuery()));
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('You are signed out on every device.');
    expect(h.report).toHaveBeenCalledTimes(2);
  });

  it('a report that could not finish: a try-again page, and the same link works again', async () => {
    h.report.mockResolvedValue({ outcome: 'failed' });
    const res = await POST(post(linkQuery()));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('open the link from your email again');
  });

  it('a post from another site is refused before anything is read or counted', async () => {
    const res = await POST(post(linkQuery(), { 'sec-fetch-site': 'cross-site' }));
    expect(res.status).toBe(403);
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.report).not.toHaveBeenCalled();
  });

  it('too many from one address: 429 before the alert is read', async () => {
    h.limit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 120_000 });
    const res = await POST(post(linkQuery()));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.report).not.toHaveBeenCalled();
  });

  it('too many for one alert: 429 and no report', async () => {
    h.limit
      .mockResolvedValueOnce({ allowed: true, remaining: 5, resetAt: Date.now() + 60_000 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 });
    const res = await POST(post(linkQuery()));
    expect(res.status).toBe(429);
    expect(h.report).not.toHaveBeenCalled();
  });

  it('every bad link gets the same page and no report: expired, changed tag, another account, no such alert', async () => {
    const pages: string[] = [];
    pages.push(await badPageOf(await POST(post(linkQuery(MEMBER, new Date(Date.now() - 9 * DAY))))));
    const forged = linkQuery();
    const t = forged.get('t')!;
    forged.set('t', (t[0] === 'A' ? 'B' : 'A') + t.slice(1));
    pages.push(await badPageOf(await POST(post(forged))));
    pages.push(await badPageOf(await POST(post(linkQuery(OTHER)))));
    h.read.mockResolvedValue({ kind: 'missing' });
    pages.push(await badPageOf(await POST(post(linkQuery()))));
    expect(new Set(pages).size).toBe(1);
    expect(h.report).not.toHaveBeenCalled();
    // A bad link never gets a per-alert bucket.
    expect(h.limit.mock.calls.every((c) => String(c[0]).startsWith('sign-in-alert:ip:'))).toBe(true);
  });

  it('an address that cannot be resolved skips its bucket; the alert bucket still applies', async () => {
    const q = linkQuery();
    const req = new NextRequest(`${BASE}/sign-in-alert`, {
      method: 'POST',
      body: q.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    });
    await POST(req);
    expect(h.limit.mock.calls.map((c) => c[0])).toEqual([`sign-in-alert:alert:${ALERT}`]);
  });
});

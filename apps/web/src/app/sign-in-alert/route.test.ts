// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NextRequest } from 'next/server';

/**
 * Part 3 (sign-in alerts): the page the "This was not me" button of an alert
 * email opens, outside the login wall.
 *   - GET shows what the alert was and one button, and changes NOTHING about
 *     the alert or the account (mail scanners open links): no report, no
 *     write. It is counted per address before the alert is read (review 1,
 *     finding 9), so a well-shaped link cannot be used to make reads without
 *     end. Over the count it answers "Too many tries", never "this link has
 *     expired": anyone behind the same address can spend the count, and the
 *     member's real link has not expired (review 2, finding 1).
 *   - POST (the page's own form) refuses a post from another site first, is
 *     limited by address and then by alert, and runs the report.
 *   - ONE ALERT, ONE SIGN-OUT: an alert already reported gets the plain
 *     "already reported" page on GET and on POST, with no button and no
 *     form, and no session is ended again; the page says how to end them
 *     again (the password reset does). The POST limiters stay in front.
 *   - Every link that does not check out (malformed, past its 7 days, a
 *     changed tag, a tag for another account, an alert that does not exist)
 *     gets ONE plain page, the same bytes each time, so the page never tells
 *     a real alert id from a made-up one.
 *   - A limiter that cannot count is "try again in a moment", never "too many
 *     tries" with an hour's wait.
 *   - The words promise what happens and no more (finding 1), and say the
 *     owners and admins were told only when one was (finding 8).
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
const ADDRESS = { 'x-forwarded-for': '203.0.113.9' };
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

function get(query: URLSearchParams | string, headers: Record<string, string> = ADDRESS): NextRequest {
  return new NextRequest(`${BASE}/sign-in-alert?${query.toString()}`, { headers });
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
const HOUR = 60 * 60 * 1000;
const VIEW_KEY = 'sign-in-alert:view:203.0.113.9';
const SESSIONS_ENDED = 'Every session of your account has been ended.';
const ENDED_THEN = 'Every session of your account was ended when you reported it.';
const END_AGAIN =
  'To end them again now, reset your password. Completing the reset ends every session of your account, and it is what closes the door.';
const OPEN_DEVICE = 'A device that is already open can keep working for a short while (until its current pass expires).';
/** What a limiter that could not count answers in closed mode (lib/rate-limit.ts). */
const COULD_NOT_COUNT = { allowed: false, count: 60, resetAt: Date.now() + HOUR, failed: true as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VERCEL', '1');
  h.read.mockResolvedValue({ kind: 'found', alert: alert() });
  h.report.mockResolvedValue({ outcome: 'done', adminsTold: false });
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
    expect(html).toContain('This was not me: end every session');
    expect(html).toContain('<form method="post" action="/sign-in-alert">');
    expect(html).toContain(`name="a" value="${ALERT}"`);
    expect(html).toContain(`name="t" value="${q.get('t')}"`);
    expect(h.read).toHaveBeenCalledWith(ALERT);
    expect(h.report).not.toHaveBeenCalled();
  });

  it('says what the button does and no more: no "signed out everywhere", and nothing about who is told', async () => {
    const html = await (await GET(get(linkQuery()))).text();
    expect(html).toContain('It ends every session of your account.');
    expect(html).toContain(OPEN_DEVICE);
    expect(html).toContain('Then reset your password. That is what closes the door.');
    expect(html).not.toMatch(/signs you out|sign me out|every device|everywhere|right away/i);
    // Whether anyone is told is not known before the press (finding 8).
    expect(html).not.toMatch(/owners and admins/);
  });

  it('is counted per address, 60 an hour, BEFORE the alert is read', async () => {
    await GET(get(linkQuery()));
    expect(h.limit.mock.calls).toEqual([[VIEW_KEY, 60, HOUR, 'closed']]);
    expect(h.limit.mock.invocationCallOrder[0]!).toBeLessThan(h.read.mock.invocationCallOrder[0]!);
  });

  it('over the count: "Too many tries" with a 429, never "this link has expired", and the alert is not read', async () => {
    h.limit.mockResolvedValue({ allowed: false, count: 60, resetAt: Date.now() + 120_000 });
    const res = await GET(get(linkQuery()));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const html = await res.text();
    expect(html).toContain('Too many tries');
    // The other way in, which this count does not hold.
    expect(html).toContain('href="/dashboard/settings/security"');
    // The count is spent by anyone behind the same address: the link is not said to be bad.
    expect(html).not.toContain('This link has expired');
    expect(h.read).not.toHaveBeenCalled();
  });

  it('over the count the page is the same for a real link and a made-up one: it says nothing about the link', async () => {
    h.limit.mockResolvedValue({ allowed: false, count: 60, resetAt: Date.now() + 120_000 });
    const real = await (await GET(get(linkQuery()))).text();
    const madeUp = linkQuery(OTHER);
    madeUp.set('a', 'a1e27000-0000-4000-8000-00000000ffff');
    const other = await (await GET(get(madeUp))).text();
    expect(other).toBe(real);
    expect(h.read).not.toHaveBeenCalled();
  });

  it('a limiter that cannot count: "try again in a moment", not "too many tries", no hour to wait, and no read', async () => {
    h.limit.mockResolvedValue(COULD_NOT_COUNT);
    const res = await GET(get(linkQuery()));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeNull();
    const html = await res.text();
    expect(html).toContain('Please try again in a moment');
    expect(html).not.toContain('Too many tries');
    expect(h.read).not.toHaveBeenCalled();
  });

  it('a link out of shape or past its days is turned away before anything is counted', async () => {
    await GET(get('a=nope&i=2026&t=x'));
    await GET(get(linkQuery(MEMBER, new Date(Date.now() - 9 * DAY))));
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('an address that cannot be resolved skips the count; the page still opens', async () => {
    const res = await GET(get(linkQuery(), {}));
    expect(res.status).toBe(200);
    expect(h.limit).not.toHaveBeenCalled();
  });

  it('an alert already reported shows that it was, with the reset button, and NO form: the link ends no session again', async () => {
    h.read.mockResolvedValue({ kind: 'found', alert: alert({ status: 'not_me' }) });
    const res = await GET(get(linkQuery()));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('You already reported this sign-in');
    expect(html).toContain(ENDED_THEN);
    expect(html).toContain(END_AGAIN);
    expect(html).toContain('href="/reset"');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/signed out|every device|everywhere|right away|ended again/i);
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

  it('markup in the device words or the city is shown as text, never as markup', async () => {
    // The table's checks refuse these; the page escapes them all the same.
    h.read.mockResolvedValue({
      kind: 'found',
      alert: alert({ deviceLabel: '<img src=x onerror=alert(1)>"\'', city: '<script>x</script>&' }),
    });
    const html = await (await GET(get(linkQuery()))).text();
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;&amp;, Mexico (approximate)');
  });
});

describe('POST /sign-in-alert', () => {
  it('a valid link: limited by address then by alert, both closed, then the report; the done page', async () => {
    const res = await POST(post(linkQuery()));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(SESSIONS_ENDED);
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

  it('the done page promises what happens and no more: an open device keeps its pass for a short while, the reset closes the door (finding 1)', async () => {
    const html = await (await POST(post(linkQuery()))).text();
    expect(html).toContain(SESSIONS_ENDED);
    expect(html).toContain(OPEN_DEVICE);
    expect(html).toContain('That is what closes the door: until you do, anyone who knows it can sign in again.');
    expect(html).not.toMatch(/signed out|every device|everywhere|right away/i);
  });

  it('the done page says the owners and admins were told only when one was (finding 8)', async () => {
    const alone = await (await POST(post(linkQuery()))).text();
    expect(alone).not.toMatch(/owners and admins/);
    h.report.mockResolvedValue({ outcome: 'done', adminsTold: true });
    const told = await (await POST(post(linkQuery()))).text();
    expect(told).toContain('The owners and admins of your organization were told, so they can help.');
  });

  it('a press on an alert already reported: behind both limiters, the same plain page as GET, with no form, and nothing is said to have ended again', async () => {
    const reported = alert({ status: 'not_me' });
    h.read.mockResolvedValue({ kind: 'found', alert: reported });
    h.report.mockResolvedValue({ outcome: 'already_reported' });
    const viewed = await (await GET(get(linkQuery()))).text();
    h.limit.mockClear();

    const res = await POST(post(linkQuery()));
    expect(res.status).toBe(200);
    expect(h.limit.mock.calls.map((c) => [c[0], c[1], c[3]])).toEqual([
      ['sign-in-alert:ip:203.0.113.9', 30, 'closed'],
      [`sign-in-alert:alert:${ALERT}`, 10, 'closed'],
    ]);
    const html = await res.text();
    expect(html).toBe(viewed);
    expect(html).toContain('You already reported this sign-in');
    expect(html).not.toContain('<form');
    expect(html).not.toContain(SESSIONS_ENDED);
    // The report decides: for a reported alert it ends nothing
    // (server/services/sign-in-alert-report.test.ts).
    expect(h.report).toHaveBeenCalledWith(expect.objectContaining({ alert: reported, via: 'link' }));
  });

  it('the limiters still bound repeat presses on a reported alert: over either count, a 429 and no report', async () => {
    h.read.mockResolvedValue({ kind: 'found', alert: alert({ status: 'not_me' }) });
    h.report.mockResolvedValue({ outcome: 'already_reported' });
    // Over the alert's own count.
    h.limit
      .mockResolvedValueOnce({ allowed: true, remaining: 5, resetAt: Date.now() + 60_000 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 });
    const byAlert = await POST(post(linkQuery()));
    expect(byAlert.status).toBe(429);
    expect(byAlert.headers.get('retry-after')).toBeTruthy();
    expect(h.limit.mock.calls.map((c) => c[0])).toEqual([
      'sign-in-alert:ip:203.0.113.9',
      `sign-in-alert:alert:${ALERT}`,
    ]);
    // Over the address's count.
    h.limit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 });
    const byAddress = await POST(post(linkQuery()));
    expect(byAddress.status).toBe(429);
    expect(h.report).not.toHaveBeenCalled();
  });

  it('two presses at once: the one the report calls already reported gets that page too', async () => {
    h.report.mockResolvedValue({ outcome: 'already_reported' });
    const res = await POST(post(linkQuery()));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('You already reported this sign-in');
    expect(html).not.toContain('<form');
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

  it('too many from one address: 429 before the alert is read, and the page names the other way in', async () => {
    h.limit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 120_000 });
    const res = await POST(post(linkQuery()));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    const html = await res.text();
    expect(html).toContain('Too many tries');
    expect(html).toContain('href="/dashboard/settings/security"');
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

  it('the address count cannot be read: "try again in a moment" at once, no hour to wait, and NO service-role read', async () => {
    h.limit.mockResolvedValueOnce(COULD_NOT_COUNT);
    // Even for an alert that is already reported: the path a limiter failure
    // takes stays cheap, and looks at nothing.
    h.read.mockResolvedValue({ kind: 'found', alert: alert({ status: 'not_me' }) });
    const res = await POST(post(linkQuery()));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeNull();
    const html = await res.text();
    expect(html).toContain('Please try again in a moment');
    expect(html).not.toContain('Too many tries');
    expect(html).not.toContain('You already reported this sign-in');
    expect(h.read).not.toHaveBeenCalled();
    expect(h.report).not.toHaveBeenCalled();
    expect(h.limit).toHaveBeenCalledTimes(1);
  });

  it('the alert count cannot be read: "try again in a moment" at once, no report, and the alert is not read again', async () => {
    h.limit
      .mockResolvedValueOnce({ allowed: true, remaining: 5, resetAt: Date.now() + 60_000 })
      .mockResolvedValueOnce(COULD_NOT_COUNT);
    const res = await POST(post(linkQuery()));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await res.text()).toContain('Please try again in a moment');
    expect(h.report).not.toHaveBeenCalled();
    // The one read is the link's own check, made before this count was asked.
    expect(h.read).toHaveBeenCalledTimes(1);
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

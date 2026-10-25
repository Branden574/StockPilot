import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

/**
 * /unsubscribe for MEMBER emails (B15): the weekly digest and the schedule
 * reminders carry `/unsubscribe?m=<signed link>`. Pins:
 *   - GET shows a confirm page and changes nothing: it never touches the
 *     database, so a mail scanner that opens every link unsubscribes no one;
 *   - POST changes the setting, from the confirm form or from a mail
 *     provider's RFC 8058 one-click POST (the link in the query), and a
 *     second POST lands on the same page;
 *   - a changed link, another member's id, an unknown email kind, a removed
 *     member and a link signed with no signing value all change nothing, and
 *     every one of them gets the same page, so a link says nothing about the
 *     account behind it;
 *   - POST is rate limited, per link and per address, and a failed write is a
 *     500 so a provider retries;
 *   - a link works for 90 days after the UTC day its email was built; after
 *     that GET and POST show a "too old" page that points to the settings
 *     page and reads and writes nothing, and a day that is missing,
 *     malformed or after today gets the forged-link page (integrator
 *     decision 1);
 *   - the confirm and done pages say which email stops, that it stops for
 *     every workspace (it is an account setting), whose account it is, and
 *     where to turn it back on (integrator decision 2).
 */

// vi.hoisted: the factory runs during hoisted imports, before top-level consts.
// The signing value is typed once, a dull value under a neutral name (see
// src/test/secret-shaped-fixtures.guard.test.ts), and restored from a copy.
const envState = vi.hoisted(() => {
  const MEMBERS_ROUTE_VALUE = 'members-route-' + 'v'.repeat(20);
  return { UNSUBSCRIBE_SECRET: MEMBERS_ROUTE_VALUE };
});
vi.mock('@/lib/env', () => ({ env: envState }));
const INITIAL_ENV = { ...envState };

const adminHolder = { client: null as unknown };
const createAdminClientMock = vi.fn(() => adminHolder.client);
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => createAdminClientMock(),
}));

const rateLimitAnswer = vi.hoisted(() => ({ allowed: true }));
const checkRateLimitMock = vi.hoisted(() =>
  vi.fn(async (_key: string, limit: number, windowMs: number, _mode?: string) => ({
    allowed: rateLimitAnswer.allowed,
    count: rateLimitAnswer.allowed ? 1 : limit,
    resetAt: Date.now() + windowMs,
  })),
);
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: checkRateLimitMock }));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

import { GET, POST } from './route';
import { mintMemberUnsubscribeToken, type MemberEmailKind } from '@/lib/email/member-unsubscribe';
import { mintUnsubscribeToken } from '@/lib/email/unsubscribe';

const MEMBER = '00000000-0000-4000-8000-0000000000a1';
const OTHER_MEMBER = '00000000-0000-4000-8000-0000000000b2';
const ORG = '00000000-0000-4000-8000-00000000c0c0';

/** The clock, frozen for every test here: noon UTC on Oct 25, 2026. */
const NOW = new Date('2026-10-25T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
/** `days` whole days before NOW. */
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

const linkFor = (kind: MemberEmailKind, builtAt: Date = NOW) =>
  mintMemberUnsubscribeToken({ userId: MEMBER, organizationId: ORG, kind }, builtAt)!;
const digestLink = (builtAt: Date = NOW) => linkFor('weekly_digest', builtAt);
const remindersLink = (builtAt: Date = NOW) => linkFor('schedule_reminders', builtAt);

/** A link for any day string, signed with the real signing value. */
function signedFor(kind: string, day: string): string {
  const mac = createHmac('sha256', envState.UNSUBSCRIBE_SECRET)
    .update(`unsubscribe:member:v2:${kind}:${MEMBER}:${ORG}:${day}`)
    .digest('hex');
  return `${kind}.${MEMBER}.${ORG}.${day}.${mac}`;
}

const KINDS: MemberEmailKind[] = ['weekly_digest', 'schedule_reminders'];

/** The link with one of its five parts replaced. */
function withPart(link: string, index: number, value: string): string {
  const parts = link.split('.');
  parts[index] = value;
  return parts.join('.');
}

type Req = Parameters<typeof POST>[0];

function getReq(query: Record<string, string>): Req {
  return new Request(
    `https://test.local/unsubscribe?${new URLSearchParams(query).toString()}`,
  ) as unknown as Req;
}

/** RFC 8058: the provider POSTs `List-Unsubscribe=One-Click` to the link verbatim. */
function oneClickPost(link: string, headers: Record<string, string> = {}): Req {
  return new Request(`https://test.local/unsubscribe?m=${link}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: 'List-Unsubscribe=One-Click',
  }) as unknown as Req;
}

/** The confirm page's form: the link in the body. */
function formPost(link: string): Req {
  return new Request('https://test.local/unsubscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ m: link }).toString(),
  }) as unknown as Req;
}

/** A database where MEMBER is an accepted member of ORG with the digest on. */
function wireAdmin(overrides: Parameters<typeof makeSupabaseStub>[0] = {}): SupabaseStub {
  const stub = makeSupabaseStub({
    'organization_members.select': { data: [{ user_id: MEMBER }], error: null },
    'user_profiles.select': { data: [{ email_digest_optin: true }], error: null },
    'notification_preferences.select': {
      data: [{ email_schedule_reminders: true }],
      error: null,
    },
    ...overrides,
  });
  adminHolder.client = stub.client;
  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(envState, INITIAL_ENV);
  rateLimitAnswer.allowed = true;
  adminHolder.client = null;
  // Only Date: the route awaits real promises.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /unsubscribe?m= shows a confirm page and changes nothing', () => {
  it('the digest link: a confirm page with a form that posts the link, and no database or limiter call', async () => {
    const link = digestLink();
    const res = await GET(getReq({ m: link }));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(html).toContain('Unsubscribe from the weekly digest?');
    expect(html).toContain('<form method="post" action="/unsubscribe">');
    expect(html).toContain(`<input type="hidden" name="m" value="${link}">`);
    expect(html).not.toMatch(/<script\b/i);
    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it('the schedule reminders link says the app and phone reminders do not change', async () => {
    const res = await GET(getReq({ m: remindersLink() }));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Unsubscribe from schedule reminder emails?');
    expect(html).toContain('Reminders in the app and on the phone don&#39;t change.');
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it('a changed link or an unknown kind shows the invalid page, still with no database call', async () => {
    const link = digestLink();
    const flipped = link.slice(0, -1) + (link.endsWith('0') ? '1' : '0');
    for (const bad of [flipped, withPart(link, 0, 'rental_reminders'), 'weekly_digest']) {
      const res = await GET(getReq({ m: bad }));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('This link isn&#39;t valid');
    }
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it('a member link wins over address parameters in the same URL', async () => {
    const res = await GET(
      getReq({
        m: digestLink(),
        e: 'member@example.test',
        t: mintUnsubscribeToken('member@example.test')!,
      }),
    );
    expect(await res.text()).toContain('Unsubscribe from the weekly digest?');
  });
});

describe('POST /unsubscribe with a member link changes the setting', () => {
  it("one-click: turns off the member's digest switch and confirms", async () => {
    const stub = wireAdmin();
    const res = await POST(oneClickPost(digestLink()));

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('You&#39;re unsubscribed');
    expect(html).toContain('weekly inventory digest');
    expect(stub.chainArgs.get('user_profiles.update')).toEqual([
      [{ email_digest_optin: false }],
      ['id', MEMBER],
    ]);
  });

  it('the confirm form: the link in the body does the same', async () => {
    const stub = wireAdmin();
    const res = await POST(formPost(remindersLink()));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Reminders in the app and on your phone still arrive.');
    expect(stub.chainArgs.get('notification_preferences.insert')).toEqual([
      [{ user_id: MEMBER, email_schedule_reminders: false }, { onConflict: 'user_id' }],
    ]);
  });

  it('a repeat POST lands on the same page and writes nothing again', async () => {
    wireAdmin();
    const first = await POST(oneClickPost(digestLink()));
    const firstHtml = await first.text();

    const stub = wireAdmin({
      'user_profiles.select': { data: [{ email_digest_optin: false }], error: null },
    });
    const second = await POST(oneClickPost(digestLink()));

    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstHtml);
    expect(stub.chainArgs.get('user_profiles.update')).toBeUndefined();
  });

  it('is rate limited per link (by its hash, never the link itself) and per address, failing closed', async () => {
    wireAdmin();
    const link = digestLink();
    await POST(oneClickPost(link, { 'x-real-ip': '203.0.113.9' }));

    const calls = checkRateLimitMock.mock.calls;
    const keys = calls.map((c) => c[0]);
    expect(keys).toContain('unsubscribe:ip:203.0.113.9');
    const linkKey = keys.find((k) => k.startsWith('unsubscribe:link:'));
    expect(linkKey).toMatch(/^unsubscribe:link:[0-9a-f]{64}$/);
    expect(linkKey).not.toContain(MEMBER);
    for (const c of calls) expect(c[3]).toBe('closed');
  });

  it('answers 429 with Retry-After and changes nothing when a limit is reached', async () => {
    const stub = wireAdmin();
    rateLimitAnswer.allowed = false;
    const res = await POST(oneClickPost(digestLink()));

    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(stub.fromCalls).toEqual([]);
  });

  it('a failed write answers 500, so a mail provider retries', async () => {
    wireAdmin({ 'user_profiles.update': { data: null, error: { message: 'boom' } } });
    const res = await POST(oneClickPost(digestLink()));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('Something went wrong');
  });
});

describe('POST /unsubscribe with a member link refuses everything else, all alike', () => {
  async function refusal(req: Req) {
    const res = await POST(req);
    return { status: res.status, html: await res.text() };
  }

  it('a changed signature, another member, an unknown kind or no signing value: 400, no database, no limiter', async () => {
    const stub = wireAdmin();
    const link = digestLink();
    const flipped = link.slice(0, -1) + (link.endsWith('0') ? '1' : '0');
    // A correctly computed signature over an unknown kind.
    const unknownKind = signedFor('rental_reminders', '20261025');

    const tampered = await refusal(oneClickPost(flipped));
    expect(tampered.status).toBe(400);
    expect(tampered.html).toContain('This link isn&#39;t valid');
    for (const req of [
      oneClickPost(withPart(link, 1, OTHER_MEMBER)),
      oneClickPost(unknownKind),
      formPost('not-a-link'),
    ]) {
      expect(await refusal(req)).toEqual(tampered);
    }
    envState.UNSUBSCRIBE_SECRET = '';
    expect(await refusal(oneClickPost(link))).toEqual(tampered);

    expect(stub.fromCalls).toEqual([]);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it('a removed member gets exactly the forged-link page, and nothing is written', async () => {
    const link = digestLink();
    const flipped = link.slice(0, -1) + (link.endsWith('0') ? '1' : '0');
    wireAdmin();
    const forged = await refusal(oneClickPost(flipped));

    const stub = wireAdmin({ 'organization_members.select': { data: [], error: null } });
    const removed = await refusal(oneClickPost(link));

    expect(removed).toEqual(forged);
    expect(stub.fromCalls).toEqual(['organization_members']);
    expect(stub.chainArgs.get('user_profiles.update')).toBeUndefined();
  });

  it('a disabled account gets exactly the forged-link page, and nothing is written', async () => {
    const link = remindersLink();
    const flipped = link.slice(0, -1) + (link.endsWith('0') ? '1' : '0');
    wireAdmin();
    const forged = await refusal(oneClickPost(flipped));

    const stub = wireAdmin({
      'user_profiles.select': {
        data: [{ email_digest_optin: true, disabled_at: '2026-10-01T00:00:00Z' }],
        error: null,
      },
    });
    const disabled = await refusal(oneClickPost(link));

    expect(disabled).toEqual(forged);
    expect(stub.chainArgs.get('notification_preferences.insert')).toBeUndefined();
  });

  it("one member's valid link only ever changes that member's switch", async () => {
    const stub = wireAdmin();
    await POST(oneClickPost(digestLink()));
    const filters = stub.chainArgsAll.get('user_profiles.update') ?? [];
    expect(filters).toHaveLength(1);
    expect(filters[0]).toContainEqual(['id', MEMBER]);
    expect(JSON.stringify(stub.chainArgsAll.get('organization_members.select'))).not.toContain(
      OTHER_MEMBER,
    );
  });
});

/** The visible words of a page: tags dropped, entities read, spaces collapsed. */
function wordsOf(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Integrator decision 2: the switch is the account's own setting, the one the
 * Notifications page shows, so the change covers every workspace the member
 * belongs to. Both pages say which email stops, that it stops for every
 * workspace, and where to turn it back on. The confirm page also says whose
 * account it is, for a reader of a forwarded email: the link works with no
 * sign-in, so whoever holds it acts for the member it was sent to.
 */
describe('what the member pages say', () => {
  const NAMES: Record<MemberEmailKind, { heading: string; email: string; done: string }> = {
    weekly_digest: {
      heading: 'Unsubscribe from the weekly digest?',
      email: 'This stops the weekly inventory digest email',
      done: 'The weekly inventory digest is off for your account now',
    },
    schedule_reminders: {
      heading: 'Unsubscribe from schedule reminder emails?',
      email: 'This stops the emails sent 24 hours and 1 hour before scheduled events',
      done: 'Schedule reminder emails are off for your account now',
    },
  };

  it.each(KINDS)(
    'the %s confirm page: the email, every workspace, whose account, and the way back',
    async (kind) => {
      const words = wordsOf(await (await GET(getReq({ m: linkFor(kind) }))).text());
      expect(words).toContain(NAMES[kind].heading);
      expect(words).toContain(NAMES[kind].email);
      expect(words).toContain('for the StockPilot account this email was sent to');
      expect(words).toContain('every workspace the account belongs to');
      expect(words).toContain('sign in and open Settings, then Notifications');
      expect(words).toContain(
        "If someone forwarded this email to you, it's their account, not yours.",
      );
      // Never "your account" before the POST: the reader may not be the member.
      expect(words).not.toMatch(/\byour (StockPilot )?account\b/);
    },
  );

  it.each(KINDS)('the %s done page: the email, every workspace, and the way back', async (kind) => {
    wireAdmin();
    const res = await POST(formPost(linkFor(kind)));
    expect(res.status).toBe(200);
    const words = wordsOf(await res.text());
    expect(words).toContain("You're unsubscribed");
    expect(words).toContain(NAMES[kind].done);
    expect(words).toContain('in every workspace you belong to');
    expect(words).toContain('sign in to StockPilot and open Settings, then Notifications');
  });

  it('the done page after a one-click POST is the same page', async () => {
    wireAdmin();
    const form = await (await POST(formPost(digestLink()))).text();
    wireAdmin();
    const oneClick = await (await POST(oneClickPost(digestLink()))).text();
    expect(oneClick).toBe(form);
  });

  it('the reminder pages say the app and phone reminders keep coming', async () => {
    const confirm = wordsOf(await (await GET(getReq({ m: remindersLink() }))).text());
    expect(confirm).toContain("Reminders in the app and on the phone don't change.");
    wireAdmin();
    const done = wordsOf(await (await POST(formPost(remindersLink()))).text());
    expect(done).toContain('Reminders in the app and on your phone still arrive.');
  });
});

/**
 * Integrator decision 1: a link carries the UTC day its email was built and
 * works for 90 days. After that it is "too old": a page that says so and
 * points to the settings page, on GET and on POST, with no database read or
 * write and no limiter call. A day that is missing, malformed, impossible or
 * after today is refused exactly like a forged link.
 */
describe('a member link older than 90 days', () => {
  async function page(res: Response) {
    return { status: res.status, html: await res.text() };
  }

  it.each(KINDS)('a %s link on day 90 still works', async (kind) => {
    const link = linkFor(kind, daysAgo(90));
    const confirm = await GET(getReq({ m: link }));
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('<form method="post" action="/unsubscribe">');

    const stub = wireAdmin();
    const done = await POST(oneClickPost(link));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('You&#39;re unsubscribed');
    expect(stub.fromCalls).toContain('organization_members');
  });

  it.each(KINDS)(
    'a %s link on day 91: GET shows the too-old page and reads nothing',
    async (kind) => {
      const res = await GET(getReq({ m: linkFor(kind, daysAgo(91)) }));
      const html = await res.text();
      expect(res.status).toBe(410);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(html).toContain('This link is too old');
      expect(wordsOf(html)).toContain('Unsubscribe links work for 90 days after the email is sent');
      expect(wordsOf(html)).toContain(
        kind === 'weekly_digest'
          ? 'To stop the weekly inventory digest, use the Unsubscribe link in a newer digest'
          : 'To stop schedule reminder emails, use the Unsubscribe link in a newer reminder',
      );
      expect(html).toContain(
        '<a href="/dashboard/settings/notifications">Open notification settings</a>',
      );
      expect(html).not.toContain('<form');
      expect(createAdminClientMock).not.toHaveBeenCalled();
      expect(checkRateLimitMock).not.toHaveBeenCalled();
    },
  );

  it.each(KINDS)('a %s link on day 91: one-click and form POSTs change nothing', async (kind) => {
    const link = linkFor(kind, daysAgo(91));
    const shown = await page(await GET(getReq({ m: link })));
    const stub = wireAdmin();

    const oneClick = await page(await POST(oneClickPost(link)));
    const form = await page(await POST(formPost(link)));

    // Non-2xx: a one-click provider must not count it done.
    expect(oneClick).toEqual(shown);
    expect(form).toEqual(shown);
    expect(oneClick.status).toBe(410);
    expect(stub.fromCalls).toEqual([]);
    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it('a link from years ago is the same too-old page', async () => {
    const old = await page(await GET(getReq({ m: digestLink(daysAgo(91)) })));
    expect(await page(await GET(getReq({ m: digestLink(daysAgo(3 * 365)) })))).toEqual(old);
  });

  it('a future, missing, malformed, impossible or edited day gets the forged-link page on GET and POST', async () => {
    const link = digestLink();
    const flipped = link.slice(0, -1) + (link.endsWith('0') ? '1' : '0');
    const forgedGet = await page(await GET(getReq({ m: flipped })));
    const forgedPost = await page(await POST(oneClickPost(flipped)));
    expect(forgedGet.status).toBe(400);
    expect(forgedGet.html).toContain('This link isn&#39;t valid');

    // The earlier four-part format, signed with the real value under v1.
    const v1Mac = createHmac('sha256', envState.UNSUBSCRIBE_SECRET)
      .update(`unsubscribe:member:v1:weekly_digest:${MEMBER}:${ORG}`)
      .digest('hex');
    const refused = [
      digestLink(new Date(NOW.getTime() + DAY_MS)), // tomorrow, correctly signed
      `weekly_digest.${MEMBER}.${ORG}.${v1Mac}`, // no day
      signedFor('weekly_digest', '2026-10-2'), // malformed, signed over
      signedFor('weekly_digest', '20260230'), // Feb 30, signed over
      withPart(digestLink(daysAgo(91)), 3, '20261025'), // expired, day moved to today
      withPart(link, 3, '20261024'), // edited day
    ];
    const stub = wireAdmin();
    for (const m of refused) {
      expect(await page(await GET(getReq({ m })))).toEqual(forgedGet);
      expect(await page(await POST(oneClickPost(m)))).toEqual(forgedPost);
    }
    expect(stub.fromCalls).toEqual([]);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });
});

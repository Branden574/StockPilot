import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

/**
 * Public unsubscribe endpoint. Pins the two load-bearing properties:
 *   - GET renders a click-through page and NEVER writes (mail scanners
 *     prefetch every emailed link — a GET-mutating unsubscribe would
 *     opt recipients out on delivery), and
 *   - POST only records the opt-out behind a valid HMAC token, accepts
 *     both the human form and the RFC 8058 one-click provider POST, and
 *     is idempotent.
 */

// vi.hoisted: the factory runs during hoisted imports, before top-level consts.
const envState = vi.hoisted(() => ({ UNSUBSCRIBE_SECRET: 'route-test-secret-0123456789abcdef' }));
vi.mock('@/lib/env', () => ({ env: envState }));

const adminHolder = { client: null as unknown };
const createAdminClientMock = vi.fn(() => adminHolder.client);
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => createAdminClientMock(),
}));

import { GET, POST } from './route';
import { mintUnsubscribeToken } from '@/lib/email/unsubscribe';

const EMAIL = 'requester@school.edu';

function wireAdmin(): SupabaseStub {
  const stub = makeSupabaseStub({
    'public_email_unsubscribes.insert': { data: null, error: null },
  });
  adminHolder.client = stub.client;
  return stub;
}

function url(e: string | null, t: string | null) {
  const qs = new URLSearchParams();
  if (e !== null) qs.set('e', e);
  if (t !== null) qs.set('t', t);
  return `https://test.local/unsubscribe?${qs.toString()}`;
}

function buildGet(e: string | null, t: string | null) {
  return new Request(url(e, t)) as unknown as Parameters<typeof GET>[0];
}

/** RFC 8058 shape: params in the query (the List-Unsubscribe URL verbatim). */
function buildOneClickPost(e: string, t: string) {
  return new Request(url(e, t), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  }) as unknown as Parameters<typeof POST>[0];
}

/** Our confirm form's shape: params in the form body. */
function buildFormPost(fields: Record<string, string>) {
  return new Request('https://test.local/unsubscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  }) as unknown as Parameters<typeof POST>[0];
}

describe('/unsubscribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.UNSUBSCRIBE_SECRET = 'route-test-secret-0123456789abcdef';
    adminHolder.client = null;
  });

  it('GET renders the confirm page without ever touching the database', async () => {
    const res = await GET(buildGet(EMAIL, mintUnsubscribeToken(EMAIL)!));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(html).toContain(EMAIL);
    expect(html).toContain('method="post"');
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it('GET with a tampered token shows the invalid page — still no DB', async () => {
    const token = mintUnsubscribeToken(EMAIL)!;
    const flipped = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');

    const res = await GET(buildGet(EMAIL, flipped));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('invalid');
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it('POST from the confirm form records the opt-out (lowercased) and confirms', async () => {
    const stub = wireAdmin();
    // Uppercased address in the link — storage must be the canonical
    // lowercase form the sender's suppression lookup uses.
    const res = await POST(
      buildFormPost({ e: 'Requester@School.EDU', t: mintUnsubscribeToken(EMAIL)! }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('unsubscribed');
    expect(stub.fromCalls).toEqual(['public_email_unsubscribes']);
    expect(stub.chainArgs.get('public_email_unsubscribes.insert')).toEqual([
      [{ email: EMAIL }, { onConflict: 'email', ignoreDuplicates: true }],
    ]);
  });

  it('POST accepts the RFC 8058 one-click provider shape (params in the query)', async () => {
    const stub = wireAdmin();

    const res = await POST(buildOneClickPost(EMAIL, mintUnsubscribeToken(EMAIL)!));

    expect(res.status).toBe(200);
    expect(stub.chainArgs.get('public_email_unsubscribes.insert')?.[0]?.[0]).toEqual({
      email: EMAIL,
    });
  });

  it('a repeat POST is idempotent — same confirmation, no error', async () => {
    wireAdmin();
    const req = () => buildOneClickPost(EMAIL, mintUnsubscribeToken(EMAIL)!);

    const first = await POST(req());
    const second = await POST(req());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('unsubscribed');
  });

  it('POST with a tampered token writes nothing and returns non-2xx', async () => {
    const stub = wireAdmin();
    const token = mintUnsubscribeToken(EMAIL)!;
    const flipped = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');

    const res = await POST(buildOneClickPost(EMAIL, flipped));

    expect(res.status).toBe(400);
    expect(stub.fromCalls).toEqual([]);
  });

  it('POST fails closed when UNSUBSCRIBE_SECRET is unset — even a previously valid link', async () => {
    const token = mintUnsubscribeToken(EMAIL)!;
    envState.UNSUBSCRIBE_SECRET = '';
    const stub = wireAdmin();

    const res = await POST(buildOneClickPost(EMAIL, token));

    expect(res.status).toBe(400);
    expect(stub.fromCalls).toEqual([]);
  });
});

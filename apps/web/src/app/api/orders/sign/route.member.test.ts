import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256Hex } from '@/lib/token-hash';
import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * Migration 0389 (slice B, order secrets expand): how POST /api/orders/sign
 * (and its /api/v1 alias) decides who may complete a hand-over.
 *
 *   link        sha256(presented) is the order's column (a printed QR, the
 *               panel's link): no session, as before.
 *   legacy_link the presented value IS the column and no side token hashes to
 *               it (minted before 0389): no session, until slice C.
 *   member      the presented value IS the column and is a DIGEST, which every
 *               member reads: only a signed-in member of the order's
 *               organization with effective orders:approve, or the order's
 *               assigned driver. Installed phones post the column with their
 *               bearer and X-Organization-Id (signature-pad-modal.tsx).
 *
 * Every refusal is the same 404 body an unknown token gets (no oracle). An
 * entitled member whose MFA is unsatisfied gets 403 (R3). The member path is
 * limited to 60 an hour per member (R4) and never counts against a per-token
 * bucket; a link counts against its token's (10 an hour, keyed by the token's
 * hash), applied once it matched as a link, so no member can use up another's
 * (desk check F3). Every digital hand-over writes order.signature_collected.
 */

vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://stockpilotusa.com' } }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const checkRateLimit = vi.fn(async (_key: string, _max: number, _win: number, _mode: string) => ({
  allowed: true,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (key: string, max: number, win: number, mode: string) => checkRateLimit(key, max, win, mode),
}));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/server/email/return-prompt', () => ({ maybeSendReturnPrompt: vi.fn(async () => undefined) }));
vi.mock('@/server/lib/order-handover-notify', () => ({
  notifyRequesterBackordered: vi.fn(async () => undefined),
  notifyRequesterBackorderShipped: vi.fn(async () => undefined),
  sendPartialReceiptEmail: vi.fn(async () => undefined),
}));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));
vi.mock('@/server/services/order-requests', () => ({ syncOrderScheduleEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
const insertAuditRowReported = vi.fn(async (_row: Record<string, unknown>) => true);
vi.mock('@/server/services/audit', () => ({
  insertAuditRowReported: (row: Record<string, unknown>) => insertAuditRowReported(row),
}));

import { withApiContext } from '@/lib/auth/api-context';

import { POST } from './route';

const RAW = '3c'.repeat(32);
const DIGEST = sha256Hex(RAW);
const LEGACY = '5e'.repeat(32);
const ORDER_ID = '0a000000-0000-4000-8000-000000000389';
const ORG = 'org-l4l';
const OTHER_ORG = 'org-other';
const DRIVER = 'driver-1';
const SIGNATURE = 'data:image/png;base64,' + 'A'.repeat(80);

interface World {
  column: string | null;
  side: string | null;
  sideError?: boolean;
  status: string;
}

function buildAdmin(w: World) {
  const order = () => ({
    id: ORDER_ID,
    organization_id: ORG,
    warehouse_id: 'wh-1',
    requester_user_id: null,
    requester_name: 'Reggie',
    requester_email: 'reggie@example.com',
    fulfillment_type: 'pickup',
    assigned_delivery_user_id: DRIVER,
    signature_token: w.column,
    status: w.status,
  });
  return makeSupabaseStub({
    'order_requests.select': servedLikePostgrest(() => [order()]),
    'order_request_secrets.select': w.sideError
      ? { data: null, error: { message: 'connection reset' } }
      : servedLikePostgrest(() =>
          w.side === null ? [] : [{ order_request_id: ORDER_ID, signature_token: w.side }],
        ),
    'order_request_lines.select': {
      data: [{ quantity_requested: 2, quantity_fulfilled: 2 }],
      error: null,
    },
    'rpc:confirm_order_signature': (call) => {
      const args = call.args[0]?.[0] as { p_signature_token: string };
      // The frozen body: the column must equal the argument.
      if (args.p_signature_token !== w.column || !['staged_for_pickup', 'in_transit'].includes(w.status)) {
        return { data: null, error: null };
      }
      w.status = 'completed';
      return { data: ORG, error: null };
    },
  });
}

let world: World;
let admin: ReturnType<typeof buildAdmin>;
beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockImplementation(async () => ({ allowed: true }));
  world = { column: DIGEST, side: RAW, status: 'staged_for_pickup' };
  admin = buildAdmin(world);
  adminHolder.client = admin.client;
  vi.mocked(withApiContext).mockResolvedValue(null);
});

function request(token: string, headers: Record<string, string> = {}) {
  return new Request('https://test.local/api/v1/orders/sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      token,
      signerName: 'Sam Signer',
      signerEmail: 'sam@example.com',
      signatureDataUrl: SIGNATURE,
    }),
  }) as never;
}

/** A signed-in member, as withApiContext would build them for the order's org. */
function member(overrides: Parameters<typeof makeServiceContext>[1]) {
  return makeServiceContext(makeSupabaseStub().client, { organizationId: ORG, ...overrides });
}

function confirmCalls() {
  return admin.rpcCalls.filter((c) => c.name === 'confirm_order_signature');
}

const NOT_FOUND_TEXT = JSON.stringify({
  ok: false,
  error: { code: 'not_found', message: 'This signature link is invalid or expired.' },
});

describe('link path: the raw token of a 0389 mint, no session', () => {
  it('hands over, passing the DIGEST to confirm_order_signature, and audits via link with no user', async () => {
    const res = await POST(request(RAW));
    expect(res.status).toBe(200);
    expect(world.status).toBe('completed');
    expect(confirmCalls()).toHaveLength(1);
    expect((confirmCalls()[0]!.args as { p_signature_token: string }).p_signature_token).toBe(DIGEST);
    // No session is ever asked for on a link.
    expect(withApiContext).not.toHaveBeenCalled();
    expect(insertAuditRowReported).toHaveBeenCalledTimes(1);
    const row = insertAuditRowReported.mock.calls[0]![0];
    expect(row).toMatchObject({
      organization_id: ORG,
      user_id: null,
      event: 'order.signature_collected',
      metadata: {
        entity_type: 'order_request',
        entity_id: ORDER_ID,
        warehouse_id: 'wh-1',
        signatureMethod: 'digital',
        via: 'link',
      },
    });
    // Never the token, raw or hashed.
    expect(JSON.stringify(row)).not.toContain(RAW);
    expect(JSON.stringify(row)).not.toContain(DIGEST);
  });
});

describe('the audit row\'s IP fits audit_logs.ip (inet)', () => {
  // Off Vercel the rate-limit helper answers "unknown", which the inet column
  // refuses (22P02): the row, and the timeline's Signature collected, was
  // lost (local E2E, 2026-10-03).
  it('no forwarding header: ip is null, never a word', async () => {
    await POST(request(RAW));
    expect(insertAuditRowReported.mock.calls[0]![0].ip).toBeNull();
  });

  it('the first x-forwarded-for hop, as every other audit row takes it', async () => {
    await POST(request(RAW, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }));
    expect(insertAuditRowReported.mock.calls[0]![0].ip).toBe('203.0.113.7');
  });

  it('x-real-ip when there is no x-forwarded-for; an IPv6 literal is kept', async () => {
    await POST(request(RAW, { 'x-real-ip': '2001:db8::5' }));
    expect(insertAuditRowReported.mock.calls[0]![0].ip).toBe('2001:db8::5');
  });

  it('anything that is not an IP literal is dropped to null', async () => {
    await POST(request(RAW, { 'x-forwarded-for': 'unknown', 'x-real-ip': 'proxy.local' }));
    expect(insertAuditRowReported.mock.calls[0]![0].ip).toBeNull();
  });
});

describe('legacy raw column (minted before 0389, until slice C)', () => {
  it('no side row: accepted as a link with no session, audited via legacy_link', async () => {
    world.column = LEGACY;
    world.side = null;
    const res = await POST(request(LEGACY));
    expect(res.status).toBe(200);
    expect((confirmCalls()[0]!.args as { p_signature_token: string }).p_signature_token).toBe(LEGACY);
    expect(withApiContext).not.toHaveBeenCalled();
    expect(insertAuditRowReported.mock.calls[0]![0]).toMatchObject({
      user_id: null,
      metadata: { via: 'legacy_link' },
    });
  });

  it('a stale side token (a pre-deploy tab re-minted raw over a 0389 mint): still the legacy link', async () => {
    world.column = LEGACY;
    world.side = RAW;
    expect((await POST(request(LEGACY))).status).toBe(200);
    expect(insertAuditRowReported.mock.calls[0]![0]).toMatchObject({ metadata: { via: 'legacy_link' } });
  });
});

describe('member path: the DIGEST (readable by every member) completes nothing without an entitled session', () => {
  it('no session: the one 404, nothing written', async () => {
    const res = await POST(request(DIGEST));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND_TEXT);
    expect(confirmCalls()).toHaveLength(0);
    expect(insertAuditRowReported).not.toHaveBeenCalled();
    expect(world.status).toBe('staged_for_pickup');
  });

  it("a viewer's bearer: the one 404", async () => {
    vi.mocked(withApiContext).mockResolvedValue(member({ role: 'viewer', userId: 'viewer-1' }) as never);
    const res = await POST(request(DIGEST, { authorization: 'Bearer viewer-token' }));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND_TEXT);
    expect(confirmCalls()).toHaveLength(0);
  });

  it('a staff member who is not the driver and holds no orders:approve: the one 404', async () => {
    vi.mocked(withApiContext).mockResolvedValue(member({ role: 'staff', userId: 'staff-1' }) as never);
    expect((await POST(request(DIGEST, { authorization: 'Bearer t' }))).status).toBe(404);
    expect(confirmCalls()).toHaveLength(0);
  });

  it("another organization's manager: withApiContext finds no membership in the order's org (null), the one 404", async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    const res = await POST(request(DIGEST, { authorization: 'Bearer t', 'x-organization-id': OTHER_ORG }));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND_TEXT);
    // The context is asked FOR THE ORDER'S organization, whatever the caller sent.
    const asked = vi.mocked(withApiContext).mock.calls[0]![0] as Request;
    expect(asked.headers.get('x-organization-id')).toBe(ORG);
    expect(asked.headers.get('authorization')).toBe('Bearer t');
  });

  it('a context for another organization is refused even if one were returned: the one 404', async () => {
    vi.mocked(withApiContext).mockResolvedValue(
      makeServiceContext(makeSupabaseStub().client, { organizationId: OTHER_ORG, role: 'owner' }) as never,
    );
    expect((await POST(request(DIGEST, { authorization: 'Bearer t' }))).status).toBe(404);
    expect(confirmCalls()).toHaveLength(0);
  });

  it('a context that cannot be built (it throws): the one 404, never a different status', async () => {
    vi.mocked(withApiContext).mockRejectedValue(new Error('account status unreadable'));
    const res = await POST(request(DIGEST, { authorization: 'Bearer t' }));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND_TEXT);
  });

  it.each([
    ['a manager', { role: 'manager' as const, userId: 'mgr-1' }],
    ['a staff member granted orders:approve', { role: 'staff' as const, userId: 'stf-1', permissions: new Set(['orders:approve']) }],
    ['the assigned driver (staff, no orders:approve)', { role: 'staff' as const, userId: DRIVER }],
  ])('%s: hands over, audited via member with their id', async (_n, who) => {
    vi.mocked(withApiContext).mockResolvedValue(member(who) as never);
    const res = await POST(request(DIGEST, { authorization: 'Bearer t', 'x-organization-id': ORG }));
    expect(res.status).toBe(200);
    expect(world.status).toBe('completed');
    expect((confirmCalls()[0]!.args as { p_signature_token: string }).p_signature_token).toBe(DIGEST);
    expect(insertAuditRowReported.mock.calls[0]![0]).toMatchObject({
      user_id: who.userId,
      event: 'order.signature_collected',
      metadata: { via: 'member', signatureMethod: 'digital' },
    });
  });

  it('a manager whose orders:approve was revoked by an override (K9c): the one 404', async () => {
    vi.mocked(withApiContext).mockResolvedValue(
      member({ role: 'manager', userId: 'mgr-2', permissions: new Set(['orders:request']) }) as never,
    );
    expect((await POST(request(DIGEST, { authorization: 'Bearer t' }))).status).toBe(404);
  });

  it('a side table that cannot be read fails closed: a column match then needs the entitled session', async () => {
    world.column = LEGACY;
    world.sideError = true;
    adminHolder.client = buildAdmin(world).client;
    expect((await POST(request(LEGACY))).status).toBe(404);
  });
});

describe('MFA on the member path (R3)', () => {
  it('an ENTITLED member whose session needs a step-up gets 403 aal2_required, and nothing is written', async () => {
    vi.mocked(withApiContext).mockResolvedValue(
      {
        ...member({ role: 'manager', userId: 'mgr-1', mfaRequired: true, mfaSatisfied: false }),
        mfaEnrolled: true,
      } as never,
    );
    const res = await POST(request(DIGEST, { authorization: 'Bearer aal1' }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; message: string };
      message: string;
      details: { reason: string };
    };
    expect(body.details.reason).toBe('aal2_required');
    expect(body.error.code).toBe('aal2_required');
    // The phone's api() shows the top-level message; the web collector shows error.message.
    expect(body.message).toBe(body.error.message);
    expect(confirmCalls()).toHaveLength(0);
    expect(insertAuditRowReported).not.toHaveBeenCalled();
  });

  it('an entitled member under a policy who has not enrolled gets 403 mfa_required', async () => {
    vi.mocked(withApiContext).mockResolvedValue(
      { ...member({ role: 'manager', userId: 'mgr-1', mfaRequired: true, mfaSatisfied: false }), mfaEnrolled: false } as never,
    );
    const res = await POST(request(DIGEST, { authorization: 'Bearer aal1' }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { details: { reason: string } }).details.reason).toBe('mfa_required');
  });

  it('a NON-entitled member whose MFA is unsatisfied gets the one 404, not the 403 (no oracle)', async () => {
    vi.mocked(withApiContext).mockResolvedValue(
      { ...member({ role: 'viewer', userId: 'v-1', mfaRequired: true, mfaSatisfied: false }), mfaEnrolled: true } as never,
    );
    const res = await POST(request(DIGEST, { authorization: 'Bearer aal1' }));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND_TEXT);
  });
});

describe('every refusal is byte-identical to an unknown token', () => {
  it('unknown token, cleared column, digest without a session, and a viewer all answer the same 404 body', async () => {
    const bodies: string[] = [];
    bodies.push(await (await POST(request('7a'.repeat(32)))).text());
    bodies.push(await (await POST(request(DIGEST))).text());
    vi.mocked(withApiContext).mockResolvedValue(member({ role: 'viewer', userId: 'v' }) as never);
    bodies.push(await (await POST(request(DIGEST, { authorization: 'Bearer v' }))).text());
    world.column = null;
    bodies.push(await (await POST(request(RAW))).text());
    expect(new Set(bodies)).toEqual(new Set([NOT_FOUND_TEXT]));
  });
});

describe('rate limits', () => {
  it('a link counts against its token, keyed by the hash of the presented token (never the token), 10 an hour, closed', async () => {
    await POST(request(RAW));
    const keys = checkRateLimit.mock.calls.map((c) => c[0]);
    expect(keys).toEqual([`order-sign:${sha256Hex(RAW)}`]);
    expect(keys.join('|')).not.toContain(RAW);
    const perToken = checkRateLimit.mock.calls.find((c) => c[0] === `order-sign:${sha256Hex(RAW)}`)!;
    expect(perToken.slice(1)).toEqual([10, 60 * 60 * 1000, 'closed']);

    checkRateLimit.mockImplementation(async () => ({ allowed: false }));
    world.status = 'staged_for_pickup';
    const res = await POST(request(RAW));
    expect(res.status).toBe(429);
    expect(confirmCalls()).toHaveLength(1); // only the first call reached it
    expect(world.status).toBe('staged_for_pickup');
  });

  it('a legacy raw column counts against its own token the same way', async () => {
    world.column = LEGACY;
    world.side = null;
    checkRateLimit.mockImplementation(async () => ({ allowed: false }));
    const res = await POST(request(LEGACY));
    expect(res.status).toBe(429);
    expect(checkRateLimit.mock.calls.map((c) => c[0])).toEqual([`order-sign:${sha256Hex(LEGACY)}`]);
    expect(confirmCalls()).toHaveLength(0);
  });

  it('an unknown token counts against no bucket and is the one 404', async () => {
    const res = await POST(request('7a'.repeat(32)));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND_TEXT);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('F3: a viewer posting the digest again and again uses up nothing an entitled phone needs', async () => {
    // A real limiter: a count per key, refused past the limit.
    const counts = new Map<string, number>();
    checkRateLimit.mockImplementation(async (key: string, max: number) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { allowed: n <= max };
    });
    vi.mocked(withApiContext).mockResolvedValue(member({ role: 'viewer', userId: 'viewer-f3' }) as never);
    for (let i = 0; i < 25; i += 1) {
      const res = await POST(request(DIGEST, { authorization: 'Bearer viewer', 'x-organization-id': ORG }));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(NOT_FOUND_TEXT);
    }
    // No per-token bucket was ever touched on the member path (neither the
    // digest's nor its hash's), and the viewer has no member bucket either.
    expect([...counts.keys()]).toEqual([]);
    // The installed phone of a manager still hands the order over.
    vi.mocked(withApiContext).mockResolvedValue(member({ role: 'manager', userId: 'mgr-f3' }) as never);
    const res = await POST(request(DIGEST, { authorization: 'Bearer manager', 'x-organization-id': ORG }));
    expect(res.status).toBe(200);
    expect(world.status).toBe('completed');
    expect([...counts.keys()]).toEqual(['order-sign:member:mgr-f3']);
  });

  it("F3: an entitled member's own limit is theirs alone: another manager is unaffected", async () => {
    const counts = new Map<string, number>();
    checkRateLimit.mockImplementation(async (key: string, max: number) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { allowed: n <= max };
    });
    counts.set('order-sign:member:mgr-a', 60);
    vi.mocked(withApiContext).mockResolvedValue(member({ role: 'manager', userId: 'mgr-a' }) as never);
    expect((await POST(request(DIGEST, { authorization: 'Bearer a' }))).status).toBe(429);
    expect(world.status).toBe('staged_for_pickup');
    vi.mocked(withApiContext).mockResolvedValue(member({ role: 'manager', userId: 'mgr-b' }) as never);
    expect((await POST(request(DIGEST, { authorization: 'Bearer b' }))).status).toBe(200);
  });

  it('the member path is limited to 60 an hour per member, counted only once the member is entitled', async () => {
    vi.mocked(withApiContext).mockResolvedValue(member({ role: 'manager', userId: 'mgr-9' }) as never);
    await POST(request(DIGEST, { authorization: 'Bearer t' }));
    const memberCall = checkRateLimit.mock.calls.find((c) => c[0] === 'order-sign:member:mgr-9');
    expect(memberCall?.slice(1)).toEqual([60, 60 * 60 * 1000, 'closed']);

    // A viewer never reaches the member bucket (their answer stays the 404).
    vi.clearAllMocks();
    vi.mocked(withApiContext).mockResolvedValue(member({ role: 'viewer', userId: 'v-9' }) as never);
    checkRateLimit.mockImplementation(async () => ({ allowed: true }));
    await POST(request(DIGEST, { authorization: 'Bearer v' }));
    expect(checkRateLimit.mock.calls.map((c) => c[0])).not.toContain('order-sign:member:v-9');

    // Over the member limit: 429 and nothing written.
    world.status = 'staged_for_pickup';
    vi.mocked(withApiContext).mockResolvedValue(member({ role: 'manager', userId: 'mgr-9' }) as never);
    checkRateLimit.mockImplementation(async (key: string) => ({ allowed: !key.startsWith('order-sign:member:') }));
    const before = confirmCalls().length;
    const res = await POST(request(DIGEST, { authorization: 'Bearer t' }));
    expect(res.status).toBe(429);
    expect(confirmCalls()).toHaveLength(before);
    expect(world.status).toBe('staged_for_pickup');
  });
});

describe('installed phones (no update): the signature pad request shape', () => {
  // signature-pad-modal.tsx posts { token: order.signatureToken (the column,
  // a digest since 0389), signerName, signerEmail, signatureDataUrl } to
  // /api/v1/orders/sign through api(), which adds Authorization: Bearer and
  // X-Organization-Id. The button shows to manager rank (order/[id].tsx).
  it('succeeds for a manager and fails (the one 404) for a viewer', async () => {
    const phone = (bearer: string) =>
      request(DIGEST, { authorization: `Bearer ${bearer}`, 'x-organization-id': ORG });
    vi.mocked(withApiContext).mockResolvedValue(member({ role: 'viewer', userId: 'v' }) as never);
    expect((await POST(phone('viewer'))).status).toBe(404);
    vi.mocked(withApiContext).mockResolvedValue(member({ role: 'manager', userId: 'm' }) as never);
    expect((await POST(phone('manager'))).status).toBe(200);
  });

  it('a scanned paper QR (the raw token, which an old bundle posts the same way) is a link', async () => {
    vi.mocked(withApiContext).mockResolvedValue(member({ role: 'viewer', userId: 'v' }) as never);
    const res = await POST(request(RAW, { authorization: 'Bearer viewer', 'x-organization-id': ORG }));
    expect(res.status).toBe(200);
    expect(withApiContext).not.toHaveBeenCalled();
  });
});

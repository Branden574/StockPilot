import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

/**
 * Security invariant: a phone sign-in is in the Audit log once per session,
 * with a hashed session reference and never the session id, and only for a
 * verified bearer token of the account the request authenticated as
 * (S5, plans/S5.md 3.4 step 10).
 *
 * THE DEFECT. The phone signs in against GoTrue directly, so a phone sign-in
 * wrote no user.signed_in row and sent no new-device email: /api/v1/auth had
 * only password-reset, and noteLoginDevice had one caller, the web sign-in.
 *
 * Why the session id never goes into the row: managers read audit_logs
 * (0272), and a live session id is what "sign out this device" acts on.
 */

const h = vi.hoisted(() => ({
  withApiContext: vi.fn(),
  readVerifiedTokenClaims: vi.fn(),
  emitAuthAudit: vi.fn(async (_p: Record<string, unknown>) => undefined),
  noteLoginDevice: vi.fn(async (_a: Record<string, unknown>) => undefined),
  reportError: vi.fn(async (..._a: unknown[]) => undefined),
  after: [] as Array<() => unknown>,
  buckets: new Map<string, number>(),
  /** lib/rate-limit's answer when its store cannot be reached. */
  storeDown: false,
  rateCalls: [] as Array<{ key: string; limit: number; windowMs: number; mode?: string }>,
}));

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: h.withApiContext }));
vi.mock('@/lib/auth/verified-claims', () => ({
  readVerifiedTokenClaims: h.readVerifiedTokenClaims,
}));
vi.mock('@/server/services/auth-audit', () => ({ emitAuthAudit: h.emitAuthAudit }));
vi.mock('@/lib/auth/login-device', () => ({ noteLoginDevice: h.noteLoginDevice }));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (cb: () => unknown) => h.after.push(cb) };
});
// The bucket table, in memory: allowed while the count stays within the limit.
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async (key: string, limit: number, windowMs: number, mode?: string) => {
    h.rateCalls.push({ key, limit, windowMs, mode });
    if (h.storeDown) {
      return mode === 'closed'
        ? { allowed: false, count: limit, resetAt: Date.now() + windowMs }
        : { allowed: true, count: 0, resetAt: Date.now() + windowMs };
    }
    const count = (h.buckets.get(key) ?? 0) + 1;
    h.buckets.set(key, count);
    return { allowed: count <= limit, count, resetAt: Date.now() + windowMs };
  }),
}));

import { POST } from './route';

const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '44444444-4444-4444-8444-444444444444';
const SESSION = '22222222-2222-4222-8222-222222222222';
const INSTALL = '0f6c2d1e-8a4b-4c5d-9e6f-7a8b9c0d1e2f';
const APP_UA = 'StockPilot/42 CFNetwork/1568.100.1 Darwin/24.0.0';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const BODY = {
  installId: INSTALL,
  device: { model: 'iPhone 15 Pro', osName: 'iOS', osVersion: '18.1', appVersion: '1.4.0' },
};

function ctx(over: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    userId: USER,
    role: 'manager',
    permissions: undefined,
    supabase: { auth: {} },
    mfaRequired: false,
    mfaSatisfied: true,
    mfaEnrolled: false,
    enabledModules: new Set<ModuleId>(),
    ...over,
  };
}

function claims(over: Record<string, unknown> = {}) {
  return {
    userId: USER,
    sessionId: SESSION,
    aal: 'aal2',
    amr: [],
    email: 'member@example.com',
    ...over,
  };
}

function req(
  body: unknown = BODY,
  headers: Record<string, string> = { authorization: 'Bearer token-1' },
) {
  return new Request('http://localhost/api/v1/auth/signed-in', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': APP_UA,
      'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.after.length = 0;
  h.buckets.clear();
  h.rateCalls.length = 0;
  h.storeDown = false;
  // Production: Vercel sets x-forwarded-for.
  vi.stubEnv('VERCEL', '1');
  h.withApiContext.mockResolvedValue(ctx());
  h.readVerifiedTokenClaims.mockResolvedValue(claims());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function runAfter() {
  for (const cb of h.after.splice(0)) await cb();
}

describe('POST /api/v1/auth/signed-in — who may write a row', () => {
  it('a cookie session (no bearer token): 401, nothing written', async () => {
    const res = await POST(req(BODY, {}));
    expect(res.status).toBe(401);
    expect(h.withApiContext).toHaveBeenCalledTimes(1);
    expect(h.emitAuthAudit).not.toHaveBeenCalled();
    expect(h.after).toHaveLength(0);
  });

  it('withApiContext answers null (no accepted membership, disabled, bad token): 401', async () => {
    h.withApiContext.mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(h.readVerifiedTokenClaims).not.toHaveBeenCalled();
    expect(h.emitAuthAudit).not.toHaveBeenCalled();
  });

  it('the token’s claims cannot be verified, or name another account: 401', async () => {
    h.readVerifiedTokenClaims.mockResolvedValueOnce(null);
    expect((await POST(req())).status).toBe(401);
    h.readVerifiedTokenClaims.mockResolvedValueOnce(
      claims({ userId: '99999999-9999-4999-8999-999999999999' }),
    );
    expect((await POST(req())).status).toBe(401);
    expect(h.emitAuthAudit).not.toHaveBeenCalled();
  });

  it('the claims are read from the bearer token itself', async () => {
    await POST(req());
    expect(h.readVerifiedTokenClaims).toHaveBeenCalledWith(expect.anything(), 'token-1');
  });

  it('a token with no session id: 200, and nothing written (nothing to count once by)', async () => {
    h.readVerifiedTokenClaims.mockResolvedValue(claims({ sessionId: null }));
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(h.emitAuthAudit).not.toHaveBeenCalled();
    expect(h.after).toHaveLength(0);
  });
});

describe('POST /api/v1/auth/signed-in — the row', () => {
  it('one user.signed_in row, client mobile, in the request’s organization, with a session reference and never the session id', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.emitAuthAudit).toHaveBeenCalledTimes(1);
    expect(h.emitAuthAudit).toHaveBeenCalledWith({
      event: 'user.signed_in',
      userId: USER,
      organizationId: ORG,
      extra: {
        client: 'mobile',
        platform: 'iOS',
        app_version: '1.4.0',
        email: 'member@example.com',
        role: 'manager',
        mfa_required: false,
        // The family only: the model stays in the person's own device list
        // and email (integrator decision, device label 2026-11-02).
        device_label: 'StockPilot app on iPhone',
        session_ref: sha256(SESSION).slice(0, 16),
      },
    });
    expect(JSON.stringify(h.emitAuthAudit.mock.calls)).not.toContain(SESSION);
  });

  it('a second note for the same session writes no row and no device note', async () => {
    await POST(req());
    const again = await POST(req());
    expect(again.status).toBe(200);
    expect(h.emitAuthAudit).toHaveBeenCalledTimes(1);
    expect(h.after).toHaveLength(1);
    // Counted once per session, by a hash of its id, for a day, closed on a
    // store failure.
    expect(h.rateCalls).toContainEqual({
      key: `auth-note:in:${sha256(SESSION)}`,
      limit: 1,
      windowMs: 86_400_000,
      mode: 'closed',
    });
  });

  it('an AAL1 token (the code not yet entered) is accepted, and the row says a code is owed', async () => {
    h.withApiContext.mockResolvedValue(
      ctx({ mfaEnrolled: true, mfaRequired: true, mfaSatisfied: false }),
    );
    h.readVerifiedTokenClaims.mockResolvedValue(claims({ aal: 'aal1' }));
    expect((await POST(req())).status).toBe(200);
    expect(h.emitAuthAudit.mock.calls[0]![0]).toMatchObject({ extra: { mfa_required: true } });
  });

  it('after the response: noteLoginDevice with this install’s id, the device’s label and its family', async () => {
    await POST(req());
    expect(h.noteLoginDevice).not.toHaveBeenCalled();
    await runAfter();
    expect(h.noteLoginDevice).toHaveBeenCalledWith({
      userId: USER,
      email: 'member@example.com',
      userAgent: APP_UA,
      ip: '203.0.113.7',
      deviceKey: INSTALL,
      deviceLabel: 'StockPilot app on iPhone 15 Pro (iOS 18.1)',
      deviceFamily: 'StockPilot app on iPhone',
    });
  });

  it('off Vercel, x-forwarded-for is not the address: x-real-ip, else none', async () => {
    vi.stubEnv('VERCEL', '');
    await POST(req());
    await runAfter();
    expect(h.noteLoginDevice.mock.calls[0]![0]).toMatchObject({ ip: null });

    vi.clearAllMocks();
    h.buckets.clear();
    h.withApiContext.mockResolvedValue(ctx());
    h.readVerifiedTokenClaims.mockResolvedValue(claims({ sessionId: 'session-real-ip' }));
    await POST(req(BODY, { authorization: 'Bearer token-1', 'x-real-ip': '198.51.100.2' }));
    await runAfter();
    expect(h.noteLoginDevice.mock.calls[0]![0]).toMatchObject({ ip: '198.51.100.2' });
  });

  it('the per-account limit: 30 an hour, then 429 and nothing written', async () => {
    for (let i = 0; i < 30; i += 1) {
      h.readVerifiedTokenClaims.mockResolvedValueOnce(claims({ sessionId: `session-${i}` }));
      expect((await POST(req())).status).toBe(200);
    }
    h.readVerifiedTokenClaims.mockResolvedValueOnce(claims({ sessionId: 'session-31' }));
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('rate_limited');
    expect(h.emitAuthAudit).toHaveBeenCalledTimes(30);
    expect(h.rateCalls).toContainEqual({
      key: `auth-note:user:${USER}`,
      limit: 30,
      windowMs: 3_600_000,
      mode: 'closed',
    });
  });

  it('a limiter that cannot answer: 429, no row and no device note', async () => {
    h.storeDown = true;
    const res = await POST(req());
    expect(res.status).toBe(429);
    await runAfter();
    expect(h.emitAuthAudit).not.toHaveBeenCalled();
    expect(h.noteLoginDevice).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/auth/signed-in — the body', () => {
  it('a body that cannot be read: 400 with the fixed sentence', async () => {
    const res = await POST(req('{not json'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_body',
      message: 'The request could not be read.',
    });
    expect(h.emitAuthAudit).not.toHaveBeenCalled();
  });

  it('a field outside the allowlist is dropped, not trusted: no model in the row, no install id; the row is still written', async () => {
    await POST(
      req({
        installId: 'not-a-uuid',
        device: {
          model: '<img src=x onerror=alert(1)>',
          osName: 'iOS',
          osVersion: '18.1',
          appVersion: '1.4.0',
        },
      }),
    );
    expect(h.emitAuthAudit.mock.calls[0]![0]).toMatchObject({
      extra: { device_label: 'StockPilot app' },
    });
    await runAfter();
    expect(h.noteLoginDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceKey: null,
        deviceLabel: 'StockPilot app',
        deviceFamily: 'StockPilot app',
      }),
    );
  });

  it('no model that passes: the device note calls it "StockPilot app", never by the request’s own User-Agent', async () => {
    // The User-Agent goes to the note for the device hash only.
    const agent = 'Placeholder-Agent/1.0 (ua-marker)';
    for (const device of [{}, { model: '<model-marker>' }, { osName: 'iOS', osVersion: '18.1' }]) {
      h.noteLoginDevice.mockClear();
      h.readVerifiedTokenClaims.mockResolvedValueOnce(claims({ sessionId: crypto.randomUUID() }));
      await POST(
        req(
          { installId: INSTALL, device },
          { authorization: 'Bearer token-1', 'user-agent': agent },
        ),
      );
      await runAfter();
      expect(h.noteLoginDevice).toHaveBeenCalledTimes(1);
      expect(h.noteLoginDevice.mock.calls[0]![0]).toMatchObject({
        userAgent: agent,
        deviceKey: INSTALL,
        deviceLabel: 'StockPilot app',
        deviceFamily: 'StockPilot app',
      });
    }
  });

  it('length caps: a model of 48 characters is kept, one of 49 is dropped', async () => {
    await POST(req({ installId: INSTALL, device: { ...BODY.device, model: 'x'.repeat(48) } }));
    h.readVerifiedTokenClaims.mockResolvedValueOnce(claims({ sessionId: crypto.randomUUID() }));
    await POST(req({ installId: INSTALL, device: { ...BODY.device, model: 'x'.repeat(49) } }));
    await runAfter();
    expect(h.noteLoginDevice.mock.calls.map((c) => c[0].deviceLabel)).toEqual([
      `StockPilot app on ${'x'.repeat(48)} (iOS 18.1)`,
      'StockPilot app',
    ]);
  });

  it('a model with no system named: the label names the model alone', async () => {
    await POST(req({ installId: INSTALL, device: { model: 'iPad Air (5th generation)' } }));
    expect(h.emitAuthAudit.mock.calls[0]![0]).toMatchObject({
      extra: {
        device_label: 'StockPilot app on iPad',
        platform: null,
        app_version: null,
      },
    });
    await runAfter();
    expect(h.noteLoginDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceLabel: 'StockPilot app on iPad Air (5th generation)',
        deviceFamily: 'StockPilot app on iPad',
      }),
    );
  });

  it('a body that is not an object: 400 validation_error, nothing written', async () => {
    const res = await POST(req('[1,2]'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
    expect(h.emitAuthAudit).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/auth/signed-in — the device’s name: the model in the person’s own device list and email, the family everywhere else', () => {
  // Integrator decision (device label, 2026-11-02): the model is letters,
  // digits, spaces, parentheses, '+' and '-', at most 48; the system is one
  // of iOS, iPadOS and Android; its version is digits and dots. The Audit log
  // row and the organization's activity name only the family.
  async function note(device: Record<string, unknown>) {
    h.readVerifiedTokenClaims.mockResolvedValueOnce(claims({ sessionId: crypto.randomUUID() }));
    h.emitAuthAudit.mockClear();
    h.noteLoginDevice.mockClear();
    expect((await POST(req({ installId: INSTALL, device }))).status).toBe(200);
    await runAfter();
    const row = h.emitAuthAudit.mock.calls[0]![0] as { extra: Record<string, unknown> };
    const sent = h.noteLoginDevice.mock.calls[0]![0] as Record<string, unknown>;
    return {
      auditLabel: row.extra.device_label,
      platform: row.extra.platform,
      label: sent.deviceLabel,
      family: sent.deviceFamily,
    };
  }

  it.each([
    ['an address and a path', 'Reset at evil.example/x'],
    ['a comma', 'a,b'],
    ['an underscore', 'x_y'],
    ['a dot alone', 'Open example.com'],
    ['a slash alone', 'a/b'],
    ['64 characters', 'A'.repeat(64)],
    ['a dot after a known family', 'iPhone example.com'],
  ])('a model with %s falls back to "StockPilot app" everywhere', async (_n, model) => {
    expect(await note({ model, osName: 'iOS', osVersion: '18.1' })).toEqual({
      auditLabel: 'StockPilot app',
      platform: 'iOS',
      label: 'StockPilot app',
      family: 'StockPilot app',
    });
  });

  it.each([
    [
      { model: 'iPhone 15 Pro', osName: 'iOS', osVersion: '18.1' },
      'StockPilot app on iPhone 15 Pro (iOS 18.1)',
      'StockPilot app on iPhone',
    ],
    [
      { model: 'iPad Air (5th generation)', osName: 'iPadOS', osVersion: '17.4.1' },
      'StockPilot app on iPad Air (5th generation) (iPadOS 17.4.1)',
      'StockPilot app on iPad',
    ],
    [
      { model: 'Pixel 8', osName: 'Android', osVersion: '14' },
      'StockPilot app on Pixel 8 (Android 14)',
      'StockPilot app on Android',
    ],
    [
      { model: 'Simulator iOS', osName: 'iOS', osVersion: '18.1' },
      'StockPilot app on Simulator iOS (iOS 18.1)',
      'StockPilot app',
    ],
    [
      { osName: 'Android', osVersion: '14' },
      'StockPilot app on Android',
      'StockPilot app on Android',
    ],
  ])(
    '%o: the model in the label, the family in the Audit row and the activity',
    async (device, label, family) => {
      expect(await note(device)).toEqual({
        auditLabel: family,
        platform: device.osName,
        label,
        family,
      });
    },
  );

  it.each(['Visit evil', 'ios', 'iOS ', 'Windows', 'iPhone OS'])(
    'a system outside the three names (%j) is dropped: no platform, no system in the label',
    async (osName) => {
      expect(await note({ model: 'iPhone 15 Pro', osName, osVersion: '18.1' })).toEqual({
        auditLabel: 'StockPilot app on iPhone',
        platform: null,
        label: 'StockPilot app on iPhone 15 Pro',
        family: 'StockPilot app on iPhone',
      });
    },
  );

  it.each(['call-now', '18.1a', '18_1', '1'.repeat(17), '18 1'])(
    'a system version that is not digits and dots, or over 16 characters (%j), is dropped',
    async (osVersion) => {
      expect((await note({ model: 'iPhone 15 Pro', osName: 'iOS', osVersion })).label).toBe(
        'StockPilot app on iPhone 15 Pro (iOS)',
      );
    },
  );

  it('a system version of 16 digits and dots is kept', async () => {
    expect(
      (await note({ model: 'iPhone 15 Pro', osName: 'iOS', osVersion: '18.1.1.1.1.1.1.1' })).label,
    ).toBe('StockPilot app on iPhone 15 Pro (iOS 18.1.1.1.1.1.1.1)');
  });
});

describe('POST /api/v1/auth/signed-in — an unexpected failure', () => {
  it('answers the fixed sentence and reports it (S16)', async () => {
    h.withApiContext.mockRejectedValue(
      new Error('account status unreadable: relation "user_profiles" does not exist'),
    );
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: 'Something went wrong. Please try again.',
    });
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'auth.signed_in' }),
    );
  });
});

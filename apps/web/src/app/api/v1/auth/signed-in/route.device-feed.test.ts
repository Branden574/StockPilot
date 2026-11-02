import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: a phone sign-in's note keeps only the device family in
 * the organization's activity (the security.new_device_login event), and
 * names the device from the allowlisted fields alone, never from the
 * request's User-Agent (security review of S5a; integrator decision, device
 * label 2026-11-02).
 *
 * The family is "StockPilot app on iPhone", "on iPad" or "on Android", else
 * "StockPilot app". The model stays in the person's own device list and
 * their own new-device email.
 *
 * The REAL route, the REAL noteLoginDevice and the REAL Slack request
 * builder. Only the identity, the rate limiter, the Audit row, the email
 * transport, the event dispatch and the admin client's tables are faked.
 */

const ORG = '44444444-4444-4444-8444-444444444444';
const INSTALL = '0f6c2d1e-8a4b-4c5d-9e6f-7a8b9c0d1e2f';
// A placeholder agent: none of it may be shown anywhere.
const AGENT = 'Placeholder-Agent/1.0 (ua-marker)';

const h = vi.hoisted(() => ({
  after: [] as Array<() => unknown>,
  dispatched: [] as Array<{ org: string; type: string; data: Record<string, unknown> }>,
  emails: [] as Array<Record<string, unknown>>,
  stored: [] as Array<Record<string, unknown>>,
  sessions: 0,
}));

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(async () => ({
    organizationId: '44444444-4444-4444-8444-444444444444',
    userId: '11111111-1111-4111-8111-111111111111',
    role: 'viewer',
    permissions: undefined,
    supabase: { auth: {} },
    mfaRequired: false,
    mfaSatisfied: true,
    mfaEnrolled: false,
    enabledModules: new Set(),
  })),
}));
vi.mock('@/lib/auth/verified-claims', () => ({
  readVerifiedTokenClaims: vi.fn(async () => ({
    userId: '11111111-1111-4111-8111-111111111111',
    // A fresh session each time, so each request writes its note.
    sessionId: `22222222-2222-4222-8222-${String(++h.sessions).padStart(12, '0')}`,
    aal: 'aal2',
    amr: [],
    email: 'member@example.com',
  })),
}));
vi.mock('@/server/services/auth-audit', () => ({ emitAuthAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (cb: () => unknown) => h.after.push(cb) };
});
vi.mock('@/lib/email/login-alert', () => ({
  sendNewDeviceLoginEmail: vi.fn(async (a: Record<string, unknown>) => {
    h.emails.push(a);
  }),
}));
vi.mock('@/server/services/integration-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/integration-events')>();
  return {
    ...actual,
    dispatchEvent: vi.fn(async (org: string, type: string, data: Record<string, unknown>) => {
      h.dispatched.push({ org, type, data });
    }),
  };
});
// The account already has a known device, and is an accepted member of ORG.
vi.mock('@/lib/supabase/admin', () => {
  const chain = (result: unknown) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'not', 'limit', 'update']) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return b;
  };
  return {
    createAdminClient: () => ({
      from: (table: string) => {
        if (table === 'organization_members') {
          return chain({
            data: [{ organization_id: '44444444-4444-4444-8444-444444444444' }],
            error: null,
          });
        }
        const devices = chain({ data: null, error: null, count: 1 });
        devices.insert = async (row: Record<string, unknown>) => {
          h.stored.push(row);
          return { data: null, error: null };
        };
        return devices;
      },
    }),
  };
});

import { buildRequest } from '@/server/services/integration-events';

import { POST } from './route';

async function signIn(device: unknown) {
  const res = await POST(
    new Request('http://localhost/api/v1/auth/signed-in', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token-1',
        'content-type': 'application/json',
        'user-agent': AGENT,
      },
      body: JSON.stringify({ installId: INSTALL, device }),
    }),
  );
  expect(res.status).toBe(200);
  for (const cb of h.after.splice(0)) await cb();
}

function slackText(data: Record<string, unknown>): string {
  const req = buildRequest(
    { id: 'ep', organization_id: ORG, type: 'slack', url: 'https://hooks.example/x', secret: null },
    'security.new_device_login',
    { data },
  );
  return (JSON.parse(req.body) as { text: string }).text;
}

beforeEach(() => {
  h.after.length = 0;
  h.dispatched.length = 0;
  h.emails.length = 0;
  h.stored.length = 0;
});

describe('POST /api/v1/auth/signed-in: the organization’s activity', () => {
  it.each([
    ['no device fields', {}],
    ['a model outside the allowlist', { model: '<model-marker|x>' }],
    ['a system but no model', { osName: 'iOS', osVersion: '18.1' }],
  ])(
    '%s: the device is "StockPilot app", and the User-Agent reaches no Slack text, email or stored device',
    async (_n, device) => {
      await signIn(device);
      expect(h.dispatched).toHaveLength(1);
      expect(h.dispatched[0]!.type).toBe('security.new_device_login');
      expect(h.dispatched[0]!.data.device).toBe('StockPilot app');
      const text = slackText(h.dispatched[0]!.data);
      expect(text).not.toContain('marker');
      expect(text).toContain('(StockPilot app)');
      expect(h.emails).toHaveLength(1);
      expect(h.emails[0]!.deviceLabel).toBe('StockPilot app');
      expect(h.stored).toHaveLength(1);
      expect(h.stored[0]!.user_agent).toBe('StockPilot app');
    },
  );

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
  ])(
    'an allowlisted model (%o): the person’s own device list and email name it, the activity names only the family',
    async (device, label, family) => {
      await signIn(device);
      expect(h.dispatched[0]!.data.device).toBe(family);
      const text = slackText(h.dispatched[0]!.data);
      expect(text).toContain(`(${family})`);
      expect(text).not.toContain(device.model);
      expect(text).not.toContain('marker');
      expect(h.emails[0]!.deviceLabel).toBe(label);
      expect(h.stored[0]!.user_agent).toBe(label);
    },
  );
});

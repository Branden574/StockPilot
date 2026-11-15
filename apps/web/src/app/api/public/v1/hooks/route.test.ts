import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authorizePublicApi } from '@/lib/auth/public-api';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET, POST } from './route';

vi.mock('@/lib/auth/public-api', () => ({ authorizePublicApi: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

function authOk() {
  vi.mocked(authorizePublicApi).mockResolvedValue({
    ctx: { organizationId: 'org-1', keyId: 'key-1', scopes: ['webhooks:manage'] },
  } as never);
}

function adminStub(overrides: Record<string, unknown> = {}) {
  const stub = makeSupabaseStub({
    'organization_modules.select': { data: [{ enabled: true }], error: null },
    'organizations.select': { data: [{ all_modules_comp: false }], error: null },
    'integration_endpoints.select': { data: [], error: null },
    'integration_endpoints.insert': { data: [{ id: 'hook-1' }], error: null },
    ...overrides,
  });
  vi.mocked(createAdminClient).mockReturnValue(stub.client as never);
  return stub;
}

function req(body: unknown) {
  return new Request('https://test.local/api/public/v1/hooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer sk_live_x' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/public/v1/hooks (automation webhook subscribe)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('subscribes a valid https hook and returns 201 with id + secret', async () => {
    authOk();
    const stub = adminStub();
    const res = await POST(req({ target_url: 'https://hooks.zapier.com/abc', event_types: ['po.received'] }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe('hook-1');
    expect(typeof json.secret).toBe('string');
    expect(json.event_types).toEqual(['po.received']);
    // Inserted as an org-scoped webhook endpoint.
    const ins = stub.chainArgs.get('integration_endpoints.insert')?.[0]?.[0] as Record<string, unknown>;
    expect(ins.organization_id).toBe('org-1');
    expect(ins.type).toBe('webhook');
    expect(ins.event_types).toEqual(['po.received']);
  });

  it('rejects a non-https target_url with 400', async () => {
    authOk();
    adminStub();
    const res = await POST(req({ target_url: 'http://insecure.example/x', event_types: ['po.received'] }));
    expect(res.status).toBe(400);
  });

  it('rejects when no known event types are supplied (400)', async () => {
    authOk();
    adminStub();
    const res = await POST(req({ target_url: 'https://ok.example/x', event_types: ['not.a.real.event'] }));
    expect(res.status).toBe(400);
  });

  it('rejects security.* events (not exfiltrable via a public key) with 400 and no insert', async () => {
    authOk();
    const stub = adminStub();
    const res = await POST(
      req({ target_url: 'https://ok.example/x', event_types: ['security.new_device_login'] }),
    );
    expect(res.status).toBe(400);
    expect(stub.chainArgs.get('integration_endpoints.insert')).toBeUndefined();
  });

  it('returns 403 when the integrations module is disabled', async () => {
    authOk();
    adminStub({ 'organization_modules.select': { data: [{ enabled: false }], error: null } });
    const res = await POST(req({ target_url: 'https://ok.example/x', event_types: ['po.received'] }));
    expect(res.status).toBe(403);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('accepts a COMPED organization whose integrations row is OFF, like the dashboard panel beside it', async () => {
    authOk();
    // Rows-only, this route refused a comped organization's Zapier subscribe call
    // while the Webhooks panel accepted the very same URL.
    adminStub({
      'organization_modules.select': { data: [{ enabled: false }], error: null },
      'organizations.select': { data: [{ all_modules_comp: true }], error: null },
    });
    const res = await POST(req({ target_url: 'https://ok.example/x', event_types: ['po.received'] }));
    expect(res.status).not.toBe(403);
  });

  it.each([
    [
      'the comp flag',
      {
        'organization_modules.select': { data: [{ enabled: false }], error: null },
        'organizations.select': { data: null, error: { message: 'timeout', code: '57014' } },
      },
    ],
    [
      'the module row',
      { 'organization_modules.select': { data: null, error: { message: 'timeout', code: '57014' } } },
    ],
  ])(
    'a module state that could not be read (%s): 503 with a Retry-After, never 403, and nothing is read or written',
    async (_name, overrides) => {
      authOk();
      const stub = adminStub(overrides);
      for (const call of [
        () => POST(req({ target_url: 'https://ok.example/x', event_types: ['po.received'] })),
        () => GET(new Request('https://test.local/api/public/v1/hooks')),
      ]) {
        const res = await call();
        expect(res.status).toBe(503);
        expect(res.headers.get('retry-after')).toBe('5');
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual({
          error: 'Your access could not be checked. Please try again.',
        });
      }
      expect(stub.fromCalls).not.toContain('integration_endpoints');
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'ModulesUnavailableError' }),
        { tag: 'public_api.hooks.module_state', level: 'warning', organizationId: 'org-1' },
      );
    },
  );

  it('a comp flag that cannot be read is never a comp: still not served', async () => {
    authOk();
    const stub = adminStub({
      'organization_modules.select': { data: [{ enabled: false }], error: null },
      'organizations.select': { data: null, error: { message: 'timeout' } },
    });
    const res = await POST(req({ target_url: 'https://ok.example/x', event_types: ['po.received'] }));
    expect(res.status).toBe(503);
    expect(stub.chainArgs.get('integration_endpoints.insert')).toBeUndefined();
  });

  it('propagates the auth failure response (e.g. missing scope)', async () => {
    const { NextResponse } = await import('next/server');
    vi.mocked(authorizePublicApi).mockResolvedValue({
      res: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    } as never);
    const res = await POST(req({ target_url: 'https://ok.example/x', event_types: ['po.received'] }));
    expect(res.status).toBe(403);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authorizePublicApi } from '@/lib/auth/public-api';
import { createAdminClient } from '@/lib/supabase/admin';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/public-api', () => ({ authorizePublicApi: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

function authOk() {
  vi.mocked(authorizePublicApi).mockResolvedValue({
    ctx: { organizationId: 'org-1', keyId: 'key-1', scopes: ['webhooks:manage'] },
  } as never);
}

function adminStub(overrides: Record<string, unknown> = {}) {
  const stub = makeSupabaseStub({
    'organization_modules.select': { data: { enabled: true }, error: null },
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
  beforeEach(() => vi.clearAllMocks());

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
    adminStub({ 'organization_modules.select': { data: { enabled: false }, error: null } });
    const res = await POST(req({ target_url: 'https://ok.example/x', event_types: ['po.received'] }));
    expect(res.status).toBe(403);
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

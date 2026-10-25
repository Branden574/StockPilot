import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, orgHeader } from './api';

/**
 * The workspace header names only the signed-in account's own saved workspace
 * (docket B10: the 401 burst about a second after a password sign-in).
 *
 * THE DEFECT. api() sent X-Organization-Id from the saved workspace whoever
 * saved it. The biometric and MFA fallbacks ("Use password instead", "Use a
 * different account") and a session the server ended keep that key for the
 * person coming back, so the next account to sign in sent the previous
 * account's organization on its first requests (/me/seen, /me/announcements,
 * /mobile/snapshot), and the server refused each one with a 401 (a requested
 * organization the caller is not a member of is a refusal, not a fallback:
 * apps/web/src/lib/auth/api-context.ts). Each 401 also asked the eviction bus
 * for a probe.
 *
 * Executed against the real api.ts; vi.hoisted and vi.mock run before it loads.
 */

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});

const state = vi.hoisted(() => ({
  saved: {} as Record<string, string>,
  session: { access_token: 'token-u2', user: { id: 'u2' } } as null | {
    access_token: string;
    user: { id: string };
  },
  stored: { present: true, userId: 'u2' as string | null },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async (key: string) => state.saved[key] ?? null) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
const supabaseMock = vi.hoisted(() => ({
  getSession: vi.fn(async () => ({ data: { session: state.session } })),
  readDeviceAuthSession: vi.fn(async () => state.stored),
}));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: supabaseMock.getSession } },
  readDeviceAuthSession: supabaseMock.readDeviceAuthSession,
}));
vi.mock('./account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('./request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  text: async () => '{}',
  json: async () => ({}),
}));

function sentHeaders(): Record<string, string> {
  const init = (
    fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
  )[1];
  return init.headers;
}

/** The saved workspace as use-workspace.ts writes it (owner absent: an older build's). */
function save(orgId: string, ownerId?: string) {
  state.saved = { 'workspace.activeOrgId': orgId };
  if (ownerId) state.saved['workspace.activeOrgUserId'] = ownerId;
}

beforeEach(() => {
  state.saved = {};
  state.session = { access_token: 'token-u2', user: { id: 'u2' } };
  state.stored = { present: true, userId: 'u2' };
  fetchMock.mockClear();
  supabaseMock.getSession.mockClear();
  supabaseMock.readDeviceAuthSession.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('api() names the saved workspace only for the account that saved it', () => {
  it("another account's saved workspace is not named: the server answers for this account's own", async () => {
    save('org-a', 'u1');
    await api('/api/v1/me/seen', { method: 'POST' });
    expect(sentHeaders()).not.toHaveProperty('X-Organization-Id');
    expect(sentHeaders().Authorization).toBe('Bearer token-u2');
  });

  it("this account's saved workspace is named", async () => {
    save('org-b', 'u2');
    await api('/api/v1/me/announcements');
    expect(sentHeaders()['X-Organization-Id']).toBe('org-b');
  });

  it('a workspace saved by an older build (no owner) is named, as before', async () => {
    save('org-b');
    await api('/api/v1/mobile/snapshot');
    expect(sentHeaders()['X-Organization-Id']).toBe('org-b');
  });

  it('the owner is checked against the account whose bearer is sent, from the same session read', async () => {
    save('org-b', 'u2');
    await api('/api/v1/me/seen', { method: 'POST' });
    expect(supabaseMock.getSession).toHaveBeenCalledTimes(1);
    expect(supabaseMock.readDeviceAuthSession).not.toHaveBeenCalled();
  });

  it('a request that names its own workspace still sends that one', async () => {
    save('org-a', 'u1');
    await api('/api/v1/cycle-counts/c1/lines', { method: 'POST', orgId: 'org-c' });
    expect(sentHeaders()['X-Organization-Id']).toBe('org-c');
  });

  it('with nobody signed in, an owned workspace is not named', async () => {
    save('org-a', 'u1');
    state.session = null;
    await api('/api/v1/public/thing');
    expect(sentHeaders()).not.toHaveProperty('X-Organization-Id');
    expect(sentHeaders()).not.toHaveProperty('Authorization');
  });
});

describe('orgHeader() for the screens that call fetch themselves', () => {
  it('checks the owner against the stored session, never a refreshing getSession()', async () => {
    save('org-a', 'u1');
    state.stored = { present: true, userId: 'u2' };
    await expect(orgHeader()).resolves.toEqual({});
    state.stored = { present: true, userId: 'u1' };
    await expect(orgHeader()).resolves.toEqual({ 'X-Organization-Id': 'org-a' });
    expect(supabaseMock.getSession).not.toHaveBeenCalled();
  });

  it('takes the account when the caller has it', async () => {
    save('org-a', 'u1');
    await expect(orgHeader('u1')).resolves.toEqual({ 'X-Organization-Id': 'org-a' });
    await expect(orgHeader('u2')).resolves.toEqual({});
    await expect(orgHeader(null)).resolves.toEqual({});
    expect(supabaseMock.readDeviceAuthSession).not.toHaveBeenCalled();
  });

  it('an unreadable stored session names no owned workspace', async () => {
    save('org-a', 'u1');
    supabaseMock.readDeviceAuthSession.mockRejectedValueOnce(new Error('keychain locked'));
    await expect(orgHeader()).resolves.toEqual({});
  });

  it('nothing saved names nothing', async () => {
    await expect(orgHeader('u2')).resolves.toEqual({});
  });
});

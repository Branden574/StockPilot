/**
 * "Sign out this device" must sign a web tab out LIVE.
 *
 * The listener matches a "revoked" broadcast against the session_id claim of
 * this tab's own access token. It used to decode that claim with
 * Buffer.from(seg, 'base64url'), which Node supports but the client bundle's
 * `buffer` polyfill (next/dist/compiled/buffer) does not: isEncoding() has no
 * 'base64url', so it threw, the id stayed null and no broadcast ever matched.
 * The realtime socket kept streaming to the revoked tab until token expiry.
 *
 * The rendered tests install that same polyfill as the global Buffer, so they
 * run against what the browser actually has, not against Node's Buffer.
 */
import { render, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { decodeBase64UrlUtf8, sessionIdFromAccessToken } from './session-id-from-token';

const MY_SESSION = '5f0c9a1e-7b2d-4c3e-9f10-aa55bb66cc77';
// The name is chosen so the encoded payload contains BOTH URL-safe characters
// ('-' and '_') and needs padding that the JWT form leaves off.
const PAYLOAD = { session_id: MY_SESSION, name: 'þÿûé' };

function b64url(value: unknown): string {
  // Test-side encoding only (Node); the code under test never uses Buffer.
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
const PAYLOAD_SEGMENT = b64url(PAYLOAD);
const FAKE_JWT = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${PAYLOAD_SEGMENT}.signature`;

describe('decodeBase64UrlUtf8', () => {
  it('the fixture really exercises the URL-safe alphabet and missing padding', () => {
    expect(PAYLOAD_SEGMENT).toContain('-');
    expect(PAYLOAD_SEGMENT).toContain('_');
    expect(PAYLOAD_SEGMENT.length % 4).not.toBe(0);
    expect(PAYLOAD_SEGMENT).not.toContain('=');
  });

  it("decodes a base64url segment with '-', '_' and no padding, as UTF-8", () => {
    expect(JSON.parse(decodeBase64UrlUtf8(PAYLOAD_SEGMENT))).toEqual(PAYLOAD);
  });

  it('reads the session_id claim from a token', () => {
    expect(sessionIdFromAccessToken(FAKE_JWT)).toBe(MY_SESSION);
  });

  it('returns null for anything it cannot read', () => {
    expect(sessionIdFromAccessToken(undefined)).toBeNull();
    expect(sessionIdFromAccessToken('')).toBeNull();
    expect(sessionIdFromAccessToken('only-one-part')).toBeNull();
    expect(sessionIdFromAccessToken('a.!!!notbase64!!!.c')).toBeNull();
    expect(sessionIdFromAccessToken(`a.${b64url({ sub: 'u1' })}.c`)).toBeNull();
    expect(sessionIdFromAccessToken(`a.${b64url({ session_id: 42 })}.c`)).toBeNull();
  });
});

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  signOut: vi.fn(async (_opts?: unknown) => ({ error: null })),
  getSession: vi.fn(),
  // GoTrue's answer about THIS session when a message arrives. A real
  // revocation deletes the session first, so getUser fails.
  getUser: vi.fn(),
  handlers: [] as Array<(msg: { payload: unknown }) => void>,
  channelName: vi.fn(),
  forgetTourState: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('next/navigation', () => {
  const router = { replace: h.replace, push: vi.fn(), refresh: vi.fn() };
  return { useRouter: () => router };
});

vi.mock('sonner', () => ({ toast: { message: h.toast } }));

vi.mock('@/lib/onboarding/tour-state-cache', () => ({
  forgetTourState: h.forgetTourState,
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getSession: h.getSession, getUser: h.getUser, signOut: h.signOut },
    channel: (name: string) => {
      h.channelName(name);
      const ch: Record<string, unknown> = {
        on: (_type: string, _filter: unknown, cb: (msg: { payload: unknown }) => void) => {
          h.handlers.push(cb);
          return ch;
        },
        subscribe: vi.fn(),
      };
      return ch;
    },
    removeChannel: vi.fn(),
  }),
}));

import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';

import { SessionRevocationListener } from './session-revocation-listener';

const nodeBuffer = globalThis.Buffer;

describe('SessionRevocationListener (browser Buffer polyfill installed)', () => {
  beforeAll(async () => {
    // What the client bundle actually gets for `Buffer`. Next ships no type
    // declarations for its compiled polyfill; the shape is asserted below.
    // @ts-expect-error -- untyped module, cast on the next line
    const polyfill = (await import('next/dist/compiled/buffer/index.js')) as unknown as {
      Buffer: typeof Buffer;
    };
    expect(polyfill.Buffer.isEncoding('base64url')).toBe(false);
    globalThis.Buffer = polyfill.Buffer;
  });

  afterAll(() => {
    globalThis.Buffer = nodeBuffer;
  });

  beforeEach(() => {
    h.replace.mockClear();
    h.signOut.mockClear();
    h.forgetTourState.mockClear();
    h.toast.mockClear();
    h.channelName.mockClear();
    h.handlers.length = 0;
    h.getSession.mockResolvedValue({ data: { session: { access_token: FAKE_JWT } } });
    // Default: the session really was revoked (GoTrue no longer knows it).
    h.getUser.mockReset();
    h.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError('Session from session_id claim in JWT does not exist', 403, 'session_not_found'),
    });
  });

  async function mount() {
    render(<SessionRevocationListener userId="user-1" />);
    await waitFor(() => expect(h.handlers).toHaveLength(1));
    expect(h.channelName).toHaveBeenCalledWith('user:user-1:sessions');
    return h.handlers[0]!;
  }

  it('a broadcast naming this session signs this tab out locally and goes to /signin', async () => {
    const onRevoked = await mount();

    onRevoked({ payload: { sessionIds: ['someone-else', MY_SESSION] } });

    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/signin'));
    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(h.forgetTourState).toHaveBeenCalledTimes(1);
  });

  it('"sign out everywhere else" (keepId is another session) signs this tab out', async () => {
    const onRevoked = await mount();

    onRevoked({ payload: { keepId: 'the-device-that-asked' } });

    await waitFor(() => expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' }));
  });

  it('a FORGED message (the session is still live at GoTrue) signs nothing out', async () => {
    // The channel is public: anyone with the anon key and this user's id can
    // send one. Before signing out, the tab asks GoTrue; a session it still
    // accepts means the message is not a real revocation.
    h.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    const onRevoked = await mount();

    onRevoked({ payload: { sessionIds: [MY_SESSION] } });
    onRevoked({ payload: { keepId: 'someone-else' } });
    await waitFor(() => expect(h.getUser).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.forgetTourState).not.toHaveBeenCalled();
  });

  it('a check that could not be made (network) signs nothing out; token expiry still applies', async () => {
    h.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError('Failed to fetch', 0),
    });
    const onRevoked = await mount();

    onRevoked({ payload: { sessionIds: [MY_SESSION] } });
    await waitFor(() => expect(h.getUser).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('a tab whose own session id is unknown ignores a keepId message', async () => {
    h.getSession.mockResolvedValue({ data: { session: { access_token: 'not-a-jwt' } } });
    const onRevoked = await mount();

    onRevoked({ payload: { keepId: 'x' } });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.getUser).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('a broadcast about other sessions leaves this tab signed in', async () => {
    const onRevoked = await mount();

    onRevoked({ payload: { sessionIds: ['someone-else'] } });
    onRevoked({ payload: { keepId: MY_SESSION } });
    onRevoked({ payload: {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });
});

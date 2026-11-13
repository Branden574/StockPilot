import { GoTrueClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  codeGateUp,
  decodeJwtPayload,
  reconcileStepUp,
  stepUpOwedFor,
  stepUpOwedFromStored,
  tokenAal,
  verifiedTotpFactorId,
} from './mfa-level';

/**
 * Security invariant (docket S43b): whether a session still owes its
 * authenticator code is worked out from the session itself, so the phone's
 * code gate holds with no connection and in the same render the session
 * arrives in. Every branch of that answer is executed here; the last block
 * runs the real auth-js client offline, so the premise (the stored session
 * carries the token's level and the user's factors) is itself under test.
 */

/** A token shaped like GoTrue's: header, claims, signature (never checked on the phone). */
function jwt(claims: Record<string, unknown>): string {
  return [{ alg: 'HS256', typ: 'JWT' }, claims, 'signature']
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
}

const NOW = Math.floor(Date.now() / 1000);
const TOTP = { id: 'factor-totp', factor_type: 'totp', status: 'verified' };
const TOTP_UNVERIFIED = { id: 'factor-new', factor_type: 'totp', status: 'unverified' };
const PHONE = { id: 'factor-phone', factor_type: 'phone', status: 'verified' };

function session(
  aal: string | null,
  factors?: unknown[] | null,
  over: { exp?: number; userId?: string } = {},
) {
  return {
    access_token: jwt({
      sub: over.userId ?? 'u1',
      exp: over.exp ?? NOW + 3600,
      ...(aal ? { aal } : {}),
    }),
    user: {
      id: over.userId ?? 'u1',
      ...(factors === undefined ? {} : { factors }),
    } as { id: string; factors?: (typeof TOTP)[] | null },
  };
}

describe('decodeJwtPayload / tokenAal', () => {
  it('reads the claims of a token, unicode included', () => {
    expect(decodeJwtPayload(jwt({ aal: 'aal1', session_id: 's1', name: 'Zoë 東京' }))).toEqual({
      aal: 'aal1',
      session_id: 's1',
      name: 'Zoë 東京',
    });
  });

  it('answers null for anything that is not a token', () => {
    for (const value of [null, undefined, '', 'x', 'x.y.z', 'a.!!!.c', `a.${Buffer.from('[1]').toString('base64url')}.c`]) {
      expect(decodeJwtPayload(value), String(value)).toBeNull();
    }
    expect(decodeJwtPayload(42 as unknown as string)).toBeNull();
  });

  it('the level is the aal claim, and nothing else stands in for it', () => {
    expect(tokenAal(jwt({ aal: 'aal1' }))).toBe('aal1');
    expect(tokenAal(jwt({ aal: 'aal2' }))).toBe('aal2');
    expect(tokenAal(jwt({ amr: [{ method: 'totp' }] }))).toBeNull();
    expect(tokenAal(jwt({ aal: 2 }))).toBeNull();
    expect(tokenAal('not-a-token')).toBeNull();
    expect(tokenAal(null)).toBeNull();
  });
});

describe('stepUpOwedFor: does this session still owe its authenticator code?', () => {
  it('a verified factor and a password-only token: owed', () => {
    expect(stepUpOwedFor(session('aal1', [TOTP]))).toBe(true);
  });

  it('a verified factor of any type counts, as on the server', () => {
    expect(stepUpOwedFor(session('aal1', [PHONE]))).toBe(true);
    expect(stepUpOwedFor(session('aal1', [TOTP_UNVERIFIED, PHONE]))).toBe(true);
  });

  it('a level that is missing or cannot be read is not aal2: owed', () => {
    expect(stepUpOwedFor(session(null, [TOTP]))).toBe(true);
    expect(stepUpOwedFor({ access_token: 'garbage', user: { id: 'u1', factors: [TOTP] } })).toBe(true);
    expect(stepUpOwedFor({ access_token: null, user: { id: 'u1', factors: [TOTP] } })).toBe(true);
    expect(stepUpOwedFor({ user: { id: 'u1', factors: [TOTP] } })).toBe(true);
  });

  it('an expired password-only token still owes it (the level does not improve with age)', () => {
    expect(stepUpOwedFor(session('aal1', [TOTP], { exp: NOW - 7200 }))).toBe(true);
  });

  it('the code was entered (aal2): not owed, expired token or not', () => {
    expect(stepUpOwedFor(session('aal2', [TOTP]))).toBe(false);
    expect(stepUpOwedFor(session('aal2', [TOTP], { exp: NOW - 7200 }))).toBe(false);
  });

  it('no factor: never owed, whatever the level', () => {
    expect(stepUpOwedFor(session('aal1'))).toBe(false);
    expect(stepUpOwedFor(session('aal1', []))).toBe(false);
    expect(stepUpOwedFor(session('aal1', null))).toBe(false);
    expect(stepUpOwedFor(session(null))).toBe(false);
  });

  it('a factor that was never verified is no factor', () => {
    expect(stepUpOwedFor(session('aal1', [TOTP_UNVERIFIED]))).toBe(false);
  });

  it('signed out (no session): nothing is owed, the sign-in screen is what shows', () => {
    expect(stepUpOwedFor(null)).toBe(false);
    expect(stepUpOwedFor(undefined)).toBe(false);
  });

  it('a session with no user lists no factor', () => {
    expect(stepUpOwedFor({ access_token: jwt({ aal: 'aal1' }) })).toBe(false);
    expect(stepUpOwedFor({ access_token: jwt({ aal: 'aal1' }), user: null })).toBe(false);
  });
});

describe('codeGateUp: the gate RootGate reads', () => {
  it('up when the session itself owes its code, with or without a note', () => {
    expect(codeGateUp(session('aal1', [TOTP]), null)).toBe(true);
    expect(codeGateUp(session('aal1', [TOTP]), 'u1')).toBe(true);
    expect(codeGateUp(session('aal1', [TOTP]), 'someone-else')).toBe(true);
  });

  it("up on the server's word for this account, while the session's copy lists no factor yet", () => {
    // An authenticator turned on elsewhere mid-session, and the refresh that
    // would show it could not be made (mfa-reconcile.ts).
    expect(codeGateUp(session('aal1'), 'u1')).toBe(true);
    expect(codeGateUp(session(null), 'u1')).toBe(true);
  });

  it('a note about another account says nothing about this session', () => {
    expect(codeGateUp(session('aal1'), 'u2')).toBe(false);
  });

  it('a session that entered its code is never asked again, whatever was noted', () => {
    expect(codeGateUp(session('aal2', [TOTP]), 'u1')).toBe(false);
    expect(codeGateUp(session('aal2'), 'u1')).toBe(false);
  });

  it('down with no factor and no note', () => {
    expect(codeGateUp(session('aal1'), null)).toBe(false);
    expect(codeGateUp(session('aal1', [TOTP_UNVERIFIED]), null)).toBe(false);
  });

  it('down when signed out, note or not', () => {
    expect(codeGateUp(null, null)).toBe(false);
    expect(codeGateUp(null, 'u1')).toBe(false);
    expect(codeGateUp(undefined, 'u1')).toBe(false);
  });

  it('a session with no account id is never matched by a note', () => {
    expect(codeGateUp({ access_token: jwt({ aal: 'aal1' }), user: {} }, 'u1')).toBe(false);
    expect(codeGateUp({ access_token: jwt({ aal: 'aal1' }), user: { id: '' } }, '')).toBe(false);
  });
});

describe('verifiedTotpFactorId: the factor the code screen answers for', () => {
  it('the verified authenticator-app factor', () => {
    expect(verifiedTotpFactorId({ id: 'u1', factors: [TOTP] })).toBe('factor-totp');
    expect(verifiedTotpFactorId({ id: 'u1', factors: [TOTP_UNVERIFIED, PHONE, TOTP] })).toBe('factor-totp');
  });

  it('none when there is no verified authenticator-app factor', () => {
    expect(verifiedTotpFactorId(null)).toBeNull();
    expect(verifiedTotpFactorId({ id: 'u1' })).toBeNull();
    expect(verifiedTotpFactorId({ id: 'u1', factors: [] })).toBeNull();
    expect(verifiedTotpFactorId({ id: 'u1', factors: [TOTP_UNVERIFIED] })).toBeNull();
    expect(verifiedTotpFactorId({ id: 'u1', factors: [PHONE] })).toBeNull();
    expect(verifiedTotpFactorId({ id: 'u1', factors: [null, { status: 'verified', factor_type: 'totp' }] })).toBeNull();
  });
});

describe('stepUpOwedFromStored: the same answer from the session as stored on the device', () => {
  const stored = (s: unknown) => JSON.stringify(s);
  const base = (aal: string | null, factors?: unknown) => ({
    access_token: jwt(aal ? { aal } : {}),
    refresh_token: 'r',
    expires_at: NOW + 3600,
    user: { id: 'u1', ...(factors === undefined ? {} : { factors }) },
  });

  it('agrees with stepUpOwedFor for every readable session', () => {
    const cases: [string | null, unknown][] = [
      ['aal1', [TOTP]],
      [null, [TOTP]],
      ['aal2', [TOTP]],
      ['aal1', undefined],
      ['aal1', []],
      ['aal1', null],
      ['aal1', [TOTP_UNVERIFIED]],
      ['aal1', [PHONE]],
    ];
    for (const [aal, factors] of cases) {
      const s = base(aal, factors);
      expect(stepUpOwedFromStored(stored(s)), JSON.stringify([aal, factors])).toBe(
        stepUpOwedFor(s as Parameters<typeof stepUpOwedFor>[0]),
      );
    }
    expect(stepUpOwedFromStored(stored(base('aal1', [TOTP])))).toBe(true);
    expect(stepUpOwedFromStored(stored(base('aal2', [TOTP])))).toBe(false);
    expect(stepUpOwedFromStored(stored(base('aal1')))).toBe(false);
  });

  it('a token that is not a token, with a verified factor: owed', () => {
    expect(stepUpOwedFromStored(stored({ ...base('aal2', [TOTP]), access_token: 'a' }))).toBe(true);
    expect(stepUpOwedFromStored(stored({ ...base('aal2', [TOTP]), access_token: 7 }))).toBe(true);
  });

  it('what cannot be read as a session owes it: nothing is sent on a guess', () => {
    expect(stepUpOwedFromStored(null)).toBe(true);
    expect(stepUpOwedFromStored(undefined)).toBe(true);
    expect(stepUpOwedFromStored('')).toBe(true);
    expect(stepUpOwedFromStored('not json')).toBe(true);
    expect(stepUpOwedFromStored('"a string"')).toBe(true);
    expect(stepUpOwedFromStored('[]')).toBe(true);
    expect(stepUpOwedFromStored(stored({ access_token: jwt({ aal: 'aal1' }) }))).toBe(true);
    expect(stepUpOwedFromStored(stored({ ...base('aal1'), user: null }))).toBe(true);
    expect(stepUpOwedFromStored(stored({ ...base('aal1'), user: 'u1' }))).toBe(true);
    // Factors present but not a list: not read as "none".
    expect(stepUpOwedFromStored(stored(base('aal1', 'totp')))).toBe(true);
    expect(stepUpOwedFromStored(stored(base('aal1', { 0: TOTP })))).toBe(true);
  });
});

describe('reconcileStepUp: the stored copy of the user against the one the server just answered with', () => {
  const live = (factors?: unknown[], id = 'u1') =>
    ({ id, ...(factors ? { factors } : {}) }) as { id: string; factors?: (typeof TOTP)[] };

  it('they agree: nothing to do', () => {
    expect(reconcileStepUp(session('aal1', [TOTP]), live([TOTP]))).toBe('none');
    expect(reconcileStepUp(session('aal1'), live())).toBe('none');
    expect(reconcileStepUp(session('aal1', [TOTP_UNVERIFIED]), live([TOTP_UNVERIFIED]))).toBe('none');
  });

  it('an authenticator turned on elsewhere since the session was stored: refresh', () => {
    expect(reconcileStepUp(session('aal1'), live([TOTP]))).toBe('refresh');
    expect(reconcileStepUp(session('aal1', [TOTP_UNVERIFIED]), live([TOTP]))).toBe('refresh');
  });

  it('an authenticator removed since (a reset, a recovery code): refresh', () => {
    expect(reconcileStepUp(session('aal1', [TOTP]), live())).toBe('refresh');
    expect(reconcileStepUp(session('aal1', [TOTP]), live([TOTP_UNVERIFIED]))).toBe('refresh');
  });

  it('a session that entered its code owes nothing when a second factor is added', () => {
    expect(reconcileStepUp(session('aal2', [TOTP]), live([TOTP, PHONE]))).toBe('none');
    expect(reconcileStepUp(session('aal2'), live([TOTP]))).toBe('none');
    expect(reconcileStepUp(session('aal2', [TOTP]), live())).toBe('none');
  });

  it('an answer about another account, or no answer, says nothing', () => {
    expect(reconcileStepUp(session('aal1'), live([TOTP], 'u2'))).toBe('none');
    expect(reconcileStepUp(session('aal1', [TOTP]), null)).toBe('none');
    expect(reconcileStepUp(null, live([TOTP]))).toBe('none');
    expect(reconcileStepUp({ access_token: jwt({ aal: 'aal1' }), user: {} }, live([TOTP]))).toBe('none');
  });
});

/**
 * The premise, against the auth-js this app resolves: a session read back
 * from storage with NO connection carries the token and the user's factors,
 * so the gate can be worked out without a request, and it gives the same
 * answer auth-js's own level read gives (the one push registration uses:
 * use-push-notifications.ts owesAuthenticatorCode).
 */
describe('against the real auth-js client, offline: the stored session answers the gate', () => {
  const KEY = 'sb-test-auth-token';
  const store = new Map<string, string>();
  const memory = {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      store.delete(k);
    },
  };
  const requests: string[] = [];

  async function clientWith(aal: string, factors: unknown[] | undefined): Promise<GoTrueClient> {
    store.set(
      KEY,
      JSON.stringify({
        access_token: jwt({ sub: 'u1', aal, exp: NOW + 3600 }),
        refresh_token: 'r',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: NOW + 3600,
        user: {
          id: 'u1',
          aud: 'authenticated',
          app_metadata: {},
          user_metadata: {},
          created_at: '2026-09-24T00:00:00Z',
          ...(factors ? { factors } : {}),
        },
      }),
    );
    const client = new GoTrueClient({
      url: 'http://127.0.0.1:9',
      storage: memory,
      storageKey: KEY,
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
      fetch: async (input: RequestInfo | URL) => {
        requests.push(String(input));
        throw new TypeError('Network request failed');
      },
    });
    await client.initialize();
    return client;
  }

  beforeEach(() => {
    store.clear();
    requests.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['a verified factor at aal1', 'aal1', [TOTP], true],
    ['a verified factor at aal2', 'aal2', [TOTP], false],
    ['no factor at aal1', 'aal1', undefined, false],
    ['an unverified factor at aal1', 'aal1', [TOTP_UNVERIFIED], false],
  ] as const)('%s: owed = %s, with no request made', async (_name, aal, factors, owed) => {
    const client = await clientWith(aal, factors ? [...factors] : undefined);
    const { data } = await client.getSession();
    expect(data.session).not.toBeNull();
    expect(stepUpOwedFor(data.session)).toBe(owed);
    expect(codeGateUp(data.session, null)).toBe(owed);
    // The stored entry itself says the same (the outbox reads that).
    expect(stepUpOwedFromStored(store.get(KEY) ?? null)).toBe(owed);
    // And so does auth-js's own level read.
    const { data: level } = await client.mfa.getAuthenticatorAssuranceLevel();
    expect(level?.currentLevel === 'aal1' && level?.nextLevel === 'aal2').toBe(owed);
    expect(requests).toEqual([]);
  });

  it('the factor id the code is for is on the stored session too', async () => {
    const client = await clientWith('aal1', [TOTP]);
    const { data } = await client.getSession();
    expect(verifiedTotpFactorId(data.session?.user)).toBe('factor-totp');
    expect(requests).toEqual([]);
  });
});

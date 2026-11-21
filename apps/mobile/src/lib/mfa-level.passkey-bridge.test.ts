import { describe, expect, it } from 'vitest';

import {
  bridgeOnlyAccount,
  codeGateUp,
  isBridgeFactor,
  PASSKEY_BRIDGE_NAME_PREFIX,
  passkeyOnlySession,
  reconcileStepUp,
  stepUpOwedFor,
  verifiedTotpFactorId,
} from './mfa-level';

/**
 * Security invariant: the phone never answers a code for a passkey's bridge
 * factor, and never loosens the code gate for it (plan section 5, 3.1 #8).
 *
 * The bridge is a TOTP factor whose secret only the server holds, named with
 * the reserved prefix sp-passkey-bridge-. The phone's only offline source is
 * the session's factor list, so it knows the bridge by that name: the code
 * screen answers for the first verified authenticator app that does not carry
 * it, whatever the order (Supabase puts the factor used last at the END of
 * the list, so the bridge comes first after the app is used: proof B7). An
 * account whose only verified factors are bridges gets a plain screen instead
 * of the code box (bridgeOnlyAccount). The gate itself is unchanged: a bridge
 * is a verified factor, so the session still owes aal2, and the outbox, push
 * and appearance holds stay closed. When the server's copy of the user and the
 * session's disagree on that (an app added or removed on the website), the
 * session is refreshed like any stale copy (reconcileStepUp), so a re-read
 * brings the right screen up (review 2-3 finding 10).
 */

function jwt(claims: Record<string, unknown>): string {
  return [{ alg: 'HS256', typ: 'JWT' }, claims, 'signature']
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
}

const APP = { id: 'factor-app', factor_type: 'totp', status: 'verified', friendly_name: 'Phone' };
const BRIDGE = {
  id: 'factor-bridge',
  factor_type: 'totp',
  status: 'verified',
  friendly_name: 'sp-passkey-bridge-a1b2c3',
};
const BRIDGE_UNVERIFIED = { ...BRIDGE, id: 'factor-bridge-new', status: 'unverified' };
const PHONE = { id: 'factor-phone', factor_type: 'phone', status: 'verified', friendly_name: null };

const user = (...factors: unknown[]) => ({ id: 'u1', factors: factors as (typeof APP)[] });
const session = (aal: string, ...factors: unknown[]) => ({
  access_token: jwt({ sub: 'u1', aal }),
  user: user(...factors),
});

describe('isBridgeFactor', () => {
  it('is a TOTP factor whose name starts with the reserved prefix, exactly', () => {
    expect(PASSKEY_BRIDGE_NAME_PREFIX).toBe('sp-passkey-bridge-');
    expect(isBridgeFactor(BRIDGE)).toBe(true);
    expect(isBridgeFactor(BRIDGE_UNVERIFIED)).toBe(true);
    expect(isBridgeFactor(APP)).toBe(false);
    expect(isBridgeFactor({ ...BRIDGE, friendly_name: 'SP-PASSKEY-BRIDGE-x' })).toBe(false);
    expect(isBridgeFactor({ ...BRIDGE, friendly_name: 'my sp-passkey-bridge-x' })).toBe(false);
    expect(isBridgeFactor({ ...BRIDGE, factor_type: 'phone' })).toBe(false);
    expect(isBridgeFactor({ ...BRIDGE, friendly_name: null })).toBe(false);
    expect(isBridgeFactor(null)).toBe(false);
  });
});

describe('verifiedTotpFactorId never picks the bridge', () => {
  it('the app, whatever the order', () => {
    expect(verifiedTotpFactorId(user(BRIDGE, APP))).toBe('factor-app');
    expect(verifiedTotpFactorId(user(APP, BRIDGE))).toBe('factor-app');
    expect(verifiedTotpFactorId(user(BRIDGE_UNVERIFIED, BRIDGE, PHONE, APP))).toBe('factor-app');
  });

  it('none for an account whose only authenticator is the bridge', () => {
    expect(verifiedTotpFactorId(user(BRIDGE))).toBeNull();
    expect(verifiedTotpFactorId(user(BRIDGE, BRIDGE_UNVERIFIED))).toBeNull();
  });
});

describe('bridgeOnlyAccount', () => {
  it('true when every verified factor is a bridge', () => {
    expect(bridgeOnlyAccount(user(BRIDGE))).toBe(true);
    expect(bridgeOnlyAccount(user(BRIDGE, { ...APP, status: 'unverified' }))).toBe(true);
  });

  it('false with an app or another verified factor beside it, or with no verified factor', () => {
    expect(bridgeOnlyAccount(user(BRIDGE, APP))).toBe(false);
    expect(bridgeOnlyAccount(user(APP, BRIDGE))).toBe(false);
    expect(bridgeOnlyAccount(user(BRIDGE, PHONE))).toBe(false);
    expect(bridgeOnlyAccount(user(APP))).toBe(false);
    expect(bridgeOnlyAccount(user(BRIDGE_UNVERIFIED))).toBe(false);
    expect(bridgeOnlyAccount(user())).toBe(false);
    expect(bridgeOnlyAccount({ id: 'u1' })).toBe(false);
    expect(bridgeOnlyAccount(null)).toBe(false);
  });
});

describe('passkeyOnlySession: the same answer for a session', () => {
  it("reads the session's own user", () => {
    expect(passkeyOnlySession(session('aal1', BRIDGE))).toBe(true);
    expect(passkeyOnlySession(session('aal1', BRIDGE, APP))).toBe(false);
    expect(passkeyOnlySession(null)).toBe(false);
  });
});

describe('the gate is unchanged for a bridge', () => {
  it('a bridge-only session at aal1 still owes its second step; at aal2 it does not', () => {
    expect(stepUpOwedFor(session('aal1', BRIDGE))).toBe(true);
    expect(codeGateUp(session('aal1', BRIDGE), null)).toBe(true);
    expect(stepUpOwedFor(session('aal2', BRIDGE))).toBe(false);
    expect(codeGateUp(session('aal2', BRIDGE), null)).toBe(false);
  });

  it('an unverified bridge alone owes nothing, as any unverified factor', () => {
    expect(stepUpOwedFor(session('aal1', BRIDGE_UNVERIFIED))).toBe(false);
  });
});

describe('reconcileStepUp: the session copy and the server disagree on a bridge-only account', () => {
  const live = (...factors: unknown[]) => user(...factors);

  it('an app added on the website to a bridge-only account: refresh (the notice gives way to the code screen)', () => {
    expect(reconcileStepUp(session('aal1', BRIDGE), live(BRIDGE, APP))).toBe('refresh');
    expect(reconcileStepUp(session('aal1', BRIDGE), live(APP, BRIDGE))).toBe('refresh');
  });

  it('the app removed, the bridge left: refresh (the code screen gives way to the notice)', () => {
    expect(reconcileStepUp(session('aal1', BRIDGE, APP), live(BRIDGE))).toBe('refresh');
  });

  it('they agree, whatever the order: nothing to do', () => {
    expect(reconcileStepUp(session('aal1', BRIDGE), live(BRIDGE))).toBe('none');
    expect(reconcileStepUp(session('aal1', BRIDGE, APP), live(APP, BRIDGE))).toBe('none');
  });

  it('a session that entered its second step owes nothing: no refresh for the kind of step', () => {
    expect(reconcileStepUp(session('aal2', BRIDGE), live(BRIDGE, APP))).toBe('none');
  });
});

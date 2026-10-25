import { describe, expect, it } from 'vitest';

import {
  LINK_FAILED_NOTICE,
  RESET_LINK_EXPIRED_NOTICE,
  RESET_QUERY_NOTICES,
  SESSION_ENDED_NOTICE,
  SIGN_IN_QUERY_NOTICES,
  linkFragment,
  resetNotice,
  signInNotice,
} from './auth-page-notices';

const query = (qs: string) => new URLSearchParams(qs);

/** Names every object inherits: a lookup that is not own-keys-only finds these. */
const INHERITED = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

describe('the words (docket B39)', () => {
  it('says what happened to the link and what to do next, in plain words', () => {
    expect(LINK_FAILED_NOTICE).toEqual({
      tone: 'danger',
      text: 'That link has expired or was already used. Sign in with your password, or ask whoever sent you the link for a new one.',
    });
  });

  it('keeps the session-ended and reset-link words the pages showed before', () => {
    expect(SESSION_ENDED_NOTICE).toEqual({
      tone: 'info',
      text: 'You were signed out on this device. Sign in again to continue.',
    });
    expect(RESET_LINK_EXPIRED_NOTICE).toEqual({
      tone: 'danger',
      text: "That reset link has expired or was already used. Enter your email below and we'll send a fresh one.",
    });
  });

  it('decides every value it lists: a notice, or null on purpose', () => {
    expect(SIGN_IN_QUERY_NOTICES).toEqual({
      error: { auth_callback_failed: LINK_FAILED_NOTICE },
      reason: { session_ended: SESSION_ENDED_NOTICE },
      reset: { success: null },
    });
    expect(RESET_QUERY_NOTICES).toEqual({ error: { link_expired: RESET_LINK_EXPIRED_NOTICE } });
  });
});

describe('linkFragment', () => {
  it('reads no fragment, an empty one and an unrelated one as none', () => {
    for (const hash of [undefined, null, '', '#', '#top', '#section=2', 'type=recovery']) {
      expect(linkFragment(hash), String(hash)).toBe('none');
    }
  });

  it("reads Supabase's refused link as failed, by any of the keys auth-js reads", () => {
    expect(
      linkFragment(
        '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
      ),
    ).toBe('failed');
    expect(linkFragment('#error=access_denied')).toBe('failed');
    expect(linkFragment('#error_code=otp_expired')).toBe('failed');
    expect(linkFragment('#error_description=Token+has+expired')).toBe('failed');
    // Without the leading '#', as a raw fragment string.
    expect(linkFragment('error_code=otp_expired')).toBe('failed');
  });

  it('reads a session in the fragment as session (the link worked)', () => {
    expect(
      linkFragment(
        '#access_token=h.p.s&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery',
      ),
    ).toBe('session');
    expect(linkFragment('#access_token=h.p.s&type=invite')).toBe('session');
  });

  it('puts an error before a session, as auth-js does', () => {
    expect(linkFragment('#access_token=h.p.s&error=server_error')).toBe('failed');
  });
});

describe('signInNotice', () => {
  it('says the link failed for ?error=auth_callback_failed', () => {
    expect(signInNotice(query('error=auth_callback_failed'), 'none')).toBe(LINK_FAILED_NOTICE);
  });

  it('says the link failed when the fragment does, whatever the query holds', () => {
    expect(signInNotice(query(''), 'failed')).toBe(LINK_FAILED_NOTICE);
    expect(signInNotice(query('redirect=%2Fdashboard'), 'failed')).toBe(LINK_FAILED_NOTICE);
    expect(signInNotice(query('reason=session_ended'), 'failed')).toBe(LINK_FAILED_NOTICE);
  });

  it('does not call the link failed when its session is in the fragment', () => {
    expect(signInNotice(query('error=auth_callback_failed'), 'session')).toBeNull();
  });

  it('keeps the session-ended note, under a failed link', () => {
    expect(signInNotice(query('reason=session_ended'), 'none')).toBe(SESSION_ENDED_NOTICE);
    expect(signInNotice(query('reason=session_ended'), 'session')).toBe(SESSION_ENDED_NOTICE);
    expect(signInNotice(query('reason=session_ended&error=auth_callback_failed'), 'none')).toBe(
      LINK_FAILED_NOTICE,
    );
  });

  it('says nothing for ?reset=success, on purpose', () => {
    expect(signInNotice(query('reset=success'), 'none')).toBeNull();
  });

  it('says nothing for a value it does not know, and never echoes one', () => {
    for (const qs of [
      '',
      'redirect=%2Fdashboard',
      'error=Your+account+is+locked',
      'error=AUTH_CALLBACK_FAILED',
      'error=auth_callback_failed%20',
      'reason=session_ended_everywhere',
      'reset=failed',
      'message=hello',
    ]) {
      expect(signInNotice(query(qs), 'none'), qs).toBeNull();
    }
  });

  it("never reads an object's inherited members as a value", () => {
    for (const name of INHERITED) {
      for (const key of ['error', 'reason', 'reset']) {
        expect(signInNotice(query(`${key}=${name}`), 'none'), `${key}=${name}`).toBeNull();
      }
    }
  });

  it('reads the first of a repeated parameter, as URLSearchParams does', () => {
    expect(signInNotice(query('error=auth_callback_failed&error=other'), 'none')).toBe(
      LINK_FAILED_NOTICE,
    );
    expect(signInNotice(query('error=other&error=auth_callback_failed'), 'none')).toBeNull();
  });
});

describe('resetNotice', () => {
  it('says the reset link expired for ?error=link_expired', () => {
    expect(resetNotice('link_expired')).toBe(RESET_LINK_EXPIRED_NOTICE);
  });

  it('says nothing for no value or one it does not know', () => {
    for (const value of [
      undefined,
      null,
      '',
      'auth_callback_failed',
      'Call this number',
      'LINK_EXPIRED',
    ]) {
      expect(resetNotice(value), String(value)).toBeNull();
    }
  });

  it("never reads an object's inherited members as a value", () => {
    for (const name of INHERITED) expect(resetNotice(name), name).toBeNull();
  });

  it('reads the first of a repeated parameter', () => {
    expect(resetNotice(['link_expired', 'other'])).toBe(RESET_LINK_EXPIRED_NOTICE);
    expect(resetNotice(['other', 'link_expired'])).toBeNull();
    expect(resetNotice([])).toBeNull();
  });
});

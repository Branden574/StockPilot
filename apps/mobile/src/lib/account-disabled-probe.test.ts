import { describe, expect, it } from 'vitest';

import { classifyAuthProbe, shouldProbeAfterFailure } from './account-disabled-probe';

/**
 * The server answers a disabled caller with the SAME uniform 401 an anonymous
 * caller gets — deliberately, so an API probe teaches an attacker nothing. The
 * client therefore has to ask GoTrue directly, and only a structured
 * `user_banned` counts. A network blip must never lock a working account out of
 * its own app.
 */

describe('shouldProbeAfterFailure', () => {
  it('probes on 401', () => {
    expect(shouldProbeAfterFailure({ status: 401 })).toBe(true);
  });

  it('does NOT probe on 403 — that is a permission answer, not an identity one', () => {
    expect(shouldProbeAfterFailure({ status: 403 })).toBe(false);
  });

  it('does not probe on 404, 500 or a plain network error', () => {
    expect(shouldProbeAfterFailure({ status: 404 })).toBe(false);
    expect(shouldProbeAfterFailure({ status: 500 })).toBe(false);
    expect(shouldProbeAfterFailure(null)).toBe(false);
    expect(shouldProbeAfterFailure(new Error('Network request failed'))).toBe(false);
  });
});

describe('classifyAuthProbe', () => {
  it('reports disabled for the structured user_banned code', () => {
    expect(classifyAuthProbe({ data: { user: null }, error: { code: 'user_banned' } })).toBe('disabled');
  });

  it('reports active when the user still resolves', () => {
    expect(classifyAuthProbe({ data: { user: { id: 'u1' } }, error: null })).toBe('active');
  });

  it('reports unknown for any other failure — never lock someone out on a blip', () => {
    expect(classifyAuthProbe({ data: { user: null }, error: { message: 'Network request failed' } })).toBe('unknown');
    expect(classifyAuthProbe(null)).toBe('unknown');
  });

  /**
   * The fourth answer, and the one the first cut of this module did not have.
   *
   * A platform disable REVOKES the user's sessions, so by the time a device
   * probes, its own session row is gone and GoTrue answers `session_not_found`
   * (403) — or, once the access token expires and gotrue-js tries to refresh,
   * `refresh_token_not_found` (400), because auth.refresh_tokens cascades on
   * the session delete. Neither is `user_banned`, and neither ever will be:
   * a revoked client cannot read its own account status.
   *
   * Folding these into 'unknown' was the defect. 'unknown' means "change
   * nothing", so the app kept its dead session and drifted to the marketing
   * screen. They are not inconclusive at all — they are a definite answer to a
   * different question: YOUR SESSION IS GONE. That justifies a local sign-out
   * and the sign-in screen, and nothing more: the device still cannot tell a
   * disable from an ordinary sign-out-everywhere, and must not pretend it can.
   */
  it('reports signed-out when the session itself is gone', () => {
    expect(classifyAuthProbe({ data: { user: null }, error: { status: 403, code: 'session_not_found' } })).toBe(
      'signed-out',
    );
    expect(classifyAuthProbe({ data: { user: null }, error: { status: 400, code: 'refresh_token_not_found' } })).toBe(
      'signed-out',
    );
    expect(classifyAuthProbe({ data: { user: null }, error: { code: 'session_expired' } })).toBe('signed-out');
  });

  it('does NOT infer signed-out from free text either', () => {
    expect(classifyAuthProbe({ data: { user: null }, error: { message: 'session_not_found' } })).toBe('unknown');
  });

  it('still prefers a confirmed ban over a dead session', () => {
    // Belt and braces: if GoTrue ever answers a revoked-AND-banned user with
    // the ban, that is the better answer and it must win.
    expect(
      classifyAuthProbe({ data: { user: null }, error: { status: 403, code: 'user_banned' } }),
    ).toBe('disabled');
  });

  it('prefers a live user over a session-gone code', () => {
    expect(
      classifyAuthProbe({ data: { user: { id: 'u1' } }, error: { code: 'session_not_found' } }),
    ).toBe('active');
  });

  it('never infers a ban from free text', () => {
    expect(classifyAuthProbe({ data: { user: null }, error: { message: 'user_banned' } })).toBe('unknown');
  });

  /**
   * The web guard's third state (AccountStatusUnavailableError) mirrored here:
   * a status the server could not answer is UNREADABLE, not disabled. It must
   * deny, and it must be worded as transient — never as the disabled copy.
   */
  it('reports unavailable when the identity server itself failed', () => {
    expect(classifyAuthProbe({ data: { user: null }, error: { status: 500 } })).toBe('unavailable');
    expect(classifyAuthProbe({ data: { user: null }, error: { status: 503, code: 'unexpected_failure' } })).toBe(
      'unavailable',
    );
  });

  it('still prefers a confirmed ban over a server status', () => {
    expect(classifyAuthProbe({ data: { user: null }, error: { status: 503, code: 'user_banned' } })).toBe('disabled');
  });

  it('does not call a 4xx unavailable — those are answers, not outages', () => {
    expect(classifyAuthProbe({ data: { user: null }, error: { status: 403 } })).toBe('unknown');
  });
});

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
    expect(classifyAuthProbe({ data: { user: null }, error: { code: 'session_not_found' } })).toBe('unknown');
    expect(classifyAuthProbe({ data: { user: null }, error: { message: 'Network request failed' } })).toBe('unknown');
    expect(classifyAuthProbe(null)).toBe('unknown');
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

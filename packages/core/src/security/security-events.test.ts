import { describe, expect, it } from 'vitest';

import {
  SECURITY_BOT_FAMILIES,
  SECURITY_EVENT_CATEGORIES,
  SECURITY_EVENT_OUTCOMES,
  SECURITY_EVENT_REASON_LABELS,
  SECURITY_EVENT_REASON_RE,
  SECURITY_EVENT_SOURCES,
  SECURITY_EVENT_UNKNOWN_REASON_LABEL,
  SECURITY_PROBE_KINDS,
  securityBotReason,
  securityEventCategoryLabel,
  securityEventOutcomeLabel,
  securityEventPlaceLabel,
  securityEventReasonLabel,
  securityEventSourceLabel,
} from './security-events';

/**
 * The words of the shared security-events record. The lists are written out
 * here, not imported: they are the database's own checks
 * (record_security_events and the table's constraints), and a change to
 * either side must be a visible change to this test.
 */
describe('security events: the lists the database checks', () => {
  it('categories, outcomes and sources are the database lists, in order', () => {
    expect(SECURITY_EVENT_CATEGORIES).toEqual([
      'password_guessing',
      'exploit',
      'bots',
      'phishing',
      'malware',
    ]);
    expect(SECURITY_EVENT_OUTCOMES).toEqual(['blocked', 'allowed', 'flagged']);
    expect(SECURITY_EVENT_SOURCES).toEqual(['web', 'phone', 'api', 'email', 'edge']);
  });

  it('the reason check is the database pattern', () => {
    expect(SECURITY_EVENT_REASON_RE.source).toBe('^[a-z][a-z0-9_]{0,47}$');
  });

  it('every reason this build writes passes the database check and has words', () => {
    const written = [
      'wrong_password',
      'repeated_wrong_password',
      'sign_in_paused',
      'auth_server_paused',
      'wrong_code',
      'repeated_wrong_code',
      'code_checks_paused',
      'wrong_recovery_code',
      'recovery_code_checks_paused',
      'unknown_api_key',
      'sign_in_new_country',
      'sign_in_not_me',
      'sign_in_alerts_held',
      'over_minute_cap',
      'over_buffer_cap',
      ...SECURITY_PROBE_KINDS,
      ...SECURITY_BOT_FAMILIES.map(securityBotReason),
    ];
    expect(Object.keys(SECURITY_EVENT_REASON_LABELS).sort()).toEqual([...written].sort());
    for (const reason of written) {
      expect(reason, reason).toMatch(SECURITY_EVENT_REASON_RE);
      const label = securityEventReasonLabel(reason);
      expect(label, reason).not.toBe(SECURITY_EVENT_UNKNOWN_REASON_LABEL);
      expect(label.length, reason).toBeGreaterThan(5);
    }
  });

  it('the two overflow rows read the same', () => {
    expect(securityEventReasonLabel('over_minute_cap')).toBe('More events than could be listed');
    expect(securityEventReasonLabel('over_buffer_cap')).toBe('More events than could be listed');
  });

  it('names the plain words of the two code-check pauses', () => {
    expect(securityEventReasonLabel('code_checks_paused')).toBe(
      'Authenticator code checks paused after too many attempts',
    );
    expect(securityEventReasonLabel('recovery_code_checks_paused')).toBe(
      'Recovery code checks paused after too many attempts',
    );
  });

  it('names the plain words of the sign-in reasons', () => {
    expect(securityEventReasonLabel('wrong_password')).toBe('Wrong password at sign-in');
    expect(securityEventReasonLabel('repeated_wrong_password')).toBe(
      'Repeated wrong passwords from one source',
    );
  });

  it('names the plain words of the two sign-in alert reasons (part 3)', () => {
    expect(securityEventReasonLabel('sign_in_new_country')).toBe('Sign-in from a new country');
    expect(securityEventReasonLabel('sign_in_not_me')).toBe(
      'A member said a sign-in was not them',
    );
  });

  it('names the plain words of sign-in alerts held past the daily ceiling', () => {
    expect(securityEventReasonLabel('sign_in_alerts_held')).toBe(
      'Sign-in alerts held after too many in one day',
    );
  });

  it('the sign-in alert link is an anonymous family of its own, with its own words', () => {
    expect(SECURITY_BOT_FAMILIES).toContain('sign_in_alert');
    expect(securityEventReasonLabel(securityBotReason('sign_in_alert'))).toBe(
      'Too many requests to a sign-in alert link',
    );
  });
});

describe('security events: a value this build does not know still renders', () => {
  it.each([
    ['a later reason', 'impossible_travel'],
    ['an empty string', ''],
    ['a prototype key', 'constructor'],
    ['a prototype key', '__proto__'],
    ['not a string', 42],
    ['null', null],
    ['undefined', undefined],
  ])('reason: %s', (_what, value) => {
    expect(securityEventReasonLabel(value)).toBe(SECURITY_EVENT_UNKNOWN_REASON_LABEL);
  });

  it('category, outcome and source fall back to Other', () => {
    for (const value of ['ransomware', 'toString', '', null, 7]) {
      expect(securityEventCategoryLabel(value)).toBe('Other');
      expect(securityEventOutcomeLabel(value)).toBe('Other');
      expect(securityEventSourceLabel(value)).toBe('Other');
    }
    expect(securityEventCategoryLabel('bots')).toBe('Automated traffic');
    expect(securityEventOutcomeLabel('blocked')).toBe('Blocked');
    expect(securityEventSourceLabel('api')).toBe('API');
  });
});

describe('security events: the place', () => {
  it.each([
    ['NL', 'Utrecht', 'Utrecht, NL'],
    ['NL', null, 'NL'],
    ['NL', '   ', 'NL'],
    [null, null, 'Unknown place'],
    [null, 'Utrecht', 'Utrecht'],
    ['nl', null, 'Unknown place'],
    ['NLD', 'Utrecht', 'Utrecht'],
  ])('%s / %s -> %s', (country, city, expected) => {
    expect(securityEventPlaceLabel(country, city)).toBe(expected);
  });
});

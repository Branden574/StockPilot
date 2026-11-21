import { describe, expect, it } from 'vitest';

import {
  NOT_ME_WORDS,
  REPORTED_MEMBER_NAME_MAX,
  countryName,
  reportedMemberName,
  signInAlertAnswerWords,
  signInAlertBadges,
  signInAlertKindWords,
  signInAlertPlaceWords,
} from './sign-in-alert-words';

/**
 * The words every page and email of a sign-in alert uses (part 3): the
 * country's English name (Intl.DisplayNames), the place, what kind of alert
 * it was, and the member's answer. One source, so the email, Active sessions
 * and the admin list say the same thing.
 */

describe('countryName', () => {
  it('names a country in English', () => {
    expect(countryName('MX')).toBe('Mexico');
    expect(countryName('US')).toBe('United States');
    expect(countryName('BR')).toBe('Brazil');
  });

  it('a value that is not two capital letters is no country', () => {
    for (const value of ['mx', 'MEX', '', null, undefined, 42]) {
      expect(countryName(value as unknown as string)).toBeNull();
    }
  });

  it('a code with no English name stays as its two letters', () => {
    expect(countryName('QM')).toBe('QM');
  });
});

describe('signInAlertPlaceWords', () => {
  it('city and country, the country alone, or nothing', () => {
    expect(signInAlertPlaceWords('MX', 'Tijuana')).toBe('Tijuana, Mexico');
    expect(signInAlertPlaceWords('MX', null)).toBe('Mexico');
    expect(signInAlertPlaceWords('MX', '   ')).toBe('Mexico');
    expect(signInAlertPlaceWords(null, null)).toBeNull();
  });

  it('a city with no country is not shown alone', () => {
    expect(signInAlertPlaceWords(null, 'Tijuana')).toBeNull();
  });
});

describe('signInAlertKindWords and signInAlertBadges', () => {
  it('says which it was', () => {
    expect(signInAlertKindWords({ newDevice: true, newCountry: false })).toBe('New device');
    expect(signInAlertKindWords({ newDevice: false, newCountry: true })).toBe('New country');
    expect(signInAlertKindWords({ newDevice: true, newCountry: true })).toBe(
      'New device and new country',
    );
  });

  it('the badges name the country', () => {
    expect(signInAlertBadges({ newDevice: true, newCountry: false, country: 'MX' })).toEqual([
      'New device',
    ]);
    expect(signInAlertBadges({ newDevice: false, newCountry: true, country: 'MX' })).toEqual([
      'New country: Mexico',
    ]);
    expect(signInAlertBadges({ newDevice: true, newCountry: true, country: 'MX' })).toEqual([
      'New device',
      'New country: Mexico',
    ]);
    expect(signInAlertBadges({ newDevice: false, newCountry: true, country: null })).toEqual([
      'New country',
    ]);
  });
});

describe('signInAlertAnswerWords', () => {
  it('the three answers, and a neutral word for anything else', () => {
    expect(signInAlertAnswerWords('open')).toBe('No answer yet');
    expect(signInAlertAnswerWords('was_me')).toBe('Member confirmed');
    expect(signInAlertAnswerWords('not_me')).toBe('Reported: not them');
    expect(signInAlertAnswerWords('later')).toBe('Unknown');
    expect(signInAlertAnswerWords(null)).toBe('Unknown');
  });
});

describe('reportedMemberName: a member-chosen name, made safe for the body of a notice or an email', () => {
  it('an ordinary name is kept as it is', () => {
    expect(reportedMemberName('Avery Example')).toBe('Avery Example');
    expect(reportedMemberName('  María-José   O’Neil ')).toBe('María-José O’Neil');
  });

  it('is cut to 80 characters', () => {
    expect(REPORTED_MEMBER_NAME_MAX).toBe(80);
    expect(reportedMemberName('x'.repeat(200))).toBe('x'.repeat(80));
    // Counted in characters, not in halves of one.
    expect([...reportedMemberName('𝒳'.repeat(200))!]).toHaveLength(80);
  });

  it('loses control characters; a line break or a tab becomes one space', () => {
    expect(reportedMemberName('Robin\nSample')).toBe('Robin Sample');
    expect(reportedMemberName('Robin\r\n\tSample')).toBe('Robin Sample');
    expect(reportedMemberName('Ro\u0000bin\u0007 \u001BSample\u007F\u0085')).toBe('Robin Sample');
  });

  it('loses invisible characters: zero-width, direction marks and overrides, fillers', () => {
    expect(reportedMemberName('Ro\u200Bbin\u200D \u200E\u202ESample\u2066\u2069\uFEFF\u00AD')).toBe('Robin Sample');
    expect(reportedMemberName('Robin\u3164\u115F\u1160\uFFA0\u2800Sample')).toBe('RobinSample');
    expect(reportedMemberName('Robin\u2028Sample\u2029')).toBe('Robin Sample');
  });

  it('nothing left, or not a string: null', () => {
    for (const nothing of [null, undefined, '', '   ', '\u200B\u202E', '\n\t', 7, {}]) {
      expect(reportedMemberName(nothing as never)).toBeNull();
    }
  });

  it('never throws on half of a character', () => {
    expect(reportedMemberName('Robin\uD83D')).toBe('Robin');
  });
});

describe('the words of a "This was not me" (review 1, finding 1)', () => {
  it('say what happens and no more: the sessions ended, an open device keeps its pass for a short while, the reset closes the door', () => {
    expect(NOT_ME_WORDS.sessionsEnded).toBe('Every session of your account has been ended.');
    expect(NOT_ME_WORDS.openDevice).toBe(
      'A device that is already open can keep working for a short while (until its current pass expires).',
    );
    expect(NOT_ME_WORDS.resetNow).toBe(
      'Reset your password now. That is what closes the door: until you do, anyone who knows it can sign in again.',
    );
    for (const words of Object.values(NOT_ME_WORDS)) {
      expect(words).not.toMatch(/signed out (on|of) every|everywhere|right away|at once|immediately/i);
      // How long a pass lives is a setting of the live project, which the code
      // does not know: no sentence names a length (review 2, finding 5).
      expect(words).not.toMatch(/hour|minute/i);
      // Plain text that needs no escaping in a page or an email.
      expect(words).not.toMatch(/[<>&"'’]/);
    }
  });
});

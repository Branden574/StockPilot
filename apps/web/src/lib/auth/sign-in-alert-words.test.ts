import { describe, expect, it } from 'vitest';

import {
  countryName,
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

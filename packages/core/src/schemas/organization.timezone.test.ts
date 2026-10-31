import { describe, expect, it } from 'vitest';

import {
  createOrganizationSchema,
  isStorableOrgTimezone,
  ORG_TIMEZONE_INVALID_MESSAGE,
  storableOrgTimezoneSchema,
} from './organization';

/**
 * AN ORGANIZATION'S ZONE IS CHECKED WHERE A NEW ORGANIZATION IS CREATED (B41).
 *
 * The create schemas accepted any 1 to 64 characters, and the onboarding form
 * offers a free-text box defaulting to the creator's browser zone, so zones
 * outside Settings' list of 20, and strings that are no zone at all, could be
 * stored. The web and the phone read the stored zone through
 * resolveOrgTimezone (any zone this runtime's Intl accepts); the Book Order
 * Totals report's SQL tries only UTC, GMT or an Area/Location name and falls
 * back to Pacific otherwise (0379, 0382). A zone is storable when both use it.
 */

/** Settings > Organization's list (apps/web/src/lib/timezone-options.ts),
 *  restated: core cannot import the web app. */
const SETTINGS_LIST = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Manila',
  'Australia/Sydney',
];

describe('isStorableOrgTimezone', () => {
  it('accepts the settings list, UTC, GMT and a valid zone outside the list', () => {
    for (const zone of [
      ...SETTINGS_LIST,
      'GMT',
      'America/Indiana/Indianapolis',
      'America/Argentina/Buenos_Aires',
      'Etc/GMT+5',
    ]) {
      expect(isStorableOrgTimezone(zone), zone).toBe(true);
    }
  });

  it('refuses what the app or the report would not use', () => {
    for (const zone of [
      '',
      '   ',
      // Intl accepts these, but the report's SQL does not try them, so the
      // report would use Pacific while the app used the zone.
      'PST',
      'EST',
      'EST5EDT',
      'Zulu',
      // A POSIX offset: no Intl zone, and Postgres reads its sign inverted.
      'UTC+5',
      // The right shape, but no zone Intl knows.
      'Mars/Olympus',
      // Case matters to the report's UTC/GMT test.
      'utc',
      `America/${'A'.repeat(57)}`,
    ]) {
      expect(isStorableOrgTimezone(zone), JSON.stringify(zone)).toBe(false);
    }
  });

  it('reads the zone as the app does: surrounding spaces are not part of it', () => {
    expect(isStorableOrgTimezone('  America/Chicago ')).toBe(true);
  });
});

describe('createOrganizationSchema timezone', () => {
  const base = { name: 'Example Workspace' };

  // Every refusal, a blank box and an overlong one included, says the same
  // plain sentence first: the form shows the field's first message.
  it('refuses an unusable zone with the plain message', () => {
    for (const timezone of ['PST', 'Mars/Olympus', 'UTC+5', '   ', 'x'.repeat(65)]) {
      const parsed = createOrganizationSchema.safeParse({ ...base, timezone });
      expect(parsed.success, timezone).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message, timezone).toBe(ORG_TIMEZONE_INVALID_MESSAGE);
        expect(parsed.error.issues[0]?.path, timezone).toEqual(['timezone']);
      }
    }
    expect(ORG_TIMEZONE_INVALID_MESSAGE).toBe(
      'Enter a time zone name such as America/Chicago or UTC.',
    );
  });

  it('defaults to UTC', () => {
    const parsed = createOrganizationSchema.parse(base);
    expect(parsed.timezone).toBe('UTC');
  });

  it('keeps a valid zone outside the settings list as given, trimmed', () => {
    expect(
      createOrganizationSchema.parse({ ...base, timezone: ' America/Indiana/Indianapolis ' })
        .timezone,
    ).toBe('America/Indiana/Indianapolis');
  });

  // Postgres and Intl match zone names whatever their case, but the Settings
  // editor finds a listed zone by exact name. Only the letters' case is
  // changed, never one name for another (this runtime's Intl answers
  // America/Indianapolis for America/Indiana/Indianapolis and Asia/Calcutta
  // for Asia/Kolkata).
  it('stores a zone typed in another case under its own name, and never swaps one zone name for another', () => {
    expect(createOrganizationSchema.parse({ ...base, timezone: 'america/chicago' }).timezone).toBe(
      'America/Chicago',
    );
    expect(createOrganizationSchema.parse({ ...base, timezone: 'utc' }).timezone).toBe('UTC');
    for (const zone of ['GMT', 'America/Indiana/Indianapolis', 'Asia/Kolkata', 'Etc/GMT+5']) {
      expect(createOrganizationSchema.parse({ ...base, timezone: zone }).timezone, zone).toBe(zone);
    }
  });
});

describe('storableOrgTimezoneSchema (the platform console uses it with its own default)', () => {
  it('defaults to the zone it is given and applies the same check', () => {
    const schema = storableOrgTimezoneSchema('America/Los_Angeles');
    expect(schema.parse(undefined)).toBe('America/Los_Angeles');
    expect(schema.parse('Europe/Berlin')).toBe('Europe/Berlin');
    const refused = schema.safeParse('EST5EDT');
    expect(refused.success).toBe(false);
    if (!refused.success)
      expect(refused.error.issues[0]?.message).toBe(ORG_TIMEZONE_INVALID_MESSAGE);
  });
});

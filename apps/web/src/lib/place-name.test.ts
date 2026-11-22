import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CITY_CHECK_PATTERNS, CITY_MAX_CHARACTERS, cityForRecord } from './place-name';

/**
 * The city a sign-in alert stores (public.sign_in_alerts.city, migration
 * sign_in_alerts) and a security event stores (public.security_events.city,
 * migration security_events) must pass the same check, written in both
 * migrations in the same words: 1 to 80 characters and five patterns it must
 * not match. The part 1 helper (lib/client-ip.ts cityOf) lets through names
 * the table refuses, such as one with parentheses or a slash, and a refused
 * city would cost the whole alert row. So the app empties such a city first,
 * with ONE function that holds the table's own five patterns.
 *
 * The pattern texts below are copied from the migration. When the migration
 * is in this tree, the test also reads it and compares the text itself.
 */

/** The five patterns of sign_in_alerts_city and security_events_city, as the migration writes them. */
const MIGRATION_PATTERNS = [
  '[[:cntrl:]]',
  '[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]',
  '[@/\\\\:;<>(){}\\[\\]=?&%#"|$*+^~`]',
  '[0-9].*[0-9].*[0-9].*[0-9]',
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-',
];

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../supabase/migrations');

/** The patterns of one named city check in a migration file: the texts after `city !~`. */
function patternsOf(sql: string, constraint: string): string[] | null {
  const at = sql.indexOf(`constraint ${constraint}`);
  if (at === -1) return null;
  const block = sql.slice(at, sql.indexOf('))', at) + 2);
  const found: string[] = [];
  for (const m of block.matchAll(/city !~ '((?:[^']|'')*)'/g)) found.push(m[1]!.replace(/''/g, "'"));
  return found;
}

function migrationNamed(suffix: string): string | null {
  if (!existsSync(MIGRATIONS_DIR)) return null;
  const file = readdirSync(MIGRATIONS_DIR).find((f) => f.endsWith(suffix));
  return file ? readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') : null;
}

describe('cityForRecord: the table’s own five patterns, in the migration’s words', () => {
  it('holds exactly the five pattern texts of the migration, in order', () => {
    expect(CITY_CHECK_PATTERNS).toEqual(MIGRATION_PATTERNS);
    expect(CITY_MAX_CHARACTERS).toBe(80);
  });

  const alerts = migrationNamed('_sign_in_alerts.sql');
  it.runIf(alerts !== null)('matches the sign_in_alerts_city check of the migration in this tree', () => {
    expect(patternsOf(alerts!, 'sign_in_alerts_city')).toEqual(MIGRATION_PATTERNS);
    expect(alerts).toContain('char_length(city) between 1 and 80');
  });

  const events = migrationNamed('_security_events.sql');
  it.runIf(events !== null)('matches the security_events_city check of the migration in this tree', () => {
    expect(patternsOf(events!, 'security_events_city')).toEqual(MIGRATION_PATTERNS);
  });
});

describe('cityForRecord: what it keeps and what it empties', () => {
  it.each([
    ['Tijuana', 'Tijuana'],
    ['São Paulo', 'São Paulo'],
    ['Frankfurt am Main', 'Frankfurt am Main'],
    ["Val-d'Or", "Val-d'Or"],
    ['St. John’s', 'St. John’s'],
    ['Zürich', 'Zürich'],
    ['  Utrecht  ', 'Utrecht'],
    // Up to three digits is still a place name.
    ['District 9', 'District 9'],
    ['Ward 123', 'Ward 123'],
  ])('keeps %j as %j', (raw, kept) => {
    expect(cityForRecord(raw)).toBe(kept);
  });

  it.each([
    ['parentheses (the helper lets them through)', 'Springfield (East)'],
    ['a slash (the helper lets it through)', 'Sample/Town'],
    ['an at sign', 'someone@example.test'],
    ['a colon', 'http:x'],
    ['markup', '<b>Town</b>'],
    ['a query', 'a=b&c=d'],
    ['a percent sign', '50%'],
    ['four digits', 'Area 1234'],
    ['four digits apart', '1 a 2 b 3 c 4'],
    ['the start of an id', 'deadbeef-cafe-'],
    ['a control character', 'Town\u0007'],
    ['a C1 control character', 'Town\u0085'],
    ['an invisible mark', 'Town\u200B'],
    ['a direction control', 'Town\u202E'],
    // (inside the name: a leading or trailing one is trimmed away, as a space is)
    ['a byte order mark', 'To\uFEFFwn'],
    ['a backslash', 'Town\\x'],
    ['brackets', 'Town[1]'],
    ['a backtick', 'Town`'],
    ['empty', ''],
    ['only spaces', '   '],
    ['81 characters', 'a'.repeat(81)],
  ])('empties a city with %s', (_what, raw) => {
    expect(cityForRecord(raw)).toBeNull();
  });

  it('counts characters as the database does (code points), so 80 accented letters fit', () => {
    expect(cityForRecord('é'.repeat(80))).toBe('é'.repeat(80));
    expect(cityForRecord('😀'.repeat(80))).toBe('😀'.repeat(80));
    expect(cityForRecord('😀'.repeat(81))).toBeNull();
  });

  it('anything that is not a string is no city, and it never throws', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(cityForRecord(value as unknown as string)).toBeNull();
    }
  });
});

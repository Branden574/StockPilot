import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { dockerRefusal, urlRefusal } from '../../tests/e2e/appearance/fixtures/seed-fidelity.mjs';

/**
 * PLAN 8.1 "Same data": the stage 5 fidelity seed is committed to a PUBLIC
 * repository, so it must hold fictional data only. This guard fails on:
 *  - an email whose domain is not example.test or example.com (subdomains
 *    of those included);
 *  - a value shaped like a phone number: with separators, the lab's 555-0131
 *    form, E.164 (+ and 8 to 15 digits), spaced international groups
 *    (+44 20 7946 0958) or a bare 10-digit number (UUIDs and 13-digit ISBNs
 *    are set aside first);
 *  - a value shaped like a payment card (13 to 19 digits, spaces or dashes
 *    allowed, passing the Luhn check);
 *  - a value shaped like a token or key (a JWT, a known key prefix, 32+ hex
 *    characters, a 40+ character base64 run) once the fixed UUIDs are set
 *    aside;
 * and the secret-shaped-fixtures guard covers the same files (its list names
 * them; checked below). The names are invented (the PR reviewer confirms it).
 * The runner's own refusals (any database not on this machine) are proven
 * here too.
 */

const DIR = join(__dirname, '..', '..', 'tests/e2e/appearance/fixtures');
const FILES = ['seed-fidelity.sql', 'seed-fidelity.mjs'];
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/gu;
const ALLOWED_DOMAIN = /(^|\.)example\.(test|com)$/iu;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
/** ISBN-13 (978 / 979, with or without hyphens): set aside before the phone shapes, as UUIDs are. */
const ISBN13 = /\b97[89](?:-?\d){10}\b/gu;
const PHONE = [
  /(?:\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/u,
  /(?<![\d-])\b\d{3}-\d{4}\b(?![\d-])/u,
  // E.164: + and 8 to 15 digits, no separators (+14155550199).
  /(?<![\w+])\+\d{8,15}\b/u,
  // Spaced or dotted international groups: + country code, then 2 to 5 groups (+44 20 7946 0958).
  /(?<![\w+])\+\d{1,3}(?:[\s.-]\d{1,5}){2,5}\b/u,
  // A bare 10-digit number (4155550199), not part of a longer run.
  /(?<![\d-])\b\d{10}\b(?![\d-])/u,
];
const TOKENS = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bre_[A-Za-z0-9]{16,}/u,
  /\b[0-9a-f]{32,}\b/iu,
  // A long base64 run holding letters and digits (a line of dashes is not one).
  /(?=[A-Za-z0-9+/_-]*[A-Za-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{40,}={0,2}/u,
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Every problem in `text` (empty: fictional-only). */
export function fixtureProblems(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EMAIL))
    if (!ALLOWED_DOMAIN.test(m[1]!)) out.push(`email at ${m[1]}: only example.test / example.com`);
  const scrubbed = text.replace(UUID, ' ').replace(ISBN13, ' ');
  for (const re of PHONE) {
    const m = re.exec(scrubbed);
    if (m) out.push(`phone-shaped value ${m[0]}`);
  }
  for (const m of scrubbed.matchAll(/\b\d(?:[ -]?\d){12,18}\b/gu)) {
    const digits = m[0].replace(/\D/gu, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits))
      out.push(`card-shaped value ${m[0]}`);
  }
  for (const re of TOKENS) {
    const m = re.exec(scrubbed);
    if (m) out.push(`token-shaped value ${m[0].slice(0, 12)}...`);
  }
  return out;
}

describe('the fidelity seed is fictional only', () => {
  it.each(FILES)('%s holds no real-looking email, phone, card or token', (file) => {
    expect(fixtureProblems(read(file))).toEqual([]);
  });

  it('FAILS on each kind of real-looking value (the guard is not blind)', () => {
    // The shapes are built at run time, so this file holds none of them (scanners read it too).
    expect(fixtureProblems(`'someone@${'gmail'}.com'`)).toHaveLength(1);
    expect(fixtureProblems("'office@lantern-hollow.example.test'")).toEqual([]);
    expect(fixtureProblems(`'(415) ${'555'}-0199'`)).not.toEqual([]);
    expect(fixtureProblems(`'${'555'}-0131'`)).not.toEqual([]);
    // E.164, a bare 10-digit number and spaced international groups (stage 5 review, minor 9).
    expect(fixtureProblems(`'+1415${'555'}0199'`)).not.toEqual([]);
    expect(fixtureProblems(`'415${'555'}0199'`)).not.toEqual([]);
    expect(fixtureProblems(`'+44 20 ${'7946'} 0958'`)).not.toEqual([]);
    expect(fixtureProblems(`'+33 1 ${'23'} 45 67 89'`)).not.toEqual([]);
    // Not phones: an ISBN-13 (with or without hyphens), a UUID, a price, a quantity, a year range.
    expect(fixtureProblems("'979-8-9000-0141-8'")).toEqual([]);
    expect(fixtureProblems("'61.25', 104, '2025-2026'")).toEqual([]);
    expect(fixtureProblems(`'${['4111', '1111', '1111', '1111'].join(' ')}'`)).not.toEqual([]);
    expect(fixtureProblems("'9798900001418'")).toEqual([]); // an invented ISBN: not Luhn-valid
    expect(
      fixtureProblems(`'${['eyJ' + 'hbGciOiJub25lIn0', 'eyJ' + 'zdWIiOiJ4In0', 'x'].join('.')}'`),
    ).not.toEqual([]);
    expect(fixtureProblems(`'${'0123456789abcdef'.repeat(2)}'`)).not.toEqual([]);
    expect(fixtureProblems("'5eed0000-f1d0-4000-8000-000000000001'")).toEqual([]);
  });

  it('the secret-shaped-fixtures guard lists the seed files too', () => {
    const guard = readFileSync(join(__dirname, 'secret-shaped-fixtures.guard.test.ts'), 'utf8');
    for (const f of FILES) expect(guard).toContain(`tests/e2e/appearance/fixtures/${f}`);
  });

  it('the seed writes in one guarded transaction and checks itself', () => {
    const sql = read('seed-fidelity.sql');
    expect(sql).toMatch(/rlab_seed\.meta/u);
    expect(sql).toMatch(/FIDELITY SEED OK/u);
    expect(sql).not.toMatch(/\b(drop|truncate|delete from|alter table)\b/iu);
  });
});

describe('the seed runner refuses any database not on this machine', () => {
  it('accepts a local URL', () => {
    expect(urlRefusal('postgresql://postgres@127.0.0.1:55422/postgres')).toBeNull();
    expect(urlRefusal('postgres://u@localhost:55422/db')).toBeNull();
  });
  it('REFUSES a remote host, a look-alike, another scheme or no URL', () => {
    expect(urlRefusal('postgresql://u@db.example.supabase.co:5432/postgres')).toMatch(/not 127/u);
    expect(urlRefusal('postgresql://u@127.0.0.1.example.test:5432/postgres')).toMatch(/not 127/u);
    expect(urlRefusal('mysql://u@127.0.0.1/db')).toMatch(/not a postgres/u);
    expect(urlRefusal(undefined)).toMatch(/no database/u);
  });
  it('accepts the local engine publishing on this machine at the given port', () => {
    expect(
      dockerRefusal({
        dockerHost: undefined,
        portLines: '0.0.0.0:55422\n[::]:55422\n',
        port: '55422',
      }),
    ).toBeNull();
    expect(
      dockerRefusal({
        dockerHost: 'unix:///var/run/docker.sock',
        portLines: '127.0.0.1:55422',
        port: '55422',
      }),
    ).toBeNull();
  });
  it('REFUSES a remote engine, another bind address or another port', () => {
    expect(
      dockerRefusal({
        dockerHost: 'tcp://10.0.0.9:2376',
        portLines: '127.0.0.1:55422',
        port: '55422',
      }),
    ).toMatch(/local engine/u);
    expect(
      dockerRefusal({ dockerHost: undefined, portLines: '10.0.0.9:55422', port: '55422' }),
    ).toMatch(/not on this machine/u);
    expect(
      dockerRefusal({ dockerHost: undefined, portLines: '127.0.0.1:5432', port: '55422' }),
    ).toMatch(/port 5432/u);
    expect(dockerRefusal({ dockerHost: undefined, portLines: '', port: '55422' })).toMatch(
      /no 5432/u,
    );
  });
});

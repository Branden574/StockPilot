import { describe, expect, it } from 'vitest';

import {
  SAMPLE_AT_MS_PAST_HOURS,
  SAMPLE_BARE_VALUE_MAX,
  SAMPLE_BATCH_MAX,
  SAMPLE_COUNT_MAX,
  SAMPLE_CUT_MARK,
  SAMPLE_HOUR_CAP,
  SAMPLE_INPUT_MAX,
  SAMPLE_KIND_CAP_PER_HOUR,
  SAMPLE_MARKERS,
  SAMPLE_METHODS,
  SAMPLE_OVERFLOW_TARGET,
  SAMPLE_PURGE_BATCH,
  SAMPLE_QUERY_MAX,
  SAMPLE_READ_DEFAULT_HOURS,
  SAMPLE_READ_DEFAULT_LIMIT,
  SAMPLE_READ_MAX_HOURS,
  SAMPLE_READ_MAX_LIMIT,
  SAMPLE_READ_PAIRS_PER_TARGET,
  SAMPLE_READ_ROW_CEILING,
  SAMPLE_RETENTION_DAYS,
  SAMPLE_SECRET_KEY_NAMES,
  SAMPLE_SECRET_KEY_PARTS,
  SAMPLE_TARGET_MAX,
  SAMPLE_TOKEN_RUN_MIN,
  SAMPLE_UNREADABLE_TARGET,
  SCRUB_RULES,
  isSampleMethod,
  isSecretQueryKey,
  isStorableSample,
  isStorableTarget,
  looksLikeToken,
  scrubRequestSample,
  scrubRequestTarget,
} from './request-scrub';

/**
 * Security invariant: the scrubber of "what was asked for" (security tools
 * part 5, stage 3; migration 0479). Whatever a scanner sends, what is kept is
 * printable ASCII, cut to length, passes the table's own text rules (so the
 * writer never skips it), and holds no email address, id, long number,
 * network address, long value, token or secret-named value of the input, in
 * plain or encoded form.
 *
 * Every value here is made up. The secret-looking values the generated tests
 * use are built from a seeded sequence at run time, so none is written out in
 * this file.
 */

// ── A seeded sequence, so every run is the same ─────────────────────────────

function sequence(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(list: readonly T[]): T => list[int(0, list.length - 1)]!;
  const text = (alphabet: string, n: number) =>
    Array.from({ length: n }, () => alphabet[int(0, alphabet.length - 1)]).join('');
  return { next, int, pick, text };
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGITS = '0123456789';
const HEX = '0123456789abcdef';
const BASE64 = `${UPPER}${LOWER}${DIGITS}+`;
const BASE64URL = `${UPPER}${LOWER}${DIGITS}-_`;

/** Every character written as an escape. */
const encodeAll = (s: string) =>
  [...new TextEncoder().encode(s)]
    .map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('');

/** Undoes escapes as often as they change, for a check of what a kept text still says. */
function decodedForm(s: string): string {
  let out = s;
  for (let i = 0; i < 6; i++) {
    let next: string;
    try {
      next = decodeURIComponent(out);
    } catch {
      return out;
    }
    if (next === out) return out;
    out = next;
  }
  return out;
}

/** A secret-looking value: as it reads, and as it is written into the request. */
type Planted = { value: string; written: string; kind: string };

function plantedValues(seq: ReturnType<typeof sequence>): Planted {
  const kind = seq.pick([
    'email',
    'email_plus',
    'email_encoded_at',
    'email_double_encoded_at',
    'email_triple_encoded_at',
    'email_all_encoded',
    'id',
    'id_upper',
    'id_encoded',
    'id_without_dashes',
    'digits',
    'digits_encoded',
    'ipv4',
    'ipv4_encoded',
    'base64',
    'hex',
    'jwt',
    'dotted_token',
    'short_token',
  ] as const);
  const word = () => seq.text(LOWER, seq.int(3, 9));
  switch (kind) {
    case 'email':
      return { kind, value: `${word()}@${word()}.example`, written: '' };
    case 'email_plus':
      return { kind, value: `${word()}+${word()}@${word()}.example`, written: '' };
    case 'email_encoded_at':
    case 'email_double_encoded_at':
    case 'email_triple_encoded_at': {
      const local = word();
      const domain = `${word()}.example`;
      const at = {
        email_encoded_at: '%40',
        email_double_encoded_at: '%2540',
        email_triple_encoded_at: '%252540',
      }[kind];
      return { kind, value: `${local}@${domain}`, written: `${local}${at}${domain}` };
    }
    case 'email_all_encoded': {
      const value = `${word()}@${word()}.example`;
      return { kind, value, written: encodeAll(value) };
    }
    case 'id':
    case 'id_upper':
    case 'id_encoded': {
      const g = (n: number) => seq.text(HEX, n);
      const id = `${g(8)}-${g(4)}-${g(4)}-${g(4)}-${g(12)}`;
      const value = kind === 'id_upper' ? id.toUpperCase() : id;
      return { kind, value, written: kind === 'id_encoded' ? encodeAll(value) : '' };
    }
    case 'id_without_dashes':
      return { kind, value: seq.text(HEX, 32), written: '' };
    case 'digits':
      return { kind, value: seq.text(DIGITS, seq.int(6, 20)), written: '' };
    case 'digits_encoded': {
      const value = seq.text(DIGITS, seq.int(6, 12));
      return { kind, value, written: encodeAll(value) };
    }
    case 'ipv4': {
      const value = [seq.int(1, 255), seq.int(0, 255), seq.int(0, 255), seq.int(1, 254)].join('.');
      return { kind, value, written: '' };
    }
    case 'ipv4_encoded': {
      const value = [seq.int(1, 255), seq.int(0, 255), seq.int(0, 255), seq.int(1, 254)].join('.');
      return { kind, value, written: encodeAll(value) };
    }
    case 'base64': {
      const value = `${seq.text(BASE64, seq.int(24, 60))}${seq.pick(['', '=', '=='])}`;
      return { kind, value, written: '' };
    }
    case 'hex':
      return { kind, value: seq.text(HEX, seq.int(33, 64)), written: '' };
    case 'jwt': {
      const part = () => seq.text(BASE64URL, seq.int(20, 48));
      return { kind, value: `eyJ${part()}.${part()}.${part()}`, written: '' };
    }
    case 'dotted_token': {
      const part = () => seq.text(BASE64URL, seq.int(16, 40));
      return { kind, value: `${part()}.${part()}.${part()}`, written: '' };
    }
    case 'short_token':
      // The shape of this app's invite token: 22 characters of base64url.
      return { kind, value: seq.text(BASE64URL, 22), written: '' };
  }
}

/** Characters a scanner might slip in: controls, zero-width, bidi, other non-ASCII; literal or encoded. */
const NOISE = [
  '\u0000',
  '\u0007',
  '\n',
  '\r',
  '\t',
  '\u001b',
  '\u007f',
  '\u0085',
  '\u200b',
  '\u200c',
  '\u200d',
  '\u2060',
  '\ufeff',
  '\u00ad',
  '\u202a',
  '\u202e',
  '\u2066',
  '\u2069',
  '\u061c',
  '\u2028',
  'é',
  '中',
  '\u{1f600}',
  'А',
] as const;

function withNoise(seq: ReturnType<typeof sequence>, s: string): string {
  let out = s;
  const n = seq.int(0, 3);
  for (let i = 0; i < n; i++) {
    const at = seq.int(0, out.length);
    // Never inside an escape: the input stays decodable unless it means not to.
    if (/%[0-9A-Fa-f]?$/.test(out.slice(0, at))) continue;
    const ch = seq.pick(NOISE);
    out = out.slice(0, at) + (seq.next() < 0.5 ? ch : encodeAll(ch)) + out.slice(at);
  }
  return out;
}

const PLAIN_SEGMENTS = [
  'wp-admin',
  'api',
  'backup',
  'old',
  'site',
  'static',
  'cgi-bin',
  'x',
  'phpunit',
];
const PROBE_NAMES = [
  '.env',
  'wp-login.php',
  'index.php',
  '.git/config',
  'etc/passwd',
  'xmlrpc.php',
];
const JOINERS = ['/', '-', '_', '.', '=', ';'];

/** A path with one planted value, some noise, sometimes very long. */
function hostilePath(seq: ReturnType<typeof sequence>): { input: string; planted: Planted } {
  const planted = plantedValues(seq);
  const written = planted.written || planted.value;
  const parts: string[] = [];
  for (let i = seq.int(0, 3); i > 0; i--) parts.push(seq.pick(PLAIN_SEGMENTS));
  const joiner = seq.pick(JOINERS);
  const segment = seq.next() < 0.5 ? written : `${seq.pick(PLAIN_SEGMENTS)}${joiner}${written}`;
  parts.splice(seq.int(0, parts.length), 0, segment);
  if (seq.next() < 0.1) parts.unshift('a'.repeat(seq.int(100, 700)));
  parts.push(seq.pick(PROBE_NAMES));
  return { input: withNoise(seq, `/${parts.join('/')}`), planted };
}

const SECRET_NAMES = [
  'password',
  'passwd',
  'pwd',
  'api_key',
  'apiKey',
  'access_token',
  'auth',
  'session_id',
  'sig',
  'otp',
  'email',
  'username',
  'card_number',
  'jwt',
  'state',
  'nonce',
  'refresh',
  'cookie',
];

function mixedCase(seq: ReturnType<typeof sequence>, s: string): string {
  return [...s].map((c) => (seq.next() < 0.5 ? c.toUpperCase() : c)).join('');
}

/** A query with a planted value: as a secret-named key's value, as a plain value, or with no key. */
function hostileQuery(seq: ReturnType<typeof sequence>): { input: string; planted: Planted } {
  const parts: string[] = [];
  for (let i = seq.int(0, 3); i > 0; i--)
    parts.push(`${seq.pick(['q', 'page', 'lang', 'v', 'x'])}=${seq.text(LOWER, 4)}`);
  let planted: Planted;
  const how = seq.int(0, 2);
  if (how === 0) {
    // A dull value under a secret-shaped key: removed whole, whatever it looks like.
    const name = mixedCase(seq, seq.pick(SECRET_NAMES));
    const nested =
      seq.next() < 0.3
        ? `${seq.pick(['user', 'data', 'form'])}[${seq.pick(['a', 'b'])}][${name}]`
        : name;
    const key = seq.next() < 0.2 ? encodeAll(nested) : nested;
    const value = `v${seq.text(LOWER, 11)}`;
    planted = { kind: 'secret_key', value, written: value };
    // Noise goes around this part, not into it: a letter slipped into a key
    // makes it another key, which is the sender's to choose.
    const noisy = parts.map((part) => withNoise(seq, part));
    noisy.splice(seq.int(0, noisy.length), 0, `${key}=${value}`);
    return { input: noisy.join(seq.pick(['&', '&', ';'])), planted };
  }
  planted = plantedValues(seq);
  const written = planted.written || planted.value;
  parts.splice(
    seq.int(0, parts.length),
    0,
    how === 1 ? `${seq.pick(['q', 'path', 'x'])}=${written}` : written,
  );
  if (seq.next() < 0.1) parts.push(`pad=${'b'.repeat(seq.int(200, 700))}`);
  return { input: withNoise(seq, parts.join(seq.pick(['&', '&', ';']))), planted };
}

const PRINTABLE_ASCII = /^[ -~]*$/;

function expectSafe(out: string, planted: Planted, max: number) {
  expect(PRINTABLE_ASCII.test(out), out).toBe(true);
  expect(out.length).toBeLessThanOrEqual(max);
  expect(out.includes('@'), out).toBe(false);
  for (const form of [out, decodedForm(out)]) {
    expect(
      form.toLowerCase().includes(planted.value.toLowerCase()),
      `${planted.kind} in ${out}`,
    ).toBe(false);
    if (planted.written && planted.written !== planted.value) {
      expect(form.includes(planted.written), `${planted.kind} (as written) in ${out}`).toBe(false);
    }
  }
}

/**
 * A second scrub never shows more than the first did: every run of six or
 * more characters it keeps, outside the markers and the cut mark, is already
 * in the first scrub's text. (It can remove more: a value that only reads as
 * one once the first scrub's markers stand beside it, or a cut that leaves an
 * address-shaped end: 21 of 400,000 hostile inputs, review 3B S9.)
 */
function revealsNothingNew(once: string, again: string): boolean {
  const words = [
    ...Object.values(SAMPLE_MARKERS),
    SAMPLE_CUT_MARK,
    SAMPLE_UNREADABLE_TARGET,
    SAMPLE_OVERFLOW_TARGET,
  ].sort((a, b) => b.length - a.length);
  let runs = [again];
  for (const word of words) runs = runs.flatMap((r) => r.split(word));
  return runs.every((run) => {
    for (let i = 0; i + 6 <= run.length; i++) if (!once.includes(run.slice(i, i + 6))) return false;
    return true;
  });
}

// ── The contract's words ────────────────────────────────────────────────────

describe('the contract with migration 0479', () => {
  it('has the constants the database uses, as the contract writes them', () => {
    expect([SAMPLE_TARGET_MAX, SAMPLE_QUERY_MAX]).toEqual([200, 300]);
    expect(SAMPLE_UNREADABLE_TARGET).toBe('(unreadable)');
    expect(SAMPLE_OVERFLOW_TARGET).toBe('(more than could be listed)');
    expect([SAMPLE_BATCH_MAX, SAMPLE_KIND_CAP_PER_HOUR, SAMPLE_HOUR_CAP]).toEqual([50, 50, 300]);
    expect([...SAMPLE_METHODS]).toEqual([
      'GET',
      'HEAD',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
    ]);
    expect(SAMPLE_COUNT_MAX).toBe(999_999);
    expect(SAMPLE_AT_MS_PAST_HOURS).toBe(26);
    expect([SAMPLE_RETENTION_DAYS, SAMPLE_PURGE_BATCH]).toEqual([90, 5_000]);
    expect([SAMPLE_READ_MAX_HOURS, SAMPLE_READ_DEFAULT_HOURS]).toEqual([168, 24]);
    expect([
      SAMPLE_READ_DEFAULT_LIMIT,
      SAMPLE_READ_MAX_LIMIT,
      SAMPLE_READ_PAIRS_PER_TARGET,
    ]).toEqual([10, 50, 5]);
    expect(SAMPLE_READ_ROW_CEILING).toBe(60_000);
  });

  it('every marker and both fixed words pass every rule, as a path and in a query string', () => {
    const markers = Object.values(SAMPLE_MARKERS);
    expect(markers).toEqual([
      '<email>',
      '<id>',
      '<number>',
      '<long value>',
      '<token>',
      '<removed>',
      '<address>',
      '(at)',
    ]);
    for (const word of [...markers, SAMPLE_UNREADABLE_TARGET, SAMPLE_OVERFLOW_TARGET]) {
      expect(isStorableTarget(`/${word}`), word).toBe(true);
      expect(isStorableSample(word), word).toBe(true);
      expect(isStorableSample(`x=${word}`), word).toBe(true);
    }
    expect(isStorableTarget(SAMPLE_UNREADABLE_TARGET)).toBe(true);
    expect(isStorableTarget(SAMPLE_OVERFLOW_TARGET)).toBe(false);
  });

  it('the text rules refuse what the contract says they refuse', () => {
    const b64 = `${'dGhpcyBpcyBhIG1hZGUgdXAgdmFsdWU'}=`;
    for (const refused of [
      '/a@b',
      '/a%40b',
      '/a%2540b',
      '/a%252540b',
      '/123456',
      '/1.2.3.4',
      '/1.2.3.4.5',
      `/${'a1'.repeat(12)}`,
      `/${'A+b='.repeat(6)}`,
      `/${b64}`,
      '/0f1e2d3c-4b5a-4968-8776-655443322110',
      '/0F1E2D3C-4B5A-4968-8776-655443322110',
      `/${'0f1e2d3c'.repeat(4)}`,
      '/café',
      '/a\nb',
    ]) {
      expect(isStorableTarget(refused), refused).toBe(false);
      expect(isStorableSample(refused.slice(1)), refused).toBe(false);
    }
    expect(isStorableTarget('')).toBe(false);
    expect(isStorableTarget('no-slash')).toBe(false);
    expect(isStorableTarget(`/${'abc/'.repeat(49)}abc`)).toBe(true);
    expect(isStorableTarget(`/${'abc/'.repeat(50)}`)).toBe(false);
    expect(isStorableSample(null)).toBe(true);
    expect(isStorableSample('')).toBe(true);
    expect(isStorableSample('x'.repeat(301))).toBe(false);
    // `/`, `-` and `_` break a long-value run.
    expect(isStorableTarget(`/${'abcdefghij-'.repeat(5)}`)).toBe(true);
  });

  it('a method is one of the seven, exactly', () => {
    for (const m of SAMPLE_METHODS) expect(isSampleMethod(m)).toBe(true);
    for (const m of ['get', 'TRACE', 'CONNECT', 'PROPFIND', '', null, 1])
      expect(isSampleMethod(m)).toBe(false);
  });
});

// ── Each rule, on its own ───────────────────────────────────────────────────

describe('each rule', () => {
  const t = scrubRequestTarget;
  it('an email address, plain, plus-addressed and with its @ encoded once, twice and three times', () => {
    expect(t('/users/someone@example.com/.env')).toBe('/users/<email>/.env');
    expect(t('/users/some.one+tag@mail.example/.env')).toBe('/users/<email>/.env');
    expect(t('/users/someone%40example.com/.env')).toBe('/users/<email>/.env');
    expect(t('/users/someone%2540example.com/.env')).toBe('/users/<email>/.env');
    expect(t('/users/someone%252540example.com/.env')).toBe('/users/<email>/.env');
    // Four times: past the decodes, still caught by the at-sign's encoded shape.
    expect(t('/users/someone%25252540example.com/.env')).toBe('/users/<email>/.env');
    // Not an email address (no domain with a dot and a name of letters): `(at)` in place.
    expect(t('/@example/.env')).toBe('/(at)example/.env');
  });
  it('an `@` that is not part of an email address is `(at)` in its place', () => {
    expect(t('/@vite/env')).toBe('/(at)vite/env');
    expect(t('/@fs/etc/passwd')).toBe('/(at)fs/etc/passwd');
    expect(t('/x/user%40host/.env')).toBe('/x/user(at)host/.env');
    expect(t('/x/a@b.c/.env')).toBe('/x/a(at)b.c/.env');
    expect(t('/x/@/.env')).toBe('/x/(at)/.env');
    expect(scrubRequestSample('q=a@b')).toBe('q=a(at)b');
    expect(scrubRequestSample('q=%2540x')).toBe('q=(at)x');
    for (const out of ['/(at)vite/env', '/x/user(at)host/.env']) {
      expect(isStorableTarget(out), out).toBe(true);
      expect(t(out)).toBe(out);
    }
    expect(isStorableSample('q=a(at)b')).toBe(true);
    expect(scrubRequestSample('q=a(at)b')).toBe('q=a(at)b');
  });
  it('an id, dashed in either case, and dashless', () => {
    expect(t('/x/0f1e2d3c-4b5a-4968-8776-655443322110/.env')).toBe('/x/<id>/.env');
    expect(t('/x/0F1E2D3C-4B5A-4968-8776-655443322110/.env')).toBe('/x/<id>/.env');
    expect(t(`/x/${'0f1e2d3c'.repeat(4)}/.env`)).toBe('/x/<id>/.env');
  });
  it('a run of six digits or more, and a phone number with separators', () => {
    expect(t('/x/123456/.env')).toBe('/x/<number>/.env');
    expect(t('/x/12345/.env')).toBe('/x/12345/.env');
    expect(t('/x/555-012-3456/.env')).toBe('/x/<number>/.env');
    expect(t('/x/(555) 012 3456/.env')).toBe('/x/<number>/.env');
    // A date is not a phone number.
    expect(t('/backup-2026-01-31.zip')).toBe('/backup-2026-01-31.zip');
  });
  it('an IPv4 and an IPv6 address', () => {
    expect(t('/x/192.0.2.10/.env')).toBe('/x/<address>/.env');
    expect(t('/x/198.51.100.7.9/.env')).toBe('/x/<address>.9/.env');
    expect(t('/x/2001:db8::1/.env')).toBe('/x/<address>/.env');
    expect(t('/x/1:2:3:4:5:6:7:8/.env')).toBe('/x/<address>/.env');
    // A time and a version are not addresses.
    expect(t('/x/12:30:45/v1.2.3/.env')).toBe('/x/12:30:45/v1.2.3/.env');
  });
  it('a long value, and a short key before it is kept', () => {
    expect(t(`/x/${'wxyz'.repeat(8)}/.env`)).toBe('/x/<long value>/.env');
    // Letters and digits mixed through it: a token.
    expect(t(`/x/${'xy12'.repeat(8)}/.env`)).toBe('/x/<token>/.env');
    expect(scrubRequestSample(`q=${'abcdefghij'.repeat(3)}`)).toBe('q=<long value>');
    expect(scrubRequestSample('backupmanagerconfigvalue=1')).toBe('<long value>');
    // A key shaped like a token is `<token>`, a name that holds a secret word: its value goes too.
    expect(scrubRequestSample(`${'k'.repeat(24)}=1`)).toBe('<token>=<removed>');
    expect(scrubRequestSample('q=hello+world+these+are+words')).toBe('q=<long value>');
  });
  it('a run shaped like a token, short or long, with `-` and `_` or without', () => {
    expect(t('/x/Zk3_q9Lm-7Rt2_Wx8-Bv4Nc6Yp1/.env')).toBe('/x/<token>/.env');
    expect(t('/wp-content/plugins/advanced-custom-fields-pro/x.php')).toBe(
      '/wp-content/plugins/advanced-custom-fields-pro/x.php',
    );
    expect(t('/wp-content/plugins/JMXInvokerServlet/x.php')).toBe(
      '/wp-content/plugins/JMXInvokerServlet/x.php',
    );
  });
  it('a JWT shape, and any three long base64url parts joined by dots', () => {
    const part = 'Ab1_'.repeat(5);
    expect(t(`/x/eyJ${part}.${part}.${part}/.env`)).toBe('/x/<token>/.env');
    expect(t(`/x/${part}.${part}.${part}/.env`)).toBe('/x/<token>/.env');
    expect(scrubRequestSample(`eyJ${part}.${part}`)).toBe('<token>');
    expect(t('/connector.minimal.php')).toBe('/connector.minimal.php');
  });
  it('the value of a secret-named key, in mixed case, nested, encoded, and in a path part', () => {
    const q = scrubRequestSample;
    expect(q('x=1&PassWord=vexample&y=2')).toBe('x=1&PassWord=<removed>&y=2');
    expect(q('form[user][Api_Key]=vexample')).toBe('form[user][Api_Key]=<removed>');
    expect(q(`${encodeAll('session')}=vexample`)).toBe(`${encodeAll('session')}=<removed>`);
    expect(q('pa%E2%80%8Bss=vexample')).toBe('pa%E2%80%8Bss=<removed>');
    expect(q('x=1;token=vexample')).toBe('x=1;token=<removed>');
    expect(t('/x;jsessionid=vexample/index.php')).toBe('/x;jsessionid=<removed>/index.php');
    expect(t('/x;color=blue/index.php')).toBe('/x;color=blue/index.php');
    // The one-letter names this app's own links carry a token or an address in.
    expect(q('m=vexample&e=vexample&t=vexample&s=kept')).toBe(
      'm=<removed>&e=<removed>&t=<removed>&s=kept',
    );
    for (const name of [...SAMPLE_SECRET_KEY_PARTS, ...SAMPLE_SECRET_KEY_NAMES]) {
      expect(isSecretQueryKey(name.toUpperCase()), name).toBe(true);
    }
    expect(isSecretQueryKey('page')).toBe(false);
    expect(isSecretQueryKey('cmd')).toBe(false);
  });
  it('a part with no key is kept only when short', () => {
    expect(scrubRequestSample('debug')).toBe('debug');
    const short = 'ab-'.repeat(26);
    expect(short.length).toBe(SAMPLE_BARE_VALUE_MAX - 2);
    expect(scrubRequestSample(short)).toBe(short);
    expect(scrubRequestSample('x-'.repeat(SAMPLE_BARE_VALUE_MAX / 2))).toBe('<removed>');
    expect(scrubRequestSample(`a=1&${'x-'.repeat(50)}`)).toBe('a=<removed>&<removed>');
  });
  it('decodes up to three times for the rules, and keeps what was sent', () => {
    expect(t('/x/%31%32%33%34%35%36/.env')).toBe('/x/<number>/.env');
    expect(t('/x/%2531%2532%2533%2534%2535%2536/.env')).toBe('/x/<number>/.env');
    expect(t('/x/%252531%252532%252533%252534%252535%252536/.env')).toBe('/x/<number>/.env');
    expect(t('/..%2f..%2fetc%2fpasswd')).toBe('/..%2f..%2fetc%2fpasswd');
  });
  it('an escape’s own digits count, as they do in the table', () => {
    // Decoded, this is "A23456" (five digits); as kept it holds seven in a row.
    expect(t('/x/%4123456/.env')).toBe('/x/<number>/.env');
  });
  it('control, zero-width and bidi characters: taken out when literal, kept as escapes, never let a value through', () => {
    expect(t('/x/a\u202eb\u200bc/.env')).toBe('/x/abc/.env');
    expect(t('/x/a\nb/.env')).toBe('/x/ab/.env');
    expect(t('/x/a%0D%0Ab/.env')).toBe('/x/a%0D%0Ab/.env');
    expect(t('/x/123\u200b456/.env')).toBe('/x/<number>/.env');
    expect(t('/x/123%E2%80%8B456/.env')).toBe('/x/<number>/.env');
    expect(t('/x/café/.env')).toBe('/x/caf?/.env');
    expect(t('/x/caf%C3%A9/.env')).toBe('/x/caf%C3%A9/.env');
  });
  it('a malformed escape: the path is unreadable, the query is no sample', () => {
    for (const bad of [
      '/a%zz/.env',
      '/a%/.env',
      '/a%2/.env',
      '/a%C3/.env',
      '/a%FF/.env',
      '/a%E2%80/.env',
    ]) {
      expect(t(bad), bad).toBe(SAMPLE_UNREADABLE_TARGET);
      expect(scrubRequestSample(bad.slice(1)), bad).toBeNull();
    }
    // Deeper than the first decode, a broken escape is only text.
    expect(t('/a%25zz/.env')).toBe('/a%25zz/.env');
  });
  it('no query or an empty one is no sample', () => {
    for (const none of ['', null, undefined]) expect(scrubRequestSample(none)).toBeNull();
    // What follows the `?` only: a `?` in it is text.
    expect(scrubRequestSample('?a2=1')).toBe('?a2=1');
  });
  it('cuts to length on a whole character or marker, ending in three dots', () => {
    const long = `/${'abc/'.repeat(100)}.env`;
    const out = t(long);
    expect(out.length).toBeLessThanOrEqual(SAMPLE_TARGET_MAX);
    expect(out.endsWith(SAMPLE_CUT_MARK)).toBe(true);
    expect(out.startsWith('/abc/abc/')).toBe(true);
    const encoded = `/${'%C3%A9'.repeat(200)}`;
    const cut = t(encoded);
    expect(cut).toMatch(/^\/(%C3%A9)+\.\.\.$/);
    const q = scrubRequestSample(`x=${'a.'.repeat(400)}`)!;
    expect(q.length).toBeLessThanOrEqual(SAMPLE_QUERY_MAX);
    expect(q.endsWith(SAMPLE_CUT_MARK)).toBe(true);
  });
  it('reads at most SAMPLE_INPUT_MAX characters: what follows is never looked at', () => {
    const tail = '/someone@example.com';
    const path = `/${'a/'.repeat(SAMPLE_INPUT_MAX / 2)}${tail}`;
    const out = t(path);
    expect(out.endsWith(SAMPLE_CUT_MARK)).toBe(true);
    // A cut through an escape drops the broken escape, so the path stays readable.
    const split = `/${'b'.repeat(SAMPLE_INPUT_MAX - 3)}%C3%A9`;
    expect(t(split)).not.toBe(SAMPLE_UNREADABLE_TARGET);
  });
  it('a target that is not a path is unreadable', () => {
    for (const bad of ['', 'no-slash', SAMPLE_OVERFLOW_TARGET])
      expect(t(bad), bad).toBe(SAMPLE_UNREADABLE_TARGET);
    expect(t(SAMPLE_UNREADABLE_TARGET)).toBe(SAMPLE_UNREADABLE_TARGET);
    expect(t(42 as unknown as string)).toBe(SAMPLE_UNREADABLE_TARGET);
  });
});

describe("the table's own rules also run over the kept text, where an escape's digits count", () => {
  // Each input reads clean when decoded; the text as kept (an escape stays an
  // escape) is what the table checks, and there it is an address, a long
  // value or an id. Without these rules each would end as the last step's
  // (unreadable) or <removed>.
  it.each([
    ['%25.1.2.3', '<address>'],
    ['%2Fwordpressbackupmanager', '<long value>'],
    ['%25abcdef0-1234-abcd-abcd-abcdefabcdef', '<id>'],
  ])('%s', (text, marker) => {
    expect(scrubRequestTarget(`/x/${text}`)).toBe(`/x/${marker}`);
    expect(scrubRequestSample(`q=${text}`)).toBe(`q=${marker}`);
  });
});

describe('the key rule also reads a value split at decoded separators', () => {
  // Split as a server splits it first; then again at an encoded `&`, `;`, `=`
  // (or `/` in a path), so a secret-named key inside a value loses its value.
  it.each([
    ['q=a%26token%3Dxyz', 'q=a%26token%3D<removed>'],
    ['q=a%3Bsession%3Dxyz', 'q=a%3Bsession%3D<removed>'],
    ['q=a%2526token%253Dxyz', 'q=a%2526token%253D<removed>'],
    ['token%3Dxyz', 'token%3D<removed>'],
    ['pass%3Dword=x', 'pass%3D<removed>'],
    ['q=a%26b%3Dc', 'q=a%26b%3Dc'],
  ])('a query: %s', (query, out) => {
    expect(scrubRequestSample(query)).toBe(out);
    expect(scrubRequestSample(out)).toBe(out);
  });
  it('a value with no key is measured whole, as sent: an encoded `&` inside does not shorten it', () => {
    const half = 'ab-'.repeat(20);
    const bare = `${half}%26${half}`;
    expect(half.length).toBeLessThan(SAMPLE_BARE_VALUE_MAX);
    expect(scrubRequestSample(bare)).toBe('<removed>');
    expect(scrubRequestSample(`q=1&${bare}`)).toBe('q=1&<removed>');
  });
  it.each([
    ['/x%3Btoken%3Dxyz/.env', '/x%3Btoken%3D<removed>/.env'],
    ['/a%2Fb%3Bsig%3Dxyz/.git/config', '/a%2Fb%3Bsig%3D<removed>/.git/config'],
    ['/x;token=xyz/.env', '/x;token=<removed>/.env'],
  ])('a path: %s', (target, out) => {
    expect(scrubRequestTarget(target)).toBe(out);
    expect(scrubRequestTarget(out)).toBe(out);
  });
});

describe('ordinary scanner shapes are kept as they were sent', () => {
  it.each([
    '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
    '/wp-content/plugins/wp-file-manager/lib/php/connector.minimal.php',
    '/_ignition/execute-solution',
    '/phpmyadmin4.8.1/',
    '/static/..%2F..%2Fwin.ini',
    '/download/..%5c..%5cwindows%5cwin.ini',
    '/%2e%2e%2f%2e%2e%2fetc/passwd',
    '/index.php%00.jpg',
  ])('%s', (p) => {
    expect(scrubRequestTarget(p)).toBe(p);
  });
  it.each(['XDEBUG=1', 'page=2&lang=en', 'cmd=ls&dir=..%2F..%2F'])('a query: %s', (q) => {
    expect(scrubRequestSample(q)).toBe(q);
  });
});

// ── Generated hostile inputs ────────────────────────────────────────────────

describe('generated hostile inputs (seeded)', () => {
  const RUNS = 4_000;

  it(`${RUNS} paths: every output is storable, printable, in length, and holds no planted value`, () => {
    const seq = sequence(0x5eed01);
    const kinds = new Set<string>();
    for (let i = 0; i < RUNS; i++) {
      const { input, planted } = hostilePath(seq);
      kinds.add(planted.kind);
      const out = scrubRequestTarget(input);
      expect(isStorableTarget(out), `${input} -> ${out}`).toBe(true);
      expectSafe(out, planted, SAMPLE_TARGET_MAX);
      expect(revealsNothingNew(out, scrubRequestTarget(out)), `scrubbed twice: ${input}`).toBe(
        true,
      );
    }
    expect(kinds.size).toBe(19);
  });

  it(`${RUNS} query strings: the same, for samples`, () => {
    const seq = sequence(0x5eed02);
    const kinds = new Set<string>();
    for (let i = 0; i < RUNS; i++) {
      const { input, planted } = hostileQuery(seq);
      kinds.add(planted.kind);
      const out = scrubRequestSample(input);
      if (out === null) continue;
      expect(isStorableSample(out), `${input} -> ${out}`).toBe(true);
      expectSafe(out, planted, SAMPLE_QUERY_MAX);
      expect(
        revealsNothingNew(out, scrubRequestSample(out) ?? ''),
        `scrubbed twice: ${input}`,
      ).toBe(true);
    }
    expect(kinds.size).toBe(20);
  });

  it('a planted value with a malformed escape somewhere: unreadable, or no sample', () => {
    const seq = sequence(0x5eed03);
    for (let i = 0; i < 300; i++) {
      const { input } = hostilePath(seq);
      const at = seq.int(1, Math.min(input.length, 400));
      const broken = `${input.slice(0, at).replace(/%[0-9A-Fa-f]?$/, '')}%${seq.pick(['zz', 'g1', 'Z/', 'x'])}${input.slice(at)}`;
      expect(scrubRequestTarget(broken), broken).toBe(SAMPLE_UNREADABLE_TARGET);
      expect(scrubRequestSample(broken.slice(1))).toBeNull();
    }
  });

  it('random printable and non-printable text never yields anything unstorable', () => {
    const seq = sequence(0x5eed04);
    const alphabet = `${LOWER}${UPPER}${DIGITS}%@./-_=+;&?#:[]()<> \u200b\u202eé\n`;
    for (let i = 0; i < 2_000; i++) {
      const raw = seq.text(alphabet, seq.int(0, 900));
      const target = scrubRequestTarget(`/${raw}`);
      expect(isStorableTarget(target), raw).toBe(true);
      expect(scrubRequestTarget(target)).toBe(target);
      const sample = scrubRequestSample(raw);
      if (sample !== null) {
        expect(isStorableSample(sample), raw).toBe(true);
        expect(scrubRequestSample(sample)).toBe(sample);
      }
    }
  });
});

// ── A short token, in every position (0479 review, round 2) ─────────────────

describe('a token, which the table lets through when it is short, is replaced in every position', () => {
  const seq = sequence(0x5eed05);
  const tokens = Array.from({ length: 2_000 }, () => seq.text(BASE64URL, 22));
  // The rule is judged on the run alone: these are the random values it reads as names.
  const missed = tokens.filter((v) => !looksLikeToken(v));

  it('of 2,000 random 22-character base64url values, at most 2 read as names (1,000 per million)', () => {
    expect(missed.length).toBeLessThanOrEqual(2);
  });

  const POSITIONS: Array<[string, (v: string) => string | null]> = [
    ['a middle path segment', (v) => scrubRequestTarget(`/backup/${v}/.env`)],
    ['the last path segment', (v) => scrubRequestTarget(`/backup/${v}`)],
    ['a file name before its extension', (v) => scrubRequestTarget(`/x/${v}.php`)],
    ['a query value under an ordinary key', (v) => scrubRequestSample(`page=2&q=${v}`)],
    ['a query value with no key', (v) => scrubRequestSample(v)],
    ['a query key itself', (v) => scrubRequestSample(`${v}=1&page=2`)],
  ];

  it.each(POSITIONS)('as %s: every value the rule reads as a token is gone', (_where, scrub) => {
    for (const value of tokens) {
      if (missed.includes(value)) continue;
      const out = scrub(value) ?? '';
      expect(out.includes(value), `${value} -> ${out}`).toBe(false);
      expect(decodedForm(out).includes(value)).toBe(false);
    }
  });

  it('nor with a word joined to it by `-` or `_`', () => {
    for (const value of tokens.slice(0, 500)) {
      if (missed.includes(value)) continue;
      for (const joined of [`invite-${value}`, `${value}_backup`, `x-${value}-y`]) {
        expect(scrubRequestTarget(`/a/${joined}/.env`).includes(value), joined).toBe(false);
      }
    }
  });

  it('every length from the shortest looked at up to 43: at most 1 in 100 of each length reads as a name', () => {
    for (let n = SAMPLE_TOKEN_RUN_MIN + 2; n <= 43; n++) {
      let kept = 0;
      for (let i = 0; i < 300; i++) {
        const value = seq.text(BASE64URL, n);
        if (scrubRequestTarget(`/x/${value}/.env`).includes(value)) kept++;
      }
      expect(kept, `length ${n}`).toBeLessThanOrEqual(3);
    }
  });

  it('measured: at most 1,000 per million kept at 22 characters, at most 10 per million at 32 and 43', () => {
    // The full measurement was 1,000,000 values at each length (numbers in
    // stockpilot-work/security-tools-2026-11/part-5-samples-web/PROGRESS.md);
    // the pinned test below re-counts 200,000 per length. Here a smaller
    // seeded sample (so a failure repeats) is held to the same per-million
    // bounds, rounded up: 1,000 per million is 4 in 4,000, and 10 per
    // million is under 1 in 20,000, so 1 is allowed as a margin.
    const own = sequence(0x5eed0a);
    const rate = (n: number, runs: number) => {
      let kept = 0;
      for (let i = 0; i < runs; i++) {
        const value = own.text(BASE64URL, n);
        if (scrubRequestTarget(`/x/${value}`).includes(value)) kept++;
      }
      return kept;
    };
    expect(rate(22, 4_000)).toBeLessThanOrEqual(4);
    expect(rate(32, 20_000)).toBeLessThanOrEqual(1);
    expect(rate(43, 20_000)).toBeLessThanOrEqual(1);
  }, 60_000);

  it('the rule as measured, pinned: of 200,000 seeded values, exactly 24 at 22 characters and none at 32 read as names', () => {
    // A change to the rule moves these counts (each sign of a random value
    // taken out alone moved the 22-character count to 27, 52, 59 or 84):
    // re-measure it (PROGRESS.md) and re-pin here, with the names below.
    const names = (seed: number, n: number) => {
      const own = sequence(seed);
      let kept = 0;
      for (let i = 0; i < 200_000; i++) if (!looksLikeToken(own.text(BASE64URL, n))) kept++;
      return kept;
    };
    expect(names(0x70ce22, 22)).toBe(24);
    expect(names(0x70ce32, 32)).toBe(0);
  }, 60_000);

  it('an all-capital part longer than five letters reads as a name only with its vowels', () => {
    expect(looksLikeToken('XDEBUG_SESSION_START')).toBe(false);
    expect(looksLikeToken('MSSQL_backup_files_2024')).toBe(false);
    // Six, seven and eight capitals with no vowel: not an acronym.
    for (const part of ['BCDFGH', 'BCDFGHJ', 'BCDFGHJK']) {
      expect(looksLikeToken(`${part}_backup_files`), part).toBe(true);
    }
  });

  it('is replaced by <token>', () => {
    const [a, b] = tokens.filter((v) => !missed.includes(v));
    expect(scrubRequestTarget(`/x/${a}/.env`)).toBe('/x/<token>/.env');
    expect(scrubRequestSample(`q=${b}`)).toBe('q=<token>');
  });

  it('the ordinary names it still replaces (digits inside the letters, or a capital-heavy part), pinned', () => {
    const replaced = [
      'MyPlugin2Settings_Config',
      'getUserById2023x',
      'iPhone14ProMax_case',
      'ZyXEL_NAS_Firmware_v5',
    ];
    for (const name of replaced) {
      expect(looksLikeToken(name), name).toBe(true);
      expect(scrubRequestTarget(`/x/${name}/.env`), name).toBe('/x/<token>/.env');
    }
  });

  it('the ordinary names it keeps, these five first', () => {
    const kept = [
      'phpMyAdmin-5-2-1-all-languages',
      'WordPress_SEO_by_Yoast',
      'CVE-2021-44228-test',
      'ExchangeServer2019',
      'Simple_Ajax_Chat_v2_Plugin',
      // Replaced by the first rule (2026-11-24), kept by this one.
      'wpFileManagerPro_2024_v3',
      'Ultimate_Member_v2',
      'ContactForm7_Extension',
      'WP_Super_Cache_2',
      'GetObjectList_v2',
      'RevSliderAdmin_v6',
      'UTF8_General_CI_x64',
      'CVE_2017_9841_check',
      'HtmlAdaptor_action_InvokeOp',
      'jmx-console_HtmlAdaptor',
      'elFinderConnector_php',
      'FCKeditor_2_6_editor',
      'getAllUsersFromDB',
      'ShowUserProfileById',
      'MSSQL_DB_Backup_x64',
      'SAP_NetWeaver_Portal_7',
      'AppsLocalLogin_jsp',
      'OWA_Exchange_2016_CU23',
      'iOS_17_Profile_Install',
      // Kept by both.
      'advanced-custom-fields-pro',
      'google-analytics-for-wordpress',
      'all-in-one-wp-migration',
      'call_user_func_array',
      'ee-simple-file-list-ajax',
      'jquery-ui-1-12-1',
      'x86_64-linux-gnu',
      'backup-2026-01-31-db',
      'nginx-1-25-3-alpine',
      'XDEBUG_SESSION_START',
      'HTTP_X_FORWARDED_FOR',
      'AWS_ACCESS_KEY_ID',
      'PHPUnit_Framework_TestCase',
      'WooCommerce-Payments',
      'JetEngine_Booking_Form',
      'TinyMCE_Advanced',
      'InfiniteWP_Client',
      'SpringBootActuator',
      'Content-Disposition',
      'Revslider_Show_Image',
      'ThemeGrill_Demo_Importer',
      'WPvivid_Backup_Restore',
      'DuplicatorPro_Installer',
      'UpdraftPlus_Backups',
      'DotNetNuke_Install_wizard',
      'JMXInvokerServlet',
      'EJBInvokerServlet',
      'ProductKeyExtractor',
      'Telerik-Web-UI-WebResource',
      'ScriptResource_axd',
    ];
    for (const name of kept) {
      expect(looksLikeToken(name), name).toBe(false);
      expect(scrubRequestTarget(`/wp-content/plugins/${name}/x.php`), name).toBe(
        `/wp-content/plugins/${name}/x.php`,
      );
    }
  });
});

describe('a JWT, a hex value of 32 or more and a base64 value of 32 or more always go', () => {
  const seq = sequence(0x5eed06);
  const B64 = `${UPPER}${LOWER}${DIGITS}+/`;

  it('a JWT shape, in a path and in a query string', () => {
    for (let i = 0; i < 500; i++) {
      const jwt = `eyJ${seq.text(BASE64URL, seq.int(8, 40))}.${seq.text(BASE64URL, seq.int(8, 60))}.${seq.text(BASE64URL, seq.int(8, 43))}`;
      expect(scrubRequestTarget(`/x/${jwt}/.env`)).toBe('/x/<token>/.env');
      expect(scrubRequestSample(`q=${jwt}`)).toBe('q=<token>');
    }
  });

  it('hex of 32, 40 and 64 characters', () => {
    for (let i = 0; i < 500; i++) {
      for (const n of [32, 40, 64]) {
        const hex = seq.text(HEX, n);
        expect(scrubRequestTarget(`/x/${hex}/.env`).includes(hex.slice(0, 12)), hex).toBe(false);
        expect((scrubRequestSample(`q=${hex}`) ?? '').includes(hex.slice(0, 12)), hex).toBe(false);
      }
    }
  });

  it('standard base64 of 32 to 64 characters in a query string, `+` and `/` in it or not, padded or not', () => {
    for (let i = 0; i < 2_000; i++) {
      const value = `${seq.text(B64, seq.int(32, 64))}${seq.pick(['', '=', '=='])}`;
      const out = scrubRequestSample(`q=${value}`) ?? '';
      expect(isStorableSample(out), value).toBe(true);
      for (let k = 0; k + 12 <= value.length; k++) {
        expect(out.includes(value.slice(k, k + 12)), `${value} -> ${out}`).toBe(false);
      }
    }
  });

  it('a path in a query string is not a base64 value', () => {
    for (const q of [
      'path=/usr/local/share/applications/defaults',
      'f=vendor/phpunit/phpunit/src/Util/PHP/eval',
      'next=/wordpress/wp-admin/options-general',
    ]) {
      expect(scrubRequestSample(q)).toBe(q);
    }
  });
});

// ── The independent review of 3b (REVIEW-3B.md): each way through it found ─

describe('the ways through the scrub the independent review found are closed', () => {
  const t = scrubRequestTarget;
  const q = scrubRequestSample;
  const seq = sequence(0x3b3b01);

  it('M1: an email address with a `-`, a digit or an encoded `-` glued after it is still an email address', () => {
    expect(t('/wp-admin/a-jane.doe@school.example-b')).toBe('/wp-admin/<email>');
    expect(t('/wp-admin/jane.doe@school.example1')).toBe('/wp-admin/<email>');
    expect(t('/wp-admin/jane.doe%40school.example%2Dold')).toBe('/wp-admin/<email>');
    expect(q('q=jane.doe@school.example-old')).toBe('q=<email>');
    const TAILS = ['-b', '-', '1', '-2024', '--', '2x', '-old.x', '%2Dold', '_x', '.example-1'];
    for (let i = 0; i < 2_000; i++) {
      const local = seq.text(LOWER, seq.int(3, 9));
      const tail = seq.pick(TAILS);
      const address = `${local}@school.example${tail}`;
      for (const out of [t(`/wp-admin/${address}/x.php`), q(`q=${address}&page=2`) ?? '']) {
        expect(out.includes(local) || out.includes('school'), `${address} -> ${out}`).toBe(false);
      }
    }
    // An `@` with no address around it still reads `(at)`.
    expect(t('/@vite/env')).toBe('/(at)vite/env');
    expect(t('/x/user%40host/.env')).toBe('/x/user(at)host/.env');
    expect(q('q=a@b')).toBe('q=a(at)b');
  });

  it('S2: a standard base64 value whose padding is followed by more is taken whole', () => {
    expect(q('data=Zm9vYmFy+YmF6cXV4/LW1hZGUtdXAtdmFsdWU=x')).toBe('data=<long value>=x');
    expect(q('data=Zm9vYmFy+YmF6cXV4/LW1hZGUtdXAtdmFsdWU===')).toBe('data=<long value>===');
    expect(q('data=Zm9vYmFy+YmF6cXV4/LW1hZGUtdXAtdmFsdWU=')).toBe('data=<long value>');
  });

  it('S2: in a path, a standard base64 value of 32 or more is taken whole when most of it does not read as names', () => {
    const B64 = `${UPPER}${LOWER}${DIGITS}+/`;
    let slashed = 0;
    let whole = 0;
    let piece = 0;
    for (let i = 0; i < 20_000; i++) {
      const value = seq.text(B64, 32);
      if (!value.includes('/')) continue;
      slashed++;
      const out = t(`/wp-admin/${value}`);
      if (out.includes(value)) whole++;
      else if (value.split('/').some((p) => p.length >= 10 && out.includes(p))) piece++;
    }
    // Measured (PROGRESS.md): of all 32-character values, about 0.02% kept
    // whole and 0.07% a piece of 10+; it was 6.6% and 10.4%.
    expect(slashed).toBeGreaterThan(7_000);
    expect(whole / slashed).toBeLessThan(0.003);
    expect(piece / slashed).toBeLessThan(0.005);
    // Ordinary long paths are names: kept as sent.
    for (const path of [
      '/wordpress/wp/includes/blog/xmlrpc.php',
      '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
      '/wp-content/themes/twentytwentyone/functions.php',
      '/wp-content/plugins/contact-form-7/includes/js/index.js',
    ]) {
      expect(t(path)).toBe(path);
    }
  });

  it('S9: a second scrub never shows more, on padded base64 followed by more and on texts cut near an address', () => {
    // 1,000 seeded texts here; 4,000 were run in full when this was written
    // (stockpilot-work/security-tools-2026-11/part-5-samples-web/PROGRESS.md).
    const B64 = `${UPPER}${LOWER}${DIGITS}+/`;
    const pieces = [
      () =>
        `${seq.text(B64, seq.int(30, 48))}${seq.pick(['=', '==', '==='])}${seq.text(LOWER, seq.int(1, 3))}`,
      () =>
        `${seq.text(HEX, seq.int(2, 6))}:${seq.text(HEX, seq.int(1, 4))}::${seq.text(HEX, seq.int(1, 6))}`,
      () => `${seq.int(1, 299)}.${seq.int(1, 299)}.${seq.int(1, 299)}.${seq.int(1, 299)}`,
      () => seq.text(BASE64URL, seq.int(10, 30)),
      () =>
        seq.pick(['<token>', '<removed>', '(at)', '...', '%25%25', '%0A', '&', ';', '=', '/', '@']),
      () => seq.text(`${LOWER}.-_`, seq.int(1, 12)),
    ];
    let changed = 0;
    for (let i = 0; i < 1_000; i++) {
      let raw = '';
      const want = seq.int(1, 3) === 1 ? seq.int(280, 330) : seq.int(20, 200);
      while (raw.length < want) raw += seq.pick(pieces)();
      const out = q(raw);
      if (out !== null) {
        const again = q(out) ?? '';
        if (again !== out) changed++;
        expect(isStorableSample(again)).toBe(true);
        expect(revealsNothingNew(out, again), `${raw}\n -> ${out}\n -> ${again}`).toBe(true);
      }
      const path = t(`/wp-admin/${raw}`);
      const pathAgain = t(path);
      if (pathAgain !== path) changed++;
      expect(isStorableTarget(pathAgain)).toBe(true);
      expect(revealsNothingNew(path, pathAgain), `${raw}\n -> ${path}\n -> ${pathAgain}`).toBe(
        true,
      );
    }
    // Most are unchanged; the property above is what is promised, and it sees a leak.
    expect(changed).toBeLessThan(100);
    expect(revealsNothingNew('q=<token>', 'q=<token>')).toBe(true);
    expect(revealsNothingNew('q=<token>', 'q=madeupvalue')).toBe(false);
  }, 60_000);

  it('S3: a card number or phone number in groups joined by `+`, `_`, spaces or dashes is a number', () => {
    expect(q('q=4111+1111+1111+1111')).toBe('q=<number>');
    expect(q('q=4111 1111 1111 1111')).toBe('q=<number>');
    expect(q('q=4111-1111-1111-1111')).toBe('q=<number>');
    expect(t('/wp-admin/1234_5678_9012_3456')).toBe('/wp-admin/<number>');
    // Nineteen digits glued to its key: taken as a long value, gone either way.
    expect(q('q=5555+5555+5555+4444+123')).not.toMatch(/[0-9]{3}/);
    expect(q('q=555+010+4477')).toBe('q=<number>');
    expect(q('q=12345-67890')).toBe('q=<number>');
    // A date, a version, a size and an injection probe's numbers are not.
    expect(t('/backup/2026-01-31-db/.env')).toBe('/backup/2026-01-31-db/.env');
    expect(t('/wp-admin/v10.15.7/x')).toBe('/wp-admin/v10.15.7/x');
    expect(q('id=1+UNION+SELECT+1,2,3--')).toBe('id=1+UNION+SELECT+1,2,3--');
    expect(q('range=10-20&size=640+480')).toBe('range=10-20&size=640+480');
  });

  it('S4: in a path, a secret-named key after an encoded `?` or `&` loses its value', () => {
    expect(t('/wp-admin/x.php%3Flog%3Dadmin%26pwd%3Dmadeup7')).toBe(
      '/wp-admin/x.php%3Flog%3Dadmin%26pwd%3D<removed>',
    );
    expect(t('/wp-admin/x%3Fpassword%3Dmadeup7/y.php')).toBe(
      '/wp-admin/x%3Fpassword%3D<removed>/y.php',
    );
    expect(t('/wp-admin/a&token=madeup7/x')).toBe('/wp-admin/a&token=<removed>/x');
    expect(t('/wp-admin/a&b=c/x')).toBe('/wp-admin/a&b=c/x');
  });
});

// ── Cost ────────────────────────────────────────────────────────────────────

describe('every rule runs in about linear time (review S2)', () => {
  const N = 2_000;

  // A slow shared runner moves every time by the same factor, so no absolute
  // millisecond bound is used as the check: the worst case at 2N must cost
  // about twice the one at N. A ratio under 6 allows timer noise and fails a
  // worse-than-quadratic rule; plain quadratic growth (a ratio of about 4) is
  // caught by the ceiling, on the inputs 20 times longer than N.
  const CEILING_MS = 2_000;
  const RATIO_MAX = 6;
  const RUNS = 7;
  const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
  const timeOf = (work: () => void) => {
    work(); // warm-up
    const runs: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const started = performance.now();
      work();
      runs.push(performance.now() - started);
    }
    return median(runs);
  };
  // The same shapes at length N and at 2N.
  const worst = (n: number) => [
    'a'.repeat(n),
    '1'.repeat(n),
    'f'.repeat(n),
    '@'.repeat(n),
    'a@'.repeat(n / 2),
    '1.'.repeat(n / 2),
    '12 '.repeat(n / 3),
    ':'.repeat(n),
    'a:'.repeat(n / 2),
    'eyJ'.repeat(n / 3),
    'eyJaa.'.repeat(n / 6),
    `${'a'.repeat(15)}.`.repeat(n / 16),
    'aB1-'.repeat(n / 4),
    'a='.repeat(n / 2),
    '%25'.repeat(n / 3),
    '%2540'.repeat(n / 5),
  ];
  const small = worst(N);
  const large = worst(2 * N);

  it.each(SCRUB_RULES.map((r) => [r.name, r] as const))(
    '%s, on 2,000-character worst cases',
    (_name, rule) => {
      small.forEach((text, i) => {
        const at = timeOf(() => rule.find(text));
        const twice = timeOf(() => rule.find(large[i]!));
        expect(twice, text.slice(0, 12)).toBeLessThan(CEILING_MS);
        // Under a millisecond a ratio is only timer noise.
        if (at >= 1) expect(twice / at, text.slice(0, 12)).toBeLessThan(RATIO_MAX);
      });
    },
    60_000,
  );

  it('the whole scrub, on the longest input it reads and far past it', () => {
    const whole = (input: string) => () => {
      scrubRequestTarget(input);
      scrubRequestSample(input.slice(1));
    };
    small.forEach((text, i) => {
      for (const [at, twice] of [
        [`/${text}`, `/${large[i]!}`],
        [`/${text.repeat(20)}`, `/${large[i]!.repeat(20)}`],
      ] as const) {
        const one = timeOf(whole(at));
        const two = timeOf(whole(twice));
        expect(two, text.slice(0, 12)).toBeLessThan(CEILING_MS);
        if (one >= 1) expect(two / one, text.slice(0, 12)).toBeLessThan(RATIO_MAX);
      }
    });
  }, 60_000);
});

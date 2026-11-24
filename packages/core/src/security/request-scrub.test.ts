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
  [...new TextEncoder().encode(s)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');

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
      const at = { email_encoded_at: '%40', email_double_encoded_at: '%2540', email_triple_encoded_at: '%252540' }[
        kind
      ];
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
  '​',
  '‌',
  '‍',
  '⁠',
  '﻿',
  '­',
  '‪',
  '‮',
  '⁦',
  '⁩',
  '؜',
  ' ',
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

const PLAIN_SEGMENTS = ['wp-admin', 'api', 'backup', 'old', 'site', 'static', 'cgi-bin', 'x', 'phpunit'];
const PROBE_NAMES = ['.env', 'wp-login.php', 'index.php', '.git/config', 'etc/passwd', 'xmlrpc.php'];
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

const SECRET_NAMES = ['password', 'passwd', 'pwd', 'api_key', 'apiKey', 'access_token', 'auth', 'session_id', 'sig', 'otp', 'email', 'username', 'card_number', 'jwt', 'state', 'nonce', 'refresh', 'cookie'];

function mixedCase(seq: ReturnType<typeof sequence>, s: string): string {
  return [...s].map((c) => (seq.next() < 0.5 ? c.toUpperCase() : c)).join('');
}

/** A query with a planted value: as a secret-named key's value, as a plain value, or with no key. */
function hostileQuery(seq: ReturnType<typeof sequence>): { input: string; planted: Planted } {
  const parts: string[] = [];
  for (let i = seq.int(0, 3); i > 0; i--) parts.push(`${seq.pick(['q', 'page', 'lang', 'v', 'x'])}=${seq.text(LOWER, 4)}`);
  let planted: Planted;
  const how = seq.int(0, 2);
  if (how === 0) {
    // A dull value under a secret-shaped key: removed whole, whatever it looks like.
    const name = mixedCase(seq, seq.pick(SECRET_NAMES));
    const nested = seq.next() < 0.3 ? `${seq.pick(['user', 'data', 'form'])}[${seq.pick(['a', 'b'])}][${name}]` : name;
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
  parts.splice(seq.int(0, parts.length), 0, how === 1 ? `${seq.pick(['q', 'path', 'x'])}=${written}` : written);
  if (seq.next() < 0.1) parts.push(`pad=${'b'.repeat(seq.int(200, 700))}`);
  return { input: withNoise(seq, parts.join(seq.pick(['&', '&', ';']))), planted };
}

const PRINTABLE_ASCII = /^[ -~]*$/;

function expectSafe(out: string, planted: Planted, max: number) {
  expect(PRINTABLE_ASCII.test(out), out).toBe(true);
  expect(out.length).toBeLessThanOrEqual(max);
  expect(out.includes('@'), out).toBe(false);
  for (const form of [out, decodedForm(out)]) {
    expect(form.toLowerCase().includes(planted.value.toLowerCase()), `${planted.kind} in ${out}`).toBe(false);
    if (planted.written && planted.written !== planted.value) {
      expect(form.includes(planted.written), `${planted.kind} (as written) in ${out}`).toBe(false);
    }
  }
}

// ── The contract's words ────────────────────────────────────────────────────

describe('the contract with migration 0479', () => {
  it('has the constants the database uses, as the contract writes them', () => {
    expect([SAMPLE_TARGET_MAX, SAMPLE_QUERY_MAX]).toEqual([200, 300]);
    expect(SAMPLE_UNREADABLE_TARGET).toBe('(unreadable)');
    expect(SAMPLE_OVERFLOW_TARGET).toBe('(more than could be listed)');
    expect([SAMPLE_BATCH_MAX, SAMPLE_KIND_CAP_PER_HOUR, SAMPLE_HOUR_CAP]).toEqual([50, 50, 300]);
    expect([...SAMPLE_METHODS]).toEqual(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
    expect(SAMPLE_COUNT_MAX).toBe(999_999);
    expect(SAMPLE_AT_MS_PAST_HOURS).toBe(26);
    expect([SAMPLE_RETENTION_DAYS, SAMPLE_PURGE_BATCH]).toEqual([90, 5_000]);
    expect([SAMPLE_READ_MAX_HOURS, SAMPLE_READ_DEFAULT_HOURS]).toEqual([168, 24]);
    expect([SAMPLE_READ_DEFAULT_LIMIT, SAMPLE_READ_MAX_LIMIT, SAMPLE_READ_PAIRS_PER_TARGET]).toEqual([10, 50, 5]);
    expect(SAMPLE_READ_ROW_CEILING).toBe(60_000);
  });

  it('every marker and both fixed words pass every rule, as a path and in a query string', () => {
    const markers = Object.values(SAMPLE_MARKERS);
    expect(markers).toEqual(['<email>', '<id>', '<number>', '<long value>', '<token>', '<removed>', '<address>']);
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
    for (const m of ['get', 'TRACE', 'CONNECT', 'PROPFIND', '', null, 1]) expect(isSampleMethod(m)).toBe(false);
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
    expect(t('/@example/.env')).toBe('/<email>/.env');
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
    expect(scrubRequestSample(`${'k'.repeat(24)}=1`)).toBe('<long value>');
    expect(scrubRequestSample('q=hello+world+these+are+words')).toBe('q=<long value>');
  });
  it('a run shaped like a token, short or long, with `-` and `_` or without', () => {
    expect(t('/x/Zk3_q9Lm-7Rt2_Wx8-Bv4Nc6Yp1/.env')).toBe('/x/<token>/.env');
    expect(t('/wp-content/plugins/advanced-custom-fields-pro/x.php')).toBe(
      '/wp-content/plugins/advanced-custom-fields-pro/x.php',
    );
    expect(t('/wp-content/plugins/JMXInvokerServlet/x.php')).toBe('/wp-content/plugins/JMXInvokerServlet/x.php');
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
    expect(q('m=vexample&e=vexample&t=vexample&s=kept')).toBe('m=<removed>&e=<removed>&t=<removed>&s=kept');
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
    expect(t('/x/a‮b​c/.env')).toBe('/x/abc/.env');
    expect(t('/x/a\nb/.env')).toBe('/x/ab/.env');
    expect(t('/x/a%0D%0Ab/.env')).toBe('/x/a%0D%0Ab/.env');
    expect(t('/x/123​456/.env')).toBe('/x/<number>/.env');
    expect(t('/x/123%E2%80%8B456/.env')).toBe('/x/<number>/.env');
    expect(t('/x/café/.env')).toBe('/x/caf?/.env');
    expect(t('/x/caf%C3%A9/.env')).toBe('/x/caf%C3%A9/.env');
  });
  it('a malformed escape: the path is unreadable, the query is no sample', () => {
    for (const bad of ['/a%zz/.env', '/a%/.env', '/a%2/.env', '/a%C3/.env', '/a%FF/.env', '/a%E2%80/.env']) {
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
    for (const bad of ['', 'no-slash', SAMPLE_OVERFLOW_TARGET]) expect(t(bad), bad).toBe(SAMPLE_UNREADABLE_TARGET);
    expect(t(SAMPLE_UNREADABLE_TARGET)).toBe(SAMPLE_UNREADABLE_TARGET);
    expect(t(42 as unknown as string)).toBe(SAMPLE_UNREADABLE_TARGET);
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
      expect(scrubRequestTarget(out), `scrubbed twice: ${input}`).toBe(out);
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
      expect(scrubRequestSample(out), `scrubbed twice: ${input}`).toBe(out);
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
    const alphabet = `${LOWER}${UPPER}${DIGITS}%@./-_=+;&?#:[]()<> ​‮é\n`;
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

describe('a 22-character base64url token, which the table lets through, never survives', () => {
  const seq = sequence(0x5eed05);
  const tokens = Array.from({ length: 2_000 }, () => seq.text(BASE64URL, 22));

  const POSITIONS: Array<[string, (v: string) => string | null]> = [
    ['a middle path segment', (v) => scrubRequestTarget(`/backup/${v}/.env`)],
    ['the last path segment', (v) => scrubRequestTarget(`/backup/${v}`)],
    ['a file name before its extension', (v) => scrubRequestTarget(`/x/${v}.php`)],
    ['a query value under an ordinary key', (v) => scrubRequestSample(`page=2&q=${v}`)],
    ['a query value with no key', (v) => scrubRequestSample(v)],
    ['a query key itself', (v) => scrubRequestSample(`${v}=1&page=2`)],
  ];

  it.each(POSITIONS)('as %s', (_where, scrub) => {
    for (const value of tokens) {
      const out = scrub(value) ?? '';
      expect(out.includes(value), `${value} -> ${out}`).toBe(false);
      expect(decodedForm(out).includes(value)).toBe(false);
    }
  });

  it('nor with a word joined to it by `-` or `_`', () => {
    for (const value of tokens.slice(0, 500)) {
      for (const joined of [`invite-${value}`, `${value}_backup`, `x-${value}-y`]) {
        expect(scrubRequestTarget(`/a/${joined}/.env`).includes(value), joined).toBe(false);
      }
    }
  });

  it('every length from the shortest looked at up to 43', () => {
    for (let n = SAMPLE_TOKEN_RUN_MIN + 2; n <= 43; n++) {
      for (let i = 0; i < 300; i++) {
        const value = seq.text(BASE64URL, n);
        expect(scrubRequestTarget(`/x/${value}/.env`).includes(value), value).toBe(false);
      }
    }
  });

  it('is replaced by <token>', () => {
    expect(scrubRequestTarget(`/x/${tokens[0]}/.env`)).toBe('/x/<token>/.env');
    expect(scrubRequestSample(`q=${tokens[1]}`)).toBe('q=<token>');
  });

  it('the ordinary mixed-case names it also replaces (a digit, few vowels, or not only words), pinned', () => {
    const replaced = [
      'Simple_Ajax_Chat_v2_Plugin',
      'wpFileManagerPro_2024_v3',
      'MyPlugin2Settings_Config',
      'phpMyAdmin-5-2-1-all-languages',
      'WordPress_SEO_by_Yoast',
      'ExchangeServer2019',
      'Ultimate_Member_v2',
      'ContactForm7_Extension',
      'WP_Super_Cache_2',
      'GetObjectList_v2',
      'getUserById2023x',
      'RevSliderAdmin_v6',
      'iPhone14ProMax_case',
      'UTF8_General_CI_x64',
      'CVE-2021-44228-test',
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
      'ZyXEL_NAS_Firmware_v5',
      'iOS_17_Profile_Install',
    ];
    for (const name of replaced) {
      expect(looksLikeToken(name), name).toBe(true);
      expect(scrubRequestTarget(`/x/${name}/.env`), name).toBe('/x/<token>/.env');
    }
  });

  it('the ordinary names it keeps', () => {
    const kept = [
      // No capital, or no lower-case letter: never a token.
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
      // Mixed case, only words and short acronyms, no digit.
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
      expect(scrubRequestTarget(`/wp-content/plugins/${name}/x.php`), name).toBe(`/wp-content/plugins/${name}/x.php`);
    }
  });
});

// ── Cost ────────────────────────────────────────────────────────────────────

describe('every rule runs in about linear time (review S2)', () => {
  const N = 2_000;
  const WORST = [
    'a'.repeat(N),
    '1'.repeat(N),
    'f'.repeat(N),
    '@'.repeat(N),
    'a@'.repeat(N / 2),
    '1.'.repeat(N / 2),
    '12 '.repeat(N / 3),
    ':'.repeat(N),
    'a:'.repeat(N / 2),
    'eyJ'.repeat(N / 3),
    'eyJaa.'.repeat(N / 6),
    `${'a'.repeat(15)}.`.repeat(N / 16),
    'aB1-'.repeat(N / 4),
    'a='.repeat(N / 2),
    '%25'.repeat(N / 3),
    '%2540'.repeat(N / 5),
  ];

  it.each(SCRUB_RULES.map((r) => [r.name, r] as const))('%s, on 2,000-character worst cases', (_name, rule) => {
    for (const text of WORST) {
      const started = performance.now();
      rule.find(text);
      expect(performance.now() - started, text.slice(0, 12)).toBeLessThan(50);
    }
  });

  it('the whole scrub, on the longest input it reads and far past it', () => {
    for (const text of WORST) {
      for (const input of [`/${text}`, `/${text.repeat(20)}`]) {
        const started = performance.now();
        scrubRequestTarget(input);
        scrubRequestSample(input.slice(1));
        expect(performance.now() - started, text.slice(0, 12)).toBeLessThan(100);
      }
    }
  });
});

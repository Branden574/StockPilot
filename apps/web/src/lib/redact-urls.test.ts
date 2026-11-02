import { describe, expect, it } from 'vitest';

import { asReportableError, nonErrorText } from './error-text';
import { redactCredentialUrls, redactTokens, redactTokensDeep } from './redact-urls';

/**
 * Security wave E, MED-1. These assert the PROPERTY — "no live credential
 * survives redaction" — not the exact replacement text: every case checks
 * that the secret substring is ABSENT from the output, so a future change to
 * the placeholder or to the matching strategy still has to keep the
 * credential out.
 */

// Realistic shapes. None of these are live credentials — they are
// syntactically valid, randomly typed fixtures.
const SHARE_TOKEN = 'a3f9c1d20b7e4856f10c9d2e3b4a5f6708192a3b4c5d6e7f8091a2b3c4d5e6f7';

/**
 * Assembled at runtime rather than written as a literal.
 *
 * The redaction this file tests is precisely "a bare JWT must not survive", so
 * the fixture has to BE a syntactically valid JWT. Written as a string literal
 * it is also, unavoidably, a JWT-shaped literal committed to the repository —
 * which secret scanning flags, correctly and by design. GitGuardian did flag it.
 *
 * Suppressing the scanner with an ignore rule would trade a real detection
 * capability for one test fixture. Base64-encoding the three segments here
 * produces a byte-identical token at runtime while leaving no scannable
 * literal in source, so the scanner keeps its teeth and the test keeps its
 * realism. The decoded signature is the ASCII text "AlphaBetaGammaDelta" —
 * there is no key material anywhere in this file.
 */
const b64url = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
const SIGNED_URL_JWT = [
  b64url('{"alg":"HS256","typ":"JWT"}'),
  b64url('{"url":"item-images/org/cover.jpg"}'),
  b64url('AlphaBetaGammaDelta'),
].join('.');

describe('redactTokens — signed storage URLs', () => {
  it('drops the token query parameter of a Supabase signed URL', () => {
    const url = `https://xizpqmhhslgzbuqtjubv.supabase.co/storage/v1/object/sign/item-images/org/item/cover.jpg?token=${SIGNED_URL_JWT}`;
    const out = redactTokens(`fetch failed for ${url}`);
    expect(out).not.toContain(SIGNED_URL_JWT);
    expect(out).not.toContain('token=');
  });

  it('drops every query parameter, not only ones named token', () => {
    const out = redactTokens(
      'GET https://example.supabase.co/storage/v1/object/sign/b/p.jpg?jwt=abc&sig=def 403',
    );
    expect(out).not.toContain('abc');
    expect(out).not.toContain('def');
  });

  it('redacts a bare JWT with no surrounding URL', () => {
    const out = redactTokens(`Authorization header was Bearer ${SIGNED_URL_JWT}`);
    expect(out).not.toContain(SIGNED_URL_JWT);
  });
});

describe('redactTokens — share links carry the credential in the PATH', () => {
  it.each([
    `https://stockpilotusa.com/m/${SHARE_TOKEN}`,
    `https://stockpilotusa.com/m/${SHARE_TOKEN}/photo/2`,
    `https://stockpilotusa.com/r/${SHARE_TOKEN}`,
    `https://stockpilotusa.com/i/${SHARE_TOKEN}`,
    `https://stockpilotusa.com/invite/${SHARE_TOKEN}`,
    `https://stockpilotusa.com/orders/sign/${SHARE_TOKEN}`,
    `https://stockpilotusa.com/returns/request/${SHARE_TOKEN}`,
    `/m/${SHARE_TOKEN}`,
    `/orders/sign/${SHARE_TOKEN}`,
  ])('removes the token segment from %s', (url) => {
    expect(redactTokens(`render failed at ${url}`)).not.toContain(SHARE_TOKEN);
  });

  it('removes the token even when a query string also needs dropping', () => {
    const out = redactTokens(`https://stockpilotusa.com/r/${SHARE_TOKEN}?warehouse=abc#frag`);
    expect(out).not.toContain(SHARE_TOKEN);
    expect(out).not.toContain('warehouse=abc');
    expect(out).not.toContain('frag');
  });

  it('redacts a magic/recovery link token_hash', () => {
    const out = redactTokens(
      'https://stockpilotusa.com/auth/confirm?token_hash=pkce_9f8e7d6c5b4a&type=recovery',
    );
    expect(out).not.toContain('pkce_9f8e7d6c5b4a');
  });

  it('redacts a Supabase /auth/v1/verify link', () => {
    const out = redactTokens(
      'https://xizpqmhhslgzbuqtjubv.supabase.co/auth/v1/verify?token=6c1b9a8f7e6d5c4b&type=invite',
    );
    expect(out).not.toContain('6c1b9a8f7e6d5c4b');
  });
});

describe('redactTokens — a redacted string must not be re-usable', () => {
  it('is idempotent (a second pass changes nothing)', () => {
    const once = redactTokens(`/m/${SHARE_TOKEN}?a=1`);
    expect(redactTokens(once)).toBe(once);
  });

  it('leaks nothing through a multi-line stack trace', () => {
    const stack = [
      'TypeError: Failed to fetch',
      `    at load (https://stockpilotusa.com/m/${SHARE_TOKEN}/photo/0)`,
      `    at img (https://p.supabase.co/storage/v1/object/sign/b/x.jpg?token=${SIGNED_URL_JWT})`,
    ].join('\n');
    const out = redactTokens(stack);
    expect(out).not.toContain(SHARE_TOKEN);
    expect(out).not.toContain(SIGNED_URL_JWT);
  });
});

describe('redactTokens — keeps the alert feed readable', () => {
  it('leaves a plain dashboard path intact', () => {
    expect(redactTokens('failed at /dashboard/inventory')).toContain('/dashboard/inventory');
  });

  it('leaves the non-credential sibling routes under /r/ intact', () => {
    expect(redactTokens('GET /r/track failed')).toContain('/r/track');
    expect(redactTokens('GET /r/confirm failed')).toContain('/r/confirm');
  });

  it('does not mangle a local file path in a stack frame', () => {
    const frame = '    at fn (/var/task/.next/server/app/page.js:12:34)';
    expect(redactTokens(frame)).toBe(frame);
  });

  it('does not mangle prose containing a slash', () => {
    expect(redactTokens('checked in and/or out')).toBe('checked in and/or out');
  });
});

describe('redactTokensDeep', () => {
  it('redacts nested string values and passes other types through', () => {
    const out = redactTokensDeep({
      count: 3,
      ok: false,
      nothing: null,
      url: `https://stockpilotusa.com/m/${SHARE_TOKEN}`,
      nested: { list: [`/orders/sign/${SHARE_TOKEN}`] },
    });
    expect(JSON.stringify(out)).not.toContain(SHARE_TOKEN);
    expect(out.count).toBe(3);
    expect(out.ok).toBe(false);
    expect(out.nothing).toBeNull();
  });
});

/**
 * Analytics (docket B39 review): PostHog records the page's URL on every event,
 * and /signin can carry a credential in its query (the invite page's Sign in
 * link is /signin?redirect=/invite/<token>) or its fragment (a session a link
 * Supabase verified itself hands back). This redaction changes only the
 * credential and keeps every other character, so product analytics keeps its
 * URLs.
 */
describe('redactCredentialUrls', () => {
  const APP = 'https://app.example.test';

  it('redacts a share token in a query value and keeps the rest of the URL as it was', () => {
    expect(redactCredentialUrls(`${APP}/signin?redirect=/invite/${SHARE_TOKEN}`)).toBe(
      `${APP}/signin?redirect=/invite/[redacted]`,
    );
    const encoded = redactCredentialUrls(
      `${APP}/signin/mfa?redirect=%2Finvite%2F${SHARE_TOKEN}&remember=1`,
    );
    expect(encoded).not.toContain(SHARE_TOKEN);
    expect(encoded).toMatch(/^https:\/\/app\.example\.test\/signin\/mfa\?redirect=%2Finvite%2F/);
    expect(encoded).toMatch(/&remember=1$/);
  });

  it('redacts a share token inside a nested return path', () => {
    const nested = encodeURIComponent(
      `/signin?redirect=${encodeURIComponent(`/invite/${SHARE_TOKEN}`)}`,
    );
    expect(redactCredentialUrls(`${APP}/signin/mfa?redirect=${nested}`)).not.toContain(SHARE_TOKEN);
  });

  it('redacts a share token in the path, as a referrer from a share page carries it', () => {
    expect(redactCredentialUrls(`${APP}/invite/${SHARE_TOKEN}`)).toBe(`${APP}/invite/[redacted]`);
    expect(redactCredentialUrls(`${APP}/orders/sign/${SHARE_TOKEN}?step=2`)).toBe(
      `${APP}/orders/sign/[redacted]?step=2`,
    );
  });

  it("redacts a session's tokens in the fragment and keeps the failure in the query", () => {
    const out = redactCredentialUrls(
      `${APP}/signin?error=auth_callback_failed#access_token=header.payload.signature&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery`,
    );
    expect(out).toBe(
      `${APP}/signin?error=auth_callback_failed#access_token=[redacted]&expires_in=3600&refresh_token=[redacted]&token_type=bearer&type=recovery`,
    );
  });

  it('redacts a signed-URL token, a token_hash and a bare JWT', () => {
    const signed = redactCredentialUrls(
      `https://project.example.invalid/storage/v1/object/sign/b/p.jpg?token=${SIGNED_URL_JWT}`,
    );
    expect(signed).not.toContain(SIGNED_URL_JWT);
    expect(signed).toContain('/storage/v1/object/sign/b/p.jpg?token=');
    expect(
      redactCredentialUrls(`${APP}/auth/confirm?token_hash=placeholder-hash&type=recovery`),
    ).toBe(`${APP}/auth/confirm?token_hash=[redacted]&type=recovery`);
    expect(redactCredentialUrls(`bearer ${SIGNED_URL_JWT}`)).not.toContain(SIGNED_URL_JWT);
  });

  it('leaves every string with no credential exactly as it was', () => {
    for (const value of [
      '',
      `${APP}/dashboard/inventory/3f2c1a9e-7b4d-4c1e-9a2f-0d5e6f7a8b9c?q=acme&tab=2#notes`,
      `${APP}/signin?redirect=%2Fdashboard`,
      `${APP}/signin?error=auth_callback_failed#error=unusable_link`,
      '/r/track',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'checked in and/or out',
      '$pageview',
    ]) {
      expect(redactCredentialUrls(value)).toBe(value);
    }
  });

  it('is idempotent', () => {
    const once = redactCredentialUrls(
      `${APP}/signin?redirect=/invite/${SHARE_TOKEN}#refresh_token=r1`,
    );
    expect(redactCredentialUrls(once)).toBe(once);
  });
});

/**
 * Error reports for a value that is not an Error (docket C21, lib/error-text.ts):
 * a failed supabase-js call's plain `error` object is reported by its message,
 * code, hint and, for a request that got no answer, the first "Caused by:"
 * line. These pin what must never reach the alert: a server error's `details`
 * (a unique or check violation quotes the row's values, such as an email), a
 * cause's stack, and any part of a credential that a cut to length could leave
 * behind (each piece is redacted before it is cut).
 */
describe('error report text for a value that is not an Error', () => {
  const PRIVATE = ['someone@example.com', '555-0100', 'Key (', 'Failing row'];

  /** Every 8-character run of a credential: none may survive. */
  const runsOf = (secret: string) =>
    Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8));

  it.each([
    [
      'a unique violation',
      {
        message: 'duplicate key value violates unique constraint "public_email_unsubscribes_pkey"',
        code: '23505',
        details: 'Key (email)=(someone@example.com) already exists.',
        hint: null,
      },
    ],
    [
      'a check violation',
      {
        message: 'new row for relation "order_signatures" violates check constraint "signer_check"',
        code: '23514',
        details:
          'Failing row contains (00000000-0000-4000-8000-000000000001, someone@example.com, 555-0100).',
        hint: null,
      },
    ],
  ])("%s never carries the row's values", (_label, refusal) => {
    const made = asReportableError(refusal);
    for (const text of [nonErrorText(refusal), made.message, made.stack ?? '']) {
      for (const value of PRIVATE) expect(text).not.toContain(value);
    }
    expect(made.message).toContain(`(code ${refusal.code})`);
  });

  it("a request that got no answer keeps only the cause line, never the cause's stack", () => {
    const shape = {
      message: 'TypeError: fetch failed',
      details: [
        'TypeError: fetch failed',
        '',
        'Caused by: Error: connect ECONNREFUSED 127.0.0.1:5432 (ECONNREFUSED)',
        'Error: connect ECONNREFUSED 127.0.0.1:5432',
        '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16)',
      ].join('\n'),
      hint: '',
      code: '',
    };
    const text = nonErrorText(shape);
    expect(text).toBe(
      'TypeError: fetch failed (cause: Error: connect ECONNREFUSED 127.0.0.1:5432 (ECONNREFUSED))',
    );
    expect(text).not.toContain('    at ');
    expect(asReportableError(shape).stack).not.toContain('afterConnect');
  });

  it('a cut to length that falls inside a share token leaves no part of it', () => {
    const lead = `${'x'.repeat(478)} /orders/sign/`;
    // The 500-character cut falls 8 characters into the token.
    expect(lead.length + 8).toBe(500);
    const text = nonErrorText({ message: `${lead}${SHARE_TOKEN} was refused`, code: 'P0001' });
    for (const run of runsOf(SHARE_TOKEN)) expect(text).not.toContain(run);
  });

  it("a cut to length that falls inside a token's payload leaves no part of it", () => {
    const lead = `${'y'.repeat(445)} Bearer `;
    const [header, payload] = SIGNED_URL_JWT.split('.');
    // The 500-character cut falls inside the second of the token's three parts.
    const payloadStart = lead.length + header!.length + 1;
    expect(payloadStart).toBeLessThan(500);
    expect(payloadStart + payload!.length).toBeGreaterThan(500);
    const text = nonErrorText({ message: `${lead}${SIGNED_URL_JWT} rejected` });
    for (const run of runsOf(SIGNED_URL_JWT)) expect(text).not.toContain(run);
  });

  it("a hint that carries a signed URL loses the URL's token", () => {
    const text = nonErrorText({
      message: 'object not found',
      code: 'P0001',
      hint: `Sign again: https://supabase.example.test/storage/v1/object/sign/b/p.jpg?token=${SIGNED_URL_JWT}`,
    });
    expect(text).toContain('hint: Sign again');
    for (const run of runsOf(SIGNED_URL_JWT)) expect(text).not.toContain(run);
  });

  it('a 200-character cut that falls inside a share token in a hint leaves no part of it', () => {
    const lead = `${'h'.repeat(178)} /orders/sign/`;
    // The hint's 200-character cut falls 8 characters into the token.
    expect(lead.length + 8).toBe(200);
    const refusal = {
      message: 'signature refused',
      code: 'P0001',
      hint: `${lead}${SHARE_TOKEN} x`,
    };
    const made = asReportableError(refusal);
    expect(made.message).toContain(`hint: ${lead}`);
    expect(made.message).toMatch(/…\)$/);
    for (const text of [nonErrorText(refusal), made.message, made.stack ?? '']) {
      for (const run of runsOf(SHARE_TOKEN)) expect(text).not.toContain(run);
    }
  });

  it('a 200-character cut that falls inside a share token in a cause line leaves no part of it', () => {
    const cause = `Error: ${'c'.repeat(171)} /orders/sign/`;
    // The cause's 200-character cut falls 8 characters into the token.
    expect(cause.length + 8).toBe(200);
    const shape = {
      message: 'TypeError: fetch failed',
      details: `TypeError: fetch failed\n\nCaused by: ${cause}${SHARE_TOKEN} x`,
      hint: '',
      code: '',
    };
    const made = asReportableError(shape);
    expect(made.message).toContain(`cause: ${cause}`);
    expect(made.message).toMatch(/…\)$/);
    for (const text of [nonErrorText(shape), made.message, made.stack ?? '']) {
      for (const run of runsOf(SHARE_TOKEN)) expect(text).not.toContain(run);
    }
  });

  it.each([
    ['a server error with a code', '42501'],
    ['a value with no code', undefined],
  ])("%s never gives up a 'Caused by:' line from its details", (_label, code) => {
    // Only postgrest-js's own no-answer shape (code '') has a cause line to keep.
    const refusal = {
      message: 'permission denied for table order_signatures',
      code,
      details: 'x\n\nCaused by: Error: someone@example.com',
      hint: null,
    };
    const made = asReportableError(refusal);
    for (const text of [nonErrorText(refusal), made.message, made.stack ?? '']) {
      expect(text).not.toContain('someone@example.com');
      expect(text).not.toContain('Caused by');
      expect(text).not.toContain('cause:');
    }
  });
});

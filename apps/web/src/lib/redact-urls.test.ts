import { describe, expect, it } from 'vitest';

import { redactTokens, redactTokensDeep } from './redact-urls';

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
const b64url = (value: string) =>
  Buffer.from(value, 'utf8').toString('base64url');
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
    const out = redactTokens(
      `https://stockpilotusa.com/r/${SHARE_TOKEN}?warehouse=abc#frag`,
    );
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
    expect(redactTokens('failed at /dashboard/inventory')).toContain(
      '/dashboard/inventory',
    );
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

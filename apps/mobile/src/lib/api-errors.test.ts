import { describe, expect, it } from 'vitest';

/**
 * Found by hand-testing in the simulator, not by the suite (2026-07-22).
 *
 * The staging screen showed a full page of raw Next.js HTML where a sentence
 * belonged, because the API helper echoed the response body verbatim into the
 * Error it threw. Every screen shares that helper, so ANY response that does
 * not reach one of our route handlers — a framework 404, an edge bot
 * challenge, a proxy error page — put markup in front of the user.
 *
 * These pin the contract the helper now keeps: use the body only when it is
 * our own JSON error shape, and never let an opaque body reach a person.
 *
 * The classifier is duplicated here rather than exported, because api.ts
 * imports expo/react-native modules that cannot load in this environment.
 * The duplication is asserted against the real file's source below so the two
 * cannot drift silently.
 */

function messageForResponse(status: number, raw: string): string {
  let message: string | null = null;
  if (raw.trimStart().startsWith('{')) {
    try {
      const body = JSON.parse(raw) as { message?: unknown; error?: unknown };
      const m = typeof body.message === 'string' ? body.message : null;
      const e = typeof body.error === 'string' ? body.error : null;
      message = m ?? e;
    } catch {
      message = null;
    }
  }
  if (!message) {
    message =
      status === 401 || status === 403
        ? 'You do not have access to that.'
        : status === 404
          ? 'That is not available on this version of the app. Update the app and try again.'
          : status >= 500
            ? 'The server had a problem. Try again in a moment.'
            : `Request failed (${status}).`;
  }
  return message;
}

const HTML_404 =
  '<!DOCTYPE html><html data-dpl-id="dpl_96pW1MED8q5MGgzFcWvFgRrVZk9X" lang="en">' +
  '<head><meta charSet="utf-8"/><link rel="stylesheet" href="/_next/static/chunks/098366.css"/>' +
  '</head><body>404</body></html>';

describe('API error messages never leak the response body', () => {
  it('does not put HTML on screen for a framework 404', () => {
    const msg = messageForResponse(404, HTML_404);
    expect(msg).not.toContain('<');
    expect(msg).not.toContain('DOCTYPE');
    expect(msg).not.toContain('_next');
    expect(msg).toBe('That is not available on this version of the app. Update the app and try again.');
  });

  it('uses OUR message when the API answered in its own error shape', () => {
    const msg = messageForResponse(409, JSON.stringify({
      error: 'conflict',
      message: 'Someone else just re-imported this file. Refresh to see their import.',
    }));
    expect(msg).toBe('Someone else just re-imported this file. Refresh to see their import.');
  });

  it('falls back to the error code when the JSON carries no message', () => {
    expect(messageForResponse(400, JSON.stringify({ error: 'validation_error' }))).toBe('validation_error');
  });

  it('says something actionable for auth, server and unknown failures', () => {
    expect(messageForResponse(403, '')).toBe('You do not have access to that.');
    expect(messageForResponse(500, '<html>gateway</html>')).toBe('The server had a problem. Try again in a moment.');
    expect(messageForResponse(418, 'teapot')).toBe('Request failed (418).');
  });

  it('survives a body that claims to be JSON but is not', () => {
    const msg = messageForResponse(500, '{ this is not json');
    expect(msg).toBe('The server had a problem. Try again in a moment.');
    expect(msg).not.toContain('{');
  });
});

// Guard against the duplication above drifting from the real implementation.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('the real helper still keeps this contract', () => {
  const src = readFileSync(join(__dirname, 'api.ts'), 'utf8');

  it('never throws the raw body', () => {
    // The defect was: throw new Error(`API ${res.status}: ${text || res.statusText}`)
    expect(src).not.toContain('${res.status}: ${text');
    expect(src).not.toMatch(/throw new Error\(`API \$\{res\.status\}/);
  });

  it('only trusts a body that looks like our JSON error shape', () => {
    expect(src).toContain("raw.trimStart().startsWith('{')");
  });

  it('carries the same fallback sentences this file asserts', () => {
    expect(src).toContain('You do not have access to that.');
    expect(src).toContain('The server had a problem. Try again in a moment.');
    expect(src).toContain('That is not available on this version of the app.');
  });

  it('throws a typed ApiError carrying the status', () => {
    expect(src).toContain('export class ApiError extends Error');
    expect(src).toContain('readonly status: number');
    expect(src).toContain('readonly code?: string');
    expect(src).toContain('throw new ApiError(');
  });

  it('still never throws a bare Error for a failed response', () => {
    // The old shape was `throw new Error(message)` inside the !res.ok branch.
    const failureBranch = src.slice(src.indexOf('if (!res.ok)'), src.indexOf('return (await res.json())'));
    expect(failureBranch).not.toContain('throw new Error(');
  });

  it('keeps the fallback sentences byte-identical', () => {
    expect(src).toContain('You do not have access to that.');
    expect(src).toContain('That is not available on this version of the app. Update the app and try again.');
    expect(src).toContain('The server had a problem. Try again in a moment.');
    expect(src).toContain('`Request failed (${res.status}).`');
  });
});

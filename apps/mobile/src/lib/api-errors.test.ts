import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readErrorBody, statusSentence } from './api-error-body';

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
 * The reader and the sentences are api-error-body.ts, shared by api() and the
 * AI chat (which posts with fetch itself, docket B75), and these run them as
 * they are. They used to run a copy kept here, because api.ts was thought
 * unable to load in this environment; api-error-details.test.ts has loaded it
 * with five mocks since 2026-08-12, and runs these answers through api().
 */

const HTML_404 =
  '<!DOCTYPE html><html data-dpl-id="dpl_96pW1MED8q5MGgzFcWvFgRrVZk9X" lang="en">' +
  '<head><meta charSet="utf-8"/><link rel="stylesheet" href="/_next/static/chunks/098366.css"/>' +
  '</head><body>404</body></html>';

const NOTHING = { message: null, code: undefined, details: undefined };

describe('API error messages never leak the response body', () => {
  it('does not put HTML on screen for a framework 404', () => {
    expect(readErrorBody(HTML_404)).toEqual(NOTHING);
    const msg = statusSentence(404);
    expect(msg).not.toContain('<');
    expect(msg).not.toContain('DOCTYPE');
    expect(msg).not.toContain('_next');
    expect(msg).toBe(
      'That is not available on this version of the app. Update the app and try again.',
    );
  });

  it('uses OUR message when the API answered in its own error shape', () => {
    const body = readErrorBody(
      JSON.stringify({
        error: 'conflict',
        message: 'Someone else just re-imported this file. Refresh to see their import.',
      }),
    );
    expect(body.message).toBe(
      'Someone else just re-imported this file. Refresh to see their import.',
    );
    expect(body.code).toBe('conflict');
  });

  // api() shows the code when there is no message (api-error-details.test.ts);
  // the AI chat never does (ai-chat.test.ts).
  it('reads the error code apart from the message', () => {
    expect(readErrorBody(JSON.stringify({ error: 'validation_error' }))).toEqual({
      ...NOTHING,
      code: 'validation_error',
    });
  });

  it('carries the details blob uninspected', () => {
    const details = { reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION', items: [] };
    expect(
      readErrorBody(JSON.stringify({ error: 'conflict', message: 'm', details })).details,
    ).toEqual(details);
  });

  it('says something actionable for auth, server and unknown failures', () => {
    expect(readErrorBody('')).toEqual(NOTHING);
    expect(statusSentence(401)).toBe('You do not have access to that.');
    expect(statusSentence(403)).toBe('You do not have access to that.');
    expect(readErrorBody('<html>gateway</html>')).toEqual(NOTHING);
    expect(statusSentence(500)).toBe('The server had a problem. Try again in a moment.');
    expect(statusSentence(502)).toBe('The server had a problem. Try again in a moment.');
    expect(readErrorBody('teapot')).toEqual(NOTHING);
    expect(statusSentence(418)).toBe('Request failed (418).');
  });

  it('survives a body that claims to be JSON but is not', () => {
    expect(readErrorBody('{ this is not json')).toEqual(NOTHING);
  });

  it('reads only text: a message or code of another type is not one', () => {
    expect(readErrorBody(JSON.stringify({ error: 42, message: { text: 'x' } }))).toEqual(NOTHING);
    expect(readErrorBody('  {"message":"Slow down."}').message).toBe('Slow down.');
  });
});

describe('the real helper still keeps this contract', () => {
  const src = readFileSync(join(__dirname, 'api.ts'), 'utf8');
  const reader = readFileSync(join(__dirname, 'api-error-body.ts'), 'utf8');

  it('never throws the raw body', () => {
    // The defect was: throw new Error(`API ${res.status}: ${text || res.statusText}`)
    expect(src).not.toContain('${res.status}: ${text');
    expect(src).not.toMatch(/throw new Error\(`API \$\{res\.status\}/);
  });

  it('only trusts a body that looks like our JSON error shape', () => {
    expect(reader).toContain("raw.trimStart().startsWith('{')");
  });

  // One reader and one set of sentences: a copy fixed alone is not a fix
  // (recurring pattern 26).
  it('reads the body and words the failure only through api-error-body.ts', () => {
    expect(src).toContain("import { readErrorBody, statusSentence } from './api-error-body';");
    const failureBranch = src.slice(
      src.indexOf('if (!res.ok)'),
      src.indexOf('return (await res.json())'),
    );
    expect(failureBranch).toContain('readErrorBody(raw)');
    expect(failureBranch).toContain('statusSentence(res.status)');
    expect(src).not.toContain("startsWith('{')");
    expect(src).not.toContain('You do not have access to that.');
  });

  it('throws a typed ApiError carrying the status', () => {
    expect(src).toContain('export class ApiError extends Error');
    expect(src).toContain('readonly status: number');
    expect(src).toContain('readonly code?: string');
    expect(src).toContain('throw new ApiError(');
  });

  it('still never throws a bare Error for a failed response', () => {
    // The old shape was `throw new Error(message)` inside the !res.ok branch.
    const failureBranch = src.slice(
      src.indexOf('if (!res.ok)'),
      src.indexOf('return (await res.json())'),
    );
    expect(failureBranch).not.toContain('throw new Error(');
  });

  it('keeps the fallback sentences byte-identical', () => {
    expect(reader).toContain('You do not have access to that.');
    expect(reader).toContain(
      'That is not available on this version of the app. Update the app and try again.',
    );
    expect(reader).toContain('The server had a problem. Try again in a moment.');
    expect(reader).toContain('`Request failed (${status}).`');
  });
});

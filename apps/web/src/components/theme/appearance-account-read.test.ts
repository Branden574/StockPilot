import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCOUNT_APPEARANCE_ROUTE, readAccountAppearance } from './appearance-account-read';

/**
 * The browser's read of the signed-in person's account row: one plain request
 * to POST /api/appearance/account (never a server action: one pending on load
 * holds the hydration of the page's streamed content and a client redirect;
 * measured 2026-11-11). It answers what the route answered, and anything it
 * cannot take as that answer (another status, a body that is not the answer,
 * a request that never finished) is a quiet `error`: it never rejects, logs
 * nothing and reports nothing, so a request torn down by a navigation is
 * silent.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ROW = { style: 'classic', theme: 'dark', updated_at: '2026-11-02T10:00:00.000001+00:00' };
const FAILED = { ok: false, reason: 'error' };

let fetchMock: ReturnType<typeof vi.fn>;
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  expect(consoleError).not.toHaveBeenCalled();
  expect(consoleWarn).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('readAccountAppearance', () => {
  it('sends one same-origin POST with the appearance header, the id in the body and nothing in the URL', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, userId: USER, row: ROW }));
    expect(await readAccountAppearance(USER)).toEqual({ ok: true, userId: USER, row: ROW });
    expect(ACCOUNT_APPEARANCE_ROUTE).toBe('/api/appearance/account');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/appearance/account');
    expect(url).not.toContain(USER);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-sp-appearance': '1' });
    expect(JSON.parse(String(init.body))).toEqual({ userId: USER });
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
  });

  it('answers a null row for a person who never chose on an account', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, userId: USER, row: null }));
    expect(await readAccountAppearance(USER)).toEqual({ ok: true, userId: USER, row: null });
  });

  it.each(['missing-table', 'unauthenticated', 'invalid', 'error'])(
    'hands on the reason %s as the route gave it',
    async (reason) => {
      fetchMock.mockResolvedValue(json({ ok: false, reason }));
      expect(await readAccountAppearance(USER)).toEqual({ ok: false, reason });
    },
  );

  it.each([
    ['403 with no body', () => new Response(null, { status: 403 })],
    ['400 with the invalid answer', () => json({ ok: false, reason: 'invalid' }, 400)],
    ['500', () => new Response('Internal Server Error', { status: 500 })],
    ['204', () => new Response(null, { status: 204 })],
    // Another status never counts, whatever its body says.
    ['201 with a row', () => json({ ok: true, userId: USER, row: ROW }, 201)],
    ['404 with missing-table', () => json({ ok: false, reason: 'missing-table' }, 404)],
  ])('any answer but 200 is an error: %s', async (_name, response) => {
    fetchMock.mockResolvedValue(response());
    expect(await readAccountAppearance(USER)).toEqual(FAILED);
  });

  it.each([
    ['a sign-in page', () => new Response('<!doctype html><title>Sign in</title>')],
    ['an empty body', () => new Response('')],
    ['null', () => json(null)],
    ['a list', () => json([{ ok: true }])],
    ['no ok', () => json({ userId: USER, row: ROW })],
    ['ok without a user id', () => json({ ok: true, row: ROW })],
    ['ok without a row', () => json({ ok: true, userId: USER })],
    ['a row that is not an object', () => json({ ok: true, userId: USER, row: 'classic' })],
    ['a reason it does not know', () => json({ ok: false, reason: 'teapot' })],
    ['no reason', () => json({ ok: false })],
  ])('a 200 that is not the answer is an error: %s', async (_name, response) => {
    fetchMock.mockResolvedValue(response());
    expect(await readAccountAppearance(USER)).toEqual(FAILED);
  });

  it.each([
    ['the network failed', () => new TypeError('Failed to fetch')],
    ['a navigation tore the request down', () => new TypeError('Load failed')],
    ['the request was aborted', () => new DOMException('The operation was aborted.', 'AbortError')],
  ])('never rejects and says nothing when %s', async (_name, failure) => {
    fetchMock.mockRejectedValue(failure());
    await expect(readAccountAppearance(USER)).resolves.toEqual(FAILED);
  });

  it('is an error when the body stops before it is whole', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      json: () => Promise.reject(new TypeError('network error')),
    });
    await expect(readAccountAppearance(USER)).resolves.toEqual(FAILED);
  });
});

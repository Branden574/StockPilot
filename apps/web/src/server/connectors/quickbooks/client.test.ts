import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectorSecrets } from '@stockpilot/core';

import { QboClient } from './client';

const secrets: ConnectorSecrets = {
  accessToken: 'tok-abc',
  refreshToken: 'ref-abc',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

type FetchCall = [string | URL, RequestInit];

describe('QboClient', () => {
  let fetchSpy: ReturnType<typeof vi.fn<(input: string | URL, init: RequestInit) => Promise<Response>>>;

  const callAt = (i: number): FetchCall => fetchSpy.mock.calls[i] as unknown as FetchCall;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('post() uses the sandbox base URL, minorversion=75, RequestId and Bearer header', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ Bill: { Id: '42' } }));
    const client = new QboClient('realm-1', secrets, 'sandbox');

    const out = await client.post('/bill', { foo: 'bar' }, 'rcpt-99');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = callAt(0);
    const url = new URL(String(calledUrl));
    expect(url.origin).toBe('https://sandbox-quickbooks.api.intuit.com');
    expect(url.pathname).toBe('/v3/company/realm-1/bill');
    expect(url.searchParams.get('minorversion')).toBe('75');
    expect(url.searchParams.get('requestid')).toBe('rcpt-99');

    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-abc');
    expect(headers.Accept).toBe('application/json');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ foo: 'bar' }));

    expect(out).toEqual({ Bill: { Id: '42' } });
  });

  it('uses the production base URL when env=production', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new QboClient('realm-2', secrets, 'production');

    await client.post('/journalentry', {}, 'req-1');

    const url = new URL(String(callAt(0)[0]));
    expect(url.origin).toBe('https://quickbooks.api.intuit.com');
  });

  it('query() issues a GET to /query with the select statement and minorversion', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ QueryResponse: { Vendor: [] } }));
    const client = new QboClient('realm-3', secrets, 'sandbox');

    await client.query("select * from Vendor where DisplayName = 'Acme'");

    const [calledUrl, init] = callAt(0);
    const url = new URL(String(calledUrl));
    expect(url.pathname).toBe('/v3/company/realm-3/query');
    expect(url.searchParams.get('minorversion')).toBe('75');
    expect(url.searchParams.get('query')).toBe(
      "select * from Vendor where DisplayName = 'Acme'",
    );
    expect((init?.method ?? 'GET')).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-abc');
  });

  it('throws with status + intuit_tid on a non-OK response, without logging tokens', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        { Fault: { Error: [{ Message: 'boom' }] } },
        { status: 400, headers: { intuit_tid: 'tid-xyz' } },
      ),
    );
    const client = new QboClient('realm-4', secrets, 'sandbox');

    const err = await client.post('/bill', {}, 'r').then(
      () => null,
      (e) => e as Error & { status?: number; intuitTid?: string },
    );

    expect(err).not.toBeNull();
    expect(err!.message).toContain('400');
    expect(err!.message).toContain('tid-xyz');
    expect((err as { status?: number }).status).toBe(400);
    // The Bearer token must never appear in the surfaced error.
    expect(err!.message).not.toContain('tok-abc');
  });
});

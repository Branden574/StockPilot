import { describe, expect, it } from 'vitest';

import {
  bodyShape,
  classifyRequest,
  compareLoads,
  holdsDocument,
  jsonShape,
  type NetRequest,
} from '../../tests/e2e/appearance/stage5a-network';

/** The plan 8.5 network-parity rule network-parity.spec.ts applies on the lab. */

const APP = 'http://127.0.0.1:3410';
const DB = 'http://127.0.0.1:55421';
const USER = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

const req = (
  method: string,
  url: string,
  headers: Record<string, string> = {},
  postData: string | null = null,
): NetRequest => ({
  method,
  url: url.startsWith('/') ? `${APP}${url}` : url,
  headers,
  postData,
});

describe('stage 5 network parity', () => {
  it('writes a JSON body as its shape', () => {
    expect(jsonShape({ b: 1, a: ['x', 'y'], c: null })).toBe('{"a":[string],"b":number,"c":null}');
    expect(bodyShape('[{"id":"1","qty":2}]', 'text/plain')).toBe('[{"id":string,"qty":number}]');
    expect(bodyShape('a=1&b=2&a=3', 'application/x-www-form-urlencoded')).toBe('form(a,b)');
    expect(bodyShape(null, undefined)).toBe('-');
  });

  it('leaves out static files, scene photos, analytics, the cookie route and the account save', () => {
    const ignored = [
      req('GET', '/_next/static/chunks/abc.js'),
      req('GET', '/liquid-glass/scene-day.avif'),
      req('GET', 'https://eu.i.posthog.com/e/'),
      req('POST', '/monitoring?o=1'),
      req('POST', '/api/appearance/style', {}, '{"style":"liquid-glass"}'),
      req(
        'POST',
        '/dashboard',
        { 'next-action': 'aa11' },
        JSON.stringify([{ userId: USER, style: 'classic' }]),
      ),
    ];
    for (const r of ignored) expect(classifyRequest(r, APP).kind, r.url).toBe('ignore');
  });

  it('keys a data request by method, place, action and body shape; drops _rsc and the moment in a filter', () => {
    expect(
      classifyRequest(req('GET', '/dashboard/inventory?_rsc=1x2y&b=2&a=1', { rsc: '1' }), APP),
    ).toEqual({
      kind: 'data',
      key: 'GET /dashboard/inventory?a=1&b=2 rsc -',
    });
    expect(
      classifyRequest(
        req('GET', `${DB}/rest/v1/items?updated_at=gte.2031-04-15T10:11:12.345Z&select=id`),
        APP,
      ),
    ).toEqual({
      kind: 'data',
      key: 'GET 127.0.0.1:55421/rest/v1/items?select=id&updated_at=gte.<time> -',
    });
    expect(
      classifyRequest(
        req('POST', '/dashboard', { 'next-action': 'bb22' }, JSON.stringify([USER])),
        APP,
      ),
    ).toEqual({
      kind: 'data',
      key: 'POST /dashboard action bb22 [string]',
    });
    expect(
      classifyRequest(
        req('GET', '/dashboard/books', { 'next-router-prefetch': '1', rsc: '1' }),
        APP,
      ),
    ).toEqual({
      kind: 'prefetch',
      path: '/dashboard/books',
    });
  });

  it('passes equal loads and fails a request only one look makes, a changed body shape, a stray prefetch', () => {
    const shared = [
      req('GET', `${DB}/rest/v1/items?select=id`),
      req('GET', '/liquid-glass/scene-night.avif'),
    ];
    expect(
      compareLoads(shared, [...shared, req('GET', '/_next/static/css/glass.css')], APP, []),
    ).toEqual({
      onlyClassic: [],
      onlyGlass: [],
      strayPrefetches: [],
    });
    const extra = compareLoads(
      shared,
      [...shared, req('GET', `${DB}/rest/v1/orders?select=id`)],
      APP,
      [],
    );
    expect(extra.onlyGlass).toEqual(['GET 127.0.0.1:55421/rest/v1/orders?select=id -']);
    const action = (body: unknown) =>
      req('POST', '/dashboard', { 'next-action': 'cc33' }, JSON.stringify(body));
    const shape = compareLoads([action([{ a: 1 }])], [action([{ a: 1, b: 2 }])], APP, []);
    expect(shape.onlyClassic).toHaveLength(1);
    expect(shape.onlyGlass).toHaveLength(1);
    const prefetch = (path: string) => req('GET', path, { 'next-router-prefetch': '1' });
    expect(
      compareLoads([], [prefetch('/dashboard/books')], APP, ['/dashboard/books']).strayPrefetches,
    ).toEqual([]);
    expect(
      compareLoads([], [prefetch('/dashboard/team')], APP, ['/dashboard/books']).strayPrefetches,
    ).toEqual(['/dashboard/team']);
  });

  it('ignores only the action id the first appearance save used: a save-shaped body on another action is data', () => {
    const save = (action: string, style: string) =>
      req(
        'POST',
        '/dashboard',
        { 'next-action': action },
        JSON.stringify([{ userId: USER, style }]),
      );
    // One save, its action id fixed: ignored in either look.
    expect(compareLoads([], [save('aa11', 'liquid-glass')], APP, [])).toEqual({
      onlyClassic: [],
      onlyGlass: [],
      strayPrefetches: [],
    });
    // A second action id sending a save-shaped body is another action: data.
    const other = compareLoads(
      [],
      [save('aa11', 'liquid-glass'), save('ff99', 'classic')],
      APP,
      [],
    );
    expect(other.onlyGlass).toEqual([
      'POST /dashboard action ff99 [{"style":string,"userId":string}]',
    ]);
  });

  it('a load must hold its own document request, so a recorder that saw nothing cannot pass', () => {
    const doc = req('GET', '/dashboard/inventory');
    expect(
      holdsDocument(
        [doc, req('GET', `${DB}/rest/v1/items?select=id`)],
        APP,
        '/dashboard/inventory',
      ),
    ).toBe(true);
    expect(holdsDocument([], APP, '/dashboard/inventory')).toBe(false);
    // An RSC fetch of the path is not the document.
    expect(
      holdsDocument(
        [req('GET', '/dashboard/inventory?_rsc=1', { rsc: '1' })],
        APP,
        '/dashboard/inventory',
      ),
    ).toBe(false);
    expect(holdsDocument([req('GET', '/dashboard')], APP, '/dashboard/inventory')).toBe(false);
  });
});

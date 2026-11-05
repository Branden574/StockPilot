import { describe, expect, it } from 'vitest';

import {
  isAppearanceSaveBody,
  switchRequestFilter,
  type SeenRequest,
} from '../../tests/e2e/appearance/switch-requests';

/**
 * The requests a look switch may make (Liquid Glass plan 8.2), as the orders
 * lane's transition specs judge them: the account save and nothing else of
 * the server actions, the Design cookie route, the scene photos and static
 * files, analytics, and a prefetch of a link the page already held.
 */

const ORIGIN = 'https://app.example.test';
const PAGE = `${ORIGIN}/dashboard/orders?status=all_active`;
const USER = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const SAVE_ID = '7f00aa11bb22cc33dd44ee55ff6677889900aabb';
const OTHER_ID = '40aa11bb22cc33dd44ee55ff6677889900aabbcc';

function post(body: string, action: string | null, path = '/dashboard/orders'): SeenRequest {
  return {
    method: 'POST',
    url: `${ORIGIN}${path}`,
    headers: action ? { 'next-action': action } : {},
    postData: body,
  };
}

function get(path: string, headers: Record<string, string> = {}): SeenRequest {
  return {
    method: 'GET',
    url: path.startsWith('/') ? `${ORIGIN}${path}` : path,
    headers,
    postData: null,
  };
}

const saveBody = (input: Record<string, unknown>) => JSON.stringify([input]);

function filter() {
  return switchRequestFilter({
    pageUrl: PAGE,
    linkHrefs: [
      '/dashboard/orders/0b1c2d3e-0000-4000-8000-000000000001',
      '/dashboard/orders?status=needs_approval',
      'https://help.example.test/orders',
    ],
  });
}

describe('isAppearanceSaveBody', () => {
  it('reads setMyAppearanceAction’s one argument: a Design, a Theme or both', () => {
    expect(isAppearanceSaveBody(saveBody({ userId: USER, style: 'liquid-glass' }))).toBe(true);
    expect(isAppearanceSaveBody(saveBody({ userId: USER, theme: 'dark' }))).toBe(true);
    expect(
      isAppearanceSaveBody(saveBody({ userId: USER, style: 'classic', theme: 'system' })),
    ).toBe(true);
    // React writes a present-but-undefined property as "$undefined".
    expect(
      isAppearanceSaveBody(saveBody({ userId: USER, style: 'classic', theme: '$undefined' })),
    ).toBe(true);
  });

  it('refuses any other shape', () => {
    expect(isAppearanceSaveBody(null)).toBe(false);
    expect(isAppearanceSaveBody('not json')).toBe(false);
    // getMyAppearanceAction(userId): the account read.
    expect(isAppearanceSaveBody(JSON.stringify([USER]))).toBe(false);
    expect(isAppearanceSaveBody(saveBody({ userId: USER }))).toBe(false);
    expect(isAppearanceSaveBody(saveBody({ userId: 'someone', style: 'classic' }))).toBe(false);
    expect(isAppearanceSaveBody(saveBody({ userId: USER, style: 'neon' }))).toBe(false);
    expect(isAppearanceSaveBody(saveBody({ userId: USER, theme: 'dim' }))).toBe(false);
    expect(isAppearanceSaveBody(saveBody({ userId: USER, style: 'classic', orderId: 'o-1' }))).toBe(
      false,
    );
    expect(
      isAppearanceSaveBody(
        JSON.stringify([
          { userId: USER, style: 'classic' },
          { userId: USER, theme: 'dark' },
        ]),
      ),
    ).toBe(false);
  });
});

describe('switchRequestFilter', () => {
  it('allows the save, and later saves under the same action id only', () => {
    const rules = filter();
    expect(rules.verdict(post(saveBody({ userId: USER, style: 'liquid-glass' }), SAVE_ID))).toBe(
      null,
    );
    expect(rules.verdict(post(saveBody({ userId: USER, theme: 'light' }), SAVE_ID))).toBe(null);
    expect(rules.verdict(post(saveBody({ userId: USER, theme: 'light' }), OTHER_ID))).toMatch(
      /not the save's/u,
    );
  });

  it('counts every other server action: the account read, a submission read, any write', () => {
    const rules = filter();
    expect(rules.verdict(post(JSON.stringify([USER]), OTHER_ID))).toBe(`server action ${OTHER_ID}`);
    expect(
      rules.verdict(
        post(JSON.stringify([{ orderRequestId: 'o-1' }]), OTHER_ID, '/dashboard/orders/new'),
      ),
    ).toMatch(/^server action /u);
    // The first save-shaped action fixes the id, so a later true save under
    // another id is counted too.
    expect(rules.verdict(post(saveBody({ userId: USER, style: 'classic' }), SAVE_ID))).toBe(null);
    expect(rules.verdict(post(saveBody({ userId: USER, style: 'classic' }), OTHER_ID))).not.toBe(
      null,
    );
  });

  it('counts a refresh of the page and a prefetch of the page itself', () => {
    const rules = filter();
    expect(rules.verdict(get('/dashboard/orders?status=all_active&_rsc=1a2b', { rsc: '1' }))).toBe(
      'a data request',
    );
    expect(
      rules.verdict(
        get('/dashboard/orders?status=needs_approval&_rsc=1a2b', {
          rsc: '1',
          'next-router-prefetch': '1',
        }),
      ),
    ).toBe('a prefetch of the page itself');
  });

  it('allows a prefetch of a link the page held, and counts one of any other path', () => {
    const rules = filter();
    const prefetch = { rsc: '1', 'next-router-prefetch': '1' };
    expect(
      rules.verdict(
        get('/dashboard/orders/0b1c2d3e-0000-4000-8000-000000000001?_rsc=9z', prefetch),
      ),
    ).toBe(null);
    expect(rules.verdict(get('/dashboard/items?_rsc=9z', prefetch))).toMatch(
      /no link on the page named/u,
    );
  });

  it('allows the cookie route, the scene photos, static files and analytics; counts data reads', () => {
    const rules = filter();
    expect(rules.verdict(post('{"style":"classic"}', null, '/api/appearance/style'))).toBe(null);
    expect(rules.verdict(get('/liquid-glass/scene-day.avif'))).toBe(null);
    expect(rules.verdict(get('/_next/static/css/app.css'))).toBe(null);
    expect(rules.verdict(get('https://eu.i.posthog.com/e/'))).toBe(null);
    expect(rules.verdict(post('envelope', null, '/monitoring?o=1&p=2'))).toBe(null);
    expect(rules.verdict(get('data:image/png;base64,AAAA'))).toBe(null);
    expect(rules.verdict(get('/api/orders/export?format=csv'))).toBe('a data request');
    expect(rules.verdict(get('/api/appearance/style'))).toBe('a data request');
    expect(rules.verdict(get('https://db.example.test/rest/v1/order_requests'))).toBe(
      'a request to another host',
    );
  });
});

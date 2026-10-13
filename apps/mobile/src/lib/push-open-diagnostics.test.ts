import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseNotificationLink } from './notification-link';
import {
  PUSH_OPEN_ROUTE_KINDS,
  PUSH_OPEN_STAGES,
  errorClassOf,
  pushOpenDiag,
  sanitizePushOpenEvent,
} from './push-open-diagnostics';

// The real module writes Sentry breadcrumbs; @sentry/react-native cannot load
// under node, so the Sentry namespace it imports is replaced and recorded.
const sentry = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('./sentry', () => ({ Sentry: sentry }));

/**
 * Push-open diagnostics (Phase 3). The tap path used to swallow every failure
 * with `.catch(() => {})`; it now leaves sanitised breadcrumbs. Only fixed keys
 * with values from fixed enums leave the phone: never the link, a uuid, the
 * title or body, a user or org id, or a push token.
 */

const RMA = '22222222-2222-4222-8222-222222222222';
const ORDER = '11111111-1111-4111-8111-111111111111';
const USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DUAL = `/dashboard/returns/${RMA}?order=/dashboard/orders/${ORDER}`;
const TITLE = 'New exchange request from Jordan Example';
const BODY = 'SO-000031 needs a replacement for 2 shirts';
const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const ALLOWED_KEYS = ['stage', 'source', 'linkKind', 'routeKind', 'reason', 'errorClass'];

const breadcrumbs = () =>
  sentry.addBreadcrumb.mock.calls.map(
    ([crumb]) => crumb as { category: string; level: string; data: Record<string, string> },
  );

beforeEach(() => {
  sentry.addBreadcrumb.mockClear();
  sentry.captureException.mockClear();
});

afterEach(() => {
  delete (globalThis as { __DEV__?: boolean }).__DEV__;
  vi.restoreAllMocks();
});

describe('each stage leaves one breadcrumb with allowlisted keys only', () => {
  it.each(PUSH_OPEN_STAGES)('%s', (stage) => {
    pushOpenDiag({
      stage,
      source: 'listener',
      linkKind: 'relative',
      routeKind: 'order',
      reason: 'duplicate',
    });
    expect(breadcrumbs()).toEqual([
      {
        category: 'push.open',
        level: 'info',
        data: {
          stage,
          source: 'listener',
          linkKind: 'relative',
          routeKind: 'order',
          reason: 'duplicate',
        },
      },
    ]);
  });

  it('a value outside its enum is dropped, and an unknown stage sends nothing', () => {
    expect(
      sanitizePushOpenEvent({
        stage: 'navigate',
        source: 'push',
        linkKind: 'ftp',
        routeKind: 'dashboard',
        reason: 'because',
      }),
    ).toEqual({ stage: 'navigate' });
    pushOpenDiag({ stage: 'teleport' } as never);
    expect(breadcrumbs()).toEqual([]);
  });
});

describe('nothing private ever leaves the phone', () => {
  it('fed the dual link, a uuid, the title and body, a user id and a push token, it emits none of them', () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const poisoned = {
      stage: 'capture',
      source: DUAL,
      linkKind: TITLE,
      routeKind: RMA,
      reason: BODY,
      errorClass: TOKEN,
      link: DUAL,
      title: TITLE,
      body: BODY,
      userId: USER,
      orgId: ORDER,
      token: TOKEN,
    };
    pushOpenDiag(poisoned as never);
    pushOpenDiag({ stage: 'error', errorClass: `${USER}Error` });
    pushOpenDiag({ stage: 'navigate', routeKind: `/order/${ORDER}` });

    const emitted = JSON.stringify([breadcrumbs(), info.mock.calls]);
    expect(emitted).not.toMatch(UUID_ANYWHERE);
    expect(emitted).not.toContain('ExponentPushToken');
    expect(emitted).not.toContain('/dashboard');
    expect(emitted).not.toContain(TITLE);
    expect(emitted).not.toContain(BODY);
    for (const crumb of breadcrumbs()) {
      for (const key of Object.keys(crumb.data)) expect(ALLOWED_KEYS).toContain(key);
    }
    // The console line in development carries the same sanitised data.
    expect(info).toHaveBeenCalledWith('[push.open]', { stage: 'capture', errorClass: 'Error' });
  });

  it('errorClass is Error.name only, never the message', () => {
    expect(errorClassOf(new TypeError(`Network request failed for ${DUAL}`))).toBe('TypeError');
    const named = new Error(`token ${TOKEN}`);
    named.name = 'PostgrestError';
    expect(errorClassOf(named)).toBe('PostgrestError');
    expect(errorClassOf({ name: 'AbortError', message: DUAL })).toBe('AbortError');
    // Anything that is not a plain error-class name collapses to 'Error'.
    expect(errorClassOf(new Error(DUAL))).toBe('Error');
    expect(errorClassOf(`${TOKEN} failed`)).toBe('Error');
    expect(errorClassOf({ name: TOKEN })).toBe('Error');
    expect(errorClassOf({ name: `${RMA}Error` })).toBe('Error');
    expect(errorClassOf(null)).toBe('Error');
  });

  it('breadcrumbs only: no stage raises a Sentry event', () => {
    for (const stage of PUSH_OPEN_STAGES) {
      pushOpenDiag({ stage, reason: 'error', errorClass: 'TypeError' });
    }
    expect(breadcrumbs()).toHaveLength(PUSH_OPEN_STAGES.length);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('a failing Sentry call never breaks the tap', () => {
    sentry.addBreadcrumb.mockImplementationOnce(() => {
      throw new Error('sentry is down');
    });
    expect(() => pushOpenDiag({ stage: 'navigate', routeKind: 'order' })).not.toThrow();
  });
});

describe('the route kinds are the table outputs', () => {
  it('every native route a first-party link opens has its kind in the enum', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const links = [
      '/dashboard/orders/new',
      DUAL,
      '/dashboard/returns',
      `/dashboard/orders/${id}`,
      '/dashboard/inventory/staging',
      `/dashboard/inventory/${id}`,
      '/dashboard/inventory',
      `/dashboard/purchase-orders/${id}`,
      '/dashboard/purchase-orders',
      `/dashboard/cycle-counts/${id}`,
      `/dashboard/bundles/${id}`,
      '/dashboard/schedule',
      '/dashboard/insights',
      '/dashboard/support',
      '/dashboard/orders',
      '/dashboard/audit',
      `/dashboard/maintenance/${id}`,
      '/dashboard/maintenance/new',
      '/dashboard/maintenance',
      `/dashboard/exceptions/${id}`,
      '/dashboard/exceptions',
      `/dashboard/rentals/${id}`,
      '/dashboard/rentals/new',
      '/dashboard/rentals',
      `/dashboard/locations/${id}`,
      '/dashboard/locations',
      '/dashboard/reports/book-order-totals',
      '/dashboard/reports',
    ];
    for (const link of links) {
      const target = parseNotificationLink(link);
      expect(target.ok, link).toBe(true);
      if (target.ok) expect(PUSH_OPEN_ROUTE_KINDS, link).toContain(target.routeKind);
    }
  });
});

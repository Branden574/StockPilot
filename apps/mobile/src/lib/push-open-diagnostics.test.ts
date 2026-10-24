import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseNotificationLink } from './notification-link';
import {
  PUSH_OPEN_ROUTE_KINDS,
  PUSH_OPEN_STAGES,
  errorClassOf,
  pushOpenDiag,
  sanitizePushOpenEvent,
} from './push-open-diagnostics';

// The real module writes Sentry breadcrumbs, and one event for a failed step;
// @sentry/react-native cannot load under node, so the Sentry namespace it
// imports is replaced and recorded. withScope hands its callback one scope,
// and each captureMessage records whether it ran inside that callback (the
// only place the scope's breadcrumb filter applies).
const sentry = vi.hoisted(() => {
  const scope = { addEventProcessor: vi.fn() };
  const state = { insideScope: false, capturedInsideScope: [] as boolean[] };
  return {
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(() => {
      state.capturedInsideScope.push(state.insideScope);
    }),
    scope,
    state,
    withScope: vi.fn((callback: (s: typeof scope) => void) => {
      state.insideScope = true;
      try {
        return callback(scope);
      } finally {
        state.insideScope = false;
      }
    }),
  };
});
vi.mock('./sentry', () => ({ Sentry: sentry }));

/** A fresh copy of the module: what a failed step reported is per launch. */
async function freshDiagnostics() {
  vi.resetModules();
  return import('./push-open-diagnostics');
}

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
  sentry.captureMessage.mockClear();
  sentry.withScope.mockClear();
  sentry.scope.addEventProcessor.mockClear();
  sentry.state.capturedInsideScope.length = 0;
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
  it('fed the dual link, a uuid, the title and body, a user id and a push token, it emits none of them', async () => {
    const { pushOpenDiag } = await freshDiagnostics();
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
    pushOpenDiag({ stage: 'error', errorClass: `${USER}Error`, reason: BODY as never });
    pushOpenDiag({ stage: 'navigate', routeKind: `/order/${ORDER}` });

    // The failed step's Sentry event (review 4) is held to the same rule.
    const emitted = JSON.stringify([
      breadcrumbs(),
      info.mock.calls,
      sentry.captureMessage.mock.calls,
    ]);
    expect(sentry.captureMessage).toHaveBeenCalled();
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

  // 2026-10-24 (review 4): a failed step also raises one event. Was:
  // breadcrumbs only, which reach Sentry only with some later event, so a tap
  // that went nowhere still left no trace unless something else failed.
  it('every stage leaves its breadcrumb; only a failed step raises an event, and never an exception', async () => {
    const fresh = await freshDiagnostics();
    for (const stage of PUSH_OPEN_STAGES) {
      fresh.pushOpenDiag({ stage, reason: 'switch-failed', errorClass: 'TypeError' });
    }
    expect(breadcrumbs()).toHaveLength(PUSH_OPEN_STAGES.length);
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentry.captureMessage.mock.calls[0]![1]).toMatchObject({
      tags: { 'push.open.stage': 'error' },
    });
  });

  it('a failing Sentry call never breaks the tap', () => {
    sentry.addBreadcrumb.mockImplementationOnce(() => {
      throw new Error('sentry is down');
    });
    expect(() => pushOpenDiag({ stage: 'navigate', routeKind: 'order' })).not.toThrow();
  });
});

/**
 * Review 4 (2026-10-24): a breadcrumb reaches Sentry only with some later
 * event, and Sentry cannot search breadcrumbs across events, so a failed step
 * (a switch that did not take, a missing native function) left no trace
 * unless something else failed in the same session. A failed step now also
 * raises one event, at most once per launch for the same failure.
 */
describe('a failed step raises one Sentry event that can be found', () => {
  const SWITCH_FAILED = {
    stage: 'error',
    source: 'listener',
    reason: 'switch-failed',
    errorClass: 'TypeError',
  } as const;

  it('a fixed message, the sanitised values as tags, one issue per reason, at warning level', async () => {
    const { pushOpenDiag, PUSH_OPEN_ERROR_MESSAGE } = await freshDiagnostics();
    pushOpenDiag(SWITCH_FAILED);
    expect(PUSH_OPEN_ERROR_MESSAGE).toBe('push.open error');
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentry.captureMessage).toHaveBeenCalledWith('push.open error', {
      level: 'warning',
      tags: {
        'push.open.stage': 'error',
        'push.open.source': 'listener',
        'push.open.reason': 'switch-failed',
        'push.open.errorClass': 'TypeError',
      },
      fingerprint: ['push.open', 'switch-failed'],
    });
    // The breadcrumb is still left, for any later event's trail.
    expect(breadcrumbs()).toEqual([
      { category: 'push.open', level: 'info', data: { ...SWITCH_FAILED } },
    ]);
  });

  it("only this module's breadcrumbs travel with it: the session's request URLs and console lines are taken off", async () => {
    const { pushOpenDiag } = await freshDiagnostics();
    pushOpenDiag(SWITCH_FAILED);
    // The event is captured inside the scope the filter was added to, after
    // the filter was added.
    expect(sentry.withScope).toHaveBeenCalledTimes(1);
    expect(sentry.scope.addEventProcessor).toHaveBeenCalledTimes(1);
    expect(sentry.state.capturedInsideScope).toEqual([true]);
    expect(sentry.scope.addEventProcessor.mock.invocationCallOrder[0]!).toBeLessThan(
      sentry.captureMessage.mock.invocationCallOrder[0]!,
    );
    const filter = sentry.scope.addEventProcessor.mock.calls[0]![0] as (
      event: Record<string, unknown>,
    ) => Record<string, unknown>;
    const ours = { category: 'push.open', level: 'info', data: { stage: 'resolve' } };
    const event = {
      message: 'push.open error',
      breadcrumbs: [
        {
          category: 'fetch',
          data: { url: `https://example.supabase.co/rest/v1/returns?id=eq.${RMA}` },
        },
        ours,
        { category: 'console', message: `[workspace] ${USER} ${TOKEN}` },
        { category: 'navigation', data: { to: `/order/${ORDER}` } },
      ],
    };
    const sent = filter(event);
    expect(sent).toEqual({ message: 'push.open error', breadcrumbs: [ours] });
    expect(JSON.stringify(sent)).not.toMatch(UUID_ANYWHERE);
    // With no trail at all, the event goes with none.
    expect(filter({ message: 'push.open error' })).toEqual({
      message: 'push.open error',
      breadcrumbs: [],
    });
  });

  it('no other stage raises one, whatever its reason', async () => {
    const { pushOpenDiag } = await freshDiagnostics();
    for (const stage of PUSH_OPEN_STAGES) {
      if (stage === 'error') continue;
      pushOpenDiag({ stage, source: 'listener', reason: 'switch-failed', errorClass: 'TypeError' });
    }
    expect(sentry.captureMessage).not.toHaveBeenCalled();
    expect(sentry.withScope).not.toHaveBeenCalled();
  });

  it('once per launch for the same failure; another failure is its own event', async () => {
    const { pushOpenDiag } = await freshDiagnostics();
    pushOpenDiag(SWITCH_FAILED);
    pushOpenDiag(SWITCH_FAILED);
    pushOpenDiag(SWITCH_FAILED);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    pushOpenDiag({ ...SWITCH_FAILED, errorClass: 'AbortError' });
    pushOpenDiag({ stage: 'error', reason: 'listener-unavailable', errorClass: 'Error' });
    expect(sentry.captureMessage).toHaveBeenCalledTimes(3);
    // Every one still leaves its breadcrumb.
    expect(breadcrumbs()).toHaveLength(5);
    // The next launch (a fresh module) reports it again.
    const next = await freshDiagnostics();
    next.pushOpenDiag(SWITCH_FAILED);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(4);
  });

  it('a failing Sentry call never breaks the tap, and the breadcrumb is still left', async () => {
    const { pushOpenDiag } = await freshDiagnostics();
    sentry.withScope.mockImplementationOnce(() => {
      throw new Error('sentry is down');
    });
    expect(() => pushOpenDiag(SWITCH_FAILED)).not.toThrow();
    expect(breadcrumbs()).toHaveLength(1);
    sentry.captureMessage.mockImplementationOnce(() => {
      throw new Error('sentry is down');
    });
    expect(() =>
      pushOpenDiag({ stage: 'error', reason: 'clear-unavailable', errorClass: 'Error' }),
    ).not.toThrow();
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

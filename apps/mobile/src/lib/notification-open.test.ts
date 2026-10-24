import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CapturedIntent, TakeResult } from './notification-intent';
import { parseNotificationLink } from './notification-link';
import {
  CHECKING_NOTICE_DELAY_MS,
  NOTICE_NO_PAGE_COPY,
  NOTICE_OTHER_ACCOUNT_COPY,
  NOTICE_RETRY_COPY,
  NOTICE_UNAVAILABLE_COPY,
  TARGET_READ_TIMEOUT_MS,
  checkingNoticeCopy,
  createWorkspaceChecks,
  focusedStackRoute,
  nextOpenStep,
  noticeContent,
  resolutionReason,
  resolveTargetWorkspace,
  stepAfterResolution,
  switchNoticeCopy,
  switchingNoticeCopy,
  type IntentNotice,
  type OpenStepInput,
  type TargetResolution,
  type WorkspaceView,
} from './notification-open';
import { PUSH_OPEN_REASONS } from './push-open-diagnostics';

// errorClassOf lives beside the Sentry breadcrumbs; Sentry cannot load here.
vi.mock('./sentry', () => ({ Sentry: { addBreadcrumb: vi.fn(), captureException: vi.fn() } }));

/**
 * What the host does with a captured tap, step by step (Phase 3). Readiness
 * is read from real signals (MFA being checked, the navigator, the auth
 * group, the binding, the workspace), never from a timer. A user in more than
 * one workspace has an order or return checked first, under RLS, so a tap
 * for the other workspace offers the switch instead of "Order not found."
 */

const ORDER = '11111111-1111-4111-8111-111111111111';
const RMA = '22222222-2222-4222-8222-222222222222';
const REPLACEMENT = '33333333-3333-4333-8333-333333333333';
const PO = '44444444-4444-4444-8444-444444444444';
const ITEM = '55555555-5555-4555-8555-555555555555';
const COUNT = '66666666-6666-4666-8666-666666666666';
const BUNDLE = '77777777-7777-4777-8777-777777777777';
const REQUEST = '88888888-8888-4888-8888-888888888888';
const EVENT = '99999999-9999-4999-8999-999999999999';

function intent(link: unknown, over: Partial<CapturedIntent> = {}): CapturedIntent {
  return {
    key: 'req-1|1',
    identifier: 'req-1',
    seq: 1,
    source: 'listener',
    capturedAt: 0,
    deliveredAt: 1,
    target: parseNotificationLink(link),
    title: null,
    body: null,
    binding: { userId: 'u1', email: null },
    ...over,
  };
}

const ready = (link: unknown, over: Partial<CapturedIntent> = {}): TakeResult => ({
  kind: 'ready',
  intent: intent(link, over),
});

const ONE: WorkspaceView = {
  loading: false,
  orgs: [{ id: 'org-a', name: 'Acme Demo Co' }],
  activeOrgId: 'org-a',
  activeOrgName: 'Acme Demo Co',
};
const TWO: WorkspaceView = {
  loading: false,
  orgs: [
    { id: 'org-a', name: 'Acme Demo Co' },
    { id: 'org-b', name: 'Ledger QA Co' },
  ],
  activeOrgId: 'org-b',
  activeOrgName: 'Ledger QA Co',
};
/** Before the first workspace load for this account has answered. */
const COLD: WorkspaceView = { loading: true, orgs: [], activeOrgId: null, activeOrgName: null };

function input(over: Partial<OpenStepInput> = {}): OpenStepInput {
  return {
    take: ready(`/dashboard/orders/${ORDER}`),
    forSeq: 1,
    mfaPending: false,
    routerReady: true,
    stackRoute: '(drawer)',
    segments: ['(drawer)', '(tabs)'],
    pathname: '/',
    workspace: ONE,
    // ONE is on screen for the account signed in (workspaceShownForAccount).
    workspaceShown: true,
    ...over,
  };
}

describe('nextOpenStep waits on real signals', () => {
  it.each<[string, Partial<OpenStepInput>, string]>([
    ['the sign-in to MFA window (mfaPending)', { mfaPending: true }, 'mfa-pending'],
    ['the navigator is not mounted yet', { routerReady: false }, 'router-not-ready'],
    ['no route yet', { segments: [] }, 'no-segments'],
    [
      'still on the sign-in group (the redirect has not run)',
      { segments: ['(auth)', 'sign-in'] },
      'auth-group',
    ],
    [
      'on the sign-in group, live and published alike (a session, before the redirect)',
      { stackRoute: '(auth)', segments: ['(auth)', 'sign-in'] },
      'auth-group',
    ],
    [
      'whose tap it is is not known yet',
      {
        take: { kind: 'waiting', reason: 'binding', intent: intent(`/dashboard/orders/${ORDER}`) },
      },
      'binding',
    ],
    // 2026-10-24 (review 3): only the first load for this account waits; a
    // reload decides from the workspace on screen (see 'a reload never holds
    // an order or a return'). Was { workspace: { ...ONE, loading: true } }.
    [
      'the first workspace load for this account, for an order with an id',
      { workspace: COLD, workspaceShown: false },
      'workspace-loading',
    ],
  ])('%s', (_label, over, reason) => {
    expect(nextOpenStep(input(over))).toEqual({ kind: 'wait', reason });
  });

  it('readiness comes before any decision: nothing is dropped or shown over MFA or sign-in', () => {
    const mismatch: TakeResult = {
      kind: 'dropped',
      reason: 'account-mismatch',
      intent: intent(`/dashboard/orders/${ORDER}`),
    };
    expect(nextOpenStep(input({ take: mismatch, mfaPending: true }))).toEqual({
      kind: 'wait',
      reason: 'mfa-pending',
    });
    expect(nextOpenStep(input({ take: mismatch, segments: ['(auth)'] }))).toEqual({
      kind: 'wait',
      reason: 'auth-group',
    });
  });

  it('no timer decides readiness: the timers are the read deadline and the Checking delay', () => {
    const src = readFileSync(path.join(__dirname, 'notification-open.ts'), 'utf8');
    const fn = (name: string) => {
      const start = src.indexOf(`function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      return src.slice(start, src.indexOf('\n}\n', start));
    };
    expect(src).not.toMatch(/setInterval|requestAnimationFrame/);
    for (const name of ['nextOpenStep', 'stepAfterResolution']) {
      expect(fn(name)).not.toMatch(/setTimeout/);
    }
    // A network deadline (orchestrator decision (a)) and a UI delay
    // (decision (b)); neither is a readiness wait.
    expect(src.match(/setTimeout\(/g)).toHaveLength(2);
    expect(fn('resolveTargetWorkspace')).toContain('setTimeout(');
    expect(fn('createWorkspaceChecks')).toContain('setTimeout(');
  });
});

/**
 * The navigator, not the published route, decides. RootGate swaps the Stack
 * for the MFA or Face ID screen; the navigator clears its state on unmount,
 * and expo-router's store skips an undefined state, so useSegments() keeps
 * the route from before. When the Stack remounts (on its first declared
 * screen, the sign-in group, until the redirect sends it Home), the host's
 * first look sees that stale route. The live root state is read instead.
 */
describe('a remounted navigator: the live route, not a stale one', () => {
  it("focusedStackRoute reads the root Stack's focused route under expo-router's __root slot", () => {
    expect(focusedStackRoute(undefined)).toBeNull();
    expect(focusedStackRoute({ index: 0, routes: [{ name: '__root' }] })).toBeNull();
    expect(
      focusedStackRoute({
        index: 0,
        routes: [
          {
            name: '__root',
            state: { index: 1, routes: [{ name: '(drawer)' }, { name: 'order/[id]' }] },
          },
        ],
      }),
    ).toBe('order/[id]');
    expect(
      focusedStackRoute({ routes: [{ name: '__root', state: { routes: [{ name: '(auth)' }] } }] }),
    ).toBe('(auth)');
    expect(focusedStackRoute({ index: 0, routes: [{ name: '+not-found' }] })).toBe('+not-found');
    expect(focusedStackRoute({ routes: [] })).toBeNull();
  });

  it('no Stack state yet: wait', () => {
    expect(nextOpenStep(input({ stackRoute: null }))).toEqual({
      kind: 'wait',
      reason: 'router-not-ready',
    });
  });

  it('the Stack remounted on the sign-in group while the published route still says Home: wait', () => {
    expect(nextOpenStep(input({ stackRoute: '(auth)', segments: ['(drawer)', '(tabs)'] }))).toEqual(
      {
        kind: 'wait',
        reason: 'auth-group',
      },
    );
  });

  it('the published route has not caught up with the navigator: wait', () => {
    expect(nextOpenStep(input({ stackRoute: '(drawer)', segments: ['order', '[id]'] }))).toEqual({
      kind: 'wait',
      reason: 'route-settling',
    });
  });

  it('settled: a nested route name agrees with its first segment', () => {
    expect(nextOpenStep(input({ stackRoute: 'order/[id]', segments: ['order', '[id]'] }))).toEqual({
      kind: 'navigate',
      path: `/order/${ORDER}`,
    });
    expect(
      nextOpenStep(
        input({
          stackRoute: 'reports/book-order-totals/index',
          segments: ['reports', 'book-order-totals'],
        }),
      ),
    ).toEqual({ kind: 'navigate', path: `/order/${ORDER}` });
  });
});

describe('nextOpenStep decides', () => {
  it('nothing pending: idle', () => {
    expect(nextOpenStep(input({ take: { kind: 'none' } }))).toEqual({ kind: 'idle' });
  });

  /**
   * The host acts on the intent take() hands over, read when its effect
   * runs; the render it runs for was for the tap pending then. A newer tap
   * captured in between (tap X waiting on mfaPending, the flag clears in one
   * render, tap Y lands before that render's effects run) must not be opened
   * as X, finished as X and then pushed again as itself: two cards of one
   * order. The step is idle, and the re-render for the newer tap opens it.
   */
  it('a newer tap than the render was for: idle, and the next render opens it', () => {
    const newer = intent(`/dashboard/orders/${ORDER}`, { seq: 2 });
    expect(nextOpenStep(input({ forSeq: 1, take: { kind: 'ready', intent: newer } }))).toEqual({
      kind: 'idle',
    });
    expect(
      nextOpenStep(
        input({
          forSeq: 1,
          take: { kind: 'dropped', reason: 'account-mismatch', intent: newer },
        }),
      ),
    ).toEqual({ kind: 'idle' });
    expect(
      nextOpenStep(
        input({ forSeq: 1, take: { kind: 'waiting', reason: 'binding', intent: newer } }),
      ),
    ).toEqual({ kind: 'idle' });
    expect(nextOpenStep(input({ forSeq: 2, take: { kind: 'ready', intent: newer } }))).toEqual({
      kind: 'navigate',
      path: `/order/${ORDER}`,
    });
  });

  it('expired or unbound: dropped silently; another account: the neutral notice', () => {
    const it1 = intent(`/dashboard/orders/${ORDER}`);
    expect(
      nextOpenStep(input({ take: { kind: 'dropped', reason: 'expired', intent: it1 } })),
    ).toEqual({
      kind: 'drop',
      reason: 'expired',
    });
    expect(
      nextOpenStep(input({ take: { kind: 'dropped', reason: 'unbound', intent: it1 } })),
    ).toEqual({
      kind: 'drop',
      reason: 'unbound',
    });
    expect(
      nextOpenStep(input({ take: { kind: 'dropped', reason: 'account-mismatch', intent: it1 } })),
    ).toEqual({
      kind: 'notice',
      notice: { kind: 'account-mismatch' },
    });
  });

  it("a link the app cannot open: the notice with the push's own words", () => {
    expect(
      nextOpenStep(
        input({ take: ready(undefined, { title: 'Push test', body: 'Hello' }), workspace: TWO }),
      ),
    ).toEqual({
      kind: 'notice',
      notice: { kind: 'unsupported', title: 'Push test', body: 'Hello' },
    });
    expect(nextOpenStep(input({ take: ready('https://evil.example/x') }))).toMatchObject({
      kind: 'notice',
      notice: { kind: 'unsupported' },
    });
  });

  it('a single-workspace user goes straight to the order, with no extra read', () => {
    expect(nextOpenStep(input())).toEqual({ kind: 'navigate', path: `/order/${ORDER}` });
  });

  it('a user in more than one workspace has an order or a return checked first', () => {
    expect(nextOpenStep(input({ workspace: TWO }))).toEqual({
      kind: 'resolve',
      table: 'order_requests',
      id: ORDER,
    });
    expect(
      nextOpenStep(
        input({
          workspace: TWO,
          take: ready(`/dashboard/returns/${RMA}?order=/dashboard/orders/${ORDER}`),
        }),
      ),
    ).toEqual({ kind: 'resolve', table: 'returns', id: RMA });
  });

  it('other kinds, and lists, open as today for everyone (no workspace check this phase)', () => {
    expect(
      nextOpenStep(input({ workspace: TWO, take: ready(`/dashboard/purchase-orders/${PO}`) })),
    ).toEqual({
      kind: 'navigate',
      path: `/po/${PO}`,
    });
    expect(nextOpenStep(input({ workspace: TWO, take: ready('/dashboard/returns') }))).toEqual({
      kind: 'navigate',
      path: '/returns',
    });
  });

  it('already on that order: stay (no second card)', () => {
    expect(nextOpenStep(input({ pathname: `/order/${ORDER}` }))).toEqual({ kind: 'stay' });
  });

  it('a workspace that failed to load does not hold the tap: the screen shows its own state', () => {
    const none: WorkspaceView = {
      loading: false,
      orgs: [],
      activeOrgId: null,
      activeOrgName: null,
    };
    expect(nextOpenStep(input({ workspace: none, workspaceShown: false }))).toEqual({
      kind: 'navigate',
      path: `/order/${ORDER}`,
    });
  });
});

/**
 * Review round 2 (2026-10-13): only an order or a return with an id reads the
 * workspace, so only those wait while it loads. Every screen that mounts
 * useWorkspace or useOrg publishes loading:true and loads the workspace again,
 * and its membership and default-organization reads have no deadline: a
 * cycle count tapped during one of the 1-8 s stalls showed nothing until that
 * reload ended, where main opened it at once. Every other page opens as on
 * main, and its screen loads its own workspace, under RLS.
 */
describe('only an order or a return with an id waits for the workspace to load', () => {
  // Each view with whether a workspace is on screen for this account
  // (workspaceShownForAccount): a reload keeps it, a cold start has none yet.
  const LOADING: [string, Pick<OpenStepInput, 'workspace' | 'workspaceShown'>][] = [
    [
      'one workspace, loading again',
      { workspace: { ...ONE, loading: true }, workspaceShown: true },
    ],
    [
      'two workspaces, loading again',
      { workspace: { ...TWO, loading: true }, workspaceShown: true },
    ],
    ['a cold start, before the first load', { workspace: COLD, workspaceShown: false }],
  ];

  it.each<[string, string, string]>([
    ['a PO', `/dashboard/purchase-orders/${PO}`, `/po/${PO}`],
    ['the PO list', '/dashboard/purchase-orders', '/purchase-orders'],
    ['a cycle count', `/dashboard/cycle-counts/${COUNT}`, `/cycle-count/${COUNT}`],
    ['an item', `/dashboard/inventory/${ITEM}`, `/item/${ITEM}`],
    ['the low-stock list', '/dashboard/inventory?stock=low&type=all', '/inventory'],
    ['a bundle', `/dashboard/bundles/${BUNDLE}`, `/bundles/${BUNDLE}`],
    ['a maintenance request', `/dashboard/maintenance/${REQUEST}`, `/maintenance/${REQUEST}`],
    ['the schedule', `/dashboard/schedule/${EVENT}`, '/schedule'],
    ['a report', '/dashboard/reports/book-order-totals', '/reports/book-order-totals'],
    ['the inbox', '/dashboard/insights', '/notifications'],
    ['the orders list', '/dashboard/orders', '/orders'],
    ['the returns list', '/dashboard/returns', '/returns'],
    ['a new order', '/dashboard/orders/new', '/order/new'],
  ])('%s opens at once', (_label, link, path) => {
    for (const [view, loading] of LOADING) {
      expect(nextOpenStep(input({ ...loading, take: ready(link) })), view).toEqual({
        kind: 'navigate',
        path,
      });
      // Already the screen in front: stay (no second card).
      expect(nextOpenStep(input({ ...loading, take: ready(link), pathname: path })), view).toEqual({
        kind: 'stay',
      });
    }
  });

  // 2026-10-24 (review 3): the wait is for the first load only. Was: every
  // LOADING view waits, the two reloads included.
  it.each<[string, string]>([
    ['an order', `/dashboard/orders/${ORDER}`],
    ['a replacement order', `/dashboard/orders/${REPLACEMENT}`],
    ['an order from the hand-over (https)', `https://stockpilotusa.com/dashboard/orders/${ORDER}`],
    ['a return (the dual link)', `/dashboard/returns/${RMA}?order=/dashboard/orders/${ORDER}`],
  ])(
    '%s waits for the first load only, then opens for one workspace and is checked for two',
    (_label, link) => {
      expect(
        nextOpenStep(input({ workspace: COLD, workspaceShown: false, take: ready(link) })),
      ).toEqual({ kind: 'wait', reason: 'workspace-loading' });
      for (const [workspace, shown] of [
        [ONE, true],
        [{ ...ONE, loading: true }, true],
      ] as const) {
        expect(
          nextOpenStep(input({ workspace, workspaceShown: shown, take: ready(link) })),
        ).toMatchObject({ kind: 'navigate' });
      }
      for (const [workspace, shown] of [
        [TWO, true],
        [{ ...TWO, loading: true }, true],
      ] as const) {
        expect(
          nextOpenStep(input({ workspace, workspaceShown: shown, take: ready(link) })),
        ).toMatchObject({ kind: 'resolve' });
      }
    },
  );
});

/**
 * Review round 3 (2026-10-13), MEDIUM: an order or a return tapped while ANY
 * screen was loading the workspace again waited for that reload, with nothing
 * on screen and no deadline. useWorkspace() publishes loading:true and loads
 * again on every mount (useOrg in 35 files, useRole in 31, the order screen
 * itself), and its membership and default-organization reads have no deadline;
 * one that throws leaves loading true until another screen mounts. A warm tap
 * on main opened the order at once, and the order screen reads with the
 * workspace already on screen. A reload keeps that workspace published, so the
 * tap decides from it now: one workspace opens the order, two check it first
 * (a read bounded at 15 seconds, with the Checking notice after 400 ms). Only
 * the first load for this account, with nothing on screen yet, still holds an
 * order or a return; a workspace chosen for an account that is gone never
 * counts (use-workspace.ts workspaceShownForAccount).
 */
describe('a reload never holds an order or a return: the workspace on screen decides', () => {
  const RETURN_LINK = `/dashboard/returns/${RMA}?order=/dashboard/orders/${ORDER}`;

  it('one workspace on screen, loading again: the order opens at once, with no read', () => {
    expect(nextOpenStep(input({ workspace: { ...ONE, loading: true } }))).toEqual({
      kind: 'navigate',
      path: `/order/${ORDER}`,
    });
    expect(
      nextOpenStep(input({ workspace: { ...ONE, loading: true }, take: ready(RETURN_LINK) })),
    ).toEqual({ kind: 'navigate', path: `/returns/${RMA}` });
  });

  it('two workspaces on screen, loading again: checked at once, never held', () => {
    expect(nextOpenStep(input({ workspace: { ...TWO, loading: true } }))).toEqual({
      kind: 'resolve',
      table: 'order_requests',
      id: ORDER,
    });
    expect(
      nextOpenStep(input({ workspace: { ...TWO, loading: true }, take: ready(RETURN_LINK) })),
    ).toEqual({ kind: 'resolve', table: 'returns', id: RMA });
  });

  it('already on that order while the workspace reloads: stay (no second card)', () => {
    expect(
      nextOpenStep(input({ workspace: { ...ONE, loading: true }, pathname: `/order/${ORDER}` })),
    ).toEqual({ kind: 'stay' });
  });

  it("the first load for this account waits, even with another account's workspace still published", () => {
    expect(nextOpenStep(input({ workspace: COLD, workspaceShown: false }))).toEqual({
      kind: 'wait',
      reason: 'workspace-loading',
    });
    // Signed out and another account in: the previous one's workspace is
    // still published while the new account's first load runs. Never decide
    // from it.
    for (const stale of [ONE, TWO]) {
      expect(
        nextOpenStep(input({ workspace: { ...stale, loading: true }, workspaceShown: false })),
      ).toEqual({ kind: 'wait', reason: 'workspace-loading' });
    }
  });
});

describe('stepAfterResolution', () => {
  const base = {
    answerSeq: 1,
    currentSeq: 1,
    native: `/order/${ORDER}`,
    routeKind: 'order',
    workspace: TWO,
    pathname: '/',
  };

  it('the active workspace: open it', () => {
    expect(stepAfterResolution({ ...base, resolution: { kind: 'found', orgId: 'org-b' } })).toEqual(
      {
        kind: 'navigate',
        path: `/order/${ORDER}`,
      },
    );
    expect(
      stepAfterResolution({
        ...base,
        pathname: `/order/${ORDER}`,
        resolution: { kind: 'found', orgId: 'org-b' },
      }),
    ).toEqual({ kind: 'stay' });
  });

  it('another workspace this user belongs to: the switch notice naming it (never a silent switch)', () => {
    expect(stepAfterResolution({ ...base, resolution: { kind: 'found', orgId: 'org-a' } })).toEqual(
      {
        kind: 'notice',
        notice: {
          kind: 'switch',
          orgId: 'org-a',
          orgName: 'Acme Demo Co',
          activeOrgName: 'Ledger QA Co',
          noun: 'order',
          native: `/order/${ORDER}`,
        },
      },
    );
    expect(
      stepAfterResolution({
        ...base,
        native: `/returns/${RMA}`,
        routeKind: 'returns',
        resolution: { kind: 'found', orgId: 'org-a' },
      }),
    ).toMatchObject({
      kind: 'notice',
      notice: { kind: 'switch', noun: 'return', native: `/returns/${RMA}` },
    });
  });

  it('a workspace this user is not in, or no row at all: unavailable, in the same words', () => {
    const foreign = stepAfterResolution({ ...base, resolution: { kind: 'found', orgId: 'org-z' } });
    const missing = stepAfterResolution({ ...base, resolution: { kind: 'none' } });
    expect(foreign).toEqual({ kind: 'notice', notice: { kind: 'unavailable' } });
    expect(missing).toEqual(foreign);
    const words = (step: typeof foreign) =>
      step.kind === 'notice' ? JSON.stringify(noticeContent(step.notice, { offline: false })) : '';
    expect(words(foreign)).toBe(words(missing));
  });

  it('a read that failed: try again', () => {
    expect(
      stepAfterResolution({ ...base, resolution: { kind: 'error', errorClass: 'TypeError' } }),
    ).toEqual({
      kind: 'notice',
      notice: { kind: 'retry' },
    });
  });

  it('a late answer for a tap that was replaced is ignored', () => {
    expect(
      stepAfterResolution({
        ...base,
        currentSeq: 2,
        resolution: { kind: 'found', orgId: 'org-b' },
      }),
    ).toEqual({
      kind: 'idle',
    });
    expect(
      stepAfterResolution({
        ...base,
        currentSeq: null,
        resolution: { kind: 'found', orgId: 'org-b' },
      }),
    ).toEqual({
      kind: 'idle',
    });
  });
});

describe('resolutionReason names what the workspace read found (diagnostics only)', () => {
  it('each outcome', () => {
    const sw: IntentNotice = {
      kind: 'switch',
      orgId: 'org-a',
      orgName: 'Acme Demo Co',
      activeOrgName: 'Ledger QA Co',
      noun: 'order',
      native: `/order/${ORDER}`,
    };
    const found = { kind: 'found', orgId: 'org-a' } as const;
    expect(resolutionReason(found, { kind: 'navigate', path: '/x' })).toBe('same-workspace');
    expect(resolutionReason(found, { kind: 'stay' })).toBe('same-workspace');
    expect(resolutionReason(found, { kind: 'notice', notice: sw })).toBe('other-workspace');
    expect(resolutionReason(found, { kind: 'notice', notice: { kind: 'unavailable' } })).toBe(
      'not-a-member',
    );
    expect(
      resolutionReason({ kind: 'none' }, { kind: 'notice', notice: { kind: 'unavailable' } }),
    ).toBe('none');
    expect(
      resolutionReason(
        { kind: 'error', errorClass: 'TypeError' },
        { kind: 'notice', notice: { kind: 'retry' } },
      ),
    ).toBe('error');
    expect(resolutionReason(found, { kind: 'idle' })).toBe('superseded');
  });
});

describe('resolveTargetWorkspace reads the organization under RLS, and nothing else', () => {
  function recordingClient(answer: { data: unknown; error: unknown } | Error) {
    const calls: unknown[][] = [];
    const chain = {
      select: (...args: unknown[]) => {
        calls.push(['select', ...args]);
        return chain;
      },
      eq: (...args: unknown[]) => {
        calls.push(['eq', ...args]);
        return chain;
      },
      maybeSingle: async () => {
        calls.push(['maybeSingle']);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    return {
      calls,
      client: {
        from: (table: string) => {
          calls.push(['from', table]);
          return chain;
        },
      },
    };
  }

  it('one read by id, with NO organization filter (the active workspace is exactly what is unknown)', async () => {
    const rec = recordingClient({ data: { organization_id: 'org-a' }, error: null });
    await expect(resolveTargetWorkspace(rec.client, 'order_requests', ORDER)).resolves.toEqual({
      kind: 'found',
      orgId: 'org-a',
    });
    expect(rec.calls).toEqual([
      ['from', 'order_requests'],
      ['select', 'organization_id'],
      ['eq', 'id', ORDER],
      ['maybeSingle'],
    ]);
    expect(rec.calls.some(([op, col]) => op === 'eq' && col === 'organization_id')).toBe(false);
  });

  it('a return is read from returns', async () => {
    const rec = recordingClient({ data: { organization_id: 'org-a' }, error: null });
    await resolveTargetWorkspace(rec.client, 'returns', RMA);
    expect(rec.calls[0]).toEqual(['from', 'returns']);
  });

  it('no row (missing, or not shared with this user): none', async () => {
    const rec = recordingClient({ data: null, error: null });
    await expect(resolveTargetWorkspace(rec.client, 'order_requests', ORDER)).resolves.toEqual({
      kind: 'none',
    });
  });

  it('a failed or thrown read: error, with the class name only', async () => {
    const failed = recordingClient({
      data: null,
      error: { name: 'PostgrestError', message: `bad ${ORDER}` },
    });
    await expect(resolveTargetWorkspace(failed.client, 'order_requests', ORDER)).resolves.toEqual({
      kind: 'error',
      errorClass: 'PostgrestError',
    });
    const thrown = recordingClient(new TypeError('Network request failed'));
    await expect(resolveTargetWorkspace(thrown.client, 'order_requests', ORDER)).resolves.toEqual({
      kind: 'error',
      errorClass: 'TypeError',
    });
  });

  it('writes nothing: the module has no insert, update, delete, upsert or rpc', () => {
    const src = readFileSync(path.join(__dirname, 'notification-open.ts'), 'utf8');
    expect(src).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
  });
});

/**
 * Orchestrator decision (a), 2026-10-13: the read is bounded the way
 * use-workspace.ts bounds the warehouse read (loadWarehousesBounded). React
 * Native's fetch has no timeout of its own, so a request that stalled (the
 * 1-8 s IAD stalls, a captive portal that accepts the connection and never
 * answers) left a multi-workspace tap with no page, no notice and no Try
 * again. A network deadline, not a readiness wait.
 */
describe('resolveTargetWorkspace answers within its deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A client whose read answers only when the test says so. */
  function stalledClient() {
    let settle: (answer: { data: unknown; error: unknown }) => void = () => {};
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () =>
        new Promise<{ data: unknown; error: unknown }>((resolve) => {
          settle = resolve;
        }),
    };
    return {
      client: { from: () => chain },
      answer: (answer: { data: unknown; error: unknown }) => settle(answer),
    };
  }

  const afterRead = (resolution: TargetResolution) =>
    stepAfterResolution({
      answerSeq: 1,
      currentSeq: 1,
      resolution,
      native: `/order/${ORDER}`,
      routeKind: 'order',
      workspace: TWO,
      pathname: '/',
    });

  it('a read that never answers is a read error after 15 seconds, which offers Try again', async () => {
    const stalled = stalledClient();
    const answered = vi.fn();
    void resolveTargetWorkspace(stalled.client, 'order_requests', ORDER).then(answered);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(answered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(answered).toHaveBeenCalledTimes(1);
    expect(answered).toHaveBeenCalledWith({ kind: 'error', errorClass: 'TimeoutError' });
    expect(afterRead(answered.mock.calls[0]?.[0] as TargetResolution)).toEqual({
      kind: 'notice',
      notice: { kind: 'retry' },
    });
    expect(TARGET_READ_TIMEOUT_MS).toBe(15_000);
  });

  it("a timed-out read's late answer changes nothing", async () => {
    const stalled = stalledClient();
    const answered = vi.fn();
    void resolveTargetWorkspace(stalled.client, 'order_requests', ORDER).then(answered);
    await vi.advanceTimersByTimeAsync(15_000);
    stalled.answer({ data: { organization_id: 'org-b' }, error: null });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(answered).toHaveBeenCalledTimes(1);
    expect(answered).toHaveBeenCalledWith({ kind: 'error', errorClass: 'TimeoutError' });
  });

  it('an answer in time is the answer, and the deadline is cleared', async () => {
    const stalled = stalledClient();
    const read = resolveTargetWorkspace(stalled.client, 'order_requests', ORDER);
    expect(vi.getTimerCount()).toBe(1);
    stalled.answer({ data: { organization_id: 'org-b' }, error: null });
    await expect(read).resolves.toEqual({ kind: 'found', orgId: 'org-b' });
    expect(vi.getTimerCount()).toBe(0);
    expect(afterRead({ kind: 'found', orgId: 'org-b' })).toEqual({
      kind: 'navigate',
      path: `/order/${ORDER}`,
    });
  });
});

/**
 * Orchestrator decision (b), 2026-10-13: while a multi-workspace tap's read
 * is out, the notice says so once the read has taken longer than about
 * 400 ms, so a slow connection never looks like a dead tap, and a fast read
 * shows nothing at all. The answer, a newer tap, a sign-out, an unmount or
 * Close ends it, timer and all. Each start is its own attempt: Try again
 * reuses the tap's seq, so an older attempt's late answer must go nowhere
 * (createWorkspaceChecks, which the host runs one at a time).
 */
describe('the workspace check: Checking after a moment, one attempt at a time', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const FOUND: TargetResolution = { kind: 'found', orgId: 'org-a' };

  /** A read the test answers by hand. */
  function manualRead() {
    let settle: (resolution: TargetResolution) => void = () => {};
    let fail: (err: unknown) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise<TargetResolution>((resolve, reject) => {
          settle = resolve;
          fail = reject;
        }),
    );
    return {
      read,
      answer: (resolution: TargetResolution) => settle(resolution),
      fail: (err: unknown) => fail(err),
    };
  }

  /** The host's view: the store's pending tap, and the two handlers. */
  function harness() {
    const store = { pending: 1 as number | null };
    const checks = createWorkspaceChecks(() => store.pending);
    const handlers = { checking: vi.fn(), answer: vi.fn() };
    return { store, checks, handlers };
  }

  it('a fast read shows nothing: the answer comes, the Checking notice never does', async () => {
    const h = harness();
    const r = manualRead();
    h.checks.start(1, r.read, h.handlers);
    expect(h.checks.running(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    r.answer(FOUND);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.handlers.answer).toHaveBeenCalledTimes(1);
    expect(h.handlers.answer).toHaveBeenCalledWith(FOUND);
    expect(h.checks.running(1)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.handlers.checking).not.toHaveBeenCalled();
  });

  it('a slow read shows the Checking notice after 400 ms, and then the answer', async () => {
    const h = harness();
    const r = manualRead();
    h.checks.start(1, r.read, h.handlers);
    await vi.advanceTimersByTimeAsync(399);
    expect(h.handlers.checking).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.handlers.checking).toHaveBeenCalledTimes(1);
    expect(h.handlers.answer).not.toHaveBeenCalled();
    expect(h.checks.running(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_600);
    r.answer(FOUND);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.handlers.answer).toHaveBeenCalledWith(FOUND);
    expect(h.handlers.checking).toHaveBeenCalledTimes(1);
    expect(h.checks.running(1)).toBe(false);
    expect(CHECKING_NOTICE_DELAY_MS).toBe(400);
  });

  it('a newer tap ends it: nothing shows for the old tap, its timer is cleared, its answer goes nowhere', async () => {
    const h = harness();
    const r = manualRead();
    h.checks.start(1, r.read, h.handlers);
    await vi.advanceTimersByTimeAsync(200);
    h.store.pending = 2;
    h.checks.keepOnly(2); // the host, on the newer tap
    expect(h.checks.running(1)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    r.answer(FOUND);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.handlers.checking).not.toHaveBeenCalled();
    expect(h.handlers.answer).not.toHaveBeenCalled();
  });

  it('a newer tap the host has not seen yet: no Checking notice for the old one, and its answer is ignored', async () => {
    const h = harness();
    const r = manualRead();
    h.checks.start(1, r.read, h.handlers);
    h.store.pending = 2; // captured; the host has not re-rendered yet
    await vi.advanceTimersByTimeAsync(400);
    expect(h.handlers.checking).not.toHaveBeenCalled();
    r.answer(FOUND);
    await vi.advanceTimersByTimeAsync(0);
    const late = h.handlers.answer.mock.calls[0]?.[0] as TargetResolution;
    expect(
      stepAfterResolution({
        answerSeq: 1,
        currentSeq: 2,
        resolution: late,
        native: `/order/${ORDER}`,
        routeKind: 'order',
        workspace: TWO,
        pathname: '/',
      }),
    ).toEqual({ kind: 'idle' });
  });

  it('a sign-out ends it the same way, even once the Checking notice shows', async () => {
    const h = harness();
    const r = manualRead();
    h.checks.start(1, r.read, h.handlers);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.handlers.checking).toHaveBeenCalledTimes(1);
    h.store.pending = null; // clear('deliberate-sign-out')
    h.checks.keepOnly(null);
    expect(h.checks.running(1)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    r.answer(FOUND);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.handlers.answer).not.toHaveBeenCalled();
  });

  it('the tap it is for keeps it (a re-render, a binding update)', async () => {
    const h = harness();
    const r = manualRead();
    h.checks.start(1, r.read, h.handlers);
    h.checks.keepOnly(1);
    expect(h.checks.running(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.handlers.checking).toHaveBeenCalledTimes(1);
    r.answer(FOUND);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.handlers.answer).toHaveBeenCalledWith(FOUND);
  });

  it('an unmount or Close ends it: no handler runs after cancel()', async () => {
    const h = harness();
    const r = manualRead();
    h.checks.start(1, r.read, h.handlers);
    await vi.advanceTimersByTimeAsync(100);
    h.checks.cancel();
    expect(h.checks.running(1)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    r.answer(FOUND);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.handlers.checking).not.toHaveBeenCalled();
    expect(h.handlers.answer).not.toHaveBeenCalled();
  });

  it("each start is its own attempt: a replaced attempt's late answer never reaches the next", async () => {
    const h = harness();
    const first = manualRead();
    const second = manualRead();
    h.checks.start(1, first.read, h.handlers);
    h.checks.start(1, second.read, h.handlers); // the same tap, again
    expect(vi.getTimerCount()).toBe(1);
    first.answer({ kind: 'found', orgId: 'org-b' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.handlers.answer).not.toHaveBeenCalled();
    expect(h.checks.running(1)).toBe(true);
    second.answer(FOUND);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.handlers.answer).toHaveBeenCalledTimes(1);
    expect(h.handlers.answer).toHaveBeenCalledWith(FOUND);
  });

  it('a stalled read: Checking at 400 ms, Try again at 15 s, and its late answer never reaches the retry', async () => {
    const h = harness();
    let settleFirst: (answer: { data: unknown; error: unknown }) => void = () => {};
    let settleSecond: (answer: { data: unknown; error: unknown }) => void = () => {};
    let reads = 0;
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () =>
        new Promise<{ data: unknown; error: unknown }>((resolve) => {
          reads += 1;
          if (reads === 1) settleFirst = resolve;
          else settleSecond = resolve;
        }),
    };
    const read = () => resolveTargetWorkspace({ from: () => chain }, 'order_requests', ORDER);
    h.checks.start(1, read, h.handlers);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.handlers.checking).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TARGET_READ_TIMEOUT_MS - 400);
    expect(h.handlers.answer).toHaveBeenCalledTimes(1);
    expect(h.handlers.answer).toHaveBeenLastCalledWith({
      kind: 'error',
      errorClass: 'TimeoutError',
    });
    expect(h.checks.running(1)).toBe(false);
    // Try again: the same tap, a new attempt.
    h.checks.start(1, read, h.handlers);
    settleFirst({ data: { organization_id: 'org-b' }, error: null });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.handlers.answer).toHaveBeenCalledTimes(1);
    settleSecond({ data: { organization_id: 'org-a' }, error: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.handlers.answer).toHaveBeenCalledTimes(2);
    expect(h.handlers.answer).toHaveBeenLastCalledWith(FOUND);
    expect(h.handlers.checking).toHaveBeenCalledTimes(1);
  });

  it('a read that rejects answers as a read error, with the class name only', async () => {
    const h = harness();
    const r = manualRead();
    h.checks.start(1, r.read, h.handlers);
    r.fail(new TypeError(`Network request failed for ${ORDER}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.handlers.answer).toHaveBeenCalledWith({ kind: 'error', errorClass: 'TypeError' });
  });

  it('the Checking notice says it in plain words, with Close and a spinner', () => {
    expect(checkingNoticeCopy('order')).toBe('Checking which workspace this order is in.');
    expect(checkingNoticeCopy('return')).toBe('Checking which workspace this return is in.');
    expect(noticeContent({ kind: 'checking', noun: 'order' }, { offline: false })).toEqual({
      heading: null,
      lines: ['Checking which workspace this order is in.'],
      actions: [{ id: 'close', label: 'Close', primary: false, disabled: false }],
      dismiss: 'close',
      announcement: 'Checking which workspace this order is in.',
      progress: true,
    });
    expect(noticeContent({ kind: 'retry' }, { offline: false }).progress).toBe(false);
  });
});

describe('the notices say plainly what happened', () => {
  it('another account', () => {
    expect(NOTICE_OTHER_ACCOUNT_COPY).toBe(
      'That notification was sent to a different account on this phone.',
    );
    expect(noticeContent({ kind: 'account-mismatch' }, { offline: false })).toMatchObject({
      heading: null,
      lines: [NOTICE_OTHER_ACCOUNT_COPY],
      actions: [{ id: 'ok', label: 'OK', primary: true, disabled: false }],
      dismiss: 'ok',
    });
  });

  it("no page in the app: the push's title and body, then the line; no Open on the web", () => {
    expect(NOTICE_NO_PAGE_COPY).toBe('This notification has no page in the app.');
    const content = noticeContent(
      { kind: 'unsupported', title: 'Push test', body: 'Hello' },
      { offline: false },
    );
    expect(content).toMatchObject({
      heading: 'Push test',
      lines: ['Hello', NOTICE_NO_PAGE_COPY],
      actions: [
        { id: 'open-notifications', label: 'Open notifications', primary: true },
        { id: 'close', label: 'Close', primary: false },
      ],
      dismiss: 'close',
    });
    expect(JSON.stringify(content)).not.toMatch(/web/i);
    expect(
      noticeContent({ kind: 'unsupported', title: null, body: null }, { offline: false }),
    ).toMatchObject({
      heading: null,
      lines: [NOTICE_NO_PAGE_COPY],
    });
  });

  it('unavailable', () => {
    expect(NOTICE_UNAVAILABLE_COPY).toBe(
      "This isn't available. It may have been removed, or it isn't shared with you.",
    );
    expect(noticeContent({ kind: 'unavailable' }, { offline: false })).toMatchObject({
      lines: [NOTICE_UNAVAILABLE_COPY],
      actions: [{ id: 'open-notifications' }, { id: 'close' }],
    });
  });

  it('try again', () => {
    expect(NOTICE_RETRY_COPY).toBe(
      'Could not open this notification. Check your connection and try again.',
    );
    expect(noticeContent({ kind: 'retry' }, { offline: false })).toMatchObject({
      lines: [NOTICE_RETRY_COPY],
      actions: [{ id: 'retry', label: 'Try again', primary: true }, { id: 'close' }],
    });
  });

  it('the switch names both workspaces, and is disabled offline', () => {
    const notice: IntentNotice = {
      kind: 'switch',
      orgId: 'org-a',
      orgName: 'Acme Demo Co',
      activeOrgName: 'Ledger QA Co',
      noun: 'order',
      native: `/order/${ORDER}`,
    };
    expect(switchNoticeCopy('order', 'Acme Demo Co', 'Ledger QA Co')).toBe(
      'This order is in Acme Demo Co. You are working in Ledger QA Co.',
    );
    expect(switchNoticeCopy('return', 'Acme Demo Co', null)).toBe(
      'This return is in Acme Demo Co. You are working in another workspace.',
    );
    expect(noticeContent(notice, { offline: false })).toMatchObject({
      lines: ['This order is in Acme Demo Co. You are working in Ledger QA Co.'],
      actions: [
        { id: 'switch', label: 'Switch to Acme Demo Co', primary: true, disabled: false },
        { id: 'not-now', label: 'Not now', primary: false, disabled: false },
      ],
      dismiss: 'not-now',
    });
    expect(noticeContent(notice, { offline: true }).actions[0]).toMatchObject({
      id: 'switch',
      disabled: true,
    });
  });

  /**
   * Review finding 6: while the switch ran, every button was disabled and
   * the sheet ignored the backdrop, Escape and back, with nothing saying a
   * switch was under way, for as long as setActiveOrg took (the SQLite wipe,
   * then the warehouse read of up to 15 s). It now says so, with a spinner,
   * until the destination opens (the host opens it once the new workspace is
   * published, before the warehouse read).
   */
  it('while the switch runs: "Switching to <Org>." with a spinner, and nothing to press half-way', () => {
    const notice: IntentNotice = {
      kind: 'switch',
      orgId: 'org-a',
      orgName: 'Acme Demo Co',
      activeOrgName: 'Ledger QA Co',
      noun: 'order',
      native: `/order/${ORDER}`,
    };
    expect(switchingNoticeCopy('Acme Demo Co')).toBe('Switching to Acme Demo Co.');
    expect(noticeContent(notice, { offline: false, busy: true })).toEqual({
      heading: null,
      lines: ['Switching to Acme Demo Co.'],
      actions: [],
      dismiss: null,
      announcement: 'Switching to Acme Demo Co.',
      progress: true,
    });
    // A connection lost mid-switch says the same: the switch is under way.
    expect(noticeContent(notice, { offline: true, busy: true }).lines).toEqual([
      'Switching to Acme Demo Co.',
    ]);
    // Before Switch is pressed: the question and its two buttons, as before.
    expect(noticeContent(notice, { offline: false, busy: false })).toMatchObject({
      actions: [{ id: 'switch' }, { id: 'not-now' }],
      dismiss: 'not-now',
      progress: false,
    });
  });

  const ALL_NOTICES: IntentNotice[] = [
    { kind: 'account-mismatch' },
    { kind: 'unsupported', title: null, body: null },
    { kind: 'unavailable' },
    { kind: 'retry' },
    { kind: 'checking', noun: 'return' },
    {
      kind: 'switch',
      orgId: 'o',
      orgName: 'A',
      activeOrgName: 'B',
      noun: 'return',
      native: '/returns',
    },
  ];

  it('every line is plain: no exclamation marks, and never "book" for a recorded quantity', () => {
    for (const notice of ALL_NOTICES) {
      for (const busy of [false, true]) {
        const text = JSON.stringify(noticeContent(notice, { offline: true, busy }));
        expect(text).not.toContain('!');
        expect(text).not.toMatch(/\bbook\b/i);
      }
    }
  });

  it("each notice's kind is an allowed breadcrumb reason (the host sends it as one)", () => {
    for (const notice of ALL_NOTICES) {
      expect(PUSH_OPEN_REASONS as readonly string[]).toContain(notice.kind);
    }
  });
});

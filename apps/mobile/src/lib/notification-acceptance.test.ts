import { describe, expect, it, vi } from 'vitest';

import {
  createNotificationIntentStore,
  type NotificationIntentStore,
  type SessionLike,
  type TapResponse,
} from './notification-intent';
import {
  nextOpenStep,
  noticeContent,
  resolveTargetWorkspace,
  stepAfterResolution,
  NOTICE_UNAVAILABLE_COPY,
  type OpenStep,
  type WorkspaceResolverClient,
  type WorkspaceView,
} from './notification-open';
import { pushOpenDiag } from './push-open-diagnostics';

// The phone's native side, the session and the database are faked; the
// coordinator, the link parser, the open steps and the sanitised diagnostics
// are the real ones. Sentry only records the breadcrumbs it is handed.
const sentry = vi.hoisted(() => ({ crumbs: [] as unknown[] }));
vi.mock('./sentry', () => ({
  Sentry: {
    addBreadcrumb: (crumb: unknown) => {
      sentry.crumbs.push(crumb);
    },
    captureException: vi.fn(),
  },
}));
vi.mock('expo-notifications', () => ({}));
vi.mock('./supabase', () => ({ supabase: {} }));
vi.mock('./remembered-identity', () => ({
  getRememberedIdentity: vi.fn(async () => null),
  normalizeIdentityEmail: (raw: string) => raw.trim().toLowerCase(),
}));

/**
 * ACCEPTANCE: THE WRONG-WORKSPACE TAP THAT ANSWERED 404 (Phase 3, iPhone push
 * tap; map-push.md section 5).
 *
 * Production, 2026-10-12 01:20:01Z (the RX-3 R9 log check): the owner's
 * iPhone, working in one workspace (Learn4Life), tapped another workspace's
 * (Demo Co's) "New exchange request" about 38 seconds after it was sent. The
 * phone opened the return inside the workspace it was working in, sent that
 * workspace as X-Organization-Id, and GET /api/v1/returns/<rma> answered 404:
 * the record belongs to the other workspace.
 *
 * Accepted when: a return pushed from workspace A and tapped while the phone
 * works in workspace B is checked first, the person is told plainly that it is
 * in A and offered the switch (never switched silently), and the switch opens
 * the return itself, never the original order the dual link also names; on a
 * cold start and warm, and while a screen reloads the workspace. The same for
 * a replacement-order push. A record the person cannot read in any of their
 * workspaces says so in the words used for a missing one, and nothing is ever
 * opened inside the wrong workspace.
 *
 * Here the workspace read answers what the database would for a member of
 * both workspaces (RLS: returns_select and order_requests_select are
 * is_org_member). The simulator walk (case C5, on the local stack) and the
 * owner's iPhone matrix repeat it on a phone; both are still to run.
 */

const DEFAULT = 'expo.modules.notifications.actions.DEFAULT';
const RMA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ORIGINAL = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const REPLACEMENT = 'cccccccc-3333-4333-8333-cccccccccccc';
const FOREIGN = 'dddddddd-4444-4444-8444-dddddddddddd';
const NOW = 5_000_000;

const OWNER = { id: 'user-owner', email: 'owner@example.test' };
/** The workspace the phone works in (Learn4Life in the sighting). */
const WORKING = { id: 'org-working', name: 'Ledger QA Co' };
/** The workspace the push came from (Demo Co in the sighting). */
const OTHER = { id: 'org-other', name: 'Acme Demo Co' };

const IN_WORKING: WorkspaceView = {
  loading: false,
  orgs: [WORKING, OTHER],
  activeOrgId: WORKING.id,
  activeOrgName: WORKING.name,
};
const IN_OTHER: WorkspaceView = { ...IN_WORKING, activeOrgId: OTHER.id, activeOrgName: OTHER.name };

/** The staff "New exchange request" (returns-notify.ts returnStaffLink). */
const DUAL = `/dashboard/returns/${RMA}?order=/dashboard/orders/${ORIGINAL}`;

function push(link: string, type: string, title: string, identifier = 'req-1'): TapResponse {
  return {
    actionIdentifier: DEFAULT,
    notification: {
      date: 1_000,
      request: { identifier, content: { title, body: 'Open it to review.', data: { link, type } } },
    },
  };
}

/** One phone: the coordinator with its native side and session faked. */
function phone() {
  const listeners: ((r: TapResponse) => void)[] = [];
  let last: TapResponse | null = null;
  let auth: ((session: SessionLike | null) => void) | null = null;
  const store = createNotificationIntentStore({
    notifications: {
      DEFAULT_ACTION_IDENTIFIER: DEFAULT,
      addNotificationResponseReceivedListener: (fn) => {
        listeners.push(fn);
        return { remove: () => {} };
      },
      getLastNotificationResponse: () => last,
      clearLastNotificationResponse: () => {
        last = null;
      },
      dismissAllNotificationsAsync: async () => {},
    },
    onAuthChange: (fn) => {
      auth = fn;
    },
    readRememberedIdentity: async () => null,
    diag: pushOpenDiag,
    now: () => NOW,
  });
  return {
    store,
    /** The tap that launched the app: native holds it, no listener heard it. */
    launchedFrom(r: TapResponse) {
      last = r;
    },
    /** A tap while the app runs (foreground, or background then Notification Center). */
    tap(r: TapResponse) {
      last = r;
      for (const fn of listeners) fn(r);
    },
    signedIn() {
      auth?.({ user: OWNER });
    },
    nativeLast: () => last,
  };
}

/** The database, as RLS answers this owner: id -> organization, per table. */
function database(rows: Partial<Record<'returns' | 'order_requests', Record<string, string>>>) {
  const reads: string[][] = [];
  const client: WorkspaceResolverClient = {
    from(table: string) {
      const call = [`from:${table}`];
      const query = {
        select(columns: string) {
          call.push(`select:${columns}`);
          return query;
        },
        eq(column: string, value: string) {
          call.push(`eq:${column}=${value}`);
          return query;
        },
        async maybeSingle() {
          reads.push(call);
          const id = call.find((c) => c.startsWith('eq:id='))?.slice('eq:id='.length);
          const org = id ? rows[table as 'returns' | 'order_requests']?.[id] : undefined;
          return { data: org ? { organization_id: org } : null, error: null };
        },
      };
      return query;
    },
  };
  return { client, reads };
}

/** What NotificationIntentHost decides for the pending tap, read for read. */
async function hostDecides(
  store: NotificationIntentStore,
  workspace: WorkspaceView,
  client: WorkspaceResolverClient,
  opts: { pathname?: string; workspaceShown?: boolean } = {},
): Promise<{ first: OpenStep; last: OpenStep }> {
  const pending = store.peek();
  if (!pending) throw new Error('no tap pending');
  const pathname = opts.pathname ?? '/';
  const first = nextOpenStep({
    take: store.take({ id: OWNER.id, email: OWNER.email }, NOW),
    forSeq: pending.seq,
    mfaPending: false,
    routerReady: true,
    stackRoute: '(drawer)',
    segments: ['(drawer)', '(tabs)'],
    pathname,
    workspace,
    workspaceShown: opts.workspaceShown ?? true,
  });
  if (first.kind !== 'resolve' || !pending.target.ok) return { first, last: first };
  const resolution = await resolveTargetWorkspace(client, first.table, first.id);
  const last = stepAfterResolution({
    answerSeq: pending.seq,
    currentSeq: store.peek()?.seq ?? null,
    resolution,
    native: pending.target.native,
    routeKind: pending.target.routeKind,
    workspace,
    pathname,
  });
  return { first, last };
}

const SWITCH_TO_RETURN = {
  kind: 'notice',
  notice: {
    kind: 'switch',
    orgId: OTHER.id,
    orgName: OTHER.name,
    activeOrgName: WORKING.name,
    noun: 'return',
    native: `/returns/${RMA}`,
  },
} as const;

describe("acceptance: another workspace's return, tapped while the phone works in this one (the 404 of 2026-10-12)", () => {
  it('cold start: checked first, the switch offered in plain words, and the switch opens the return itself', async () => {
    const p = phone();
    p.launchedFrom(push(DUAL, 'return.requested', 'New exchange request'));
    p.store.start(); // app/_layout.tsx, at module scope
    p.signedIn(); // the restored session
    const tap = p.store.peek();
    // Routed on the path: the return, never the original order the link names.
    expect(tap?.target).toMatchObject({
      ok: true,
      native: `/returns/${RMA}`,
      routeKind: 'returns',
      resourceId: RMA,
    });

    const db = database({ returns: { [RMA]: OTHER.id } });
    const { first, last } = await hostDecides(p.store, IN_WORKING, db.client);
    // Before: /returns/<rma> opened at once inside the working workspace (the
    // 404). Now nothing opens before the return's own workspace is known.
    expect(first).toEqual({ kind: 'resolve', table: 'returns', id: RMA });
    // One read, of the return by its id, with NO organization filter: the
    // working workspace is exactly what is in question.
    expect(db.reads).toEqual([['from:returns', 'select:organization_id', `eq:id=${RMA}`]]);
    expect(last).toEqual(SWITCH_TO_RETURN);

    if (last.kind !== 'notice') throw new Error('expected the switch notice');
    const words = noticeContent(last.notice, { offline: false });
    expect(words.lines).toEqual([
      'This return is in Acme Demo Co. You are working in Ledger QA Co.',
    ]);
    expect(words.actions.map((a) => [a.label, a.primary, a.disabled])).toEqual([
      ['Switch to Acme Demo Co', true, false],
      ['Not now', false, false],
    ]);
    // Offline, the switch cannot start (the drawer switcher's own rule).
    expect(
      noticeContent(last.notice, { offline: true }).actions.find((a) => a.id === 'switch')
        ?.disabled,
    ).toBe(true);

    // Switch: once Acme Demo Co is published, the host opens the notice's own
    // destination, the return, in the workspace it belongs to.
    expect(last.notice).toMatchObject({ orgId: OTHER.id, native: `/returns/${RMA}` });
    expect(await hostDecides(p.store, IN_OTHER, db.client)).toEqual({
      first: { kind: 'resolve', table: 'returns', id: RMA },
      last: { kind: 'navigate', path: `/returns/${RMA}` },
    });
    p.store.finish(tap!, 'switched');
    expect(p.store.peek()).toBeNull();
    expect(p.nativeLast()).toBeNull(); // the launch tap never opens again
  });

  it('warm, from the banner or Notification Center: the same check and the same switch', async () => {
    const p = phone();
    p.store.start();
    p.signedIn();
    p.tap(push(DUAL, 'return.requested', 'New exchange request'));
    const db = database({ returns: { [RMA]: OTHER.id } });
    const { first, last } = await hostDecides(p.store, IN_WORKING, db.client);
    expect(first).toEqual({ kind: 'resolve', table: 'returns', id: RMA });
    expect(last).toEqual(SWITCH_TO_RETURN);
  });

  it('while a screen loads the workspace again: still checked at once, never held, never opened in the wrong one', async () => {
    const p = phone();
    p.store.start();
    p.signedIn();
    p.tap(push(DUAL, 'return.requested', 'New exchange request'));
    const db = database({ returns: { [RMA]: OTHER.id } });
    const { first, last } = await hostDecides(p.store, { ...IN_WORKING, loading: true }, db.client);
    expect(first).toEqual({ kind: 'resolve', table: 'returns', id: RMA });
    expect(last).toEqual(SWITCH_TO_RETURN);
  });

  it('a replacement order from the other workspace: the switch, then the replacement order', async () => {
    const p = phone();
    p.store.start();
    p.signedIn();
    // _notify_replacement_order_changes: type order_request.<status>, linked
    // to the replacement order (its replacement flag stays on the server).
    p.tap(push(`/dashboard/orders/${REPLACEMENT}`, 'order_request.completed', 'Order completed'));
    const db = database({ order_requests: { [REPLACEMENT]: OTHER.id } });
    const { first, last } = await hostDecides(p.store, IN_WORKING, db.client);
    expect(first).toEqual({ kind: 'resolve', table: 'order_requests', id: REPLACEMENT });
    expect(db.reads).toEqual([
      ['from:order_requests', 'select:organization_id', `eq:id=${REPLACEMENT}`],
    ]);
    expect(last).toEqual({
      kind: 'notice',
      notice: {
        kind: 'switch',
        orgId: OTHER.id,
        orgName: OTHER.name,
        activeOrgName: WORKING.name,
        noun: 'order',
        native: `/order/${REPLACEMENT}`,
      },
    });
    if (last.kind !== 'notice') throw new Error('expected the switch notice');
    expect(noticeContent(last.notice, { offline: false }).lines).toEqual([
      'This order is in Acme Demo Co. You are working in Ledger QA Co.',
    ]);
  });

  it('the same return in the workspace the phone works in opens at once, as before', async () => {
    const p = phone();
    p.store.start();
    p.signedIn();
    p.tap(push(DUAL, 'return.requested', 'New exchange request'));
    const db = database({ returns: { [RMA]: WORKING.id } });
    expect((await hostDecides(p.store, IN_WORKING, db.client)).last).toEqual({
      kind: 'navigate',
      path: `/returns/${RMA}`,
    });
  });

  it('a return this person cannot read in any workspace: the words for a missing one, and nothing opens', async () => {
    const p = phone();
    p.store.start();
    p.signedIn();
    p.tap(
      push(
        `/dashboard/returns/${FOREIGN}?order=/dashboard/orders/${ORIGINAL}`,
        'return.requested',
        'New return request',
      ),
    );
    // RLS hides another tenant's row: no row at all, exactly as a deleted one.
    const hidden = await hostDecides(p.store, IN_WORKING, database({}).client);
    // A row in a workspace this person is not a member of (never shown).
    const elsewhere = await hostDecides(
      p.store,
      IN_WORKING,
      database({ returns: { [FOREIGN]: 'org-not-mine' } }).client,
    );
    for (const { last } of [hidden, elsewhere]) {
      expect(last).toEqual({ kind: 'notice', notice: { kind: 'unavailable' } });
      if (last.kind !== 'notice') throw new Error('expected the unavailable notice');
      expect(noticeContent(last.notice, { offline: false }).lines).toEqual([
        NOTICE_UNAVAILABLE_COPY,
      ]);
    }
  });

  it('nothing the tap read leaves the phone: no id, link, title or workspace in the breadcrumbs', async () => {
    sentry.crumbs.length = 0;
    const p = phone();
    p.launchedFrom(push(DUAL, 'return.requested', 'New exchange request'));
    p.store.start();
    p.signedIn();
    const db = database({ returns: { [RMA]: OTHER.id } });
    await hostDecides(p.store, IN_WORKING, db.client);
    p.store.finish(p.store.peek()!, 'switched');
    expect(sentry.crumbs.length).toBeGreaterThan(0);
    const sent = JSON.stringify(sentry.crumbs);
    for (const secret of [
      RMA,
      ORIGINAL,
      '/dashboard',
      'exchange',
      OWNER.id,
      OWNER.email,
      WORKING.id,
      OTHER.id,
      'Acme',
      'Ledger',
    ]) {
      expect(sent).not.toContain(secret);
    }
  });
});

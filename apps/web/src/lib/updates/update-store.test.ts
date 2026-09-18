// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const build = vi.hoisted(() => ({ id: 'aaaaaaaaaaaa', builtAt: '2026-09-18T10:00:00.000Z' }));
vi.mock('@/lib/build-info', () => ({
  get LOADED_BUILD() {
    return build.id;
  },
  get LOADED_BUILT_AT() {
    return build.builtAt;
  },
}));
const capture = vi.fn();
vi.mock('@/lib/analytics', () => ({ capture: (...a: unknown[]) => capture(...a) }));
const reloadToBuild = vi.fn();
const reconcileReload = vi.fn(() => 'none' as const);
vi.mock('./safe-reload', () => ({
  reloadToBuild: (...a: unknown[]) => reloadToBuild(...a),
  reconcileReload: (...a: unknown[]) => reconcileReload(...(a as [])),
}));

import { registerUnsavedSource, resetUnsavedSourcesForTests } from '@/lib/unsaved-work';

import {
  checkForUpdate,
  closeWhatsNew,
  dismissNotice,
  getUpdateState,
  LIST_PENDING,
  markAllRead,
  noteNoticeShown,
  openWhatsNew,
  recheckUnsaved,
  RELEASES_WAIT_MS,
  requestRefresh,
  resetUpdateStoreForTests,
  retryRelease,
  selectNotice,
  startUpdateCenter,
} from './update-store';

/**
 * The update center answers two questions that must never be merged: "does this
 * tab need a refresh?" and "is there something unread for me?". These tests pin
 * the behaviours the old notifier got wrong or never had.
 */

const summary = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  revision: 1,
  status: 'published',
  title: `Release ${id}`,
  summary: 's',
  publishedAt: '2026-09-18T17:00:00Z',
  entryCount: 1,
  state: { read: false, dismissed: false },
  ...over,
});

const server = {
  version: {
    build: 'aaaaaaaaaaaa',
    builtAt: '2026-09-18T10:00:00.000Z',
    releasesKey: 'k1',
  } as Record<string, unknown>,
  versionOk: true,
  list: {
    releases: [summary('sept')],
    unreadCount: 1,
    latestUnread: summary('sept'),
    stateAvailable: true,
  } as Record<string, unknown>,
  stateOk: true,
  /** What POST release-state reports as written. 0 = the server did not recognise the release. */
  recorded: 1,
  posted: [] as Array<Record<string, unknown>>,
  detailOk: true,
  listOk: true,
  /** When set, the NEXT list request waits on it: lets a test order responses. */
  listGate: null as Promise<void> | null,
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === '/api/version')
    return server.versionOk ? Response.json(server.version) : new Response('nope', { status: 503 });
  if (url === '/api/v1/me/releases') {
    const body = server.list;
    const ok = server.listOk;
    const gate = server.listGate;
    server.listGate = null;
    if (gate) await gate;
    return ok ? Response.json(body) : new Response('x', { status: 503 });
  }
  if (url === '/api/v1/me/release-state') {
    server.posted.push(JSON.parse(String(init?.body)));
    return server.stateOk
      ? Response.json({ ok: true, recorded: server.recorded })
      : Response.json({ ok: false }, { status: 503 });
  }
  if (url.startsWith('/api/v1/me/releases/')) {
    if (!server.detailOk) return new Response('x', { status: 500 });
    return Response.json({ release: { ...summary('sept'), entries: [] } });
  }
  return new Response('not found', { status: 404 });
});

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  resetUpdateStoreForTests();
  resetUnsavedSourcesForTests();
  localStorage.clear();
  build.id = 'aaaaaaaaaaaa';
  server.version = {
    build: 'aaaaaaaaaaaa',
    builtAt: '2026-09-18T10:00:00.000Z',
    releasesKey: 'k1',
  };
  server.versionOk = true;
  server.stateOk = true;
  server.recorded = 1;
  server.detailOk = true;
  server.listOk = true;
  server.listGate = null;
  server.posted = [];
  server.list = {
    releases: [summary('sept')],
    unreadCount: 1,
    latestUnread: summary('sept'),
    stateAvailable: true,
  };
  fetchMock.mockClear();
  capture.mockClear();
  reloadToBuild.mockClear();
  reconcileReload.mockReset();
  reconcileReload.mockReturnValue('none');
  build.builtAt = '2026-09-18T10:00:00.000Z';
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('deployment detection', () => {
  it('is current when production serves this tab’s build, and says nothing about a refresh', async () => {
    await checkForUpdate();
    expect(getUpdateState().status).toBe('current');
  });

  it('a tab opened DURING a deploy still learns it is stale: the baseline is the bundle, not the first poll', async () => {
    // The very first poll already answers from the NEW deployment. The old
    // notifier took that as its baseline and never prompted.
    server.version = {
      build: 'bbbbbbbbbbbb',
      builtAt: '2026-09-18T12:00:00.000Z',
      releasesKey: 'k1',
    };
    await checkForUpdate();
    expect(getUpdateState().status).toBe('update_available');
  });

  it('a failed poll changes nothing and says nothing', async () => {
    server.versionOk = false;
    await checkForUpdate();
    expect(getUpdateState().status).toBe('unknown');
    expect(selectNotice(getUpdateState())).toEqual({ kind: 'none' });
  });

  it('does nothing in development, where there is no loaded build to compare', async () => {
    build.id = '';
    await checkForUpdate();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dedupes a burst of triggers into one request', async () => {
    await Promise.all([checkForUpdate(), checkForUpdate(), checkForUpdate()]);
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/version')).toHaveLength(1);
  });

  it('does not poll while offline', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    await checkForUpdate();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('selectNotice: exactly one notice, or none', () => {
  const base = () => ({ ...getUpdateState() });

  it('a newer build with an unread release offers both actions on ONE notice', () => {
    const s = {
      ...base(),
      status: 'update_available' as const,
      served: { build: 'b', builtAt: null, releasesKey: 'k1' },
      releases: server.list as never,
    };
    expect(selectNotice(s)).toMatchObject({ kind: 'update', build: 'b', release: { id: 'sept' } });
  });

  it('a newer build with nothing unread keeps the legitimate refresh, with no release attached', () => {
    const s = {
      ...base(),
      status: 'update_available' as const,
      served: { build: 'b', builtAt: null, releasesKey: null },
      releases: { releases: [], unreadCount: 0, latestUnread: null, stateAvailable: true },
    };
    expect(selectNotice(s)).toEqual({ kind: 'update', build: 'b', release: null });
  });

  it('a rollback is its own notice and never offers What’s New', () => {
    const s = {
      ...base(),
      status: 'rolled_back' as const,
      served: { build: 'old', builtAt: null, releasesKey: 'k1' },
      releases: server.list as never,
    };
    expect(selectNotice(s)).toEqual({ kind: 'rollback', build: 'old' });
  });

  it('a current tab with something unread gets the no-refresh notice', () => {
    expect(
      selectNotice({ ...base(), status: 'current', releases: server.list as never }),
    ).toMatchObject({ kind: 'unread', release: { id: 'sept' } });
  });

  it('a dismissed refresh notice stays dismissed for that build, but a NEWER build prompts again', () => {
    const served = { build: 'b', builtAt: null, releasesKey: null };
    const none = { releases: [], unreadCount: 0, latestUnread: null, stateAvailable: true };
    expect(
      selectNotice({
        ...base(),
        status: 'update_available',
        served,
        dismissedBuild: 'b',
        releases: none,
      }),
    ).toEqual({ kind: 'none' });
    expect(
      selectNotice({
        ...base(),
        status: 'update_available',
        served: { ...served, build: 'c' },
        dismissedBuild: 'b',
        releases: none,
      }).kind,
    ).toBe('update');
  });
});

describe('dismissing', () => {
  it('records a DISMISSAL and never a read, and the tab still needs its refresh', async () => {
    server.version = {
      build: 'bbbbbbbbbbbb',
      builtAt: '2026-09-18T12:00:00.000Z',
      releasesKey: 'k1',
    };
    const stop = startUpdateCenter('user-1');
    await flush();
    const notice = selectNotice(getUpdateState());
    expect(notice.kind).toBe('update');

    dismissNotice(notice);
    await flush();
    expect(server.posted).toEqual([{ action: 'dismiss', releaseId: 'sept' }]);
    expect(getUpdateState().status).toBe('update_available');
    expect(getUpdateState().releases!.releases[0]!.state).toEqual({ read: false, dismissed: true });
    expect(getUpdateState().releases!.unreadCount).toBe(1);
    expect(selectNotice(getUpdateState())).toEqual({ kind: 'none' });
    expect(JSON.parse(localStorage.getItem('sp:update-dismissed:user-1')!)).toEqual({
      loaded: 'aaaaaaaaaaaa',
      served: 'bbbbbbbbbbbb',
    });
    stop();
  });

  it('scopes the dismissed build to the person, so a shared device does not leak it', async () => {
    startUpdateCenter('user-1')();
    localStorage.setItem(
      'sp:update-dismissed:user-1',
      JSON.stringify({ loaded: 'aaaaaaaaaaaa', served: 'bbbbbbbbbbbb' }),
    );
    resetUpdateStoreForTests();
    startUpdateCenter('user-2')();
    expect(getUpdateState().dismissedBuild).toBeNull();
  });
});

describe('impressions', () => {
  it('counts a notice once however many times it renders', () => {
    const notice = { kind: 'unread' as const, release: summary('sept') as never };
    noteNoticeShown(notice);
    noteNoticeShown(notice);
    noteNoticeShown(notice);
    expect(capture.mock.calls.filter((c) => c[0] === 'update_notification_shown')).toHaveLength(1);
  });

  it('sends ids only: never release text', () => {
    noteNoticeShown({ kind: 'unread', release: summary('sept') as never });
    expect(JSON.stringify(capture.mock.calls)).not.toContain('Release sept');
  });
});

describe('the drawer', () => {
  it('opening records OPENED at once and READ only after the details rendered', async () => {
    startUpdateCenter('user-1')();
    await flush();
    openWhatsNew('sept');
    expect(getUpdateState().detail).toEqual({ phase: 'loading', releaseId: 'sept' });
    await flush();
    expect(getUpdateState().detail.phase).toBe('ready');
    expect(server.posted.map((p) => p.action)).toEqual(['open', 'read']);
    expect(getUpdateState().releases!.unreadCount).toBe(0);
  });

  it('a FAILED load is opened, not read, and offers a retry', async () => {
    startUpdateCenter('user-1')();
    await flush();
    server.detailOk = false;
    openWhatsNew('sept');
    await flush();
    expect(getUpdateState().detail).toEqual({ phase: 'error', releaseId: 'sept', offline: false });
    expect(server.posted.map((p) => p.action)).toEqual(['open']);
    expect(getUpdateState().releases!.unreadCount).toBe(1);
  });

  it('says so when the read could not be saved, and keeps the release unread', async () => {
    startUpdateCenter('user-1')();
    await flush();
    server.stateOk = false;
    openWhatsNew('sept');
    await flush();
    expect(getUpdateState().saveFailed).toBe(true);
    expect(getUpdateState().releases!.unreadCount).toBe(1);
  });

  it('closing KEEPS the content: the sheet is still on screen while it slides out', async () => {
    startUpdateCenter('user-1')();
    await flush();
    openWhatsNew('sept');
    await flush();
    closeWhatsNew();
    expect(getUpdateState().drawerOpen).toBe(false);
    expect(getUpdateState().detail.phase).toBe('ready');
    // ...and the next open starts clean rather than flashing the old release.
    openWhatsNew('sept');
    expect(getUpdateState().detail).toEqual({ phase: 'loading', releaseId: 'sept' });
  });

  it('the entry point opens the newest UNREAD release even when its notice was dismissed', async () => {
    // latestUnread is the NOTICE's offer: null once the newest unread is dismissed.
    server.list = {
      releases: [
        summary('newer', { state: { read: true, dismissed: false } }),
        summary('older', { state: { read: false, dismissed: true } }),
      ],
      unreadCount: 1,
      latestUnread: null,
      stateAvailable: true,
    };
    startUpdateCenter('user-1')();
    await flush();
    openWhatsNew(null, 'topbar');
    expect(getUpdateState().drawerReleaseId).toBe('older');
    await flush();
    expect(server.posted[0]).toEqual({ action: 'open', releaseId: 'older' });
  });

  it('opened BEFORE the list arrived it waits for the list instead of claiming there is nothing', async () => {
    openWhatsNew(null, 'topbar');
    expect(getUpdateState().detail).toEqual({ phase: 'loading', releaseId: LIST_PENDING });
    await flush();
    expect(getUpdateState().drawerReleaseId).toBe('sept');
    expect(getUpdateState().detail.phase).toBe('ready');
  });

  it('when the list cannot be loaded it says THAT, and Try again recovers', async () => {
    server.listOk = false;
    openWhatsNew(null, 'topbar');
    await flush();
    expect(getUpdateState().detail).toEqual({
      phase: 'error',
      releaseId: LIST_PENDING,
      offline: false,
    });
    server.listOk = true;
    retryRelease();
    await flush();
    expect(getUpdateState().detail.phase).toBe('ready');
  });

  it('a write the server did not recognise (recorded: 0) is NOT saved', async () => {
    startUpdateCenter('user-1')();
    await flush();
    server.recorded = 0;
    openWhatsNew('sept');
    await flush();
    expect(getUpdateState().saveFailed).toBe(true);
    expect(getUpdateState().releases!.unreadCount).toBe(1);
  });

  it('mark all as read is explicit, and reports a failure instead of pretending', async () => {
    startUpdateCenter('user-1')();
    await flush();
    server.stateOk = false;
    expect(await markAllRead()).toBe(false);
    expect(getUpdateState().saveFailed).toBe(true);
    server.stateOk = true;
    expect(await markAllRead()).toBe(true);
    expect(server.posted.at(-1)).toEqual({ action: 'read_all' });
  });
});

describe('Refresh to update', () => {
  it('reloads toward the served build when nothing is unsaved', async () => {
    server.version = { build: 'bbbbbbbbbbbb', builtAt: '2026-09-18T12:00:00.000Z' };
    await checkForUpdate();
    expect(requestRefresh()).toEqual({ blocked: false });
    // It records where it IS as well as where it is going: success is judged by
    // whether the tab moved.
    expect(reloadToBuild).toHaveBeenCalledWith('bbbbbbbbbbbb', 'aaaaaaaaaaaa');
  });

  it('does NOT reload over unsaved work: it names it and waits for a decision', () => {
    registerUnsavedSource({ id: 'item-form', label: 'New item', isDirty: () => true });
    expect(requestRefresh()).toEqual({ blocked: true });
    expect(reloadToBuild).not.toHaveBeenCalled();
    expect(getUpdateState().blockedBy).toEqual([{ id: 'item-form', label: 'New item' }]);
    // Field contents never reach analytics, only the source id.
    const call = capture.mock.calls.find((c) => c[0] === 'update_refresh_blocked_unsaved_changes');
    expect(call?.[1]).toEqual({ sources: ['item-form'] });
  });

  it('stops claiming unsaved work once it is saved, and NEVER reloads on its own', () => {
    let dirty = true;
    registerUnsavedSource({ id: 'item-form', label: 'New item', isDirty: () => dirty });
    requestRefresh();
    recheckUnsaved();
    expect(getUpdateState().blockedBy).toHaveLength(1);
    dirty = false;
    recheckUnsaved();
    expect(getUpdateState().blockedBy).toEqual([]);
    expect(reloadToBuild).not.toHaveBeenCalled();
  });

  it('does not carry the confirmation into a later mount', () => {
    const stop = startUpdateCenter('user-1');
    registerUnsavedSource({ id: 'item-form', label: 'New item', isDirty: () => true });
    requestRefresh();
    expect(getUpdateState().blockedBy).toHaveLength(1);
    stop();
    expect(getUpdateState().blockedBy).toEqual([]);
  });

  it('"Refresh anyway" is an explicit decision', () => {
    registerUnsavedSource({ id: 'item-form', label: 'New item', isDirty: () => true });
    expect(requestRefresh({ force: true })).toEqual({ blocked: false });
    expect(reloadToBuild).toHaveBeenCalledTimes(1);
  });
});

describe('boot and lifecycle', () => {
  it('finds unread releases with NO deploy in sight, so What’s New survives an automatic reload', async () => {
    const stop = startUpdateCenter('user-1');
    await flush();
    expect(getUpdateState().status).toBe('current');
    expect(selectNotice(getUpdateState())).toMatchObject({
      kind: 'unread',
      release: { id: 'sept' },
    });
    stop();
  });

  it('a remount does not re-baseline, re-fetch or forget', async () => {
    const stop1 = startUpdateCenter('user-1');
    await flush();
    const before = fetchMock.mock.calls.length;
    const stop2 = startUpdateCenter('user-1');
    await flush();
    expect(fetchMock.mock.calls.length).toBe(before);
    stop1();
    expect(getUpdateState().releases).not.toBeNull();
    stop2();
    expect(getUpdateState().releases).not.toBeNull();
  });

  it('reports a reload that reached its target', async () => {
    reconcileReload.mockReturnValueOnce('reached' as never);
    startUpdateCenter('user-1')();
    expect(capture.mock.calls.some((c) => c[0] === 'update_target_loaded')).toBe(true);
  });
});

describe('one composed notice', () => {
  afterEach(() => vi.useRealTimers());

  it('waits for the served registry’s list, so the card is never shown and then changed', async () => {
    await checkForUpdate();
    expect(getUpdateState().status).toBe('current');

    let open!: () => void;
    server.listGate = new Promise<void>((r) => (open = r));
    server.version = {
      build: 'bbbbbbbbbbbb',
      builtAt: '2026-09-18T12:00:00.000Z',
      releasesKey: 'k2',
    };
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    const pending = checkForUpdate();
    await flush();
    // The new build is known, and deliberately not announced yet.
    expect(getUpdateState().status).toBe('current');
    open();
    await pending;
    expect(selectNotice(getUpdateState())).toMatchObject({
      kind: 'update',
      release: { id: 'sept' },
    });
  });

  it('does not wait forever: a slow list costs a few seconds, never the refresh notice', async () => {
    vi.useFakeTimers();
    server.listGate = new Promise<void>(() => {});
    server.version = {
      build: 'bbbbbbbbbbbb',
      builtAt: '2026-09-18T12:00:00.000Z',
      releasesKey: 'k2',
    };
    const pending = checkForUpdate();
    await vi.advanceTimersByTimeAsync(RELEASES_WAIT_MS + 10);
    await pending;
    expect(selectNotice(getUpdateState())).toEqual({
      kind: 'update',
      build: 'bbbbbbbbbbbb',
      release: null,
    });
  });

  it('keeps asking for the list while it has none, so one failed request is not the whole session', async () => {
    // Served WITHOUT a registry key (an older deployment mid-rollout, or an
    // empty registry): "the key changed" can never be the reason to fetch, so
    // "this tab has no list" has to be one.
    server.version = { build: 'aaaaaaaaaaaa', builtAt: '2026-09-18T10:00:00.000Z' };
    server.listOk = false;
    await checkForUpdate();
    expect(getUpdateState().releases).toBeNull();
    server.listOk = true;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    await checkForUpdate();
    expect(getUpdateState().releases).not.toBeNull();
  });
});

describe('a different person, or organization, in the same tab', () => {
  const listFor = (id: string) => ({
    releases: [summary(id)],
    unreadCount: 1,
    latestUnread: summary(id),
    stateAvailable: true,
  });

  it('shows the next person NOTHING of the previous one: list, count and open drawer go', async () => {
    server.list = listFor('for-owner');
    const stop1 = startUpdateCenter('user-1', 'org-1');
    await flush();
    openWhatsNew('for-owner');
    await flush();
    stop1();

    server.list = listFor('for-staff');
    const stop2 = startUpdateCenter('user-2', 'org-1');
    // Before any request answers: the previous person's data is already gone.
    expect(getUpdateState().releases).toBeNull();
    expect(getUpdateState().drawerOpen).toBe(false);
    expect(getUpdateState().detail).toEqual({ phase: 'idle' });
    await flush();
    expect(getUpdateState().releases!.releases.map((r) => r.id)).toEqual(['for-staff']);
    stop2();
  });

  it('discards a list that was still in flight for the previous person', async () => {
    let open!: () => void;
    server.list = listFor('for-owner');
    server.listGate = new Promise<void>((r) => (open = r));
    const stop1 = startUpdateCenter('user-1', 'org-1');
    await flush();
    stop1();

    server.list = listFor('for-staff');
    const stop2 = startUpdateCenter('user-2', 'org-1');
    await flush();
    open(); // the owner's response lands LAST
    await flush();
    expect(getUpdateState().releases!.releases.map((r) => r.id)).toEqual(['for-staff']);
    stop2();
  });

  it('treats an organization switch the same way: the audience is per organization', async () => {
    server.list = listFor('org-one');
    const stop1 = startUpdateCenter('user-1', 'org-1');
    await flush();
    stop1();
    server.list = listFor('org-two');
    const stop2 = startUpdateCenter('user-1', 'org-2');
    expect(getUpdateState().releases).toBeNull();
    await flush();
    expect(getUpdateState().releases!.releases.map((r) => r.id)).toEqual(['org-two']);
    stop2();
  });
});

describe('a dismissal belongs to the build it was made FROM', () => {
  const none = { releases: [], unreadCount: 0, latestUnread: null, stateAvailable: true };

  it('does not swallow a later ROLLBACK to the build whose card was once closed', async () => {
    // On A: B is deployed, and the person closes its card.
    server.list = none;
    server.version = { build: 'bbbbbbbbbbbb', builtAt: '2026-09-18T12:00:00.000Z' };
    const stop = startUpdateCenter('user-1');
    await flush();
    dismissNotice(selectNotice(getUpdateState()));
    stop();

    // Later, a session running C. Production is rolled back to B.
    resetUpdateStoreForTests();
    build.id = 'cccccccccccc';
    build.builtAt = '2026-09-18T14:00:00.000Z';
    const stop2 = startUpdateCenter('user-1');
    await flush();
    expect(getUpdateState().dismissedBuild).toBeNull();
    expect(selectNotice(getUpdateState())).toEqual({ kind: 'rollback', build: 'bbbbbbbbbbbb' });
    stop2();
  });

  it('keeps an in-memory dismissal when storage cannot hold one, across a tab switch', async () => {
    server.list = none;
    server.version = { build: 'bbbbbbbbbbbb', builtAt: '2026-09-18T12:00:00.000Z' };
    const stop = startUpdateCenter('user-1');
    await flush();
    // Storage that can hold nothing: every write throws, every read is empty.
    // (Stubbed whole: happy-dom's localStorage does not go through
    // Storage.prototype, so a prototype spy never fires and the test would pass
    // for the wrong reason.)
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
    });
    dismissNotice(selectNotice(getUpdateState()));
    expect(selectNotice(getUpdateState())).toEqual({ kind: 'none' });

    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(getUpdateState().dismissedBuild).toBe('bbbbbbbbbbbb');
    expect(selectNotice(getUpdateState())).toEqual({ kind: 'none' });
    stop();
  });
});

describe('a past reload', () => {
  it('has nothing left to report once the tab is current, so it cannot mislabel the NEXT deploy', async () => {
    reconcileReload.mockReturnValue('not_reached' as never);
    const stop = startUpdateCenter('user-1');
    expect(getUpdateState().reloadOutcome).toBe('not_reached');
    await flush();
    expect(getUpdateState().status).toBe('current');
    expect(getUpdateState().reloadOutcome).toBe('none');
    stop();
  });

  it('is still reported while the tab really is behind', async () => {
    reconcileReload.mockReturnValue('not_reached' as never);
    server.version = { build: 'bbbbbbbbbbbb', builtAt: '2026-09-18T12:00:00.000Z' };
    const stop = startUpdateCenter('user-1');
    await flush();
    expect(getUpdateState().status).toBe('update_available');
    expect(getUpdateState().reloadOutcome).toBe('not_reached');
    stop();
  });
});

describe('development', () => {
  it('has no build to compare, and still loads What’s New', async () => {
    build.id = '';
    const stop = startUpdateCenter('user-1');
    await flush();
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/version')).toBe(false);
    expect(getUpdateState().releases).not.toBeNull();
    stop();
  });
});

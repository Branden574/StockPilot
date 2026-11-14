import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  effectCallback,
  screenCallback,
  screenFunction,
  stateInitializer,
} from './__fixtures__/screen-functions';
import {
  countLoadClearsScreen,
  countLoadDraftAction,
  countReloadIsQuiet,
} from './count-access-refresh';
import { createDraftDebouncer } from './draft-debouncer';

import type { ScreenAccess } from './screen-access';

// screen-access.ts reaches drawer-nav, which maps icon names to lucide
// components; the native package does not load under node.
vi.mock('./nav-icons', () => ({ NAV_ICONS: new Proxy({}, { get: () => () => null }) }));

/**
 * AN ANSWER THAT LANDS AFTER THE ACCOUNT, WORKSPACE OR COUNT CHANGED IS NEVER
 * DRAWN, AND A REVIEW BUILT FOR ONE IS NEVER SENT FOR ANOTHER.
 *
 * The count screen, the barcode scanner and the AI shelf scan clear what they
 * drew when the account, the workspace or the count changes (round 3). Work
 * already in flight then still wrote its answer when it landed: a fetch
 * started under account A drew A's count after the clear, a store read drew
 * A's lines, and an AI scan upload built a review from A's lines that Confirm
 * then sent under whoever was signed in. Now every continuation on these
 * screens notes the key it started under (count-access-refresh.ts
 * CountLoadKey: the count, the workspace, the account and the access) and
 * drops its answer when the screen's key has changed since
 * (countAnswerStillShown); Confirm closes a review built under another key,
 * or for another account than the session's, and sends nothing.
 *
 * And the count screen's clear resets every per-count state with the header
 * and the lines: the linked exceptions (their chips match lines by item, so
 * count 1's would show on count 2's lines that share an item), the server's
 * line locations, the scope, the conflict banner and the Post gate.
 *
 * The screens' own functions and effects are RUN here (screen-functions.ts).
 */

const COUNT = 'app/cycle-count/[id].tsx';
const SCAN = 'app/cycle-count/scan/[id].tsx';
const AI_SCAN = 'app/cycle-count/ai-scan/[id].tsx';
// Made-up session values: the screens only pass them on.
const MADE_UP_SESSION_A = 'made-up-session-a';
const MADE_UP_SESSION = 'made-up-session';
const COUNT_ID = '0a000000-0000-0000-0000-0000000000c7';

type Key = { id: string; orgId: string | null; userId: string | null; access: ScreenAccess };
const A: Key = { id: COUNT_ID, orgId: 'org-a', userId: 'user-a', access: 'allowed' };
const B: Key = { ...A, userId: 'user-b' };
const SIGNED_OUT: Key = { ...A, userId: null };

async function stillShown() {
  const mod = (await import('./count-access-refresh')) as Record<string, unknown>;
  return mod.countAnswerStillShown as ((s: Key | null, n: Key | null) => boolean) | undefined;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('countAnswerStillShown', () => {
  it('the same count, workspace and account, with the access the same or widened to allowed', async () => {
    const still = (await stillShown())!;
    expect(still(A, A)).toBe(true);
    expect(still({ ...A, access: 'not-synced' }, A)).toBe(true);
    expect(still(A, B)).toBe(false);
    expect(still(A, SIGNED_OUT)).toBe(false);
    expect(still(A, { ...A, orgId: 'org-b' })).toBe(false);
    expect(still(A, { ...A, id: 'another-count' })).toBe(false);
    expect(still(A, { ...A, access: 'denied' })).toBe(false);
    expect(still(A, { ...A, access: 'not-synced' })).toBe(false);
    expect(still(null, null)).toBe(true);
    expect(still(null, A)).toBe(false);
  });
});

describe('the count screen', () => {
  for (const [label, next] of [
    ['another account', B],
    ['a sign-out', SIGNED_OUT],
  ] as const) {
    it(`a fetch started under account A that lands after ${label} draws nothing and stores nothing`, async () => {
      const lastLoadKey = { current: A as Key };
      const answer = deferred<unknown>();
      const drawn: string[] = [];
      const draw = (name: string) => () => drawn.push(name);
      const cacheCycleCount = vi.fn(async () => true);
      const fetchLines = vi.fn(async () => {
        await answer.promise;
        return { data: [], error: null };
      });
      const loadOnce = screenCallback<() => Promise<unknown>>(COUNT, 'loadOnce', {
        id: COUNT_ID,
        orgId: 'org-a',
        access: 'allowed',
        workspaceLoading: false,
        lastLoadKey,
        countAnswerStillShown: await stillShown(),
        CYCLE_COUNTS_NOT_AVAILABLE: 'x',
        NOT_SYNCED_YET: 'y',
        SAVED_ACCESS_UNREADABLE: 'z',
        countStoredForLiveAccount: async () => true,
        getCycleCount: async () => null,
        hydrateFromSnapshot: draw('hydrate'),
        setLoading: () => undefined,
        setReadError: () => undefined,
        setEmptyState: () => undefined,
        setScope: draw('scope'),
        setServerLocations: draw('locations'),
        setConflictBanner: draw('banner'),
        setLinked: draw('linked'),
        Network: {
          getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true }),
        },
        COUNT_UNREADABLE_ON_PHONE: 'u',
        cacheWriteScope: async () => ({}),
        retryWorkspace: async () => undefined,
        supabase: {
          from: () => {
            const q = { select: () => q, eq: () => q, maybeSingle: () => answer.promise };
            return q;
          },
        },
        fetchAllCycleCountLines: fetchLines,
        cacheCycleCount,
        getCountLinkedExceptions: async () => ({ organizationId: 'org-a', exceptions: [] }),
        variantLabel: () => null,
        offlineCaptureAt: () => null,
      });
      const pass = loadOnce();
      await flush();
      lastLoadKey.current = next;
      answer.resolve({
        data: { id: COUNT_ID, organization_id: 'org-a', status: 'in_progress', scope: 'warehouse' },
        error: null,
      });
      await pass;
      expect(drawn).toEqual([]);
      expect(cacheCycleCount).not.toHaveBeenCalled();
    });
  }

  it("a pass whose answer the cache discarded does not run a second pass under the old load's access", async () => {
    const lastLoadKey = { current: A as Key };
    const loadOnce = vi.fn(async () => {
      lastLoadKey.current = SIGNED_OUT; // the session ended while the first pass was out
      return 'discarded';
    });
    const said: unknown[] = [];
    const load = screenCallback<() => Promise<void>>(COUNT, 'load', {
      loadOnce,
      lastLoadKey,
      countAnswerStillShown: await stillShown(),
      COUNT_NOT_SAVED_AFTER_A_CHANGE: 'changed',
      setReadError: (v: unknown) => said.push(v),
      setEmptyState: () => undefined,
      setLoading: () => undefined,
    });
    await load();
    expect(loadOnce).toHaveBeenCalledTimes(1);
    expect(said).toEqual([]);
  });

  it('a count typed under account A whose save lands after the change to B draws nothing and says nothing', async () => {
    const lastLoadKey = { current: A as Key };
    const saved = deferred<{ id: string }>();
    const drawn: string[] = [];
    const alert = vi.fn();
    const init = stateInitializer<() => ReturnType<typeof createDraftDebouncer>>(
      COUNT,
      'lineSaver',
      {
        createDraftDebouncer,
        SAVE_DEBOUNCE_MS: 300,
        countFromBox: (raw: string) => Number(raw),
        isEmptyBox: (raw: string) => raw.trim() === '',
        clearLocalLine: async () => true,
        updateLocalLine: () => saved.promise,
        reportPhoneSaveFailure: () => undefined,
        countNotSavedAlert: () => ({ title: 't', message: 'm' }),
        countNotClearedAlert: () => ({ title: 't', message: 'm' }),
        Alert: { alert },
        setLines: () => drawn.push('lines'),
        setDraft: () => drawn.push('draft'),
        withoutSavedDraft: (d: unknown) => d,
        lineGoneNotice: { say: () => drawn.push('notice') },
        setLineGoneAnswered: () => drawn.push('answered'),
        cycleCountSync: {
          refreshPendingCount: async () => undefined,
          forceSync: async () => undefined,
        },
        lastLoadKey,
        countAnswerStillShown: await stillShown(),
      },
    );
    const saver = init();
    saver.schedule('l1', '5');
    saver.flushAll();
    await flush();
    lastLoadKey.current = B;
    saved.resolve({ id: 'q1' });
    await flush();
    await flush();
    expect(drawn).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
  });

  it("a clear for another count resets every per-count state, so count 1's exception chips are not on count 2's lines", () => {
    const state: Record<string, unknown> = {
      linked: {
        kind: 'ready',
        data: { exceptions: [{ occurrence: { itemId: 'item-1' } }] },
      },
      locations: new Map([['l1', 'loc-1']]),
      scope: 'selection',
      banner: '1 line updated on the server while you were offline',
      gate: { kind: 'known', gate: { canPost: true } },
    };
    const set = (name: string) => (v: unknown) => {
      state[name] = v;
    };
    const lastLoadKey = { current: A as Key };
    const run = (key: Key) =>
      effectCallback<() => void>(COUNT, 'countLoadClearsScreen(lastLoadKey.current', {
        lastLoadKey,
        loadKeyNow: () => ({ key, linesShown: true }),
        countReloadIsQuiet,
        countLoadClearsScreen,
        countLoadDraftAction,
        lineSaver: { dropAll: () => undefined, flushAll: () => undefined },
        setDraft: () => undefined,
        setHeader: () => undefined,
        setLines: () => undefined,
        setLinked: set('linked'),
        setServerLocations: set('locations'),
        setScope: set('scope'),
        setConflictBanner: set('banner'),
        setCloseGate: set('gate'),
        rememberedCloseGate: () => null,
        setLoading: () => undefined,
        setReadError: () => undefined,
        setEmptyState: () => undefined,
        load: async () => undefined,
      })();
    run({ ...A, id: 'count-2' });
    expect(state.linked).toEqual({ kind: 'none' });
    expect((state.locations as Map<string, unknown>).size).toBe(0);
    expect(state.scope).toBeNull();
    expect(state.banner).toBeNull();
    expect(state.gate).toEqual({ kind: 'loading' });
    // The chip rule the line rows draw by (pinned below): none for count 2.
    const linked = state.linked as {
      kind: string;
      data?: { exceptions: { occurrence: { itemId: string } }[] };
    };
    const chips =
      linked.kind === 'ready'
        ? linked.data!.exceptions.filter((x) => x.occurrence.itemId === 'item-1')
        : [];
    expect(chips).toEqual([]);
    const src = readFileSync(path.resolve(__dirname, '../..', COUNT), 'utf8').replace(/\s+/g, ' ');
    expect(src).toContain(
      "linked.kind === 'ready' ? linked.data.exceptions.filter((x) => x.occurrence.itemId === l.itemId)",
    );
  });

  it('an offline load resets the linked exceptions too', async () => {
    const linked: unknown[] = [];
    const loadOnce = screenCallback<() => Promise<unknown>>(COUNT, 'loadOnce', {
      id: COUNT_ID,
      orgId: 'org-a',
      access: 'allowed',
      workspaceLoading: false,
      lastLoadKey: { current: A },
      countAnswerStillShown: await stillShown(),
      CYCLE_COUNTS_NOT_AVAILABLE: 'x',
      NOT_SYNCED_YET: 'y',
      SAVED_ACCESS_UNREADABLE: 'z',
      countStoredForLiveAccount: async () => true,
      getCycleCount: async () => ({ header: { id: COUNT_ID }, lines: [] }),
      hydrateFromSnapshot: () => undefined,
      setLoading: () => undefined,
      setReadError: () => undefined,
      setEmptyState: () => undefined,
      setLinked: (v: unknown) => linked.push(v),
      Network: {
        getNetworkStateAsync: async () => ({ isConnected: false, isInternetReachable: false }),
      },
      COUNT_UNREADABLE_ON_PHONE: 'u',
    });
    await loadOnce();
    expect(linked).toEqual([{ kind: 'none' }]);
  });
});

describe('the barcode scanner', () => {
  it('lines read under account A that land after the change to B, or a sign-out, are not drawn', async () => {
    for (const next of [B, SIGNED_OUT]) {
      const lastLinesKey = { current: A as Key };
      const read = deferred<unknown>();
      const drawn: string[] = [];
      const alert = vi.fn();
      const loadLines = screenFunction<() => Promise<void>>(SCAN, 'loadLines', {
        id: COUNT_ID,
        access: 'allowed',
        lastLinesKey,
        countAnswerStillShown: await stillShown(),
        CYCLE_COUNTS_NOT_AVAILABLE: 'x',
        NOT_SYNCED_YET: 'y',
        SAVED_ACCESS_UNREADABLE: 'z',
        countStoredForLiveAccount: async () => true,
        getCycleCount: () => read.promise,
        openNotice: { say: alert },
        leave: () => undefined,
        setLines: () => drawn.push('lines'),
        setScannedMap: () => drawn.push('tally'),
        mergeScannedCounts: () => new Map(),
      });
      const run = loadLines();
      await flush();
      lastLinesKey.current = next;
      read.resolve({ lines: [{ id: 'l1', counted: 2 }] });
      await run;
      expect(drawn).toEqual([]);
      expect(alert).not.toHaveBeenCalled();
    }
  });

  it('a scan saved under account A that lands after the change to B is not tallied, and the scanner takes the next scan', async () => {
    const lastLinesKey = { current: A as Key };
    const saved = deferred<{ id: string }>();
    const drawn: string[] = [];
    const busy: boolean[] = [];
    const recordCount = screenFunction<(line: { id: string }, qty: number) => Promise<boolean>>(
      SCAN,
      'recordCount',
      {
        lastLinesKey,
        countAnswerStillShown: await stillShown(),
        setBusy: (v: boolean) => busy.push(v),
        updateLocalLine: () => saved.promise,
        reportPhoneSaveFailure: () => undefined,
        countNotSavedAlert: () => ({ title: 't', message: 'm' }),
        Alert: { alert: () => drawn.push('alert') },
        lineGoneNotice: { say: () => drawn.push('notice') },
        setScannedMap: () => drawn.push('tally'),
        setLines: () => drawn.push('lines'),
        cycleCountSync: {
          refreshPendingCount: async () => undefined,
          forceSync: async () => undefined,
        },
      },
    );
    const run = recordCount({ id: 'l1' }, 3);
    await flush();
    lastLinesKey.current = B;
    saved.resolve({ id: 'q1' });
    expect(await run).toBe(false);
    expect(drawn).toEqual([]);
    expect(busy.at(-1)).toBe(false);
  });
});

describe('the AI shelf scan', () => {
  function uploader(opts: { sessionUser: string; post: () => Promise<unknown> }) {
    const lastLinesKey = { current: A as Key };
    const phases: { kind: string }[] = [];
    const postMultipart = vi.fn(opts.post);
    return {
      lastLinesKey,
      phases,
      postMultipart,
      build: async () =>
        screenFunction<(uri: string) => Promise<void>>(AI_SCAN, 'uploadCapturedPhoto', {
          lastLinesKey,
          countAnswerStillShown: await stillShown(),
          uploadSeq: { current: 0 },
          setPhase: (v: unknown) =>
            phases.push(
              typeof v === 'function'
                ? (v as (p: unknown) => { kind: string })({ kind: 'uploading' })
                : (v as { kind: string }),
            ),
          ImageManipulator: {
            manipulateAsync: async () => ({ uri: 'file:///scan.jpg' }),
            SaveFormat: { JPEG: 'jpeg' },
          },
          COMPRESS_MAX_DIMENSION: 1600,
          COMPRESS_QUALITY: 0.8,
          FileSystem: { getInfoAsync: async () => ({ exists: true, size: 1000 }) },
          MAX_PHOTO_BYTES: 10_000_000,
          supabase: {
            auth: {
              getSession: async () => ({
                data: {
                  session: { access_token: MADE_UP_SESSION_A, user: { id: opts.sessionUser } },
                },
              }),
            },
          },
          postMultipart,
          API_BASE: 'https://api.example.test',
          cycleCountId: COUNT_ID,
          orgHeader: async () => ({}),
          cachedLines: [{ id: 'l1', itemName: 'A book' }],
          Alert: { alert: () => phases.push({ kind: 'alert' }) },
        }),
    };
  }

  it('an upload started under account A that lands after the change to B, or a sign-out, builds no review', async () => {
    for (const next of [B, SIGNED_OUT]) {
      const answer = deferred<unknown>();
      const u = uploader({ sessionUser: 'user-a', post: () => answer.promise });
      const run = (await u.build())('file:///photo.jpg');
      await flush();
      await flush();
      u.lastLinesKey.current = next;
      answer.resolve({
        ok: true,
        json: async () => ({ scanId: 'scan-1', photoSignedUrl: 'https://x.test/p', results: [] }),
      });
      await run;
      expect(u.phases.some((p) => p.kind === 'review')).toBe(false);
      expect(u.phases.some((p) => p.kind === 'alert')).toBe(false);
    }
  });

  it('nothing is uploaded when the session is already another account than the one the scan started for', async () => {
    const u = uploader({
      sessionUser: 'user-b',
      post: async () => ({ ok: true, json: async () => ({ results: [] }) }),
    });
    await (
      await u.build()
    )('file:///photo.jpg');
    expect(u.postMultipart).not.toHaveBeenCalled();
    expect(u.phases.some((p) => p.kind === 'review')).toBe(false);
  });

  it('a photo taken under account A that lands after the change to B, or a sign-out, is not uploaded and nothing is said', async () => {
    for (const [next, how] of [
      [B, 'taken'],
      [SIGNED_OUT, 'taken'],
      [B, 'failed'],
    ] as const) {
      const picture = deferred<{ uri: string } | null>();
      const lastLinesKey = { current: A as Key };
      const said: unknown[] = [];
      const phases: unknown[] = [];
      const uploadCapturedPhoto = vi.fn(async () => undefined);
      const capture = screenFunction<() => Promise<void>>(AI_SCAN, 'onCapture', {
        cameraRef: {
          current: {
            takePictureAsync: () =>
              how === 'taken'
                ? picture.promise
                : picture.promise.then(() => Promise.reject(new Error('camera'))),
          },
        },
        phase: { kind: 'idle' },
        lastLinesKey,
        countAnswerStillShown: await stillShown(),
        setPhase: (v: unknown) => phases.push(v),
        Alert: { alert: (...a: unknown[]) => said.push(a) },
        uploadCapturedPhoto,
      });
      const run = capture();
      // The screen clears for the new key while the camera is still out.
      lastLinesKey.current = next;
      picture.resolve({ uri: 'file:///photo.jpg' });
      await run;
      expect(uploadCapturedPhoto).not.toHaveBeenCalled();
      expect(said).toEqual([]);
      expect(phases).toEqual([{ kind: 'capturing' }]);
    }
  });

  function confirmer(opts: { builtUnder: Key; now: Key; sessionUser: string }) {
    const phases: unknown[] = [];
    const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    const mirror = vi.fn(async () => undefined);
    const build = async () =>
      screenFunction<() => Promise<void>>(AI_SCAN, 'onConfirm', {
        phase: {
          kind: 'review',
          scanId: 'scan-1',
          builtUnder: opts.builtUnder,
          reviewLines: [{ line: { id: 'l1', itemName: 'A book' }, override: '3' }],
        },
        lastLinesKey: { current: opts.now },
        countAnswerStillShown: await stillShown(),
        overrideNotACount: () => false,
        reviewNotACountMessage: () => '',
        lineCountToWrite: () => 3,
        Alert: { alert: vi.fn() },
        setPhase: (v: unknown) => phases.push(v),
        supabase: {
          auth: {
            getSession: async () => ({
              data: { session: { access_token: MADE_UP_SESSION, user: { id: opts.sessionUser } } },
            }),
          },
        },
        fetch,
        API_BASE: 'https://api.example.test',
        cycleCountId: COUNT_ID,
        orgHeader: async () => ({}),
        mirrorRecordedCount: mirror,
        cycleCountSync: {
          refreshPendingCount: async () => undefined,
          forceSync: async () => undefined,
        },
        leave: () => undefined,
        console: { warn: vi.fn() },
      });
    return { build, phases, fetch, mirror };
  }

  it('Confirm closes a review built under another account, workspace or count, and sends nothing', async () => {
    for (const now of [B, SIGNED_OUT, { ...A, orgId: 'org-b' }, { ...A, id: 'count-2' }]) {
      const c = confirmer({ builtUnder: A, now, sessionUser: 'user-a' });
      await (
        await c.build()
      )();
      expect(c.fetch).not.toHaveBeenCalled();
      expect(c.mirror).not.toHaveBeenCalled();
      expect(c.phases).toEqual([{ kind: 'idle' }]);
    }
  });

  it('Confirm sends nothing when the session is another account than the review was built for', async () => {
    const c = confirmer({ builtUnder: A, now: A, sessionUser: 'user-b' });
    await (
      await c.build()
    )();
    expect(c.fetch).not.toHaveBeenCalled();
    expect(c.phases.at(-1)).toEqual({ kind: 'idle' });
  });
});

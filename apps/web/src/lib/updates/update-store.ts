import * as React from 'react';

import {
  clientReleaseListSchema,
  clientReleaseSchema,
  type ClientRelease,
  type ClientReleaseList,
  type ReleaseStateAction,
} from '@stockpilot/core';

import { capture } from '@/lib/analytics';
import { LOADED_BUILD, LOADED_BUILT_AT } from '@/lib/build-info';
import { offeredRelease } from '@/lib/releases/logic';
import { getUnsavedSources } from '@/lib/unsaved-work';

import {
  compareBuilds,
  parseServedVersion,
  refreshRequired,
  type ServedVersion,
  type UpdateStatus,
} from './detector';
import { reconcileReload, reloadToBuild, type ReloadOutcome } from './safe-reload';

/**
 * The update center's state, at MODULE scope.
 *
 * Module scope, not component refs, because the previous notifier kept its
 * baseline in refs of a component that lives in the (dashboard) layout: any
 * remount of that layout inside one long JS session (finishing sign-in, coming
 * back from /platform) reset the baseline to whatever was live at that moment
 * and silently swallowed the pending update. The identity of the loaded bundle
 * is a fact about the JS session, so it lives with the JS session.
 *
 * Two independent questions are answered here and never merged:
 *   DEPLOYMENT  does this tab need a refresh?          detector.ts, /api/version
 *   RELEASE     is there something unread for ME?      /api/v1/me/releases
 * StockPilot deploys about ten times per release, so tying "What's New" to
 * "the build changed" would nag ten times too often, and tying "refresh" to
 * "there is a release" would leave tabs stale.
 *
 * Per TAB (memory only): status, served build, whether the drawer is open.
 * Per PERSON (server): dismissed / opened / read for each release.
 * Shared across tabs: a dismissed refresh notice (localStorage, per user) and a
 * nudge to re-read release state (BroadcastChannel).
 */

export const POLL_MS = 30_000;
const DEDUPE_MS = 1_500;
/** Let the page paint before saying anything that is not urgent. */
export const UNREAD_NOTICE_DELAY_MS = 1_200;
/**
 * How long a newly detected build waits for ITS release list before the notice
 * goes up without one. The list decides what the card says and offers, so the
 * card is composed once, from both answers, instead of appearing as "refresh
 * only" and changing under the reader's eyes a moment later.
 */
export const RELEASES_WAIT_MS = 4_000;
/** `detail.releaseId` while the drawer is waiting for the LIST, not a release. */
export const LIST_PENDING = '';

export type ReleaseLoad =
  | { phase: 'idle' }
  | { phase: 'loading'; releaseId: string }
  | { phase: 'ready'; release: ClientRelease }
  | { phase: 'error'; releaseId: string; offline: boolean };

export interface UpdateState {
  status: UpdateStatus;
  served: ServedVersion | null;
  /** The served build whose refresh notice this person closed. */
  dismissedBuild: string | null;
  /** Result of a refresh this tab asked for, reported once. */
  reloadOutcome: ReloadOutcome;
  releases: ClientReleaseList | null;
  drawerOpen: boolean;
  /** What the drawer is showing, or null for "the newest". */
  drawerReleaseId: string | null;
  detail: ReleaseLoad;
  /** Sources that blocked the last refresh request; empty when none did. */
  blockedBy: Array<{ id: string; label: string }>;
  /** A state write failed. The UI says so instead of pretending it saved. */
  saveFailed: boolean;
}

const initialState = (): UpdateState => ({
  status: 'unknown',
  served: null,
  dismissedBuild: null,
  reloadOutcome: 'none',
  releases: null,
  drawerOpen: false,
  drawerReleaseId: null,
  detail: { phase: 'idle' },
  blockedBy: [],
  saveFailed: false,
});

let state: UpdateState = initialState();
const listeners = new Set<() => void>();

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

export function getUpdateState(): UpdateState {
  return state;
}

export function useUpdateState(): UpdateState {
  return React.useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getUpdateState,
    getUpdateState,
  );
}

// ── session ────────────────────────────────────────────────────────────────

let userId: string | null = null;
/** Person AND organization: the release list depends on both. */
let scope: string | null = null;
let channel: BroadcastChannel | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let lastCheckedAt = 0;
let versionSeq = 0;
let releasesSeq = 0;
let releasesFetchedFor = '';
let starts = 0;
const shownOnce = new Set<string>();

const dismissKey = () => `sp:update-dismissed:${userId ?? 'anon'}`;

/**
 * A dismissal means "not now" for one served build, SEEN FROM one loaded build.
 * Stored bare, "I closed the card for B" outlived the tab that said it: after
 * moving on to C, a rollback to B (the usual rollback target) matched the old
 * record and was never announced. Scoped to the loaded build, a record from an
 * earlier bundle simply does not apply.
 */
function readDismissedBuild(): string | null {
  try {
    const raw = localStorage.getItem(dismissKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { loaded?: unknown; served?: unknown };
    if (parsed.loaded !== LOADED_BUILD || typeof parsed.served !== 'string') return null;
    return parsed.served;
  } catch {
    return null;
  }
}

function broadcast(
  message:
    { type: 'releases-changed' } | { type: 'notice-dismissed'; build: string; loaded: string },
): void {
  try {
    channel?.postMessage(message);
  } catch {
    /* another tab missing a nudge is not an error */
  }
}

// ── deployment ─────────────────────────────────────────────────────────────

/**
 * Ask production which build it serves. A plain same-origin GET on purpose: it
 * carries no deployment header, so under Skew Protection it is NOT pinned to
 * this tab's old deployment. Failures change nothing and say nothing.
 */
export async function checkForUpdate(): Promise<void> {
  if (typeof window === 'undefined' || !LOADED_BUILD) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const now = Date.now();
  if (now - lastCheckedAt < DEDUPE_MS) return;
  lastCheckedAt = now;

  const seq = ++versionSeq;
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return;
    const served = parseServedVersion(await res.json());
    // A slow response must not overwrite the answer to a later request.
    if (!served || seq !== versionSeq) return;

    const status = compareBuilds({ build: LOADED_BUILD, builtAt: LOADED_BUILT_AT || null }, served);

    // The list for the served registry comes FIRST (see RELEASES_WAIT_MS). It
    // is also retried here for as long as this tab has no list at all, so one
    // failed request at boot does not leave What's New empty for the session.
    const releaseKey = served.releasesKey ?? '';
    if (releaseKey !== releasesFetchedFor || state.releases === null) {
      await Promise.race([
        refreshReleases(releaseKey),
        new Promise<void>((resolve) => setTimeout(resolve, RELEASES_WAIT_MS)),
      ]);
      if (seq !== versionSeq) return;
    }

    set({
      served,
      status,
      // A tab that is current has nothing left to report about a past reload.
      // Left in place, a stale "did not load" attached itself to the NEXT deploy.
      ...(status === 'current' && state.reloadOutcome !== 'none'
        ? { reloadOutcome: 'none' as const }
        : {}),
    });
  } catch {
    /* offline or transient: try again at the next trigger */
  }
}

// ── releases ───────────────────────────────────────────────────────────────

export async function refreshReleases(fetchedFor?: string): Promise<void> {
  if (typeof window === 'undefined') return;
  const seq = ++releasesSeq;
  try {
    const res = await fetch('/api/v1/me/releases', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!res.ok) return;
    const parsed = clientReleaseListSchema.safeParse(await res.json());
    if (!parsed.success || seq !== releasesSeq) return;
    if (fetchedFor !== undefined) releasesFetchedFor = fetchedFor;
    set({ releases: parsed.data });
  } catch {
    /* a release-notes outage must never affect the product */
  }
}

async function postState(action: ReleaseStateAction): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/me/release-state', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });
    if (!res.ok) return false;
    // `recorded: 0` for ONE named release means the server did not recognise it
    // for this reader, so nothing was written. Treating that as saved let the
    // dot clear here and come back on the next load.
    if ('releaseId' in action) {
      const body = (await res.json().catch(() => null)) as { recorded?: unknown } | null;
      if (body && typeof body.recorded === 'number' && body.recorded < 1) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function patchRelease(id: string, patch: Partial<{ read: boolean; dismissed: boolean }>): void {
  const list = state.releases;
  if (!list) return;
  const releases = list.releases.map((r) =>
    r.id === id ? { ...r, state: { ...r.state, ...patch } } : r,
  );
  const unread = releases.filter((r) => !r.state.read);
  set({
    releases: {
      ...list,
      releases,
      unreadCount: unread.length,
      latestUnread: offeredRelease(unread),
    },
  });
}

// ── the notice ─────────────────────────────────────────────────────────────

export type Notice =
  | { kind: 'none' }
  /** A newer build is live. `release` is the unread release to offer, if any. */
  | { kind: 'update'; build: string; release: ClientReleaseList['latestUnread'] }
  /** Production went BACK to an older build. Nothing new to read. */
  | { kind: 'rollback'; build: string }
  /** This tab is current, and there is something unread. */
  | { kind: 'unread'; release: NonNullable<ClientReleaseList['latestUnread']> };

/** PURE: exactly one notice, or none. */
export function selectNotice(s: UpdateState): Notice {
  if (refreshRequired(s.status) && s.served && s.dismissedBuild !== s.served.build) {
    if (s.status === 'rolled_back') return { kind: 'rollback', build: s.served.build };
    return { kind: 'update', build: s.served.build, release: s.releases?.latestUnread ?? null };
  }
  const unread = s.releases?.latestUnread;
  if (unread) return { kind: 'unread', release: unread };
  return { kind: 'none' };
}

/** An impression is one notice becoming visible, not one render of it. */
export function noteNoticeShown(notice: Notice): void {
  if (notice.kind === 'none') return;
  const key =
    notice.kind === 'unread'
      ? `unread:${notice.release.id}@${notice.release.revision}`
      : `${notice.kind}:${notice.build}`;
  if (shownOnce.has(key)) return;
  shownOnce.add(key);
  capture('update_notification_shown', {
    kind: notice.kind,
    releaseId: notice.kind === 'rollback' ? null : (notice.release?.id ?? null),
    loadedBuild: LOADED_BUILD,
  });
}

/**
 * Close the notice. It records a DISMISSAL and nothing else: the release stays
 * unread, and the tab still needs its refresh.
 */
export function dismissNotice(notice: Notice): void {
  if (notice.kind === 'none') return;
  capture('update_notification_dismissed', {
    kind: notice.kind,
    releaseId: notice.kind === 'rollback' ? null : (notice.release?.id ?? null),
  });
  if (notice.kind === 'update' || notice.kind === 'rollback') {
    try {
      localStorage.setItem(
        dismissKey(),
        JSON.stringify({ loaded: LOADED_BUILD, served: notice.build }),
      );
    } catch {
      /* this tab still remembers */
    }
    set({ dismissedBuild: notice.build });
    broadcast({ type: 'notice-dismissed', build: notice.build, loaded: LOADED_BUILD });
  }
  const release = notice.kind === 'rollback' ? null : notice.release;
  if (release) {
    patchRelease(release.id, { dismissed: true });
    void postState({ action: 'dismiss', releaseId: release.id }).then((ok) => {
      if (ok) broadcast({ type: 'releases-changed' });
    });
  }
}

// ── the drawer ─────────────────────────────────────────────────────────────

async function loadRelease(releaseId: string): Promise<void> {
  set({ detail: { phase: 'loading', releaseId } });
  try {
    const res = await fetch(`/api/v1/me/releases/${encodeURIComponent(releaseId)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { release?: unknown };
    const parsed = clientReleaseSchema.safeParse(body.release);
    if (!parsed.success) throw new Error('shape');
    // The person may have closed the drawer or picked another release meanwhile.
    if (
      !state.drawerOpen ||
      (state.detail.phase === 'loading' && state.detail.releaseId !== releaseId)
    )
      return;
    set({ detail: { phase: 'ready', release: parsed.data } });
    capture('release_details_viewed', { releaseId, entryPoint: 'drawer' });
    // READ = the details rendered after an intentional open. Not a popup
    // impression, not a dismissal, not a failed load.
    if (!parsed.data.state.read && parsed.data.status === 'published') {
      const ok = await postState({ action: 'read', releaseId });
      if (ok) {
        patchRelease(releaseId, { read: true });
        broadcast({ type: 'releases-changed' });
      } else {
        set({ saveFailed: true });
      }
    }
  } catch {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    set({ detail: { phase: 'error', releaseId, offline } });
    capture('release_details_load_failed', { releaseId, offline });
  }
}

/**
 * The release the permanent entry point opens: the newest UNREAD one, else the
 * newest. NOT `latestUnread`: that is the notice's offer, and it is null once the
 * newest unread release has been dismissed. Using it here made the entry point
 * say "1 unread" and open an already-read release, every time, with no way to
 * reach the unread one except the history page.
 */
function defaultTarget(): string | null {
  const list = state.releases?.releases ?? [];
  return (list.find((r) => !r.state.read) ?? list[0])?.id ?? null;
}

function openOn(target: string | null, entryPoint: string): void {
  set({ drawerReleaseId: target });
  capture('whats_new_opened', { releaseId: target, entryPoint });
  if (!target) {
    set({ detail: { phase: 'idle' } });
    return;
  }
  void postState({ action: 'open', releaseId: target });
  void loadRelease(target);
}

/** Open the drawer on a release (default: the newest unread, else the newest). */
export function openWhatsNew(releaseId?: string | null, entryPoint: string = 'notification'): void {
  set({ drawerOpen: true, saveFailed: false, blockedBy: [] });
  if (releaseId) return openOn(releaseId, entryPoint);
  if (state.releases !== null) return openOn(defaultTarget(), entryPoint);

  // The list has not arrived (or its one request failed). "Not loaded" is not
  // "empty": saying "there are no release notes" here was simply untrue. Load
  // it, then decide; if it cannot be loaded, say THAT, with a way to try again.
  set({ drawerReleaseId: null, detail: { phase: 'loading', releaseId: LIST_PENDING } });
  void refreshReleases().then(() => {
    if (!state.drawerOpen || state.detail.phase !== 'loading') return;
    if (state.detail.releaseId !== LIST_PENDING) return;
    if (state.releases === null) {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      set({ detail: { phase: 'error', releaseId: LIST_PENDING, offline } });
      return;
    }
    openOn(defaultTarget(), entryPoint);
  });
}

export function retryRelease(): void {
  if (state.detail.phase !== 'error') return;
  if (state.detail.releaseId === LIST_PENDING) openWhatsNew(null, 'retry');
  else void loadRelease(state.detail.releaseId);
}

/**
 * `detail` is deliberately KEPT. The sheet stays mounted for its 300ms slide-out,
 * and clearing the content here replaced the release with the empty-state
 * sentence for the whole animation. The next open sets it afresh.
 */
export function closeWhatsNew(): void {
  set({ drawerOpen: false, blockedBy: [] });
}

/**
 * READ for a release opened by its own URL (the history page). Same rule, same
 * route, same cross-tab nudge as the drawer, so the topbar dot and every other
 * tab agree. False means it was NOT saved; the caller says so.
 */
export async function markReleaseRead(releaseId: string): Promise<boolean> {
  const ok = await postState({ action: 'read', releaseId });
  if (!ok) return false;
  patchRelease(releaseId, { read: true });
  broadcast({ type: 'releases-changed' });
  return true;
}

export async function markAllRead(): Promise<boolean> {
  const ok = await postState({ action: 'read_all' });
  if (!ok) {
    set({ saveFailed: true });
    return false;
  }
  await refreshReleases();
  broadcast({ type: 'releases-changed' });
  return true;
}

// ── refreshing ─────────────────────────────────────────────────────────────

/**
 * "Refresh to update". Never reloads over unsaved work it knows about: it
 * returns the sources that blocked it and leaves the decision with the person.
 * `force` is that decision ("Refresh anyway").
 */
export function requestRefresh(options: { force?: boolean } = {}): { blocked: boolean } {
  const dirty = options.force ? [] : getUnsavedSources();
  if (dirty.length > 0) {
    set({ blockedBy: dirty });
    capture('update_refresh_blocked_unsaved_changes', { sources: dirty.map((d) => d.id) });
    return { blocked: true };
  }
  capture('update_refresh_requested', {
    loadedBuild: LOADED_BUILD,
    targetBuild: state.served?.build ?? null,
    forced: Boolean(options.force),
  });
  reloadToBuild(state.served?.build ?? null, LOADED_BUILD || null);
  return { blocked: false };
}

export function cancelRefresh(): void {
  set({ blockedBy: [] });
}

/**
 * `blockedBy` is a snapshot from the moment of the click. The person is told to
 * save their work, and when they do, the claim has to stop being made: otherwise
 * the card keeps saying "you have unsaved changes" about a form that is saved,
 * and the only way forward is the button labelled as the risky choice. Called on
 * a short timer while the confirmation is showing. It NEVER reloads: a clean
 * result only returns the card to its normal state.
 */
export function recheckUnsaved(): void {
  if (state.blockedBy.length === 0) return;
  const dirty = getUnsavedSources();
  const same =
    dirty.length === state.blockedBy.length &&
    dirty.every((d, i) => d.id === state.blockedBy[i]!.id && d.label === state.blockedBy[i]!.label);
  if (!same) set({ blockedBy: dirty });
}

// ── lifecycle ──────────────────────────────────────────────────────────────

function startInterval(): void {
  if (interval || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  interval = setInterval(() => void checkForUpdate(), POLL_MS);
}
function stopInterval(): void {
  if (interval) clearInterval(interval);
  interval = null;
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') {
    void checkForUpdate();
    // The cross-tab fallback where BroadcastChannel is unavailable.
    // Only ever ADOPTS a dismissal. Where storage cannot hold one (quota,
    // blocked by policy) this read is null, and overwriting with it brought the
    // card back on every tab switch.
    const next = readDismissedBuild();
    if (next && next !== state.dismissedBuild) set({ dismissedBuild: next });
    startInterval();
  } else {
    // No polling from a tab nobody is looking at.
    stopInterval();
  }
}
const onFocus = () => void checkForUpdate();
const onOnline = () => void checkForUpdate();
const onPageShow = (e: PageTransitionEvent) => {
  // A page restored from the back/forward cache resumes with stale memory.
  if (e.persisted) void checkForUpdate();
};

/**
 * Start (or join) the update center for this person. Safe to call from a
 * component that mounts more than once: listeners and the interval exist once,
 * and the state survives the remount.
 */
export function startUpdateCenter(forUserId: string, forOrganizationId: string = ''): () => void {
  starts += 1;
  const nextScope = `${forUserId}|${forOrganizationId}`;
  const switched = scope !== null && scope !== nextScope;
  if (starts === 1 || scope !== nextScope) {
    userId = forUserId;
    scope = nextScope;
    const outcome = reconcileReload(LOADED_BUILD);
    if (outcome === 'reached') capture('update_target_loaded', { build: LOADED_BUILD });
    set({ reloadOutcome: outcome, dismissedBuild: readDismissedBuild() });

    if (switched) {
      // Sign-out, sign-in and the organization switcher are all SOFT navigations:
      // this module outlives them. Everything below belongs to the previous
      // person (or their other organization) and must not be shown to this one:
      // their unread count, their audience-filtered titles, their open drawer.
      // The refreshReleases() below takes a new sequence number, which is what
      // discards a list request still in flight for the previous person.
      releasesFetchedFor = '';
      shownOnce.clear();
      set({
        releases: null,
        drawerOpen: false,
        drawerReleaseId: null,
        detail: { phase: 'idle' },
        blockedBy: [],
        saveFailed: false,
      });
      void refreshReleases();
    }

    try {
      channel?.close();
      channel =
        typeof BroadcastChannel === 'undefined'
          ? null
          : new BroadcastChannel(`sp:updates:${forUserId}`);
      if (channel) {
        channel.onmessage = (e: MessageEvent) => {
          const m = e.data as { type?: string; build?: string } | null;
          if (m?.type === 'releases-changed') void refreshReleases();
          const m2 = e.data as { loaded?: unknown } | null;
          // A dismissal only means something to tabs on the SAME loaded build.
          if (
            m?.type === 'notice-dismissed' &&
            typeof m.build === 'string' &&
            m2?.loaded === LOADED_BUILD
          )
            set({ dismissedBuild: m.build });
        };
      }
    } catch {
      channel = null;
    }
  }
  if (starts === 1) {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('pageshow', onPageShow);
    startInterval();
    // Boot path: unread releases must be discoverable with NO deploy in sight.
    // checkForUpdate() fetches the list itself (and keeps retrying while there
    // is none); in development there is no loaded build, it returns at once, and
    // the list is fetched directly.
    if (LOADED_BUILD) void checkForUpdate();
    else void refreshReleases();
  }
  return () => {
    starts = Math.max(0, starts - 1);
    if (starts > 0) return;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('pageshow', onPageShow);
    stopInterval();
    // State is deliberately KEPT: a remount must not re-baseline or re-nag.
    // Except the unsaved-work confirmation: it is a moment in a conversation,
    // and coming back to it on a later mount would move focus for no reason.
    if (state.blockedBy.length > 0) set({ blockedBy: [] });
  };
}

export function acknowledgeReloadOutcome(): void {
  set({ reloadOutcome: 'none' });
}

/** Test seam. */
export function resetUpdateStoreForTests(): void {
  stopInterval();
  try {
    channel?.close();
  } catch {
    /* ignore */
  }
  channel = null;
  userId = null;
  scope = null;
  lastCheckedAt = 0;
  versionSeq = 0;
  releasesSeq = 0;
  releasesFetchedFor = '';
  starts = 0;
  shownOnce.clear();
  state = initialState();
}

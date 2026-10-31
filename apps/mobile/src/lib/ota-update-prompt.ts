/**
 * THE PHONE UPDATE POP-UP (B44): when "Update ready" shows, and what each of
 * its buttons does.
 *
 * The owner's rule (2026-10-31): the app opens once, with one launch screen.
 * A new update downloads quietly. When it is ready, a pop-up says so, and the
 * app restarts only when the person taps Restart now: one restart, into the
 * new version, in the same visit. Later is there so nobody is restarted in the
 * middle of a scan, a count or an unsaved form; it never brings back two
 * quits, because the downloaded update opens by itself at the next open from
 * closed, with one launch screen.
 *
 * WHERE THE UPDATE COMES FROM. expo-updates checks at every open from closed
 * and downloads a new update in the background (app.config.ts sets only the
 * updates url: checkOnLaunch ALWAYS, launchWaitMs 0). It never relaunches the
 * app for it; it only tells JavaScript, through its native state
 * (isUpdatePending), which this module reads. The hook this replaced checked
 * again from JavaScript and called reloadAsync on every open, so a fresh
 * update showed the launch screen, the app, a white flash and the launch
 * screen again, with no reason given. On a return to the app after 30
 * minutes or more, this module checks once more itself, so an update
 * published while the app sat in the background is offered too.
 *
 * Pure: no React Native or expo import. Every call out goes through
 * UpdatePromptDeps; use-ota-updates.ts holds the real ones, and
 * ota-update-prompt.test.ts runs these rules with fakes and a fake clock.
 */

// ── The words (each pinned word for word by ota-update-prompt.test.ts) ──────

export const UPDATE_PROMPT_TITLE = 'Update ready';
/** The owner's sentence, exactly as he approved it (2026-10-31). */
export const UPDATE_PROMPT_MESSAGE =
  'An update for StockPilot is ready. The app will restart to finish installing it.';
export const UPDATE_PROMPT_LATER = 'Later';
export const UPDATE_PROMPT_RESTART = 'Restart now';
/** What VoiceOver says while the app restarts (the overlay shows no words). */
export const RESTARTING_LABEL = 'Restarting StockPilot to finish the update';
export const RESTART_FAILED_TITLE = 'Update not finished';
export const RESTART_FAILED_MESSAGE =
  'StockPilot could not restart. Close the app and open it again to finish the update.';
export const RESTART_FAILED_OK = 'OK';

/**
 * The pop-up's place in the app's one interruption slot (tour-targets.ts):
 * held while the pop-up is open or the app is restarting, so What's New, the
 * tours and a tapped notification's notice wait for it, as it waits for them.
 */
export const UPDATE_PROMPT_LOCK_ID = 'update-prompt';

// ── Timing ──────────────────────────────────────────────────────────────────

/** A return to the app checks for an update at most this often. */
export const RETURN_CHECK_MIN_GAP_MS = 30 * 60_000;
/** Nothing in the way for this long before the pop-up shows. */
export const SHOW_SETTLE_MS = 600;
/** A focused text field sends no event when it loses focus: look again this often. */
export const FOCUS_RECHECK_MS = 2_000;
/** Restart now waits at most this long for work in flight (api()'s 20 s timeout plus 5 s). */
export const RESTART_SETTLE_MAX_MS = 25_000;
/** A restart still pending this long is reported once (the overlay stays). */
export const RELOAD_SLOW_MS = 15_000;
/** Still running this long after reloadAsync said it would restart: the restart failed. */
export const RESTART_WATCHDOG_MS = 15_000;
/**
 * A restart takes seconds. A restart record older than this at the next start
 * is from a restart that never came (the app was closed while it hung), so
 * that start is an ordinary open from closed (restartRecordAtStart).
 */
export const RESTART_RECORD_MAX_AGE_MS = 60_000;

// ── Memory (AsyncStorage) ───────────────────────────────────────────────────

/**
 * Device-level, not under the account-scoped 'workspace.' prefix
 * (account-eviction.ts), so it survives a sign-out. It holds update ids and
 * times only.
 */
export const MEMORY_KEY = 'stockpilot.update-prompt.v1';
export const MEMORY_MAX_ENTRIES = 10;

/** The launch screen's colour (app.config.ts, expo-splash-screen backgroundColor). */
export const LAUNCH_SCREEN_GROUND = '#0a0f1f';

/**
 * Screens where the pop-up never shows: someone is scanning, counting,
 * creating a record, checking out an order, grouping, typing to support or the
 * assistant, connecting an account, or reviewing an imported purchase order.
 * Keys are useSegments().join('/'); expo-router drops a trailing 'index', so
 * app/scan-po/index.tsx is 'scan-po'. ota-update-prompt.test.ts checks that
 * every key is a real route file.
 */
export const WORK_ROUTES: readonly string[] = [
  // Scanning.
  '(drawer)/(tabs)/scan',
  'scan-po',
  'cycle-count/scan/[id]',
  'cycle-count/ai-scan/[id]',
  // Counting.
  'cycle-count/[id]',
  'cycle-count/new',
  // New records.
  'item/new',
  'maintenance/new',
  'rentals/new',
  'schedule/new',
  // Ordering.
  'order/new',
  'order/new/browse',
  'order/new/checkout',
  // Grouping.
  'group-selected',
  'ungroup-selected',
  // Typing and connected screens.
  '(drawer)/settings/change-email',
  '(drawer)/support',
  'ai/chat',
  'zendesk/web',
  '(drawer)/zendesk',
  '(drawer)/settings/integrations',
  // Review.
  'po-import/[id]',
];

const WORK_ROUTE_SET = new Set(WORK_ROUTES);

// ── The native state ────────────────────────────────────────────────────────

/** A downloaded update waiting for a restart. */
export type WaitingUpdate = { type: 'new'; id: string } | { type: 'rollback' };

export interface NativeUpdateState {
  /** A newer update, or a roll back to the built-in one, launches at the next restart. */
  pending: boolean;
  /** What is waiting, when anything is. */
  downloaded: WaitingUpdate | null;
  /** The launch check, a check or a download is running. */
  busy: boolean;
  /** When the last check finished (ms), in this JavaScript runtime. */
  lastCheckAt: number | null;
}

/** The parts of expo-updates' native state context this reads. */
export interface NativeContextLike {
  isStartupProcedureRunning?: boolean;
  isUpdatePending?: boolean;
  isChecking?: boolean;
  isDownloading?: boolean;
  downloadedManifest?: { id?: unknown } | null;
  rollback?: unknown;
  lastCheckForUpdateTime?: Date | string | number | null;
}

function timeOf(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The native context, reduced to what the pop-up needs.
 *
 * - An update's id is compared in lowercase: Updates.updateId is lowercased,
 *   the downloaded manifest's id is not.
 * - A downloaded manifest names the waiting update (expo-updates' own useUpdates
 *   reads it first too). With none, a pending update is a roll back to the
 *   built-in update: only a roll back makes an update pending without a
 *   manifest (downloadCompleteWithRollback).
 */
export function nativeStateFromContext(
  ctx: NativeContextLike | null | undefined,
): NativeUpdateState {
  const c = ctx ?? {};
  const pending = c.isUpdatePending === true;
  const manifestId = c.downloadedManifest?.id;
  let downloaded: WaitingUpdate | null = null;
  if (typeof manifestId === 'string' && manifestId !== '') {
    downloaded = { type: 'new', id: manifestId.toLowerCase() };
  } else if (c.rollback || pending) {
    downloaded = { type: 'rollback' };
  }
  return {
    pending,
    downloaded,
    busy: c.isStartupProcedureRunning === true || c.isChecking === true || c.isDownloading === true,
    lastCheckAt: timeOf(c.lastCheckForUpdateTime),
  };
}

// ── The memory ──────────────────────────────────────────────────────────────

export interface UpdateMemoryEntry {
  /** The waiting update's lowercase id, or 'rollback'. */
  id: string;
  /** The update that was running when this one was first seen waiting. */
  from: string | null;
  /** The JavaScript runtime that first saw it waiting (RUNTIME_TOKEN). */
  runtime: string;
  /** The passed-over warning was sent for it. */
  reported: boolean;
}

/** What Restart now saves right before it restarts. */
export interface RestartRecord {
  /** The update that was running (Updates.updateId as it was). */
  from: string | null;
  /** When it was saved (ms). */
  at: number;
}

export interface UpdateMemory {
  v: 1;
  waiting: UpdateMemoryEntry[];
  /** Saved right before Restart now restarts; read and cleared at the next start. */
  restart: RestartRecord | null;
}

export const EMPTY_MEMORY: UpdateMemory = { v: 1, waiting: [], restart: null };

/** The stored memory, or an empty one when it is missing or unreadable. */
export function parseMemory(text: string | null | undefined): UpdateMemory {
  if (!text) return EMPTY_MEMORY;
  try {
    const raw = JSON.parse(text) as Partial<UpdateMemory> | null;
    if (!raw || raw.v !== 1 || !Array.isArray(raw.waiting)) return EMPTY_MEMORY;
    const waiting = raw.waiting
      .filter(
        (e): e is UpdateMemoryEntry =>
          !!e &&
          typeof e.id === 'string' &&
          (typeof e.from === 'string' || e.from === null) &&
          typeof e.runtime === 'string' &&
          typeof e.reported === 'boolean',
      )
      .slice(-MEMORY_MAX_ENTRIES);
    const r = raw.restart;
    const restart =
      r && (typeof r.from === 'string' || r.from === null) && typeof r.at === 'number'
        ? { from: r.from, at: r.at }
        : null;
    return { v: 1, waiting, restart };
  } catch {
    return EMPTY_MEMORY;
  }
}

export function serializeMemory(memory: UpdateMemory): string {
  return JSON.stringify({
    v: 1,
    waiting: memory.waiting.slice(-MEMORY_MAX_ENTRIES),
    restart: memory.restart,
  });
}

function waitingKey(update: WaitingUpdate): string {
  return update.type === 'new' ? update.id : 'rollback';
}

export type Offerability = 'offerable' | 'same-as-running' | 'passed-over';

/**
 * Whether a waiting update may be offered.
 *
 * - Same as running: Restart now would restart into the code already running
 *   (the update now running, or a roll back while the built-in update runs).
 * - Passed over: it was seen waiting in an EARLIER JavaScript runtime and that
 *   runtime's update still runs, so the launcher skipped it at an open from
 *   closed or a restart since. The launcher skips only an update that cannot
 *   launch (it failed to launch before), and expo-updates' launch check still
 *   reports such an update as downloaded at every open. Offering it would
 *   restart into the same version every time.
 */
export function offerability(
  update: WaitingUpdate,
  running: { updateId: string | null; isEmbeddedLaunch: boolean },
  memory: UpdateMemory,
  runtimeToken: string,
): Offerability {
  const runningId = running.updateId?.toLowerCase() ?? null;
  if (update.type === 'new' && update.id === runningId) return 'same-as-running';
  if (update.type === 'rollback' && running.isEmbeddedLaunch) return 'same-as-running';
  const entry = memory.waiting.find((e) => e.id === waitingKey(update));
  if (entry && entry.runtime !== runtimeToken && entry.from === running.updateId) {
    return 'passed-over';
  }
  return 'offerable';
}

// ── When the pop-up may show ────────────────────────────────────────────────

export type PromptBlocker =
  | 'never'
  | 'memory-loading'
  | 'not-offerable'
  | 'native-busy'
  | 'not-in-shell'
  | 'splash'
  | 'not-active'
  | 'keyboard'
  | 'text-focus'
  | 'whats-new'
  | 'slot-taken'
  | 'work-route'
  | 'held'
  | 'own-state';

export interface PromptInputs {
  /** Development, updates off, or an emergency launch. */
  never: boolean;
  memoryLoaded: boolean;
  /** The waiting update may be offered (offerability). */
  offerable: boolean;
  /** Native update work, or this module's own check or fetch, is running. */
  nativeBusy: boolean;
  /** UpdatePromptHost is mounted: signed in, past MFA and the Face ID lock. */
  mounted: boolean;
  splashActive: boolean;
  appActive: boolean;
  keyboardVisible: boolean;
  textFocused: boolean;
  whatsNewOpen: boolean;
  /** A tour, the tour offer or a notification's notice holds the slot. */
  slotTaken: boolean;
  workRoute: boolean;
  /** A sheet, an alert, a photo or file flow, a draft, or a write in flight. */
  held: boolean;
  /** The pop-up is open, the app is restarting, Later was tapped this return, or a restart failed. */
  ownState: boolean;
}

/** The first thing keeping the pop-up away, or null when nothing is. */
export function promptBlocker(i: PromptInputs): PromptBlocker | null {
  if (i.never) return 'never';
  if (!i.memoryLoaded) return 'memory-loading';
  if (!i.offerable) return 'not-offerable';
  if (i.nativeBusy) return 'native-busy';
  if (!i.mounted) return 'not-in-shell';
  if (i.splashActive) return 'splash';
  if (!i.appActive) return 'not-active';
  if (i.keyboardVisible) return 'keyboard';
  if (i.textFocused) return 'text-focus';
  if (i.whatsNewOpen) return 'whats-new';
  if (i.slotTaken) return 'slot-taken';
  if (i.workRoute) return 'work-route';
  if (i.held) return 'held';
  if (i.ownState) return 'own-state';
  return null;
}

export function isWorkRoute(routeKey: string): boolean {
  return WORK_ROUTE_SET.has(routeKey);
}

// ── The check on a return to the app ────────────────────────────────────────

export interface ReturnCheckInputs {
  never: boolean;
  online: boolean;
  nativeBusy: boolean;
  ownCheckRunning: boolean;
  /** The pop-up is open or the app is restarting. */
  promptBusy: boolean;
  now: number;
  /** The native state's last check, in this JavaScript runtime. */
  lastCheckAt: number | null;
  /** This module's own last attempt. */
  lastAttemptAt: number | null;
}

export function shouldRunReturnCheck(i: ReturnCheckInputs): boolean {
  if (i.never || !i.online || i.nativeBusy || i.ownCheckRunning || i.promptBusy) return false;
  const last = Math.max(i.lastCheckAt ?? -Infinity, i.lastAttemptAt ?? -Infinity);
  return i.now - last >= RETURN_CHECK_MIN_GAP_MS;
}

/** The parts of a checkForUpdateAsync result this reads. */
export interface CheckResultLike {
  isAvailable?: boolean;
  isRollBackToEmbedded?: boolean;
  manifest?: { id?: unknown } | null;
  reason?: unknown;
}

/**
 * Download only what is not waiting already: a new update whose id differs
 * from the waiting one, or a roll back when none is waiting. An update that
 * failed to launch before comes back as "not available" (reason
 * updatePreviouslyFailed), so nothing is fetched for it.
 */
export function shouldFetch(result: CheckResultLike, waiting: WaitingUpdate | null): boolean {
  if (result.isAvailable === true) {
    const id = result.manifest?.id;
    if (typeof id !== 'string' || id === '') return false;
    return !(waiting?.type === 'new' && waiting.id === id.toLowerCase());
  }
  if (result.isRollBackToEmbedded === true) return waiting?.type !== 'rollback';
  return false;
}

// ── Reporting ───────────────────────────────────────────────────────────────

export type OtaWarningStage =
  | 'emergency-launch'
  | 'update-passed-over'
  | 'restart-no-change'
  | 'reload-slow'
  | 'reload-rejected'
  | 'reload-stuck';

/** An error's code when it looks like one (ERR_UPDATES_RELOAD), never its message. */
export function codeOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : null;
}

// ── The controller ──────────────────────────────────────────────────────────

export type UpdatePromptPhase =
  'never' | 'idle' | 'waiting' | 'settling' | 'open' | 'dismissed' | 'restarting' | 'failed';

/** What UpdatePromptHost tells the controller about the screen. */
export interface ScreenInputs {
  mounted: boolean;
  userId: string | null;
  /** useSegments().join('/') */
  routeKey: string;
  splashActive: boolean;
  keyboardVisible: boolean;
  whatsNewOpen: boolean;
  slotTaken: boolean;
}

export interface UpdatePromptDeps {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;

  /** Launch facts, fixed for this JavaScript runtime. */
  isDev: boolean;
  isEnabled: boolean;
  isEmergencyLaunch: boolean;
  isEmbeddedLaunch: boolean;
  runningUpdateId: string | null;
  runtimeToken: string;

  readNative(): NativeContextLike | null | undefined;
  listenNative(fn: (ctx: NativeContextLike) => void): () => void;
  currentAppState(): string;
  listenAppState(fn: (state: string) => void): () => void;
  isHeld(): boolean;
  listenHolds(fn: () => void): () => void;
  releaseHoldsUntilReturn(): void;
  isTextFocused(): boolean;

  loadMemory(): Promise<string | null>;
  saveMemory(text: string): Promise<void>;

  isOnline(): Promise<boolean>;
  checkForUpdate(): Promise<CheckResultLike>;
  fetchUpdate(): Promise<void>;

  /** The pop-up: Later, then Restart now. */
  showPrompt(onLater: () => void, onRestartNow: () => void): void;
  showRestartFailed(): void;
  /** Stops sync and the count drain between rows; returns their resume. */
  pauseWork(): () => void;
  /** Sync, the count drain and every write in flight have settled. */
  settle(): Promise<void>;
  /** The one restart (Updates.reloadAsync with the launch-screen look). */
  restart(): Promise<void>;
  /** Holds or releases the interruption slot. */
  setSlot(open: boolean): void;
  announce(text: string): void;
  reportOnce(stage: OtaWarningStage, code: string | null): void;
}

export interface UpdatePromptController {
  /** Subscribes and loads the memory. Returns the stop. */
  start(): () => void;
  setNative(ctx: NativeContextLike | null | undefined): void;
  setScreen(screen: Partial<ScreenInputs>): void;
  onAppState(state: string): void;
  onHoldsChanged(): void;
  onLater(): void;
  onRestartNow(): Promise<void>;
  runReturnCheck(): Promise<void>;
  /**
   * The record Restart now saved right before it restarted into this
   * JavaScript runtime. This runtime's first start reads it and clears it from
   * the memory, before any screen can look, so "Keep me signed in" (B57) asks
   * here and never reads MEMORY_KEY. Non-null: Restart now restarted the app
   * into this runtime, in the same visit, whether or not the update changed.
   * Null: an ordinary open from closed, a record too old to be this start's
   * (RESTART_RECORD_MAX_AGE_MS), or memory that could not be read. Resolves
   * once the memory has loaded, loading it if nothing has yet; never rejects.
   */
  restartRecordAtStart(): Promise<RestartRecord | null>;
  getPhase(): UpdatePromptPhase;
  getBlocker(): PromptBlocker | null;
  subscribe(fn: () => void): () => void;
}

export function createUpdatePromptController(deps: UpdatePromptDeps): UpdatePromptController {
  const never = deps.isDev || !deps.isEnabled || deps.isEmergencyLaunch;
  const running = { updateId: deps.runningUpdateId, isEmbeddedLaunch: deps.isEmbeddedLaunch };

  let started = false;
  let unsubs: (() => void)[] = [];
  let phase: UpdatePromptPhase = never ? 'never' : 'idle';
  let blocker: PromptBlocker | null = never ? 'never' : null;
  const listeners = new Set<() => void>();

  let native: NativeUpdateState = nativeStateFromContext(null);
  let screen: ScreenInputs = {
    mounted: false,
    userId: null,
    routeKey: '',
    splashActive: false,
    keyboardVisible: false,
    whatsNewOpen: false,
    slotTaken: false,
  };
  let appState = 'active';
  let sawBackground = false;
  /** Counts background-to-active returns; Later lasts for one. */
  let returnSeq = 0;
  let dismissed: { userId: string | null; returnSeq: number } | null = null;

  let memory: UpdateMemory | null = null;
  let memoryLoad: Promise<void> | null = null;
  /** The restart record this runtime's start found (restartRecordAtStart). */
  let restartAtStart: RestartRecord | null = null;

  // Timer handles are boxed: a handle may be any value (0 included).
  let settleTimer: { handle: unknown } | null = null;
  let focusTimer: { handle: unknown } | null = null;

  let checkInFlight: Promise<void> | null = null;
  let lastAttemptAt: number | null = null;
  let checksPaused = false;

  let watchdog: { handle: unknown } | null = null;
  let failureReported = false;
  const activeWaiters: (() => void)[] = [];
  const nativeIdleWaiters: (() => void)[] = [];

  function notify(): void {
    for (const fn of [...listeners]) fn();
  }

  function setPhase(next: UpdatePromptPhase, reason: PromptBlocker | null): void {
    if (phase === next && blocker === reason) return;
    phase = next;
    blocker = reason;
    notify();
  }

  function stopSettle(): void {
    if (settleTimer) deps.clearTimeout(settleTimer.handle);
    settleTimer = null;
  }

  function stopFocusRecheck(): void {
    if (focusTimer) deps.clearTimeout(focusTimer.handle);
    focusTimer = null;
  }

  function persist(): void {
    if (!memory) return;
    deps.saveMemory(serializeMemory(memory)).catch(() => {
      // Best-effort: the memory only keeps a skipped update from being offered.
    });
  }

  function isDismissedNow(): boolean {
    return (
      dismissed !== null && dismissed.returnSeq === returnSeq && dismissed.userId === screen.userId
    );
  }

  function waitingNow(): WaitingUpdate | null {
    return native.pending ? native.downloaded : null;
  }

  /**
   * Whether the waiting update may be offered, keeping the memory up to date:
   * an update seen waiting for the first time is written down with this
   * runtime, and a passed-over one is reported once per update.
   */
  function offerableNow(update: WaitingUpdate): boolean {
    if (!memory) return false;
    const verdict = offerability(update, running, memory, deps.runtimeToken);
    if (verdict === 'same-as-running') return false;
    const key = waitingKey(update);
    if (verdict === 'passed-over') {
      const entry = memory.waiting.find((e) => e.id === key);
      if (entry && !entry.reported) {
        memory = {
          ...memory,
          waiting: memory.waiting.map((e) => (e.id === key ? { ...e, reported: true } : e)),
        };
        persist();
        deps.reportOnce('update-passed-over', null);
      }
      return false;
    }
    if (!memory.waiting.some((e) => e.id === key)) {
      memory = {
        ...memory,
        waiting: [
          ...memory.waiting,
          { id: key, from: running.updateId, runtime: deps.runtimeToken, reported: false },
        ].slice(-MEMORY_MAX_ENTRIES),
      };
      persist();
    }
    return true;
  }

  function blockerFor(update: WaitingUpdate): PromptBlocker | null {
    return promptBlocker({
      never,
      memoryLoaded: memory !== null,
      offerable: memory !== null && offerableNow(update),
      nativeBusy: native.busy || checkInFlight !== null,
      mounted: screen.mounted,
      splashActive: screen.splashActive,
      appActive: appState === 'active',
      keyboardVisible: screen.keyboardVisible,
      textFocused: deps.isTextFocused(),
      whatsNewOpen: screen.whatsNewOpen,
      slotTaken: screen.slotTaken,
      workRoute: isWorkRoute(screen.routeKey),
      held: deps.isHeld(),
      // Open, restarting, failed and dismissed are settled before this runs.
      ownState: false,
    });
  }

  /**
   * Reads every input again and moves the phase. Runs on every change of the
   * native state, the screen, AppState and the holds, at the end of the quiet
   * period, and every FOCUS_RECHECK_MS while a focused field is the reason.
   */
  function evaluate(settled = false): void {
    if (!started) return;
    if (phase === 'never' || phase === 'open' || phase === 'restarting' || phase === 'failed') {
      stopSettle();
      stopFocusRecheck();
      return;
    }
    const update = waitingNow();
    if (!update) {
      stopSettle();
      stopFocusRecheck();
      setPhase('idle', null);
      return;
    }
    if (isDismissedNow()) {
      stopSettle();
      stopFocusRecheck();
      setPhase('dismissed', 'own-state');
      return;
    }
    const reason = blockerFor(update);
    if (reason) {
      stopSettle();
      if (reason === 'text-focus') {
        focusTimer ??= {
          handle: deps.setTimeout(() => {
            focusTimer = null;
            evaluate();
          }, FOCUS_RECHECK_MS),
        };
      } else {
        stopFocusRecheck();
      }
      setPhase('waiting', reason);
      return;
    }
    stopFocusRecheck();
    if (settled) {
      show();
      return;
    }
    settleTimer ??= {
      handle: deps.setTimeout(() => {
        settleTimer = null;
        evaluate(true);
      }, SHOW_SETTLE_MS),
    };
    setPhase('settling', null);
  }

  function show(): void {
    // Open first: the alert itself takes a hold (alert-holds.ts), and the
    // evaluation that hold starts must find the pop-up already open.
    setPhase('open', 'own-state');
    deps.setSlot(true);
    try {
      deps.showPrompt(onLater, () => {
        void onRestartNow();
      });
    } catch {
      // Nothing was shown: give the slot back and wait for the next return.
      dismissed = { userId: screen.userId, returnSeq };
      deps.setSlot(false);
      setPhase('dismissed', 'own-state');
    }
  }

  function onLater(): void {
    if (phase !== 'open') return;
    dismissed = { userId: screen.userId, returnSeq };
    deps.setSlot(false);
    setPhase('dismissed', 'own-state');
    evaluate();
  }

  function untilActive(): Promise<void> {
    if (appState === 'active') return Promise.resolve();
    return new Promise((resolve) => activeWaiters.push(resolve));
  }

  function untilNativeIdle(): Promise<void> {
    if (!native.busy) return Promise.resolve();
    return new Promise((resolve) => nativeIdleWaiters.push(resolve));
  }

  function withLimit(work: Promise<unknown>, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = deps.setTimeout(resolve, ms);
      work.then(
        () => {
          deps.clearTimeout(timer);
          resolve();
        },
        () => {
          deps.clearTimeout(timer);
          resolve();
        },
      );
    });
  }

  function fail(stage: OtaWarningStage, code: string | null, resume: () => void): void {
    if (phase !== 'restarting') return;
    if (watchdog) deps.clearTimeout(watchdog.handle);
    watchdog = null;
    resume();
    checksPaused = false;
    deps.setSlot(false);
    if (memory) {
      memory = { ...memory, restart: null };
      persist();
    }
    if (!failureReported) {
      failureReported = true;
      deps.reportOnce(stage, code);
    }
    setPhase('failed', 'own-state');
    deps.showRestartFailed();
  }

  async function onRestartNow(): Promise<void> {
    if (phase !== 'open') return;
    // The overlay (UpdatePromptHost) covers the app from here, and the slot
    // stays held, so nothing else opens over a restart.
    setPhase('restarting', 'own-state');
    deps.announce(RESTARTING_LABEL);
    checksPaused = true;
    const resume = deps.pauseWork();
    // Let what is already on its way finish: a reload cancels every request
    // in flight, and a cut write may or may not have landed.
    await withLimit(
      Promise.all([deps.settle(), checkInFlight ?? Promise.resolve(), untilNativeIdle()]),
      RESTART_SETTLE_MAX_MS,
    );
    // Never restart in the background.
    await untilActive();
    if (memory) {
      memory = { ...memory, restart: { from: running.updateId, at: deps.now() } };
      await deps.saveMemory(serializeMemory(memory)).catch(() => {});
    }
    // A queued restart cannot be taken back (expo-updates' relaunch waits its
    // turn and may download missing files first), so the overlay stays while
    // it is pending; a slow one is only reported.
    const slow = deps.setTimeout(() => deps.reportOnce('reload-slow', null), RELOAD_SLOW_MS);
    try {
      await deps.restart();
    } catch (err) {
      deps.clearTimeout(slow);
      fail('reload-rejected', codeOf(err), resume);
      return;
    }
    deps.clearTimeout(slow);
    // reloadAsync resolves just before the restart: JavaScript still running
    // well after it means the restart did not happen.
    watchdog = {
      handle: deps.setTimeout(() => fail('reload-stuck', null, resume), RESTART_WATCHDOG_MS),
    };
  }

  async function runReturnCheck(): Promise<void> {
    const eligible = (online: boolean) =>
      !checksPaused &&
      shouldRunReturnCheck({
        never,
        online,
        nativeBusy: native.busy,
        ownCheckRunning: checkInFlight !== null,
        promptBusy: phase === 'open' || phase === 'restarting',
        now: deps.now(),
        lastCheckAt: native.lastCheckAt,
        lastAttemptAt,
      });
    if (!started || !eligible(true)) return;
    let finish!: () => void;
    checkInFlight = new Promise<void>((resolve) => {
      finish = resolve;
    });
    evaluate();
    try {
      const online = await deps.isOnline().catch(() => false);
      // Read again: the pop-up may have opened, or a restart begun, meanwhile.
      if (!online || checksPaused || phase === 'open' || phase === 'restarting') return;
      lastAttemptAt = deps.now();
      // What waits before the check: the check's own result can rewrite the
      // native rollback field before it answers.
      const before = waitingNow();
      const result = await deps.checkForUpdate();
      if (shouldFetch(result, before)) await deps.fetchUpdate();
    } catch {
      // Best-effort: the next return, or the next open from closed, checks again.
    } finally {
      checkInFlight = null;
      finish();
      evaluate();
    }
  }

  function setNative(ctx: NativeContextLike | null | undefined): void {
    native = nativeStateFromContext(ctx);
    if (!native.busy) for (const resolve of nativeIdleWaiters.splice(0)) resolve();
    evaluate();
  }

  function setScreen(next: Partial<ScreenInputs>): void {
    screen = { ...screen, ...next };
    evaluate();
  }

  function onAppState(state: string): void {
    appState = state;
    if (state === 'background') sawBackground = true;
    if (state === 'active') {
      for (const resolve of activeWaiters.splice(0)) resolve();
      if (sawBackground) {
        // A return. Inactive to active (Face ID, Control Center, the app
        // switcher, Split View) is not one.
        sawBackground = false;
        returnSeq += 1;
        deps.releaseHoldsUntilReturn();
        void runReturnCheck();
      }
    }
    evaluate();
  }

  function onHoldsChanged(): void {
    evaluate();
  }

  function loadMemory(): Promise<void> {
    memoryLoad ??= deps
      .loadMemory()
      .then(parseMemory, () => EMPTY_MEMORY)
      .then((loaded) => {
        // Kept for restartRecordAtStart first: the memory is cleared below.
        const record = loaded.restart;
        restartAtStart =
          record && Math.abs(deps.now() - record.at) <= RESTART_RECORD_MAX_AGE_MS
            ? { from: record.from, at: record.at }
            : null;
        if (never) {
          // No pop-up in this runtime, but the record is still its own to
          // clear, or a later open from closed would read as a restart. After
          // an emergency launch (an update that would not start) the waiting
          // list stays as it is, for the next launch's passed-over check.
          if (record) {
            deps.saveMemory(serializeMemory({ ...loaded, restart: null })).catch(() => {});
          }
          return;
        }
        // Entries from another running update are history: the phone moved on.
        const waiting = loaded.waiting.filter((e) => e.from === running.updateId);
        let changed = waiting.length !== loaded.waiting.length;
        if (loaded.restart) {
          // Restart now saved this right before restarting. Still on the same
          // update, the restart changed nothing.
          if (loaded.restart.from === running.updateId) deps.reportOnce('restart-no-change', null);
          changed = true;
        }
        memory = { v: 1, waiting, restart: null };
        if (changed) persist();
        evaluate();
      });
    return memoryLoad;
  }

  function restartRecordAtStart(): Promise<RestartRecord | null> {
    const read = () => (restartAtStart ? { ...restartAtStart } : null);
    return loadMemory().then(read, read);
  }

  function stop(): void {
    if (!started) return;
    started = false;
    for (const off of unsubs) off();
    unsubs = [];
    stopSettle();
    stopFocusRecheck();
  }

  function start(): () => void {
    if (started) return stop;
    started = true;
    if (never) {
      if (deps.isEmergencyLaunch && !deps.isDev) deps.reportOnce('emergency-launch', null);
      setPhase('never', 'never');
      // Only to read and clear the restart record (restartRecordAtStart).
      void loadMemory();
      return stop;
    }
    appState = deps.currentAppState();
    sawBackground = appState === 'background';
    native = nativeStateFromContext(deps.readNative());
    unsubs = [
      deps.listenNative(setNative),
      deps.listenAppState(onAppState),
      deps.listenHolds(onHoldsChanged),
    ];
    void loadMemory();
    evaluate();
    return stop;
  }

  return {
    start,
    setNative,
    setScreen,
    onAppState,
    onHoldsChanged,
    onLater,
    onRestartNow,
    runReturnCheck,
    restartRecordAtStart,
    getPhase: () => phase,
    getBlocker: () => blocker,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

import { shouldProbeAfterFailure, type AuthProbeResult } from './account-disabled-probe';

import type { AccountGateState } from './account-disabled-state';

/**
 * What happens to a device whose account was just confirmed disabled, and the
 * bus that lets a non-React caller (the API helper's 401 path) ask for it.
 *
 * Kept pure — every side effect arrives as an injected step — because this is
 * the one sequence that must not be half-done, and the vitest environment here
 * cannot load react-native. The wiring lives in use-account-gate.ts.
 */

export interface EvictionSteps {
  /** Abort requests already on the wire. */
  cancelRequests: () => void | Promise<void>;
  /** Local-scope sign-out: drops the session from secure storage. */
  signOutLocal: () => void | Promise<void>;
  /**
   * Wipe the account-scoped SQLite cache. The offline outbox is REJECTED rather
   * than deleted (see use-account-gate.ts): terminal, so it can never replay
   * after a re-enable, but preserved, so the operator's queued work leaves a
   * record instead of disappearing without explanation.
   */
  clearCaches: () => void | Promise<void>;
  /** Drop the account-scoped keys in AsyncStorage (active org, warehouse). */
  clearAccountStorage: () => void | Promise<void>;
  /** Reset the protected navigation stack back to the auth group. */
  resetNavigation: () => void | Promise<void>;
}

export type EvictionStep = keyof EvictionSteps;

/**
 * The one safe order.
 *
 * Requests are cancelled BEFORE credentials are cleared, so nothing lands
 * afterwards and repopulates a cache we are about to wipe. Credentials go next,
 * because that is what actually ends the session. Caches and account-scoped
 * storage follow. Navigation is reset LAST, so no protected screen renders
 * against half-cleared state on its way out.
 */
export const EVICTION_STEP_ORDER: readonly EvictionStep[] = [
  'cancelRequests',
  'signOutLocal',
  'clearCaches',
  'clearAccountStorage',
  'resetNavigation',
];

/**
 * Runs the eviction. FAIL-SAFE, not fail-fast: the account is already disabled
 * and the gate flag is already set, so a Keychain rejection while clearing
 * credentials must not leave the caches, the outbox and the navigation stack
 * behind. Never rejects; returns the steps that failed so the caller can log.
 */
export async function runAccountEviction(steps: EvictionSteps): Promise<EvictionStep[]> {
  const failed: EvictionStep[] = [];
  for (const step of EVICTION_STEP_ORDER) {
    try {
      await steps[step]();
    } catch (e) {
      failed.push(step);
      console.warn(`[account-eviction] ${step} failed`, e);
    }
  }
  return failed;
}

/**
 * AsyncStorage keys that belong to the SIGNED-IN ACCOUNT rather than to the
 * device: the active org and the per-org active warehouse (use-workspace.ts's
 * ORG_STORAGE_KEY / WAREHOUSE_STORAGE_KEY, both under `workspace.`).
 *
 * Device-level preferences — the scanner tip, What's New — are deliberately
 * left alone: they say nothing about the account, and wiping them would
 * silently reset a shared warehouse device for whoever signs in next.
 */
export const ACCOUNT_SCOPED_STORAGE_PREFIXES: readonly string[] = ['workspace.'];

export function accountScopedStorageKeys(allKeys: readonly string[]): string[] {
  return allKeys.filter((k) => ACCOUNT_SCOPED_STORAGE_PREFIXES.some((p) => k.startsWith(p)));
}

/**
 * Maps a probe result onto a gate transition. `null` means "change nothing".
 *
 * The interesting case is 'unknown' — an offline device, an expired session,
 * any inconclusive answer. From `ok` or `disabled` it changes nothing: a blip
 * must never lock a working account out, and a disabled account that goes
 * offline must stay disabled. From `unverified` it RELEASES back to ok, because
 * that screen is blocking: an inconclusive answer is not evidence of a server
 * outage, and stranding an offline warehouse behind a retry button that can
 * never succeed is worse than anything the screen was protecting against.
 */
export function nextGateForProbe(
  current: AccountGateState,
  result: AuthProbeResult,
): AccountGateState | null {
  switch (result) {
    case 'disabled':
      return 'disabled';
    case 'active':
      return 'ok';
    case 'unavailable':
      return 'unverified';
    default:
      return current === 'unverified' ? 'ok' : null;
  }
}

/**
 * One getUser() round trip per burst. When a session dies, every mounted screen
 * 401s at once; without this the app would answer a dead session with a dozen
 * identical probes.
 */
export const PROBE_MIN_INTERVAL_MS = 30_000;

export function shouldRunProbeNow(
  now: number,
  lastProbeAt: number | null,
  minIntervalMs: number = PROBE_MIN_INTERVAL_MS,
): boolean {
  if (lastProbeAt === null) return true;
  // A clock that jumped backwards must not wedge the probe shut.
  if (now < lastProbeAt) return true;
  return now - lastProbeAt >= minIntervalMs;
}

/**
 * A probe must be BOUNDED. React Native's fetch has no default timeout and
 * neither does gotrue-js, so a captive portal that accepts the connection and
 * never answers would leave the caller waiting forever — and one of those
 * callers is the force-logout path.
 */
export const PROBE_TIMEOUT_MS = 8_000;

export function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    void work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

let unauthorizedHandler: (() => void) | null = null;
let lastNotifiedAt: number | null = null;

/**
 * Registered once by RootGate. api.ts calls `notifyUnauthorized` from a plain
 * module, so this indirection is what lets a 401 anywhere in the app reach the
 * React-side probe without api.ts importing supabase, the router or the DB.
 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/**
 * Called on every failed response. Filters to 401 (a 403 is a permission
 * answer, not an identity one), throttles, and never lets a handler failure
 * escape into the request path it was called from.
 */
export function notifyUnauthorized(err: unknown, now: number = Date.now()): void {
  if (!shouldProbeAfterFailure(err)) return;
  // No handler mounted yet — do NOT burn the window, or the first 401 after
  // launch would silence the first real probe.
  if (!unauthorizedHandler) return;
  if (!shouldRunProbeNow(now, lastNotifiedAt)) return;
  lastNotifiedAt = now;
  try {
    unauthorizedHandler();
  } catch (e) {
    console.warn('[account-eviction] unauthorized handler failed', e);
  }
}

/** Test-only. */
export function __resetUnauthorizedBusForTests(): void {
  unauthorizedHandler = null;
  lastNotifiedAt = null;
}

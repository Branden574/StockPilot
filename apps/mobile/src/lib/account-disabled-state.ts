/**
 * Module-level "what is this account allowed to do right now" flag.
 *
 * It lives outside React because the things that DISCOVER the state are not
 * components — the API helper's 401 path, the auth provider's cold-launch
 * hydrate, the outbox drain — while the thing that RENDERS it is RootGate. A
 * plain subscribable module keeps that seam pure (and therefore testable in
 * this vitest environment, which cannot load react-native).
 *
 * THREE states, not two, mirroring the web guard exactly
 * (apps/web/src/lib/auth/account-status.ts):
 *
 *   ok          — nothing to say; the app behaves normally.
 *   disabled    — CONFIRMED by GoTrue's structured `user_banned`. Renders the
 *                 owner-approved disabled copy from @stockpilot/core.
 *   unverified  — the account status could NOT be read (the identity server
 *                 itself failed). This is the mobile twin of
 *                 AccountStatusUnavailableError. It must deny, and it must not
 *                 look like `disabled`: the disabled copy tells a person to
 *                 contact their administrator, and saying that to someone whose
 *                 account is fine sends them somewhere no one can help them.
 *
 * Collapsing `unverified` into `disabled` was a critical defect on the web side
 * and must not be reintroduced here.
 */

export type AccountGateState = 'ok' | 'disabled' | 'unverified';

let state: AccountGateState = 'ok';

/** Subscribers that only care about the boolean "is this account disabled". */
const disabledListeners = new Set<(next: boolean) => void>();
/** Subscribers that care about the full three-state gate. */
const gateListeners = new Set<(next: AccountGateState) => void>();

export function getAccountGateState(): AccountGateState {
  return state;
}

export function setAccountGateState(next: AccountGateState): void {
  if (state === next) return;
  const wasDisabled = state === 'disabled';
  state = next;
  for (const l of gateListeners) l(next);
  // Only wake the boolean subscribers when the BOOLEAN actually moved, so a
  // transient ok↔unverified flap never churns the disabled gate.
  const isDisabled = next === 'disabled';
  if (wasDisabled !== isDisabled) {
    for (const l of disabledListeners) l(isDisabled);
  }
}

export function getAccountDisabled(): boolean {
  return state === 'disabled';
}

export function setAccountDisabled(next: boolean): void {
  if (next) {
    setAccountGateState('disabled');
    return;
  }
  // Clearing the disable clears the whole gate: a re-enabled (or different)
  // account starts from a clean slate.
  if (state === 'disabled') setAccountGateState('ok');
}

export function subscribeAccountDisabled(listener: (next: boolean) => void): () => void {
  disabledListeners.add(listener);
  return () => {
    disabledListeners.delete(listener);
  };
}

export function subscribeAccountGate(listener: (next: AccountGateState) => void): () => void {
  gateListeners.add(listener);
  return () => {
    gateListeners.delete(listener);
  };
}

/**
 * Clears the flag so a later sign-in is clean. Deliberately does NOT drop the
 * listeners: RootGate subscribes exactly once, in a mount effect with an empty
 * dep array, so clearing the set here would leave a later disable setting the
 * flag with nobody listening and the screen would never render.
 */
export function resetAccountDisabled(): void {
  setAccountGateState('ok');
}

/** Test-only: clears the flag AND every subscription. */
export function __resetAccountGateForTests(): void {
  state = 'ok';
  disabledListeners.clear();
  gateListeners.clear();
}

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

/**
 * HOW a `disabled` verdict was established — and therefore WHOSE it is.
 *
 *   'session'  the verdict is about the session this device is holding: a
 *              getUser() probe answered `user_banned`, or an eviction broadcast
 *              aimed at this user was corroborated by a probe. The device's own
 *              data is the disabled account's data.
 *   'sign-in'  GoTrue answered `user_banned` to a PASSWORD GRANT typed at the
 *              sign-in screen. It says nothing about this device: GoTrue
 *              evaluates the ban BEFORE the password, so any passer-by who
 *              knows one disabled address gets this answer, and the queued work
 *              on the device may belong to a different, healthy user who fell
 *              back from the biometric lock.
 *
 * The screen may be raised by either. The EVICTION — which terminally rejects
 * the offline outbox and wipes the cache — may only ever follow 'session'.
 */
export type DisableEvidence = 'session' | 'sign-in';

let state: AccountGateState = 'ok';
let evidence: DisableEvidence | null = null;

/** Subscribers that only care about the boolean "is this account disabled". */
const disabledListeners = new Set<(next: boolean) => void>();
/** Subscribers that care about the full three-state gate. */
const gateListeners = new Set<(next: AccountGateState) => void>();

export function getAccountGateState(): AccountGateState {
  return state;
}

/**
 * Reads how the CURRENT disabled verdict was established, or null when the gate
 * is not disabled. Consumed by the eviction precondition (account-eviction.ts's
 * `shouldRunEviction`), which is the only caller allowed to act destructively.
 */
export function getDisableEvidence(): DisableEvidence | null {
  return evidence;
}

/**
 * `how` defaults to 'session' because every caller EXCEPT the sign-in rejection
 * is reasoning about this device's own session. The one exception passes
 * 'sign-in' explicitly, and the eviction precondition refuses it.
 */
export function setAccountGateState(
  next: AccountGateState,
  how: DisableEvidence = 'session',
): void {
  if (state === next) {
    // A repeat verdict can still STRENGTHEN the attribution — the sign-in
    // rejection may have raised the screen first and a probe of this device's
    // own session may confirm it afterwards. It can never weaken it: 'sign-in'
    // must not overwrite 'session', or a passer-by could disarm nothing and
    // re-arm nothing but would muddy the one input the eviction trusts.
    //
    // MUST still notify gateListeners on a REAL strengthen (M-1). Returning
    // silently here, as this used to, meant a verdict that arrived as
    // 'sign-in' and was only later corroborated as 'session' could never arm
    // the eviction: use-account-gate.ts mirrors this module's evidence into
    // its own React state precisely so a strengthen-only update — the gate
    // STATE stays 'disabled', only the evidence moves — can still re-run the
    // eviction effect, and that mirroring only ever hears about a change
    // through this notification.
    if (next === 'disabled' && how === 'session' && evidence !== 'session') {
      evidence = 'session';
      for (const l of gateListeners) l(next);
    }
    return;
  }
  const wasDisabled = state === 'disabled';
  state = next;
  evidence = next === 'disabled' ? how : null;
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

export function setAccountDisabled(next: boolean, how: DisableEvidence = 'session'): void {
  if (next) {
    setAccountGateState('disabled', how);
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
  evidence = null;
  disabledListeners.clear();
  gateListeners.clear();
}

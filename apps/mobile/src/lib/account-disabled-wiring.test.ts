import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ACCOUNT_DISABLED_MESSAGE, ACCOUNT_DISABLED_TITLE } from '@stockpilot/core';

/**
 * Account-disable — WIRING PINS.
 *
 * The pure logic is tested in account-disabled-state / account-disabled-probe /
 * account-eviction / request-cancellation. What those cannot reach is the
 * WIRING: this repo has no component harness (the vitest config deliberately
 * excludes app/ screens and every component that loads a native module), so the
 * load-bearing connections are pinned at source level. Each pin below is a
 * specific way the feature silently stops working:
 *
 *   1. the revocation listener mounted in DrawerContent reached only users who
 *      were behind the drawer — not the pushed card screens, not the auth
 *      group, not the pre-drawer cold launch;
 *   2. the disabled screen must sit ABOVE the MFA and biometric gates, and must
 *      not require a session (a disabled user is refused AT sign-in, so there
 *      is no session to test);
 *   3. an UNREADABLE status must never render the disabled copy — the web fix
 *      that separated AccountStatusUnavailableError from a real disable;
 *   4. the copy is the shared owner-approved constant, never retyped;
 *   5. sign-out from this device is scope 'local' — a global sign-out would
 *      cascade to the user's other devices and, for a banned token, be refused
 *      by GoTrue anyway;
 *   6. only GoTrue's structured `user_banned` may raise the gate.
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

/** Comments explain the rules; only the CODE can leak. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Collapse formatting so a prettier line-break cannot fail a wiring pin. */
const flat = (src: string) => code(src).replace(/\s+/g, ' ');

const rootLayout = read('../../app/_layout.tsx');
const drawer = read('../components/drawer-content.tsx');
const screen = read('../components/account-disabled-screen.tsx');
const authContext = read('./auth-context.tsx');
const apiSrc = read('./api.ts');
const gate = read('./use-account-gate.ts');
const revocation = read('./use-session-revocation.ts');
const evictionSrc = read('./account-eviction.ts');

describe('the eviction listener is mounted where every screen can see it', () => {
  it('RootGate owns useSessionRevocation', () => {
    expect(rootLayout).toContain("import { useSessionRevocation } from '@/lib/use-session-revocation'");
    expect(rootLayout).toContain('useSessionRevocation(session?.user?.id ?? null');
  });

  it('DrawerContent no longer mounts it', () => {
    expect(drawer).not.toContain('useSessionRevocation');
    expect(drawer).toContain('Force-logout lives in RootGate now');
  });

  it('RootGate mounts the account gate itself, not a screen', () => {
    expect(rootLayout).toContain("import { useAccountGate } from '@/lib/use-account-gate'");
    expect(rootLayout).toContain('useAccountGate({ onEvicted: onForcedSignOut })');
  });

  it('hands the revocation listener the handler that can tell the two apart', () => {
    expect(rootLayout).toContain('onTargeted: accountGate.onSessionRevoked');
  });
});

/**
 * The line-5 / line-11 fix — WIRING PINS.
 *
 * The end-to-end run found that our own session revocation had made our own
 * detection mechanism unreachable: the disable deletes the auth.sessions row,
 * so the device's probe gets `session_not_found`, never `user_banned`, the gate
 * never reached 'disabled', the disabled screen never rendered and the outbox
 * was never rejected. There are exactly two moments a device can learn the
 * truth, and both must stay wired:
 *
 *   ONLINE — the eviction broadcast, which now names the reason. It is a
 *     PUBLIC channel, so the reason alone is a claim, not proof; the probe has
 *     to corroborate that the session really is gone before it is believed.
 *   RELAUNCH / OFFLINE — there is no proof available at all, so the device
 *     signs out and asks for a SIGN-IN, and GoTrue answers `user_banned` to
 *     the password grant. One extra step, and honest.
 */
describe('a revoked device can still find out what happened', () => {
  it('the listener forwards the broadcast payload, not just the fact of it', () => {
    // Without the payload the handler cannot see the reason and the online
    // half of the fix silently reverts to the old force-logout alert.
    expect(revocation).toContain('onTargeted?: (payload: unknown) => Promise<boolean>');
    expect(code(revocation)).toContain('onTargetedRef.current(payload)');
  });

  it('the gate believes the reason only when the probe corroborates it', () => {
    expect(gate).toContain("import { isDisableRevocation } from '@stockpilot/core'");
    expect(gate).toContain('gateForRevocation(');
    // A bare `if (isDisableRevocation(payload)) setAccountGateState('disabled')`
    // would let anyone holding the shipped anon key and a user's uuid forge a
    // disabled screen AND a terminal rejection of that user's queued work.
    expect(flat(gate)).not.toMatch(
      /if \(isDisableRevocation\([a-zA-Z]+\)\) \{? ?setAccountGateState\('disabled'\)/,
    );
  });

  it('a dead session signs out locally and asks for a sign-in', () => {
    expect(gate).toContain('probeAndSettle(');
    expect(authContext).toContain('probeAndSettle(');
    expect(rootLayout).toContain('signedOutRoute()');
    // Cleared on a fresh sign-in, or the sign-in destination would be sticky
    // for the rest of the app's life.
    expect(rootLayout).toContain('clearSessionEnded();');
    // The marketing screen is what the run actually observed, and it is the
    // one destination from which the user learns nothing.
    expect(code(rootLayout)).not.toContain("router.replace('/(auth)/welcome' as Href)");
  });

  it('sign-in remains the path that CONFIRMS a disable', () => {
    expect(authContext).toContain("(error as { code?: string }).code === 'user_banned'");
    expect(authContext).toContain("setAccountDisabled(true, 'sign-in')");
  });

  it('the outbox is rejected from the gate transition BOTH paths end at', () => {
    // Not from the broadcast handler and not from the sign-in branch: one
    // rejection site, driven by the transition into `disabled`, so neither
    // path can be the one that silently stops rejecting.
    expect(gate).toContain('rejectAllPending(ACCOUNT_DISABLED_REJECTION)');
    const evictionEffect = gate.slice(gate.indexOf('shouldRunEviction({'));
    expect(evictionEffect).toContain('rejectAllPending');
    expect(code(revocation)).not.toContain('rejectAllPending');
  });
});

/**
 * THE UNAUTHENTICATED DATA-DESTRUCTION BUG.
 *
 * The eviction terminally rejects THIS DEVICE's offline outbox and wipes its
 * cache. It hung off the transition into `disabled` alone — and one path into
 * that transition is a FAILED sign-in, because GoTrue evaluates the ban BEFORE
 * the password. Anyone who could reach the sign-in screen and knew one disabled
 * colleague's address could therefore destroy whatever queued warehouse work
 * was on the device, with no credentials at all; and after "Use password
 * instead" on the biometric lock (signOutToFallback, which deliberately does
 * not wipe), that work routinely belongs to a different, healthy user.
 *
 * The screen may still be raised from either path. The EVICTION may only follow
 * a verdict attributed to this device's own session.
 */
describe('only a verdict about THIS device may destroy its queued work', () => {
  it('the sign-in rejection is attributed to the sign-in, not to the session', () => {
    expect(authContext).toContain("setAccountDisabled(true, 'sign-in')");
    expect(code(authContext)).not.toContain('setAccountDisabled(true)');
  });

  it('the eviction asks the precondition, not just the gate state', () => {
    expect(gate).toContain("import {");
    expect(gate).toContain('shouldRunEviction');
    expect(gate).toContain('getDisableEvidence');
    expect(flat(gate)).toContain(
      'shouldRunEviction({ state, evidence: getDisableEvidence(), alreadyEvicting: evicting.current, })',
    );
    // The bare state check is exactly what was wrong: it cannot tell a verdict
    // about this device from an email somebody typed.
    expect(code(gate)).not.toContain("if (state !== 'disabled' || evicting.current) return;");
  });

  it('a successful password grant takes a stale gate back down', () => {
    // GoTrue refuses a banned user before it checks the password, so a sign-in
    // that SUCCEEDED is proof the account is fine. Without this, a gate raised
    // by somebody else's rejected attempt would meet the next healthy user
    // with the disabled screen.
    const signInFn = authContext.slice(authContext.indexOf("const signIn: AuthState['signIn']"));
    expect(signInFn).toContain('resetAccountDisabled();');
  });
});

describe('the gate renders above every other gate', () => {
  it('shows the disabled screen without requiring a session', () => {
    expect(rootLayout).toContain("if (!loading && accountGate.state === 'disabled') {");
    expect(rootLayout).toContain('<AccountDisabledScreen />');
  });

  it('places the disabled gate ABOVE the MFA and biometric gates', () => {
    const disabledAt = rootLayout.indexOf("accountGate.state === 'disabled'");
    const mfaAt = rootLayout.indexOf('session && mfaRequired');
    const lockAt = rootLayout.indexOf('session && locked');
    expect(disabledAt).toBeGreaterThan(-1);
    expect(disabledAt).toBeLessThan(mfaAt);
    expect(disabledAt).toBeLessThan(lockAt);
  });

  it('stops the unauthenticated redirect fighting the disabled screen', () => {
    expect(rootLayout).toContain("if (loading || accountGate.state === 'disabled') return;");
  });

  /**
   * An UNREADABLE status must not blockade an offline-first app.
   *
   * It used to render a full-screen "Something went wrong / Try again" for any
   * signed-in user, so a GoTrue 5xx — which says nothing about the account —
   * cut a warehouse phone off from its SQLite cache and its offline outbox, the
   * two things built to work without a server, for the length of the incident.
   * Only a CONFIRMED disable blocks now; the unreadable case runs on the cached
   * session and re-probes in the background.
   */
  it('never blocks the app on a status it merely could not read', () => {
    expect(code(rootLayout)).not.toContain('AccountStatusUnverifiedScreen');
    expect(code(rootLayout)).not.toMatch(/accountGate\.state === 'unverified'/);
    expect(code(screen)).not.toContain('export function AccountStatusUnverifiedScreen');
  });

  it('re-probes an unreadable status in the background instead', () => {
    expect(gate).toContain('unverifiedRetryDelayMs');
    const loop = gate.slice(gate.indexOf("if (state !== 'unverified') return;"));
    expect(loop).toContain('probeNow()');
    expect(loop).toContain('clearTimeout');
    // 'unverified' remains a real gate state — collapsing it into 'disabled'
    // was the critical defect on the web side.
    expect(evictionSrc).toContain("case 'unavailable':");
    expect(evictionSrc).toContain("return 'unverified'");
  });
});

describe('the screen says exactly what the web screen says', () => {
  it('takes both sentences from @stockpilot/core', () => {
    expect(screen).toContain(
      "import { ACCOUNT_DISABLED_MESSAGE, ACCOUNT_DISABLED_TITLE } from '@stockpilot/core'",
    );
    expect(screen).toContain('{ACCOUNT_DISABLED_TITLE}');
    expect(screen).toContain('{ACCOUNT_DISABLED_MESSAGE}');
  });

  it('never retypes the copy', () => {
    expect(screen).not.toContain(ACCOUNT_DISABLED_TITLE);
    expect(screen).not.toContain(ACCOUNT_DISABLED_MESSAGE);
  });

  it('reveals no reason, actor or date', () => {
    for (const leak of ['disabled_reason', 'disabled_by', 'disabled_at', 'reason', 'notes']) {
      expect(code(screen)).not.toContain(leak);
    }
  });

  it('signs out locally, and clears the flag so another account can sign in', () => {
    expect(screen).toContain('signOutToFallback');
    expect(screen).toContain('setAccountDisabled(false)');
    expect(screen).not.toContain("scope: 'global'");
  });

  it('indexes ACCENT rather than passing the palette object as a colour', () => {
    // ACCENT is an object ({ mint, pipTeal, ... }); handing it to a colour prop
    // is a type error and renders nothing.
    expect(screen).not.toMatch(/color(?:=|: )\{?ACCENT\}?[,\s)]/);
    if (screen.includes('ACCENT')) expect(screen).toMatch(/ACCENT\.[a-zA-Z]/);
  });

  it('is the ONLY screen this file ships — the transient twin blocked the app', () => {
    // It offered one control, "Try again", above every app surface, so an
    // identity-server blip denied a warehouse device its own offline work while
    // the screen's footer read "YOUR OFFLINE WORK IS SAFE".
    expect(code(screen)).not.toContain('YOUR OFFLINE WORK IS SAFE');
    expect((code(screen).match(/export function /g) ?? []).length).toBe(1);
  });
});

describe('the paths that can raise the gate', () => {
  it('sign-in trusts the structured code only, and answers with the shared copy', () => {
    expect(authContext).toContain("(error as { code?: string }).code === 'user_banned'");
    expect(authContext).toContain("setAccountDisabled(true, 'sign-in')");
    expect(authContext).toContain('return { error: ACCOUNT_DISABLED_MESSAGE };');
  });

  it('cold launch probes the restored session and cannot log a working user out', () => {
    expect(authContext).toContain('supabase.auth.getUser()');
    expect(flat(authContext)).toContain('probeAndSettle( getAccountGateState(),');
    // The rejection tolerance moved INTO probeAndSettle (a thrown probe
    // classifies as 'unknown', which changes nothing) so the hydrate path can
    // no longer forget its own try/catch.
    expect(evictionSrc).toContain('// A rejected probe is inconclusive, never evidence of anything.');
  });

  it('never AWAITS the cold-launch probe — the hydrate path owns `loading`', () => {
    // RN fetch has no timeout. An awaited probe against a captive portal would
    // hold loading=true forever and render a blank shell with no recovery but
    // force-quit — the exact failure the hydrate path's fail-closed guard was
    // written for.
    expect(authContext).toContain('void probeAndSettle(');
    expect(authContext).not.toContain('await supabase.auth.getUser()');
    expect(authContext).not.toContain('await probeAndSettle(');
  });

  it('an involuntary SIGNED_OUT routes to sign-in; a deliberate one does not', () => {
    // auth-js drops a REVOKED session inside its own initialize(), before
    // getSession() returns, so on a relaunch this event is the only trace that
    // the device ever had one. The two deliberate exits withdraw the latch so a
    // user who chose to leave still gets the marketing screen.
    expect(authContext).toContain('markSessionEnded();');
    expect((authContext.match(/clearSessionEnded\(\);/g) ?? []).length).toBe(2);
    const signOutFns = authContext.slice(authContext.indexOf("const signOut: AuthState['signOut']"));
    expect(signOutFns).toContain('clearSessionEnded();');
  });

  it('a device that never had a session still gets the MARKETING screen', () => {
    // auth-js hands every new subscriber an INITIAL_SESSION event, with a null
    // session on a fresh install. Latching on `!s?.user` fired there too, so
    // /(auth)/welcome became unreachable at launch for every first-run user —
    // and the latch is read by RootGate's redirect, which cannot tell why.
    expect(authContext).toContain('isInvoluntarySessionEnd(event, Boolean(s?.user))');
    const signedOutBranch = code(authContext).slice(
      code(authContext).indexOf("if (event === 'SIGNED_OUT'"),
      code(authContext).indexOf("if (event === 'SIGNED_IN')"),
    );
    expect(signedOutBranch).not.toMatch(/^\s*markSessionEnded\(\);/m);
  });

  it('a SIGNED_OUT event does not clear the gate', () => {
    const signedOutBranch = authContext.slice(
      authContext.indexOf("if (event === 'SIGNED_OUT'"),
      authContext.indexOf("if (event === 'SIGNED_IN')"),
    );
    expect(signedOutBranch).not.toContain('setAccountDisabled');
    expect(signedOutBranch).not.toContain('setAccountGateState');
    expect(signedOutBranch).not.toContain('resetAccountDisabled');
  });

  it('every failed request rings the bus, which filters to 401 itself', () => {
    expect(apiSrc).toContain("import { notifyUnauthorized } from './account-eviction'");
    expect(apiSrc).toContain('notifyUnauthorized({ status: res.status });');
  });

  it('every request is cancellable, and always released', () => {
    expect(apiSrc).toContain('const releaseInFlight = registerInFlight(ctrl);');
    const finallyBlock = apiSrc.slice(apiSrc.indexOf('} finally {'));
    expect(finallyBlock).toContain('releaseInFlight();');
  });
});

describe('the eviction the gate runs', () => {
  it('does all five things, from the one place that can', () => {
    expect(gate).toContain('abortAllInFlight()');
    expect(gate).toContain("supabase.auth.signOut({ scope: 'local' })");
    expect(gate).toContain('wipeForSignOut()');
    expect(gate).toContain('accountScopedStorageKeys(await AsyncStorage.getAllKeys())');
    expect(gate).toContain('resetNavigation: onEvicted');
  });

  it('never signs out globally — that would cascade to the user other devices', () => {
    expect(gate).not.toContain("scope: 'global'");
  });

  it('evicts at most once per transition into disabled', () => {
    expect(gate).toContain('evicting.current');
  });

  it('adds no second AppState listener — the existing sync lifecycle carries it', () => {
    // Foreground resume and network reconnect already run
    // useSync → syncNow → api(), and every 401 there rings the bus.
    expect(code(gate)).not.toContain('AppState');
    expect(code(gate)).not.toContain('addEventListener');
  });
});

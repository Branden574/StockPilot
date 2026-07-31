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

const rootLayout = read('../../app/_layout.tsx');
const drawer = read('../components/drawer-content.tsx');
const screen = read('../components/account-disabled-screen.tsx');
const authContext = read('./auth-context.tsx');
const apiSrc = read('./api.ts');
const gate = read('./use-account-gate.ts');

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

  it('hands the probe to the revocation listener so a disable is not reported as another device', () => {
    expect(rootLayout).toContain('onTargeted: accountGate.probeNow');
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

  it('renders the RETRYABLE screen for an unreadable status, never the disabled one', () => {
    expect(rootLayout).toContain("accountGate.state === 'unverified'");
    expect(rootLayout).toContain('<AccountStatusUnverifiedScreen');
    // The transient screen must not be reachable through the disabled branch.
    const unverifiedBranch = rootLayout.slice(
      rootLayout.indexOf("accountGate.state === 'unverified'"),
    );
    expect(unverifiedBranch).not.toContain('AccountDisabledScreen');
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

  it('does not tell an unverified user to contact their administrator', () => {
    const transient = screen.slice(screen.indexOf('export function AccountStatusUnverifiedScreen'));
    expect(transient).not.toContain('ACCOUNT_DISABLED_MESSAGE');
    expect(transient).not.toContain('ACCOUNT_DISABLED_TITLE');
    expect(transient).toContain('try again');
  });
});

describe('the paths that can raise the gate', () => {
  it('sign-in trusts the structured code only, and answers with the shared copy', () => {
    expect(authContext).toContain("(error as { code?: string }).code === 'user_banned'");
    expect(authContext).toContain('setAccountDisabled(true)');
    expect(authContext).toContain('return { error: ACCOUNT_DISABLED_MESSAGE };');
  });

  it('cold launch probes the restored session and cannot log a working user out', () => {
    expect(authContext).toContain('.getUser()');
    expect(authContext).toContain('.catch(() => null)');
    expect(authContext).toContain('nextGateForProbe(getAccountGateState(), classifyAuthProbe(probe))');
  });

  it('never AWAITS the cold-launch probe — the hydrate path owns `loading`', () => {
    // RN fetch has no timeout. An awaited probe against a captive portal would
    // hold loading=true forever and render a blank shell with no recovery but
    // force-quit — the exact failure the hydrate path's fail-closed guard was
    // written for.
    expect(authContext).toContain('void supabase.auth');
    expect(authContext).not.toContain('await supabase.auth.getUser()');
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

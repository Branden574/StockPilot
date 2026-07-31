import type { Session, User } from '@supabase/supabase-js';
import * as React from 'react';

import { classifyAuthProbe } from './account-disabled-probe';
import {
  getAccountGateState,
  setAccountDisabled,
  setAccountGateState,
} from './account-disabled-state';
import { settleProbeResult } from './account-eviction';
import {
  enableBiometricForUser,
  isBiometricEnabledForUser,
  promptBiometric,
  setBiometricEnabledForUser,
} from './biometric';
import { wipeForSignOut } from './db';
import { supabase } from './supabase';

import { ACCOUNT_DISABLED_MESSAGE } from '@stockpilot/core';

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  /**
   * True when a valid Supabase session exists on disk but the user
   * has not yet passed the biometric prompt this app launch. RootGate
   * renders the lock screen instead of the normal app while this is
   * true. Cleared once the user passes the biometric prompt or signs
   * out to fall back to email/password.
   */
  locked: boolean;
  /** True iff the currently-signed-in user has previously opted in. */
  biometricEnabled: boolean;
  /**
   * True when the user has authenticated with password (AAL1) but holds a
   * verified TOTP factor and must still enter a 6-digit code to reach AAL2.
   * RootGate renders the MFA challenge screen while this is true. Mirrors
   * the web app's /signin/mfa step — without it the mobile app would let a
   * 2FA-enrolled user in on password alone.
   */
  mfaRequired: boolean;
  /**
   * Submit a 6-digit TOTP code to complete the AAL1→AAL2 challenge.
   * Returns an error string on an invalid/expired code.
   */
  verifyMfa: (code: string) => Promise<{ error?: string }>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  /**
   * Trigger the biometric prompt to unlock the app. Sets `locked=false`
   * on success. On failure, the lock screen exposes a "use password"
   * button which calls signOutToFallback() instead.
   */
  unlock: () => Promise<boolean>;
  /**
   * Clears the Supabase session locally so the sign-in screen appears.
   * Used when the user can't pass biometric and wants to fall back to
   * email/password. Does NOT revoke global tokens — other devices
   * remain signed in.
   */
  signOutToFallback: () => Promise<void>;
  enableBiometric: () => Promise<boolean>;
  disableBiometric: () => Promise<void>;
}

const AuthContext = React.createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [locked, setLocked] = React.useState(false);
  const [biometricEnabled, setBiometricEnabledState] = React.useState(false);
  const [mfaRequired, setMfaRequired] = React.useState(false);
  const mfaFactorId = React.useRef<string | null>(null);

  // Resolves whether the current session is stuck at AAL1 with a verified
  // TOTP factor (i.e. a 2FA challenge is owed). Supabase encodes AAL in the
  // JWT, so a session that already reached AAL2 — including one restored
  // from disk — reports currentLevel='aal2' and needs no challenge.
  const checkMfa = React.useCallback(async () => {
    try {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.currentLevel === 'aal1' && aal?.nextLevel === 'aal2') {
        const { data: factors } = await supabase.auth.mfa.listFactors();
        const verified = factors?.totp?.[0] ?? null;
        if (verified) {
          mfaFactorId.current = verified.id;
          setMfaRequired(true);
          return;
        }
      }
      mfaFactorId.current = null;
      setMfaRequired(false);
    } catch (e) {
      console.warn('[auth] MFA level check failed', e);
      mfaFactorId.current = null;
      setMfaRequired(false);
    }
  }, []);

  // On first mount, hydrate the session from SecureStore (Supabase
  // does this internally) AND check whether the resulting user has
  // opted into biometric. If they have, set locked=true so the lock
  // screen renders before any app surface shows. If they haven't
  // (or there's no session), proceed normally.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      // CRITICAL: this hydrate path must ALWAYS clear `loading`, even on
      // failure. supabase.auth.getSession() and isBiometricEnabledForUser()
      // both read expo-secure-store (Keychain), which can REJECT — e.g. a
      // cold/background launch while the device is still locked, or a
      // corrupted/undecryptable entry after an iCloud restore-from-backup.
      // Without this guard a rejection would leave loading=true forever and
      // RootGate would render a blank <Stack> with no recovery but force-quit.
      // Fail CLOSED: treat any failure as "no session" → the sign-in screen.
      try {
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        const s = data.session;
        setSession(s);
        if (s?.user) {
          // COLD LAUNCH / SESSION RESTORE probe. getSession() only reads the
          // Keychain, so a session belonging to an account disabled while this
          // device was closed hydrates perfectly happily. This is the moment to
          // ask GoTrue the question.
          //
          // DETACHED ON PURPOSE — never awaited. This whole hydrate path owns
          // `loading`, and RN's fetch has no timeout: a captive portal that
          // accepts the connection and never answers would otherwise hold
          // loading=true forever and render a blank shell with no recovery but
          // force-quit. The gate is subscribable, so RootGate reacts whenever
          // the answer lands. A rejection classifies as 'unknown' and changes
          // NOTHING — an offline device must keep working.
          //
          // On a RELAUNCH after a platform disable this answers 'signed-out',
          // never 'disabled': the disable revoked the session before the app
          // was ever reopened, so GoTrue can only say `session_not_found`.
          // settleProbeResult drops the dead session and marks the destination
          // as sign-in, where the password grant finally gets `user_banned` and
          // the disabled copy. One extra step, and it is the honest one — the
          // device genuinely cannot tell a disable from a sign-out here.
          void supabase.auth
            .getUser()
            .catch(() => null)
            .then(async (probe) => {
              if (cancelled) return;
              const nextGate = await settleProbeResult(
                getAccountGateState(),
                classifyAuthProbe(probe),
                async () => {
                  await supabase.auth.signOut({ scope: 'local' });
                },
              );
              if (cancelled) return;
              if (nextGate) setAccountGateState(nextGate);
            });

          let enabled = false;
          try {
            enabled = await isBiometricEnabledForUser(s.user.id);
          } catch (e) {
            console.warn('[auth] biometric-enabled check failed', e);
            enabled = false;
          }
          if (cancelled) return;
          setBiometricEnabledState(enabled);
          setLocked(enabled);
          // A restored session may still owe an AAL2 challenge if it was
          // only ever AAL1 on disk. Check before exposing the app.
          // (checkMfa is already internally try/caught.)
          await checkMfa();
          if (cancelled) return;
        }
      } catch (e) {
        console.warn('[auth] session hydrate failed — falling back to sign-in', e);
        if (!cancelled) {
          setSession(null);
          setLocked(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, s) => {
      setSession(s);
      // When the user signs out (event = SIGNED_OUT), drop locked +
      // the biometricEnabled UI flag so the sign-in screen renders
      // immediately. The actual SecureStore opt-in flag for that
      // user is left intact so if THEY sign back in, biometric is
      // still on for them.
      if (event === 'SIGNED_OUT' || !s?.user) {
        // Deliberately does NOT clear the account gate. The eviction's own
        // local sign-out fires SIGNED_OUT, so clearing it here would unmount
        // the disabled screen the instant it appeared and hand the user back
        // to sign-in — the session-restoration loop this gate exists to
        // prevent. Only AccountDisabledScreen's own "Sign out" clears it.
        setLocked(false);
        setBiometricEnabledState(false);
        setMfaRequired(false);
        mfaFactorId.current = null;
        return;
      }
      // When the user signs IN (event = SIGNED_IN), check whether
      // biometric is enabled for them. If so, lock immediately so
      // a session restored from refresh-token doesn't briefly expose
      // the app before we prompt.
      if (event === 'SIGNED_IN') {
        const enabled = await isBiometricEnabledForUser(s.user.id);
        setBiometricEnabledState(enabled);
        // Don't lock on a fresh interactive sign-in — they just
        // proved who they are with email/password. Only lock when
        // the session was restored from disk (handled in the mount
        // effect above).
      }
      // MFA_CHALLENGE_VERIFIED fires after a successful verify() and
      // upgrades the session to AAL2 — clear the gate. Any other
      // auth event re-checks the level.
      if (event === 'MFA_CHALLENGE_VERIFIED') {
        setMfaRequired(false);
        mfaFactorId.current = null;
      }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn: AuthState['signIn'] = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      // GoTrue answers a disabled account with the STRUCTURED code
      // `user_banned`. Never infer it from free text — GoTrue's own sentence
      // is not ours, changes between releases, and would leak a reason we
      // deliberately do not reveal. Raising the gate here is what makes the
      // disabled screen reachable from a rejected sign-in, where there is no
      // session for any other path to work from.
      if ((error as { code?: string }).code === 'user_banned') {
        setAccountDisabled(true);
        return { error: ACCOUNT_DISABLED_MESSAGE };
      }
      return { error: error.message };
    }
    // Password got us to AAL1. If the account has a verified TOTP factor,
    // raise the MFA gate so RootGate shows the code screen instead of the
    // app. Without this a 2FA-enrolled user would be let in on password
    // alone — the bug being fixed.
    await checkMfa();
    return {};
  };

  const verifyMfa: AuthState['verifyMfa'] = async (code) => {
    const factorId = mfaFactorId.current;
    if (!factorId) return { error: 'No pending two-factor challenge.' };
    const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
      factorId,
    });
    if (challengeErr || !challenge) {
      return { error: challengeErr?.message ?? 'Could not start the challenge. Try again.' };
    }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code: code.trim(),
    });
    if (verifyErr) {
      return { error: verifyErr.message };
    }
    // verify() upgrades the session to AAL2 and emits
    // MFA_CHALLENGE_VERIFIED (handled in onAuthStateChange), but clear the
    // gate here too so the UI updates immediately.
    mfaFactorId.current = null;
    setMfaRequired(false);
    return {};
  };

  const signOut: AuthState['signOut'] = async () => {
    // Global scope revokes every refresh token for the user — kills
    // sessions on the web tabs + any other devices. Mirrors the
    // server action's behavior in apps/web/src/server/actions/auth.ts.
    await supabase.auth.signOut({ scope: 'global' });
    try {
      await wipeForSignOut();
    } catch (err) {
      console.warn('[auth] wipe-on-signout failed', err);
    }
  };

  const signOutToFallback: AuthState['signOutToFallback'] = async () => {
    // Local-only sign-out: clears the on-device session so the
    // sign-in screen renders, but does NOT revoke the user's other
    // sessions (web, other phone). Used when the user fails the
    // biometric prompt and wants to re-authenticate with password
    // on this device only.
    await supabase.auth.signOut({ scope: 'local' });
    setLocked(false);
    setMfaRequired(false);
    mfaFactorId.current = null;
  };

  const unlock: AuthState['unlock'] = async () => {
    const ok = await promptBiometric('Unlock StockPilot');
    if (ok) setLocked(false);
    return ok;
  };

  const enableBiometric: AuthState['enableBiometric'] = async () => {
    if (!session?.user) return false;
    const ok = await enableBiometricForUser(session.user.id);
    if (ok) setBiometricEnabledState(true);
    return ok;
  };

  const disableBiometric: AuthState['disableBiometric'] = async () => {
    if (!session?.user) return;
    await setBiometricEnabledForUser(session.user.id, false);
    setBiometricEnabledState(false);
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        loading,
        locked,
        biometricEnabled,
        mfaRequired,
        verifyMfa,
        signIn,
        signOut,
        unlock,
        signOutToFallback,
        enableBiometric,
        disableBiometric,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

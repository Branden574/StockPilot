import type { Session, User } from '@supabase/supabase-js';
import * as React from 'react';

import {
  getAccountGateState,
  resetAccountDisabled,
  setAccountDisabled,
  setAccountGateState,
} from './account-disabled-state';
import {
  clearSessionEnded,
  isInvoluntarySessionEnd,
  markSessionEnded,
  probeAndSettle,
} from './account-eviction';
import {
  enableBiometricForUser,
  isBiometricEnabledForUser,
  promptBiometric,
  setBiometricEnabledForUser,
} from './biometric';
import { wipeForSignOut } from './db';
import {
  getRememberedIdentity,
  matchesRememberedIdentity,
  normalizeIdentityEmail,
  rememberIdentity,
} from './remembered-identity';
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
          // probeAndSettle drops the dead session and routes to sign-in, where
          // the password grant finally gets `user_banned` and the disabled
          // copy. One extra step, and it is the honest one — the device
          // genuinely cannot tell a disable from a sign-out here.
          //
          // probeAndSettle, not a bare getUser().then(...): gotrue-js drops a
          // dead session from INSIDE getUser(), so RootGate's redirect has
          // already picked a destination by the time any `.then()` of ours
          // runs. It stakes sign-in up front and withdraws it if the account
          // turns out to be fine.
          void probeAndSettle(
            getAccountGateState(),
            () => supabase.auth.getUser(),
            async () => {
              await supabase.auth.signOut({ scope: 'local' });
            },
          ).then(({ gate }) => {
            if (cancelled || !gate) return;
            setAccountGateState(gate);
          });

          // Refresh this device's memory of who holds a session on it — the
          // sign-in path's user_banned rejection compares a later typed
          // address against exactly this record (see remembered-identity.ts).
          // Fire-and-forget: never rejects, and must not hold up `loading`
          // any more than the probe above does.
          void rememberIdentity({
            userId: s.user.id,
            email: s.user.email ? normalizeIdentityEmail(s.user.email) : null,
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
        // A SIGNED_OUT this app did not ask for means the session was taken
        // away — and on a RELAUNCH that is the only trace left of it. auth-js
        // validates the stored session inside its own initialize(), and a
        // revoked one is dropped there, BEFORE our getSession() returns: the
        // hydrate below then sees no session at all, never probes, and the
        // device looks exactly like one that launched signed out. Verified on
        // the simulator — the cold-launch probe never ran.
        //
        // So a SIGNED_OUT is treated as involuntary: land on sign-in, where the
        // password grant is the one call that can still learn the truth. The two
        // DELIBERATE exits (signOut, signOutToFallback) clear it again, so a
        // user who chose to leave still gets the marketing screen.
        //
        // ONLY on SIGNED_OUT, though. auth-js hands every new subscriber an
        // INITIAL_SESSION event, with a null session on a device that has never
        // signed in — so latching on `!s?.user` fired on a FRESH INSTALL and
        // made /(auth)/welcome unreachable at launch for every first-run user.
        // isInvoluntarySessionEnd draws that line; the branch below still
        // resets the lock/MFA UI for any null-session event.
        if (isInvoluntarySessionEnd(event, Boolean(s?.user))) markSessionEnded();
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
      //
      // ATTRIBUTED 'sign-in', and that is the whole point. This answer is about
      // an EMAIL SOMEBODY TYPED, not about this device: GoTrue evaluates the
      // ban before the password, so any passer-by who knows one disabled
      // address gets it with any password at all. It may raise the screen; it
      // may NOT drive the eviction, which terminally rejects the offline outbox
      // — work that, after "Use password instead" on the biometric lock,
      // routinely belongs to a different and perfectly healthy user.
      if ((error as { code?: string }).code === 'user_banned') {
        // WHOSE verdict this is. GoTrue evaluates the ban BEFORE the
        // password, so this branch is reached by ANY typed password on a
        // disabled address — a passer-by who merely knows a colleague's email
        // gets here exactly as easily as the account's own owner. The
        // remembered identity (remembered-identity.ts) is this device's own
        // durable memory of who last held a session here, refreshed at every
        // hydrate and sign-out — it is what lets a device converge on
        // 'session' evidence HONESTLY instead of either extreme: trusting
        // every typed email (the original data-loss bug) or trusting none of
        // them (the over-correction this fix replaces). A relaunched device
        // whose own owner is retyping their own now-disabled password is
        // exactly the scenario use-account-gate.ts's design note describes as
        // "the ONE path that can still confirm a disable outright" — this is
        // what lets that path earn the eviction rather than only the screen.
        const remembered = await getRememberedIdentity();
        if (matchesRememberedIdentity(email, remembered)) {
          // This device has held a session for this exact address before —
          // the disable it is hearing about is its own. Full eviction:
          // the outbox is terminally rejected and the cache is wiped
          // (use-account-gate.ts).
          setAccountDisabled(true, 'session');
        } else {
          // ATTRIBUTED 'sign-in', and that is the whole point. It may raise
          // the screen; it may NOT drive the eviction, which terminally
          // rejects the offline outbox — work that, after "Use password
          // instead" on the biometric lock, routinely belongs to a different
          // and perfectly healthy user.
          setAccountDisabled(true, 'sign-in');
        }
        return { error: ACCOUNT_DISABLED_MESSAGE };
      }
      return { error: error.message };
    }
    // A password grant that SUCCEEDED is proof the account is not banned —
    // GoTrue refuses a banned user before it ever checks the password. So this
    // is the moment a gate raised by someone else's rejected attempt (or by an
    // identity-server blip) is demonstrably stale and must come down, or the
    // healthy user who just signed in would meet the disabled screen.
    resetAccountDisabled();
    // Refresh this device's remembered identity. Deliberately email-only here
    // (userId left null) — the fuller record with userId is written at every
    // hydrate/sign-out, which already has the full user object in hand; this
    // path only has to guarantee the email is current, and the email is the
    // only field the match above ever reads (see remembered-identity.ts).
    await rememberIdentity({ userId: null, email: normalizeIdentityEmail(email) });
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
    // Refresh this device's remembered identity BEFORE the session goes —
    // this is a deliberate exit, but the record must stay current for
    // whoever this device confirms a disable for next (remembered-identity.ts).
    if (session?.user) {
      await rememberIdentity({
        userId: session.user.id,
        email: session.user.email ? normalizeIdentityEmail(session.user.email) : null,
      });
    }
    // Global scope revokes every refresh token for the user — kills
    // sessions on the web tabs + any other devices. Mirrors the
    // server action's behavior in apps/web/src/server/actions/auth.ts.
    await supabase.auth.signOut({ scope: 'global' });
    // DELIBERATE: the marker raised by the SIGNED_OUT above is withdrawn, so a
    // user who chose to leave lands on the marketing screen, not sign-in.
    clearSessionEnded();
    try {
      await wipeForSignOut();
    } catch (err) {
      console.warn('[auth] wipe-on-signout failed', err);
    }
  };

  const signOutToFallback: AuthState['signOutToFallback'] = async () => {
    // Same reasoning as signOut above: keep the remembered identity current
    // for whoever retypes a password on this device next.
    if (session?.user) {
      await rememberIdentity({
        userId: session.user.id,
        email: session.user.email ? normalizeIdentityEmail(session.user.email) : null,
      });
    }
    // Local-only sign-out: clears the on-device session so the
    // sign-in screen renders, but does NOT revoke the user's other
    // sessions (web, other phone). Used when the user fails the
    // biometric prompt and wants to re-authenticate with password
    // on this device only.
    await supabase.auth.signOut({ scope: 'local' });
    // DELIBERATE, same as signOut above.
    clearSessionEnded();
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

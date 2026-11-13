import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session, User } from '@supabase/supabase-js';
import * as React from 'react';
import { Alert, AppState, type AppStateStatus } from 'react-native';

import {
  getAccountGateState,
  resetAccountDisabled,
  setAccountDisabled,
  setAccountGateState,
} from './account-disabled-state';
import {
  accountScopedStorageKeys,
  clearSessionEnded,
  isInvoluntarySessionEnd,
  markSessionEnded,
  probeAndSettle,
  PROBE_TIMEOUT_MS,
  withTimeout,
} from './account-eviction';
import {
  enableBiometricForUser,
  isBiometricEnabledForUser,
  promptBiometric,
  setBiometricEnabledForUser,
} from './biometric';
import { totalPendingCount } from './cycle-count-cache';
import { cycleCountSync } from './cycle-count-sync';
import { wipeForSignOut } from './db';
import { codeGateUp, verifiedTotpFactorId } from './mfa-level';
import {
  createStepUpReconciler,
  handOverLiveUser,
  setLiveUserHandler,
  setStepUpForcedFor,
  stepUpForcedFor,
  subscribeStepUpForced,
} from './mfa-reconcile';
import { wipeWithPhotoCaches } from './photo-cache-wipe';
import { adoptLegacyRows, discardUnsyncedFor } from './queue';
import {
  getRememberedIdentity,
  matchesRememberedIdentity,
  normalizeIdentityEmail,
  rememberIdentity,
} from './remembered-identity';
import { sendSignedInNote, sendSignedOutNote } from './auth-notes';
import { removeOrderCachesAtRest } from './order-storefront/caches-at-rest';
import { signOutOrderSubmissions } from './order-storefront/services';
import {
  clearDeliveredNotifications,
  deviceSignOutSteps,
  FALLBACK_UNBIND_TIMEOUT_MS,
  SIGN_OUT_UNBIND_TIMEOUT_MS,
} from './push-unbind';
import { hasStoredSession, liveOutboxScope } from './session-scope';
import {
  endSession,
  runSignOutFlow,
  STILL_SIGNED_IN_MESSAGE,
  STILL_SIGNED_IN_TITLE,
  unsyncedPrompt,
  type SignOutScope,
  type UnsyncedChoice,
} from './sign-out-flow';
import { supabase } from './supabase';
import { isOnline, syncNow } from './sync';

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
   * True while the session still owes its authenticator code: the account
   * has a verified factor and the session's token is not aal2. RootGate
   * renders the code screen instead of the app while this is true, and hands
   * nobody to the hooks that read or send the account's data. Mirrors the web
   * app's /signin/mfa step.
   *
   * Worked out from the session in the same render the session arrives in
   * (mfa-level.ts): no request decides it, so it holds offline, during the
   * cold-launch hydrate and at every token refresh.
   */
  mfaRequired: boolean;
  /**
   * Submit a 6-digit TOTP code to complete the AAL1→AAL2 challenge.
   * Returns an error string on an invalid/expired code.
   */
  verifyMfa: (code: string) => Promise<{ error?: string }>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  /**
   * The deliberate sign-out (drawer, Settings). Tries to send unsynced work
   * first and asks before leaving any behind (sign-out-flow.ts). Call it with
   * no argument from a button: `onPress={() => void signOut()}`.
   * `afterAccountDeleted` skips the question and discards the account's queued
   * work, which can never be sent.
   */
  signOut: (opts?: { afterAccountDeleted?: boolean }) => Promise<void>;
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
   * remain signed in. Resolves true once the session is actually gone; false
   * when it survived (offline), in which case nothing was unlocked.
   */
  signOutToFallback: () => Promise<boolean>;
  enableBiometric: () => Promise<boolean>;
  disableBiometric: () => Promise<void>;
}

const AuthContext = React.createContext<AuthState | null>(null);

/** The code screen's sentence when the server cannot be asked which factor the code is for. */
const MFA_CANNOT_CHECK_COPY =
  'Could not reach StockPilot to check your authenticator. Check your connection and try again.';
/** The code screen's sentence when the account lists no authenticator app to answer for. */
const MFA_NO_AUTHENTICATOR_COPY =
  'This account has no authenticator app code to enter on this phone. Try again in a moment, or sign in on the web.';

/**
 * The user as the server lists it now, or null when it cannot be read: an
 * error, no answer within PROBE_TIMEOUT_MS (RN's fetch has no timeout of its
 * own), or a rejection. A promise chain on purpose, like the probes below:
 * nothing that owns `loading` ever waits on it.
 */
function readLiveUser(): Promise<User | null> {
  return withTimeout(
    supabase.auth.getUser().then(({ data, error }) => (error ? null : (data.user ?? null))),
    PROBE_TIMEOUT_MS,
    null,
  );
}

/**
 * Brings the code gate in step with the server's own factor list
 * (mfa-reconcile.ts). The session it compares is the one auth-js holds; the
 * refresh is bounded, and a refresh that fails or does not answer never
 * lowers the gate.
 */
const reconcileCodeGate = createStepUpReconciler({
  currentSession: () =>
    supabase.auth.getSession().then(
      ({ data }) => data.session,
      () => null,
    ),
  refreshSession: () =>
    withTimeout(
      supabase.auth.refreshSession().then(({ data, error }) => (error ? null : data.session)),
      PROBE_TIMEOUT_MS,
      null,
    ),
});

/** GoTrue's structured answer for a factor that no longer exists. */
function isFactorGone(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'mfa_factor_not_found';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [locked, setLocked] = React.useState(false);
  const [biometricEnabled, setBiometricEnabledState] = React.useState(false);

  // THE CODE GATE, worked out in render from the session itself (docket
  // S43b; mfa-level.ts). The token's own level and the factors the session's
  // user carries decide it, so it is true in the very render a session that
  // owes its code arrives in: at the cold-launch hydrate, at SIGNED_IN, at a
  // token refresh, online or not. No request is waited on and none can lower
  // it by failing. `stepUpForced` is the one addition: the account the
  // server's own factor list said owes a code while the session's copy could
  // not be brought up to date (mfa-reconcile.ts).
  const stepUpForced = React.useSyncExternalStore(subscribeStepUpForced, stepUpForcedFor);
  const mfaRequired = codeGateUp(session, stepUpForced);

  // A user the account gate's probe reads from the server (use-account-gate.ts)
  // is handed here, so an authenticator turned on or removed elsewhere reaches
  // the gate at the next probe. Registered before the hydrate below starts its
  // own probe.
  React.useEffect(() => {
    setLiveUserHandler((user) => {
      void reconcileCodeGate(user);
    });
    return () => setLiveUserHandler(null);
  }, []);

  // The two edges of the gate.
  //   UP: ask the server for the account's factors once, detached and bounded.
  //   A session whose copy lists a factor that was since removed (a reset, a
  //   recovery code) would otherwise show a code screen nobody can answer
  //   until its next token refresh.
  //   DOWN, with a session: the code was entered (or the gate was reconciled
  //   away), so the count outbox, held while the code was owed
  //   (outbox-scope.ts), gets a pass now instead of at its next 60 s
  //   heartbeat. The other outbox drains when RootGate hands useSync its user.
  const gateUserId = session?.user?.id ?? null;
  const gateWasUp = React.useRef(false);
  React.useEffect(() => {
    if (mfaRequired) {
      if (gateWasUp.current) return;
      gateWasUp.current = true;
      void readLiveUser().then((user) => (user ? reconcileCodeGate(user) : null));
      return;
    }
    if (!gateWasUp.current) return;
    gateWasUp.current = false;
    if (gateUserId) void cycleCountSync.forceSync().catch(() => undefined);
  }, [mfaRequired, gateUserId]);

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
          //
          // The user it reads is handed to the code gate's reconcile on the
          // way through (handOverLiveUser, mfa-reconcile.ts).
          void probeAndSettle(
            getAccountGateState(),
            () => supabase.auth.getUser().then(handOverLiveUser),
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
          // A restored session that still owes its code needs no check here:
          // the gate is worked out from the session set above, and RootGate
          // has shown the code screen since that render.
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
        // The session was taken away, so the deliberate sign-out's storage
        // cleanup never ran: the order catalog and the photo map (signed
        // URLs) are removed here; the workspace, prefs and carts stay (L137).
        const involuntary = isInvoluntarySessionEnd(event, Boolean(s?.user));
        if (involuntary) markSessionEnded();
        if (involuntary) void removeOrderCachesAtRest(AsyncStorage);
        // Deliberately does NOT clear the account gate. The eviction's own
        // local sign-out fires SIGNED_OUT, so clearing it here would unmount
        // the disabled screen the instant it appeared and hand the user back
        // to sign-in — the session-restoration loop this gate exists to
        // prevent. Only AccountDisabledScreen's own "Sign out" clears it.
        setLocked(false);
        setBiometricEnabledState(false);
        // No session owes a code: the gate reads the session, and the note
        // about the account that just left goes with it.
        setStepUpForcedFor(null);
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
      // MFA_CHALLENGE_VERIFIED fires after a successful verify() with the
      // aal2 session, set above: the gate comes down in that same render. Every
      // other event's session is read the same way, so none needs a re-check.
      // The code was entered, so nothing noted about this account is owed.
      if (event === 'MFA_CHALLENGE_VERIFIED') {
        setStepUpForcedFor(null);
      }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  // IDENTITY REFRESH ON FOREGROUND. A verified email change completed on the
  // web (mig 0345) changes auth.users.email immediately, but the session user
  // persisted on this phone keeps the OLD address until the next token refresh
  // — up to an hour — and no USER_UPDATED event ever fires here for a change
  // this client did not make. Ask GoTrue when the app comes to the foreground;
  // if the addresses differ, pull a fresh session (TOKEN_REFRESHED → setSession
  // above) and drop the cached profile. Offline or failed → change nothing.
  //
  // The same answer carries the account's factors, so it is handed to the
  // code gate's reconcile (mfa-reconcile.ts): an authenticator turned on on
  // the web while this phone is signed in brings the code screen up at the
  // next return to the app, and one removed brings it down.
  React.useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      if (state !== 'active') return;
      // Detached promise chain, never awaited (the same discipline as the
      // cold-launch probe): RN fetch has no timeout, so nothing that owns UI
      // state may wait on this network call.
      void supabase.auth
        .getSession()
        .then(({ data: sess }) => {
          if (!sess.session) return null;
          const current = sess.session.user?.email;
          return supabase.auth.getUser().then(async ({ data, error }) => {
            const liveUser = data.user;
            if (error || !liveUser) return null;
            const live = liveUser.email;
            if (current && live && live.toLowerCase() !== current.toLowerCase()) {
              // The profile cache is keyed by id AND email (use-profile.ts), so
              // the refreshed session user misses it and refetches on its own.
              await supabase.auth.refreshSession();
            }
            // After the address refresh, which brings the factors too: the
            // reconcile then finds nothing left to do, or tries again if that
            // refresh failed.
            return reconcileCodeGate(liveUser);
          });
        })
        .catch(() => {
          // best-effort — an offline device keeps its last known identity
        });
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, []);

  const signIn: AuthState['signIn'] = async (email, password) => {
    const { data: signedIn, error } = await supabase.auth.signInWithPassword({ email, password });
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
    // Refresh this device's remembered identity. The email is the only field
    // the match above ever reads (see remembered-identity.ts). The account id
    // is recorded too when the grant returned it: a disable confirmed later
    // from the sign-in screen evicts only THAT account's queued work, and after
    // a relaunch this record is the one place its id is still known
    // (use-account-gate.ts evictedAccountId).
    await rememberIdentity({
      userId: signedIn.user?.id ?? null,
      email: normalizeIdentityEmail(email),
    });
    // The sign-in reaches the server (S5): the Audit log row, and the
    // new-device email for a phone the account has not used before. Here, on
    // the password step, before the code, where the web notes a device too:
    // a stolen password used on a new phone still alerts the owner. Detached
    // and bounded (auth-notes.ts): it never holds the sign-in.
    void sendSignedInNote();
    // Password got us to AAL1. For an account with a verified factor the
    // session the grant just stored says so itself, and RootGate has shown
    // the code screen since SIGNED_IN: nothing is read or waited on here.
    return {};
  };

  const verifyMfa: AuthState['verifyMfa'] = async (code) => {
    // Which factor the code is for: the session's own copy of the user first.
    // When that lists none (the gate is up on the server's word,
    // mfa-reconcile.ts), the server's list is asked, bounded.
    let factorId = verifiedTotpFactorId(session?.user);
    if (!factorId) {
      const live = await readLiveUser();
      if (!live) return { error: MFA_CANNOT_CHECK_COPY };
      factorId = verifiedTotpFactorId(live);
      if (!factorId) {
        // Nothing to answer for. The reconcile settles the gate: it comes
        // down only through a session the server issues.
        void reconcileCodeGate(live);
        return { error: MFA_NO_AUTHENTICATOR_COPY };
      }
    }
    // A factor the server no longer has (removed on the web since this
    // session was stored): the code can never be accepted, so the server's
    // list is read again and the gate reconciled.
    const reconcileIfFactorGone = (error: unknown) => {
      if (!isFactorGone(error)) return;
      void readLiveUser().then((user) => (user ? reconcileCodeGate(user) : null));
    };
    const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
      factorId,
    });
    if (challengeErr || !challenge) {
      reconcileIfFactorGone(challengeErr);
      return { error: challengeErr?.message ?? 'Could not start the challenge. Try again.' };
    }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code: code.trim(),
    });
    if (verifyErr) {
      reconcileIfFactorGone(verifyErr);
      return { error: verifyErr.message };
    }
    // verify() stored the aal2 session and emitted MFA_CHALLENGE_VERIFIED
    // before it returned (handled in onAuthStateChange): the gate reads that
    // session and is already down.
    return {};
  };

  // A second tap while the first sign-out is still draining or asking.
  const signingOut = React.useRef(false);

  const signOut: AuthState['signOut'] = async (opts) => {
    if (signingOut.current) return;
    signingOut.current = true;
    const afterAccountDeleted = opts?.afterAccountDeleted === true;
    // This phone's own steps (S5, push-unbind.ts): while the session still
    // exists, hold push registration, delete this phone's push token row and
    // tell the server (the Audit log row, and the account's other devices
    // signed out at once); once the session's end is decided, release the
    // hold, registering again if the session survived.
    const deviceSteps = deviceSignOutSteps({
      user: session?.user ?? null,
      unbindTimeoutMs: SIGN_OUT_UNBIND_TIMEOUT_MS,
      note: sendSignedOutNote,
    });
    try {
      // Refresh this device's remembered identity BEFORE the session goes —
      // this is a deliberate exit, but the record must stay current for
      // whoever this device confirms a disable for next (remembered-identity.ts).
      if (session?.user) {
        await rememberIdentity({
          userId: session.user.id,
          email: session.user.email ? normalizeIdentityEmail(session.user.email) : null,
        });
      }
      // Whose queued work this is, read while the session still exists.
      const scope = await liveOutboxScope();
      const userId = scope.userId ?? session?.user?.id ?? null;
      const outcome = await runSignOutFlow(
        {
          countUnsynced: () => totalPendingCount(),
          isOnline,
          // Both drains: syncNow runs engine 1 (behind its single-flight
          // guard), forceSync engine 2 (after any drain already running).
          drain: async () => {
            await syncNow();
            await cycleCountSync.forceSync();
          },
          confirmUnsynced: askAboutUnsynced,
          // Order requests sent but not confirmed (phone ordering PO-4): their
          // status is read first, and any still unknown are asked about and
          // held by key (no personal data) for this account's next sign-in.
          orderSubmissions: userId ? signOutOrderSubmissions(userId) : undefined,
          holdForAccount: async () => {
            if (userId) await adoptLegacyRows({ userId, orgId: scope.orgId });
          },
          signOut: signOutDeliberately,
          hasSession: hasStoredSession,
          discardUnsynced: async () => {
            if (userId) await discardUnsyncedFor(userId);
          },
          // The cache only: the outbox stays, held for this account. The
          // photos this account saw go with it, even when the SQLite wipe
          // fails (photo-cache-wipe.ts).
          wipeCache: () => wipeWithPhotoCaches(wipeForSignOut),
          // The saved workspace belongs to this account, not the device: the
          // same keys an eviction removes (use-account-gate.ts).
          clearAccountStorage: async () => {
            const keys = accountScopedStorageKeys(await AsyncStorage.getAllKeys());
            if (keys.length > 0) await AsyncStorage.multiRemove(keys);
          },
          // After an in-app account deletion there is nothing to unbind or
          // note: the account's token rows went with it.
          ...(afterAccountDeleted
            ? {}
            : {
                beforeSessionEnds: deviceSteps.beforeSessionEnds,
                afterSessionEnd: deviceSteps.afterSessionEnd,
              }),
          warn: (message, err) => console.warn(message, err),
        },
        { discardWithoutAsking: afterAccountDeleted },
      );
      // What Notification Center still shows of the account goes with it.
      if (outcome === 'signed-out') await clearDeliveredNotifications();
      if (outcome === 'still-signed-in') {
        Alert.alert(STILL_SIGNED_IN_TITLE, STILL_SIGNED_IN_MESSAGE);
      }
    } finally {
      // The backstop: a hold the flow did not release (a throw) never keeps
      // this phone from registering again.
      deviceSteps.release();
      signingOut.current = false;
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
    // This phone's push token row goes too (S5, push-unbind.ts), deleted
    // while the session still exists, with registration held until the
    // session's end is decided: whoever signs in next on this phone must not
    // get this account's notifications. No note to the server: this is not
    // the account signing out everywhere, and it writes no Audit log row.
    const deviceSteps = deviceSignOutSteps({
      user: session?.user ?? null,
      unbindTimeoutMs: FALLBACK_UNBIND_TIMEOUT_MS,
    });
    try {
      await deviceSteps.beforeSessionEnds();
      // Local-only sign-out: clears the on-device session so the
      // sign-in screen renders, but does NOT revoke the user's other
      // sessions (web, other phone). Used when the user fails the
      // biometric prompt and wants to re-authenticate with password
      // on this device only. The cache and the outbox are kept: the
      // next account's first pull resets a cache that is not its own
      // (sync.ts), and queued work stays held for this account.
      const ended = await endSession(
        {
          signOut: signOutDeliberately,
          hasSession: hasStoredSession,
          warn: (m, e) => console.warn(m, e),
        },
        'local',
      );
      // Released either way; a session that survived registers again.
      await deviceSteps.afterSessionEnd(ended);
      if (!ended) {
        // A LOCAL sign-out needs the network too (auth-js POSTs /logout and
        // keeps the session on a transport failure). Lifting the biometric
        // lock or the MFA gate now would open the app on a session that is
        // still here, without the biometric check or the second factor.
        // "Still here" is read from the STORED session (hasStoredSession):
        // getSession() answers null for a token it could not refresh offline
        // while the session stays on the device, which read as "ended" and
        // unlocked the app once the access token had expired.
        Alert.alert(STILL_SIGNED_IN_TITLE, STILL_SIGNED_IN_MESSAGE);
        return false;
      }
      // The session is gone, and the code gate reads the session: it is down.
      setLocked(false);
      return true;
    } finally {
      deviceSteps.release();
    }
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

/**
 * A deliberate sign-out call. On success the session is gone and the
 * SIGNED_OUT it fired latched "the session was taken away"; that marker is
 * withdrawn at once, so a user who chose to leave lands on the marketing
 * screen, not sign-in. On failure nothing was signed out, so nothing is
 * withdrawn.
 */
async function signOutDeliberately(scope: SignOutScope): Promise<{ error: unknown }> {
  const { error } = await supabase.auth.signOut({ scope });
  if (!error) clearSessionEnded();
  return { error };
}

/** The unsynced-work question, as an alert (sign-out-flow.ts owns the words). */
function askAboutUnsynced(
  count: number,
  opts: { canDiscard: boolean; unconfirmedOrders?: number },
): Promise<UnsyncedChoice> {
  const prompt = unsyncedPrompt(count, opts.canDiscard, opts.unconfirmedOrders ?? 0);
  return new Promise((resolve) => {
    Alert.alert(
      prompt.title,
      prompt.message,
      prompt.buttons.map((b) => ({
        text: b.label,
        style: b.style,
        onPress: () => resolve(b.choice),
      })),
      // Dismissing (Android back, tapping outside) is staying.
      { cancelable: true, onDismiss: () => resolve('stay') },
    );
  });
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

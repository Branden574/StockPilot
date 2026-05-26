import type { Session, User } from '@supabase/supabase-js';
import * as React from 'react';

import {
  enableBiometricForUser,
  isBiometricEnabledForUser,
  promptBiometric,
  setBiometricEnabledForUser,
} from './biometric';
import { wipeForSignOut } from './db';
import { supabase } from './supabase';

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
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (
    email: string,
    password: string,
    fullName: string,
  ) => Promise<{ error?: string; needsConfirm?: boolean }>;
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

  // On first mount, hydrate the session from SecureStore (Supabase
  // does this internally) AND check whether the resulting user has
  // opted into biometric. If they have, set locked=true so the lock
  // screen renders before any app surface shows. If they haven't
  // (or there's no session), proceed normally.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      const s = data.session;
      setSession(s);
      if (s?.user) {
        const enabled = await isBiometricEnabledForUser(s.user.id);
        if (cancelled) return;
        setBiometricEnabledState(enabled);
        setLocked(enabled);
      }
      setLoading(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, s) => {
      setSession(s);
      // When the user signs out (event = SIGNED_OUT), drop locked +
      // the biometricEnabled UI flag so the sign-in screen renders
      // immediately. The actual SecureStore opt-in flag for that
      // user is left intact so if THEY sign back in, biometric is
      // still on for them.
      if (event === 'SIGNED_OUT' || !s?.user) {
        setLocked(false);
        setBiometricEnabledState(false);
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
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn: AuthState['signIn'] = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return {};
  };

  const signUp: AuthState['signUp'] = async (email, password, fullName) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    if (error) return { error: error.message };
    return { needsConfirm: !data.session };
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
        signIn,
        signUp,
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

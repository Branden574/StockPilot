import { Lock, WifiOff } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { AuthShell } from '@/components/auth/auth-shell';
import { Body, Display, Mono } from '@/components/ui/text';
import { setAccountDisabled } from '@/lib/account-disabled-state';
import { useAuth } from '@/lib/auth-context';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

import { ACCOUNT_DISABLED_MESSAGE, ACCOUNT_DISABLED_TITLE } from '@stockpilot/core';

/**
 * Full-screen disabled state, rendered by RootGate as an early return in the
 * same slot as MfaChallengeScreen and BiometricLockScreen — and ABOVE both, so
 * a disabled account is never asked for a TOTP code it can never usefully
 * supply.
 *
 * Same copy as the web screen, from the same shared constants in
 * @stockpilot/core — never retyped. It reveals nothing: no reason, no actor, no
 * date. The only affordance is signing out, so the user can try a different
 * account.
 *
 * This screen is for a CONFIRMED disable only. A status the server could not
 * read renders AccountStatusUnverifiedScreen below instead, exactly as the web
 * guard throws rather than redirecting here.
 *
 * Sign out uses signOutToFallback (scope 'local'): a global sign-out would try
 * to reach GoTrue with a banned user's token, and this device is already
 * server-side revoked anyway — while the user's other devices are not ours to
 * cascade into.
 */
export function AccountDisabledScreen() {
  const { signOutToFallback } = useAuth();
  const { c } = useTheme();
  const [busy, setBusy] = React.useState(false);

  async function onSignOut() {
    if (busy) return;
    setBusy(true);
    // Clear the flag so a DIFFERENT account can sign in on this device without
    // being met by a stale disabled screen.
    setAccountDisabled(false);
    await signOutToFallback();
  }

  return (
    <AuthShell>
      <View style={styles.iconWrap}>
        <View style={[styles.iconRing, { borderColor: c.hair }]}>
          <Lock size={28} color={c.ink} strokeWidth={1.5} />
        </View>
      </View>

      <Display size={28} accessibilityRole="header">
        {ACCOUNT_DISABLED_TITLE}
      </Display>
      <Body muted style={styles.message}>
        {ACCOUNT_DISABLED_MESSAGE}
      </Body>

      <Pressable
        accessibilityRole="button"
        onPress={() => void onSignOut()}
        disabled={busy}
        style={({ pressed }) => [
          styles.action,
          {
            borderColor: c.hair,
            backgroundColor: c.card,
            opacity: busy ? 0.5 : pressed ? 0.8 : 1,
          },
        ]}
      >
        <Body size={15} style={{ fontFamily: FONT.display }}>
          Sign out
        </Body>
      </Pressable>
    </AuthShell>
  );
}

/**
 * The transient twin, and the reason it exists.
 *
 * On the web, an UNREADABLE account status throws
 * AccountStatusUnavailableError instead of redirecting to the disabled screen,
 * because the disabled copy is owner-approved wording about contacting an
 * administrator and it must never be shown to someone whose account is fine.
 * Mobile keeps the same distinction: only GoTrue's structured `user_banned`
 * reaches AccountDisabledScreen; an identity server that answered with its own
 * 5xx lands HERE, worded as transient and retryable.
 */
export function AccountStatusUnverifiedScreen({
  onRetry,
  busy = false,
}: {
  onRetry: () => void;
  busy?: boolean;
}) {
  const { c } = useTheme();

  return (
    <AuthShell>
      <View style={styles.iconWrap}>
        <View style={[styles.iconRing, { borderColor: c.hair }]}>
          <WifiOff size={28} color={c.ink} strokeWidth={1.5} />
        </View>
      </View>

      <Display size={28} accessibilityRole="header">
        Something went wrong
      </Display>
      <Body muted style={styles.message}>
        We could not check your account just now. This is usually temporary —
        try again in a moment.
      </Body>

      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        disabled={busy}
        style={({ pressed }) => [
          styles.action,
          {
            borderColor: c.ink,
            backgroundColor: c.ink,
            opacity: busy ? 0.5 : pressed ? 0.8 : 1,
          },
        ]}
      >
        {busy ? (
          <ActivityIndicator color={c.paper} />
        ) : (
          <Body size={15} color={c.paper} style={{ fontFamily: FONT.display }}>
            Try again
          </Body>
        )}
      </Pressable>

      <Mono size={12} tracking={0.04} color={ACCENT.mint} style={styles.reassure}>
        YOUR OFFLINE WORK IS SAFE
      </Mono>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  iconWrap: {
    alignItems: 'flex-start',
    marginBottom: 18,
  },
  iconRing: {
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 1.4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  message: {
    marginTop: 10,
    marginBottom: 24,
  },
  action: {
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  reassure: {
    marginTop: 18,
    alignSelf: 'center',
  },
});

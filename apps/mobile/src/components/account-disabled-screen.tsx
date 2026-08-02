import { Lock } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AuthShell } from '@/components/auth/auth-shell';
import { Body, Display } from '@/components/ui/text';
import { setAccountDisabled } from '@/lib/account-disabled-state';
import { useAuth } from '@/lib/auth-context';
import { FONT } from '@/lib/theme';
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
 * read renders NOTHING of this file's — see the note below for why there is
 * no transient twin any more (eb3c7e3c deleted the one that used to render
 * here for that case).
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
 * There is deliberately NO transient twin any more.
 *
 * An unreadable account status ('unverified') used to render a full-screen
 * "Something went wrong / Try again" here, mirroring the web guard's
 * AccountStatusUnavailableError. On a phone that was the wrong translation: a
 * GoTrue 5xx says nothing about the account, but the screen blocked the entire
 * app — including the SQLite cache and the offline outbox built to work without
 * a server — with no escape but going offline hard enough for the probe to
 * classify as 'unknown'. Its own footer read "YOUR OFFLINE WORK IS SAFE" while
 * denying access to it.
 *
 * The gate state survives and is now handled where it belongs: the app runs on
 * its cached session and useAccountGate re-probes in the background until the
 * identity server answers. Only a CONFIRMED disable renders a screen, and this
 * is that screen.
 */

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
});

import { ShieldCheck } from 'lucide-react-native';
import * as React from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { AuthShell } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';
import { Body, Display } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { useTheme } from '@/lib/use-theme';
import { webLink } from '@/lib/web-links';

import { AUTHENTICATOR_SET_UP_PAGE, PASSKEY_ONLY_NOTICE_COPY } from '@stockpilot/core';

/**
 * Shown by RootGate in place of the code screen when the session owes its
 * second step and every verified factor of the account is a passkey's bridge
 * (mfa-level.ts bridgeOnlyAccount). The phone cannot take a passkey yet, and
 * no code it could type would pass, so this says so plainly and offers the
 * website's security page (where an authenticator app is added, and where
 * recovery codes are used) and the way out to another account.
 *
 * It reads no gate state and checks no code: RootGate decided, and the gate
 * itself is unchanged (the data hooks are still handed nobody). Every word is
 * core's (PASSKEY_ONLY_NOTICE_COPY), and claims nothing about a passkey. The
 * Classic look of the code screen it stands in for: the shell, the shield in
 * its ring, the heading, the line, a block button and the borderless one.
 */
export function PasskeyOnlyNotice() {
  const { signOutToFallback } = useAuth();
  const { c } = useTheme();

  return (
    <AuthShell>
      <View style={styles.iconWrap}>
        <View style={[styles.iconRing, { borderColor: c.hair2 }]}>
          <ShieldCheck size={30} color={c.ink} strokeWidth={1.5} />
        </View>
      </View>

      <Display size={28} style={{ marginTop: 10 }} accessibilityRole="header">
        {PASSKEY_ONLY_NOTICE_COPY.title}
      </Display>
      <Body muted style={{ marginTop: 8, marginBottom: 22 }}>
        {PASSKEY_ONLY_NOTICE_COPY.body}
      </Body>

      <Button
        block
        wrap
        onPress={() => {
          Linking.openURL(webLink(AUTHENTICATOR_SET_UP_PAGE)).catch(() => undefined);
        }}
      >
        {PASSKEY_ONLY_NOTICE_COPY.openWebsite}
      </Button>

      <View style={styles.fallback}>
        <Button block wrap variant="ghost" onPress={() => void signOutToFallback()}>
          {PASSKEY_ONLY_NOTICE_COPY.differentAccount}
        </Button>
      </View>
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
  fallback: {
    marginTop: 8,
  },
});

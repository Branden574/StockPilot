import { ShieldCheck } from 'lucide-react-native';
import * as React from 'react';
import { AccessibilityInfo, Linking, StyleSheet, View } from 'react-native';

import { AuthShell } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';
import { Body, Display } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { useTheme } from '@/lib/use-theme';
import { webLink } from '@/lib/web-links';

import {
  AUTHENTICATOR_CHECK_RESULT_COPY,
  AUTHENTICATOR_SET_UP_PAGE,
  PASSKEY_ONLY_NOTICE_COPY,
} from '@stockpilot/core';

/**
 * Shown by RootGate in place of the code screen when the session owes its
 * second step and every verified factor of the account is a passkey's bridge
 * (mfa-level.ts bridgeOnlyAccount). The phone cannot take a passkey yet, and
 * no code it could type would pass, so this says so plainly and offers the
 * website's security page (where an authenticator app is added, and where
 * recovery codes are used), Check again, and the way out to another account.
 *
 * Check again (review 2-3 finding 10) reads the user only, the read the gate
 * makes when it comes up (the provider's recheckCodeGate: readLiveUser, then
 * the code gate's reconcile, mfa-reconcile.ts). Never the workspace or the
 * memberships (review B finding 2): the session still owes its second step,
 * so it is a password and nothing more. When the server lists an
 * authenticator app now, the session is refreshed and RootGate shows the code
 * screen in this one's place; a session the server ended (Auth ends a waiting
 * aal1 session when the member passes a second step elsewhere) goes back to
 * sign-in. Still here, a line says whether the server answered, and VoiceOver
 * says it too. The way out stays usable while a check runs.
 *
 * It reads no gate state and checks no code: RootGate decided, and the gate
 * itself is unchanged (the data hooks are still handed nobody). Every word is
 * core's (PASSKEY_ONLY_NOTICE_COPY, AUTHENTICATOR_CHECK_RESULT_COPY), and
 * claims nothing about a passkey. The Classic look of the code screen it
 * stands in for: the shell, the shield in its ring, the heading, the line, a
 * block button, an outline one and the borderless one.
 */
export function PasskeyOnlyNotice() {
  const { recheckCodeGate, signOutToFallback } = useAuth();
  const { c } = useTheme();

  const [checking, setChecking] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);

  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function checkAgain() {
    if (checking) return;
    setChecking(true);
    setResult(null);
    let answer: 'answered' | 'no_answer' = 'no_answer';
    try {
      answer = await recheckCodeGate();
    } catch {
      answer = 'no_answer';
    } finally {
      if (mounted.current) setChecking(false);
    }
    // Still here: the screen did not change. Say whether the server answered.
    if (!mounted.current) return;
    const line =
      answer === 'answered'
        ? AUTHENTICATOR_CHECK_RESULT_COPY.checked
        : AUTHENTICATOR_CHECK_RESULT_COPY.noAnswer;
    setResult(line);
    AccessibilityInfo.announceForAccessibility(line);
  }

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

      <View style={styles.next}>
        <Button block wrap variant="outline" onPress={() => void checkAgain()} disabled={checking}>
          {PASSKEY_ONLY_NOTICE_COPY.checkAgain}
        </Button>
      </View>
      {result ? (
        <Body size={13} style={styles.result} accessibilityLiveRegion="polite">
          {result}
        </Body>
      ) : null}

      <View style={styles.next}>
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
  next: {
    marginTop: 8,
  },
  result: {
    marginTop: 12,
  },
});

import { ShieldCheck } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { AuthShell } from '@/components/auth/auth-shell';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Full-screen TOTP (authenticator-app) challenge. Shown by RootGate when
 * the user is signed in at AAL1 but holds a verified factor — i.e. they
 * passed the password step and now owe the second factor. Mirrors the web
 * app's /signin/mfa step.
 *
 * "Use a different account" calls signOutToFallback so a user who lost
 * their authenticator can drop back to the sign-in screen (and recover
 * via the web app's recovery-code flow).
 */
export function MfaChallengeScreen() {
  const { verifyMfa, signOutToFallback } = useAuth();
  const { c } = useTheme();
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(value: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const { error: err } = await verifyMfa(value);
    if (err) {
      setError(err);
      setCode('');
      setBusy(false);
      return;
    }
    // Success: RootGate re-renders into the app once mfaRequired clears.
    setBusy(false);
  }

  function onChange(next: string) {
    const digits = next.replace(/[^0-9]/g, '').slice(0, 6);
    setCode(digits);
    if (error) setError(null);
    // Auto-submit once 6 digits are entered (matches authenticator UX).
    if (digits.length === 6) void submit(digits);
  }

  return (
    <AuthShell>
      <View style={styles.iconWrap}>
        <View style={[styles.iconRing, { borderColor: c.hair }]}>
          <ShieldCheck size={30} color={c.ink} strokeWidth={1.5} />
        </View>
      </View>

      <Eyebrow>TWO-FACTOR AUTHENTICATION</Eyebrow>
      <Display size={28} style={{ marginTop: 10 }}>
        Enter your <Em>code.</Em>
      </Display>
      <Body muted style={{ marginTop: 8, marginBottom: 22 }}>
        Open your authenticator app (Google Authenticator, 1Password, etc.)
        and enter the 6-digit code for StockPilot.
      </Body>

      <TextInput
        value={code}
        onChangeText={onChange}
        placeholder="123456"
        placeholderTextColor={c.ink4}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        autoFocus
        editable={!busy}
        maxLength={6}
        style={[
          styles.codeInput,
          { color: c.ink, borderColor: error ? ACCENT.crit : c.hair, backgroundColor: c.card },
        ]}
      />

      {error ? (
        <Mono size={12} tracking={0.02} color={ACCENT.crit} style={{ marginTop: 10 }}>
          {error}
        </Mono>
      ) : null}

      <Pressable
        onPress={() => void submit(code)}
        disabled={busy || code.length !== 6}
        style={({ pressed }) => [
          styles.verifyBtn,
          {
            backgroundColor: c.ink,
            opacity: busy || code.length !== 6 ? 0.5 : pressed ? 0.8 : 1,
          },
        ]}
      >
        {busy ? (
          <ActivityIndicator color={c.paper} />
        ) : (
          <Body size={15} color={c.paper} style={{ fontFamily: FONT.display }}>
            Verify
          </Body>
        )}
      </Pressable>

      <Pressable
        onPress={() => void signOutToFallback()}
        disabled={busy}
        style={({ pressed }) => [styles.fallback, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Mono size={12} tracking={0.04} color={c.ink3} style={{ fontFamily: FONT.display }}>
          Use a different account
        </Mono>
      </Pressable>
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
  codeInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 18,
    fontSize: 26,
    letterSpacing: 8,
    fontFamily: FONT.mono,
    textAlign: 'center',
  },
  verifyBtn: {
    marginTop: 18,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  fallback: {
    marginTop: 18,
    alignSelf: 'center',
    padding: 8,
  },
});

import { ShieldCheck } from 'lucide-react-native';
import * as React from 'react';
import { AccessibilityInfo, ActivityIndicator, StyleSheet, TextInput, View } from 'react-native';

import { AuthShell } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';
import { Body, Display, Em, Eyebrow } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { FONT, RADIUS, TYPE_CEILING, capTo } from '@/lib/theme';
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
 *
 * Drawn on the per-mode palette: the code box with the stronger control
 * border (the refusal colour after a wrong code), Verify as the shared ink
 * button (it keeps its word beside the spinner, so VoiceOver still hears it)
 * and "Use a different account" as the shared borderless button, both 52pt
 * targets announced as buttons.
 */
export function MfaChallengeScreen() {
  const { verifyMfa, signOutToFallback } = useAuth();
  const { c } = useTheme();
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // iOS ignores accessibilityLiveRegion, so a refused code is said aloud
  // (the box clears itself, and VoiceOver said nothing about why).
  React.useEffect(() => {
    if (error) AccessibilityInfo.announceForAccessibility(error);
  }, [error]);

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
        <View style={[styles.iconRing, { borderColor: c.hair2 }]}>
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
        placeholderTextColor={c.ink3}
        // Its spoken name: without one VoiceOver read the placeholder digits.
        accessibilityLabel="6-digit code"
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        autoFocus
        editable={!busy}
        maxLength={6}
        // The input ceiling (lib/theme.ts TYPE_CEILING.input): six 26pt
        // digits with wide tracking already fill the box, and uncapped they
        // ran past its edge at the accessibility sizes.
        maxFontSizeMultiplier={CODE_CAP}
        style={[
          styles.codeInput,
          { color: c.ink, borderColor: error ? c.critText : c.hair2, backgroundColor: c.card },
        ]}
      />

      {error ? (
        <Body size={13} color={c.critText} style={{ marginTop: 10 }}>
          {error}
        </Body>
      ) : null}

      <View style={styles.verify}>
        <Button
          block
          onPress={() => void submit(code)}
          disabled={busy || code.length !== 6}
          trailing={busy ? <ActivityIndicator color={c.paper} /> : undefined}
        >
          Verify
        </Button>
      </View>

      <View style={styles.fallback}>
        <Button block variant="ghost" onPress={() => void signOutToFallback()} disabled={busy}>
          Use a different account
        </Button>
      </View>
    </AuthShell>
  );
}

/** The code is 26pt, past the 24pt input ceiling: it does not grow. */
const CODE_CAP = capTo(26, TYPE_CEILING.input);

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
    borderRadius: RADIUS.card,
    paddingVertical: 16,
    paddingHorizontal: 18,
    fontSize: 26,
    letterSpacing: 8,
    fontFamily: FONT.mono,
    textAlign: 'center',
  },
  verify: {
    marginTop: 18,
  },
  fallback: {
    marginTop: 8,
  },
});

import {
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  Mail,
  ScanFace,
} from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { AuthShell } from '@/components/auth/auth-shell';
import { BiometricOptInSheet } from '@/components/biometric-optin-sheet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import {
  getBiometricCapability,
  isBiometricEnabledForUser,
  promptBiometric,
} from '@/lib/biometric';
import { API_BASE } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { useTheme } from '@/lib/use-theme';

export default function SignIn() {
  const { signIn } = useAuth();
  const { c } = useTheme();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [showPw, setShowPw] = React.useState(false);
  const [keepIn, setKeepIn] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [showOptIn, setShowOptIn] = React.useState(false);
  const [bioCapable, setBioCapable] = React.useState(false);
  const [bioLabel, setBioLabel] = React.useState<'Face ID' | 'Touch ID' | 'Fingerprint' | 'Biometric'>('Face ID');

  // Probe biometric capability once on mount so we know whether to
  // show the Face ID / Fingerprint quick-sign-in card. If the device
  // has no biometric hardware or the user has none enrolled, hide it.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cap = await getBiometricCapability();
      if (cancelled) return;
      if (cap.hasHardware && cap.isEnrolled) {
        setBioCapable(true);
        setBioLabel(cap.label === 'Iris' ? 'Biometric' : cap.label);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // "Sign in with Face ID" path — checks for a stored Supabase session
  // (from a prior successful email/password sign-in on this device),
  // prompts biometric, and resumes the session on success. If there is
  // no stored session yet, point the user at email/password — we never
  // store passwords on-device, only the encrypted Supabase refresh
  // token which Supabase itself manages via SecureStore.
  async function signInWithBiometric() {
    setError(null);
    const { data } = await supabase.auth.getSession();
    if (!data.session?.user) {
      setError('Sign in with your password first, then enable Face ID in Settings.');
      return;
    }
    const enabled = await isBiometricEnabledForUser(data.session.user.id);
    if (!enabled) {
      setError('Enable Face ID for this account in Settings · Security first.');
      return;
    }
    const ok = await promptBiometric(`Sign in to StockPilot with ${bioLabel}`);
    if (!ok) {
      setError(`${bioLabel} couldn’t verify. Try again or use your password.`);
      return;
    }
    // Session is already valid — Supabase restored it; setting it on
    // the auth context happens automatically via onAuthStateChange.
    // We just need to nudge the router away from the auth group.
    await supabase.auth.refreshSession();
  }

  async function submit() {
    setError(null);
    setBusy(true);
    const res = await signIn(email.trim(), password);
    if (res.error) {
      setBusy(false);
      setError(res.error);
      return;
    }
    try {
      const cap = await getBiometricCapability();
      if (cap.hasHardware && cap.isEnrolled) {
        const { data } = await supabase.auth.getUser();
        const uid = data.user?.id;
        if (uid && !(await isBiometricEnabledForUser(uid))) {
          setShowOptIn(true);
        }
      }
    } catch {
      // capability probe failure is non-fatal — proceed without prompt
    }
    setBusy(false);
  }

  // Password reset: the WEB backend mints the link and emails it via
  // Resend (POST /api/v1/auth/password-reset, anti-enumeration: always
  // ok). Never call supabase.auth.resetPasswordForEmail from the device —
  // it routes through Supabase's built-in mailer (capped ~2 emails/hour,
  // silently) and emails a link whose session comes back in a URL
  // fragment no server can read, stranding the user on /signin. The
  // emailed link completes in the phone's browser.
  async function forgotPassword() {
    const target = email.trim();
    if (!target) {
      setError('Enter your email above first, then tap “Forgot?”.');
      return;
    }
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/password-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: target }),
      });
      if (!res.ok) {
        setError('Could not request a reset right now. Try again shortly.');
        return;
      }
    } catch {
      setError('Could not request a reset right now. Check your connection.');
      return;
    }
    Alert.alert(
      'Check your email',
      `If an account exists for ${target}, we’ve sent a link to reset your password.`,
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <AuthShell>
        <BiometricOptInSheet
          visible={showOptIn}
          onDismiss={() => setShowOptIn(false)}
        />
        <ScrollView
          contentContainerStyle={{ paddingBottom: 30 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ marginTop: 28 }}>
            <Eyebrow>WELCOME BACK</Eyebrow>
            <Display size={36} style={{ marginTop: 16 }}>
              Sign in to <Em>StockPilot</Em>
            </Display>
            <Body muted style={{ marginTop: 12, maxWidth: 320 }}>
              Pick up where you left off. Counts, cycle audits, and pending POs sync as soon as you&apos;re back online.
            </Body>
          </View>

          <Card hero style={{ padding: 22, marginTop: 26, gap: 18 }}>
            <Field
              label="EMAIL"
              placeholder="ops@stockpilot.app"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              textContentType="username"
              value={email}
              onChangeText={setEmail}
              trailing={<Mail size={18} color={c.ink4} strokeWidth={1.4} />}
            />
            <Field
              label="PASSWORD"
              placeholder="••••••••••••"
              secureTextEntry={!showPw}
              autoComplete="current-password"
              textContentType="password"
              value={password}
              onChangeText={setPassword}
              trailing={
                <Pressable
                  hitSlop={10}
                  onPress={() => setShowPw((p) => !p)}
                >
                  {showPw ? (
                    <EyeOff size={18} color={c.ink4} strokeWidth={1.4} />
                  ) : (
                    <Eye size={18} color={c.ink4} strokeWidth={1.4} />
                  )}
                </Pressable>
              }
            />

            <View style={styles.metaRow}>
              <Pressable
                onPress={() => setKeepIn((v) => !v)}
                style={styles.keepInRow}
                hitSlop={10}
              >
                <View
                  style={[
                    styles.checkbox,
                    {
                      borderColor: c.ink3,
                      backgroundColor: keepIn ? c.ink : 'transparent',
                    },
                  ]}
                >
                  {keepIn ? (
                    <Check size={12} color={c.paper} strokeWidth={2.2} />
                  ) : null}
                </View>
                <Body size={13} color={c.ink2} style={{ flexShrink: 1 }}>
                  Keep me signed in
                </Body>
              </Pressable>
              <Pressable hitSlop={10} onPress={forgotPassword}>
                <Body
                  size={13}
                  color={c.ink2}
                  style={{ borderBottomWidth: 1, borderBottomColor: c.hair }}
                >
                  Forgot?
                </Body>
              </Pressable>
            </View>

            {error ? (
              <Body size={13} color={c.ink} style={{ color: '#b03a3a' }}>
                {error}
              </Body>
            ) : null}

            <Button
              block
              onPress={submit}
              disabled={busy}
              trailing={
                busy ? (
                  <ActivityIndicator size="small" color={c.paper} />
                ) : (
                  <ArrowRight size={16} color={c.paper} strokeWidth={1.6} />
                )
              }
            >
              Sign in
            </Button>
          </Card>

          <View style={styles.divider}>
            <View style={[styles.line, { backgroundColor: c.hair }]} />
            <Mono size={10.5} tracking={0.18} upper color={c.ink4}>
              or
            </Mono>
            <View style={[styles.line, { backgroundColor: c.hair }]} />
          </View>

          {bioCapable ? (
            <View style={{ marginTop: 18 }}>
              <Button
                block
                variant="outline"
                onPress={signInWithBiometric}
                leading={<ScanFace size={20} color={c.ink} strokeWidth={1.4} />}
              >
                {`Sign in with ${bioLabel}`}
              </Button>
            </View>
          ) : null}

          <View style={styles.footer}>
            <Body size={13} color={c.ink4} style={{ textAlign: 'center' }}>
              New to StockPilot? Your organization admin can invite you.
            </Body>
          </View>
        </ScrollView>
      </AuthShell>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    // "Keep me signed in" and "Forgot?" cannot share a line once the label
    // grows, and unwrapped it is Forgot? — the only password-reset entry
    // point in the app — that gets pushed off the right edge.
    flexWrap: 'wrap',
    gap: 10,
  },
  keepInRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    marginTop: 26,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  line: {
    flex: 1,
    height: 1,
  },
  footer: {
    marginTop: 28,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'baseline',
  },
});

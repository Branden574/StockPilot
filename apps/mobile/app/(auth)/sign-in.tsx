import { Link } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { BiometricOptInSheet } from '@/components/biometric-optin-sheet';
import { useAuth } from '@/lib/auth-context';
import {
  getBiometricCapability,
  isBiometricEnabledForUser,
} from '@/lib/biometric';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

export default function SignIn() {
  const { signIn } = useAuth();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [showOptIn, setShowOptIn] = React.useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    const res = await signIn(email.trim(), password);
    if (res.error) {
      setBusy(false);
      setError(res.error);
      return;
    }
    // Sign-in succeeded. If the device is biometric-capable AND this
    // user hasn't already opted in, show the opt-in sheet. The sheet
    // is non-blocking — RootGate will route to (drawer) the moment the
    // sheet closes, whether the user enables or skips.
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
      // Capability probe failure is non-fatal — proceed without prompt.
    }
    setBusy(false);
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <BiometricOptInSheet visible={showOptIn} onDismiss={() => setShowOptIn(false)} />
      <View style={styles.card}>
        <Text style={styles.brand}>StockPilot</Text>
        <Text style={styles.title}>Welcome back</Text>
        <Text style={styles.subtitle}>Sign in to manage your inventory.</Text>

        <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" />

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaLabel}>Sign in</Text>}
        </Pressable>

        <View style={styles.footer}>
          <Text style={styles.footerText}>New to StockPilot? </Text>
          <Link href="/(auth)/sign-up" replace>
            <Text style={styles.link}>Create an account</Text>
          </Link>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function Field(props: React.ComponentProps<typeof TextInput> & { label: string }) {
  const { label, ...rest } = props;
  return (
    <View style={{ marginTop: space.md }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        {...rest}
        placeholderTextColor={theme.textMuted}
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: space.lg, backgroundColor: theme.bg },
  card: {
    backgroundColor: theme.card,
    borderRadius: radius.xl,
    padding: space.xl,
    borderWidth: 1,
    borderColor: theme.border,
  },
  brand: { color: theme.primary, fontSize: 14, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase' },
  title: { color: theme.text, fontSize: 28, fontWeight: '700', marginTop: space.sm },
  subtitle: { color: theme.textMuted, fontSize: 14, marginTop: space.xs, marginBottom: space.lg },
  label: { color: theme.textMuted, fontSize: 12, marginBottom: 6, fontWeight: '500' },
  input: {
    backgroundColor: theme.bgElevated,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    color: theme.text,
    fontSize: 15,
    borderWidth: 1,
    borderColor: theme.border,
  },
  cta: {
    backgroundColor: theme.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: space.lg,
  },
  ctaLabel: { color: '#fff', fontWeight: '600', fontSize: 15 },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: space.lg },
  footerText: { color: theme.textMuted, fontSize: 13 },
  link: { color: theme.primary, fontSize: 13, fontWeight: '600' },
  error: { color: theme.destructive, fontSize: 13, marginTop: space.sm },
});

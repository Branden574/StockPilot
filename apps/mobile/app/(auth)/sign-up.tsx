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

import { useAuth } from '@/lib/auth-context';
import { radius, space, theme } from '@/lib/theme';

export default function SignUp() {
  const { signUp } = useAuth();
  const [fullName, setFullName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitted, setSubmitted] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    const res = await signUp(email.trim(), password, fullName.trim());
    setBusy(false);
    if (res.error) setError(res.error);
    else if (res.needsConfirm) setSubmitted(true);
  }

  if (submitted) {
    return (
      <View style={styles.container}>
        <View style={styles.card}>
          <Text style={styles.title}>Check your email</Text>
          <Text style={styles.subtitle}>
            We sent a confirmation link to {email}. Tap it to finish creating your account, then sign in.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.card}>
        <Text style={styles.brand}>StockPilot</Text>
        <Text style={styles.title}>Start free</Text>
        <Text style={styles.subtitle}>14 days of Pro features. No credit card.</Text>

        <Field label="Full name" value={fullName} onChangeText={setFullName} autoComplete="name" />
        <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" />

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaLabel}>Create account</Text>}
        </Pressable>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Have an account? </Text>
          <Link href="/(auth)/sign-in" replace>
            <Text style={styles.link}>Sign in</Text>
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
      <TextInput {...rest} placeholderTextColor={theme.textMuted} style={styles.input} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: space.lg, backgroundColor: theme.bg },
  card: { backgroundColor: theme.card, borderRadius: radius.xl, padding: space.xl, borderWidth: 1, borderColor: theme.border },
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
  cta: { backgroundColor: theme.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', marginTop: space.lg },
  ctaLabel: { color: '#fff', fontWeight: '600', fontSize: 15 },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: space.lg },
  footerText: { color: theme.textMuted, fontSize: 13 },
  link: { color: theme.primary, fontSize: 13, fontWeight: '600' },
  error: { color: theme.destructive, fontSize: 13, marginTop: space.sm },
});

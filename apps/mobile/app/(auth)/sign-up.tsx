import { Link } from 'expo-router';
import { ArrowRight, Mail, RefreshCcw, Warehouse } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { AuthShell } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Pill } from '@/components/ui/pill';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

export default function SignUp() {
  const { signUp } = useAuth();
  const { c } = useTheme();
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
    const firstName = fullName.trim().split(/\s+/)[0] || 'there';
    return (
      <AuthShell>
        <ScrollView contentContainerStyle={{ paddingBottom: 30 }}>
          <View style={{ marginTop: 32 }}>
            <Eyebrow>CHECK YOUR INBOX</Eyebrow>
            <Display size={36} style={{ marginTop: 16 }}>
              Almost there, <Em>{firstName}.</Em>
            </Display>
          </View>

          <Card hero style={{ padding: 26, marginTop: 28, alignItems: 'center', gap: 18 }}>
            <View
              style={[
                styles.iconWell,
                { backgroundColor: c.paper2, borderColor: c.hair },
              ]}
            >
              <Mail size={42} color={c.ink} strokeWidth={1.3} />
              <View
                style={[
                  styles.pip,
                  { backgroundColor: ACCENT.pipOrange },
                ]}
              />
            </View>

            <View style={{ alignItems: 'center', gap: 8 }}>
              <Display size={20}>We sent a verification link</Display>
              <Body muted style={{ textAlign: 'center', maxWidth: 280 }}>
                Open the email at{' '}
                <Mono size={13}>{email}</Mono> to finish creating your workspace.
              </Body>
            </View>

            <View
              style={[
                styles.pendingBox,
                { backgroundColor: c.paper2, borderColor: c.hair },
              ]}
            >
              <Warehouse size={20} color={c.ink2} strokeWidth={1.4} />
              <View style={{ flex: 1 }}>
                <Body size={12.5}>{fullName || 'Your workspace'}</Body>
                <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 2 }}>
                  workspace will activate on verify
                </Mono>
              </View>
              <Pill status="warn">PENDING</Pill>
            </View>

            <Button
              block
              variant="ghost"
              leading={<RefreshCcw size={16} color={c.ink} strokeWidth={1.4} />}
            >
              Resend email
            </Button>
          </Card>

          <View style={styles.changeRow}>
            <Body size={13} color={c.ink4}>
              Wrong address?{' '}
            </Body>
            <Pressable onPress={() => setSubmitted(false)}>
              <Body
                size={13}
                color={c.ink}
                style={{ borderBottomWidth: 1, borderBottomColor: c.ink, fontFamily: FONT.display }}
              >
                Change email
              </Body>
            </Pressable>
          </View>
        </ScrollView>
      </AuthShell>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <AuthShell>
        <ScrollView
          contentContainerStyle={{ paddingBottom: 30 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ marginTop: 28 }}>
            <Eyebrow>NEW WORKSPACE</Eyebrow>
            <Display size={36} style={{ marginTop: 16 }}>
              Start <Em>free.</Em>
            </Display>
            <Body muted style={{ marginTop: 12 }}>
              14 days of Pro features. No credit card.
            </Body>
          </View>

          <Card hero style={{ padding: 22, marginTop: 26, gap: 18 }}>
            <Field
              label="FULL NAME"
              placeholder="Branden Walker"
              autoCapitalize="words"
              autoComplete="name"
              textContentType="name"
              value={fullName}
              onChangeText={setFullName}
            />
            <Field
              label="EMAIL"
              placeholder="ops@stockpilot.app"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              textContentType="emailAddress"
              value={email}
              onChangeText={setEmail}
              trailing={<Mail size={18} color={c.ink4} strokeWidth={1.4} />}
            />
            <Field
              label="PASSWORD"
              placeholder="At least 8 characters"
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
              value={password}
              onChangeText={setPassword}
            />

            {error ? (
              <Body size={13} color={ACCENT.crit}>
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
              Create account
            </Button>
          </Card>

          <View style={styles.changeRow}>
            <Body size={14} color={c.ink3}>
              Have an account?{' '}
            </Body>
            <Link href="/(auth)/sign-in" replace asChild>
              <Pressable>
                <Body
                  size={14}
                  color={c.ink}
                  style={{ borderBottomWidth: 1, borderBottomColor: c.ink, fontFamily: FONT.display }}
                >
                  Sign in
                </Body>
              </Pressable>
            </Link>
          </View>
        </ScrollView>
      </AuthShell>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  iconWell: {
    width: 96,
    height: 96,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  pip: {
    position: 'absolute',
    top: 16,
    right: 18,
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  pendingBox: {
    width: '100%',
    padding: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  changeRow: {
    marginTop: 22,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'baseline',
  },
});

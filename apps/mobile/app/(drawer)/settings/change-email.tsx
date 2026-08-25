import { useFocusEffect, useRouter } from 'expo-router';
import { ArrowLeft, Eye, EyeOff, Mail } from 'lucide-react-native';
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
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Card, Hair } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { invalidateProfile } from '@/lib/use-profile';
import { useTheme } from '@/lib/use-theme';

/**
 * Settings → Email. The mobile twin of the web Profile → Email card, on the
 * same four Bearer routes (/api/v1/account/email[/request|/resend|/cancel])
 * and therefore the same rules: the new address must be confirmed AND the
 * current address must approve before anything changes, and the phone never
 * decides what is verified — it renders what GoTrue reports.
 *
 * The confirmation links themselves are opened in the phone's browser (there
 * are no universal links), so this screen's job is to request, show pending,
 * resend, cancel — and, when it notices the change has completed, to refresh
 * the session so the drawer, lock screen and avatar pick up the new address.
 */

interface Status {
  email: string;
  pendingEmail: string | null;
  sentAt: string | null;
  expiresAt: string | null;
  expired: boolean;
}

interface RequestResult {
  pendingEmail: string;
  sentAt: string;
  expiresAt: string;
}

function describeError(e: unknown): { title: string; message: string } {
  if (e instanceof ApiError) {
    if (e.code === 'aal2_required') {
      return {
        title: 'Re-authentication needed',
        message:
          'Your account uses an authenticator app. Sign out and sign back in, then try again — that fresh session can change your email.',
      };
    }
    if (e.status === 429) {
      return { title: 'Too many attempts', message: e.message || 'Try again in a few minutes.' };
    }
    return { title: 'Could not change email', message: e.message || 'Please try again.' };
  }
  return {
    title: 'Could not change email',
    message: e instanceof Error ? e.message : 'Please check your connection and try again.',
  };
}

function relativeTime(iso: string, now: number): string {
  const min = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
}

export default function ChangeEmailScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const { user } = useAuth();

  const [status, setStatus] = React.useState<Status | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const [newEmail, setNewEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [showPw, setShowPw] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<'request' | 'resend' | 'cancel' | null>(null);
  const [showForm, setShowForm] = React.useState(false);

  const load = React.useCallback(async () => {
    setNow(Date.now());
    try {
      const s = await api<Status>('/api/v1/account/email');
      setStatus(s);
      setLoadError(null);
      // The change completed elsewhere (links are opened in a browser): the
      // session user on this phone still carries the OLD address until the
      // next token refresh. Refresh now so every profile surface updates.
      if (user?.email && s.email && s.email.toLowerCase() !== user.email.toLowerCase()) {
        await supabase.auth.refreshSession().catch(() => undefined);
        invalidateProfile(user);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your email settings.');
    }
  }, [user]);

  useFocusEffect(
    React.useCallback(() => {
      void load();
    }, [load]),
  );

  const request = async () => {
    setFormError(null);
    const target = newEmail.trim();
    if (!target) {
      setFormError('Enter your new email address.');
      return;
    }
    if (!password) {
      setFormError('Enter your current password.');
      return;
    }
    setBusy('request');
    try {
      const r = await api<RequestResult>('/api/v1/account/email/request', {
        method: 'POST',
        body: { newEmail: target, currentPassword: password },
      });
      setStatus((prev) =>
        prev
          ? { ...prev, pendingEmail: r.pendingEmail, sentAt: r.sentAt, expiresAt: r.expiresAt, expired: false }
          : prev,
      );
      setNewEmail('');
      setPassword('');
      setShowForm(false);
      Alert.alert(
        'Check both inboxes',
        `We sent a confirmation link to ${r.pendingEmail} and an approval link to ${status?.email ?? 'your current email'}. Your account keeps its current email until both are used.`,
      );
    } catch (e) {
      const d = describeError(e);
      if (e instanceof ApiError && (e.status === 400 || e.status === 409 || e.status === 403)) {
        setFormError(d.message);
      } else {
        Alert.alert(d.title, d.message);
      }
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    setBusy('resend');
    try {
      const r = await api<RequestResult>('/api/v1/account/email/resend', { method: 'POST', body: {} });
      setStatus((prev) =>
        prev ? { ...prev, pendingEmail: r.pendingEmail, sentAt: r.sentAt, expiresAt: r.expiresAt, expired: false } : prev,
      );
      setNow(Date.now());
      Alert.alert('Sent again', `Fresh links are on their way to ${r.pendingEmail} and your current email.`);
    } catch (e) {
      const d = describeError(e);
      Alert.alert(d.title, d.message);
    } finally {
      setBusy(null);
    }
  };

  const cancel = () => {
    Alert.alert(
      'Cancel this email change?',
      'The links already sent will stop working and your sign-in email stays as it is.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Cancel change',
          style: 'destructive',
          onPress: async () => {
            setBusy('cancel');
            try {
              await api('/api/v1/account/email/cancel', { method: 'POST', body: {} });
              setStatus((prev) =>
                prev ? { ...prev, pendingEmail: null, sentAt: null, expiresAt: null, expired: false } : prev,
              );
            } catch (e) {
              const d = describeError(e);
              Alert.alert(d.title, d.message);
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  };

  const pending = status?.pendingEmail ?? null;
  const expired = status?.expiresAt ? now > new Date(status.expiresAt).getTime() : false;

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip
            icon={ArrowLeft}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/settings' as never))}
          />
        </View>
        <View style={styles.head}>
          <Eyebrow>SETTINGS</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            Email<Em>.</Em>
          </Display>
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 60, gap: 16 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {!status && !loadError ? (
            <View style={{ paddingVertical: 40, alignItems: 'center' }}>
              <ActivityIndicator />
            </View>
          ) : null}

          {loadError ? (
            <Card padding={16}>
              <Body>{loadError}</Body>
              <Button variant="outline" size="sm" style={{ marginTop: 12 }} onPress={() => void load()}>
                Try again
              </Button>
            </Card>
          ) : null}

          {status ? (
            <Card padding={16} style={{ gap: 10 }}>
              <Mono size={10} tracking={0.12} upper color={c.ink4}>
                SIGN-IN EMAIL
              </Mono>
              <View style={styles.row}>
                <Body size={16} style={{ flexShrink: 1 }}>
                  {status.email}
                </Body>
                <Pill status="ok">{pending ? 'CURRENT' : 'VERIFIED'}</Pill>
              </View>
              <Body muted size={13}>
                Where StockPilot sends account emails and what you sign in with.
              </Body>
            </Card>
          ) : null}

          {status && pending ? (
            <Card padding={16} style={{ gap: 10 }}>
              <Mono size={10} tracking={0.12} upper color={c.ink4}>
                PENDING CHANGE
              </Mono>
              <View style={styles.row}>
                <Body size={16} style={{ flexShrink: 1 }}>
                  {pending}
                </Body>
                <Pill status={expired ? 'crit' : 'warn'}>{expired ? 'EXPIRED' : 'PENDING'}</Pill>
              </View>
              <Body muted size={13}>
                {expired
                  ? 'The verification links have expired. Send them again to continue.'
                  : `Links sent${status.sentAt ? ` ${relativeTime(status.sentAt, now)}` : ''} to both addresses. Open each one in your email app. Your account keeps using ${status.email} until both are confirmed.`}
              </Body>
              <Hair />
              <View style={{ gap: 8 }}>
                <Button variant="outline" size="sm" disabled={busy !== null} onPress={() => void resend()}>
                  {busy === 'resend' ? 'Sending…' : 'Resend links'}
                </Button>
                <Button variant="outline" size="sm" disabled={busy !== null} onPress={() => setShowForm(true)}>
                  Use a different address
                </Button>
                <Button variant="destructive" size="sm" disabled={busy !== null} onPress={cancel}>
                  {busy === 'cancel' ? 'Cancelling…' : 'Cancel change'}
                </Button>
              </View>
            </Card>
          ) : null}

          {status && (!pending || showForm) ? (
            <Card padding={16} style={{ gap: 14 }}>
              <Mono size={10} tracking={0.12} upper color={c.ink4}>
                {pending ? 'CHANGE TO A DIFFERENT ADDRESS' : 'CHANGE EMAIL'}
              </Mono>
              <Body muted size={13}>
                We will send a confirmation link to the new address and an approval link to{' '}
                {status.email}. Nothing changes until both are used.
              </Body>
              <Field
                label="NEW EMAIL"
                placeholder="you@company.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                value={newEmail}
                onChangeText={setNewEmail}
                trailing={<Mail size={18} color={c.ink4} strokeWidth={1.4} />}
              />
              <Field
                label="CURRENT PASSWORD"
                placeholder="••••••••••••"
                secureTextEntry={!showPw}
                autoComplete="current-password"
                textContentType="password"
                value={password}
                onChangeText={setPassword}
                trailing={
                  <Pressable hitSlop={10} onPress={() => setShowPw((p) => !p)}>
                    {showPw ? (
                      <EyeOff size={18} color={c.ink4} strokeWidth={1.4} />
                    ) : (
                      <Eye size={18} color={c.ink4} strokeWidth={1.4} />
                    )}
                  </Pressable>
                }
              />
              {formError ? (
                <Body size={13} style={{ color: '#b42318' }}>
                  {formError}
                </Body>
              ) : null}
              <Button block disabled={busy !== null} onPress={() => void request()}>
                {busy === 'request' ? 'Sending…' : 'Send verification'}
              </Button>
              {pending ? (
                <Button variant="ghost" size="sm" disabled={busy !== null} onPress={() => setShowForm(false)}>
                  Keep the pending address
                </Button>
              ) : null}
            </Card>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  head: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 18 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
});

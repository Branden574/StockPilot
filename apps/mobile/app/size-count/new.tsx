import { Stack, useRouter } from 'expo-router';
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
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '@/lib/api';
import { radius, space, theme } from '@/lib/theme';

/**
 * Start an Instant Size Count session. v1 is a review-only per-vendor size
 * tally (no inventory write). The optional reference labels the shipment.
 */
export default function NewSizeCountScreen() {
  const router = useRouter();
  const [reference, setReference] = React.useState('');
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const res = await api<{ session: { id: string } }>('/api/v1/size-counts', {
        method: 'POST',
        body: {
          mode: 'rapid_pass',
          boxId: reference.trim() || null,
        },
      });
      // Replace so Back from the counter returns to the list, not here.
      // `as never`: expo-router's generated route types don't include this new
      // dynamic path until typed-routes regenerate on the next dev/build run.
      router.replace(`/size-count/${res.session.id}` as never);
    } catch (e) {
      setStarting(false);
      setError(
        e instanceof Error ? e.message.replace(/^API \d+:\s*/, '') : 'Could not start. Try again.',
      );
    }
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Text style={styles.backText}>← Back</Text>
          </Pressable>
          <Text style={styles.title}>New size count</Text>
          <Text style={styles.subtitle}>
            Count the sizes in a vendor shipment. This builds a review list — it
            does not change inventory.
          </Text>
        </View>

        <View style={styles.body}>
          <Text style={styles.label}>Reference (optional)</Text>
          <TextInput
            value={reference}
            onChangeText={setReference}
            placeholder="Vendor name, PO #, or box label"
            placeholderTextColor={theme.textMuted}
            style={styles.input}
            autoFocus
            returnKeyType="go"
            onSubmitEditing={start}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            onPress={() => router.push('/size-count/capture' as never)}
            style={styles.captureLink}
          >
            <Text style={styles.captureLinkText}>Capture training photos →</Text>
          </Pressable>
        </View>

        <View style={styles.footer}>
          <Pressable onPress={start} disabled={starting} style={styles.startBtn}>
            {starting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.startLabel}>Start counting</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  backBtn: { paddingVertical: space.xs },
  backText: { color: theme.primary, fontSize: 14 },
  title: { color: theme.text, fontSize: 24, fontWeight: '700', marginTop: 4 },
  subtitle: { color: theme.textMuted, fontSize: 13, marginTop: 4, lineHeight: 18 },
  body: { padding: space.md },
  label: { color: theme.text, fontSize: 13, fontWeight: '600', marginBottom: 8 },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    color: theme.text,
    fontSize: 16,
  },
  error: { color: '#dc2626', fontSize: 13, marginTop: 12 },
  captureLink: { marginTop: space.lg, paddingVertical: space.sm },
  captureLinkText: { color: theme.primary, fontSize: 14, fontWeight: '600' },
  footer: { marginTop: 'auto', padding: space.md },
  startBtn: {
    minHeight: 52,
    borderRadius: radius.md,
    backgroundColor: theme.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startLabel: { color: '#fff', fontSize: 16, fontWeight: '700' },
});

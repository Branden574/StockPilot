import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { api } from '@/lib/api';
import { enqueue } from '@/lib/queue';
import { syncNow } from '@/lib/sync';
import { radius, space, theme } from '@/lib/theme';

// The nine sizes the feature targets (feature spec vocabulary).
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL'] as const;

interface SessionInfo {
  id: string;
  status: string;
  style_key: string | null;
  box_id: string | null;
}

type Tally = Record<string, number>;

export default function SizeCountScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [session, setSession] = React.useState<SessionInfo | null>(null);
  const [tally, setTally] = React.useState<Tally>({});
  const [loading, setLoading] = React.useState(true);
  const [completing, setCompleting] = React.useState(false);
  // Local stack of tapped sizes so Undo can pop the last count.
  const historyRef = React.useRef<string[]>([]);

  // Seed the tally from the server (so a resumed/queued session shows prior
  // counts). Offline: fall back to an empty local tally; taps still queue.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{
          session: SessionInfo;
          tally: Array<{ size: string; quantity: number }>;
        }>(`/api/v1/size-counts/${id}`);
        if (cancelled) return;
        setSession(res.session);
        const seeded: Tally = {};
        for (const t of res.tally) seeded[t.size] = t.quantity;
        setTally(seeded);
      } catch {
        // Offline or transient — start from a local zero tally; the server
        // reconciles when the outbox drains.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const isOpen = (session?.status ?? 'active') === 'active';
  const total = React.useMemo(
    () => Object.values(tally).reduce((a, b) => a + b, 0),
    [tally],
  );

  const count = React.useCallback(
    (size: string, delta: 1 | -1) => {
      if (!isOpen) return;
      setTally((t) => {
        const next = Math.max(0, (t[size] ?? 0) + delta);
        return { ...t, [size]: next };
      });
      if (delta === 1) historyRef.current.push(size);
      // Queue the event; the outbox dedups + syncs. Fire-and-forget sync.
      void enqueue('size_count_event', {
        sessionId: id,
        size,
        quantityDelta: delta,
        recognitionMethod: 'manual',
        countedAt: new Date().toISOString(),
      }).then(() => void syncNow());
    },
    [id, isOpen],
  );

  const undoLast = React.useCallback(() => {
    const last = historyRef.current.pop();
    if (last) count(last, -1);
  }, [count]);

  const complete = React.useCallback(() => {
    Alert.alert(
      'Finish this size count?',
      `Total counted: ${total}. This locks the list for review — it does not change inventory.`,
      [
        { text: 'Keep counting', style: 'cancel' },
        {
          text: 'Finish',
          style: 'default',
          onPress: async () => {
            setCompleting(true);
            try {
              await syncNow(true); // flush the outbox first
              await api(`/api/v1/size-counts/${id}/complete`, { method: 'POST' });
              router.back();
            } catch (e) {
              setCompleting(false);
              Alert.alert(
                'Could not finish',
                e instanceof Error ? e.message.replace(/^API \d+:\s*/, '') : 'Try again.',
              );
            }
          },
        },
      ],
    );
  }, [id, router, total]);

  if (loading) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.center}>
          <ActivityIndicator color={theme.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Size count</Text>
            <Text style={styles.subtitle}>
              {session?.box_id ? `${session.box_id} · ` : ''}
              {total} counted
              {isOpen ? '' : ' · completed'}
            </Text>
          </View>
          <SyncStatusBadge />
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.grid}>
          {SIZES.map((size) => (
            <Pressable
              key={size}
              onPress={() => count(size, 1)}
              onLongPress={() => count(size, -1)}
              disabled={!isOpen}
              style={[styles.sizeBtn, !isOpen && styles.sizeBtnDisabled]}
            >
              <Text style={styles.sizeLabel}>{size}</Text>
              <Text style={styles.sizeCount}>{tally[size] ?? 0}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.hint}>
          Tap a size to add one. Long-press to remove one.
        </Text>
      </ScrollView>

      {isOpen ? (
        <View style={styles.footer}>
          <Pressable onPress={undoLast} style={styles.undoBtn}>
            <Text style={styles.undoLabel}>Undo</Text>
          </Pressable>
          <Pressable
            onPress={complete}
            disabled={completing}
            style={styles.finishBtn}
          >
            {completing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.finishLabel}>Finish · {total}</Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  backBtn: { paddingVertical: space.xs },
  backText: { color: theme.primary, fontSize: 14 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: 4 },
  title: { color: theme.text, fontSize: 22, fontWeight: '700' },
  subtitle: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  body: { padding: space.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  sizeBtn: {
    width: '31%',
    minHeight: 92,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.card,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.md,
  },
  sizeBtnDisabled: { opacity: 0.5 },
  sizeLabel: { color: theme.textMuted, fontSize: 14, fontWeight: '600' },
  sizeCount: { color: theme.text, fontSize: 32, fontWeight: '800', marginTop: 4 },
  hint: { color: theme.textMuted, fontSize: 12, marginTop: space.md, textAlign: 'center' },
  footer: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  undoBtn: {
    minHeight: 52,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  undoLabel: { color: theme.text, fontSize: 15, fontWeight: '600' },
  finishBtn: {
    flex: 1,
    minHeight: 52,
    borderRadius: radius.md,
    backgroundColor: theme.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  finishLabel: { color: '#fff', fontSize: 16, fontWeight: '700' },
});

import { Stack, useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  FlatList,
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
import { useEnabledModules } from '@/lib/enabled-modules';
import { radius, space, theme } from '@/lib/theme';

/** A product group as the picker lists it. The roll-up is DERIVED server-side
 *  from the variants — a group owns no quantity of its own. */
interface GroupRow {
  id: string;
  name: string;
  brand: string | null;
  model: string | null;
  styleNumber: string | null;
  team: string | null;
  countingUnit: string;
  variantCount: number;
  totalQuantity: number;
}

/**
 * Start an Instant Size Count session. v1 is a review-only per-vendor size
 * tally (no inventory write).
 *
 * WHAT is being counted comes from a PRODUCT GROUP (migration 0302). Before
 * this screen posted `{ mode, boxId }` and nothing else, so `style_key` — the
 * column that was supposed to say which product a tally belonged to — was
 * never populated by anything. A group is durable identity: renaming an item
 * cannot detach the count from the product it counted.
 *
 * The picker only appears for orgs with the sports module. Everyone else gets
 * the reference field exactly as before.
 */
export default function NewSizeCountScreen() {
  const router = useRouter();
  const enabledModules = useEnabledModules();
  const sportsEnabled = enabledModules.has('sports');

  const [reference, setReference] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [groups, setGroups] = React.useState<GroupRow[]>([]);
  const [groupsStatus, setGroupsStatus] = React.useState<'loading' | 'ready' | 'failed'>(
    'loading',
  );
  const [selected, setSelected] = React.useState<GroupRow | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Debounced group search. Nothing is fetched at all for a non-sports org.
  React.useEffect(() => {
    if (!sportsEnabled) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- debounced search: the sync set is the loading flag for a keystroke-driven server fetch; every data set is post-await
    setGroupsStatus('loading');
    const t = setTimeout(async () => {
      try {
        const q = query.trim();
        const res = await api<{ groups: GroupRow[] }>(
          `/api/v1/product-groups?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`,
        );
        if (cancelled) return;
        setGroups(res.groups ?? []);
        setGroupsStatus('ready');
      } catch {
        if (cancelled) return;
        setGroups([]);
        setGroupsStatus('failed');
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, sportsEnabled]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const res = await api<{ session: { id: string } }>('/api/v1/size-counts', {
        method: 'POST',
        body: {
          mode: 'rapid_pass',
          boxId: reference.trim() || null,
          // Durable identity when the org has groups; null otherwise, which is
          // the pre-0302 shape and still perfectly valid.
          productGroupId: selected?.id ?? null,
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

  const renderGroup = React.useCallback(
    ({ item }: { item: GroupRow }) => {
      const active = selected?.id === item.id;
      const detail = [item.brand, item.model, item.styleNumber, item.team]
        .filter(Boolean)
        .join(' · ');
      return (
        <Pressable
          onPress={() => setSelected(active ? null : item)}
          style={[styles.groupRow, active && styles.groupRowActive]}
          accessibilityRole="button"
          accessibilityState={{ selected: active }}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.groupName} numberOfLines={1}>
              {item.name}
            </Text>
            {detail ? (
              <Text style={styles.groupDetail} numberOfLines={1}>
                {detail}
              </Text>
            ) : null}
          </View>
          <Text style={styles.groupMeta}>
            {item.variantCount} size{item.variantCount === 1 ? '' : 's'}
          </Text>
        </Pressable>
      );
    },
    [selected],
  );

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
          {sportsEnabled ? (
            <>
              <Text style={styles.label}>Product</Text>
              <TextInput
                value={selected ? selected.name : query}
                onChangeText={(v) => {
                  if (selected) setSelected(null);
                  setQuery(v);
                }}
                placeholder="Search product groups"
                placeholderTextColor={theme.textMuted}
                style={styles.input}
                autoCorrect={false}
              />
              {selected ? (
                <Text style={styles.selectedHint}>
                  Counting {selected.name} · sizes come from its size scale.
                </Text>
              ) : groupsStatus === 'loading' ? (
                <View style={styles.groupsBox}>
                  <ActivityIndicator color={theme.primary} />
                </View>
              ) : groupsStatus === 'failed' ? (
                <Text style={styles.hint}>
                  Couldn&apos;t load product groups. You can still start an
                  unlabelled count.
                </Text>
              ) : groups.length === 0 ? (
                <Text style={styles.hint}>
                  {query.trim()
                    ? `No product groups match "${query.trim()}".`
                    : 'No product groups yet.'}
                </Text>
              ) : (
                <View style={styles.groupsBox}>
                  <FlatList
                    data={groups}
                    keyExtractor={(g) => g.id}
                    renderItem={renderGroup}
                    keyboardShouldPersistTaps="handled"
                    initialNumToRender={10}
                  />
                </View>
              )}
            </>
          ) : null}

          <Text style={[styles.label, sportsEnabled && { marginTop: space.lg }]}>
            Reference (optional)
          </Text>
          <TextInput
            value={reference}
            onChangeText={setReference}
            placeholder="Vendor name, PO #, or box label"
            placeholderTextColor={theme.textMuted}
            style={styles.input}
            autoFocus={!sportsEnabled}
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
  body: { padding: space.md, flex: 1 },
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
  selectedHint: { color: theme.primary, fontSize: 12, marginTop: 8 },
  hint: { color: theme.textMuted, fontSize: 12, marginTop: 8 },
  groupsBox: {
    marginTop: 8,
    maxHeight: 220,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  groupRowActive: { backgroundColor: theme.bgElevated },
  groupName: { color: theme.text, fontSize: 14, fontWeight: '600' },
  groupDetail: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  groupMeta: { color: theme.textMuted, fontSize: 12, fontVariant: ['tabular-nums'] },
  error: { color: '#dc2626', fontSize: 13, marginTop: 12 },
  captureLink: { marginTop: space.lg, paddingVertical: space.sm },
  captureLinkText: { color: theme.primary, fontSize: 14, fontWeight: '600' },
  footer: { padding: space.md },
  startBtn: {
    minHeight: 52,
    borderRadius: radius.md,
    backgroundColor: theme.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startLabel: { color: '#fff', fontSize: 16, fontWeight: '700' },
});

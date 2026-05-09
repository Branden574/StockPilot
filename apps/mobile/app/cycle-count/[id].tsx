import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

interface Line {
  id: string;
  itemId: string;
  itemName: string;
  itemSku: string;
  expected: number;
  counted: number | null;
}

interface Header {
  id: string;
  warehouseName: string | null;
  startedAt: string;
}

export default function CycleCountDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [orgId, setOrgId] = React.useState<string | null>(null);
  const [header, setHeader] = React.useState<Header | null>(null);
  const [lines, setLines] = React.useState<Line[]>([]);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [posting, setPosting] = React.useState(false);

  React.useEffect(() => {
    if (!user) return;
    supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user.id)
      .not('accepted_at', 'is', null)
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setOrgId((data?.organization_id as string | undefined) ?? null));
  }, [user]);

  const load = React.useCallback(async () => {
    if (!id || !orgId) return;
    setLoading(true);
    const [{ data: cc }, { data: lineRows }] = await Promise.all([
      supabase
        .from('cycle_counts')
        .select(
          `id, started_at, warehouse:warehouses!warehouse_id (name)`,
        )
        .eq('organization_id', orgId)
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('cycle_count_lines')
        .select(
          `id, expected_quantity, counted_quantity,
           item:inventory_items!item_id (id, name, sku)`,
        )
        .eq('cycle_count_id', id),
    ]);

    if (cc) {
      const r = cc as Record<string, unknown>;
      const wh = r.warehouse as { name: string } | { name: string }[] | null;
      const whName = Array.isArray(wh) ? wh[0]?.name ?? null : wh?.name ?? null;
      setHeader({
        id: r.id as string,
        warehouseName: whName,
        startedAt: r.started_at as string,
      });
    }

    const flat: Line[] = ((lineRows ?? []) as Array<Record<string, unknown>>).map((r) => {
      const itm = r.item as { id: string; name: string; sku: string } |
        Array<{ id: string; name: string; sku: string }> | null;
      const item = Array.isArray(itm) ? itm[0] : itm;
      return {
        id: r.id as string,
        itemId: item?.id ?? '',
        itemName: item?.name ?? 'Unknown',
        itemSku: item?.sku ?? '',
        expected: Number(r.expected_quantity),
        counted:
          r.counted_quantity === null || r.counted_quantity === undefined
            ? null
            : Number(r.counted_quantity),
      };
    });
    flat.sort((a, b) => a.itemName.localeCompare(b.itemName));
    setLines(flat);
    setLoading(false);
  }, [id, orgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  function setDraftValue(lineId: string, v: string) {
    setDraft((d) => ({ ...d, [lineId]: v }));
  }

  async function saveLine(line: Line) {
    const v = draft[line.id];
    if (v === undefined) return;
    const num = Number.parseFloat(v);
    if (Number.isNaN(num) || num < 0) {
      Alert.alert('Invalid count', 'Enter a non-negative number.');
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from('cycle_count_lines')
      .update({
        counted_quantity: num,
        counted_by: user?.id ?? null,
        counted_at: new Date().toISOString(),
      })
      .eq('id', line.id);
    setSaving(false);
    if (error) {
      Alert.alert('Could not save', error.message);
      return;
    }
    setDraft((d) => {
      const { [line.id]: _, ...rest } = d;
      return rest;
    });
    await load();
  }

  async function postCount() {
    if (!header) return;
    const uncounted = lines.filter((l) => l.counted === null && draft[l.id] === undefined);
    const proceed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        'Post cycle count?',
        uncounted.length > 0
          ? `${uncounted.length} line${uncounted.length === 1 ? '' : 's'} not counted will be skipped (no variance applied).`
          : 'All lines will be applied as adjustments to inventory.',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Post', style: 'destructive', onPress: () => resolve(true) },
        ],
      );
    });
    if (!proceed) return;

    setPosting(true);
    const { error } = await supabase.rpc('post_cycle_count', {
      p_cycle_count_id: header.id,
    });
    setPosting(false);
    if (error) {
      Alert.alert('Could not post', error.message);
      return;
    }
    Alert.alert('Posted', 'Variance adjustments applied.');
    router.back();
  }

  const countedCount = lines.filter((l) => l.counted !== null).length;
  const allCounted = countedCount === lines.length && lines.length > 0;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Cycle count</Text>
            <Text style={styles.subtitle}>
              {header?.warehouseName ?? '—'} · {countedCount}/{lines.length} counted
            </Text>
          </View>
          {header && (
            <Pressable
              onPress={() => router.push(`/cycle-count/scan/${header.id}`)}
              style={styles.scanBtn}
            >
              <Text style={styles.scanBtnLabel}>Scan to count</Text>
            </Pressable>
          )}
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: space.md, paddingBottom: 140 }}>
          {lines.map((l) => {
            const draftVal = draft[l.id];
            const isDirty = draftVal !== undefined;
            const display = isDirty
              ? draftVal
              : l.counted !== null
                ? String(l.counted)
                : '';
            const variance =
              l.counted !== null ? l.counted - l.expected : null;
            return (
              <View key={l.id} style={styles.card}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName} numberOfLines={2}>
                    {l.itemName}
                  </Text>
                  <Text style={styles.itemSku}>{l.itemSku}</Text>
                  <Text style={styles.expected}>
                    Expected: {l.expected}
                    {variance !== null && variance !== 0 && (
                      <Text
                        style={
                          variance > 0
                            ? { color: theme.success }
                            : { color: theme.destructive }
                        }
                      >
                        {' · Δ '}
                        {variance > 0 ? '+' : ''}
                        {variance}
                      </Text>
                    )}
                  </Text>
                </View>
                <View style={styles.countBox}>
                  <TextInput
                    style={styles.countInput}
                    value={display}
                    onChangeText={(v) => setDraftValue(l.id, v)}
                    keyboardType="numeric"
                    placeholder="—"
                    placeholderTextColor={theme.textMuted}
                  />
                  {isDirty && (
                    <Pressable
                      onPress={() => saveLine(l)}
                      style={({ pressed }) => [
                        styles.saveBtn,
                        pressed && { opacity: 0.6 },
                      ]}
                      disabled={saving}
                    >
                      <Text style={styles.saveBtnText}>Save</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            );
          })}

          {lines.length === 0 && (
            <Text style={styles.emptyText}>
              This count has no lines yet. Add lines from the web first.
            </Text>
          )}
        </ScrollView>
      )}

      {!loading && lines.length > 0 && (
        <View style={styles.footer}>
          <Pressable
            onPress={postCount}
            disabled={posting || countedCount === 0}
            style={({ pressed }) => [
              styles.postBtn,
              !allCounted && { backgroundColor: theme.warning },
              (pressed || posting || countedCount === 0) && { opacity: 0.6 },
            ]}
          >
            <Text style={styles.postBtnText}>
              {posting
                ? 'Posting…'
                : allCounted
                  ? 'Post cycle count'
                  : `Post (${countedCount}/${lines.length} counted)`}
            </Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  backBtn: { paddingVertical: space.xs },
  backText: { color: theme.primary, fontSize: 14 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: 4 },
  title: { color: theme.text, fontSize: 22, fontWeight: '700' },
  subtitle: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  scanBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    backgroundColor: theme.primary,
  },
  scanBtnLabel: { color: '#fff', fontSize: 13, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    flexDirection: 'row',
    backgroundColor: theme.card,
    padding: space.md,
    borderRadius: radius.md,
    marginBottom: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  itemName: { color: theme.text, fontSize: 14, fontWeight: '600' },
  itemSku: {
    color: theme.textMuted,
    fontFamily: 'Menlo',
    fontSize: 11,
    marginTop: 2,
  },
  expected: { color: theme.textMuted, fontSize: 12, marginTop: 4 },
  countBox: { alignItems: 'flex-end', justifyContent: 'center', minWidth: 110 },
  countInput: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    backgroundColor: theme.bg,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    minWidth: 80,
    textAlign: 'right',
  },
  saveBtn: {
    backgroundColor: theme.primary,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    marginTop: 6,
  },
  saveBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.md,
    backgroundColor: theme.bgElevated,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  postBtn: {
    backgroundColor: theme.primary,
    paddingVertical: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  postBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  emptyText: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: 'center',
    padding: space.xl,
  },
});

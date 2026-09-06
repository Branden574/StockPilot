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

import { api, ApiError } from '@/lib/api';
import { showWriteCta } from '@/lib/cta-gating';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import {
  getBundleComponents,
  getItemById,
  listBundles,
  listWarehouses,
  type CachedBundle,
  type CachedBundleComponent,
  type CachedItem,
  type CachedWarehouse,
} from '@/lib/db-reads';
import { enqueue, newIdempotencyKey } from '@/lib/queue';
import { syncNow } from '@/lib/sync';
import { radius, space, theme } from '@/lib/theme';

interface PreviewComponent {
  itemId: string;
  itemName: string;
  itemSku: string;
  perBundleQty: number;
  isOptional: boolean;
  needed: number;
  available: number;
  drawnFromComponents: number;
  shortage: number;
}

interface Preview {
  fromPhantom: number;
  fromComponents: number;
  components: PreviewComponent[];
  hasShortage: boolean;
  totalShortageItems: number;
  totalShortageUnits: number;
}

export default function BundleDetail() {
  const router = useRouter();
  // Distribute is a WRITE — hidden for read-only visitors (bundles:read
  // grantees). Cosmetic: the API enforces server-side; while permissions are
  // loading the CTA shows (matches cycle-counts/schedule gating fallback).
  const perms = useEffectivePermissions();
  const canDistribute = showWriteCta(perms, 'bundles:distribute');
  const { id } = useLocalSearchParams<{ id: string }>();
  const [bundle, setBundle] = React.useState<CachedBundle | null>(null);
  const [components, setComponents] = React.useState<CachedBundleComponent[]>([]);
  const [items, setItems] = React.useState<Map<string, CachedItem>>(new Map());
  const [warehouses, setWarehouses] = React.useState<CachedWarehouse[]>([]);

  const [qty, setQty] = React.useState('1');
  const [warehouseId, setWarehouseId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      if (!id) return;
      const all = await listBundles();
      const b = all.find((x) => x.id === id) ?? null;
      setBundle(b);
      if (!b) return;
      const comps = await getBundleComponents(b.id);
      setComponents(comps);
      const itemMap = new Map<string, CachedItem>();
      for (const c of comps) {
        const item = await getItemById(c.itemId);
        if (item) itemMap.set(c.itemId, item);
      }
      setItems(itemMap);
      const whs = await listWarehouses();
      setWarehouses(whs);
      setWarehouseId(b.phantomWarehouseId ?? whs[0]?.id ?? null);
    })();
  }, [id]);

  // Local preview math — mirrors the server's preview.
  const preview: Preview | null = React.useMemo(() => {
    if (!bundle) return null;
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0) return null;
    const fromPhantom = Math.min(n, bundle.phantomQty);
    const fromComponents = n - fromPhantom;
    let shortItems = 0;
    let shortUnits = 0;
    const compRows: PreviewComponent[] = components.map((c) => {
      const item = items.get(c.itemId);
      const needed = c.quantity * fromComponents;
      const available = Math.max(0, item?.quantityOnHand ?? 0);
      const drawn = Math.min(needed, available);
      const shortage = needed - drawn;
      if (shortage > 0 && !c.isOptional) {
        shortItems += 1;
        shortUnits += shortage;
      }
      return {
        itemId: c.itemId,
        itemName: item?.name ?? c.itemId.slice(0, 8),
        itemSku: item?.sku ?? '',
        perBundleQty: c.quantity,
        isOptional: c.isOptional,
        needed,
        available,
        drawnFromComponents: drawn,
        shortage,
      };
    });
    return {
      fromPhantom,
      fromComponents,
      components: compRows,
      hasShortage: shortItems > 0,
      totalShortageItems: shortItems,
      totalShortageUnits: shortUnits,
    };
  }, [bundle, components, items, qty]);

  async function distribute() {
    if (!bundle || !preview || !warehouseId) return;
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0) {
      Alert.alert('Invalid quantity', 'Enter a positive number.');
      return;
    }
    const allowShortage = preview.hasShortage;
    if (allowShortage) {
      const proceed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          'Distribute with shortage?',
          `${preview.totalShortageUnits} unit${preview.totalShortageUnits === 1 ? '' : 's'} short — these will be logged as shortage markers.`,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Distribute', style: 'destructive', onPress: () => resolve(true) },
          ],
        );
      });
      if (!proceed) return;
    }

    // ═══ ONE KEY FOR EVERY ATTEMPT OF THIS DISTRIBUTION (0347) ═══
    //
    // Minted BEFORE the first request and reused by the outbox replay, so the
    // server can recognise a retry. Without it, a response lost after the
    // server committed (or api()'s own 20 s timeout) meant the queued replay
    // distributed AGAIN: components drawn twice, two distribution rows.
    const idempotencyKey = newIdempotencyKey();
    setBusy(true);
    try {
      // Try direct send first; fall back to queue if offline.
      await api(`/api/v1/bundles/${bundle.id}/distribute`, {
        method: 'POST',
        body: {
          quantity: n,
          warehouseId,
          allowShortage,
          notes: 'Mobile distribute',
          idempotencyKey,
        },
      });
      Alert.alert('Distributed', `Shipped ${n} kit${n === 1 ? '' : 's'}.`, [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (e) {
      // A 4xx is the server REFUSING this request (shortage, permission,
      // archived bundle, conflict). Queueing it would replay a refusal every
      // minute forever while the operator was told it was saved — and a
      // shortage refusal would then silently distribute later once stock was
      // topped up. Show the server's message and stop.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        Alert.alert('Could not distribute', e.message);
        return;
      }
      // Transport failure, timeout or 5xx: the server may or may not have
      // committed. Queue the SAME key so the replay is absorbed if it did.
      await enqueue(
        'distribute_bundle',
        {
          bundleId: bundle.id,
          quantity: n,
          warehouseId,
          allowShortage,
          notes: 'Mobile distribute (offline)',
        },
        { idempotencyKey },
      );
      void syncNow();
      Alert.alert(
        'Queued',
        `Couldn't reach the server (${e instanceof Error ? e.message : 'network error'}). The distribution is saved locally and will sync when you're back online.`,
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } finally {
      setBusy(false);
    }
  }

  if (!bundle) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
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
        <Text style={styles.title}>{bundle.name}</Text>
        {bundle.sku ? <Text style={styles.sku}>{bundle.sku}</Text> : null}
      </View>

      <ScrollView contentContainerStyle={{ padding: space.md, paddingBottom: 120 }}>
        {bundle.preassemblyEnabled && (
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Pre-assembled kits</Text>
            <Text style={styles.statValue}>{bundle.phantomQty}</Text>
          </View>
        )}

        <Text style={styles.section}>Components</Text>
        {components.map((c) => {
          const item = items.get(c.itemId);
          return (
            <View key={c.itemId} style={styles.compRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.compName}>{item?.name ?? '(deleted)'}</Text>
                <Text style={styles.compSku}>{item?.sku ?? '—'}</Text>
              </View>
              <Text style={styles.compQty}>×{c.quantity}</Text>
              {c.isOptional ? (
                <Text style={styles.optionalTag}>opt</Text>
              ) : null}
            </View>
          );
        })}

        {canDistribute ? (
        <>
        <Text style={styles.section}>Distribute</Text>
        <View style={styles.distBox}>
          <Text style={styles.label}>Quantity</Text>
          <TextInput
            style={styles.input}
            keyboardType="numeric"
            value={qty}
            onChangeText={setQty}
          />

          <Text style={[styles.label, { marginTop: space.md }]}>Warehouse</Text>
          <View style={styles.whRow}>
            {warehouses.map((w) => (
              <Pressable
                key={w.id}
                onPress={() => setWarehouseId(w.id)}
                style={[
                  styles.whBtn,
                  w.id === warehouseId && { backgroundColor: theme.primary },
                ]}
              >
                <Text
                  style={[
                    styles.whLabel,
                    w.id === warehouseId && { color: '#fff' },
                  ]}
                >
                  {w.name}
                </Text>
              </Pressable>
            ))}
          </View>

          {preview && (
            <View style={[styles.preview, preview.hasShortage && styles.previewWarn]}>
              {preview.fromPhantom > 0 && (
                <Text style={styles.previewLine}>
                  {preview.fromPhantom} kit
                  {preview.fromPhantom === 1 ? '' : 's'} from pre-assembled stock
                </Text>
              )}
              {preview.fromComponents > 0 && (
                <Text style={styles.previewLine}>
                  {preview.fromComponents} kit
                  {preview.fromComponents === 1 ? '' : 's'} from individual
                  components
                </Text>
              )}
              {preview.hasShortage && (
                <Text style={styles.previewWarnText}>
                  ⚠ {preview.totalShortageUnits} unit
                  {preview.totalShortageUnits === 1 ? '' : 's'} short
                </Text>
              )}
            </View>
          )}

          <Pressable
            style={[
              styles.distBtn,
              preview?.hasShortage && { backgroundColor: theme.warning },
              busy && { opacity: 0.5 },
            ]}
            onPress={distribute}
            disabled={busy || !warehouseId}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.distBtnLabel}>
                {preview?.hasShortage ? 'Distribute with shortage' : 'Distribute'}
              </Text>
            )}
          </Pressable>
        </View>
        </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  backBtn: { paddingVertical: space.xs },
  backText: { color: theme.primary, fontSize: 14 },
  title: { color: theme.text, fontSize: 22, fontWeight: '700', marginTop: 4 },
  sku: { color: theme.textMuted, fontFamily: 'Menlo', fontSize: 12, marginTop: 2 },
  statBox: {
    backgroundColor: theme.card,
    borderRadius: radius.md,
    padding: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    marginBottom: space.md,
  },
  statLabel: { color: theme.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  statValue: { color: theme.text, fontSize: 28, fontWeight: '700', marginTop: 4 },
  section: { color: theme.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: space.md, marginBottom: space.sm },
  compRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.card,
    borderRadius: radius.sm,
    padding: space.md,
    marginBottom: space.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  compName: { color: theme.text, fontSize: 13, fontWeight: '600' },
  compSku: { color: theme.textMuted, fontSize: 11, fontFamily: 'Menlo', marginTop: 2 },
  compQty: { color: theme.text, fontSize: 14, fontWeight: '700', marginLeft: space.md },
  optionalTag: { color: theme.textMuted, fontSize: 10, marginLeft: 6, fontStyle: 'italic' },
  distBox: {
    backgroundColor: theme.card,
    borderRadius: radius.md,
    padding: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  label: { color: theme.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: theme.bgElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.text,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 16,
    marginTop: 4,
  },
  whRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: 4 },
  whBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.border,
  },
  whLabel: { color: theme.text, fontSize: 12, fontWeight: '600' },
  preview: {
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.border,
  },
  previewWarn: { backgroundColor: 'rgba(255, 159, 0, 0.10)', borderColor: theme.warning },
  previewLine: { color: theme.text, fontSize: 13, marginBottom: 2 },
  previewWarnText: { color: theme.warning, fontSize: 12, fontWeight: '700', marginTop: 4 },
  distBtn: {
    backgroundColor: theme.primary,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: space.md,
  },
  distBtnLabel: { color: '#fff', fontSize: 15, fontWeight: '700' },
});

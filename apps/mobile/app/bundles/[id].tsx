import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { TriangleAlert } from 'lucide-react-native';
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

import { Button } from '@/components/ui/button';
import { Card, Hair } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Pill } from '@/components/ui/pill';
import { Body, Display, Mono } from '@/components/ui/text';
import { api, ApiError } from '@/lib/api';
import {
  computeDistributionPreview,
  defaultDistributeWarehouseId,
  type DistributionPreview,
} from '@/lib/bundle-distribute-preview';
import { showDistributeCta } from '@/lib/cta-gating';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useRole } from '@/lib/use-role';
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
import { FONT, space } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Where the screen is before the distribute form: still reading the cache
 * ('loading'), done reading with no such bundle on this phone ('missing': a
 * link to a bundle that has not synced yet, or one taken off the cache), or
 * the bundle ('ready'). It used to spin for good when the bundle was not
 * cached, with no way back on screen.
 */
function bundleScreenState(
  bundle: CachedBundle | null,
  looked: boolean,
): 'loading' | 'missing' | 'ready' {
  if (bundle) return 'ready';
  return looked ? 'missing' : 'loading';
}

/**
 * One bundle: its components and, for a manager who may, distributing kits
 * from one warehouse, offline-capable through the outbox with the same
 * idempotency key.
 *
 * Look (redesign P5.9): the device's mode on the per-mode palette (it was
 * drawn from the light-only legacy theme and stayed light in dark mode), the
 * reference's cards and chips, Distribute as the ink button that commits the
 * work (keeping its words beside the spinner while it sends), and a warning
 * icon in place of the warning-sign glyph. Every word, gate, preview rule,
 * confirm and the queue path are unchanged.
 */
export default function BundleDetail() {
  const { c } = useTheme();
  const router = useRouter();
  // Distribute is a WRITE the server accepts from managers and above holding
  // bundles:distribute (0101). Staff hold the permission by default and were
  // shown a section whose Distribute the server refused; it now appears only
  // once the role is known to be manager or above (showDistributeCta, the web
  // bundle page's rule). Read-only visitors never see it.
  const perms = useEffectivePermissions();
  const { role } = useRole();
  const canDistribute = showDistributeCta(role, perms);
  const { id } = useLocalSearchParams<{ id: string }>();
  const [bundle, setBundle] = React.useState<CachedBundle | null>(null);
  // The cache has been read for this bundle (found or not).
  const [looked, setLooked] = React.useState(false);
  const [components, setComponents] = React.useState<CachedBundleComponent[]>([]);
  const [items, setItems] = React.useState<Map<string, CachedItem>>(new Map());
  const [warehouses, setWarehouses] = React.useState<CachedWarehouse[]>([]);

  const [qty, setQty] = React.useState('1');
  const [warehouseId, setWarehouseId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      if (!id) return;
      try {
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
        // Start on the warehouse the kit can actually be handed out from: the
        // pre-assembled kits' warehouse, else the one warehouse every component
        // sits in, else the first listed (0365 draws only from the chosen one).
        setWarehouseId(
          defaultDistributeWarehouseId({
            phantomWarehouseId: b.phantomWarehouseId,
            componentWarehouseIds: comps.map((c) => itemMap.get(c.itemId)?.warehouseId),
            warehouseIds: whs.map((w) => w.id),
          }),
        );
      } catch (e) {
        console.warn('[bundle] cache read failed:', e instanceof Error ? e.message : e);
      } finally {
        setLooked(true);
      }
    })();
  }, [id]);

  // Local preview: the same rule as distribute_bundle() since 0365 (see
  // bundle-distribute-preview.ts). Only stock in the CHOSEN warehouse counts,
  // for components and for pre-assembled kits alike, so it is recomputed
  // whenever the warehouse changes.
  const preview: DistributionPreview | null = React.useMemo(() => {
    if (!bundle) return null;
    return computeDistributionPreview({
      quantity: Number(qty),
      warehouseId,
      // The snapshot does not send the kit item's deleted_at, so a deleted
      // kit item's count still shows here; the server then builds the run
      // from components instead, or refuses it as short.
      phantom: { quantityOnHand: bundle.phantomQty, warehouseId: bundle.phantomWarehouseId },
      components: components.map((c) => {
        const item = items.get(c.itemId);
        return {
          itemId: c.itemId,
          perBundleQty: c.quantity,
          isOptional: c.isOptional,
          item: item
            ? {
                name: item.name,
                sku: item.sku,
                quantityOnHand: item.quantityOnHand,
                warehouseId: item.warehouseId,
              }
            : null,
        };
      }),
    });
  }, [bundle, components, items, qty, warehouseId]);

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
    // No id at all is a bundle this phone cannot hold either.
    const state = bundleScreenState(bundle, looked || !id);
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: c.paper }]} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={[styles.header, { borderBottomColor: c.hair }]}>
          <BackLink onPress={() => router.back()} />
        </View>
        {state === 'missing' ? (
          <View style={styles.body}>
            <Card padding={16}>
              <Body size={14.5} accessibilityRole="alert">
                This bundle is not on this phone. Go back to Bundles and tap Refresh, or check back
                after the next sync.
              </Body>
            </Card>
          </View>
        ) : (
          <View style={styles.center}>
            <ActivityIndicator color={c.ink} />
          </View>
        )}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.paper }]} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { borderBottomColor: c.hair }]}>
        <BackLink onPress={() => router.back()} />
        {/* The bundle's name is content: no Dynamic Type cap, as before. */}
        <Display size={26} maxFontSizeMultiplier={0} style={{ marginTop: 4 }}>
          {bundle.name}
        </Display>
        {bundle.sku ? (
          <Mono size={12} color={c.ink3} style={{ marginTop: 4 }}>
            {bundle.sku}
          </Mono>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: 120 }]}>
        {bundle.preassemblyEnabled && (
          <Card padding={16} style={{ marginBottom: space.md }}>
            <Mono size={10.5} tracking={0.12} upper color={c.ink3}>
              Pre-assembled kits
            </Mono>
            <Display size={28} maxFontSizeMultiplier={0} style={{ marginTop: 6 }}>
              {bundle.phantomQty}
            </Display>
          </Card>
        )}

        <SectionLabel>Components</SectionLabel>
        {/* One card, a hairline between components (the reference's list). */}
        {components.length > 0 ? (
          <Card>
            {components.map((comp, i) => {
              const item = items.get(comp.itemId);
              return (
                <View key={comp.itemId}>
                  {i > 0 ? <Hair /> : null}
                  <View style={styles.compRow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Body size={14} color={c.ink} style={{ fontFamily: FONT.display }}>
                        {item?.name ?? '(deleted)'}
                      </Body>
                      <Mono size={11.5} color={c.ink3} style={{ marginTop: 2 }}>
                        {item?.sku ?? '—'}
                      </Mono>
                    </View>
                    <Mono size={14} color={c.ink}>
                      ×{comp.quantity}
                    </Mono>
                    {comp.isOptional ? <Pill dot={false}>opt</Pill> : null}
                  </View>
                </View>
              );
            })}
          </Card>
        ) : null}

        {canDistribute ? (
          <>
            <SectionLabel>Distribute</SectionLabel>
            <Card padding={16}>
              {/* What is typed is content, so it grows with the text size as
                  this box always did: 0 lifts the shared Field's 24pt cap. */}
              <Field
                label="Quantity"
                accessibilityLabel="Quantity"
                keyboardType="numeric"
                value={qty}
                onChangeText={setQty}
                maxFontSizeMultiplier={0}
              />

              <Mono size={10} tracking={0.12} upper color={c.ink3} style={{ marginTop: space.md }}>
                Warehouse
              </Mono>
              <View style={styles.whRow}>
                {warehouses.map((w) => {
                  const active = w.id === warehouseId;
                  return (
                    <Pressable
                      key={w.id}
                      onPress={() => setWarehouseId(w.id)}
                      // A choice: VoiceOver hears its name and whether it is
                      // the one chosen (it heard neither).
                      accessibilityRole="button"
                      accessibilityLabel={w.name}
                      accessibilityState={{ selected: active }}
                      style={({ pressed }) => [
                        styles.whBtn,
                        {
                          borderColor: active ? c.ink : c.hair2,
                          backgroundColor: active ? c.ink : c.sunk,
                          opacity: pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      <Text style={[styles.whLabel, { color: active ? c.paper : c.ink }]}>
                        {w.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {preview && (
                <View
                  style={[
                    styles.preview,
                    preview.hasShortage
                      ? { backgroundColor: c.warnWash, borderColor: c.warnWash }
                      : { backgroundColor: c.sunk, borderColor: c.hair },
                  ]}
                >
                  {preview.fromPhantom > 0 && (
                    <Body size={13} color={c.ink}>
                      {preview.fromPhantom} kit{preview.fromPhantom === 1 ? '' : 's'} from
                      pre-assembled stock
                    </Body>
                  )}
                  {preview.fromComponents > 0 && (
                    <Body size={13} color={c.ink}>
                      {preview.fromComponents} kit{preview.fromComponents === 1 ? '' : 's'} from
                      individual components
                    </Body>
                  )}
                  {preview.hasShortage && (
                    <View style={styles.shortRow}>
                      <TriangleAlert size={14} color={c.warnText} strokeWidth={2} />
                      <Body size={13} color={c.warnText} style={styles.shortText}>
                        {preview.totalShortageUnits} unit
                        {preview.totalShortageUnits === 1 ? '' : 's'} short
                      </Body>
                    </View>
                  )}
                </View>
              )}

              {/* Distributing commits the work: the ink button (the
                  redesign's button rule). Its words stay beside the spinner
                  while it sends, so VoiceOver still hears what it is. */}
              <Button
                block
                onPress={distribute}
                disabled={busy || !warehouseId}
                leading={busy ? <ActivityIndicator color={c.paper} /> : undefined}
                style={{ marginTop: space.md }}
              >
                {preview?.hasShortage ? 'Distribute with shortage' : 'Distribute'}
              </Button>
            </Card>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/** "← Back": a button named Back in a frame at least 44pt tall, the one Back
 *  every state of this screen draws (it used to show only a spinner while the
 *  cache was read). */
function BackLink({ onPress }: { onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={styles.backBtn}
      accessibilityRole="button"
      accessibilityLabel="Back"
    >
      <Text style={[styles.backText, { color: c.ink }]}>← Back</Text>
    </Pressable>
  );
}

/** A section's label: the reference's muted uppercase line. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <Mono size={11} tracking={0.12} upper color={c.ink3} style={styles.section}>
      {children}
    </Mono>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // "← Back" is a button in a frame at least 44pt tall (it was the 25pt
  // text). The frame takes the header's 8pt top padding and the title's 4pt
  // gap (marginBottom -4), so the title sits about 7pt lower, nothing overlaps.
  backBtn: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    marginTop: -space.sm,
    marginBottom: -4,
  },
  backText: { fontFamily: FONT.display, fontSize: 14 },
  body: { padding: space.md },
  section: { marginTop: space.md, marginBottom: space.sm },
  compRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  whRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: 6 },
  // A warehouse choice: the reference's chip (radius 8), at least the 44pt
  // iOS minimum and growing with its words (minHeight, never height).
  whBtn: {
    minHeight: 44,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
  },
  whLabel: { fontFamily: FONT.display, fontSize: 13 },
  preview: {
    marginTop: space.md,
    padding: space.md,
    borderRadius: 10,
    borderWidth: 1,
    gap: 2,
  },
  shortRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  shortText: { flexShrink: 1, fontFamily: FONT.displaySemi },
});

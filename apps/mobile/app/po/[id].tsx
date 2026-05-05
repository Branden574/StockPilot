import { CameraView, useCameraPermissions } from 'expo-camera';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
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

interface PoLine {
  id: string;
  item_id: string;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost: number;
  item: {
    id: string;
    sku: string;
    name: string;
    barcode: string | null;
  } | null;
}

interface PoHeader {
  id: string;
  po_number: string;
  status: string;
  destination_warehouse_id: string | null;
  supplier_name: string | null;
}

interface DraftLine {
  /** Quantity received in this session — may differ from accepted/rejected. */
  received: string;
  rejected: string;
}

export default function PoReceiveScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();

  const [orgId, setOrgId] = React.useState<string | null>(null);
  const [header, setHeader] = React.useState<PoHeader | null>(null);
  const [lines, setLines] = React.useState<PoLine[]>([]);
  const [draft, setDraft] = React.useState<Record<string, DraftLine>>({});
  const [loading, setLoading] = React.useState(true);
  const [posting, setPosting] = React.useState(false);
  const [scannerOpen, setScannerOpen] = React.useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [highlightLineId, setHighlightLineId] = React.useState<string | null>(null);

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
    const [{ data: po }, { data: lineRows }] = await Promise.all([
      supabase
        .from('purchase_orders')
        .select(
          `id, po_number, status,
           supplier:suppliers!supplier_id (name),
           destination:locations!destination_location_id (warehouse_id)`,
        )
        .eq('organization_id', orgId)
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('purchase_order_items')
        .select(
          `id, item_id, quantity_ordered, quantity_received, unit_cost,
           item:inventory_items!item_id (id, sku, name, barcode)`,
        )
        .eq('purchase_order_id', id),
    ]);

    if (po) {
      const r = po as Record<string, unknown>;
      const supplier = r.supplier as { name: string } | { name: string }[] | null;
      const dest = r.destination as { warehouse_id: string | null } | { warehouse_id: string | null }[] | null;
      const supplierObj = Array.isArray(supplier) ? supplier[0] : supplier;
      const destObj = Array.isArray(dest) ? dest[0] : dest;
      setHeader({
        id: r.id as string,
        po_number: r.po_number as string,
        status: r.status as string,
        supplier_name: supplierObj?.name ?? null,
        destination_warehouse_id: destObj?.warehouse_id ?? null,
      });
    }

    const flatLines: PoLine[] = (lineRows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const itemField = r.item as
        | { id: string; sku: string; name: string; barcode: string | null }
        | { id: string; sku: string; name: string; barcode: string | null }[]
        | null;
      const item = Array.isArray(itemField) ? (itemField[0] ?? null) : (itemField ?? null);
      return {
        id: r.id as string,
        item_id: r.item_id as string,
        quantity_ordered: Number(r.quantity_ordered) || 0,
        quantity_received: Number(r.quantity_received) || 0,
        unit_cost: Number(r.unit_cost) || 0,
        item,
      };
    });
    setLines(flatLines);

    // Seed draft with empty values; user fills in only the lines they
    // actually receive in this session.
    const seed: Record<string, DraftLine> = {};
    for (const l of flatLines) {
      seed[l.id] = { received: '', rejected: '' };
    }
    setDraft(seed);
    setLoading(false);
  }, [id, orgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  function setField(lineId: string, field: keyof DraftLine, value: string) {
    setDraft((m) => ({
      ...m,
      [lineId]: { ...(m[lineId] ?? { received: '', rejected: '' }), [field]: value },
    }));
  }

  function fillRemaining(line: PoLine) {
    const remaining = Math.max(0, line.quantity_ordered - line.quantity_received);
    setField(line.id, 'received', String(remaining));
    setField(line.id, 'rejected', '0');
  }

  async function openScanner() {
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) {
        Alert.alert('Camera permission required', 'Allow camera access to scan barcodes.');
        return;
      }
    }
    setScannerOpen(true);
  }

  function onScanned({ data }: { data: string }) {
    const code = data.trim();
    if (!code) return;
    const match = lines.find(
      (l) => l.item?.barcode === code || l.item?.sku === code,
    );
    setScannerOpen(false);
    if (!match) {
      Alert.alert('Not on this PO', `${code} doesn't match any line.`);
      return;
    }
    fillRemaining(match);
    setHighlightLineId(match.id);
    setTimeout(() => setHighlightLineId(null), 2000);
  }

  async function postReceipt() {
    if (!header) return;
    if (!header.destination_warehouse_id) {
      Alert.alert(
        'No destination',
        'Set a destination warehouse on the web first, then come back.',
      );
      return;
    }

    const payloadLines = lines
      .map((l) => {
        const d = draft[l.id] ?? { received: '', rejected: '' };
        const received = Number(d.received) || 0;
        const rejected = Number(d.rejected) || 0;
        if (received <= 0) return null;
        return {
          po_line_id: l.id,
          qty_received: received,
          qty_accepted: Math.max(0, received - rejected),
          qty_rejected: rejected,
          unit_cost: l.unit_cost,
          notes: null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (payloadLines.length === 0) {
      Alert.alert('Enter quantities', 'Receive at least one line first.');
      return;
    }

    setPosting(true);
    const idempotencyKey = `mobile-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const { error } = await supabase.rpc('post_receipt_v2', {
      p_purchase_order_id: id,
      p_warehouse_id: header.destination_warehouse_id,
      p_lines: payloadLines,
      p_idempotency_key: idempotencyKey,
      p_request_hash: idempotencyKey,
      p_notes: null,
    });
    setPosting(false);

    if (error) {
      Alert.alert('Receive failed', error.message);
      return;
    }
    Alert.alert(
      'Posted',
      `Received ${payloadLines.length} line${payloadLines.length === 1 ? '' : 's'}.`,
      [{ text: 'OK', onPress: () => router.back() }],
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen
        options={{
          title: header?.po_number ?? 'PO',
          headerStyle: { backgroundColor: theme.bg },
          headerTintColor: theme.text,
        }}
      />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.primary} />
        </View>
      ) : (
        <>
          <View style={styles.headerBar}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{header?.po_number ?? 'PO'}</Text>
              <Text style={styles.subtitle}>
                {header?.supplier_name ?? 'No supplier'} ·{' '}
                {labelForStatus(header?.status ?? '')}
              </Text>
            </View>
            <Pressable
              onPress={openScanner}
              style={({ pressed }) => [styles.scanBtn, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.scanBtnText}>📷 Scan</Text>
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={{ padding: space.md, paddingBottom: 140 }}
          >
            {lines.length === 0 ? (
              <Text style={styles.muted}>No lines on this PO.</Text>
            ) : (
              lines.map((l) => {
                const remaining = Math.max(
                  0,
                  l.quantity_ordered - l.quantity_received,
                );
                const d = draft[l.id] ?? { received: '', rejected: '' };
                const isHighlighted = highlightLineId === l.id;
                return (
                  <View
                    key={l.id}
                    style={[
                      styles.lineCard,
                      isHighlighted && {
                        borderColor: theme.success,
                        shadowColor: theme.success,
                        shadowOpacity: 0.6,
                        shadowRadius: 8,
                      },
                    ]}
                  >
                    <Text style={styles.lineName} numberOfLines={2}>
                      {l.item?.name ?? 'Unknown item'}
                    </Text>
                    <Text style={styles.lineMeta}>
                      {l.item?.sku ?? '—'}
                      {l.item?.barcode ? ` · ${l.item.barcode}` : ''}
                    </Text>
                    <View style={styles.lineMetricsRow}>
                      <Metric label="Ordered" value={l.quantity_ordered} />
                      <Metric label="Already" value={l.quantity_received} />
                      <Metric label="Remaining" value={remaining} tone="primary" />
                    </View>
                    <View style={styles.qtyRow}>
                      <View style={styles.qtyField}>
                        <Text style={styles.qtyLabel}>Received</Text>
                        <TextInput
                          value={d.received}
                          onChangeText={(v) => setField(l.id, 'received', v)}
                          keyboardType="decimal-pad"
                          placeholder="0"
                          placeholderTextColor={theme.textMuted}
                          style={styles.qtyInput}
                        />
                      </View>
                      <View style={styles.qtyField}>
                        <Text style={styles.qtyLabel}>Rejected</Text>
                        <TextInput
                          value={d.rejected}
                          onChangeText={(v) => setField(l.id, 'rejected', v)}
                          keyboardType="decimal-pad"
                          placeholder="0"
                          placeholderTextColor={theme.textMuted}
                          style={styles.qtyInput}
                        />
                      </View>
                      <Pressable
                        onPress={() => fillRemaining(l)}
                        style={({ pressed }) => [
                          styles.allBtn,
                          pressed && { opacity: 0.7 },
                        ]}
                      >
                        <Text style={styles.allBtnText}>All</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>

          <View style={styles.footer}>
            <Pressable
              onPress={postReceipt}
              disabled={posting}
              style={({ pressed }) => [
                styles.postBtn,
                pressed && { opacity: 0.85 },
                posting && { opacity: 0.6 },
              ]}
            >
              <Text style={styles.postBtnText}>
                {posting ? 'Posting…' : 'Post receipt'}
              </Text>
            </Pressable>
          </View>
        </>
      )}

      <Modal
        visible={scannerOpen}
        animationType="slide"
        onRequestClose={() => setScannerOpen(false)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            onBarcodeScanned={onScanned}
            barcodeScannerSettings={{
              barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'],
            }}
          />
          <Pressable
            onPress={() => setScannerOpen(false)}
            style={styles.scanCloseBtn}
          >
            <Text style={styles.scanCloseText}>Cancel</Text>
          </Pressable>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'primary';
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text
        style={[
          styles.metricValue,
          tone === 'primary' && { color: theme.primary },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

function labelForStatus(s: string): string {
  if (s === 'expected_inbound') return 'Expected';
  if (s === 'ordered') return 'Ordered';
  if (s === 'partially_received') return 'Partial';
  return s;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  title: { color: theme.text, fontSize: 20, fontWeight: '700', fontFamily: 'Menlo' },
  subtitle: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  muted: { color: theme.textMuted, padding: space.lg, textAlign: 'center' },
  scanBtn: {
    backgroundColor: theme.primary,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  scanBtnText: { color: '#fff', fontWeight: '700' },
  lineCard: {
    backgroundColor: theme.card,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    padding: space.md,
    marginBottom: space.sm,
  },
  lineName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  lineMeta: { color: theme.textMuted, fontSize: 11, fontFamily: 'Menlo', marginTop: 2 },
  lineMetricsRow: {
    flexDirection: 'row',
    marginTop: space.sm,
    gap: space.md,
  },
  metric: {},
  metricLabel: {
    color: theme.textMuted,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  metricValue: {
    color: theme.text,
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    marginTop: 2,
  },
  qtyRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    marginTop: space.md,
  },
  qtyField: { flex: 1 },
  qtyLabel: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  qtyInput: {
    backgroundColor: theme.bgElevated,
    color: theme.text,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  allBtn: {
    backgroundColor: theme.bgElevated,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  allBtnText: { color: theme.text, fontWeight: '700' },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.md,
    backgroundColor: theme.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  postBtn: {
    backgroundColor: theme.success,
    paddingVertical: space.md + 2,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  postBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  scanCloseBtn: {
    position: 'absolute',
    top: 60,
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  scanCloseText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});

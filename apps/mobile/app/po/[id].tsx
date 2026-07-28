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

import type { CountingUnit, SizeScaleValueOrder } from '@stockpilot/core';

import { PoAttachments } from '@/components/po-attachments';
import { useAuth } from '@/lib/auth-context';
import { useEnabledModules } from '@/lib/enabled-modules';
import {
  buildPoBlocks,
  poOutstanding,
  poRunSubtotal,
  poRunSubtotalLabel,
  poSizeLabel,
  type PoRunGroup,
} from '@/lib/po-size-run';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/lib/use-org';
import { radius, space, theme } from '@/lib/theme';

interface PoLine {
  id: string;
  item_id: string;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost: number;
  /** Sports variant identity (0298). NULL on every line in every non-sports org. */
  groupId: string | null;
  variantSize: string | null;
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

interface ReceiptHistoryItem {
  id: string;
  receipt_number: string;
  status: string;
  received_at: string | null;
  received_by_name: string;
  accepted: number;
  rejected: number;
}

export default function PoReceiveScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();

  const { orgId } = useOrg();
  const [header, setHeader] = React.useState<PoHeader | null>(null);
  const [lines, setLines] = React.useState<PoLine[]>([]);
  const [groups, setGroups] = React.useState<Record<string, PoRunGroup>>({});
  const [receipts, setReceipts] = React.useState<ReceiptHistoryItem[]>([]);
  const [draft, setDraft] = React.useState<Record<string, DraftLine>>({});
  const [loading, setLoading] = React.useState(true);
  /** A READ that failed, surfaced in place of the screen. Never a silent empty
   *  list — see the fail-loud note in `load`. */
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [posting, setPosting] = React.useState(false);
  // Synchronous re-entry guard: blocks a double-tap from firing a second
  // post before React re-renders the disabled button (each post would
  // otherwise carry its own key = a duplicate receipt = double-counted stock).
  const submittingRef = React.useRef(false);
  // One idempotency key per receive-intent, stable across retries so a network
  // blip after a server-side success doesn't post a second receipt. Reset only
  // after a successful post (the screen navigates away on success anyway).
  const idemKeyRef = React.useRef<string | null>(null);
  const [scannerOpen, setScannerOpen] = React.useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [highlightLineId, setHighlightLineId] = React.useState<string | null>(null);


  const enabledModules = useEnabledModules();
  const sportsEnabled = enabledModules.has('sports');
  // Read via a ref inside `load`, not as a useCallback dependency (review
  // fix). `useEnabledModules()` starts with an empty set and flips this
  // boolean once its async fetch resolves — depending on the VALUE gave
  // `load` a new identity on that flip alone, re-ran the mount effect below,
  // and reseeded `draft`, wiping any receiving quantity the user had already
  // typed while modules were still loading. The ref always reads current
  // without making a module-list refresh a reason to reload.
  const sportsEnabledRef = React.useRef(sportsEnabled);
  sportsEnabledRef.current = sportsEnabled;

  const load = React.useCallback(async () => {
    if (!id || !orgId) return;
    setLoading(true);
    setLoadError(null);
    const [{ data: po, error: poErr }, { data: lineRows, error: linesErr }] = await Promise.all([
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
           item:inventory_items!item_id (id, sku, name, barcode, group_id, variant_size)`,
        )
        .eq('purchase_order_id', id),
    ]);

    // FAIL LOUD (release-order rule). Both reads were destructured for `data`
    // alone, so any error rendered an EMPTY receiving screen that said "No lines
    // on this PO." — indistinguishable from a PO that genuinely has none. That
    // is not hypothetical: this branch WIDENED the line read with 0298's
    // `group_id` / `variant_size`, and against a database that has not taken
    // 0294+ yet PostgREST refuses the whole select. A receiving screen showing
    // nothing is how stock goes uncounted, so it must say what happened instead.
    if (poErr || linesErr) {
      setLoadError(
        `${(poErr ?? linesErr)!.message}. If the app was just updated, the server may still be catching up — pull to retry.`,
      );
      setLines([]);
      setGroups({});
      setLoading(false);
      return;
    }

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

    type ItemEmbed = {
      id: string;
      sku: string;
      name: string;
      barcode: string | null;
      group_id?: string | null;
      variant_size?: string | null;
    };
    const flatLines: PoLine[] = (lineRows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const itemField = r.item as ItemEmbed | ItemEmbed[] | null;
      const item = Array.isArray(itemField) ? (itemField[0] ?? null) : (itemField ?? null);
      return {
        id: r.id as string,
        item_id: r.item_id as string,
        quantity_ordered: Number(r.quantity_ordered) || 0,
        quantity_received: Number(r.quantity_received) || 0,
        unit_cost: Number(r.unit_cost) || 0,
        groupId: item?.group_id ?? null,
        variantSize: item?.variant_size ?? null,
        item: item
          ? { id: item.id, sku: item.sku, name: item.name, barcode: item.barcode }
          : null,
      };
    });
    setLines(flatLines);

    // Size-run grouping (Task 16), mirroring the web receive dialog. Only when
    // the org has the sports module AND a line actually carries a group — for
    // every other PO this is zero extra queries and the flat cards below stay
    // exactly as they are.
    const groupIds = Array.from(
      new Set(flatLines.map((l) => l.groupId).filter((v): v is string => Boolean(v))),
    );
    if (groupIds.length > 0 && sportsEnabledRef.current) {
      const { data: groupRows, error: groupErr } = await supabase
        .from('product_groups')
        .select('id, name, default_counting_unit, size_scale_id')
        .eq('organization_id', orgId)
        .in('id', groupIds)
        .is('deleted_at', null);

      // Degrade to flat cards on a read failure rather than blocking receiving
      // — the grouping is presentation, the receipt is the job.
      if (groupErr) {
        console.warn('[po] size-run group lookup failed', groupErr.message);
        setGroups({});
      } else {
        const rows = (groupRows ?? []) as Record<string, unknown>[];
        const scaleIds = Array.from(
          new Set(
            rows
              .map((g) => g.size_scale_id as string | null)
              .filter((v): v is string => Boolean(v)),
          ),
        );
        const valuesByScale = new Map<string, SizeScaleValueOrder[]>();
        if (scaleIds.length > 0) {
          const { data: valueRows } = await supabase
            .from('size_scale_values')
            .select('size_scale_id, value, normalized, sort_order')
            .in('size_scale_id', scaleIds)
            .order('sort_order', { ascending: true });
          for (const v of (valueRows ?? []) as Record<string, unknown>[]) {
            const key = v.size_scale_id as string;
            const entry: SizeScaleValueOrder = {
              value: v.value as string,
              normalized: (v.normalized as string | null) ?? null,
              sortOrder: Number(v.sort_order),
            };
            const arr = valuesByScale.get(key);
            if (arr) arr.push(entry);
            else valuesByScale.set(key, [entry]);
          }
        }
        const next: Record<string, PoRunGroup> = {};
        for (const g of rows) {
          const scaleId = g.size_scale_id as string | null;
          next[g.id as string] = {
            name: g.name as string,
            countingUnit: g.default_counting_unit as CountingUnit,
            sizeValues: scaleId ? (valuesByScale.get(scaleId) ?? []) : [],
          };
        }
        setGroups(next);
      }
    } else {
      setGroups({});
    }

    // Seed draft with empty values; user fills in only the lines they
    // actually receive in this session.
    const seed: Record<string, DraftLine> = {};
    for (const l of flatLines) {
      seed[l.id] = { received: '', rejected: '' };
    }
    setDraft(seed);

    // Receipt history (who / when / qty) — the audit log shown below the
    // receive form, mirroring the web PO detail page. Read-only + org-scoped.
    const { data: receiptRows } = await supabase
      .from('receipts')
      .select('id, receipt_number, status, received_at, received_by')
      .eq('organization_id', orgId)
      .eq('purchase_order_id', id)
      .order('received_at', { ascending: false });

    const receiptIds = (receiptRows ?? []).map((r) => (r as Record<string, unknown>).id as string);
    const totalsById = new Map<string, { accepted: number; rejected: number }>();
    const nameById = new Map<string, string>();
    if (receiptIds.length > 0) {
      const { data: receiptLines } = await supabase
        .from('receipt_lines')
        .select('receipt_id, qty_accepted_base, qty_rejected_base')
        .in('receipt_id', receiptIds)
        // Display-only totals; cap well above any realistic PO so PostgREST's
        // default 1000-row window can't silently understate the history.
        .limit(5000);
      for (const rl of receiptLines ?? []) {
        const r = rl as Record<string, unknown>;
        const rid = r.receipt_id as string;
        const t = totalsById.get(rid) ?? { accepted: 0, rejected: 0 };
        t.accepted += Number(r.qty_accepted_base) || 0;
        t.rejected += Number(r.qty_rejected_base) || 0;
        totalsById.set(rid, t);
      }
      const receiverIds = Array.from(
        new Set(
          (receiptRows ?? [])
            .map((r) => (r as Record<string, unknown>).received_by as string | null)
            .filter((v): v is string => Boolean(v)),
        ),
      );
      if (receiverIds.length > 0) {
        const { data: profs } = await supabase
          .from('user_profiles')
          .select('id, full_name, email')
          .in('id', receiverIds);
        for (const p of profs ?? []) {
          const pr = p as Record<string, unknown>;
          nameById.set(
            pr.id as string,
            ((pr.full_name as string | null) || (pr.email as string | null) || 'Unknown').trim(),
          );
        }
      }
    }
    setReceipts(
      (receiptRows ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const t = totalsById.get(r.id as string) ?? { accepted: 0, rejected: 0 };
        return {
          id: r.id as string,
          receipt_number: r.receipt_number as string,
          status: r.status as string,
          received_at: (r.received_at as string | null) ?? null,
          received_by_name: nameById.get(r.received_by as string) ?? 'Unknown',
          accepted: t.accepted,
          rejected: t.rejected,
        };
      }),
    );

    setLoading(false);
    // sportsEnabled deliberately excluded — see sportsEnabledRef above. Only
    // the PO id / org context re-key the draft.
  }, [id, orgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Runs + loose rows, through the SAME core rule the web dialog uses. With no
  // groups (every non-sports PO) every block is loose and the flat cards below
  // render exactly as they always have.
  const blocks = React.useMemo(() => buildPoBlocks(lines, groups), [lines, groups]);

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

    // App-side over-receive guard. NOTE: the RPC no longer blocks over-receipt
    // — migration 0285 (owner decision 2026-07-21) removed the
    // over_receive_blocked guard because vendors legitimately over-ship, and
    // the web receive dialog allows it. This check is therefore MOBILE-ONLY
    // policy, not a mirror of a server rule. The RPC still refuses an
    // already-'received' PO (po_already_closed).
    for (const l of lines) {
      const entered = Number((draft[l.id] ?? { received: '' }).received) || 0;
      const remaining = Math.max(0, l.quantity_ordered - l.quantity_received);
      if (entered > remaining) {
        Alert.alert(
          'Too many',
          `${l.item?.name ?? 'This item'} has only ${remaining} left to receive — you entered ${entered}. Receiving more would over-receive the PO.`,
        );
        return;
      }
    }

    const payloadLines = lines
      .map((l) => {
        const d = draft[l.id] ?? { received: '', rejected: '' };
        const received = Number(d.received) || 0;
        if (received <= 0) return null;
        return {
          po_line_id: l.id,
          qty_received: received,
          // Everything received goes into usable stock — no separate reject step.
          qty_accepted: received,
          qty_rejected: 0,
          unit_cost: l.unit_cost,
          notes: null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (payloadLines.length === 0) {
      Alert.alert('Enter quantities', 'Receive at least one line first.');
      return;
    }

    // Re-entry guard — checked synchronously so a rapid double-tap can't fire
    // two posts before the button's disabled state re-renders.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setPosting(true);

    // Stable key for this intent: reused on retry so the RPC dedupes a
    // post that actually succeeded server-side but failed to ack to the client.
    if (!idemKeyRef.current) {
      idemKeyRef.current = `mobile-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    const idempotencyKey = idemKeyRef.current;

    const { error } = await supabase.rpc('post_receipt_v2', {
      p_purchase_order_id: id,
      p_warehouse_id: header.destination_warehouse_id,
      p_lines: payloadLines,
      p_idempotency_key: idempotencyKey,
      p_request_hash: idempotencyKey,
      p_notes: null,
    });
    setPosting(false);
    submittingRef.current = false;

    if (error) {
      Alert.alert('Receive failed', error.message);
      return;
    }
    // Posted: retire the key so a later receive against this PO is a new intent.
    idemKeyRef.current = null;
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
      ) : loadError ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Could not load this PO</Text>
          <Text style={styles.errorBody}>{loadError}</Text>
          <Pressable
            onPress={() => void load()}
            style={({ pressed }) => [styles.scanBtn, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.scanBtnText}>Try again</Text>
          </Pressable>
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
              blocks.map((block) => {
                if (block.kind === 'run') {
                  const group = groups[block.groupId];
                  if (group) {
                    return (
                      <SizeRunCard
                        key={block.groupId}
                        group={group}
                        lines={block.lines}
                        draft={draft}
                        highlightLineId={highlightLineId}
                        onChangeReceived={(lineId, v) => setField(lineId, 'received', v)}
                        onReceiveAll={() => {
                          for (const l of block.lines) {
                            setField(l.id, 'received', String(poOutstanding(l)));
                            setField(l.id, 'rejected', '0');
                          }
                        }}
                      />
                    );
                  }
                }
                return block.lines.map((l) => {
                const remaining = Math.max(
                  0,
                  l.quantity_ordered - l.quantity_received,
                );
                const d = draft[l.id] ?? { received: '', rejected: '' };
                // Variance = what's still outstanding after this receipt.
                const variance = remaining - (Number(d.received) || 0);
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
                      <Metric label="Variance" value={variance} tone="primary" />
                    </View>
                    {remaining === 0 ? (
                      <Text style={styles.fullyReceived}>
                        ✓ Fully received — nothing left to receive on this line.
                      </Text>
                    ) : (
                      <View style={styles.qtyRow}>
                        <View style={styles.qtyField}>
                          <Text style={styles.qtyLabel}>Received now</Text>
                          <TextInput
                            value={d.received}
                            onChangeText={(v) => setField(l.id, 'received', v)}
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
                    )}
                  </View>
                );
                });
              })
            )}

            {receipts.length > 0 && (
              <View style={styles.historySection}>
                <Text style={styles.historyHeading}>Receipt history</Text>
                {receipts.map((r) => (
                  <View key={r.id} style={styles.historyCard}>
                    <View style={styles.historyTopRow}>
                      <Text style={styles.historyNumber}>
                        {r.receipt_number}
                        {r.status !== 'posted' ? ` · ${r.status}` : ''}
                      </Text>
                      <Text style={styles.historyDate}>{formatReceiptDate(r.received_at)}</Text>
                    </View>
                    <Text style={styles.historyMeta}>
                      by {r.received_by_name} · {r.accepted} accepted
                      {r.rejected > 0 ? ` · ${r.rejected} rejected` : ''}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            <Text style={styles.attachHint}>
              Documents save as soon as you add them — you don&apos;t need to post a
              receipt to keep an attachment.
            </Text>
            <PoAttachments poId={id} />
          </ScrollView>

          <View style={styles.footer}>
            {(() => {
              const anyReceivable = lines.some(
                (l) => l.quantity_ordered - l.quantity_received > 0,
              );
              return (
                <Pressable
                  onPress={postReceipt}
                  disabled={posting || !anyReceivable}
                  style={({ pressed }) => [
                    styles.postBtn,
                    pressed && { opacity: 0.85 },
                    (posting || !anyReceivable) && { opacity: 0.5 },
                  ]}
                >
                  <Text style={styles.postBtnText}>
                    {posting
                      ? 'Posting…'
                      : anyReceivable
                        ? 'Post receipt'
                        : 'Fully received'}
                  </Text>
                </Pressable>
              );
            })()}
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

/**
 * One size run: a heading, one row per size in scale order, and a subtotal in
 * the group's own counting unit — the native mirror of the web
 * `SizeRunReceiveGrid`.
 *
 * Each size still posts as its own `p_lines` entry, so `post_receipt_v2` sees
 * exactly what it sees today. Mobile never sends `lots` or `serials`, which is
 * fine for quantity variants and now also for `serial_optional` (0295/0296);
 * an item that is strictly `serial` still has to be received on the web, and
 * that is unchanged by this layout.
 */
function SizeRunCard({
  group,
  lines,
  draft,
  highlightLineId,
  onChangeReceived,
  onReceiveAll,
}: {
  group: PoRunGroup;
  lines: PoLine[];
  draft: Record<string, DraftLine>;
  highlightLineId: string | null;
  onChangeReceived: (lineId: string, value: string) => void;
  onReceiveAll: () => void;
}) {
  const received = React.useMemo(() => {
    const m: Record<string, string> = {};
    for (const l of lines) m[l.id] = draft[l.id]?.received ?? '';
    return m;
  }, [lines, draft]);
  const subtotal = poRunSubtotal(lines, received);
  const totalOrdered = lines.reduce((s, l) => s + l.quantity_ordered, 0);
  const anyOutstanding = lines.some((l) => poOutstanding(l) > 0);

  return (
    <View style={styles.runCard}>
      <View style={styles.runHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.runName} numberOfLines={2}>
            {group.name}
          </Text>
          <Text style={styles.runMeta}>
            Size run · {lines.length} sizes · {totalOrdered} ordered
          </Text>
        </View>
        {anyOutstanding && (
          <Pressable
            onPress={onReceiveAll}
            style={({ pressed }) => [styles.allBtn, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.allBtnText}>All</Text>
          </Pressable>
        )}
      </View>

      {lines.map((l) => {
        const outstanding = poOutstanding(l);
        const value = draft[l.id]?.received ?? '';
        return (
          <View
            key={l.id}
            style={[
              styles.runRow,
              highlightLineId === l.id && { borderColor: theme.success, borderWidth: 1 },
            ]}
          >
            <Text style={styles.runSize}>{poSizeLabel(l.variantSize)}</Text>
            <Text style={styles.runOrdered}>
              {l.quantity_ordered} ord · {l.quantity_received} rec
            </Text>
            {outstanding === 0 ? (
              <Text style={styles.runDone}>✓ Full</Text>
            ) : (
              <TextInput
                value={value}
                onChangeText={(v) => onChangeReceived(l.id, v)}
                keyboardType="decimal-pad"
                placeholder="0"
                placeholderTextColor={theme.textMuted}
                style={styles.runInput}
                accessibilityLabel={`Receiving size ${poSizeLabel(l.variantSize)}`}
              />
            )}
          </View>
        );
      })}

      <Text style={styles.runSubtotal}>
        {poRunSubtotalLabel(subtotal, group.countingUnit)}
      </Text>
    </View>
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

function formatReceiptDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
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
  errorTitle: {
    color: theme.text,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: space.xs,
    textAlign: 'center',
  },
  errorBody: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: space.lg,
    marginBottom: space.md,
  },
  fullyReceived: {
    color: theme.success,
    fontSize: 13,
    fontWeight: '600',
    marginTop: space.sm,
  },
  attachHint: {
    color: theme.textMuted,
    fontSize: 12,
    paddingHorizontal: space.md,
    marginTop: space.lg,
    marginBottom: space.xs,
    textAlign: 'center',
  },
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
  runCard: {
    backgroundColor: theme.card,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    padding: space.md,
    marginBottom: space.sm,
  },
  runHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginBottom: space.sm,
  },
  runName: { color: theme.text, fontSize: 15, fontWeight: '700' },
  runMeta: { color: theme.textMuted, fontSize: 11, marginTop: 2 },
  runRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
  },
  // Dynamic Type: all three of these were HARD widths. At 2x a 15pt size label
  // is ~39pt, so `XXXL` fractured inside the 64pt cell, and `runOrdered`
  // (flex: 1) was the only shrinkable child in the row, so it absorbed the
  // whole deficit and collapsed to nothing. minWidth lets each cell grow to its
  // own content while still column-aligning at default size.
  runSize: {
    color: theme.text,
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    minWidth: 64,
  },
  runOrdered: { color: theme.textMuted, fontSize: 11, flex: 1, minWidth: 0 },
  runDone: {
    color: theme.success,
    fontSize: 12,
    fontWeight: '700',
    minWidth: 96,
    textAlign: 'right',
  },
  runInput: {
    backgroundColor: theme.bgElevated,
    color: theme.text,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
    minWidth: 96,
    textAlign: 'right',
  },
  runSubtotal: {
    color: theme.text,
    fontSize: 12,
    fontWeight: '600',
    marginTop: space.sm,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  lineName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  lineMeta: { color: theme.textMuted, fontSize: 11, fontFamily: 'Menlo', marginTop: 2 },
  // Dynamic Type: Ordered / Already / Variance. The three uppercase labels need
  // ~336pt at 2x against ~345pt of card interior and overflow just past that,
  // and nothing in the row is shrinkable — so it wraps instead.
  lineMetricsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
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
  historySection: { marginTop: space.lg },
  historyHeading: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: space.sm,
  },
  historyCard: {
    backgroundColor: theme.card,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    padding: space.md,
    marginBottom: space.sm,
  },
  historyTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  historyNumber: {
    color: theme.text,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'Menlo',
  },
  historyDate: { color: theme.textMuted, fontSize: 11 },
  historyMeta: { color: theme.textMuted, fontSize: 12, marginTop: 4 },
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

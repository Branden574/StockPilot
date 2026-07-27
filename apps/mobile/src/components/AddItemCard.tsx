import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { listWarehouses, type CachedWarehouse } from '@/lib/db-reads';
import { buildQuickAddInput, describeFailure, submitCreateItem } from '@/lib/item-create';
import { radius, space, theme } from '@/lib/theme';

import type { User } from '@supabase/supabase-js';

/**
 * UPC enrichment payload returned by /api/v1/items/upc-lookup. Parallel
 * to IsbnLookupResult — same shape style, but for general products
 * (UPC/EAN) instead of books (ISBN). Description may have come from
 * the AI fallback; modelNumber NEVER does (AI is description-only).
 */
export interface UpcLookupResult {
  upc: string;
  source: 'local' | 'upcitemdb' | 'ai-fallback' | 'not_found';
  existingItem: {
    id: string;
    name: string;
  } | null;
  enrichment: {
    name: string;
    description: string | null;
    brand: string | null;
    modelNumber: string | null;
    imageUrl: string | null;
  } | null;
}

interface Props {
  user: User | null;
  result: UpcLookupResult;
  onCreated: (id: string) => void;
  onCancel: () => void;
}

/**
 * One-tap "add this product to inventory" card. Used by the scanner
 * when an unknown UPC scans in and /api/v1/items/upc-lookup returns
 * external enrichment data (or a manual draft when nothing was found).
 *
 * Fields: Name, Model number (NEW — from the manufacturer), SKU,
 * Description (read-only preview, editable in next save), Warehouse,
 * Initial quantity.
 *
 * The AI-source tag is shown when description was AI-generated so the
 * user knows to review it before tapping save.
 *
 * This card holds NO creation rules. It collects strings and hands them to
 * src/lib/item-create.ts, which parses them with the SAME zod the web uses and
 * POSTs /api/v1/items. It used to raw-insert inventory_items and guess the org
 * from the first organization_members row — see buildQuickAddInput's doc.
 */
export function AddItemCard({ user, result, onCancel, onCreated }: Props) {
  const isExisting = Boolean(result.existingItem);
  const enrichment = result.enrichment ?? {
    name: '',
    description: null,
    brand: null,
    modelNumber: null,
    imageUrl: null,
  };
  const [name, setName] = React.useState(enrichment.name ?? '');
  const [modelNumber, setModelNumber] = React.useState(enrichment.modelNumber ?? '');
  const [sku, setSku] = React.useState(suggestedSku(result.upc));
  const [qty, setQty] = React.useState('1');
  const [warehouseId, setWarehouseId] = React.useState<string | null>(null);
  const [warehouses, setWarehouses] = React.useState<CachedWarehouse[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      const list = await listWarehouses();
      setWarehouses(list);
      if (list.length > 0 && !warehouseId) setWarehouseId(list[0]?.id ?? null);
    })();

  }, []);

  if (isExisting) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Already in inventory</Text>
        <Text style={styles.body}>
          {result.existingItem!.name} — open it in the app to adjust stock.
        </Text>
        <Pressable style={styles.btnGhost} onPress={onCancel}>
          <Text style={styles.btnGhostLabel}>Close</Text>
        </Pressable>
      </View>
    );
  }

  async function create() {
    if (!user) return;
    if (!name.trim()) {
      Alert.alert('Name required', 'Type a product name before saving.');
      return;
    }

    // Brand rides along as a custom field, exactly as before. Everything else
    // — the SKU fallback, the NULL barcode for a codeless photo ID, the
    // opening quantity landing in UNPLACED via the initial movement — is the
    // shared create path's, not this card's.
    const customFields: Record<string, unknown> = {};
    if (enrichment.brand) customFields.brand = enrichment.brand;

    const built = buildQuickAddInput({
      itemType: 'product',
      name,
      sku,
      barcode: result.upc,
      modelNumber,
      description: enrichment.description ?? null,
      quantity: qty,
      warehouseId,
      customFields,
    });
    if (!built.ok) {
      Alert.alert('Check the form', describeFailure(built));
      return;
    }

    setBusy(true);
    try {
      const { id } = await submitCreateItem(built.input);
      onCreated(id);
    } catch (e) {
      Alert.alert('Could not add', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        {enrichment.imageUrl ? (
          <Image source={{ uri: enrichment.imageUrl }} style={styles.cover} />
        ) : (
          <View style={[styles.cover, styles.coverPlaceholder]}>
            <Text style={styles.coverPlaceholderText}>No image</Text>
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.isbnLabel}>UPC</Text>
          <Text style={styles.isbnValue}>{result.upc}</Text>
          {result.source === 'ai-fallback' && (
            <Text style={styles.warn}>
              Description was AI-generated — review before saving.
            </Text>
          )}
          {result.source === 'not_found' && (
            <Text style={styles.warn}>
              No external match. Fill in the details by hand.
            </Text>
          )}
          {enrichment.brand && (
            <Text style={styles.body}>{enrichment.brand}</Text>
          )}
        </View>
      </View>

      <Field label="Name">
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="Wireless mouse"
          placeholderTextColor={theme.textMuted}
        />
      </Field>
      <Field label="Model #">
        <TextInput
          style={styles.input}
          value={modelNumber}
          onChangeText={setModelNumber}
          placeholder="e.g. MX432LL/A"
          placeholderTextColor={theme.textMuted}
        />
      </Field>
      <View style={styles.row}>
        <Field label="SKU">
          <TextInput
            style={styles.input}
            value={sku}
            onChangeText={setSku}
            autoCapitalize="characters"
          />
        </Field>
        <Field label="Initial qty">
          <TextInput
            style={styles.input}
            value={qty}
            onChangeText={setQty}
            keyboardType="numeric"
          />
        </Field>
      </View>
      {enrichment.description && (
        <Field label="Description preview">
          <Text style={styles.body} numberOfLines={4}>
            {enrichment.description}
          </Text>
        </Field>
      )}
      <Field label="Warehouse">
        <View style={styles.warehouseRow}>
          {warehouses.length === 0 ? (
            <Text style={styles.body}>No warehouses cached. Refresh and try again.</Text>
          ) : (
            warehouses.map((w) => (
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
            ))
          )}
        </View>
      </Field>

      <View style={styles.actions}>
        <Pressable style={styles.btnGhost} onPress={onCancel} disabled={busy}>
          <Text style={styles.btnGhostLabel}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.btnPrimary, busy && { opacity: 0.5 }]}
          onPress={create}
          disabled={busy || !warehouseId}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.btnPrimaryLabel}>Add to inventory</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ flex: 1, marginTop: space.md }}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

function suggestedSku(upc: string): string {
  const cleaned = upc.replace(/[^0-9]/g, '');
  // No readable code (Photo ID without a visible barcode) → time-based suffix
  // so two such adds never collide on a shared bare 'ITEM-' SKU.
  if (!cleaned) return `ITEM-${Date.now().toString().slice(-8)}`;
  return `ITEM-${cleaned.slice(-8)}`;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.card,
    borderRadius: radius.xl,
    padding: space.lg,
    borderWidth: 1,
    borderColor: theme.border,
  },
  headerRow: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  cover: { width: 72, height: 96, borderRadius: radius.sm, backgroundColor: theme.bgElevated },
  coverPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  coverPlaceholderText: { color: theme.textMuted, fontSize: 10 },
  isbnLabel: { color: theme.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  isbnValue: { color: theme.text, fontFamily: 'Menlo', fontSize: 14, marginTop: 2 },
  warn: { color: theme.warning, fontSize: 11, marginTop: space.xs },
  title: { color: theme.text, fontSize: 18, fontWeight: '700' },
  body: { color: theme.textMuted, fontSize: 13, marginTop: space.xs },
  label: { color: theme.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: theme.bgElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.text,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 14,
    marginTop: 4,
  },
  row: { flexDirection: 'row', gap: space.md },
  warehouseRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', marginTop: 4 },
  whBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.border,
  },
  whLabel: { color: theme.text, fontSize: 12, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
  btnGhost: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
  },
  btnGhostLabel: { color: theme.text, fontWeight: '600', fontSize: 14 },
  btnPrimary: {
    flex: 2,
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: theme.primary,
    alignItems: 'center',
  },
  btnPrimaryLabel: { color: '#fff', fontWeight: '700', fontSize: 14 },
});

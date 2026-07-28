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

export interface IsbnLookupResult {
  isbn: string;
  existingItem: {
    id: string;
    sku: string;
    name: string;
    quantityOnHand: number;
  } | null;
  metadata: {
    title?: string | null;
    authors?: string[] | null;
    publisher?: string | null;
    description?: string | null;
    coverUrl?: string | null;
    grade?: string | null;
  } | null;
}

interface Props {
  user: User | null;
  /** Either an ISBN-lookup result, or a free-form draft when nothing was found. */
  result: IsbnLookupResult;
  onCreated: (id: string) => void;
  onCancel: () => void;
}

/**
 * One-tap "add this book to inventory" card. Used by:
 *   • the standalone scanner when an unknown ISBN scans in
 *   • the cover-ID flow when Vision returns a match
 *
 * Fields:
 *   • Title (editable, required)
 *   • Author (editable, comma-joined from metadata.authors)
 *   • Cover preview (optional)
 *   • SKU — auto-generated, editable
 *   • Warehouse — picker, defaults to first available
 *   • Initial qty — defaults to 1
 *
 * Confirm path: POST /api/v1/items through the SHARED create schema
 * (src/lib/item-create.ts), so this card enforces the same permission,
 * plan-limit, custom-field and audit rules the web form does. It used to
 * raw-insert inventory_items, guess the org from the first
 * organization_members row, and then call adjust_stock with a null location —
 * which routed every ISBN add's opening stock into STAGING instead of
 * Unplaced. The server now writes the `initial` movement inside create(), so
 * there is no RPC call left to make. Still online-only: no offline queue wraps
 * item creation.
 */
export function AddBookCard({ user, result, onCancel, onCreated }: Props) {
  const isExisting = Boolean(result.existingItem);
  const meta = result.metadata ?? {};
  const [title, setTitle] = React.useState(meta.title ?? '');
  const [author, setAuthor] = React.useState(
    Array.isArray(meta.authors) ? meta.authors.join(', ') : '',
  );
  const [sku, setSku] = React.useState(suggestedSku(result.isbn));
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
          {result.existingItem!.name} — currently {result.existingItem!.quantityOnHand}{' '}
          on hand.
        </Text>
        <Pressable style={styles.btnGhost} onPress={onCancel}>
          <Text style={styles.btnGhostLabel}>Close</Text>
        </Pressable>
      </View>
    );
  }

  async function create() {
    if (!user) return;
    if (!title.trim()) {
      Alert.alert('Title required', 'Type a title before saving.');
      return;
    }

    // The book fields the web book form keys off. Author stays a custom field
    // here rather than riding the shared form's "model number" slot, so it is
    // written once and spelled the same way it always has been.
    const customFields: Record<string, unknown> = {};
    if (author.trim()) customFields.author = author.trim();
    if (meta.publisher) customFields.publisher = meta.publisher;
    if (meta.grade) customFields.book_grade = meta.grade;

    const built = buildQuickAddInput({
      itemType: 'book',
      name: title,
      sku,
      barcode: result.isbn,
      modelNumber: '',
      description: meta.description ?? null,
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
        {meta.coverUrl ? (
          <Image source={{ uri: meta.coverUrl }} style={styles.cover} />
        ) : (
          <View style={[styles.cover, styles.coverPlaceholder]}>
            <Text style={styles.coverPlaceholderText}>No cover</Text>
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.isbnLabel}>ISBN</Text>
          <Text style={styles.isbnValue}>{result.isbn}</Text>
          {!meta.title && (
            <Text style={styles.warn}>
              No metadata found — add the title and author manually.
            </Text>
          )}
        </View>
      </View>

      <Field label="Title">
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="The Great Gatsby"
          placeholderTextColor={theme.textMuted}
        />
      </Field>
      <Field label="Author">
        <TextInput
          style={styles.input}
          value={author}
          onChangeText={setAuthor}
          placeholder="F. Scott Fitzgerald"
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

function suggestedSku(isbn: string): string {
  const cleaned = isbn.replace(/[^0-9X]/gi, '');
  return `BOOK-${cleaned.slice(-8)}`;
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

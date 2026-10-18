import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Field } from '@/components/ui/field';
import { Mono } from '@/components/ui/text';
import { PHOTO_BACKGROUND } from '@/components/ui/tones';
import { listWarehouses, type CachedWarehouse } from '@/lib/db-reads';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { buildQuickAddInput, describeFailure, submitCreateItem } from '@/lib/item-create';
import { FONT, TYPE_CEILING, capTo, palette, space, type Palette } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

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
 *
 * Look (redesign P3.8): the reference's scanned card in the device's mode,
 * the shared Field boxes, the warehouse chips and the button pair (Add to
 * inventory commits the card, so it is the ink button). It was drawn from the
 * light-only legacy theme, so it stayed light in dark mode.
 */
export function AddBookCard({ user, result, onCancel, onCreated }: Props) {
  const { mode, c } = useTheme();
  const styles = CARD_STYLES[mode];
  const stacked = shouldStackRow(useWindowDimensions().fontScale);
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
      // The first warehouse is the default until one is picked.
      if (list.length > 0) setWarehouseId((current) => current ?? list[0]?.id ?? null);
    })();
  }, []);

  if (isExisting) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Already in inventory</Text>
        <Text style={styles.body}>
          {result.existingItem!.name} — currently {result.existingItem!.quantityOnHand} on hand.
        </Text>
        <Button variant="outline" onPress={onCancel} style={styles.closeBtn}>
          Close
        </Button>
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
            <Text style={styles.coverPlaceholderText} maxFontSizeMultiplier={PLACEHOLDER_CAP}>
              No cover
            </Text>
          </View>
        )}
        <View style={styles.headerText}>
          <Text style={styles.codeLabel}>ISBN</Text>
          <Text style={styles.codeValue}>{result.isbn}</Text>
          {!meta.title && (
            <Text style={styles.warn}>No metadata found — add the title and author manually.</Text>
          )}
        </View>
      </View>

      {/* What is typed is content, so it grows with the text size as these
          boxes always did: 0, React Native's no-limit sentinel, lifts the
          shared Field's 24pt input ceiling (the box grows with it). */}
      <Field
        label="Title"
        accessibilityLabel="Title"
        value={title}
        onChangeText={setTitle}
        placeholder="The Great Gatsby"
        maxFontSizeMultiplier={0}
        style={styles.field}
      />
      <Field
        label="Author"
        accessibilityLabel="Author"
        value={author}
        onChangeText={setAuthor}
        placeholder="F. Scott Fitzgerald"
        maxFontSizeMultiplier={0}
        style={styles.field}
      />
      <View style={[styles.row, stacked && styles.rowStacked]}>
        <Field
          label="SKU"
          accessibilityLabel="SKU"
          value={sku}
          onChangeText={setSku}
          autoCapitalize="characters"
          maxFontSizeMultiplier={0}
          style={stacked ? styles.field : styles.fieldInRow}
        />
        <Field
          label="Initial qty"
          accessibilityLabel="Initial qty"
          value={qty}
          onChangeText={setQty}
          keyboardType="numeric"
          maxFontSizeMultiplier={0}
          style={stacked ? styles.field : styles.fieldInRow}
        />
      </View>
      <FieldBlock label="Warehouse" color={c.ink3}>
        <View style={styles.warehouseRow}>
          {warehouses.length === 0 ? (
            <Text style={styles.body}>No warehouses cached. Refresh and try again.</Text>
          ) : (
            warehouses.map((w) => (
              <Chip
                key={w.id}
                label={w.name}
                active={w.id === warehouseId}
                onPress={() => setWarehouseId(w.id)}
              />
            ))
          )}
        </View>
      </FieldBlock>

      {/* One full-width button under the other at every text size: a
          button's words stay on one line, and side by side "Cancel" was cut
          short from the largest standard text size, as was "Add to inventory"
          beside its spinner while it saves. */}
      <View style={styles.actions}>
        <Button variant="outline" onPress={onCancel} disabled={busy}>
          Cancel
        </Button>
        {/* Adding commits the card: the ink button (redesign button rule). */}
        <Button
          onPress={create}
          disabled={busy || !warehouseId}
          leading={busy ? <ActivityIndicator color={c.paper} /> : undefined}
        >
          Add to inventory
        </Button>
      </View>
    </View>
  );
}

/** A label over a block that is not a text box (the warehouse chips). */
function FieldBlock({
  label,
  color,
  children,
}: {
  label: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <View style={FIELD_BLOCK}>
      {/* The shared Field's label, so every label on the card reads alike. */}
      <Mono size={10} tracking={0.12} upper color={color}>
        {label}
      </Mono>
      {children}
    </View>
  );
}

function suggestedSku(isbn: string): string {
  const cleaned = isbn.replace(/[^0-9X]/gi, '');
  return `BOOK-${cleaned.slice(-8)}`;
}

/** The placeholder sits in the cover's fixed 72 × 96 frame. */
const PLACEHOLDER_CAP = capTo(10, TYPE_CEILING.chrome);

const FIELD_BLOCK = { marginTop: space.md, gap: 6 } as const;

/** The card's styles in one mode. */
function makeStyles(c: Palette) {
  return StyleSheet.create({
    card: {
      backgroundColor: c.card,
      borderRadius: 16,
      padding: space.lg,
      borderWidth: 1,
      borderColor: c.hair,
    },
    headerRow: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
    headerText: { flex: 1, minWidth: 0 },
    cover: {
      width: 72,
      height: 96,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.hair,
      backgroundColor: PHOTO_BACKGROUND,
    },
    coverPlaceholder: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: 4,
      backgroundColor: c.sunk,
    },
    coverPlaceholderText: {
      color: c.ink3,
      fontFamily: FONT.displayRegular,
      fontSize: 10,
      textAlign: 'center',
    },
    codeLabel: {
      color: c.ink3,
      fontFamily: FONT.mono,
      fontSize: 10.5,
      letterSpacing: 10.5 * 0.12,
      textTransform: 'uppercase',
    },
    codeValue: { color: c.ink, fontFamily: FONT.mono, fontSize: 14, marginTop: 4 },
    warn: {
      color: c.warnText,
      fontFamily: FONT.displayRegular,
      fontSize: 12,
      lineHeight: 17,
      marginTop: space.xs,
    },
    title: { color: c.ink, fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 17 },
    body: {
      color: c.ink3,
      fontFamily: FONT.displayRegular,
      fontSize: 13.5,
      lineHeight: 19,
      marginTop: space.xs,
    },
    field: { marginTop: space.md },
    fieldInRow: { flex: 1, marginTop: space.md },
    row: { flexDirection: 'row', gap: space.md },
    rowStacked: { flexDirection: 'column', gap: 0 },
    warehouseRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
    actions: { flexDirection: 'column', gap: space.sm, marginTop: space.lg },
    closeBtn: { marginTop: space.md },
  });
}

/** Both modes' styles, made once; the card takes the one for the device's mode. */
const CARD_STYLES = { light: makeStyles(palette('light')), dark: makeStyles(palette('dark')) };

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
 *
 * Look (redesign P3.8): the reference's scanned card in the device's mode,
 * the shared Field boxes, the warehouse chips and the button pair (Add to
 * inventory commits the card, so it is the ink button). It was drawn from the
 * light-only legacy theme, so it stayed light in dark mode.
 */
export function AddItemCard({ user, result, onCancel, onCreated }: Props) {
  const { mode, c } = useTheme();
  const styles = CARD_STYLES[mode];
  const stacked = shouldStackRow(useWindowDimensions().fontScale);
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
      // The first warehouse is the default until one is picked.
      if (list.length > 0) setWarehouseId((current) => current ?? list[0]?.id ?? null);
    })();
  }, []);

  if (isExisting) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Already in inventory</Text>
        <Text style={styles.body}>
          {result.existingItem!.name} — open it in the app to adjust stock.
        </Text>
        <Button variant="outline" onPress={onCancel} style={styles.closeBtn}>
          Close
        </Button>
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
            <Text style={styles.coverPlaceholderText} maxFontSizeMultiplier={PLACEHOLDER_CAP}>
              No image
            </Text>
          </View>
        )}
        <View style={styles.headerText}>
          <Text style={styles.codeLabel}>UPC</Text>
          <Text style={styles.codeValue}>{result.upc}</Text>
          {result.source === 'ai-fallback' && (
            <Text style={styles.warn}>Description was AI-generated — review before saving.</Text>
          )}
          {result.source === 'not_found' && (
            <Text style={styles.warn}>No external match. Fill in the details by hand.</Text>
          )}
          {enrichment.brand && <Text style={styles.body}>{enrichment.brand}</Text>}
        </View>
      </View>

      <Field
        label="Name"
        accessibilityLabel="Name"
        value={name}
        onChangeText={setName}
        placeholder="Wireless mouse"
        style={styles.field}
      />
      <Field
        label="Model #"
        accessibilityLabel="Model #"
        value={modelNumber}
        onChangeText={setModelNumber}
        placeholder="e.g. MX432LL/A"
        style={styles.field}
      />
      <View style={[styles.row, stacked && styles.rowStacked]}>
        <Field
          label="SKU"
          accessibilityLabel="SKU"
          value={sku}
          onChangeText={setSku}
          autoCapitalize="characters"
          style={stacked ? styles.field : styles.fieldInRow}
        />
        <Field
          label="Initial qty"
          accessibilityLabel="Initial qty"
          value={qty}
          onChangeText={setQty}
          keyboardType="numeric"
          style={stacked ? styles.field : styles.fieldInRow}
        />
      </View>
      {enrichment.description && (
        <FieldBlock label="Description preview" color={c.ink3}>
          <Text style={styles.description} numberOfLines={4}>
            {enrichment.description}
          </Text>
        </FieldBlock>
      )}
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

/** A label over a block that is not a text box (the description, the warehouse chips). */
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

function suggestedSku(upc: string): string {
  const cleaned = upc.replace(/[^0-9]/g, '');
  // No readable code (Photo ID without a visible barcode) → time-based suffix
  // so two such adds never collide on a shared bare 'ITEM-' SKU.
  if (!cleaned) return `ITEM-${Date.now().toString().slice(-8)}`;
  return `ITEM-${cleaned.slice(-8)}`;
}

/** The placeholder sits in the photo's fixed 72 × 96 frame. */
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
    description: {
      color: c.ink3,
      fontFamily: FONT.displayRegular,
      fontSize: 13.5,
      lineHeight: 19,
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

import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Barcode, Camera, Check, ImageIcon, X } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { listWarehouses, type CachedWarehouse } from '@/lib/db-reads';
import { resizeForUpload } from '@/lib/image-resize';
import {
  buildCreateItemInput,
  buildSizedVariantsInput,
  collectSizedVariants,
  describeFailure,
  sizeOptionsFromScale,
  submitCreateItem,
  submitSizedVariants,
  type ItemFormState,
} from '@/lib/item-create';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { useWorkspace } from '@/lib/use-workspace';

/** Maps a file extension to an image MIME type for storage uploads. */
function mimeForExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  if (e === 'heic') return 'image/heic';
  if (e === 'webp') return 'image/webp';
  return `image/${e}`;
}

function PhotosSection({
  photos,
  onAdd,
  onRemove,
}: {
  photos: Array<{ uri: string; ext: string }>;
  onAdd: (p: { uri: string; ext: string }) => void;
  onRemove: (idx: number) => void;
}) {
  const { c } = useTheme();

  async function fromCamera() {
    let perm = await ImagePicker.getCameraPermissionsAsync();
    if (!perm.granted) {
      perm = await ImagePicker.requestCameraPermissionsAsync();
    }
    if (!perm.granted) {
      Alert.alert(
        'Camera access needed',
        perm.canAskAgain
          ? 'Allow camera in the prompt to take photos.'
          : 'Camera permission is denied. Enable it in Settings → StockPilot.',
      );
      return;
    }
    try {
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.7,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        cameraType: ImagePicker.CameraType.back,
      });
      if (result.canceled || !result.assets[0]) return;
      const a = result.assets[0];
      const ext = (a.uri.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'jpg').toLowerCase();
      onAdd({ uri: a.uri, ext });
    } catch (e) {
      // iOS Simulator has no real camera; launchCameraAsync rejects.
      // Surface the error so the user knows to either run on a device
      // or use the library button.
      Alert.alert(
        'Camera unavailable',
        e instanceof Error ? e.message : 'The camera is not available on this device. Use Library instead.',
      );
    }
  }

  async function fromLibrary() {
    let perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    }
    if (!perm.granted) {
      Alert.alert('Photo access needed', 'Allow photo library to attach images.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 0.7,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: 5,
    });
    if (result.canceled) return;
    for (const a of result.assets) {
      const ext = (a.uri.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'jpg').toLowerCase();
      onAdd({ uri: a.uri, ext });
    }
  }

  return (
    <View style={{ marginTop: 10 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 10 }}
      >
        <Pressable
          onPress={fromCamera}
          style={({ pressed }) => [
            photoStyles.photoBtn,
            { borderColor: c.hair, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Camera size={20} color={c.ink} strokeWidth={1.5} />
          <Mono size={10} tracking={0.06} color={c.ink} style={{ marginTop: 4 }}>
            CAMERA
          </Mono>
        </Pressable>
        <Pressable
          onPress={fromLibrary}
          style={({ pressed }) => [
            photoStyles.photoBtn,
            { borderColor: c.hair, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <ImageIcon size={20} color={c.ink} strokeWidth={1.5} />
          <Mono size={10} tracking={0.06} color={c.ink} style={{ marginTop: 4 }}>
            LIBRARY
          </Mono>
        </Pressable>
        {photos.map((p, idx) => (
          <View key={`${p.uri}-${idx}`} style={photoStyles.photoThumb}>
            <Image source={{ uri: p.uri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
            <Pressable
              onPress={() => onRemove(idx)}
              style={({ pressed }) => [
                photoStyles.photoRemove,
                { opacity: pressed ? 0.7 : 1 },
              ]}
              hitSlop={6}
            >
              <X size={12} color="#fff" strokeWidth={2} />
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const photoStyles = StyleSheet.create({
  photoBtn: {
    width: 80,
    height: 80,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  photoThumb: {
    width: 80,
    height: 80,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#e5e5e5',
  },
  photoRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

/**
 * Manual add-item / add-book screen. Mirrors the web form at
 * /dashboard/inventory/new (and /dashboard/books/new) so anything you
 * can fill in on web is fillable on mobile too. Fields cover:
 *
 *   • Basics:        name, sku, barcode, model number, description
 *   • Classification: category, supplier
 *   • Location:      warehouse, charter, primary location, rack#, rack row
 *   • Pricing:       unit cost, retail price
 *   • Stock:         on hand (initial qty), reorder at, reorder qty,
 *                    unit of measure
 *
 * Type is fixed by the route param (?type=product or ?type=book) — the
 * Items and Books drawer entries push to different URLs so the entry
 * point determines item_type. No in-form type toggle (web has one but
 * mobile splits the flow per drawer entry to keep the form focused).
 *
 * For books, rack number/row write to custom_fields.book_rack_* (the
 * web app keys); for products they write to custom_fields.rack_*.
 *
 * THIS SCREEN HOLDS NO CREATION RULES. It collects strings, hands them to
 * src/lib/item-create.ts (which parses them with the SAME zod the web uses),
 * and POSTs to the Bearer API. It previously built raw PostgREST inserts and
 * ran its own sized fan-out with a hardcoded nine-letter size list, which
 * silently skipped every length cap, numeric bound, permission check, plan
 * limit, custom-field rule, audit event and bin_location stamp the web
 * enforces. See the module doc in src/lib/item-create.ts.
 */
export default function NewItem() {
  const router = useRouter();
  const { user } = useAuth();
  // Create into the ACTIVE workspace org (was useOrg's .limit(1), which
  // created items in the user's first org regardless of the switcher).
  const { activeOrgId: orgId } = useWorkspace();
  const { c } = useTheme();
  const params = useLocalSearchParams<{ barcode?: string; type?: string }>();
  const itemType: 'product' | 'book' = params.type === 'book' ? 'book' : 'product';
  const isBook = itemType === 'book';

  // Basics
  const [name, setName] = React.useState('');
  const [sku, setSku] = React.useState('');
  const [barcode, setBarcode] = React.useState(params.barcode ?? '');
  const [modelNumber, setModelNumber] = React.useState('');
  const [description, setDescription] = React.useState('');

  // Classification + location lookups
  const [categories, setCategories] = React.useState<
    Array<{ id: string; name: string; supports_sizes: boolean; size_scale_id: string | null }>
  >([]);
  const [suppliers, setSuppliers] = React.useState<Array<{ id: string; name: string }>>([]);
  const [locations, setLocations] = React.useState<Array<{ id: string; name: string }>>([]);
  const [charters, setCharters] = React.useState<Array<{ id: string; name: string }>>([]);
  const [warehouses, setWarehouses] = React.useState<CachedWarehouse[]>([]);

  const [categoryId, setCategoryId] = React.useState<string | null>(null);
  const [supplierId, setSupplierId] = React.useState<string | null>(null);
  const [primaryLocationId, setPrimaryLocationId] = React.useState<string | null>(null);
  const [warehouseId, setWarehouseId] = React.useState<string | null>(null);
  const [charterId, setCharterId] = React.useState<string | null>(null);
  const [rackNumber, setRackNumber] = React.useState('');
  const [rackRow, setRackRow] = React.useState('');

  // Pricing + stock
  const [unitCost, setUnitCost] = React.useState('');
  const [retailPrice, setRetailPrice] = React.useState('');
  const [onHand, setOnHand] = React.useState('0');
  const [reorderPoint, setReorderPoint] = React.useState('');
  const [reorderQuantity, setReorderQuantity] = React.useState('');
  // Left BLANK, not 'unit'. An empty box is the only honest way to say "no
  // preference", and the server then stamps the category's counting unit
  // (PAIR for a shoe category). Sending a literal 'unit' would overrule it.
  const [unitOfMeasure, setUnitOfMeasure] = React.useState('');

  // Size variants — only meaningful when the selected category has
  // supports_sizes = true (e.g. "Swag" / shirts). The size VOCABULARY comes
  // from the category's size scale (migration 0294), never from a list in this
  // file: the nine apparel letters that used to live here could not express a
  // shoe run ('9', '9.5', '10'...) at all, and were one of five copies of the
  // same list that had already drifted apart.
  const [sizeOptions, setSizeOptions] = React.useState<string[]>([]);
  const [sizesLoading, setSizesLoading] = React.useState(false);
  const [sizeQty, setSizeQty] = React.useState<Record<string, string>>({});

  // Photos staged in-memory. Each entry holds the local URI + extension;
  // they upload after the inventory_items row is created (the storage
  // path needs the new item id).
  const [photos, setPhotos] = React.useState<Array<{ uri: string; ext: string }>>([]);

  const [busy, setBusy] = React.useState(false);

  const selectedCategory = React.useMemo(
    () => categories.find((c) => c.id === categoryId) ?? null,
    [categories, categoryId],
  );
  const sizesEnabled = !isBook && (selectedCategory?.supports_sizes ?? false);
  // The size run needs an actual vocabulary. When a sized category resolves no
  // scale at all, the screen degrades to a normal single-item create (with the
  // ON HAND box back) instead of stranding the user on a Create button that can
  // only ever say "pick a size".
  const variantsEnabled = sizesEnabled && sizeOptions.length > 0;

  /**
   * The category list, with each category's size scale when the database has
   * one.
   *
   * `categories.size_scale_id` arrives with migration 0294. Asking for it
   * against an environment that has not applied 0294 yet does NOT return the
   * other columns — PostgREST rejects the whole select with "column does not
   * exist", so the category picker would come back EMPTY. A missing size scale
   * must only cost the size chips, never the picker, so the widened read falls
   * back to the narrow one this screen has always used.
   */
  const loadCategories = React.useCallback(async (org: string) => {
    type Row = {
      id: string;
      name: string;
      supports_sizes: boolean | null;
      size_scale_id?: string | null;
    };
    const run = (columns: string) =>
      supabase
        .from('categories')
        .select(columns)
        .eq('organization_id', org)
        .is('deleted_at', null)
        .order('name', { ascending: true });
    let resp = await run('id, name, supports_sizes, size_scale_id');
    if (resp.error) resp = await run('id, name, supports_sizes');
    return ((resp.data ?? []) as unknown as Row[]).map((r) => ({
      id: r.id,
      name: r.name,
      supports_sizes: !!r.supports_sizes,
      size_scale_id: r.size_scale_id ?? null,
    }));
  }, []);

  React.useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      const [whs, cats, supsResp, locsResp, chtsResp] = await Promise.all([
        listWarehouses(),
        loadCategories(orgId),
        supabase
          .from('suppliers')
          .select('id, name')
          .eq('organization_id', orgId)
          .is('deleted_at', null)
          .order('name', { ascending: true }),
        supabase
          .from('locations')
          .select('id, name')
          .eq('organization_id', orgId)
          .is('deleted_at', null)
          // Sites only — racks/shelves/crates and the staging/unplaced system
          // slots aren't stocking locations to assign an item's primary location.
          .in('type', ['warehouse', 'room', 'vehicle', 'jobsite'])
          .order('name', { ascending: true }),
        supabase
          .from('charters')
          .select('id, name')
          .eq('organization_id', orgId)
          .order('name', { ascending: true }),
      ]);
      if (cancelled) return;
      setWarehouses(whs);
      if (whs.length > 0) setWarehouseId(whs[0]?.id ?? null);
      setCategories(cats);
      setSuppliers((supsResp.data ?? []) as Array<{ id: string; name: string }>);
      setLocations((locsResp.data ?? []) as Array<{ id: string; name: string }>);
      setCharters((chtsResp.data ?? []) as Array<{ id: string; name: string }>);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, loadCategories]);

  // Load the selected category's size vocabulary. A category that carries its
  // own scale (a shoe category -> US Men's, halves included) uses it; one that
  // only has supports_sizes falls back to the BUILT-IN apparel_alpha system
  // scale seeded by migration 0294 — read from the database, so there is still
  // no size list in this file. Both are ordered by the scale's sort_order:
  // sizes are ordered, never alphabetical.
  React.useEffect(() => {
    setSizeQty({});
    if (!sizesEnabled) {
      setSizeOptions([]);
      return;
    }
    let cancelled = false;
    setSizesLoading(true);
    void (async () => {
      try {
        let scaleId = selectedCategory?.size_scale_id ?? null;
        if (!scaleId) {
          const { data: fallback } = await supabase
            .from('size_scales')
            .select('id')
            .is('organization_id', null)
            .eq('key', 'apparel_alpha')
            .maybeSingle();
          scaleId = (fallback as { id: string } | null)?.id ?? null;
        }
        if (!scaleId) {
          if (!cancelled) setSizeOptions([]);
          return;
        }
        const { data } = await supabase
          .from('size_scale_values')
          .select('value, sort_order')
          .eq('size_scale_id', scaleId)
          .order('sort_order', { ascending: true });
        if (cancelled) return;
        setSizeOptions(
          sizeOptionsFromScale(
            (data ?? []) as Array<{ value: string; sort_order: number }>,
          ),
        );
      } catch {
        // A missing scale is not an error the user can act on — fall through to
        // the plain single-item create rather than blocking the screen.
        if (!cancelled) setSizeOptions([]);
      } finally {
        if (!cancelled) setSizesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sizesEnabled, selectedCategory?.size_scale_id]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  function suggestSku() {
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    setSku(`SP-${rand}`);
  }

  async function uploadPhotosFor(itemId: string) {
    // Uploads staged local URIs to the `item-images` bucket and inserts
    // one item_images row per upload. The first upload is flagged as
    // primary so the detail screen and list thumbs pick it up.
    if (!orgId || photos.length === 0) return;
    let isFirst = true;
    for (const p of photos) {
      try {
        // Phone-camera photos are typically 4000×3000 (~3-5 MB) which
        // makes the Items list lag during scroll. Resize on the device
        // before upload so the bucket only stores list-friendly sizes.
        const resized = await resizeForUpload(p.uri);
        const path = `${orgId}/items/${itemId}/${Math.random().toString(36).slice(2, 14)}.${resized.ext}`;
        // IMPORTANT: read the local file as an ArrayBuffer, NOT a Blob.
        // `fetch(uri).blob()` in React Native/Expo uploads a 0-byte object
        // to Supabase Storage (the RN Blob can't be read by the storage
        // client), so the image row exists but renders blank everywhere.
        // ArrayBuffer is the supported Expo upload path.
        const arrayBuffer = await (await fetch(resized.uri)).arrayBuffer();
        const { error: upErr } = await supabase.storage
          .from('item-images')
          .upload(path, arrayBuffer, { contentType: mimeForExt(resized.ext) });
        if (upErr) {
          console.warn('[new-item] photo upload failed:', upErr.message);
          continue;
        }
        const { error: rowErr } = await supabase.from('item_images').insert({
          organization_id: orgId,
          item_id: itemId,
          storage_path: path,
          is_primary: isFirst,
        });
        if (rowErr) console.warn('[new-item] photo row insert failed:', rowErr.message);
        isFirst = false;
      } catch (e) {
        console.warn('[new-item] photo upload exception:', e);
      }
    }
  }

  /** The screen's raw strings, exactly as typed. No rules, no coercion. */
  function currentForm(): ItemFormState {
    return {
      name,
      sku,
      barcode,
      modelNumber,
      description,
      categoryId,
      supplierId,
      primaryLocationId,
      warehouseId,
      charterId,
      rackNumber,
      rackRow,
      unitCost,
      retailPrice,
      onHand,
      reorderPoint,
      reorderQuantity,
      unitOfMeasure,
      itemType,
      customFields: {},
    };
  }

  async function save() {
    if (busy) return;
    if (!user || !orgId) {
      Alert.alert('Not signed in', 'Sign in again to add inventory.');
      return;
    }

    const form = currentForm();
    setBusy(true);
    try {
      // ── Sized run ────────────────────────────────────────────────────────
      // ONE request. The fan-out itself — the per-variant name, the SKU
      // suffix, the size-scale check, the normalized size, variant_key, the
      // tracking-type stamp, the plan limit, the initial stock movements and
      // the audit rows — is InventoryService.bulkCreateSizedVariants'. This
      // screen only says which sizes and how many of each.
      if (variantsEnabled) {
        const variants = collectSizedVariants(sizeOptions, sizeQty);
        if (variants.length === 0) {
          // Guidance, not a rule: the shared schema refuses an empty run too
          // (variants.min(1)), this just says it in words a picker can act on.
          Alert.alert(
            'Pick at least one size',
            'Set a quantity on at least one size, or change the category.',
          );
          return;
        }
        const built = buildSizedVariantsInput(form, variants);
        if (!built.ok) {
          Alert.alert('Check the form', describeFailure(built));
          return;
        }
        const { created, ids } = await submitSizedVariants(built.input);
        // Photos apply to every variant the same way (shared design).
        for (const id of ids) await uploadPhotosFor(id);
        Alert.alert(
          'Variants created',
          `${created} size${created === 1 ? '' : 's'} added.`,
        );
        router.replace('/');
        return;
      }

      // ── Single item ──────────────────────────────────────────────────────
      // No adjust_stock call afterwards: the server writes the `initial`
      // stock movement inside create(), so calling the RPC from here would
      // double-count the opening quantity.
      const built = buildCreateItemInput(form);
      if (!built.ok) {
        Alert.alert('Check the form', describeFailure(built));
        return;
      }
      const { id } = await submitCreateItem(built.input);
      await uploadPhotosFor(id);
      router.replace({ pathname: '/item/[id]', params: { id } });
    } catch (e) {
      Alert.alert('Could not add', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={goBack} />
          <Pressable
            onPress={() => router.push('/scan')}
            hitSlop={8}
            style={({ pressed }) => [
              styles.scanShortcut,
              { borderColor: c.hair, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Barcode size={14} color={c.ink} strokeWidth={1.6} />
            <Mono size={11} tracking={0.04} color={c.ink} style={{ fontFamily: FONT.display }}>
              Scan instead
            </Mono>
          </Pressable>
        </View>
        <View style={styles.head}>
          <Eyebrow>NEW {isBook ? 'BOOK' : 'ITEM'}</Eyebrow>
          <Display size={32} style={{ marginTop: 10 }}>
            Add <Em>{isBook ? 'a book.' : 'an item.'}</Em>
          </Display>
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 140 }}
          keyboardShouldPersistTaps="handled"
        >
          <SectionLabel>PHOTOS</SectionLabel>
          <PhotosSection
            photos={photos}
            onAdd={(p) => setPhotos((prev) => [...prev, p])}
            onRemove={(idx) =>
              setPhotos((prev) => prev.filter((_, i) => i !== idx))
            }
          />

          <SectionLabel>BASICS</SectionLabel>

          <Field label={isBook ? 'TITLE' : 'NAME'}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={isBook ? 'A Brief History of Time' : 'Wireless mouse'}
              placeholderTextColor={c.ink4}
              style={[styles.input, { color: c.ink, borderColor: c.hair }]}
            />
          </Field>

          <Row>
            <Field
              flex
              label="SKU"
              trailing={
                <Pressable
                  onPress={suggestSku}
                  hitSlop={8}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                >
                  <Mono size={11} tracking={0.06} color={c.ink3}>
                    Auto
                  </Mono>
                </Pressable>
              }
            >
              <TextInput
                value={sku}
                onChangeText={setSku}
                autoCapitalize="characters"
                placeholder="SP-AB1234"
                placeholderTextColor={c.ink4}
                style={[styles.input, { color: c.ink, borderColor: c.hair }]}
              />
            </Field>
            <Field flex label={isBook ? 'ISBN' : 'BARCODE'}>
              <TextInput
                value={barcode}
                onChangeText={setBarcode}
                placeholder={isBook ? '9780553380163' : '012345678905'}
                placeholderTextColor={c.ink4}
                keyboardType="numeric"
                style={[styles.input, { color: c.ink, borderColor: c.hair }]}
              />
            </Field>
          </Row>

          <Field label={isBook ? 'AUTHOR' : 'MODEL NUMBER'}>
            <TextInput
              value={modelNumber}
              onChangeText={setModelNumber}
              placeholder={isBook ? 'Stephen Hawking' : 'MX432LL/A'}
              placeholderTextColor={c.ink4}
              style={[styles.input, { color: c.ink, borderColor: c.hair }]}
            />
          </Field>

          <Field label="DESCRIPTION">
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Optional notes"
              placeholderTextColor={c.ink4}
              multiline
              numberOfLines={3}
              style={[
                styles.input,
                styles.multiline,
                { color: c.ink, borderColor: c.hair },
              ]}
            />
          </Field>

          <SectionLabel>CLASSIFICATION</SectionLabel>

          <ChipPickerField
            label="CATEGORY"
            options={categories}
            valueId={categoryId}
            onChange={setCategoryId}
          />

          <ChipPickerField
            label="SUPPLIER"
            options={suppliers}
            valueId={supplierId}
            onChange={setSupplierId}
            emptyText="No suppliers yet."
          />

          <SectionLabel>LOCATION</SectionLabel>

          {warehouses.length > 0 ? (
            <Field label="WAREHOUSE">
              <View style={styles.chipRow}>
                {warehouses.map((w) => {
                  const selected = warehouseId === w.id;
                  return (
                    <Pressable
                      key={w.id}
                      onPress={() => setWarehouseId(selected ? null : w.id)}
                      style={({ pressed }) => [
                        styles.chip,
                        {
                          borderColor: selected ? c.ink : c.hair,
                          backgroundColor: selected ? c.card : 'transparent',
                          opacity: pressed ? 0.8 : 1,
                        },
                      ]}
                    >
                      <Body size={13} color={c.ink} style={{ fontFamily: FONT.display }}>
                        {w.name}
                      </Body>
                      {selected ? (
                        <Check size={13} color={c.ink} strokeWidth={2} style={{ marginLeft: 6 }} />
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            </Field>
          ) : null}

          <ChipPickerField
            label="CHARTER"
            options={charters}
            valueId={charterId}
            onChange={setCharterId}
            emptyText="No charters configured."
            clearable
            clearLabel="Generic"
          />

          <ChipPickerField
            label="PRIMARY LOCATION"
            options={locations}
            valueId={primaryLocationId}
            onChange={setPrimaryLocationId}
            emptyText="No locations yet."
          />

          <Row>
            <Field flex label="RACK NUMBER">
              <TextInput
                value={rackNumber}
                onChangeText={setRackNumber}
                placeholder="38"
                placeholderTextColor={c.ink4}
                style={[styles.input, { color: c.ink, borderColor: c.hair }]}
              />
            </Field>
            <Field flex label="RACK ROW">
              <TextInput
                value={rackRow}
                onChangeText={setRackRow}
                placeholder="A"
                placeholderTextColor={c.ink4}
                autoCapitalize="characters"
                style={[styles.input, { color: c.ink, borderColor: c.hair }]}
              />
            </Field>
          </Row>

          {sizesEnabled ? (
            <>
              <SectionLabel>SIZES & QUANTITIES</SectionLabel>
              {sizesLoading ? (
                <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
                  Loading this category&apos;s size scale…
                </Mono>
              ) : sizeOptions.length === 0 ? (
                <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
                  This category has no size scale yet. Saving creates one item.
                </Mono>
              ) : (
                <>
                  <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
                    One item per size will be created. Leave a size at 0 to skip it.
                  </Mono>
                  <View style={{ marginTop: 10, gap: 8 }}>
                    {sizeOptions.map((sz) => (
                      <View key={sz} style={styles.sizeRow}>
                        <View style={[styles.sizeBadge, { borderColor: c.hair }]}>
                          <Mono
                            size={12}
                            tracking={0.06}
                            color={c.ink}
                            style={{ fontFamily: FONT.display }}
                          >
                            {sz}
                          </Mono>
                        </View>
                        <TextInput
                          value={sizeQty[sz] ?? ''}
                          onChangeText={(v) =>
                            setSizeQty((prev) => ({ ...prev, [sz]: v.replace(/[^0-9]/g, '') }))
                          }
                          placeholder="0"
                          placeholderTextColor={c.ink4}
                          keyboardType="numeric"
                          style={[styles.input, { color: c.ink, borderColor: c.hair, flex: 1 }]}
                        />
                      </View>
                    ))}
                  </View>
                </>
              )}
            </>
          ) : null}

          <SectionLabel>PRICING & STOCK</SectionLabel>

          <Row>
            <Field flex label="UNIT COST">
              <TextInput
                value={unitCost}
                onChangeText={setUnitCost}
                placeholder="0.00"
                placeholderTextColor={c.ink4}
                keyboardType="decimal-pad"
                style={[styles.input, { color: c.ink, borderColor: c.hair }]}
              />
            </Field>
            <Field flex label="RETAIL PRICE">
              <TextInput
                value={retailPrice}
                onChangeText={setRetailPrice}
                placeholder="0.00"
                placeholderTextColor={c.ink4}
                keyboardType="decimal-pad"
                style={[styles.input, { color: c.ink, borderColor: c.hair }]}
              />
            </Field>
          </Row>

          <Row>
            {variantsEnabled ? null : (
              <Field flex label="ON HAND">
                <TextInput
                  value={onHand}
                  onChangeText={setOnHand}
                  placeholder="0"
                  placeholderTextColor={c.ink4}
                  keyboardType="numeric"
                  style={[styles.input, { color: c.ink, borderColor: c.hair }]}
                />
              </Field>
            )}
            <Field flex label="REORDER AT">
              <TextInput
                value={reorderPoint}
                onChangeText={setReorderPoint}
                placeholder="0"
                placeholderTextColor={c.ink4}
                keyboardType="numeric"
                style={[styles.input, { color: c.ink, borderColor: c.hair }]}
              />
            </Field>
            <Field flex label="REORDER QTY">
              <TextInput
                value={reorderQuantity}
                onChangeText={setReorderQuantity}
                placeholder="0"
                placeholderTextColor={c.ink4}
                keyboardType="numeric"
                style={[styles.input, { color: c.ink, borderColor: c.hair }]}
              />
            </Field>
          </Row>

          <Field label="UNIT OF MEASURE">
            <TextInput
              value={unitOfMeasure}
              onChangeText={setUnitOfMeasure}
              placeholder="unit"
              placeholderTextColor={c.ink4}
              autoCapitalize="none"
              style={[styles.input, { color: c.ink, borderColor: c.hair }]}
            />
          </Field>
        </ScrollView>
      </KeyboardAvoidingView>

      <View style={[styles.footer, { backgroundColor: c.paper, borderTopColor: c.hair }]}>
        <Pressable
          onPress={save}
          disabled={busy}
          style={({ pressed }) => [
            styles.saveBtn,
            { backgroundColor: c.ink, opacity: pressed || busy ? 0.7 : 1 },
          ]}
        >
          {busy ? (
            <ActivityIndicator color={c.paper} />
          ) : (
            <Body size={15} color={c.paper} style={{ fontFamily: FONT.display }}>
              {isBook ? 'Create book' : 'Create item'}
            </Body>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 22, marginBottom: 4 }}>
      <Eyebrow>{String(children)}</Eyebrow>
    </View>
  );
}

function Field({
  label,
  trailing,
  children,
  flex,
}: {
  label: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
  flex?: boolean;
}) {
  return (
    <View style={{ marginTop: 14, flex: flex ? 1 : undefined }}>
      <View style={styles.fieldHead}>
        <Eyebrow>{label}</Eyebrow>
        {trailing}
      </View>
      <View style={{ marginTop: 6 }}>{children}</View>
    </View>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', gap: 10 }}>{children}</View>;
}

function ChipPickerField({
  label,
  options,
  valueId,
  onChange,
  emptyText,
  clearable,
  clearLabel,
}: {
  label: string;
  options: Array<{ id: string; name: string }>;
  valueId: string | null;
  onChange: (id: string | null) => void;
  emptyText?: string;
  clearable?: boolean;
  clearLabel?: string;
}) {
  const { c } = useTheme();
  return (
    <Field label={label}>
      {options.length === 0 ? (
        <Mono size={11} tracking={0.04} color={c.ink4}>
          {emptyText ?? 'None available.'}
        </Mono>
      ) : (
        <View style={styles.chipRow}>
          {clearable ? (
            <Pressable
              onPress={() => onChange(null)}
              style={({ pressed }) => [
                styles.chip,
                {
                  borderColor: valueId === null ? c.ink : c.hair,
                  backgroundColor: valueId === null ? c.card : 'transparent',
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              <Body size={13} color={c.ink} style={{ fontFamily: FONT.display }}>
                {clearLabel ?? 'None'}
              </Body>
            </Pressable>
          ) : null}
          {options.map((opt) => {
            const selected = valueId === opt.id;
            return (
              <Pressable
                key={opt.id}
                // Tapping a selected chip clears it — there's no "X" UI
                // on a chip, so toggle-to-clear is how the user backs out
                // of a wrong pick.
                onPress={() => onChange(selected ? null : opt.id)}
                style={({ pressed }) => [
                  styles.chip,
                  {
                    borderColor: selected ? c.ink : c.hair,
                    backgroundColor: selected ? c.card : 'transparent',
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Body size={13} color={c.ink} style={{ fontFamily: FONT.display }}>
                  {opt.name}
                </Body>
                {selected ? (
                  <Check size={13} color={c.ink} strokeWidth={2} style={{ marginLeft: 6 }} />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      )}
    </Field>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  scanShortcut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 999,
  },
  head: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
  },
  fieldHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: FONT.displayRegular,
  },
  multiline: {
    minHeight: 80,
    textAlignVertical: 'top',
    paddingTop: 12,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 999,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  saveBtn: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  sizeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sizeBadge: {
    width: 60,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: 'center',
  },
});

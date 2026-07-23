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

import { normalizeRackFields } from '@stockpilot/core';

import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { listWarehouses, type CachedWarehouse } from '@/lib/db-reads';
import { resizeForUpload } from '@/lib/image-resize';
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
    Array<{ id: string; name: string; supports_sizes: boolean }>
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
  const [unitOfMeasure, setUnitOfMeasure] = React.useState('unit');

  // Size variants — only meaningful when the selected category has
  // supports_sizes = true (e.g. "Swag" / shirts). Mirrors the web
  // form's per-size quantity matrix and writes one inventory_items
  // row per chosen size on save.
  const ALL_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL'] as const;
  type SizeCode = (typeof ALL_SIZES)[number];
  const [sizeQty, setSizeQty] = React.useState<Record<SizeCode, string>>({
    XS: '', S: '', M: '', L: '', XL: '', XXL: '', XXXL: '', XXXXL: '', XXXXXL: '',
  });

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

  React.useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      const [whs, catsResp, supsResp, locsResp, chtsResp] = await Promise.all([
        listWarehouses(),
        supabase
          .from('categories')
          .select('id, name, supports_sizes')
          .eq('organization_id', orgId)
          .is('deleted_at', null)
          .order('name', { ascending: true }),
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
      setCategories(
        ((catsResp.data ?? []) as Array<{ id: string; name: string; supports_sizes: boolean | null }>).map(
          (r) => ({ id: r.id, name: r.name, supports_sizes: !!r.supports_sizes }),
        ),
      );
      setSuppliers((supsResp.data ?? []) as Array<{ id: string; name: string }>);
      setLocations((locsResp.data ?? []) as Array<{ id: string; name: string }>);
      setCharters((chtsResp.data ?? []) as Array<{ id: string; name: string }>);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

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

  async function save() {
    if (busy) return;
    if (!user || !orgId) {
      Alert.alert('Not signed in', 'Sign in again to add inventory.');
      return;
    }
    if (!name.trim()) {
      Alert.alert(
        isBook ? 'Title required' : 'Name required',
        'Type a name before saving.',
      );
      return;
    }
    if (!sku.trim()) {
      Alert.alert('SKU required', 'Tap Suggest to generate one, or type your own.');
      return;
    }
    // DECOMPOSE the rack fields through the ONE shared parser (web parity).
    // A picker typing the whole shelf label "22-B" into the number box gets
    // ("22","B") stored, not the composite that made items invisible to their
    // own rack filter on 2026-07-23.
    const rack = normalizeRackFields({ number: rackNumber, row: rackRow });
    const rackNum = rack.number;
    const rackRowValue = rackNum ? (rack.row ?? '').toUpperCase() : '';
    const cf: Record<string, unknown> = {};
    if (isBook) {
      if (modelNumber.trim()) cf.author = modelNumber.trim();
      if (rackNum) cf.book_rack_number = rackNum;
      if (rackRowValue) cf.book_rack_row = rackRowValue;
    } else {
      if (rackNum) cf.rack_number = rackNum;
      if (rackRowValue) cf.rack_row = rackRowValue;
    }

    setBusy(true);
    try {
      if (sizesEnabled) {
        // Multi-variant create: build one row per size with qty > 0,
        // suffix SKU + name with the size code, and stamp size into
        // custom_fields. Matches `bulkCreateSizedVariants` on the web.
        const variants = ALL_SIZES
          .map((sz) => ({ sz, qty: Math.max(0, Number(sizeQty[sz]) || 0) }))
          .filter((v) => v.qty > 0);
        if (variants.length === 0) {
          Alert.alert(
            'Pick at least one size',
            'Set a quantity on at least one size, or change the category.',
          );
          setBusy(false);
          return;
        }
        const base = sku.trim();
        const rows = variants.map((v) => ({
          organization_id: orgId,
          sku: `${base}-${v.sz}`,
          name: `${name.trim()} - ${v.sz}`,
          barcode: barcode.trim() || null,
          description: description.trim() || null,
          item_type: 'product',
          custom_fields: { ...cf, size: v.sz },
          category_id: categoryId,
          supplier_id: supplierId,
          primary_location_id: primaryLocationId,
          warehouse_id: warehouseId,
          charter_id: charterId,
          unit_cost: unitCost ? Number(unitCost) : 0,
          retail_price: retailPrice ? Number(retailPrice) : 0,
          reorder_point: reorderPoint ? Number(reorderPoint) : 0,
          reorder_quantity: reorderQuantity ? Number(reorderQuantity) : 0,
          unit_of_measure: unitOfMeasure.trim() || 'unit',
          status: 'active',
          quantity_on_hand: v.qty,
          created_by: user.id,
          updated_by: user.id,
        }));
        const { data: created, error: insErr } = await supabase
          .from('inventory_items')
          .insert(rows)
          .select('id, quantity_on_hand, primary_location_id');
        if (insErr) {
          if ((insErr as { code?: string }).code === '23505') {
            throw new Error(
              'One or more variant SKUs already exist. Pick a different base SKU.',
            );
          }
          throw new Error(insErr.message);
        }
        const insertedRows = (created ?? []) as Array<{
          id: string;
          quantity_on_hand: number;
          primary_location_id: string | null;
        }>;
        // Audit-trail rows so the 14-day sparklines + movements feed
        // pick up the initial qty events. Mirrors the web service.
        const movements = insertedRows
          .filter((r) => r.quantity_on_hand > 0)
          .map((r) => ({
            organization_id: orgId,
            item_id: r.id,
            movement_type: 'initial',
            quantity_change: r.quantity_on_hand,
            previous_quantity: 0,
            new_quantity: r.quantity_on_hand,
            user_id: user.id,
            to_location_id: r.primary_location_id,
          }));
        if (movements.length > 0) {
          const { error: movErr } = await supabase.from('stock_movements').insert(movements);
          if (movErr) console.warn('[new-item] variant movements failed:', movErr.message);
        }
        // Photos apply to every variant the same way (shared design).
        for (const r of insertedRows) await uploadPhotosFor(r.id);
        Alert.alert(
          'Variants created',
          `${insertedRows.length} size${insertedRows.length === 1 ? '' : 's'} added.`,
        );
        router.replace('/');
        return;
      }

      // Single-row path (the standard add).
      const initialQty = Math.max(0, Number(onHand) || 0);
      const insertPayload: Record<string, unknown> = {
        organization_id: orgId,
        sku: sku.trim(),
        name: name.trim(),
        barcode: barcode.trim() || null,
        model_number: !isBook && modelNumber.trim() ? modelNumber.trim() : null,
        description: description.trim() || null,
        item_type: itemType,
        custom_fields: cf,
        category_id: categoryId,
        supplier_id: supplierId,
        primary_location_id: primaryLocationId,
        warehouse_id: warehouseId,
        charter_id: charterId,
        unit_cost: unitCost ? Number(unitCost) : 0,
        retail_price: retailPrice ? Number(retailPrice) : 0,
        reorder_point: reorderPoint ? Number(reorderPoint) : 0,
        reorder_quantity: reorderQuantity ? Number(reorderQuantity) : 0,
        unit_of_measure: unitOfMeasure.trim() || 'unit',
        status: 'active',
        quantity_on_hand: 0,
        created_by: user.id,
        updated_by: user.id,
      };
      const { data: created, error: insErr } = await supabase
        .from('inventory_items')
        .insert(insertPayload)
        .select('id')
        .single();
      if (insErr) throw new Error(insErr.message);
      const newId = (created as { id: string }).id;
      if (initialQty > 0) {
        const { error: adjErr } = await supabase.rpc('adjust_stock', {
          p_item_id: newId,
          p_quantity_change: initialQty,
          p_movement_type: 'initial',
          p_location_id: null,
          p_reason: 'Manual add (mobile)',
          p_notes: null,
        });
        if (adjErr) throw new Error(adjErr.message);
      }
      await uploadPhotosFor(newId);
      router.replace({ pathname: '/item/[id]', params: { id: newId } });
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
              <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
                One item per size will be created. Leave a size at 0 to skip it.
              </Mono>
              <View style={{ marginTop: 10, gap: 8 }}>
                {ALL_SIZES.map((sz) => (
                  <View key={sz} style={styles.sizeRow}>
                    <View style={[styles.sizeBadge, { borderColor: c.hair }]}>
                      <Mono size={12} tracking={0.06} color={c.ink} style={{ fontFamily: FONT.display }}>
                        {sz}
                      </Mono>
                    </View>
                    <TextInput
                      value={sizeQty[sz]}
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
            {sizesEnabled ? null : (
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

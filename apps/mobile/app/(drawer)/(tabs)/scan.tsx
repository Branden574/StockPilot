import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';
import { X } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AddBookCard, type IsbnLookupResult } from '@/components/AddBookCard';
import { AddItemCard, type UpcLookupResult } from '@/components/AddItemCard';
import { CachedImage } from '@/components/ui/cached-image';
import { api, API_BASE } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { signItemImage } from '@/lib/image-cache';
import { resizeForUpload } from '@/lib/image-resize';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

interface FoundItem {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  quantity_on_hand: number;
  reorder_point: number;
  retail_price: number;
  unit_cost: number;
  primary_location_name: string | null;
  bin_location: string | null;
  custom_fields: Record<string, unknown> | null;
  image_url: string | null;
}

/**
 * Pulls the deep-link URL pattern out of a scanned QR/barcode value.
 * The /api/v1/items/[id]/barcode QR endpoint encodes
 *   <origin>/p/items/<uuid>          (current — public read-only page)
 *   <origin>/dashboard/inventory/<uuid>  (legacy — pre-2026-05-06 stickers)
 *   <origin>/dashboard/books/<uuid>      (legacy)
 * so we accept any of the three for back-compat with already-printed
 * labels.
 */
function parseItemId(scanned: string): string | null {
  const match = scanned.match(
    /\/(?:p\/items|dashboard\/(?:inventory|books))\/([0-9a-f-]{36})/i,
  );
  return match?.[1] ?? null;
}

/**
 * Pulls the signature token out of a scanned WAREHOUSE PACKING-SLIP QR.
 * That QR encodes `<origin>/orders/sign/<token>` — a public, token-scoped
 * proof-of-delivery signature page. Returns the token, or null for any other
 * scanned value (item labels, plain barcodes, ISBNs). Without this, the URL
 * fell through to the UPC lookup and opened the "add item" card by mistake.
 */
function parseSignToken(scanned: string): string | null {
  const match = scanned.match(/\/orders\/sign\/([A-Za-z0-9._~-]+)/);
  return match?.[1] ?? null;
}

/** ISBN-10 (with optional 'X' check digit) or ISBN-13. */
function looksLikeIsbn(raw: string): boolean {
  const cleaned = raw.replace(/[^0-9X]/gi, '');
  return cleaned.length === 10 || cleaned.length === 13;
}

/** Lightweight uuid for storage path uniqueness. */
function cryptoRandom(): string {
  return 'xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

function formatCurrency(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Maps a file extension to an image MIME type for storage uploads. */
function mimeForExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  if (e === 'heic') return 'image/heic';
  if (e === 'webp') return 'image/webp';
  return `image/${e}`;
}

function readBookStorage(cf: Record<string, unknown> | null) {
  const f = cf ?? {};
  const rackNumber = f.book_rack_number ? String(f.book_rack_number) : null;
  const rackRow = f.book_rack_row ? String(f.book_rack_row) : null;
  const crateColor = f.book_crate_color ? String(f.book_crate_color) : null;
  const crateNumber = f.book_crate_number ? String(f.book_crate_number) : null;
  const grade = f.book_grade ? String(f.book_grade) : null;
  const rackLabel =
    rackNumber || rackRow ? [rackNumber, rackRow].filter(Boolean).join('-') : null;
  return { rackLabel, crateColor, crateNumber, grade };
}

const CRATE_HEX: Record<string, string> = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  black: '#27272a',
  white: '#f4f4f5',
  gray: '#9ca3af',
};

export default function Scan() {
  const router = useRouter();
  const { user } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = React.useState(true);
  const [mode, setMode] = React.useState<'lookup' | 'cover'>('lookup');
  const [orgId, setOrgId] = React.useState<string | null>(null);
  const [item, setItem] = React.useState<FoundItem | null>(null);
  const [addBook, setAddBook] = React.useState<IsbnLookupResult | null>(null);
  const [addItem, setAddItem] = React.useState<UpcLookupResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [lastCode, setLastCode] = React.useState<string | null>(null);

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

  /** Loads an item's rich detail (with image + location name) by id. */
  async function loadItemById(id: string): Promise<FoundItem | null> {
    if (!orgId) return null;
    const { data: row } = await supabase
      .from('inventory_items')
      .select(
        `id, name, sku, barcode, quantity_on_hand, reorder_point,
         retail_price, unit_cost, bin_location, custom_fields,
         primary_location:locations!primary_location_id (name)`,
      )
      .eq('organization_id', orgId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (!row) return null;

    // Primary image (or first image) — the path lives in item_images,
    // we sign a URL for the storage object.
    const { data: imgRow } = await supabase
      .from('item_images')
      .select('storage_path')
      .eq('item_id', (row as { id: string }).id)
      .order('is_primary', { ascending: false })
      .order('sort_order', { ascending: true })
      .limit(1)
      .maybeSingle();
    let imageUrl: string | null = null;
    if (imgRow?.storage_path) {
      imageUrl = await signItemImage(imgRow.storage_path as string);
    }

    const r = row as Record<string, unknown>;
    const loc = r.primary_location as { name?: string } | { name?: string }[] | null;
    const locName = Array.isArray(loc) ? loc[0]?.name : loc?.name;
    return {
      id: r.id as string,
      name: r.name as string,
      sku: r.sku as string,
      barcode: (r.barcode as string | null) ?? null,
      quantity_on_hand: Number(r.quantity_on_hand) || 0,
      reorder_point: Number(r.reorder_point) || 0,
      retail_price: Number(r.retail_price) || 0,
      unit_cost: Number(r.unit_cost) || 0,
      primary_location_name: locName ?? null,
      bin_location: (r.bin_location as string | null) ?? null,
      custom_fields: (r.custom_fields as Record<string, unknown> | null) ?? null,
      image_url: imageUrl,
    };
  }

  /** Loads an item by scanned bare value (matches barcode or SKU). */
  async function loadItemByValue(value: string): Promise<FoundItem | null> {
    if (!orgId) return null;
    const { data: row } = await supabase
      .from('inventory_items')
      .select('id')
      .eq('organization_id', orgId)
      .or(`barcode.eq.${value},sku.eq.${value}`)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (!row) return null;
    return loadItemById((row as { id: string }).id);
  }

  async function onBarCodeScanned({ data }: { data: string }) {
    if (busy || !orgId || data === lastCode) return;
    setLastCode(data);
    setBusy(true);
    setScanning(false);

    // Warehouse packing-slip QR → the public proof-of-delivery signature page.
    // Open it in an in-app browser so the recipient signs INSIDE StockPilot,
    // instead of falling through to the item/UPC lookup (which mistook the
    // signature URL for an unknown product and opened the "add item" card).
    // Build the URL from our own API_BASE + the extracted token so a spoofed
    // QR can't redirect the in-app browser to another host.
    const signToken = parseSignToken(data);
    if (signToken) {
      try {
        await WebBrowser.openBrowserAsync(`${API_BASE}/orders/sign/${signToken}`);
      } catch (e) {
        Alert.alert(
          'Could not open signature',
          e instanceof Error ? e.message : 'Please try again.',
        );
      }
      reset();
      setBusy(false);
      return;
    }

    // QR code from a printed StockPilot label encodes a URL with
    // /dashboard/inventory/<id> — pull the id out and load by id
    // directly. Plain barcodes (Code 128 / EAN / UPC) don't carry the
    // URL prefix, so they fall through to barcode/sku lookup.
    const directId = parseItemId(data);
    const found = directId
      ? await loadItemById(directId)
      : await loadItemByValue(data);

    if (!found) {
      // Not in inventory yet. If the code looks like an ISBN, try the
      // book-lookup pipeline and offer one-tap add. Otherwise just
      // show the standard not-found alert.
      if (looksLikeIsbn(data)) {
        try {
          const res = await api<IsbnLookupResult>(
            `/api/v1/books/isbn-lookup?isbn=${encodeURIComponent(data)}`,
          );
          setAddBook(res);
        } catch (e) {
          Alert.alert(
            'ISBN lookup failed',
            e instanceof Error ? e.message : 'Network error',
            [{ text: 'OK', onPress: reset }],
          );
        }
      } else {
        // Not an ISBN — try the UPC enrichment chain so we can offer
        // one-tap add for non-book products too. The endpoint handles
        // local-DB short-circuit + UPCitemdb + Gemini description-only.
        try {
          const res = await api<{
            source: 'local' | 'upcitemdb' | 'ai-fallback';
            existsInInventory: boolean;
            itemId?: string;
            enrichment: {
              name: string;
              description: string | null;
              brand: string | null;
              modelNumber: string | null;
              imageUrl: string | null;
            };
          }>(`/api/v1/items/upc-lookup?upc=${encodeURIComponent(data)}`);
          setAddItem({
            upc: data,
            source: res.source,
            existingItem: res.existsInInventory && res.itemId
              ? { id: res.itemId, name: res.enrichment.name }
              : null,
            enrichment: res.enrichment,
          });
        } catch (e) {
          // 404 / network — offer the manual-entry path with just the
          // barcode pre-populated.
          const is404 = e instanceof Error && /404|not_found/i.test(e.message);
          if (is404) {
            setAddItem({
              upc: data,
              source: 'not_found',
              existingItem: null,
              enrichment: null,
            });
          } else {
            Alert.alert(
              'Lookup failed',
              e instanceof Error ? e.message : 'Network error',
              [{ text: 'OK', onPress: reset }],
            );
          }
        }
      }
      setBusy(false);
      return;
    }
    setItem(found);
    setBusy(false);
  }

  function reset() {
    setItem(null);
    setAddBook(null);
    setAddItem(null);
    setLastCode(null);
    setScanning(true);
  }

  async function adjust(delta: number) {
    if (!item) return;
    setBusy(true);
    const { error } = await supabase.rpc('adjust_stock', {
      p_item_id: item.id,
      p_quantity_change: delta,
      p_movement_type: delta > 0 ? 'add' : 'remove',
      p_location_id: null,
      p_reason: 'Mobile scan',
      p_notes: null,
    });
    setBusy(false);
    if (error) {
      Alert.alert('Could not adjust', error.message);
      return;
    }
    setItem({ ...item, quantity_on_hand: item.quantity_on_hand + delta });
  }

  /**
   * Cover-ID flow. Opens the camera, captures a cover photo, uploads it
   * to /api/v1/ai/identify-from-photo (Gemini Vision), and seeds
   * AddBookCard with whatever Vision returned. The user always
   * confirms before anything is added to inventory — Vision can be
   * confidently wrong on weird editions.
   */
  async function captureCoverId() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera access needed', 'Allow camera to capture a cover.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.8,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];

    setBusy(true);
    try {
      // Read the image and ship it as base64 — multipart from RN to
      // Next.js can be flaky across runtimes; JSON-base64 just works.
      const ext = (asset.uri.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'jpg').toLowerCase();
      const blob = await (await fetch(asset.uri)).blob();
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('failed to read image'));
        reader.onload = () => {
          const dataUrl = String(reader.result ?? '');
          const comma = dataUrl.indexOf(',');
          resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
        };
        reader.readAsDataURL(blob);
      });

      const vision = await api<{
        title?: string;
        author?: string;
        isbn?: string;
        publisher?: string;
        confidence?: string;
        notes?: string;
      }>('/api/v1/ai/identify-from-photo', {
        method: 'POST',
        body: {
          imageBase64: base64,
          mimeType: blob.type || `image/${ext}`,
        },
      });

      // If Vision pulled an ISBN, prefer the official lookup pipeline —
      // it's more reliable than Vision's title-only guess and surfaces
      // an existingItem flag if the book is already in inventory.
      if (vision.isbn && /^[0-9X]{10,13}$/i.test(vision.isbn.replace(/[^0-9X]/gi, ''))) {
        try {
          const lookup = await api<IsbnLookupResult>(
            `/api/v1/books/isbn-lookup?isbn=${encodeURIComponent(vision.isbn)}`,
          );
          // If lookup resolved metadata, use that; otherwise fall back to
          // Vision's data so the user still gets a one-tap add card.
          if (lookup.existingItem || lookup.metadata) {
            setAddBook(lookup);
            return;
          }
        } catch {
          /* ignore — fall back to Vision result below */
        }
      }

      // Synthesize an IsbnLookupResult from Vision's payload so
      // AddBookCard can render it the same way.
      setAddBook({
        isbn: (vision.isbn ?? '').replace(/[^0-9X]/gi, '') || 'unknown',
        existingItem: null,
        metadata: vision.title
          ? {
              title: vision.title,
              authors: vision.author ? [vision.author] : null,
              publisher: vision.publisher ?? null,
              description: null,
              coverUrl: asset.uri,
              grade: null,
            }
          : null,
      });
    } catch (e) {
      Alert.alert('Cover ID failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Open the camera, capture a photo, upload to the item-images bucket,
   * and register a new item_images row. Replaces the displayed thumb so
   * the user sees their capture immediately.
   */
  async function capturePhoto() {
    if (!item || !orgId) return;
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera access needed', 'Allow camera to take photos.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.7,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
    });
    if (result.canceled || !result.assets[0]) return;

    setBusy(true);
    try {
      const asset = result.assets[0];
      // Resize on-device so the bucket only stores list-friendly sizes
      // (~400 KB JPEGs instead of multi-megapixel phone photos).
      const resized = await resizeForUpload(asset.uri);
      const path = `${orgId}/items/${item.id}/${cryptoRandom()}.${resized.ext}`;

      // ArrayBuffer upload — `fetch(uri).blob()` uploads a 0-byte object
      // in React Native/Expo, which is why captured photos never showed
      // up. See item/new.tsx mimeForExt note.
      const arrayBuffer = await (await fetch(resized.uri)).arrayBuffer();
      const { error: upErr } = await supabase.storage
        .from('item-images')
        .upload(path, arrayBuffer, { contentType: mimeForExt(resized.ext) });
      if (upErr) throw new Error(upErr.message);

      const { data: existing } = await supabase
        .from('item_images')
        .select('id')
        .eq('organization_id', orgId)
        .eq('item_id', item.id)
        .limit(1);
      const isFirst = !existing || existing.length === 0;

      const { error: insErr } = await supabase.from('item_images').insert({
        organization_id: orgId,
        item_id: item.id,
        storage_path: path,
        is_primary: isFirst,
      });
      if (insErr) throw new Error(insErr.message);

      const signedUrl = await signItemImage(path);
      if (signedUrl) {
        setItem({ ...item, image_url: signedUrl });
      }
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  if (!permission) return <CenterMessage>Loading camera permission…</CenterMessage>;
  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.permission}>
          <Text style={styles.permTitle}>Camera access needed</Text>
          <Text style={styles.permBody}>StockPilot uses the camera to scan barcodes and QR codes.</Text>
          <Pressable style={styles.cta} onPress={requestPermission}>
            <Text style={styles.ctaLabel}>Grant access</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const storage = item ? readBookStorage(item.custom_fields) : null;
  const crateHex =
    storage?.crateColor && CRATE_HEX[storage.crateColor]
      ? CRATE_HEX[storage.crateColor]
      : null;
  const lowStock =
    item && item.reorder_point > 0 && item.quantity_on_hand <= item.reorder_point;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {scanning && !item && !addBook && mode === 'lookup' ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{
            barcodeTypes: ['qr', 'ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93', 'codabar', 'pdf417'],
          }}
          onBarcodeScanned={onBarCodeScanned}
        />
      ) : null}

      <Pressable
        onPress={() => {
          if (router.canGoBack()) router.back();
          else router.replace('/');
        }}
        style={styles.closeBtn}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Close scanner"
      >
        <X size={20} color="#f6f4ef" strokeWidth={1.8} />
      </Pressable>

      <View style={styles.overlay} pointerEvents="box-none">
        {!item && !addBook && (
          <View style={styles.modeChips} pointerEvents="auto">
            <Pressable
              onPress={() => setMode('lookup')}
              style={[styles.modeChip, mode === 'lookup' && styles.modeChipOn]}
            >
              <Text style={[styles.modeLabel, mode === 'lookup' && styles.modeLabelOn]}>
                Scan
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setMode('cover')}
              style={[styles.modeChip, mode === 'cover' && styles.modeChipOn]}
            >
              <Text style={[styles.modeLabel, mode === 'cover' && styles.modeLabelOn]}>
                Cover ID
              </Text>
            </Pressable>
          </View>
        )}

        {mode === 'lookup' ? (
          <>
            <ScanReticle />
            <Text style={styles.reticleLabel}>— ALIGN BARCODE</Text>
            <Text style={styles.hint}>
              {scanning && !item ? 'Point at a barcode or QR code' : ''}
            </Text>
          </>
        ) : !item && !addBook ? (
          <View style={styles.coverCta} pointerEvents="auto">
            <Text style={styles.coverHint}>
              Snap a clear photo of the front cover. Vision will read the
              title and author.
            </Text>
            <Pressable
              onPress={captureCoverId}
              style={styles.coverShutter}
              disabled={busy}
            >
              <Text style={styles.coverShutterLabel}>
                {busy ? 'Identifying…' : '📷  Capture cover'}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {item && (
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={{ paddingBottom: space.md }}>
            <View style={styles.headerRow}>
              {item.image_url ? (
                <CachedImage uri={item.image_url} style={styles.thumb} recyclingKey={item.id} />
              ) : (
                <View style={[styles.thumb, styles.thumbPlaceholder]}>
                  <Text style={styles.thumbPlaceholderText}>No image</Text>
                </View>
              )}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.sheetSku} numberOfLines={1}>
                  {item.sku}
                  {item.barcode ? ` · ${item.barcode}` : ''}
                </Text>
                <Text style={styles.sheetName} numberOfLines={2}>
                  {item.name}
                </Text>
              </View>
            </View>

            <View style={styles.statRow}>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>On hand</Text>
                <Text
                  style={[styles.statValue, lowStock && { color: theme.warning }]}
                >
                  {item.quantity_on_hand}
                </Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Reorder at</Text>
                <Text style={styles.statValueMuted}>{item.reorder_point}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Price</Text>
                <Text style={styles.statValueMuted}>
                  {formatCurrency(item.retail_price)}
                </Text>
              </View>
            </View>

            {(item.primary_location_name ||
              item.bin_location ||
              storage?.rackLabel ||
              storage?.crateNumber ||
              storage?.grade) && (
              <View style={styles.locationBox}>
                {item.primary_location_name && (
                  <LocRow label="Location" value={item.primary_location_name} />
                )}
                {item.bin_location && (
                  <LocRow label="Bin/shelf" value={item.bin_location} />
                )}
                {storage?.rackLabel && (
                  <LocRow label="Rack" value={storage.rackLabel} mono />
                )}
                {storage?.crateNumber && crateHex && (
                  <View style={styles.locRow}>
                    <Text style={styles.locLabel}>Crate</Text>
                    <View
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                    >
                      <View
                        style={[
                          styles.crateDot,
                          { backgroundColor: crateHex },
                        ]}
                      />
                      <Text style={styles.locValue}>{storage.crateNumber}</Text>
                    </View>
                  </View>
                )}
                {storage?.grade && (
                  <LocRow
                    label="Grade"
                    value={
                      /^\d{1,2}$/.test(storage.grade)
                        ? `Grade ${storage.grade}`
                        : storage.grade
                    }
                  />
                )}
              </View>
            )}

            <View style={styles.actions}>
              <ActionBtn label="−1" onPress={() => adjust(-1)} disabled={busy} />
              <ActionBtn label="+1" onPress={() => adjust(1)} disabled={busy} primary />
              <ActionBtn label="+5" onPress={() => adjust(5)} disabled={busy} primary />
              <ActionBtn label="+25" onPress={() => adjust(25)} disabled={busy} />
            </View>

            <View style={styles.secondaryActions}>
              <Pressable
                style={styles.photoBtn}
                onPress={capturePhoto}
                disabled={busy}
              >
                <Text style={styles.photoBtnLabel}>📷  Take photo</Text>
              </Pressable>
              <Pressable style={styles.dismiss} onPress={reset}>
                <Text style={styles.dismissLabel}>Scan another</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      )}

      {addBook && (
        <View style={styles.addBookWrap}>
          <ScrollView contentContainerStyle={{ paddingBottom: space.lg }}>
            <AddBookCard
              user={user}
              result={addBook}
              onCancel={reset}
              onCreated={(id) => {
                setAddBook(null);
                void (async () => {
                  const found = await loadItemById(id);
                  if (found) setItem(found);
                  else reset();
                })();
              }}
            />
          </ScrollView>
        </View>
      )}

      {addItem && (
        <View style={styles.addBookWrap}>
          <ScrollView contentContainerStyle={{ paddingBottom: space.lg }}>
            <AddItemCard
              user={user}
              result={addItem}
              onCancel={reset}
              onCreated={(id) => {
                setAddItem(null);
                void (async () => {
                  const found = await loadItemById(id);
                  if (found) setItem(found);
                  else reset();
                })();
              }}
            />
          </ScrollView>
        </View>
      )}

      {busy && !item && !addBook && !addItem && (
        <ActivityIndicator style={styles.spinner} color="#fafaf7" size="large" />
      )}
    </SafeAreaView>
  );
}

// Animated reticle — 4 corner brackets with a mint scan line that
// sweeps top→bottom→top continuously while the scanner is open.
function ScanReticle() {
  // 0 = top, 1 = bottom — interpolated to translateY across the
  // reticle's interior so the line never crosses the corner brackets.
  const t = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(t, {
          toValue: 0,
          duration: 1600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [t]);
  const translateY = t.interpolate({
    inputRange: [0, 1],
    outputRange: [10, 270],
  });
  return (
    <View style={styles.reticle}>
      <View style={[styles.corner, styles.cornerTL]} />
      <View style={[styles.corner, styles.cornerTR]} />
      <View style={[styles.corner, styles.cornerBL]} />
      <View style={[styles.corner, styles.cornerBR]} />
      <Animated.View style={[styles.scanLine, { transform: [{ translateY }] }]} />
    </View>
  );
}

function LocRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.locRow}>
      <Text style={styles.locLabel}>{label}</Text>
      <Text style={[styles.locValue, mono && { fontFamily: 'Menlo' }]}>{value}</Text>
    </View>
  );
}

function ActionBtn({ label, onPress, disabled, primary }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.actionBtn,
        primary && { backgroundColor: theme.primary },
        pressed && { opacity: 0.7 },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Text style={[styles.actionLabel, primary && { color: '#fff' }]}>{label}</Text>
    </Pressable>
  );
}

function CenterMessage({ children }: { children: React.ReactNode }) {
  return (
    <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
      <Text style={{ color: theme.textMuted }}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
  },
  closeBtn: {
    position: 'absolute',
    top: 60,
    left: 16,
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticle: {
    width: 280,
    height: 280,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderColor: '#f6f4ef',
  },
  cornerTL: { top: 0, left: 0, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 4 },
  cornerTR: { top: 0, right: 0, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 4 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: 4 },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: 4 },
  scanLine: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 0,
    height: 2,
    backgroundColor: '#9adfc8',
    borderRadius: 2,
    shadowColor: '#9adfc8',
    shadowOpacity: 0.95,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  reticleLabel: {
    color: '#f6f4ef',
    marginTop: 24,
    fontSize: 11,
    letterSpacing: 2,
    opacity: 0.7,
    fontFamily: 'Menlo',
  },
  hint: { color: '#fff', marginTop: space.lg, fontSize: 13, fontWeight: '500' },
  sheet: {
    position: 'absolute',
    bottom: 90,
    left: space.lg,
    right: space.lg,
    maxHeight: '75%',
    backgroundColor: theme.card,
    borderRadius: radius.xl,
    padding: space.lg,
    borderWidth: 1,
    borderColor: theme.border,
  },
  headerRow: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  thumb: { width: 72, height: 72, borderRadius: radius.md, backgroundColor: theme.bgElevated },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  thumbPlaceholderText: { color: theme.textMuted, fontSize: 10 },
  sheetSku: { color: theme.textMuted, fontSize: 11, fontFamily: 'Menlo' },
  sheetName: { color: theme.text, fontSize: 17, fontWeight: '700', marginTop: 2 },
  statRow: {
    flexDirection: 'row',
    gap: space.md,
    marginTop: space.lg,
  },
  stat: { flex: 1 },
  statLabel: {
    color: theme.textMuted,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  statValue: { color: theme.text, fontSize: 22, fontWeight: '700', marginTop: 2 },
  statValueMuted: { color: theme.text, fontSize: 14, fontWeight: '600', marginTop: 2 },
  locationBox: {
    marginTop: space.md,
    padding: space.md,
    backgroundColor: theme.bgElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.border,
    gap: 6,
  },
  locRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  locLabel: { color: theme.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  locValue: { color: theme.text, fontSize: 13, fontWeight: '600' },
  crateDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.border,
  },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  actionBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.md,
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
  },
  actionLabel: { color: theme.text, fontWeight: '700', fontSize: 14 },
  secondaryActions: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: space.md,
    alignItems: 'center',
  },
  photoBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
  },
  photoBtnLabel: { color: theme.text, fontWeight: '600', fontSize: 13 },
  dismiss: { flex: 1, alignItems: 'center', paddingVertical: 10 },
  dismissLabel: { color: theme.primary, fontSize: 13, fontWeight: '600' },
  permission: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: space.xl, backgroundColor: theme.bg },
  permTitle: { color: theme.text, fontSize: 20, fontWeight: '700' },
  permBody: { color: theme.textMuted, fontSize: 14, textAlign: 'center', marginTop: space.sm },
  cta: { backgroundColor: theme.primary, paddingHorizontal: space.lg, paddingVertical: 12, borderRadius: radius.md, marginTop: space.lg },
  ctaLabel: { color: '#fff', fontWeight: '600' },
  spinner: { position: 'absolute', top: '50%', left: '50%' },
  addBookWrap: {
    position: 'absolute',
    top: 60,
    left: space.lg,
    right: space.lg,
    bottom: 80,
  },
  modeChips: {
    position: 'absolute',
    top: 16,
    flexDirection: 'row',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 999,
    padding: 4,
  },
  modeChip: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  modeChipOn: { backgroundColor: '#fafaf7' },
  modeLabel: { color: '#fafaf7', fontSize: 12, fontWeight: '600', opacity: 0.7 },
  modeLabelOn: { color: '#0e0f0d', opacity: 1 },
  coverCta: {
    position: 'absolute',
    bottom: 120,
    left: space.lg,
    right: space.lg,
    padding: space.lg,
    borderRadius: radius.xl,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
  },
  coverHint: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginBottom: space.md,
    lineHeight: 18,
  },
  coverShutter: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    backgroundColor: theme.primary,
    borderRadius: radius.md,
    width: '100%',
    alignItems: 'center',
  },
  coverShutterLabel: { color: '#fff', fontSize: 15, fontWeight: '700' },
});

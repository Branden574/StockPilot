import { CameraView, useCameraPermissions } from 'expo-camera';
// `/legacy` is load-bearing: expo-file-system 19 (SDK 54) moved the URI-string
// API (readAsStringAsync, EncodingType) to this subpath. The same names on the
// default export are still typed but THROW at runtime. See
// src/lib/maintenance-upload.ts for the full note.
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { useRouter, type Href } from 'expo-router';
import { X } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatRackHoldings, type RackHoldingLike } from '@stockpilot/core';

import { AddBookCard, type IsbnLookupResult } from '@/components/AddBookCard';
import { AddItemCard, type UpcLookupResult } from '@/components/AddItemCard';
import { SignaturePadModal } from '@/components/signature-pad-modal';
import { CachedImage } from '@/components/ui/cached-image';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { showWriteCta } from '@/lib/cta-gating';
import { useEnabledModules } from '@/lib/enabled-modules';
import { signItemImage } from '@/lib/image-cache';
import { resizeForUpload } from '@/lib/image-resize';
import { resolveScanMatches, sanitizeScanCode } from '@/lib/scan-resolve';
import { supabase } from '@/lib/supabase';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useOrg } from '@/lib/use-org';
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
  /** Rack/crate HOLDINGS (item_stock_levels, qty > 0) this item's stock
   *  actually sits on. When there's more than one, `bin_location` above
   *  is potentially misleading (it names one rack while stock sits on
   *  several) — the location box prefers this breakdown in that case. */
  rackHoldings: RackHoldingLike[];
}

/**
 * One placement row candidate for a scanned barcode/SKU. Under Model B the
 * same SKU can exist as multiple rows (one per charter/rack) — see
 * 0008_warehouse_charters + 0126_relax_sku_uniqueness_per_location. When a
 * scan resolves to more than one of these, the user picks which placement
 * to adjust instead of an arbitrary row being grabbed.
 */
interface ScanCandidate {
  id: string;
  sku: string;
  barcode: string | null;
  charterId: string | null;
  charterName: string | null;
  binLocation: string | null;
  quantityOnHand: number;
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
  const enabledModules = useEnabledModules();
  const permissions = useEffectivePermissions();
  // "Report a problem" launch point (Task 20, master brief §8/§25) — the
  // SAME two-part gate as web's ReportProblemButton
  // (report-problem-button.tsx: `moduleEnabled && canSubmit`), so a viewer
  // who cannot submit never sees a button that only dead-ends on the
  // destination screen's own re-gate.
  const maintenanceEnabled = enabledModules.has('maintenance_requests');
  const canReportProblem =
    maintenanceEnabled && showWriteCta(permissions, 'maintenance_requests:submit');
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = React.useState(true);
  const [mode, setMode] = React.useState<'lookup' | 'cover'>('lookup');
  const { orgId } = useOrg();
  const [item, setItem] = React.useState<FoundItem | null>(null);
  const [addBook, setAddBook] = React.useState<IsbnLookupResult | null>(null);
  const [addItem, setAddItem] = React.useState<UpcLookupResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [lastCode, setLastCode] = React.useState<string | null>(null);
  const [signatureToken, setSignatureToken] = React.useState<string | null>(null);
  const [signatureModalVisible, setSignatureModalVisible] = React.useState(false);
  // Set when a scanned code resolves to MORE THAN ONE placement row (same
  // SKU under different charters/racks) — the picker sheet renders while
  // this is non-null, and is cleared once the user picks one or cancels.
  const [placementChoices, setPlacementChoices] = React.useState<ScanCandidate[] | null>(null);


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

    // Rack/crate HOLDINGS for this item (item_stock_levels, qty > 0) — a
    // scanned item's stock can be split across more than one rack, which
    // makes the single bin_location label above potentially misleading
    // (it names one rack while stock sits on several, and can go stale).
    // No single-warehouse context on this screen (staff scan from
    // anywhere) — list every holding wherever it physically sits, same
    // as the web scanner/lookup API (apps/web/src/app/api/v1/items/lookup).
    const { data: holdingRows } = await supabase
      .from('item_stock_levels')
      .select('quantity, locations!inner(name, kind)')
      .eq('organization_id', orgId)
      .eq('item_id', id)
      .in('locations.kind', ['rack', 'crate'])
      .gt('quantity', 0);
    const rackHoldings: RackHoldingLike[] = ((holdingRows ?? []) as unknown as {
      quantity: number;
      locations: { name: string; kind: string } | { name: string; kind: string }[] | null;
    }[])
      .map((h) => {
        const l = Array.isArray(h.locations) ? h.locations[0] : h.locations;
        return l?.name ? { name: l.name, quantity: Number(h.quantity) || 0 } : null;
      })
      .filter((h): h is RackHoldingLike => h !== null);

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
      rackHoldings,
    };
  }

  /**
   * Loads an item by scanned bare value (matches barcode or SKU). Under
   * Model B the same value can match MULTIPLE placement rows — this
   * resolves every match rather than grabbing an arbitrary one:
   *   - 0 matches → null (caller falls into the "not in inventory" flow).
   *   - 1 match → resolved directly, same as before.
   *   - >1 matches → sets `placementChoices` so the picker sheet renders,
   *     and returns 'ambiguous' so the caller does NOT treat this as a
   *     miss (it very much exists — the user just needs to say which row).
   */
  async function loadItemByValue(value: string): Promise<FoundItem | null | 'ambiguous'> {
    if (!orgId) return null;
    // Strip characters that would break the `.or(...)` filter string (a
    // stray `,`/`()`/`%` in a scanned barcode would otherwise be parsed as
    // extra filter clauses) — mirrors the web lookup route's sanitization.
    const safe = sanitizeScanCode(value);
    const { data: rows } = await supabase
      .from('inventory_items')
      .select(
        `id, sku, barcode, charter_id, bin_location, quantity_on_hand,
         charter:charters!charter_id (name)`,
      )
      .eq('organization_id', orgId)
      .or(`barcode.eq.${safe},sku.eq.${safe}`)
      .is('deleted_at', null);

    const candidates: ScanCandidate[] = ((rows ?? []) as Record<string, unknown>[]).map((r) => {
      const charterRaw = r.charter as { name?: string | null } | { name?: string | null }[] | null;
      const charterObj = Array.isArray(charterRaw) ? charterRaw[0] : charterRaw;
      return {
        id: r.id as string,
        sku: r.sku as string,
        barcode: (r.barcode as string | null) ?? null,
        charterId: (r.charter_id as string | null) ?? null,
        charterName: charterObj?.name ?? null,
        binLocation: (r.bin_location as string | null) ?? null,
        quantityOnHand: Number(r.quantity_on_hand) || 0,
      };
    });

    const resolution = resolveScanMatches(candidates, safe);
    if (resolution.kind === 'not_found') return null;
    if (resolution.kind === 'multiple') {
      setPlacementChoices(resolution.matches);
      return 'ambiguous';
    }
    return loadItemById(resolution.match.id);
  }

  /** User picked a specific placement from the disambiguation sheet. */
  async function choosePlacement(candidate: ScanCandidate) {
    setPlacementChoices(null);
    setBusy(true);
    const found = await loadItemById(candidate.id);
    setBusy(false);
    if (found) setItem(found);
    else reset();
  }

  function cancelPlacementChoice() {
    reset();
  }

  async function onBarCodeScanned({ data }: { data: string }) {
    if (busy || !orgId || data === lastCode) return;
    setLastCode(data);
    setBusy(true);
    setScanning(false);

    // Warehouse packing-slip QR → in-app native signature pad.
    // Extract the token from the scanned URL and open the SignaturePadModal
    // instead of the system browser. Spoofed QRs can't inject a different host
    // because parseSignToken only extracts the token path segment.
    const signToken = parseSignToken(data);
    if (signToken) {
      setSignatureToken(signToken);
      setSignatureModalVisible(true);
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

    if (found === 'ambiguous') {
      // loadItemByValue already populated `placementChoices` — the picker
      // sheet renders below; wait for the user to choose (or cancel).
      setBusy(false);
      return;
    }

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
    setPlacementChoices(null);
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
      // Resize before encoding — a full-res cover base64-encodes to several MB
      // of JS string held in memory during the request. Vision is just as
      // accurate at <=1600px; this slashes the in-memory payload + upload time.
      const { uri: resizedUri, ext } = await resizeForUpload(asset.uri, {
        maxEdge: 1600,
        quality: 0.8,
      });
      // Read the resized file straight to base64 with expo-file-system (the
      // same idiom document-scanner.ts uses). The previous
      // fetch(uri).blob() + FileReader.readAsDataURL chain allocated a native
      // blob and read it back through RCTFileReaderModule — the fragile
      // native module behind a production EXC_BAD_ACCESS (Sentry a8109a24,
      // 2026-08-02, blob read racing blob deallocation). Reading the file
      // directly never creates a native blob at all.
      const base64 = await FileSystem.readAsStringAsync(resizedUri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const vision = await api<{
        kind?: string;
        title?: string;
        author?: string;
        isbn?: string;
        publisher?: string;
        upc?: string;
        brand?: string;
        modelNumber?: string;
        category?: string;
        confidence?: string;
        notes?: string;
      }>('/api/v1/ai/identify-from-photo', {
        method: 'POST',
        body: {
          imageBase64: base64,
          // resizeForUpload normalizes the extension to 'jpg', whose real
          // MIME type is image/jpeg ('image/jpg' is not a registered type).
          mimeType: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`,
        },
      });

      // GENERAL PRODUCT (not a book): flow into the UPC/new-item pipeline
      // instead of the book one. If Vision read a UPC off the packaging,
      // re-chain through the authoritative upc-lookup first (enrichment +
      // exists-in-inventory), exactly like the ISBN re-chain below; fall back
      // to Vision's own fields so the user still gets a one-tap add card.
      if (vision.kind === 'product') {
        const visionUpc = (vision.upc ?? '').replace(/\D/g, '');
        if (visionUpc.length >= 11 && visionUpc.length <= 14) {
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
            }>(`/api/v1/items/upc-lookup?upc=${encodeURIComponent(visionUpc)}`);
            setAddItem({
              upc: visionUpc,
              source: res.source,
              existingItem:
                res.existsInInventory && res.itemId
                  ? { id: res.itemId, name: res.enrichment.name }
                  : null,
              enrichment: res.enrichment,
            });
            return;
          } catch {
            /* ignore — fall back to Vision's own fields below */
          }
        }
        setAddItem({
          // Empty when Vision couldn't read a real code — AddItemCard treats
          // an empty upc as "no barcode" (never persist a placeholder string).
          upc: visionUpc,
          source: 'ai-fallback',
          existingItem: null,
          enrichment: vision.title
            ? {
                name: vision.brand && !vision.title.toLowerCase().includes(vision.brand.toLowerCase())
                  ? `${vision.brand} ${vision.title}`
                  : vision.title,
                description: vision.notes ?? null,
                brand: vision.brand ?? null,
                modelNumber: vision.modelNumber ?? null,
                imageUrl: asset.uri,
              }
            : null,
        });
        return;
      }

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
      Alert.alert('Photo ID failed', e instanceof Error ? e.message : 'Unknown error');
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
          <Text style={styles.permBody}>
            {permission.canAskAgain
              ? 'StockPilot uses the camera to scan barcodes and QR codes.'
              : 'Camera access is off for StockPilot. Turn it on in Settings to scan barcodes and QR codes.'}
          </Text>
          {/* App Store 5.1.1(iv): a pre-permission prompt must use a NEUTRAL
              button ("Continue"), never directive text ("Grant"/"Allow") — the
              OS dialog makes the actual ask. If the user previously denied
              (canAskAgain=false), iOS won't re-prompt, so we link to Settings
              instead of a button that silently does nothing. */}
          {permission.canAskAgain ? (
            <Pressable style={styles.cta} onPress={requestPermission}>
              <Text style={styles.ctaLabel}>Continue</Text>
            </Pressable>
          ) : (
            <Pressable style={styles.cta} onPress={() => Linking.openSettings()}>
              <Text style={styles.ctaLabel}>Open Settings</Text>
            </Pressable>
          )}
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
      {scanning && !item && !addBook && !placementChoices && mode === 'lookup' ? (
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
                Photo ID
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
              item.rackHoldings.length > 1 ||
              storage?.rackLabel ||
              storage?.crateNumber ||
              storage?.grade) && (
              <View style={styles.locationBox}>
                {item.primary_location_name && (
                  <LocRow label="Location" value={item.primary_location_name} />
                )}
                {item.rackHoldings.length > 1 ? (
                  // Stock is SPLIT across more than one rack/crate — the
                  // single bin_location label would only point at one of
                  // them, so show the full breakdown instead (mirrors the
                  // web pick-slip / count-sheet PDFs' locationFor).
                  <LocRow
                    label="Split stock"
                    value={formatRackHoldings(item.rackHoldings) ?? ''}
                  />
                ) : (
                  item.bin_location && (
                    <LocRow label="Bin/shelf" value={item.bin_location} />
                  )
                )}
                {storage?.rackLabel && (
                  <LocRow label="Rack" value={storage.rackLabel} mono />
                )}
                {storage?.crateNumber && (
                  <View style={styles.locRow}>
                    <Text style={styles.locLabel}>Crate</Text>
                    <View
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                    >
                      {/* Number identifies the crate; the color is optional.
                          A hollow dot (bordered, no fill) means "no color set". */}
                      <View
                        style={[
                          styles.crateDot,
                          crateHex ? { backgroundColor: crateHex } : null,
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

            {canReportProblem ? (
              <Pressable
                style={styles.reportProblemBtn}
                onPress={() =>
                  router.push({
                    pathname: '/maintenance/new',
                    // Deep-link HINT only (mirrors web's ReportProblemButton
                    // doc comment) — the create route re-derives and
                    // validates this id server-side (uuid shape + THIS org)
                    // before it is ever attached to a request. Only the id
                    // crosses the boundary; sku/name stay client-local
                    // display data the server never trusts or re-reads from
                    // here (binding constraint 6).
                    params: { itemId: item.id },
                    // .expo/types/router.d.ts is stale (regenerated only by
                    // the Expo dev server) and predates Task 19's route —
                    // same cast maintenance.tsx's own 'New' button already
                    // needs for this identical reason (see that file). The
                    // double cast (TS's own suggested escape hatch) is
                    // required because an unregistered pathname doesn't
                    // structurally overlap any registered route's object
                    // shape, unlike the plain-string form.
                  } as unknown as Href)
                }
              >
                <Text style={styles.reportProblemLabel}>Report a problem</Text>
              </Pressable>
            ) : null}
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

      {placementChoices && (
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={{ paddingBottom: space.md }}>
            <Text style={styles.pickerTitle}>Multiple placements found</Text>
            <Text style={styles.pickerSubtitle}>
              This SKU is stocked in more than one place. Choose which one to adjust.
            </Text>
            {placementChoices.map((c) => (
              <Pressable
                key={c.id}
                style={({ pressed }) => [styles.pickerRow, pressed && { opacity: 0.7 }]}
                onPress={() => void choosePlacement(c)}
                disabled={busy}
              >
                <Text style={styles.pickerRowTitle} numberOfLines={1}>
                  {c.charterName ?? 'Unassigned charter'}
                </Text>
                <Text style={styles.pickerRowSubtitle} numberOfLines={1}>
                  {c.binLocation ?? 'No bin set'} · {c.quantityOnHand} on hand
                </Text>
              </Pressable>
            ))}
            <Pressable style={styles.dismiss} onPress={cancelPlacementChoice} disabled={busy}>
              <Text style={styles.dismissLabel}>Cancel</Text>
            </Pressable>
          </ScrollView>
        </View>
      )}

      {busy && !item && !addBook && !addItem && !placementChoices && (
        <ActivityIndicator style={styles.spinner} color="#fafaf7" size="large" />
      )}

      {signatureToken ? (
        <SignaturePadModal
          visible={signatureModalVisible}
          onClose={() => {
            setSignatureModalVisible(false);
            setSignatureToken(null);
            reset();
          }}
          onSuccess={() => {
            setSignatureModalVisible(false);
            setSignatureToken(null);
            reset();
          }}
          signatureToken={signatureToken}
        />
      ) : null}
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
  reportProblemBtn: {
    marginTop: space.sm,
    paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
  },
  reportProblemLabel: { color: theme.text, fontWeight: '600', fontSize: 13 },
  pickerTitle: { color: theme.text, fontSize: 17, fontWeight: '700' },
  pickerSubtitle: { color: theme.textMuted, fontSize: 13, marginTop: 4, marginBottom: space.md },
  pickerRow: {
    paddingVertical: 12,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.border,
    marginBottom: space.sm,
  },
  pickerRowTitle: { color: theme.text, fontSize: 15, fontWeight: '700' },
  pickerRowSubtitle: { color: theme.textMuted, fontSize: 12.5, marginTop: 2 },
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

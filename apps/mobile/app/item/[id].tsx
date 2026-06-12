import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowLeftRight,
  ArrowUpRight,
  Camera,
  ChevronLeft,
  Edit3,
  Minus,
  Plus,
  RotateCcw,
} from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { CachedImage } from '@/components/ui/cached-image';
import { Card, Hair } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useOrg } from '@/lib/use-org';
import { signItemImage } from '@/lib/image-cache';
import { resizeForUpload } from '@/lib/image-resize';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT, SHADOW } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface Item {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  description: string | null;
  quantity_on_hand: number;
  reorder_point: number;
  reorder_quantity: number;
  unit_cost: number;
  retail_price: number;
  unit_of_measure: string;
  status: string;
  category_id: string | null;
  category_name: string | null;
  supplier_name: string | null;
  location_name: string | null;
  warehouse_name: string | null;
  bin_location: string | null;
  charter_name: string | null;
  item_type: string | null;
  rack_label: string | null;
  crate_color: string | null;
  crate_number: string | null;
  grade: string | null;
  imageUrl: string | null;
}

interface MovementRow {
  id: string;
  movement_type: string;
  quantity_change: number;
  previous_quantity: number;
  new_quantity: number;
  reason: string | null;
  created_at: string;
  actor: { full_name: string | null; email: string | null } | null;
}

const TYPE_LABEL: Record<string, string> = {
  add: 'Added',
  remove: 'Removed',
  adjust: 'Adjusted',
  transfer: 'Transferred',
  receive_po: 'Received',
  return: 'Returned',
  damage: 'Damaged',
  loss: 'Lost',
  correction: 'Corrected',
  initial: 'Initialized',
};

type TabId = 'overview' | 'movements';

function mimeForExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  if (e === 'heic') return 'image/heic';
  if (e === 'webp') return 'image/webp';
  return `image/${e}`;
}

export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { c } = useTheme();
  const { orgId } = useOrg();
  const [item, setItem] = React.useState<Item | null>(null);
  const [movements, setMovements] = React.useState<MovementRow[]>([]);
  const [movementsLoading, setMovementsLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState<TabId>('overview');
  const [adjustOpen, setAdjustOpen] = React.useState(false);
  const [photoBusy, setPhotoBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!id) return;
    const { data } = await supabase
      .from('inventory_items')
      .select(
        `id, name, sku, barcode, description, quantity_on_hand,
         reorder_point, reorder_quantity, unit_cost, retail_price,
         unit_of_measure, status, category_id, item_type, bin_location,
         warehouse_id, charter_id, custom_fields,
         category:categories!category_id (name),
         supplier:suppliers!supplier_id (name),
         primary_location:locations!primary_location_id (name)`,
      )
      .eq('id', id)
      .maybeSingle();
    if (!data) {
      Alert.alert('Not found', 'This item no longer exists.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
      return;
    }
    const r = data as Record<string, unknown>;
    const cat = r.category as { name?: string } | { name?: string }[] | null;
    const sup = r.supplier as { name?: string } | { name?: string }[] | null;
    const loc = r.primary_location as { name?: string } | { name?: string }[] | null;

    // Rack stamp keys differ by item_type so books and products don't
    // clobber each other in custom_fields:
    //   • products:  rack_number + rack_row
    //   • books:     book_rack_number + book_rack_row
    // Crate info (color + number) and grade are book-only — products
    // are just on a rack.
    const cf = (r.custom_fields as Record<string, unknown> | null) ?? null;
    const cfStr = (key: string): string | null => {
      const v = cf?.[key];
      return typeof v === 'string' && v.trim() !== '' ? v : null;
    };
    const itemTypeStr = (r.item_type as string | null) ?? 'product';
    const isBook = itemTypeStr === 'book';
    const rackNum = isBook
      ? cfStr('book_rack_number') ?? cfStr('rack_number')
      : cfStr('rack_number') ?? cfStr('book_rack_number');
    const rackRow = isBook
      ? cfStr('book_rack_row') ?? cfStr('rack_row')
      : cfStr('rack_row') ?? cfStr('book_rack_row');
    // Legacy free-text rack label support (older imports stamped this
    // single value before the structured number/row split).
    const legacyRack =
      cfStr('rackLabel') ?? cfStr('rack_label') ?? cfStr('rack');
    const rackLabel = rackNum || rackRow
      ? [rackNum, rackRow].filter(Boolean).join(' · ')
      : legacyRack;
    const crateColor = cfStr('crateColor') ?? cfStr('crate_color');
    const crateNumber = cfStr('crateNumber') ?? cfStr('crate_number');
    const grade = cfStr('grade');

    // Warehouse is resolved in a second pass to avoid a multi-FK embed
    // (`warehouses` has two relations into other tables that confuse
    // PostgREST). Cheap because we filter to one row.
    //
    // Charter comes from the ITEM's own charter_id — never from the
    // warehouse. warehouse_charters is many-to-many (one warehouse hosts
    // inventory for many charters), so deriving it from the warehouse
    // stamped an arbitrary charter (whichever row came first) on every
    // item in the building. charter_id IS NULL = "Generic" (any charter
    // the warehouse services can use) — same sentinel the web table uses.
    let warehouseName: string | null = null;
    let charterName: string | null = null;
    const whId = r.warehouse_id as string | null | undefined;
    const charterId = r.charter_id as string | null | undefined;
    const [whResp, chResp] = await Promise.all([
      whId
        ? supabase.from('warehouses').select('name').eq('id', whId).maybeSingle()
        : Promise.resolve(null),
      charterId
        ? supabase.from('charters').select('name').eq('id', charterId).maybeSingle()
        : Promise.resolve(null),
    ]);
    warehouseName = (whResp?.data?.name as string | undefined) ?? null;
    charterName = charterId
      ? ((chResp?.data?.name as string | undefined) ?? null)
      : 'Generic';

    // Primary image — cached signed URL (reused across screens).
    const { data: imgRow } = await supabase
      .from('item_images')
      .select('storage_path')
      .eq('item_id', r.id as string)
      .order('is_primary', { ascending: false })
      .order('sort_order', { ascending: true })
      .limit(1)
      .maybeSingle();
    let imageUrl: string | null = null;
    if (imgRow?.storage_path) {
      imageUrl = await signItemImage(imgRow.storage_path as string);
    }

    setItem({
      id: r.id as string,
      name: r.name as string,
      sku: r.sku as string,
      barcode: (r.barcode as string | null) ?? null,
      description: (r.description as string | null) ?? null,
      quantity_on_hand: Number(r.quantity_on_hand) || 0,
      reorder_point: Number(r.reorder_point) || 0,
      reorder_quantity: Number(r.reorder_quantity) || 0,
      unit_cost: Number(r.unit_cost) || 0,
      retail_price: Number(r.retail_price) || 0,
      unit_of_measure: (r.unit_of_measure as string) ?? 'EA',
      status: r.status as string,
      category_id: (r.category_id as string | null) ?? null,
      category_name: Array.isArray(cat) ? cat[0]?.name ?? null : cat?.name ?? null,
      supplier_name: Array.isArray(sup) ? sup[0]?.name ?? null : sup?.name ?? null,
      location_name: Array.isArray(loc) ? loc[0]?.name ?? null : loc?.name ?? null,
      warehouse_name: warehouseName,
      bin_location: (r.bin_location as string | null) ?? null,
      charter_name: charterName,
      item_type: (r.item_type as string | null) ?? null,
      rack_label: rackLabel,
      crate_color: crateColor,
      crate_number: crateNumber,
      grade,
      imageUrl,
    });
  }, [id, router]);

  const loadMovements = React.useCallback(async () => {
    if (!id || !orgId) return;
    setMovementsLoading(true);
    const { data } = await supabase
      .from('stock_movements')
      .select(
        `id, movement_type, quantity_change, previous_quantity, new_quantity,
         reason, created_at,
         actor:user_profiles!user_id (full_name, email)`,
      )
      .eq('organization_id', orgId)
      .eq('item_id', id)
      .order('created_at', { ascending: false })
      .limit(50);
    setMovements(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const actor = r.actor as MovementRow['actor'] | MovementRow['actor'][] | null;
        return {
          id: r.id as string,
          movement_type: r.movement_type as string,
          quantity_change: Number(r.quantity_change) || 0,
          previous_quantity: Number(r.previous_quantity) || 0,
          new_quantity: Number(r.new_quantity) || 0,
          reason: (r.reason as string | null) ?? null,
          created_at: r.created_at as string,
          actor: Array.isArray(actor) ? actor[0] ?? null : actor,
        };
      }),
    );
    setMovementsLoading(false);
  }, [id, orgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (tab === 'movements') void loadMovements();
  }, [tab, loadMovements]);

  async function adjust(delta: number, reason = 'Mobile detail') {
    if (!item) return;
    setBusy(true);
    const { error } = await supabase.rpc('adjust_stock', {
      p_item_id: item.id,
      p_quantity_change: delta,
      p_movement_type: delta > 0 ? 'add' : 'remove',
      p_location_id: null,
      p_reason: reason,
      p_notes: null,
    });
    setBusy(false);
    if (error) {
      Alert.alert('Could not adjust', error.message);
      return;
    }
    setItem({ ...item, quantity_on_hand: item.quantity_on_hand + delta });
    if (tab === 'movements') void loadMovements();
  }

  function openEdit() {
    if (!item) return;
    Linking.openURL(
      `https://stockpilotusa.com/dashboard/inventory/${item.id}/edit`,
    ).catch(() => undefined);
  }

  async function pickFromCamera() {
    let perm = await ImagePicker.getCameraPermissionsAsync();
    if (!perm.granted) perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        'Camera access needed',
        perm.canAskAgain
          ? 'Allow camera in the prompt to take photos.'
          : 'Enable camera in Settings → StockPilot.',
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
      await uploadAndReplace(a.uri, ext);
    } catch (e) {
      Alert.alert(
        'Camera unavailable',
        e instanceof Error ? e.message : 'Use Library instead.',
      );
    }
  }

  async function pickFromLibrary() {
    let perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!perm.granted) perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Photo access needed', 'Allow photo library to attach images.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 0.7,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: false,
    });
    if (result.canceled || !result.assets[0]) return;
    const a = result.assets[0];
    const ext = (a.uri.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'jpg').toLowerCase();
    await uploadAndReplace(a.uri, ext);
  }

  function openPhotoActions() {
    if (!item || photoBusy) return;
    const hasPhoto = !!item.imageUrl;
    Alert.alert(
      hasPhoto ? 'Replace photo' : 'Add photo',
      undefined,
      [
        { text: 'Take photo', onPress: () => void pickFromCamera() },
        { text: 'Choose from library', onPress: () => void pickFromLibrary() },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }

  async function uploadAndReplace(uri: string, ext: string) {
    if (!item || !orgId) return;
    setPhotoBusy(true);
    try {
      // Resize on-device so the bucket only stores list-friendly sizes
      // (~400 KB JPEGs instead of multi-megapixel phone photos).
      const resized = await resizeForUpload(uri);
      const path = `${orgId}/items/${item.id}/${Math.random().toString(36).slice(2, 14)}.${resized.ext}`;
      // ArrayBuffer upload — `fetch(uri).blob()` uploads a 0-byte object
      // to Supabase Storage in RN/Expo, so use arrayBuffer().
      const arrayBuffer = await (await fetch(resized.uri)).arrayBuffer();
      const { error: upErr } = await supabase.storage
        .from('item-images')
        .upload(path, arrayBuffer, { contentType: mimeForExt(resized.ext) });
      if (upErr) {
        Alert.alert('Upload failed', upErr.message);
        return;
      }
      // Wipe any existing image rows + their storage files. Cleans up
      // the legacy 0-byte uploads from before the arrayBuffer fix.
      const { data: oldRows } = await supabase
        .from('item_images')
        .select('id, storage_path')
        .eq('item_id', item.id);
      const oldPaths = ((oldRows ?? []) as Array<{ storage_path: string | null }>)
        .map((r) => r.storage_path)
        .filter((p): p is string => !!p);
      if (oldPaths.length > 0) {
        await supabase.storage.from('item-images').remove(oldPaths);
        await supabase.from('item_images').delete().eq('item_id', item.id);
      }
      const { error: insErr } = await supabase.from('item_images').insert({
        organization_id: orgId,
        item_id: item.id,
        storage_path: path,
        is_primary: true,
      });
      if (insErr) {
        Alert.alert('Save failed', insErr.message);
        return;
      }
      const signedUrl = await signItemImage(path);
      setItem({ ...item, imageUrl: signedUrl });
    } catch (e) {
      Alert.alert('Photo error', e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setPhotoBusy(false);
    }
  }

  if (!item) {
    return (
      <View style={[styles.root, { backgroundColor: c.paper, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={c.ink} />
      </View>
    );
  }

  const lowStock = item.reorder_point > 0 && item.quantity_on_hand <= item.reorder_point;
  const status: 'ok' | 'warn' | 'crit' =
    item.quantity_on_hand <= 0 ? 'crit' : lowStock ? 'warn' : 'ok';
  const inventoryValue = item.unit_cost * item.quantity_on_hand;

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ChevronLeft} onPress={() => router.back()} />
          <IconChip icon={Edit3} onPress={openEdit} />
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Hero */}
        <View style={styles.hero}>
          <Mono size={9.5} tracking={0.2} upper color={c.ink4}>
            — {item.sku}
          </Mono>
          <Display size={26} style={{ marginTop: 6 }}>
            {item.name}
          </Display>
          {item.category_name || item.barcode ? (
            <Mono size={11.5} tracking={0.04} color={c.ink4} style={{ marginTop: 6 }}>
              {[item.category_name, item.barcode].filter(Boolean).join(' · ')}
            </Mono>
          ) : null}
        </View>

        {/* Image — tap to add or replace */}
        <View style={{ paddingHorizontal: 20, marginTop: 10 }}>
          <Pressable
            onPress={openPhotoActions}
            disabled={photoBusy}
            style={({ pressed }) => ({ opacity: pressed && !photoBusy ? 0.85 : 1 })}
            accessibilityRole="button"
            accessibilityLabel={item.imageUrl ? 'Replace photo' : 'Add photo'}
          >
            <View
              style={{
                aspectRatio: 4 / 3,
                borderRadius: 14,
                overflow: 'hidden',
                borderWidth: 1,
                borderColor: c.hair,
                backgroundColor: c.paper2,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              {item.imageUrl ? (
                <CachedImage
                  uri={item.imageUrl}
                  style={{ width: '100%', height: '100%' }}
                  recyclingKey={`${item.id}-${item.imageUrl}`}
                />
              ) : (
                <View style={{ alignItems: 'center', gap: 8 }}>
                  <Camera size={28} color={c.ink4} strokeWidth={1.4} />
                  <Mono size={11} tracking={0.12} upper color={c.ink4}>
                    Tap to add photo
                  </Mono>
                </View>
              )}
              {item.imageUrl && !photoBusy ? (
                <View
                  style={{
                    position: 'absolute',
                    bottom: 10,
                    right: 10,
                    backgroundColor: 'rgba(0,0,0,0.55)',
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Camera size={12} color="#fff" strokeWidth={1.6} />
                  <Mono size={10} tracking={0.12} upper color="#fff">
                    Replace
                  </Mono>
                </View>
              ) : null}
              {photoBusy ? (
                <View
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: 'rgba(0,0,0,0.4)',
                    justifyContent: 'center',
                    alignItems: 'center',
                  }}
                >
                  <ActivityIndicator color="#fff" />
                </View>
              ) : null}
            </View>
          </Pressable>
        </View>

        {/* Tab bar */}
        <View style={styles.tabsRow}>
          <TabButton
            label="Overview"
            active={tab === 'overview'}
            onPress={() => setTab('overview')}
          />
          <TabButton
            label="Movements"
            active={tab === 'movements'}
            onPress={() => setTab('movements')}
          />
        </View>

        {tab === 'overview' ? (
          <View style={{ paddingHorizontal: 20, gap: 14 }}>
            {/* Stock card */}
            <Card hero style={{ padding: 20 }}>
              <Eyebrow>ON HAND</Eyebrow>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
                <Mono size={56} tracking={-0.025} color={c.ink} style={{ fontFamily: FONT.display }}>
                  {item.quantity_on_hand}
                </Mono>
                <Body size={16} color={c.ink4}>
                  {item.unit_of_measure}
                </Body>
                <View style={{ marginLeft: 'auto' }}>
                  {status === 'ok' ? <Pill status="ok">OK</Pill> : null}
                  {status === 'warn' ? <Pill status="warn">LOW</Pill> : null}
                  {status === 'crit' ? <Pill status="crit">OUT</Pill> : null}
                </View>
              </View>
              <Mono size={11.5} tracking={0.04} color={c.ink4} style={{ marginTop: 6 }}>
                Reorder at {item.reorder_point} · suggested reorder {item.reorder_quantity}
              </Mono>

              <View style={styles.quickAdjust}>
                <QuickBtn label="−5" onPress={() => adjust(-5)} disabled={busy} />
                <QuickBtn label="−1" onPress={() => adjust(-1)} disabled={busy} />
                <QuickBtn label="+1" onPress={() => adjust(1)} disabled={busy} primary />
                <QuickBtn label="+5" onPress={() => adjust(5)} disabled={busy} primary />
              </View>

              <Button
                block
                variant="outline"
                onPress={() => setAdjustOpen(true)}
                leading={<ArrowLeftRight size={16} color={c.ink} strokeWidth={1.5} />}
                style={{ marginTop: 12 }}
              >
                Adjust with reason
              </Button>
            </Card>

            {/* Meta card */}
            <Card padding={0}>
              <MetaRow label="UNIT COST" value={`$${item.unit_cost.toFixed(2)}`} />
              <Hair inset={20} />
              <MetaRow label="RETAIL PRICE" value={`$${item.retail_price.toFixed(2)}`} />
              <Hair inset={20} />
              <MetaRow label="INVENTORY VALUE" value={`$${inventoryValue.toFixed(2)}`} />
              {item.supplier_name ? (
                <>
                  <Hair inset={20} />
                  <MetaRow label="SUPPLIER" value={item.supplier_name} />
                </>
              ) : null}
            </Card>

            {/* Location block — only render when at least one field is
                populated. Mirrors what the web detail page shows under
                its "Location & storage" section. */}
            {(() => {
              const isBookView = item.item_type === 'book';
              const rows: Array<{ label: string; value: string }> = [];
              if (item.warehouse_name) rows.push({ label: 'WAREHOUSE', value: item.warehouse_name });
              if (item.charter_name) rows.push({ label: 'CHARTER', value: item.charter_name });
              if (item.location_name) rows.push({ label: 'LOCATION', value: item.location_name });
              if (item.rack_label) rows.push({ label: 'RACK', value: item.rack_label });
              if (isBookView && (item.crate_color || item.crate_number)) {
                rows.push({
                  label: 'CRATE',
                  value: [item.crate_color, item.crate_number].filter(Boolean).join(' · '),
                });
              }
              if (isBookView && item.grade) rows.push({ label: 'GRADE', value: item.grade });
              // bin_location is a separate free-text field — only render
              // it when there's NO structured rack info, to avoid double
              // labelling for the same physical spot.
              if (!item.rack_label && item.bin_location) {
                rows.push({ label: isBookView ? 'BIN' : 'RACK', value: item.bin_location });
              }
              if (rows.length === 0) return null;
              return (
                <Card padding={0}>
                  {rows.map((row, i) => (
                    <React.Fragment key={row.label}>
                      {i > 0 ? <Hair inset={20} /> : null}
                      <MetaRow label={row.label} value={row.value} />
                    </React.Fragment>
                  ))}
                </Card>
              );
            })()}

            {item.description ? (
              <Card padding={16}>
                <Eyebrow>DESCRIPTION</Eyebrow>
                <Body style={{ marginTop: 8 }}>{item.description}</Body>
              </Card>
            ) : null}

            <Pressable
              onPress={openEdit}
              style={({ pressed }) => ({
                marginTop: 4,
                alignItems: 'center',
                paddingVertical: 14,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Mono size={11} tracking={0.12} upper color={c.ink}>
                  Edit on web
                </Mono>
                <ArrowUpRight size={12} color={c.ink} strokeWidth={1.6} />
              </View>
            </Pressable>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 20 }}>
            {movementsLoading ? (
              <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
            ) : movements.length === 0 ? (
              <View style={{ padding: 32, alignItems: 'center' }}>
                <ArrowLeftRight size={32} color={c.ink4} strokeWidth={1.3} />
                <Display size={18} style={{ marginTop: 12 }}>
                  No movements <Em>yet.</Em>
                </Display>
                <Body muted style={{ marginTop: 6, textAlign: 'center', maxWidth: 280 }}>
                  Adjustments, receipts, and counts will appear here as you work.
                </Body>
              </View>
            ) : (
              <View style={{ gap: 8 }}>
                {movements.map((m) => (
                  <MovementCard key={m.id} movement={m} />
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      <AdjustModal
        visible={adjustOpen}
        item={item}
        busy={busy}
        onClose={() => setAdjustOpen(false)}
        onConfirm={async (delta, reason) => {
          await adjust(delta, reason);
          setAdjustOpen(false);
        }}
      />
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, flex: 1 })}
    >
      <View
        style={{
          paddingVertical: 12,
          alignItems: 'center',
          borderBottomWidth: 2,
          borderBottomColor: active ? c.ink : 'transparent',
        }}
      >
        <Mono
          size={11}
          tracking={0.12}
          upper
          color={active ? c.ink : c.ink4}
          style={{ fontFamily: FONT.mono }}
        >
          {label}
        </Mono>
      </View>
    </Pressable>
  );
}

function QuickBtn({
  label,
  onPress,
  disabled,
  primary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.quickBtn,
        {
          backgroundColor: primary ? c.ink : c.card,
          borderColor: primary ? c.ink : c.hair,
          opacity: disabled ? 0.4 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <Mono
        size={15}
        tracking={-0.012}
        color={primary ? c.paper : c.ink}
        style={{ fontFamily: FONT.display }}
      >
        {label}
      </Mono>
    </Pressable>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  const { c } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 16,
      }}
    >
      <Mono size={10.5} tracking={0.12} upper color={c.ink4}>
        {label}
      </Mono>
      <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
        {value}
      </Body>
    </View>
  );
}

function MovementCard({ movement }: { movement: MovementRow }) {
  const { c } = useTheme();
  const isAdd = movement.quantity_change > 0;
  const Icon = isAdd ? Plus : movement.quantity_change < 0 ? Minus : RotateCcw;
  const pipColor = isAdd ? ACCENT.mint : movement.quantity_change < 0 ? ACCENT.crit : ACCENT.warn;
  const verb = TYPE_LABEL[movement.movement_type] ?? movement.movement_type;
  const actor = movement.actor?.full_name ?? movement.actor?.email ?? 'system';
  return (
    <Card padding={12}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: c.hair,
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            backgroundColor: c.card,
          }}
        >
          <Icon size={14} color={c.ink} strokeWidth={1.6} />
          <View
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 5,
              height: 5,
              borderRadius: 3,
              backgroundColor: pipColor,
            }}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Body size={14} color={c.ink} style={{ fontFamily: FONT.display }}>
            {verb}
            {movement.reason ? ` · ${movement.reason}` : ''}
          </Body>
          <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 3 }}>
            {actor} · {new Date(movement.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </Mono>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Mono
            size={15}
            tracking={-0.012}
            color={isAdd ? ACCENT.mintInk : movement.quantity_change < 0 ? ACCENT.crit : c.ink}
            style={{ fontFamily: FONT.display }}
          >
            {isAdd ? '+' : ''}
            {movement.quantity_change}
          </Mono>
          <Mono size={9.5} tracking={0.04} color={c.ink4} style={{ marginTop: 2 }}>
            {movement.previous_quantity} → {movement.new_quantity}
          </Mono>
        </View>
      </View>
    </Card>
  );
}

function AdjustModal({
  visible,
  item,
  busy,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  item: Item;
  busy: boolean;
  onClose: () => void;
  onConfirm: (delta: number, reason: string) => Promise<void>;
}) {
  const { c, mode } = useTheme();
  const [delta, setDelta] = React.useState('');
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (visible) {
      setDelta('');
      setReason('');
    }
  }, [visible]);

  const parsedDelta = parseInt(delta, 10);
  const isValid = !Number.isNaN(parsedDelta) && parsedDelta !== 0;
  const preview =
    isValid ? item.quantity_on_hand + parsedDelta : item.quantity_on_hand;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          onPress={onClose}
          style={[
            {
              flex: 1,
              justifyContent: 'flex-end',
              backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)',
            },
          ]}
        >
        <Pressable
          onPress={() => undefined}
          style={[
            {
              backgroundColor: c.card,
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              paddingTop: 12,
              paddingBottom: 36,
              paddingHorizontal: 22,
            },
            SHADOW.sheet,
          ]}
        >
          <View style={{ alignItems: 'center', marginBottom: 18 }}>
            <View
              style={{
                width: 36,
                height: 5,
                borderRadius: 100,
                backgroundColor: mode === 'dark' ? 'rgba(250,250,247,0.22)' : 'rgba(14,15,13,0.18)',
              }}
            />
          </View>
          <Eyebrow>ADJUST STOCK</Eyebrow>
          <Display size={24} style={{ marginTop: 10 }}>
            {item.name}
          </Display>
          <Mono size={11.5} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
            on hand {item.quantity_on_hand} {item.unit_of_measure}
          </Mono>

          <View style={{ marginTop: 20, gap: 14 }}>
            <View style={{ gap: 6 }}>
              <Mono size={10} tracking={0.12} upper color={c.ink4}>
                CHANGE (+ ADDS, − REMOVES)
              </Mono>
              <TextInput
                value={delta}
                onChangeText={setDelta}
                placeholder="e.g. -3 or 12"
                placeholderTextColor={c.ink5}
                keyboardType="numbers-and-punctuation"
                autoFocus
                style={{
                  fontFamily: FONT.display,
                  fontSize: 18,
                  height: 52,
                  paddingHorizontal: 14,
                  borderWidth: 1,
                  borderColor: c.hair,
                  borderRadius: 8,
                  color: c.ink,
                  backgroundColor: c.paper2,
                }}
              />
            </View>
            <View style={{ gap: 6 }}>
              <Mono size={10} tracking={0.12} upper color={c.ink4}>
                REASON (OPTIONAL)
              </Mono>
              <TextInput
                value={reason}
                onChangeText={setReason}
                placeholder="Cycle count variance, damage, etc."
                placeholderTextColor={c.ink5}
                style={{
                  fontFamily: FONT.displayRegular,
                  fontSize: 15,
                  height: 50,
                  paddingHorizontal: 14,
                  borderWidth: 1,
                  borderColor: c.hair,
                  borderRadius: 8,
                  color: c.ink,
                  backgroundColor: c.paper2,
                }}
              />
            </View>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginTop: 4,
              }}
            >
              <Mono size={10.5} tracking={0.12} upper color={c.ink4}>
                NEW TOTAL
              </Mono>
              <Mono
                size={28}
                tracking={-0.022}
                color={preview < 0 ? ACCENT.crit : preview === 0 ? ACCENT.warn : c.ink}
                style={{ fontFamily: FONT.display }}
              >
                {preview}
              </Mono>
            </View>
          </View>

          <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
            <View style={{ flex: 1 }}>
              <Button block variant="ghost" onPress={onClose}>
                Cancel
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button
                block
                onPress={() => isValid && onConfirm(parsedDelta, reason || 'Mobile detail')}
                disabled={!isValid || busy}
              >
                {busy ? 'Saving…' : 'Confirm'}
              </Button>
            </View>
          </View>
        </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  hero: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  tabsRow: {
    flexDirection: 'row',
    marginTop: 16,
    marginBottom: 16,
    marginHorizontal: 20,
  },
  quickAdjust: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  quickBtn: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

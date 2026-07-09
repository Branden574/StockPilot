import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { ArrowLeft, Camera, ImagePlus, PenLine, Trash2, Truck, X } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DigitalPick } from '@/components/digital-pick';
import { SignaturePadModal } from '@/components/signature-pad-modal';

import { CachedImage } from '@/components/ui/cached-image';
import { Card } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { resizeForUpload } from '@/lib/image-resize';
import { profileFromEmbed, resolveRequesterLabel } from '@/lib/requester-label';
import {
  claimPicking,
  listOrderDrivers,
  releasePicking,
  transitionOrder,
  type OrderAction,
  type OrderDriver,
} from '@/lib/orders-api';
import {
  availableOrderActions,
  can,
  derivePickingStatus,
  type FulfillmentType,
  type OrderStatus,
  type Role,
} from '@stockpilot/core';
import { getOrderShipment, type OrderShipment } from '@/lib/shipping-api';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/use-workspace';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

const BUCKET = 'order-attachments';

const ATTACHABLE = [
  'staged_for_pickup',
  'staged_for_delivery',
  'in_transit',
  'signature_requested',
  'completed',
];

const KIND_LABELS: Record<string, string> = {
  signature: 'Wet signature',
  dropoff_photo: 'Items dropped off',
  location: 'Drop-off location',
  other: 'Other',
};
const KINDS = ['dropoff_photo', 'location', 'signature', 'other'] as const;
type Kind = (typeof KINDS)[number];

const SHIPMENT_STATUS_LABELS: Record<string, string> = {
  draft: 'Label not purchased',
  purchased: 'Label purchased',
  in_transit: 'In transit',
  delivered: 'Delivered',
  returned: 'Returned',
  failure: 'Delivery failed',
  cancelled: 'Cancelled',
};

function mimeForExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  if (e === 'heic') return 'image/heic';
  if (e === 'webp') return 'image/webp';
  return `image/${e}`;
}

interface OrderHeader {
  id: string;
  status: string;
  requester: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  orgLabel: string | null;
  warehouseName: string | null;
  /** Whether a signature exists. The blob itself is fetched on modal-open,
   *  not shipped in the order payload to every viewer. */
  hasSignature: boolean;
  signedByName: string | null;
  signedAt: string | null;
  createdAt: string | null;
  assignedDeliveryUserId: string | null;
  /** The locked-in picker (null when unclaimed). Drives the picker chip. */
  assignedPickerId: string | null;
  /** Resolved display name of the assigned picker, when readable. */
  pickerName: string | null;
  fulfillmentType: string | null;
  signatureToken: string | null;
  /** Line roll-ups for the backorder progress card. requested = ordered,
   *  fulfilled = provided to the customer (shipped at hand-over). */
  totalRequested: number;
  totalFulfilled: number;
  /** Whether a strict approve would fall short (drives "Approve partial"). */
  isShortStock: boolean;
  /** Whether any still-owed line has available stock (gates "Resume fulfillment"). */
  hasFulfillableStock: boolean;
  /** What's being ordered — name/sku/requested (+fulfilled once shipping starts). */
  lines: Array<{
    name: string;
    sku: string | null;
    requested: number;
    fulfilled: number;
  }>;
}

interface Attachment {
  id: string;
  storagePath: string;
  kind: string;
  contentType: string | null;
  fileName: string | null;
  url: string | null;
  createdAt: string;
}

export default function OrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { c, mode } = useTheme();

  const { activeOrgId: orgId, activeRole: role } = useWorkspace();
  const [order, setOrder] = React.useState<OrderHeader | null>(null);
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [attachmentsError, setAttachmentsError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState<{
    done: number;
    total: number;
  } | null>(null);
  const [kind, setKind] = React.useState<Kind>('dropoff_photo');
  const [sigOpen, setSigOpen] = React.useState(false);
  const [sigUrl, setSigUrl] = React.useState<string | null>(null);
  const [sigLoading, setSigLoading] = React.useState(false);
  const [viewerUrl, setViewerUrl] = React.useState<string | null>(null);
  const [shipment, setShipment] = React.useState<OrderShipment | null>(null);

  // Pipeline-action state (manager parity with the web ManagerActionsPanel).
  const [acting, setActing] = React.useState<string | null>(null);
  const [denyOpen, setDenyOpen] = React.useState(false);
  const [denyReason, setDenyReason] = React.useState('');
  const [driverOpen, setDriverOpen] = React.useState(false);
  const [drivers, setDrivers] = React.useState<OrderDriver[] | null>(null);
  const [signatureModalVisible, setSignatureModalVisible] = React.useState(false);

  const isManager = role !== null && ['owner', 'admin', 'manager'].includes(role);
  const canAttach = isManager && order !== null && ATTACHABLE.includes(order.status);

  // Effective permission set (org role/user overrides applied; static role
  // defaults while loading). Feeds `viewerCanPick` below.
  const permissions = useEffectivePermissions();
  // Whether THIS viewer can pick — manager+ OR holds items:update. Mobile can't
  // see warehouse assignments (the backend + assign_picking enforce warehouse),
  // so this at least keeps a `viewer` role from being offered Claim/Pick. `can`
  // falls back to the static role default when `permissions` hasn't loaded, so a
  // staffer sees pick affordances immediately and a viewer never does.
  const viewerCanPick =
    isManager || (role !== null && can({ role: role as Role, permissions }, 'items:update'));


  const loadAttachments = React.useCallback(async () => {
    if (!orgId || !id) return;
    const { data, error } = await supabase
      .from('order_request_attachments')
      .select('id, storage_path, kind, content_type, file_name, created_at')
      .eq('organization_id', orgId)
      .eq('order_request_id', id)
      .order('created_at', { ascending: false });
    // A failed read must NOT masquerade as "No attachments yet." — surface it
    // as an error state so a member seeing an empty gallery is distinguishable
    // from a member whose read actually failed (offline / RLS denial).
    setAttachmentsError(error ? error.message : null);
    const rows = (data ?? []) as Record<string, unknown>[];
    const paths = rows.map((r) => r.storage_path as string);
    const signed = new Map<string, string>();
    if (paths.length > 0) {
      const { data: urls } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 60 * 60);
      for (const u of (urls ?? []) as { path?: string | null; signedUrl: string }[]) {
        if (u.path) signed.set(u.path, u.signedUrl);
      }
    }
    setAttachments(
      rows.map((r) => ({
        id: r.id as string,
        storagePath: r.storage_path as string,
        kind: (r.kind as string | null) ?? 'other',
        contentType: (r.content_type as string | null) ?? null,
        fileName: (r.file_name as string | null) ?? null,
        url: signed.get(r.storage_path as string) ?? null,
        createdAt: r.created_at as string,
      })),
    );
  }, [orgId, id]);

  const load = React.useCallback(async () => {
    if (!orgId || !id) return;
    const { data } = await supabase
      .from('order_requests')
      .select(
        // `requester:user_profiles!requester_user_id` resolves the team-member
        // name that internal orders DON'T denormalize onto the row (else they
        // showed "Unknown requester"). RLS lets org members read each other.
        // `picker:user_profiles!assigned_picker_id` resolves the claimant's name
        // for the picker chip (assigned_picker_id FK → user_profiles.id, mig
        // 0109). RLS lets org members read each other, same as the requester join.
        `id, status, requester_name, requester_email, requester_user_id, requester_org_label,
         signed_by_name, signed_at, created_at,
         assigned_delivery_user_id, assigned_picker_id, fulfillment_type, signature_token,
         warehouse:warehouses!warehouse_id (name),
         requester:user_profiles!requester_user_id (full_name, email),
         picker:user_profiles!assigned_picker_id (full_name, email)`,
      )
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle();
    // Order lines — both the per-line ITEMS list (a manager must SEE what's
    // being ordered before approving) and the backorder roll-ups.
    const { data: lineRows } = await supabase
      .from('order_request_lines')
      .select(
        'item_id, quantity_requested, quantity_fulfilled, item:inventory_items(name, sku)',
      )
      .eq('order_request_id', id);
    const rows = (lineRows ?? []) as {
      item_id: string | null;
      quantity_requested: number | null;
      quantity_fulfilled: number | null;
      item: { name: string | null; sku: string | null } | { name: string | null; sku: string | null }[] | null;
    }[];
    const totalRequested = rows.reduce((s, l) => s + (Number(l.quantity_requested) || 0), 0);
    const totalFulfilled = rows.reduce((s, l) => s + (Number(l.quantity_fulfilled) || 0), 0);

    // Stock-awareness, mirroring the web page loader:
    //  - pending_approval → isShortStock (drives "Approve partial"), judged on
    //    PER-ITEM demand (duplicate-item lines are summed first).
    //  - backordered → hasFulfillableStock (gates "Resume fulfillment").
    // Only computed on those two statuses to keep load() light.
    let isShortStock = false;
    let hasFulfillableStock = false;
    const stStatus = (data as Record<string, unknown> | null)?.status;
    if ((stStatus === 'pending_approval' || stStatus === 'backordered') && rows.length > 0) {
      const itemIds = [...new Set(rows.map((l) => l.item_id).filter((x): x is string => Boolean(x)))];
      if (itemIds.length > 0) {
        const [{ data: itemRows }, { data: resvRows }] = await Promise.all([
          supabase.from('inventory_items').select('id, quantity_on_hand').in('id', itemIds),
          supabase
            .from('stock_reservations')
            .select('item_id, quantity')
            .in('item_id', itemIds)
            .is('released_at', null),
        ]);
        const onHandById = new Map<string, number>();
        for (const it of (itemRows ?? []) as { id: string; quantity_on_hand: number | null }[]) {
          onHandById.set(it.id, Number(it.quantity_on_hand) || 0);
        }
        const reservedByItem = new Map<string, number>();
        for (const rv of (resvRows ?? []) as { item_id: string; quantity: number | null }[]) {
          reservedByItem.set(rv.item_id, (reservedByItem.get(rv.item_id) ?? 0) + (Number(rv.quantity) || 0));
        }
        const demandByItem = new Map<string, { requested: number; owed: number }>();
        for (const l of rows) {
          if (!l.item_id) continue;
          const entry = demandByItem.get(l.item_id) ?? { requested: 0, owed: 0 };
          entry.requested += Number(l.quantity_requested) || 0;
          entry.owed += Math.max(
            0,
            (Number(l.quantity_requested) || 0) - (Number(l.quantity_fulfilled) || 0),
          );
          demandByItem.set(l.item_id, entry);
        }
        for (const [itemId, d] of demandByItem) {
          const available = Math.max(0, (onHandById.get(itemId) ?? 0) - (reservedByItem.get(itemId) ?? 0));
          if (stStatus === 'pending_approval' && d.requested > available) isShortStock = true;
          if (stStatus === 'backordered' && d.owed > 0 && available > 0) hasFulfillableStock = true;
        }
      }
    }
    if (data) {
      const r = data as Record<string, unknown>;
      const wh = r.warehouse as { name: string | null } | { name: string | null }[] | null;
      const whObj = Array.isArray(wh) ? wh[0] : wh;
      const pk = r.picker as
        | { full_name: string | null; email: string | null }
        | { full_name: string | null; email: string | null }[]
        | null;
      const pkObj = Array.isArray(pk) ? pk[0] : pk;
      setOrder({
        id: r.id as string,
        status: r.status as string,
        requester: resolveRequesterLabel({
          requesterName: (r.requester_name as string | null) ?? null,
          requesterEmail: (r.requester_email as string | null) ?? null,
          requesterUserId: (r.requester_user_id as string | null) ?? null,
          profile: profileFromEmbed(r.requester),
        }),
        requesterName: (r.requester_name as string | null) ?? null,
        requesterEmail: (r.requester_email as string | null) ?? null,
        orgLabel: (r.requester_org_label as string | null) ?? null,
        warehouseName: whObj?.name ?? null,
        hasSignature: (r.signed_at as string | null) != null,
        signedByName: (r.signed_by_name as string | null) ?? null,
        signedAt: (r.signed_at as string | null) ?? null,
        createdAt: (r.created_at as string | null) ?? null,
        assignedDeliveryUserId: (r.assigned_delivery_user_id as string | null) ?? null,
        assignedPickerId: (r.assigned_picker_id as string | null) ?? null,
        pickerName: pkObj?.full_name?.trim() || pkObj?.email?.trim() || null,
        fulfillmentType: (r.fulfillment_type as string | null) ?? null,
        signatureToken: (r.signature_token as string | null) ?? null,
        totalRequested,
        totalFulfilled,
        isShortStock,
        hasFulfillableStock,
        lines: rows.map((l) => {
          const itemObj = Array.isArray(l.item) ? l.item[0] : l.item;
          return {
            name: itemObj?.name ?? 'Unknown item',
            sku: itemObj?.sku ?? null,
            requested: Number(l.quantity_requested) || 0,
            fulfilled: Number(l.quantity_fulfilled) || 0,
          };
        }),
      });
    }
    await loadAttachments();
    // Read-only carrier tracking. The wrapper soft-gates: if the shipping
    // module is off, the member lacks access, or there is simply no shipment,
    // it returns null and the section below stays hidden.
    setShipment(await getOrderShipment(id));
    setLoading(false);
  }, [orgId, id, loadAttachments]);

  useFocusEffect(
    React.useCallback(() => {
      void load();
    }, [load]),
  );

  // Fetch the signature blob only when the viewer opens the dialog — it's an
  // image seen inside a closed-by-default modal, so shipping it in the order
  // payload to every viewer wasted bandwidth on every screen focus.
  React.useEffect(() => {
    // `sigLoading` must NOT be a dep — setting it below would re-run the
    // effect, whose cleanup cancels the in-flight query, hanging the spinner.
    if (!sigOpen || sigUrl || !orgId || !id) return;
    let cancelled = false;
    setSigLoading(true);
    void (async () => {
      try {
        const { data } = await supabase
          .from('order_requests')
          .select('signature_data_url')
          .eq('organization_id', orgId)
          .eq('id', id)
          .maybeSingle();
        if (!cancelled) {
          setSigUrl((data?.signature_data_url as string | null) ?? null);
        }
      } catch {
        /* leave null — modal shows nothing */
      } finally {
        if (!cancelled) setSigLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sigOpen, sigUrl, orgId, id]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  // Run any order mutation under a shared busy key, then reload. The server
  // enforces module + permission + status (and 409 on a claim race); we just
  // surface its message on failure.
  async function runAction(busyKey: string, fn: () => Promise<void>) {
    setActing(busyKey);
    try {
      await fn();
      await load();
    } catch (e) {
      Alert.alert('Could not update order', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setActing(null);
    }
  }

  // Advance the order through the pipeline, then reload.
  async function act(body: OrderAction, busyKey: string) {
    if (!id) return;
    await runAction(busyKey, () => transitionOrder(id, body));
  }

  async function submitDeny() {
    const reason = denyReason.trim();
    if (!reason) {
      Alert.alert('Reason required', 'Enter a reason before denying.');
      return;
    }
    setDenyOpen(false);
    await act({ action: 'deny', reason }, 'deny');
    setDenyReason('');
  }

  async function openDriverPicker() {
    setDriverOpen(true);
    if (drivers === null && id) {
      try {
        setDrivers(await listOrderDrivers(id));
      } catch (e) {
        setDriverOpen(false);
        Alert.alert('Could not load drivers', e instanceof Error ? e.message : 'Please try again.');
      }
    }
  }

  function collectSignature() {
    if (!order?.signatureToken) {
      Alert.alert('No signature link', 'Generate the packing slip first to create a signature link.');
      return;
    }
    setSignatureModalVisible(true);
  }

  // Whether the current status exposes any manager action (so we don't render an
  // empty section at, e.g., a terminal status).
  const ft = order?.fulfillmentType;
  const st = order?.status;
  // NOTE: the picking phase (pick_slip_generated / picking_in_progress) is
  // intentionally NOT here — it has its own PICKING section below that renders
  // for staff pickers too, not just managers.
  const hasPipelineActions =
    isManager &&
    !!st &&
    (st === 'pending_approval' ||
      st === 'approved' ||
      st === 'picking_complete' ||
      (st === 'packing_slip_generated' && (ft === 'pickup' || ft === 'delivery')) ||
      st === 'staged_for_delivery' ||
      st === 'staged_for_pickup' ||
      st === 'in_transit' ||
      st === 'backordered');

  // Fulfilled = units PROVIDED to the customer (shipped at hand-over); owed =
  // the still-unfulfilled remainder. Drives the backorder progress card.
  const totalRequested = order?.totalRequested ?? 0;
  const totalFulfilled = order?.totalFulfilled ?? 0;
  const totalOwed = Math.max(0, totalRequested - totalFulfilled);

  // Picking claim/lock (owner decisions, enforced server-side). This section is
  // visible to ANY role in the picking phase — a staff picker must claim before
  // picking; the picker or a manager may release; a manager may pick directly.
  // Which buttons show is decided by the shared @stockpilot/core state machine
  // (the same source of truth the web order page reads); the server re-checks.
  const pickingStatus =
    order && st ? derivePickingStatus(st as OrderStatus, order.assignedPickerId) : null;
  const isPickingPhase =
    pickingStatus === 'unassigned' ||
    pickingStatus === 'assigned' ||
    pickingStatus === 'in_progress';
  const pickActions =
    isPickingPhase && order && role
      ? availableOrderActions({
          status: st as OrderStatus,
          fulfillmentType: (ft as FulfillmentType | null) ?? 'pickup',
          hasAssignedDelivery: order.assignedDeliveryUserId !== null,
          viewerRole: role as Role,
          viewerUserId: user?.id ?? '',
          assignedPickerId: order.assignedPickerId,
          assignedDeliveryUserId: order.assignedDeliveryUserId,
          viewerCanPick,
        })
      : [];
  const canClaimPick = pickActions.includes('claim_picking');
  const canDigitalPick = pickActions.includes('open_digital_pick');
  const canReleasePick = pickActions.includes('release_picking');
  const pickerLabel =
    !order || order.assignedPickerId === null
      ? 'Unassigned'
      : order.assignedPickerId === user?.id
        ? 'Being picked by you'
        : order.pickerName
          ? `Being picked by ${order.pickerName}`
          : 'Being picked by another picker';

  const actionBtn = (
    label: string,
    busyKey: string,
    onPress: () => void,
    tone: 'primary' | 'danger' | 'default' = 'primary',
  ) => {
    const isBusy = acting === busyKey;
    const bg = tone === 'primary' ? c.ink : tone === 'danger' ? '#b42318' : 'transparent';
    const fg = tone === 'default' ? c.ink : tone === 'danger' ? '#fff' : c.paper;
    return (
      <Pressable
        key={label}
        onPress={onPress}
        disabled={acting !== null}
        style={[
          styles.addBtn,
          {
            backgroundColor: bg,
            borderWidth: 1,
            borderColor: tone === 'default' ? c.hair : 'transparent',
            opacity: acting !== null && !isBusy ? 0.5 : 1,
          },
        ]}
      >
        {isBusy ? <ActivityIndicator color={fg} /> : <Mono size={13} color={fg}>{label}</Mono>}
      </Pressable>
    );
  };

  // Uploads ONE asset (resize → storage → row). Returns success/failure
  // WITHOUT touching the shared `uploading` flag or refetching, so the single
  // and batch flows can share it. Per-file storage rollback on a row-insert
  // failure is preserved so we never leave an orphaned object behind.
  async function uploadOne(uri: string): Promise<{ ok: boolean; error?: string }> {
    if (!orgId || !id) return { ok: false, error: 'Not ready' };
    try {
      const resized = await resizeForUpload(uri);
      const path = `${orgId}/${id}/${Math.random().toString(36).slice(2, 14)}.${resized.ext}`;
      const arrayBuffer = await (await fetch(resized.uri)).arrayBuffer();
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, arrayBuffer, { contentType: mimeForExt(resized.ext) });
      if (upErr) return { ok: false, error: upErr.message };
      const { error: rowErr } = await supabase.from('order_request_attachments').insert({
        organization_id: orgId,
        order_request_id: id,
        storage_path: path,
        file_name: null,
        content_type: mimeForExt(resized.ext),
        kind,
      });
      if (rowErr) {
        await supabase.storage.from(BUCKET).remove([path]);
        return { ok: false, error: rowErr.message };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Please try again.' };
    }
  }

  async function uploadAsset(uri: string) {
    setUploading(true);
    try {
      const res = await uploadOne(uri);
      if (!res.ok) Alert.alert('Upload failed', res.error ?? 'Please try again.');
      await loadAttachments();
    } finally {
      setUploading(false);
    }
  }

  // Multi-file upload: concurrency capped at 2 (peak memory during concurrent
  // resize on older iPhones), a live 'N/M' progress label, ONE refetch at the
  // end, and a SINGLE aggregated failure Alert (stacked concurrent Alerts are
  // unreliable on Android). Airplane-mode mid-batch → failures are reported,
  // the batch finishes, and no storage objects are orphaned.
  async function uploadAssets(uris: string[]) {
    if (uris.length === 0) return;
    if (uris.length === 1) {
      await uploadAsset(uris[0]!);
      return;
    }
    setUploading(true);
    setUploadProgress({ done: 0, total: uris.length });
    const failures: string[] = [];
    let done = 0;
    const queue = [...uris];
    const worker = async () => {
      while (queue.length > 0) {
        const uri = queue.shift()!;
        const res = await uploadOne(uri);
        if (!res.ok) failures.push(res.error ?? 'Upload failed');
        done += 1;
        setUploadProgress({ done, total: uris.length });
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(2, uris.length) }, () => worker()),
      );
      await loadAttachments();
      if (failures.length > 0) {
        Alert.alert(
          `${failures.length} of ${uris.length} uploads failed`,
          failures.slice(0, 3).join('\n'),
        );
      }
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }

  async function fromCamera() {
    let perm = await ImagePicker.getCameraPermissionsAsync();
    if (!perm.granted) perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera access needed', 'Allow camera to capture proof photos.');
      return;
    }
    try {
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.7,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        cameraType: ImagePicker.CameraType.back,
      });
      if (result.canceled || !result.assets[0]) return;
      await uploadAsset(result.assets[0].uri);
    } catch (e) {
      Alert.alert('Camera unavailable', e instanceof Error ? e.message : 'Use Library instead.');
    }
  }

  async function fromLibrary() {
    let perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!perm.granted) perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
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
    await uploadAssets(result.assets.map((a) => a.uri));
  }

  function addProof() {
    Alert.alert('Add proof of delivery', `Saving as "${KIND_LABELS[kind]}"`, [
      { text: 'Take photo', onPress: () => void fromCamera() },
      { text: 'Choose from library', onPress: () => void fromLibrary() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  async function deleteAttachment(att: Attachment) {
    await supabase.storage.from(BUCKET).remove([att.storagePath]);
    await supabase
      .from('order_request_attachments')
      .delete()
      .eq('organization_id', orgId)
      .eq('id', att.id);
    await loadAttachments();
  }

  function openAttachment(a: Attachment) {
    if (!a.url) {
      // Signed-URL minting failed (offline, or a storage-RLS denial) — say so
      // instead of a dead tap on the tile.
      Alert.alert(
        'Couldn’t open file',
        'No download link is available right now. Pull to refresh and try again.',
      );
      return;
    }
    // Images open in an in-app full-screen viewer; PDFs/other open in the
    // device's browser/viewer via the signed URL.
    if ((a.contentType ?? '').startsWith('image/')) {
      setViewerUrl(a.url);
    } else {
      Linking.openURL(a.url).catch(() =>
        Alert.alert('Could not open', 'Unable to open this file on your device.'),
      );
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip
            icon={ArrowLeft}
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace('/');
            }}
          />
        </View>
      </SafeAreaView>

      {loading ? (
        <ActivityIndicator color={c.ink} style={{ marginTop: 40 }} />
      ) : !order ? (
        <View style={styles.center}>
          <Display size={18}>Order not <Em>found.</Em></Display>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 60, gap: 16 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink} />}
        >
          <View style={{ paddingTop: 4 }}>
            <Eyebrow>{`ORDER · ${order.status.replace(/_/g, ' ').toUpperCase()}`}</Eyebrow>
            <Display size={30} style={{ marginTop: 10 }}>
              {order.requester ?? 'Order'}
            </Display>
            <Mono size={11.5} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
              {[order.orgLabel, order.warehouseName].filter(Boolean).join(' · ') || '—'}
            </Mono>
          </View>

          {totalOwed > 0 && (totalFulfilled > 0 || order.status === 'backordered') ? (
            <Card padding={14}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Body size={13} color="#b45309">
                  {order.status === 'backordered' ? 'Backordered — awaiting stock' : 'Partially fulfilled'}
                </Body>
                <Mono size={11} color="#b45309">
                  {totalFulfilled} / {totalRequested} · {totalOwed} owed
                </Mono>
              </View>
              <View
                style={{
                  marginTop: 10,
                  height: 6,
                  borderRadius: 999,
                  backgroundColor: c.hair,
                  overflow: 'hidden',
                }}
              >
                <View
                  style={{
                    height: '100%',
                    borderRadius: 999,
                    backgroundColor: '#f59e0b',
                    width: `${totalRequested > 0 ? Math.round((totalFulfilled / totalRequested) * 100) : 0}%`,
                  }}
                />
              </View>
            </Card>
          ) : null}

          {order.lines.length > 0 ? (
            <View style={{ gap: 10 }}>
              <Eyebrow>
                {`ITEMS · ${order.lines.length} LINE${order.lines.length === 1 ? '' : 'S'} · ${totalRequested} UNITS`}
              </Eyebrow>
              <Card padding={0}>
                {order.lines.map((l, i) => (
                  <View
                    key={`${l.sku ?? l.name}-${i}`}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      paddingHorizontal: 14,
                      paddingVertical: 12,
                      borderTopWidth: i === 0 ? 0 : 1,
                      borderTopColor: c.hair,
                    }}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Body size={14} color={c.ink} numberOfLines={2}>
                        {l.name}
                      </Body>
                      {l.sku ? (
                        <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 2 }}>
                          {l.sku}
                        </Mono>
                      ) : null}
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Mono size={13} color={c.ink}>
                        ×{l.requested}
                      </Mono>
                      {l.fulfilled > 0 && l.fulfilled < l.requested ? (
                        <Mono size={10.5} color="#b45309" style={{ marginTop: 2 }}>
                          {l.fulfilled} provided · {l.requested - l.fulfilled} owed
                        </Mono>
                      ) : l.fulfilled >= l.requested && l.requested > 0 ? (
                        <Mono size={10.5} color={c.ink4} style={{ marginTop: 2 }}>
                          fulfilled
                        </Mono>
                      ) : null}
                    </View>
                  </View>
                ))}
              </Card>
            </View>
          ) : null}

          {isPickingPhase && order ? (
            <View style={{ gap: 10 }}>
              <Eyebrow>PICKING</Eyebrow>
              {/* Picker chip: unassigned, you, a named picker, or an anonymous
                  other (when only the id is readable). */}
              <View
                style={{
                  alignSelf: 'flex-start',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 7,
                  borderWidth: 1,
                  borderColor: c.hair,
                  borderRadius: 999,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  backgroundColor: c.card,
                }}
              >
                <View
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: order.assignedPickerId ? '#16a34a' : c.ink4,
                  }}
                />
                <Mono size={11} color={c.ink}>{pickerLabel}</Mono>
              </View>

              {/* Unclaimed + viewer is staff → claim before picking. */}
              {canClaimPick
                ? actionBtn('Claim picking', 'claim', () =>
                    void runAction('claim', () => claimPicking(id!)),
                  )
                : null}

              {/* Assigned picker or a manager → the pick workspace. A non-manager
                  who is NOT the claimant sees a note instead (never the inputs). */}
              {canDigitalPick ? (
                <DigitalPick orderId={id!} canPick onCompleted={() => void load()} />
              ) : !canClaimPick &&
                order.assignedPickerId !== null &&
                order.assignedPickerId !== user?.id ? (
                <Mono size={11.5} color={c.ink4}>
                  This order is being picked by someone else.
                </Mono>
              ) : null}

              {/* Self-release by the picker, or a manager override/reassign
                  affordance (release, then re-claim / pick directly). */}
              {canReleasePick
                ? actionBtn(
                    'Release',
                    'release',
                    () => void runAction('release', () => releasePicking(id!)),
                    'default',
                  )
                : null}

              <Mono size={10.5} color={c.ink4}>
                Same actions as the web dashboard — changes sync instantly.
              </Mono>
            </View>
          ) : null}

          {hasPipelineActions ? (
            <View style={{ gap: 8 }}>
              <Eyebrow>MANAGER ACTIONS</Eyebrow>
              {order.status === 'pending_approval' ? (
                <>
                  {actionBtn('Approve', 'approve', () => void act({ action: 'approve' }, 'approve'))}
                  {order.isShortStock
                    ? actionBtn(
                        'Approve partial',
                        'approve-partial',
                        () => void act({ action: 'approve_partial' }, 'approve-partial'),
                        'default',
                      )
                    : null}
                  {actionBtn('Deny', 'deny', () => setDenyOpen(true), 'danger')}
                </>
              ) : null}
              {order.status === 'approved'
                ? actionBtn('Generate pick slip', 'gps', () =>
                    void act({ action: 'generate_pick_slip' }, 'gps'),
                  )
                : null}
              {order.status === 'picking_complete'
                ? actionBtn('Generate packing slips', 'gpk', () =>
                    void act({ action: 'generate_packing_slips' }, 'gpk'),
                  )
                : null}
              {order.status === 'packing_slip_generated' && order.fulfillmentType === 'pickup'
                ? actionBtn('Mark staged for pickup', 'stage', () =>
                    void act({ action: 'stage', target: 'staged_for_pickup' }, 'stage'),
                  )
                : null}
              {order.status === 'packing_slip_generated' && order.fulfillmentType === 'delivery'
                ? actionBtn('Mark staged for delivery', 'stage', () =>
                    void act({ action: 'stage', target: 'staged_for_delivery' }, 'stage'),
                  )
                : null}
              {order.status === 'staged_for_delivery'
                ? actionBtn(
                    order.assignedDeliveryUserId ? 'Reassign delivery' : 'Assign delivery',
                    'assign',
                    () => void openDriverPicker(),
                    'default',
                  )
                : null}
              {order.status === 'staged_for_delivery' && order.assignedDeliveryUserId
                ? actionBtn('Mark in transit', 'transit', () =>
                    void act({ action: 'mark_in_transit' }, 'transit'),
                  )
                : null}
              {order.status === 'staged_for_pickup' || order.status === 'in_transit' ? (
                <>
                  {actionBtn('Collect signature', 'sig', collectSignature)}
                  {actionBtn(
                    'Physical signature',
                    'physicalsig',
                    () =>
                      Alert.prompt(
                        'Physical signature',
                        "Customer signed on paper? Enter the signer's name — this completes the hand-over exactly like the digital sign page (backordering any still-owed items).",
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Record',
                            onPress: (name?: string) => {
                              const signer = (name ?? '').trim();
                              if (!signer) {
                                Alert.alert('Name required', 'Enter who signed the paper copy.');
                                return;
                              }
                              void act(
                                { action: 'confirm_physical_signature', signerName: signer },
                                'physicalsig',
                              );
                            },
                          },
                        ],
                        'plain-text',
                      ),
                    'default',
                  )}
                </>
              ) : null}
              {order.status === 'backordered' ? (
                <>
                  {order.hasFulfillableStock ? (
                    actionBtn('Resume fulfillment', 'resume', () =>
                      void act({ action: 'resume_fulfillment' }, 'resume'),
                    )
                  ) : (
                    <Body size={12} color={c.ink4}>
                      Resume unlocks when owed items are back in stock.
                    </Body>
                  )}
                  {actionBtn(
                    'Close as delivered-partial',
                    'closepartial',
                    () =>
                      Alert.alert(
                        'Close as delivered-partial?',
                        'This ends the order and keeps the record of what was delivered. The remaining backordered units will NOT be fulfilled.',
                        [
                          { text: 'Keep open', style: 'cancel' },
                          {
                            text: 'Close order',
                            onPress: () => void act({ action: 'close_partial' }, 'closepartial'),
                          },
                        ],
                      ),
                    'default',
                  )}
                  {actionBtn(
                    'Cancel order',
                    'cancelorder',
                    () =>
                      Alert.alert(
                        'Cancel this order?',
                        'The order is voided. Already-delivered items are NOT restocked; the hold on the remaining items is released.',
                        [
                          { text: 'Keep order', style: 'cancel' },
                          {
                            text: 'Cancel order',
                            style: 'destructive',
                            onPress: () => void act({ action: 'cancel' }, 'cancelorder'),
                          },
                        ],
                      ),
                    'danger',
                  )}
                </>
              ) : null}
              <Mono size={10.5} color={c.ink4}>
                Same actions as the web dashboard — changes sync instantly.
              </Mono>
            </View>
          ) : null}

          {order.hasSignature ? (
            <Pressable onPress={() => setSigOpen(true)}>
              <Card padding={14}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <PenLine size={16} color={c.ink} strokeWidth={1.7} />
                  <View style={{ flex: 1 }}>
                    <Body size={14} color={c.ink}>View signature</Body>
                    <Mono size={11} color={c.ink4} style={{ marginTop: 2 }}>
                      {order.signedByName ?? 'Signed'}
                      {order.signedAt ? ` · ${new Date(order.signedAt).toLocaleDateString()}` : ''}
                    </Mono>
                  </View>
                </View>
              </Card>
            </Pressable>
          ) : null}

          {shipment ? (
            <View style={{ gap: 8 }}>
              <Eyebrow>SHIPPING</Eyebrow>
              <Card padding={14}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                  <Truck size={16} color={c.ink} strokeWidth={1.7} style={{ marginTop: 2 }} />
                  <View style={{ flex: 1, gap: 6 }}>
                    <Body size={14} color={c.ink}>
                      {[shipment.carrier, shipment.service].filter(Boolean).join(' · ') || 'Carrier'}
                    </Body>
                    <Mono size={11} color={c.ink4}>
                      {SHIPMENT_STATUS_LABELS[shipment.status] ??
                        shipment.status.replace(/_/g, ' ')}
                      {shipment.tracking_status ? ` · ${shipment.tracking_status}` : ''}
                    </Mono>
                    {shipment.tracking_code ? (
                      <Mono size={11} color={c.ink3}>{`Tracking ${shipment.tracking_code}`}</Mono>
                    ) : null}
                    {shipment.tracking_url ? (
                      <Pressable
                        onPress={() =>
                          Linking.openURL(shipment.tracking_url as string).catch(() =>
                            Alert.alert('Could not open', 'Unable to open the tracking page.'),
                          )
                        }
                        hitSlop={6}
                      >
                        <Mono size={11} color={c.ink} style={{ textDecorationLine: 'underline' }}>
                          Track package
                        </Mono>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              </Card>
            </View>
          ) : null}

          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Eyebrow>PROOF OF DELIVERY</Eyebrow>
            </View>

            {canAttach ? (
              <View style={{ gap: 10 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {KINDS.map((k) => {
                    const on = kind === k;
                    return (
                      <Pressable
                        key={k}
                        onPress={() => setKind(k)}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: on ? c.ink : c.hair,
                          backgroundColor: on ? c.ink : 'transparent',
                        }}
                      >
                        <Mono size={10.5} color={on ? c.paper : c.ink3}>
                          {KIND_LABELS[k]}
                        </Mono>
                      </Pressable>
                    );
                  })}
                </View>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Pressable
                    onPress={addProof}
                    disabled={uploading}
                    style={[styles.addBtn, { backgroundColor: c.ink, opacity: uploading ? 0.6 : 1 }]}
                  >
                    {uploading ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <ActivityIndicator color={c.paper} />
                        {uploadProgress ? (
                          <Mono size={13} color={c.paper}>
                            {`Uploading ${uploadProgress.done}/${uploadProgress.total}…`}
                          </Mono>
                        ) : null}
                      </View>
                    ) : (
                      <>
                        <Camera size={16} color={c.paper} strokeWidth={1.8} />
                        <Mono size={13} color={c.paper}>Add proof</Mono>
                      </>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : (
              <Mono size={11} color={c.ink4}>
                {isManager
                  ? 'Available once the order is out for delivery or completed.'
                  : 'Managers can add proof of delivery here.'}
              </Mono>
            )}

            {attachments.length === 0 && attachmentsError ? (
              <Pressable onPress={() => void loadAttachments()}>
                <Mono size={11} color="#b42318" style={{ marginTop: 4 }}>
                  {`Couldn’t load attachments — tap to retry. (${attachmentsError})`}
                </Mono>
              </Pressable>
            ) : attachments.length === 0 ? (
              <Mono size={11} color={c.ink4} style={{ marginTop: 4 }}>No attachments yet.</Mono>
            ) : (
              <View style={styles.grid}>
                {attachments.map((a) => {
                  const isImage = (a.contentType ?? '').startsWith('image/');
                  return (
                    <View key={a.id} style={[styles.tile, { borderColor: c.hair, backgroundColor: c.card }]}>
                      <Pressable onPress={() => openAttachment(a)}>
                        {isImage && a.url ? (
                          <CachedImage uri={a.url} style={styles.tileImg} recyclingKey={a.id} />
                        ) : (
                          <View style={[styles.tileImg, { alignItems: 'center', justifyContent: 'center', gap: 4 }]}>
                            <ImagePlus size={20} color={c.ink4} />
                            <Mono size={9} color={c.ink4}>Open</Mono>
                          </View>
                        )}
                      </Pressable>
                      <View style={styles.tileFoot}>
                        <Mono size={9.5} color={c.ink4} numberOfLines={1} style={{ flex: 1 }}>
                          {KIND_LABELS[a.kind] ?? 'Other'}
                        </Mono>
                        {isManager ? (
                          <Pressable onPress={() => void deleteAttachment(a)} hitSlop={8}>
                            <Trash2 size={14} color={c.ink4} />
                          </Pressable>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        </ScrollView>
      )}

      <Modal visible={sigOpen} transparent animationType="fade" onRequestClose={() => setSigOpen(false)}>
        <Pressable
          onPress={() => setSigOpen(false)}
          style={{
            flex: 1,
            justifyContent: 'center',
            padding: 24,
            backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)',
          }}
        >
          <Pressable onPress={() => undefined} style={{ backgroundColor: c.card, borderRadius: 16, padding: 18, gap: 12 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>Customer signature</Body>
              <Pressable onPress={() => setSigOpen(false)} hitSlop={8}>
                <X size={18} color={c.ink4} />
              </Pressable>
            </View>
            {sigLoading ? (
              <View style={{ height: 180, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator color={c.ink4} />
              </View>
            ) : sigUrl ? (
              <View style={{ backgroundColor: '#fff', borderRadius: 8, padding: 8 }}>
                <Image
                  source={{ uri: sigUrl }}
                  style={{ width: '100%', height: 180 }}
                  resizeMode="contain"
                />
              </View>
            ) : null}
            <Mono size={11} color={c.ink4}>
              {order?.signedByName ?? 'Signed'}
              {order?.signedAt ? ` · ${new Date(order.signedAt).toLocaleString()}` : ''}
            </Mono>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={!!viewerUrl}
        transparent
        animationType="fade"
        onRequestClose={() => setViewerUrl(null)}
      >
        <Pressable
          onPress={() => setViewerUrl(null)}
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 12,
            backgroundColor: 'rgba(0,0,0,0.92)',
          }}
        >
          {viewerUrl ? (
            <View
              style={{
                width: '100%',
                height: '82%',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {/* Spinner sits behind the image — visible only until the photo
                  paints, instead of a silent black gap. */}
              <ActivityIndicator
                color="rgba(255,255,255,0.8)"
                style={{ position: 'absolute' }}
              />
              {/* CachedImage shares the tile's disk cache (keyed by the
                  token-stripped storage path), so the full view opens
                  instantly from bytes expo-image already has — the old plain
                  RN Image re-downloaded them through its separate cache. */}
              <CachedImage
                uri={viewerUrl}
                style={{ width: '100%', height: '100%' }}
                contentFit="contain"
              />
            </View>
          ) : null}
          <Mono size={11} color="rgba(255,255,255,0.7)" style={{ marginTop: 16 }}>
            Tap anywhere to close
          </Mono>
        </Pressable>
      </Modal>

      {/* Deny-reason capture (the requester sees this reason). */}
      <Modal visible={denyOpen} transparent animationType="fade" onRequestClose={() => setDenyOpen(false)}>
        <Pressable
          onPress={() => setDenyOpen(false)}
          style={{
            flex: 1,
            justifyContent: 'center',
            padding: 24,
            backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)',
          }}
        >
          <Pressable onPress={() => undefined} style={{ backgroundColor: c.card, borderRadius: 16, padding: 18, gap: 12 }}>
            <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>Deny this request?</Body>
            <Mono size={11} color={c.ink4}>The requester is notified with the reason you provide.</Mono>
            <TextInput
              value={denyReason}
              onChangeText={setDenyReason}
              placeholder="Reason"
              placeholderTextColor={c.ink4}
              multiline
              style={{
                minHeight: 72,
                borderWidth: 1,
                borderColor: c.hair,
                borderRadius: 10,
                padding: 10,
                color: c.ink,
                fontFamily: FONT.mono,
                fontSize: 13,
                textAlignVertical: 'top',
              }}
            />
            <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
              <Pressable
                onPress={() => setDenyOpen(false)}
                style={[styles.addBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.hair, paddingHorizontal: 18 }]}
              >
                <Mono size={13} color={c.ink}>Cancel</Mono>
              </Pressable>
              <Pressable
                onPress={() => void submitDeny()}
                style={[styles.addBtn, { backgroundColor: '#b42318', paddingHorizontal: 18 }]}
              >
                <Mono size={13} color="#fff">Deny</Mono>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {order?.signatureToken ? (
        <SignaturePadModal
          visible={signatureModalVisible}
          onClose={() => setSignatureModalVisible(false)}
          onSuccess={() => void load()}
          signatureToken={order.signatureToken}
          defaultName={order.requesterName ?? ''}
          defaultEmail={order.requesterEmail ?? ''}
        />
      ) : null}

      {/* Driver picker for assign / reassign delivery. */}
      <Modal visible={driverOpen} transparent animationType="slide" onRequestClose={() => setDriverOpen(false)}>
        <Pressable
          onPress={() => setDriverOpen(false)}
          style={{
            flex: 1,
            justifyContent: 'flex-end',
            backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)',
          }}
        >
          <Pressable
            onPress={() => undefined}
            style={{ backgroundColor: c.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, gap: 10 }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>Assign delivery</Body>
              <Pressable onPress={() => setDriverOpen(false)} hitSlop={8}>
                <X size={18} color={c.ink4} />
              </Pressable>
            </View>
            {drivers === null ? (
              <ActivityIndicator color={c.ink} style={{ marginVertical: 24 }} />
            ) : drivers.length === 0 ? (
              <Mono size={12} color={c.ink4} style={{ paddingVertical: 16 }}>No team members found.</Mono>
            ) : (
              <ScrollView style={{ maxHeight: 360 }}>
                {drivers.map((d) => {
                  const current = d.id === order?.assignedDeliveryUserId;
                  return (
                    <Pressable
                      key={d.id}
                      onPress={() => {
                        setDriverOpen(false);
                        void act({ action: 'assign_delivery', deliveryUserId: d.id }, 'assign');
                      }}
                      style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.hair }}
                    >
                      <Body size={14} color={c.ink}>
                        {d.name}
                        {current ? '  · current' : ''}
                      </Body>
                      <Mono size={11} color={c.ink4}>{d.email}</Mono>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: { paddingHorizontal: 12, paddingTop: 8, flexDirection: 'row' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    height: 44,
    borderRadius: 10,
    justifyContent: 'center',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  tile: { width: '31%', borderRadius: 10, borderWidth: 1, overflow: 'hidden' },
  tileImg: { width: '100%', height: 90 },
  tileFoot: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 6 },
});

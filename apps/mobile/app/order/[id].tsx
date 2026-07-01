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
import { SignaturePadModal } from '@/components/signature-pad-modal';

import { CachedImage } from '@/components/ui/cached-image';
import { Card } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { resizeForUpload } from '@/lib/image-resize';
import { profileFromEmbed, resolveRequesterLabel } from '@/lib/requester-label';
import {
  listOrderDrivers,
  transitionOrder,
  type OrderAction,
  type OrderDriver,
} from '@/lib/orders-api';
import { getOrderShipment, type OrderShipment } from '@/lib/shipping-api';
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
  signatureDataUrl: string | null;
  signedByName: string | null;
  signedAt: string | null;
  createdAt: string | null;
  assignedDeliveryUserId: string | null;
  fulfillmentType: string | null;
  signatureToken: string | null;
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
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [kind, setKind] = React.useState<Kind>('dropoff_photo');
  const [sigOpen, setSigOpen] = React.useState(false);
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


  const loadAttachments = React.useCallback(async () => {
    if (!orgId || !id) return;
    const { data } = await supabase
      .from('order_request_attachments')
      .select('id, storage_path, kind, content_type, file_name, created_at')
      .eq('organization_id', orgId)
      .eq('order_request_id', id)
      .order('created_at', { ascending: false });
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
        `id, status, requester_name, requester_email, requester_user_id, requester_org_label,
         signature_data_url, signed_by_name, signed_at, created_at,
         assigned_delivery_user_id, fulfillment_type, signature_token,
         warehouse:warehouses!warehouse_id (name),
         requester:user_profiles!requester_user_id (full_name, email)`,
      )
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle();
    if (data) {
      const r = data as Record<string, unknown>;
      const wh = r.warehouse as { name: string | null } | { name: string | null }[] | null;
      const whObj = Array.isArray(wh) ? wh[0] : wh;
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
        signatureDataUrl: (r.signature_data_url as string | null) ?? null,
        signedByName: (r.signed_by_name as string | null) ?? null,
        signedAt: (r.signed_at as string | null) ?? null,
        createdAt: (r.created_at as string | null) ?? null,
        assignedDeliveryUserId: (r.assigned_delivery_user_id as string | null) ?? null,
        fulfillmentType: (r.fulfillment_type as string | null) ?? null,
        signatureToken: (r.signature_token as string | null) ?? null,
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

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  // Advance the order through the pipeline, then reload. The server enforces
  // module + permission + status; we just surface its message on failure.
  async function act(body: OrderAction, busyKey: string) {
    if (!id) return;
    setActing(busyKey);
    try {
      await transitionOrder(id, body);
      await load();
    } catch (e) {
      Alert.alert('Could not update order', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setActing(null);
    }
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
  const hasPipelineActions =
    isManager &&
    !!st &&
    (st === 'pending_approval' ||
      st === 'approved' ||
      st === 'pick_slip_generated' ||
      st === 'picking_in_progress' ||
      st === 'picking_complete' ||
      (st === 'packing_slip_generated' && (ft === 'pickup' || ft === 'delivery')) ||
      st === 'staged_for_delivery' ||
      st === 'staged_for_pickup' ||
      st === 'in_transit');

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

  async function uploadAsset(uri: string) {
    if (!orgId || !id) return;
    setUploading(true);
    try {
      const resized = await resizeForUpload(uri);
      const path = `${orgId}/${id}/${Math.random().toString(36).slice(2, 14)}.${resized.ext}`;
      const arrayBuffer = await (await fetch(resized.uri)).arrayBuffer();
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, arrayBuffer, { contentType: mimeForExt(resized.ext) });
      if (upErr) {
        Alert.alert('Upload failed', upErr.message);
        return;
      }
      const { error: rowErr } = await supabase.from('order_request_attachments').insert({
        organization_id: orgId,
        order_request_id: id,
        storage_path: path,
        file_name: null,
        content_type: mimeForExt(resized.ext),
        kind,
      });
      if (rowErr) {
        Alert.alert('Could not save attachment', rowErr.message);
        await supabase.storage.from(BUCKET).remove([path]);
        return;
      }
      await loadAttachments();
    } catch (e) {
      Alert.alert('Upload error', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setUploading(false);
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
    for (const a of result.assets) {
      await uploadAsset(a.uri);
    }
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
    if (!a.url) return;
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

          {hasPipelineActions ? (
            <View style={{ gap: 8 }}>
              <Eyebrow>MANAGER ACTIONS</Eyebrow>
              {order.status === 'pending_approval' ? (
                <>
                  {actionBtn('Approve', 'approve', () => void act({ action: 'approve' }, 'approve'))}
                  {actionBtn('Deny', 'deny', () => setDenyOpen(true), 'danger')}
                </>
              ) : null}
              {order.status === 'approved'
                ? actionBtn('Generate pick slip', 'gps', () =>
                    void act({ action: 'generate_pick_slip' }, 'gps'),
                  )
                : null}
              {order.status === 'pick_slip_generated' || order.status === 'picking_in_progress'
                ? actionBtn('Mark picking complete', 'cp', () =>
                    void act({ action: 'complete_picking' }, 'cp'),
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
              {order.status === 'staged_for_pickup' || order.status === 'in_transit'
                ? actionBtn('Collect signature', 'sig', collectSignature)
                : null}
              <Mono size={10.5} color={c.ink4}>
                Same actions as the web dashboard — changes sync instantly.
              </Mono>
            </View>
          ) : null}

          {order.signatureDataUrl ? (
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
                      <ActivityIndicator color={c.paper} />
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

            {attachments.length === 0 ? (
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
            {order?.signatureDataUrl ? (
              <View style={{ backgroundColor: '#fff', borderRadius: 8, padding: 8 }}>
                <Image
                  source={{ uri: order.signatureDataUrl }}
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

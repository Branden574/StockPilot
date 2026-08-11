import * as ImagePicker from 'expo-image-picker';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import {
  AlertCircle,
  ArrowLeft,
  Camera,
  Check,
  ImageIcon,
  RefreshCw,
  Wrench,
} from 'lucide-react-native';
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
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_MAX_PHOTOS,
  MAINTENANCE_PRIORITIES,
  maintenanceRequestFormSchema,
  type MaintenancePriority,
} from '@stockpilot/core';

import { Card } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, FieldLabel, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { showWriteCta } from '@/lib/cta-gating';
import { footerReservation, shouldStackRow } from '@/lib/dynamic-type-layout';
import { useEnabledModules } from '@/lib/enabled-modules';
import { createMaintenanceRequest } from '@/lib/maintenance-api';
import {
  checkPhotoCap,
  createPhotoAttemptGuard,
  uploadMaintenancePhoto,
  UploadError,
  type PhotoAttemptGuard,
} from '@/lib/maintenance-upload';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT } from '@/lib/theme';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useTheme } from '@/lib/use-theme';
import { useWorkspace } from '@/lib/use-workspace';

/**
 * New maintenance request — mobile twin of the web /dashboard/maintenance/new
 * form (maintenance-request-form.tsx) plus, in the SAME screen, the photo
 * capture/upload step web only offers on the detail page. Mobile has no
 * detail screen yet (Task 20), so this is the one place a phone can attach
 * photos to a brand-new request.
 *
 * Two steps, one screen: STEP 1 is the form; Save calls
 * `createMaintenanceRequest` (validated with the SAME `.strict()` core
 * schema web uses — `maintenanceRequestFormSchema` — so client and server
 * agree by construction and a rejected field reads as the schema's own
 * message, never a hand-rolled rule). Once that returns an id, the screen
 * swaps IN PLACE to STEP 2 — camera/library capture, a per-photo progress
 * bar driven by `uploadMaintenancePhoto`, and a Retry button per failed row
 * — because photos need a request id to attach to and there is none before
 * Save succeeds.
 *
 * Brief §20/never-claim-an-outcome: this screen never says "ticket created",
 * "email sent", or names a recipient — there is no recipient field anywhere
 * in the schema this form validates against, by construction, and none is
 * added here either.
 */
const PRIORITY_LABELS: Record<MaintenancePriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

interface PhotoAsset {
  uri: string;
  fileName?: string;
}

type PhotoStatus = 'uploading' | 'done' | 'error';

interface PhotoEntry {
  key: string;
  uri: string;
  fileName?: string;
  status: PhotoStatus;
  progress: number;
  message?: string;
}

function localKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function NewMaintenanceRequest() {
  const { c } = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { activeOrgId: orgId } = useWorkspace();
  const enabledModules = useEnabledModules();
  const enabled = enabledModules.has('maintenance_requests');
  const perms = useEffectivePermissions();
  const canSubmit = showWriteCta(perms, 'maintenance_requests:submit');

  // Launch-point prefill (Task 20's scan/item launch points push with these).
  // NEVER contact identity — the server ignores any client-supplied
  // requester name/email regardless of what this screen carries, matching
  // web's own defaults contract (new/page.tsx).
  const params = useLocalSearchParams<{
    itemId?: string;
    orderRequestId?: string;
    rentalId?: string;
    charterId?: string;
    subject?: string;
  }>();
  const relatedItemId = params.itemId || null;
  const relatedOrderRequestId = params.orderRequestId || null;
  const relatedRentalId = params.rentalId || null;
  const hasLinkedRecord = Boolean(relatedItemId || relatedOrderRequestId || relatedRentalId);

  // ── Form state ────────────────────────────────────────────────────────
  const [subject, setSubject] = React.useState(params.subject ?? '');
  const [description, setDescription] = React.useState('');
  const [category, setCategory] = React.useState<string | null>(null);
  const [priority, setPriority] = React.useState<MaintenancePriority>('normal');
  const [charterId, setCharterId] = React.useState<string | null>(params.charterId || null);
  const [warehouseId, setWarehouseId] = React.useState<string | null>(null);
  const [requesterPhone, setRequesterPhone] = React.useState('');
  const [building, setBuilding] = React.useState('');
  const [roomOrArea, setRoomOrArea] = React.useState('');
  const [department, setDepartment] = React.useState('');
  const [accessInstructions, setAccessInstructions] = React.useState('');

  const [sites, setSites] = React.useState<Array<{ id: string; name: string }>>([]);
  const [categories, setCategories] = React.useState<string[]>([...MAINTENANCE_CATEGORIES]);

  // Sites (charters) + org-configured categories + the caller's own default
  // site — the same three reads the web page.tsx server component does
  // before rendering the form, done here client-side since mobile has no
  // server component. A launch-point charterId (params.charterId) always
  // wins over the employee's own assignment, matching web's
  // `launchCharterId ?? assignment?.charter_id` precedence.
  React.useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      const [chartersResp, settingsResp] = await Promise.all([
        supabase
          .from('charters')
          .select('id, name')
          .eq('organization_id', orgId)
          .eq('status', 'active')
          .order('name', { ascending: true }),
        supabase
          .from('organization_modules')
          .select('settings')
          .eq('organization_id', orgId)
          .eq('module_id', 'maintenance_requests')
          .maybeSingle(),
      ]);
      if (cancelled) return;
      setSites((chartersResp.data ?? []) as Array<{ id: string; name: string }>);

      const configured = (settingsResp.data as { settings?: { categories?: unknown } } | null)?.settings
        ?.categories;
      if (
        Array.isArray(configured) &&
        configured.length > 0 &&
        configured.every((v) => typeof v === 'string')
      ) {
        setCategories(configured as string[]);
      }

      if (!params.charterId && orgId && user?.id) {
        const { data: assignmentRow } = await supabase
          .from('user_warehouse_assignments')
          .select('charter_id, warehouse_id, is_primary')
          .eq('organization_id', orgId)
          .eq('user_id', user.id)
          .order('is_primary', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (cancelled) return;
        const assignment = assignmentRow as
          | { charter_id: string | null; warehouse_id: string | null }
          | null;
        if (assignment?.charter_id) setCharterId(assignment.charter_id);
        if (assignment?.warehouse_id) setWarehouseId(assignment.warehouse_id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, params.charterId, user?.id]);

  // ── Save (step 1 -> step 2) ──────────────────────────────────────────
  const [saving, setSaving] = React.useState(false);
  const [createdId, setCreatedId] = React.useState<string | null>(null);

  function formValues(): unknown {
    return {
      subject,
      description,
      category: category || null,
      priority,
      charterId: charterId || null,
      warehouseId: warehouseId || null,
      building: building.trim() || null,
      roomOrArea: roomOrArea.trim() || null,
      department: department.trim() || null,
      accessInstructions: accessInstructions.trim() || null,
      requesterPhone: requesterPhone.trim() || null,
      relatedItemId,
      relatedOrderRequestId,
      relatedRentalId,
      relatedLocationId: null,
    };
  }

  async function onSave() {
    if (saving) return;
    // Validated with the SAME .strict() schema web uses (zodResolver there,
    // safeParse here) — never a hand-rolled field check. A rejected field's
    // message is the schema's own, so the two platforms can never disagree
    // about what "valid" means.
    const parsed = maintenanceRequestFormSchema.safeParse(formValues());
    if (!parsed.success) {
      Alert.alert(
        'Check the form',
        parsed.error.issues[0]?.message ?? 'Check the form and try again.',
      );
      return;
    }
    setSaving(true);
    try {
      const { id } = await createMaintenanceRequest(parsed.data);
      setCreatedId(id);
    } catch (e) {
      Alert.alert('Could not save', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }

  // ── Photos (step 2) ───────────────────────────────────────────────────
  const [photoEntries, setPhotoEntries] = React.useState<PhotoEntry[]>([]);
  const guardRef = React.useRef<PhotoAttemptGuard | null>(null);
  if (!guardRef.current) guardRef.current = createPhotoAttemptGuard();

  function patchEntry(key: string, patch: Partial<PhotoEntry>) {
    setPhotoEntries((prev) => prev.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  }

  async function runUpload(entry: PhotoEntry) {
    if (!createdId) return;
    const guard = guardRef.current!;
    const token = guard.start(entry.key);
    try {
      await uploadMaintenancePhoto(createdId, { uri: entry.uri, fileName: entry.fileName }, (fraction) => {
        // Stale guard: a Retry tap starts a NEWER attempt for this same key,
        // and this attempt's late progress/result must never overwrite the
        // newer one's visible state (never claim an upload succeeded, or
        // show it still failing, when a newer attempt already settled it).
        if (guard.isCurrent(entry.key, token)) patchEntry(entry.key, { progress: fraction });
      });
      if (guard.isCurrent(entry.key, token)) {
        patchEntry(entry.key, { status: 'done', progress: 1, message: undefined });
      }
    } catch (e) {
      if (!guard.isCurrent(entry.key, token)) return;
      const message =
        e instanceof UploadError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Photo upload failed. Try again.';
      patchEntry(entry.key, { status: 'error', progress: 0, message });
    }
  }

  async function addPhotos(assets: PhotoAsset[]) {
    if (assets.length === 0) return;
    const existing = photoEntries.filter((e) => e.status === 'done').length;
    const pending = photoEntries.filter((e) => e.status === 'uploading').length;
    const cap = checkPhotoCap({ existing, pending, incoming: assets.length });
    if (!cap.ok) {
      Alert.alert('Too many photos', cap.message);
      return;
    }
    const entries: PhotoEntry[] = assets.map((a) => ({
      key: localKey(),
      uri: a.uri,
      fileName: a.fileName,
      status: 'uploading',
      progress: 0,
    }));
    setPhotoEntries((prev) => [...prev, ...entries]);
    for (const entry of entries) {
      await runUpload(entry);
    }
  }

  function retryPhoto(key: string) {
    const entry = photoEntries.find((e) => e.key === key);
    if (!entry) return;
    const next: PhotoEntry = { ...entry, status: 'uploading', progress: 0, message: undefined };
    patchEntry(key, { status: 'uploading', progress: 0, message: undefined });
    void runUpload(next);
  }

  async function fromCamera() {
    let perm = await ImagePicker.getCameraPermissionsAsync();
    if (!perm.granted) perm = await ImagePicker.requestCameraPermissionsAsync();
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
      await addPhotos([{ uri: a.uri, fileName: a.fileName ?? undefined }]);
    } catch (e) {
      // iOS Simulator has no real camera; launchCameraAsync rejects.
      Alert.alert(
        'Camera unavailable',
        e instanceof Error
          ? e.message
          : 'The camera is not available on this device. Use Library instead.',
      );
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
      selectionLimit: MAINTENANCE_MAX_PHOTOS,
    });
    if (result.canceled) return;
    await addPhotos(result.assets.map((a) => ({ uri: a.uri, fileName: a.fileName ?? undefined })));
  }

  function finish() {
    if (!createdId) return;
    router.replace(`/maintenance/${createdId}` as Href);
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  // ── Gates ────────────────────────────────────────────────────────────
  if (!enabled) {
    return (
      <GateScreen c={c} onBack={goBack}>
        Maintenance requests aren’t enabled for this workspace. Ask an admin to enable it in
        Settings → Modules.
      </GateScreen>
    );
  }
  if (!canSubmit) {
    return (
      <GateScreen c={c} onBack={goBack}>
        You do not have permission to submit maintenance requests.
      </GateScreen>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={goBack} />
        </View>
        <View style={styles.head}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Wrench size={16} color={c.ink3} strokeWidth={1.5} />
            <Eyebrow>{createdId ? 'ADD PHOTOS' : 'NEW MAINTENANCE REQUEST'}</Eyebrow>
          </View>
          <Display size={32} style={{ marginTop: 10 }}>
            {createdId ? (
              <>
                Add <Em>photos.</Em>
              </>
            ) : (
              <>
                Report an <Em>issue.</Em>
              </>
            )}
          </Display>
        </View>
      </SafeAreaView>

      {createdId ? (
        <PhotosStep
          entries={photoEntries}
          onCamera={fromCamera}
          onLibrary={fromLibrary}
          onRetry={retryPhoto}
          onFinish={finish}
        />
      ) : (
        <FormStep
          subject={subject}
          setSubject={setSubject}
          description={description}
          setDescription={setDescription}
          category={category}
          setCategory={setCategory}
          categories={categories}
          priority={priority}
          setPriority={setPriority}
          charterId={charterId}
          setCharterId={setCharterId}
          sites={sites}
          requesterPhone={requesterPhone}
          setRequesterPhone={setRequesterPhone}
          building={building}
          setBuilding={setBuilding}
          roomOrArea={roomOrArea}
          setRoomOrArea={setRoomOrArea}
          department={department}
          setDepartment={setDepartment}
          accessInstructions={accessInstructions}
          setAccessInstructions={setAccessInstructions}
          hasLinkedRecord={hasLinkedRecord}
          saving={saving}
          onSave={onSave}
        />
      )}
    </View>
  );
}

function GateScreen({
  c,
  onBack,
  children,
}: {
  c: ReturnType<typeof useTheme>['c'];
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={onBack} />
        </View>
      </SafeAreaView>
      <View style={{ paddingHorizontal: 20, marginTop: 24 }}>
        <Card padding={16}>
          <Body size={14.5}>{children}</Body>
        </Card>
      </View>
    </View>
  );
}

function FormStep({
  subject,
  setSubject,
  description,
  setDescription,
  category,
  setCategory,
  categories,
  priority,
  setPriority,
  charterId,
  setCharterId,
  sites,
  requesterPhone,
  setRequesterPhone,
  building,
  setBuilding,
  roomOrArea,
  setRoomOrArea,
  department,
  setDepartment,
  accessInstructions,
  setAccessInstructions,
  hasLinkedRecord,
  saving,
  onSave,
}: {
  subject: string;
  setSubject: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  category: string | null;
  setCategory: (v: string | null) => void;
  categories: string[];
  priority: MaintenancePriority;
  setPriority: (v: MaintenancePriority) => void;
  charterId: string | null;
  setCharterId: (v: string | null) => void;
  sites: Array<{ id: string; name: string }>;
  requesterPhone: string;
  setRequesterPhone: (v: string) => void;
  building: string;
  setBuilding: (v: string) => void;
  roomOrArea: string;
  setRoomOrArea: (v: string) => void;
  department: string;
  setDepartment: (v: string) => void;
  accessInstructions: string;
  setAccessInstructions: (v: string) => void;
  hasLinkedRecord: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const { c } = useTheme();
  const [footerHeight, setFooterHeight] = React.useState<number | null>(null);

  return (
    <>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingBottom: footerReservation(footerHeight, 140),
          }}
          keyboardShouldPersistTaps="handled"
        >
          <SectionLabel>WHAT&apos;S THE ISSUE</SectionLabel>
          <Field label="SUBJECT">
            <TextInput
              value={subject}
              onChangeText={setSubject}
              placeholder="Example: Air conditioner is not working in Room 204"
              placeholderTextColor={c.ink4}
              style={[styles.input, { color: c.ink, borderColor: c.hair }]}
            />
          </Field>
          <Field label="DESCRIBE THE ISSUE">
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Explain what is happening, when it started, and anything the maintenance team should know before arriving."
              placeholderTextColor={c.ink4}
              multiline
              numberOfLines={5}
              style={[styles.input, styles.multiline, { color: c.ink, borderColor: c.hair }]}
            />
          </Field>

          <SectionLabel>DETAILS</SectionLabel>
          <ChipPickerField label="SITE" options={sites} valueId={charterId} onChange={setCharterId} emptyText="No sites configured." />
          <ChipTextPickerField
            label="CATEGORY"
            options={categories}
            value={category}
            onChange={setCategory}
          />
          <Field label="PRIORITY">
            <View style={styles.chipRow}>
              {MAINTENANCE_PRIORITIES.map((p) => {
                const selected = priority === p;
                return (
                  <Pressable
                    key={p}
                    onPress={() => setPriority(p)}
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
                      {PRIORITY_LABELS[p]}
                    </Body>
                    {selected ? (
                      <Check size={13} color={c.ink} strokeWidth={2} style={{ marginLeft: 6 }} />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </Field>
          {priority === 'urgent' ? (
            <Card padding={12} style={{ marginTop: 10 }}>
              <Body size={13} muted>
                For emergencies that put people in danger, follow your site emergency procedures
                first. StockPilot does not replace them.
              </Body>
            </Card>
          ) : null}

          <Field label="CONTACT PHONE (OPTIONAL)">
            <TextInput
              value={requesterPhone}
              onChangeText={setRequesterPhone}
              placeholder="(555) 555-0100"
              placeholderTextColor={c.ink4}
              keyboardType="phone-pad"
              style={[styles.input, { color: c.ink, borderColor: c.hair }]}
            />
          </Field>

          <SectionLabel>LOCATION</SectionLabel>
          <Row>
            <Field flex label="BUILDING">
              <TextInput
                value={building}
                onChangeText={setBuilding}
                placeholder="Main building"
                placeholderTextColor={c.ink4}
                style={[styles.input, { color: c.ink, borderColor: c.hair }]}
              />
            </Field>
            <Field flex label="ROOM OR AREA">
              <TextInput
                value={roomOrArea}
                onChangeText={setRoomOrArea}
                placeholder="Room 204"
                placeholderTextColor={c.ink4}
                style={[styles.input, { color: c.ink, borderColor: c.hair }]}
              />
            </Field>
          </Row>
          <Field label="DEPARTMENT">
            <TextInput
              value={department}
              onChangeText={setDepartment}
              placeholderTextColor={c.ink4}
              style={[styles.input, { color: c.ink, borderColor: c.hair }]}
            />
          </Field>
          <Field label="ADDITIONAL ACCESS INSTRUCTIONS">
            <TextInput
              value={accessInstructions}
              onChangeText={setAccessInstructions}
              multiline
              numberOfLines={2}
              placeholderTextColor={c.ink4}
              style={[styles.input, styles.multiline, { color: c.ink, borderColor: c.hair }]}
            />
          </Field>

          {hasLinkedRecord ? (
            <Card padding={12} style={{ marginTop: 16 }}>
              {/* M3 (web parity): only claims what was LAUNCHED WITH, never
                  what the server actually kept — create() re-derives the id
                  against this org and silently drops it on a mismatch. */}
              <Body size={13} muted>
                A related StockPilot record was pre-filled. If it matches a record in your
                organization, it will be included automatically.
              </Body>
            </Card>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

      <View
        style={[styles.footer, { backgroundColor: c.paper, borderTopColor: c.hair }]}
        onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
      >
        <Pressable
          onPress={onSave}
          disabled={saving}
          style={({ pressed }) => [
            styles.saveBtn,
            { backgroundColor: c.ink, opacity: pressed || saving ? 0.7 : 1 },
          ]}
        >
          {saving ? (
            <ActivityIndicator color={c.paper} />
          ) : (
            <Body size={15} color={c.paper} style={{ fontFamily: FONT.display }}>
              Save request
            </Body>
          )}
        </Pressable>
      </View>
    </>
  );
}

function PhotosStep({
  entries,
  onCamera,
  onLibrary,
  onRetry,
  onFinish,
}: {
  entries: PhotoEntry[];
  onCamera: () => void;
  onLibrary: () => void;
  onRetry: (key: string) => void;
  onFinish: () => void;
}) {
  const { c } = useTheme();
  const doneCount = entries.filter((e) => e.status === 'done').length;
  const [footerHeight, setFooterHeight] = React.useState<number | null>(null);

  return (
    <>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 8,
          paddingBottom: footerReservation(footerHeight, 140),
        }}
      >
        <Body muted size={13} style={{ marginBottom: 14 }}>
          Your request was saved. Photos are optional — add them now, or skip this and continue.
        </Body>
        <Mono size={11} tracking={0.04} upper color={c.ink4} style={{ marginBottom: 10 }}>
          {doneCount}/{MAINTENANCE_MAX_PHOTOS} PHOTOS
        </Mono>

        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
          <Pressable
            onPress={onCamera}
            style={({ pressed }) => [
              photoStyles.addBtn,
              { borderColor: c.hair, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Camera size={18} color={c.ink} strokeWidth={1.5} />
            <Mono size={10} tracking={0.06} color={c.ink} style={{ marginLeft: 6 }}>
              CAMERA
            </Mono>
          </Pressable>
          <Pressable
            onPress={onLibrary}
            style={({ pressed }) => [
              photoStyles.addBtn,
              { borderColor: c.hair, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <ImageIcon size={18} color={c.ink} strokeWidth={1.5} />
            <Mono size={10} tracking={0.06} color={c.ink} style={{ marginLeft: 6 }}>
              LIBRARY
            </Mono>
          </Pressable>
        </View>

        {entries.map((entry) => (
          <PhotoRow key={entry.key} entry={entry} onRetry={() => onRetry(entry.key)} />
        ))}
      </ScrollView>

      <View
        style={[styles.footer, { backgroundColor: c.paper, borderTopColor: c.hair }]}
        onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
      >
        <Pressable
          onPress={onFinish}
          style={({ pressed }) => [styles.saveBtn, { backgroundColor: c.ink, opacity: pressed ? 0.7 : 1 }]}
        >
          <Body size={15} color={c.paper} style={{ fontFamily: FONT.display }}>
            Done
          </Body>
        </Pressable>
      </View>
    </>
  );
}

function PhotoRow({ entry, onRetry }: { entry: PhotoEntry; onRetry: () => void }) {
  const { c } = useTheme();
  return (
    <Card padding={10} style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={photoStyles.thumb}>
          <Image source={{ uri: entry.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {entry.status === 'uploading' ? (
            <>
              <Body size={13} color={c.ink}>
                Uploading…
              </Body>
              <View style={[photoStyles.progressTrack, { backgroundColor: c.hair }]}>
                <View
                  style={[
                    photoStyles.progressFill,
                    { backgroundColor: c.ink, width: `${Math.max(4, Math.round(entry.progress * 100))}%` },
                  ]}
                />
              </View>
            </>
          ) : entry.status === 'done' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Check size={14} color={c.ink} strokeWidth={2} />
              <Body size={13} color={c.ink}>
                Uploaded
              </Body>
            </View>
          ) : (
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <AlertCircle size={14} color={ACCENT.crit} strokeWidth={2} />
                <Body size={13} color={ACCENT.crit} numberOfLines={2}>
                  {entry.message ?? 'Photo upload failed.'}
                </Body>
              </View>
              <Pressable
                onPress={onRetry}
                hitSlop={8}
                style={({ pressed }) => [
                  photoStyles.retryBtn,
                  { borderColor: c.hair, opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <RefreshCw size={12} color={c.ink} strokeWidth={1.8} />
                <Mono size={11} tracking={0.04} color={c.ink} style={{ marginLeft: 6 }}>
                  Retry
                </Mono>
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Card>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 22, marginBottom: 4 }}>
      <Eyebrow>{String(children)}</Eyebrow>
    </View>
  );
}

function useStackedRow(): boolean {
  const { fontScale } = useWindowDimensions();
  return shouldStackRow(fontScale);
}

function Field({
  label,
  children,
  flex,
}: {
  label: string;
  children: React.ReactNode;
  flex?: boolean;
}) {
  const stacked = useStackedRow();
  return (
    <View style={{ marginTop: 14, flex: flex && !stacked ? 1 : undefined }}>
      <FieldLabel>{label}</FieldLabel>
      <View style={{ marginTop: 6 }}>{children}</View>
    </View>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  const stacked = useStackedRow();
  return <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 10 }}>{children}</View>;
}

function ChipPickerField({
  label,
  options,
  valueId,
  onChange,
  emptyText,
}: {
  label: string;
  options: Array<{ id: string; name: string }>;
  valueId: string | null;
  onChange: (id: string | null) => void;
  emptyText?: string;
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
          {options.map((opt) => {
            const selected = valueId === opt.id;
            return (
              <Pressable
                key={opt.id}
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

function ChipTextPickerField({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const { c } = useTheme();
  return (
    <Field label={label}>
      <View style={styles.chipRow}>
        {options.map((opt) => {
          const selected = value === opt;
          return (
            <Pressable
              key={opt}
              onPress={() => onChange(selected ? null : opt)}
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
                {opt}
              </Body>
              {selected ? (
                <Check size={13} color={c.ink} strokeWidth={2} style={{ marginLeft: 6 }} />
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </Field>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  head: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
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
    maxWidth: '100%',
    flexShrink: 1,
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
});

const photoStyles = StyleSheet.create({
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 999,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#e5e5e5',
  },
  progressTrack: {
    marginTop: 6,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    borderRadius: 2,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: 999,
  },
});

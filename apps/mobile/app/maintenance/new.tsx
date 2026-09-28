import * as ImagePicker from 'expo-image-picker';
import { useNetworkState } from 'expo-network';
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
  ESCALATE_TO_MAINTENANCE_HELP,
  ESCALATION_FORM_NOTE_COPY,
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_MAX_PHOTOS,
  MAINTENANCE_PRIORITIES,
  maintenanceRequestFormSchema,
  type MaintenancePriority,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, FieldLabel, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { showWriteCta } from '@/lib/cta-gating';
import { footerReservation, shouldStackRow } from '@/lib/dynamic-type-layout';
import { useEnabledModules } from '@/lib/enabled-modules';
import {
  describeEscalateError,
  duplicateOutcome,
  ESCALATE_BAD_LINK_COPY,
  escalateException,
  escalationFormPrefill,
  escalationFormState,
  escalationSourceLines,
  escalationTarget,
  listedCategory,
  nextRequestFormSlot,
  REQUEST_FORM_REPLACED_COPY,
  requestFormKey,
  uuidParam,
  type EscalationFormState,
  type EscalationLoad,
  type RequestFormSlot,
} from '@/lib/exception-escalation';
import {
  describeExceptionsRequestError,
  EXCEPTION_WORKSPACE_UNAVAILABLE,
  getException,
  isOfflineState,
} from '@/lib/exceptions-api';
import { createMaintenanceRequest } from '@/lib/maintenance-api';
import {
  checkPhotoCap,
  createPhotoAttemptGuard,
  uploadMaintenancePhoto,
  UploadError,
} from '@/lib/maintenance-upload';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT } from '@/lib/theme';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useTheme } from '@/lib/use-theme';
import { retryWorkspace, useWorkspace } from '@/lib/use-workspace';

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
 *
 * RELATED LOCATION (F1-5): a `locationId` launch param (a well-formed uuid)
 * rides as relatedLocationId on EVERY flow; the request used to hard-code
 * null. A hint only: create() re-derives it against this org.
 *
 * ESCALATING AN EXCEPTION (F1-5, Outlook rule 3): with `exceptionOccurrenceId`
 * this is the exception's "Escalate to maintenance" form. It reads the
 * exception (GET /api/v1/exceptions/[id]) for the card that says what is
 * being escalated and for the prefill (core escalationPrefill, the web's
 * words), shows only the four fields the escalate route takes (subject,
 * description, category, priority: the item and the location come from the
 * exception on the server), and Save POSTs /api/v1/exceptions/[id]/escalate,
 * which saves ONE request linked to the exception. Then it replaces itself
 * with the request's screen, where the email opens only if the person taps
 * Outlook, the default mail app or Copy: nothing here opens a composer or
 * sends anything. An exception already escalated opens that request instead.
 * Online only: offline Save is disabled with the reason, and nothing is kept
 * to try later, so an offline replay can never open a composer. Photos are
 * added on the request's screen once it is saved (they are not copied from
 * the exception). Every decision is in lib/exception-escalation.ts.
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

/**
 * Launch-point prefill (Task 20's scan/item launch points push with these,
 * and F1-5's exception and location). NEVER contact identity: the server
 * ignores any client-supplied requester name/email regardless of what this
 * screen carries, matching web's own defaults contract (new/page.tsx).
 */
type LaunchParams = {
  itemId?: string;
  orderRequestId?: string;
  rentalId?: string;
  charterId?: string;
  subject?: string;
  exceptionOccurrenceId?: string;
  locationId?: string;
};

export default function NewMaintenanceRequest() {
  const params = useLocalSearchParams<LaunchParams>();
  // A fresh form whenever what it is for changes (requestFormKey):
  // expo-router REUSES this screen when a link to /maintenance/new arrives
  // while it is on top, swapping only the params, and the form used to keep
  // what it held (simulator walk 2026-09-27: a plain request's subject
  // carried into the escalation form). The same exception keeps its form,
  // and what was typed in it.
  const formKey = requestFormKey(params);
  // The key of the form holding unsaved input (what the person entered, not
  // the prefill), or null. A form that replaces it says so: never silent.
  const [unsavedKey, setUnsavedKey] = React.useState<string | null>(null);
  const [slot, setSlot] = React.useState<RequestFormSlot>({ key: formKey, replacedUnsaved: false });
  if (slot.key !== formKey) {
    setSlot(nextRequestFormSlot(slot, formKey, unsavedKey));
    setUnsavedKey(null);
  }
  return (
    <RequestFormScreen
      key={formKey}
      params={params}
      replacedUnsaved={slot.key === formKey && slot.replacedUnsaved}
      onEntered={() => setUnsavedKey(formKey)}
      onSaved={() => setUnsavedKey(null)}
    />
  );
}

function RequestFormScreen({
  params,
  replacedUnsaved,
  onEntered,
  onSaved,
}: {
  params: LaunchParams;
  /** A link opened this form in place of one holding unsaved input. */
  replacedUnsaved: boolean;
  /** The person entered something (the prefill does not count). */
  onEntered: () => void;
  /** The request was saved: nothing entered here is unsaved any more. */
  onSaved: () => void;
}) {
  const { c } = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { activeOrgId: orgId, loading: workspaceLoading } = useWorkspace();
  const enabledModules = useEnabledModules();
  const enabled = enabledModules.has('maintenance_requests');
  const perms = useEffectivePermissions();
  const canSubmit = showWriteCta(perms, 'maintenance_requests:submit');

  const relatedItemId = params.itemId || null;
  const relatedOrderRequestId = params.orderRequestId || null;
  const relatedRentalId = params.rentalId || null;
  const relatedLocationId = uuidParam(params.locationId);
  const hasLinkedRecord = Boolean(relatedItemId || relatedOrderRequestId || relatedRentalId || relatedLocationId);
  // Escalating an exception (F1-5): the exception this form escalates, or
  // null. A malformed exception param is refused below, never an ordinary
  // (unlinked) request.
  const target = escalationTarget(params.exceptionOccurrenceId);
  const escalationId = target.kind === 'escalate' ? target.occurrenceId : null;
  const offline = isOfflineState(useNetworkState());

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

  const [sites, setSites] = React.useState<{ id: string; name: string }[]>([]);
  const [categories, setCategories] = React.useState<string[]>([...MAINTENANCE_CATEGORIES]);

  // What the person enters marks this form as holding unsaved input (the
  // prefill below does not), so a link that replaces it says so.
  function entered<T>(set: (value: T) => void): (value: T) => void {
    return (value) => {
      set(value);
      onEntered();
    };
  }
  const replacedNotice = replacedUnsaved ? REQUEST_FORM_REPLACED_COPY : null;

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
      setSites((chartersResp.data ?? []) as { id: string; name: string }[]);

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

  // A category is shown selected, and saved, only while the org's list has it
  // (the escalation prefill suggests one the org may not use).
  const shownCategory = listedCategory(categories, category);

  function formValues(): unknown {
    return {
      subject,
      description,
      category: shownCategory,
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
      relatedLocationId,
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
      onSaved();
    } catch (e) {
      Alert.alert('Could not save', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }

  // ── Escalating an exception (F1-5) ────────────────────────────────────
  // The exception, read once it can be (a workspace, a connection), for the
  // "From exception" card, the prefill and whether it can be escalated.
  const [escLoad, setEscLoad] = React.useState<EscalationLoad>({ kind: 'loading' });
  const [escReadNonce, setEscReadNonce] = React.useState(0);
  // The prefill fills the fields once, and never over what the person typed.
  // It is always THIS exception's: a link for another exception, or for a
  // plain request, mounts a fresh form (requestFormKey, above).
  const prefilled = React.useRef(false);
  React.useEffect(() => {
    if (!escalationId || !orgId || offline) return;
    let cancelled = false;
    void (async () => {
      try {
        const detail = await getException(escalationId);
        if (cancelled) return;
        if (detail.organizationId !== orgId) {
          setEscLoad({
            kind: 'error',
            message: 'The server answered for a different workspace. Go back and switch workspace from the menu.',
          });
          return;
        }
        setEscLoad({ kind: 'ready', occurrence: detail.occurrence });
        if (!prefilled.current) {
          prefilled.current = true;
          const prefill = escalationFormPrefill(detail.occurrence);
          setSubject((typed) => typed || prefill.subject);
          setDescription((typed) => typed || prefill.description);
          setCategory((chosen) => chosen ?? prefill.category);
        }
      } catch (e) {
        if (cancelled) return;
        const status = (e as { status?: unknown }).status;
        setEscLoad({
          kind: 'error',
          message:
            status === 404
              ? 'This exception is not available to you, or it no longer exists.'
              : describeExceptionsRequestError(e, 'Could not load this exception.'),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [escalationId, orgId, offline, escReadNonce]);

  function rereadEscalation() {
    setEscLoad({ kind: 'loading' });
    setEscReadNonce((n) => n + 1);
  }

  // Fed the LIVE network state: offline, Save is disabled with the reason.
  const escState = escalationFormState({ load: escLoad, online: !offline, saving, maintenanceEnabled: enabled });
  // A second tap while the first is on its way is dropped here (the server's
  // claim refuses it too: one request per exception).
  const escalating = React.useRef(false);

  async function onEscalate() {
    if (!escalationId || escalating.current || !escState.saveEnabled) return;
    // The request form's own rules, on the four fields the route takes.
    const parsed = maintenanceRequestFormSchema.safeParse({
      subject,
      description,
      category: shownCategory,
      priority,
    });
    if (!parsed.success) {
      Alert.alert('Check the form', parsed.error.issues[0]?.message ?? 'Check the form and try again.');
      return;
    }
    escalating.current = true;
    setSaving(true);
    try {
      const created = await escalateException(escalationId, {
        subject: parsed.data.subject,
        description: parsed.data.description,
        priority: parsed.data.priority,
        category: parsed.data.category ?? null,
      });
      // The request's own screen: the email opens there only on a tap.
      router.replace(`/maintenance/${created.id}` as Href);
    } catch (e) {
      const failure = describeEscalateError(e);
      if (failure.duplicate) {
        // Already escalated (someone got there first). Nothing was saved.
        // Open that request only for a reader who can open it: read the
        // exception again to know (a failed read opens nothing).
        const fresh = await getException(escalationId).then(
          (d) => (d.organizationId === orgId ? d.occurrence : null),
          () => null,
        );
        const outcome = duplicateOutcome(failure.duplicate, fresh, enabled);
        Alert.alert('Already escalated', outcome.message);
        if (outcome.kind === 'open') {
          router.replace(`/maintenance/${outcome.requestId}` as Href);
          return;
        }
        if (fresh) setEscLoad({ kind: 'ready', occurrence: fresh });
        else rereadEscalation();
        return;
      }
      Alert.alert('Could not escalate', failure.message);
      // The exception may have changed (resolved, escalated elsewhere): read
      // it again so the form says so. A retryable failure keeps what is shown.
      if (!failure.retryable) rereadEscalation();
    } finally {
      escalating.current = false;
      setSaving(false);
    }
  }

  // ── Photos (step 2) ───────────────────────────────────────────────────
  const [photoEntries, setPhotoEntries] = React.useState<PhotoEntry[]>([]);
  // Lazy useState, not a ref: .current during render is a compiler violation.
  const [guard] = React.useState(() => createPhotoAttemptGuard());

  function patchEntry(key: string, patch: Partial<PhotoEntry>) {
    setPhotoEntries((prev) => prev.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  }

  async function runUpload(entry: PhotoEntry) {
    if (!createdId) return;
    
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

  const escalationView: EscalationFormView = {
    load: escLoad,
    online: !offline,
    state: escState,
    onRetry: rereadEscalation,
    onOpenRequest: (requestId) => router.replace(`/maintenance/${requestId}` as Href),
  };

  // ── Gates ────────────────────────────────────────────────────────────
  if (!enabled) {
    return (
      <GateScreen c={c} onBack={goBack} notice={replacedNotice}>
        Maintenance requests aren’t enabled for this workspace. Ask an admin to enable it in
        Settings → Modules.
      </GateScreen>
    );
  }
  if (!canSubmit) {
    return (
      <GateScreen c={c} onBack={goBack} notice={replacedNotice}>
        You do not have permission to submit maintenance requests.
      </GateScreen>
    );
  }
  if (target.kind === 'malformed') {
    return (
      <GateScreen c={c} onBack={goBack} notice={replacedNotice}>
        {ESCALATE_BAD_LINK_COPY}
      </GateScreen>
    );
  }
  // Escalating with no workspace (a launch offline, or a failed first read):
  // the exception can never load, so say so, with Try again that loads the
  // workspace again.
  if (escalationId && !orgId && !workspaceLoading) {
    return (
      <GateScreen c={c} onBack={goBack} action={<WorkspaceRetry />} notice={replacedNotice}>
        {EXCEPTION_WORKSPACE_UNAVAILABLE}
      </GateScreen>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={goBack} accessibilityLabel="Back" minTap />
        </View>
        <View style={styles.head}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Wrench size={16} color={c.ink3} strokeWidth={1.5} />
            <Eyebrow>
              {createdId ? 'ADD PHOTOS' : escalationId ? 'ESCALATE TO MAINTENANCE' : 'NEW MAINTENANCE REQUEST'}
            </Eyebrow>
          </View>
          <Display size={32} style={{ marginTop: 10 }}>
            {createdId ? (
              <>
                Add <Em>photos.</Em>
              </>
            ) : escalationId ? (
              <>
                Escalate an <Em>exception.</Em>
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
      ) : escalationId && !escState.showForm ? (
        // Escalating, but no form: the exception is loading, could not be
        // read, or cannot be escalated (with its request to open when it is
        // already escalated). The web shows no form either.
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}>
          <ReplacedNotice text={replacedNotice} />
          <EscalationSourceCard view={escalationView} />
        </ScrollView>
      ) : (
        <FormStep
          subject={subject}
          setSubject={entered(setSubject)}
          description={description}
          setDescription={entered(setDescription)}
          category={shownCategory}
          setCategory={entered(setCategory)}
          categories={categories}
          priority={priority}
          setPriority={entered(setPriority)}
          charterId={charterId}
          setCharterId={entered(setCharterId)}
          sites={sites}
          requesterPhone={requesterPhone}
          setRequesterPhone={entered(setRequesterPhone)}
          building={building}
          setBuilding={entered(setBuilding)}
          roomOrArea={roomOrArea}
          setRoomOrArea={entered(setRoomOrArea)}
          department={department}
          setDepartment={entered(setDepartment)}
          accessInstructions={accessInstructions}
          setAccessInstructions={entered(setAccessInstructions)}
          hasLinkedRecord={hasLinkedRecord}
          saving={saving}
          onSave={escalationId ? () => void onEscalate() : onSave}
          escalation={escalationId ? escalationView : null}
          notice={replacedNotice}
        />
      )}
    </View>
  );
}

/**
 * Said on the form a link opened in place of one holding unsaved input
 * (REQUEST_FORM_REPLACED_COPY): what was entered there was not saved and is
 * not part of this request. Nothing when `text` is null.
 */
function ReplacedNotice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <Card padding={14} style={{ marginTop: 16 }}>
      <Body size={14} accessibilityRole="alert">
        {text}
      </Body>
    </Card>
  );
}

function GateScreen({
  c,
  onBack,
  children,
  action,
  notice,
}: {
  c: ReturnType<typeof useTheme>['c'];
  onBack: () => void;
  children: React.ReactNode;
  /** A control under the message (Try again). */
  action?: React.ReactNode;
  /** A link opened this screen in place of a form holding unsaved input. */
  notice?: string | null;
}) {
  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={onBack} accessibilityLabel="Back" minTap />
        </View>
      </SafeAreaView>
      <View style={{ paddingHorizontal: 20, marginTop: 21 }}>
        <Card padding={16}>
          <Body size={14.5}>{children}</Body>
          {action}
        </Card>
        <ReplacedNotice text={notice ?? null} />
      </View>
    </View>
  );
}

/** Try again for a missing workspace (use-workspace retryWorkspace). */
function WorkspaceRetry() {
  const [retrying, setRetrying] = React.useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={retrying}
      onPress={() => {
        setRetrying(true);
        void retryWorkspace().finally(() => setRetrying(false));
      }}
      style={{ alignSelf: 'flex-start', marginTop: 14, minHeight: 44 }}
    >
      Try again
    </Button>
  );
}

/** What the form shows and does while it escalates an exception. */
interface EscalationFormView {
  load: EscalationLoad;
  online: boolean;
  state: EscalationFormState;
  onRetry: () => void;
  onOpenRequest: (requestId: string) => void;
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
  escalation,
  notice,
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
  sites: { id: string; name: string }[];
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
  /** Escalating an exception (F1-5): only the four fields the escalate route
   *  takes are shown (a field it would drop is never offered), and Save
   *  follows the escalation gate. null for an ordinary request. */
  escalation: EscalationFormView | null;
  /** A link opened this form in place of one holding unsaved input. */
  notice: string | null;
}) {
  const { c } = useTheme();
  const [footerHeight, setFooterHeight] = React.useState<number | null>(null);
  const saveDisabled = saving || (escalation !== null && !escalation.state.saveEnabled);

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
          <ReplacedNotice text={notice} />
          {escalation ? <EscalationSourceCard view={escalation} /> : null}
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
          {escalation ? null : (
            <ChipPickerField label="SITE" options={sites} valueId={charterId} onChange={setCharterId} emptyText="No sites configured." />
          )}
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

          {escalation ? null : (
            <>
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
            </>
          )}

          {hasLinkedRecord && !escalation ? (
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
        {escalation?.state.reason ? (
          <Body size={13} muted accessibilityRole="alert" style={{ marginBottom: 10 }}>
            {escalation.state.reason}
          </Body>
        ) : null}
        <Pressable
          onPress={onSave}
          disabled={saveDisabled}
          accessibilityRole="button"
          accessibilityState={{ disabled: saveDisabled, busy: saving }}
          style={({ pressed }) => [
            styles.saveBtn,
            { backgroundColor: c.ink, opacity: pressed || saveDisabled ? 0.7 : 1 },
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

/**
 * The exception being escalated (F1-5): its reference and rule, its item and
 * location, and what escalating does and does not do (core's words, as on
 * the web). Loading, a failed read (with Try again) and offline say so. With
 * no form (the exception cannot be escalated), why, and its request to open
 * when it is already escalated and this reader can open it.
 */
function EscalationSourceCard({ view }: { view: EscalationFormView }) {
  const { c } = useTheme();
  const { load, state } = view;
  const lines = load.kind === 'ready' ? escalationSourceLines(load.occurrence) : null;
  return (
    <Card padding={14} style={{ marginTop: 16, gap: 6 }}>
      <Eyebrow>LINKED EXCEPTION</Eyebrow>
      {load.kind === 'loading' ? (
        view.online ? (
          <ActivityIndicator
            color={c.ink4}
            style={{ alignSelf: 'flex-start' }}
            accessibilityLabel="Loading the exception"
          />
        ) : null
      ) : load.kind === 'error' ? (
        <>
          <Body size={14} accessibilityRole="alert">
            {load.message}
          </Body>
          <Button
            variant="outline"
            size="sm"
            disabled={!view.online}
            onPress={view.onRetry}
            style={{ alignSelf: 'flex-start', minHeight: 44 }}
          >
            Try again
          </Button>
        </>
      ) : lines ? (
        <>
          <Mono size={12} color={c.ink3}>
            {lines.heading}
          </Mono>
          {lines.item ? (
            <Body size={14.5} color={c.ink}>
              {`Item: ${lines.item}`}
            </Body>
          ) : null}
          {lines.location ? (
            <Body size={14} color={c.ink}>
              {`Location: ${lines.location}`}
            </Body>
          ) : null}
        </>
      ) : null}
      {!state.showForm && state.reason ? (
        <Body size={14} color={c.ink} accessibilityRole="alert" style={{ marginTop: 4 }}>
          {state.reason}
        </Body>
      ) : null}
      {state.openExisting ? (
        <Button
          block
          variant="outline"
          onPress={() => view.onOpenRequest(state.openExisting!.requestId)}
          style={{ marginTop: 6 }}
        >
          {state.openExisting.label}
        </Button>
      ) : null}
      <Body size={13} muted style={{ marginTop: 4 }}>
        {ESCALATE_TO_MAINTENANCE_HELP}
      </Body>
      <Body size={13} muted>
        {ESCALATION_FORM_NOTE_COPY}
      </Body>
    </Card>
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
  options: { id: string; name: string }[];
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
  // The back chip's 44pt frame (IconChip minTap) is 3pt wider than the 38pt
  // chip on every side, so the bar takes 3pt off its padding (12, 8) and the
  // head and the gate card 3pt off their top: the chip, the title and the
  // card sit exactly where they did, and on every other screen.
  topbar: {
    paddingHorizontal: 9,
    paddingTop: 5,
    flexDirection: 'row',
    alignItems: 'center',
  },
  head: {
    paddingHorizontal: 20,
    paddingTop: 9,
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

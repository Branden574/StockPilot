import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowLeft,
  Camera,
  Check,
  CheckCircle2,
  ClipboardList,
  Copy,
  ImageIcon,
  Images,
  Mail,
  MailOpen,
  Trash2,
  Users,
  Wrench,
} from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  MAINTENANCE_CC_NOTICE,
  MAINTENANCE_MAX_PHOTOS,
  MAINTENANCE_RESOLUTION_NOTE_MAX,
  MAINTENANCE_STATUS_LABELS,
  formatMaintenanceRequestNumber,
  prepareMaintenanceEmail,
  type MaintenanceEmailInput,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card, Hair } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Pill } from '@/components/ui/pill';
import { Body, Display, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { useEnabledModules } from '@/lib/enabled-modules';
import { formatRelativeTime } from '@/lib/item-activity';
import {
  ARCHIVE_BUTTON_LABEL,
  ARCHIVE_CANCEL_LABEL,
  ARCHIVE_CONFIRM_MESSAGE,
  ARCHIVE_CONFIRM_TITLE,
  ARCHIVE_GENERIC_ERROR,
  ASSIGN_OWNER_GENERIC_ERROR,
  ASSIGN_OWNER_HELPER,
  ASSIGN_OWNER_SECTION_LABEL,
  ASSIGN_OWNER_TOGGLE_LABEL,
  ASSIGN_OWNER_UNASSIGNED_LABEL,
  MEMBERS_LOAD_ERROR,
  MOBILE_RESOLVE_DISCLOSURE,
  NOTES_ADD_GENERIC_ERROR,
  NOTES_ADD_LABEL,
  NOTES_ADD_PENDING_LABEL,
  NOTES_EMPTY,
  NOTES_HELPER,
  NOTES_LOAD_ERROR,
  NOTES_PLACEHOLDER,
  NOTES_SECTION_LABEL,
  NOTES_TOGGLE_LABEL,
  NOTES_TRUNCATED,
  RESOLVE_ADD_PHOTO_LABEL,
  RESOLVE_CONFIRM_LABEL,
  RESOLVE_GENERIC_ERROR,
  RESOLVE_NOTE_PLACEHOLDER,
  RESOLVE_PENDING_LABEL,
  RESOLVE_TOGGLE_LABEL,
  availableCloseoutActions,
  canConfirmResolve,
  mapActionError,
  resolveNoteAuthorName,
  resolveNoteHelperText,
} from '@/lib/maintenance-actions';
import {
  addMaintenanceNote,
  archiveMaintenanceRequest,
  assignMaintenanceOwner,
  getMaintenanceRequest,
  issueMaintenanceShareLink,
  listMaintenanceMembers,
  listMaintenanceNotes,
  recordDraftOpened,
  resolveMaintenanceRequest,
  type MobileMaintenanceMember,
  type MobileMaintenanceNote,
  type MobileMaintenancePhoto,
  type MobileMaintenanceRequestDetail,
} from '@/lib/maintenance-api';
import {
  BLOCKED_HEADLINE,
  BLOCKED_RETRY_MESSAGE,
  CONDENSED_NOTICE,
  COPY_HELPER_TEXT,
  DUPLICATE_WARNING,
  OVERSIZED_MESSAGE,
  SHARE_LINK_EXISTS_NOTICE,
  SHARE_LINK_SHOW_ONCE_NOTICE,
  openMaintenanceDraft,
  shouldConfirmBeforeOpening,
  shouldShowCondensedNotice,
  successMessageFor,
  withShareUrl,
  type EmailTransport,
  type OpenedTransport,
  type OutlookPlatform,
} from '@/lib/maintenance-email-actions';
import { resolutionProofCaption, shouldShowResolutionCard, splitPhotosByKind, statusPillTone } from '@/lib/maintenance-filters';
import {
  PHOTO_UPLOAD_GENERIC_ERROR,
  REQUEST_PHOTOS_ADD_LABEL,
  REQUEST_PHOTOS_REFRESH_ERROR,
  photoPermissionDenial,
  photoUploadErrorMessage,
  reconcileRequestPhotoQueue,
  requestPhotoCapCheck,
  requestPhotoUploadOptions,
  requestPhotosEditability,
  requestPhotosEmptyCopy,
  requestPhotosHeading,
  resolutionPhotoUploadOptions,
  type MaintenancePhotoQueueEntry,
} from '@/lib/maintenance-request-photos';
import {
  checkPhotoCap,
  createPhotoAttemptGuard,
  uploadMaintenancePhoto,
} from '@/lib/maintenance-upload';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Maintenance request detail — mobile twin of the web
 * `/dashboard/maintenance/[id]` page: status, subject/description, photos,
 * To/CC + `MAINTENANCE_CC_NOTICE`, the email-action block (Task 20), and
 * (Task 10) the CLOSE-OUT card — Resolve with note + proof photos, Archive,
 * Assign owner, Internal notes, manage-gated via `availableCloseoutActions`.
 * The full StockPilot-activity TIMELINE (the chronological event list web's
 * page.tsx renders in its own aside) stays web-only for now — out of Task
 * 10's file list, not silently dropped.
 *
 * Every DECISION this screen makes — which transport opens, whether the
 * duplicate-draft confirm fires, whether the condensed notice shows,
 * whether a failed open gets recorded, which CLOSE-OUT actions are visible,
 * whether the resolve confirm button is enabled — is delegated to
 * `@/lib/maintenance-email-actions` / `@/lib/maintenance-actions`, tested
 * there behaviorally. This file is orchestration + rendering only, same
 * "source-pin honesty" posture Task 9/18/19 established (this repo's
 * vitest cannot render `app/`).
 */
/** Detail-page analog of the list screen's brief-section-22 note (web's own
 *  detail page shows this exact sentence under "StockPilot activity" —
 *  page.tsx). Never implies a fake ticket-conversation timeline (brief
 *  section 23). */
const SECTION_23_NOTE =
  'Local StockPilot actions only. Ticket replies happen in the Outlook/Zendesk email conversation and are not shown here.';

function localPhotoKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * One row of a photo-upload queue. Shared verbatim by BOTH queues on this
 * screen — the request-photo card (`kind: 'requester'`) and the close-out
 * card's proof picker (`kind: 'resolution'`) — so honest progress and honest
 * failure cannot drift apart between them. The queue entry shape it renders
 * is `MaintenancePhotoQueueEntry` (maintenance-request-photos.ts), for the
 * same reason.
 */
function PhotoQueueRow({
  entry,
  onRetry,
}: {
  entry: MaintenancePhotoQueueEntry;
  onRetry: () => void;
}) {
  const { c } = useTheme();
  const label = entry.fileName ?? 'photo';
  return (
    <Card padding={10} style={{ marginTop: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Image source={{ uri: entry.uri }} style={styles.resolvePhotoThumb} contentFit="cover" />
        <View style={{ flex: 1, minWidth: 0 }}>
          {entry.status === 'uploading' ? (
            <>
              <Body size={12.5} color={c.ink}>
                Uploading…
              </Body>
              <View style={[styles.progressTrack, { backgroundColor: c.hair }]}>
                <View
                  style={[
                    styles.progressFill,
                    { backgroundColor: c.ink, width: `${Math.max(4, Math.round(entry.progress * 100))}%` },
                  ]}
                />
              </View>
            </>
          ) : entry.status === 'done' ? (
            <Body size={12.5} color={c.ink}>
              Uploaded
            </Body>
          ) : (
            <>
              {/* The failure reason is rendered IN PLACE, next to the photo it
                  belongs to — never only as a transient toast, which would
                  leave a failed photo on screen with nothing saying why. */}
              <Body size={12.5} color={ACCENT.crit}>
                {entry.message ?? PHOTO_UPLOAD_GENERIC_ERROR}
              </Body>
              <Pressable
                onPress={onRetry}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Retry ${label}`}
                style={{ marginTop: 6 }}
              >
                <Mono size={10.5} tracking={0.04} upper color={c.ink}>
                  RETRY
                </Mono>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Card>
  );
}

/** Camera/Library pair, shared by the request-photo card and the close-out
 *  proof picker so the two never drift in shape or reach. */
function PhotoSourceButton({
  icon: Icon,
  label,
  accessibilityLabel,
  onPress,
}: {
  icon: typeof Camera;
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.addPhotoBtn,
        { borderColor: c.hair, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Icon size={16} color={c.ink} strokeWidth={1.5} />
      <Mono size={10} tracking={0.06} color={c.ink} style={{ marginLeft: 6 }}>
        {label}
      </Mono>
    </Pressable>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  const { c } = useTheme();
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return null;
  return (
    <View style={styles.detailRow}>
      <Mono size={11} tracking={0.04} upper color={c.ink4}>
        {label}
      </Mono>
      <Body size={13} color={c.ink} style={{ flexShrink: 1, textAlign: 'right' }}>
        {v}
      </Body>
    </View>
  );
}

export default function MaintenanceRequestDetailScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const enabledModules = useEnabledModules();
  const enabled = enabledModules.has('maintenance_requests');

  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<MobileMaintenanceRequestDetail | null>(null);
  const [photos, setPhotos] = React.useState<MobileMaintenancePhoto[]>([]);
  // Request-photo queue (kind: 'requester') — the card that closes the gap
  // this screen shipped with: a phone could attach photos only during
  // app/maintenance/new.tsx's post-create step, and nothing routed back to
  // it. Kept separate from `resolvePhotos` below (different kind, different
  // per-kind cap budget, different card) but rendered by the same
  // `PhotoQueueRow` and settled by the same guard mechanism.
  const [requestPhotoQueue, setRequestPhotoQueue] = React.useState<MaintenancePhotoQueueEntry[]>([]);
  // Lazy useState, not a ref: .current during render is a compiler violation.
  const [requestPhotoGuard] = React.useState(() => createPhotoAttemptGuard());
  const [photosRefreshError, setPhotosRefreshError] = React.useState<string | null>(null);
  const [emailInput, setEmailInput] = React.useState<MaintenanceEmailInput | null>(null);
  const [canManage, setCanManage] = React.useState(false);
  // Mig 0330: token-free status ("a link exists, expires then") from the
  // GET; the URL itself only ever exists in `generatedShareUrl`, set by an
  // explicit Generate action (show-once — gone on unmount, by design).
  const [shareLink, setShareLink] = React.useState<{ expiresAt: string } | null>(null);
  const [generatedShareUrl, setGeneratedShareUrl] = React.useState<string | null>(null);
  const [sharePending, setSharePending] = React.useState(false);
  const [openCount, setOpenCount] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [lastResult, setLastResult] = React.useState<{
    used: OpenedTransport | null;
    outcome: 'opened' | 'blocked';
  } | null>(null);
  const [copyOpen, setCopyOpen] = React.useState(false);

  // Task 10 — CLOSE-OUT card state. Bumping `refreshKey` re-fires the load
  // effect below (its own dependency array), which is how a successful
  // Resolve/Archive/Assign-owner call refreshes `detail` — never a local
  // hand-patched echo of what the server did.
  const [refreshKey, setRefreshKey] = React.useState(0);
  function refreshDetail() {
    setRefreshKey((k) => k + 1);
  }

  const [resolveOpen, setResolveOpen] = React.useState(false);
  const [resolveNote, setResolveNote] = React.useState('');
  const [resolvePending, setResolvePending] = React.useState(false);
  const [resolveError, setResolveError] = React.useState<string | null>(null);
  const [resolvePhotos, setResolvePhotos] = React.useState<MaintenancePhotoQueueEntry[]>([]);
  // Lazy useState, not a ref: .current during render is a compiler violation.
  const [resolveGuard] = React.useState(() => createPhotoAttemptGuard());

  const [archivePending, setArchivePending] = React.useState(false);

  const [assignOpen, setAssignOpen] = React.useState(false);
  const [members, setMembers] = React.useState<MobileMaintenanceMember[] | null>(null);
  const [membersLoading, setMembersLoading] = React.useState(false);
  const [membersError, setMembersError] = React.useState<string | null>(null);
  const [assignPending, setAssignPending] = React.useState(false);

  const [notesOpen, setNotesOpen] = React.useState(false);
  const [notes, setNotes] = React.useState<MobileMaintenanceNote[] | null>(null);
  const [notesLoading, setNotesLoading] = React.useState(false);
  const [notesError, setNotesError] = React.useState<string | null>(null);
  const [noteBody, setNoteBody] = React.useState('');
  const [notePending, setNotePending] = React.useState(false);

  React.useEffect(() => {
    if (!enabled || !id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- keyed refetch (refreshKey): the sync sets are the guard/loading/error flags for a server fetch this effect re-runs after mutations; every data set is post-await
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const res = await getMaintenanceRequest(id);
        if (cancelled) return;
        setDetail(res.request);
        setPhotos(res.photos);
        setEmailInput(res.emailInput);
        setShareLink(res.shareLink);
        setOpenCount(res.request.outlookDraftOpenCount);
        setCanManage(res.canManage);
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Couldn't load this request. Try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, id, refreshKey]);

  // Pure, deterministic (no clock, no DOM) — recomputed only when the
  // server payload or a freshly-generated share URL changes, matching web's
  // identical useMemo (there the merge happens via the share-link context).
  const prepared = React.useMemo(
    () => (emailInput ? prepareMaintenanceEmail(withShareUrl(emailInput, generatedShareUrl)) : null),
    [emailInput, generatedShareUrl],
  );

  // Explicit Generate/Regenerate (mig 0330): the ONLY way to obtain a URL.
  // Rotates server-side, so any previously shared URL stops working.
  async function generateShareLink() {
    if (!id) return;
    setSharePending(true);
    try {
      const res = await issueMaintenanceShareLink(id);
      setGeneratedShareUrl(res.url);
      setShareLink({ expiresAt: res.expiresAt });
    } catch (e) {
      Alert.alert(
        'Could not generate the link',
        e instanceof Error ? e.message : 'Try again in a moment.',
      );
    } finally {
      setSharePending(false);
    }
  }

  async function runOpen(transport: EmailTransport) {
    if (!prepared || !id) return;
    setBusy(true);
    // Platform.OS is read HERE and nowhere in src/lib — the transport
    // decision stays a pure, node-testable function that takes the platform
    // as data (react-native cannot be imported under this repo's vitest).
    const platform: OutlookPlatform = Platform.OS === 'android' ? 'android' : 'ios';
    const result = await openMaintenanceDraft(transport, prepared, platform, () => {
      // Optimistic local bump so a rapid second tap is gated even before the
      // network round trip below settles; recordDraftOpened's own count
      // (server truth) then reconciles it. Best-effort only — mirrors web's
      // identical `.catch()` precedent (maintenance-email-action.tsx): a
      // lost bookkeeping call means the SERVER's count can undercount, never
      // that the employee's own draft silently vanished.
      setOpenCount((n) => n + 1);
      void recordDraftOpened(id)
        .then((r) => setOpenCount(r.openCount))
        .catch(() => {});
    });
    setBusy(false);
    // `result.used` is the transport that ACTUALLY carried the draft (native
    // Outlook, Outlook Web, or the default mail app), which is what the
    // success copy below is chosen from — never the button that was pressed.
    setLastResult(result);
  }

  function handleOpenPress(transport: EmailTransport) {
    if (shouldConfirmBeforeOpening(openCount)) {
      Alert.alert('Open another draft?', DUPLICATE_WARNING, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Another Draft', onPress: () => void runOpen(transport) },
      ]);
      return;
    }
    void runOpen(transport);
  }

  function openPhotosPage() {
    // Only a URL generated THIS session is openable (mig 0330 — the server
    // never sends one back).
    const url = generatedShareUrl;
    if (!url) return;
    Linking.openURL(url).catch(() => {
      // Nothing further to do — this opens a plain public page, not an
      // email compose; no recovery panel is owed for it (unlike the two
      // email transports above).
    });
  }

  // ── Photo sources (shared by BOTH queues) ─────────────────────────────
  // One camera path and one library path for the whole screen. Permission
  // denial copy comes from `photoPermissionDenial`, which keys on
  // `canAskAgain` for BOTH sources — the OS will not re-prompt once someone
  // has hard-denied, so "allow it in the prompt" would point at a prompt that
  // never appears again; only the Settings app can undo it. Returns [] for
  // cancel AND for denial: both mean "no assets", and the denial already
  // said its piece in the alert.
  async function pickFromCamera(): Promise<{ uri: string; fileName?: string }[]> {
    let perm = await ImagePicker.getCameraPermissionsAsync();
    if (!perm.granted) perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      const denial = photoPermissionDenial('camera', perm.canAskAgain);
      Alert.alert(denial.title, denial.message);
      return [];
    }
    try {
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.7,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        cameraType: ImagePicker.CameraType.back,
      });
      if (result.canceled || !result.assets[0]) return [];
      const a = result.assets[0];
      return [{ uri: a.uri, fileName: a.fileName ?? undefined }];
    } catch (e) {
      // iOS Simulator has no real camera; launchCameraAsync rejects.
      Alert.alert(
        'Camera unavailable',
        e instanceof Error
          ? e.message
          : 'The camera is not available on this device. Use Library instead.',
      );
      return [];
    }
  }

  async function pickFromLibrary(): Promise<{ uri: string; fileName?: string }[]> {
    let perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!perm.granted) perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      const denial = photoPermissionDenial('library', perm.canAskAgain);
      Alert.alert(denial.title, denial.message);
      return [];
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 0.7,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: MAINTENANCE_MAX_PHOTOS,
    });
    if (result.canceled) return [];
    return result.assets.map((a) => ({ uri: a.uri, fileName: a.fileName ?? undefined }));
  }

  // ── Request photos (kind: 'requester') ────────────────────────────────
  function patchRequestPhoto(key: string, patch: Partial<MaintenancePhotoQueueEntry>) {
    setRequestPhotoQueue((prev) => prev.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  }

  /**
   * Re-reads the request so a just-uploaded photo appears in the grid without
   * anyone pulling to refresh or leaving the screen. Deliberately NOT
   * `refreshDetail()`: that bumps `refreshKey`, which flips the whole screen
   * to a full-page spinner — acceptable after a Resolve, absurd after each
   * photo. Only `photos` is adopted here, so the share-link/open-count state
   * this screen holds is never reset behind the user's back.
   *
   * A failed refresh is NOT reported as a failed upload. The bytes are on the
   * server; only this list is stale, and the finished queue row stays visible
   * (reconcile keeps any row the server list cannot yet show) so the photo is
   * never silently unaccounted for.
   */
  async function refreshRequestPhotos() {
    if (!id) return;
    try {
      const res = await getMaintenanceRequest(id);
      setPhotos(res.photos);
      setPhotosRefreshError(null);
      setRequestPhotoQueue((prev) =>
        reconcileRequestPhotoQueue(
          prev,
          res.photos.map((p) => p.id),
        ),
      );
    } catch {
      setPhotosRefreshError(REQUEST_PHOTOS_REFRESH_ERROR);
    }
  }

  async function runRequestPhotoUpload(entry: MaintenancePhotoQueueEntry) {
    if (!id) return;
    const guard = requestPhotoGuard;
    const token = guard.start(entry.key);
    try {
      // kind: 'requester' — REQUEST photos, the same kind web's
      // MaintenancePhotosPanel uploads, NOT the 'resolution' close-out proof
      // the Resolve card below sends. Everything else (resize/HEIC
      // transcode, mint, native createUploadTask PUT, finalize) is the same
      // tested orchestration from maintenance-upload.ts.
      const { id: attachmentId } = await uploadMaintenancePhoto(
        id,
        { uri: entry.uri, fileName: entry.fileName },
        (fraction) => {
          // Stale-attempt guard: a Retry starts a NEWER attempt for this same
          // key, and this one's late progress/result must never overwrite it
          // — neither by claiming success for bytes that failed nor by
          // re-failing a row a retry already saved.
          if (guard.isCurrent(entry.key, token)) patchRequestPhoto(entry.key, { progress: fraction });
        },
        requestPhotoUploadOptions(),
      );
      if (!guard.isCurrent(entry.key, token)) return;
      // attachmentId comes from finalize's own return value — it is what
      // reconcile matches against the server list, so this row retires
      // exactly when the grid can show it.
      patchRequestPhoto(entry.key, {
        status: 'done',
        progress: 1,
        message: undefined,
        attachmentId,
      });
    } catch (e) {
      if (!guard.isCurrent(entry.key, token)) return;
      patchRequestPhoto(entry.key, { status: 'error', progress: 0, message: photoUploadErrorMessage(e) });
      return;
    }
    // OUTSIDE the try on purpose. The upload is already settled 'done' above;
    // if the follow-up read were inside it, a refresh failure would fall into
    // that catch and re-mark a photo the server ACCEPTED as failed — telling
    // someone to retry bytes that are already stored, and inviting a
    // duplicate. refreshRequestPhotos owns its own failure (a notice that
    // says the list is stale, not that the upload failed).
    await refreshRequestPhotos();
  }

  async function addRequestPhotos(assets: { uri: string; fileName?: string }[]) {
    if (assets.length === 0) return;
    // Counts against the REQUESTER photos only: the server budgets
    // MAINTENANCE_MAX_PHOTOS per kind (maintenance-attachments.ts —
    // "applies PER KIND"), so proof photos must not eat this card's slots.
    const cap = requestPhotoCapCheck({
      serverPhotoCount: splitPhotosByKind(photos).requester.length,
      entries: requestPhotoQueue,
      incoming: assets.length,
    });
    if (!cap.ok) {
      Alert.alert('Too many photos', cap.message);
      return;
    }
    const entries: MaintenancePhotoQueueEntry[] = assets.map((a) => ({
      key: localPhotoKey(),
      uri: a.uri,
      fileName: a.fileName,
      status: 'uploading',
      progress: 0,
    }));
    setRequestPhotoQueue((prev) => [...prev, ...entries]);
    for (const entry of entries) {
      await runRequestPhotoUpload(entry);
    }
  }

  function retryRequestPhoto(key: string) {
    const entry = requestPhotoQueue.find((e) => e.key === key);
    if (!entry) return;
    const next: MaintenancePhotoQueueEntry = {
      ...entry,
      status: 'uploading',
      progress: 0,
      message: undefined,
    };
    patchRequestPhoto(key, { status: 'uploading', progress: 0, message: undefined });
    void runRequestPhotoUpload(next);
  }

  // ── CLOSE-OUT: Resolve (Task 10) ──────────────────────────────────────
  function patchResolvePhoto(key: string, patch: Partial<MaintenancePhotoQueueEntry>) {
    setResolvePhotos((prev) => prev.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  }

  async function runResolvePhotoUpload(entry: MaintenancePhotoQueueEntry) {
    if (!id) return;
    const guard = resolveGuard;
    const token = guard.start(entry.key);
    try {
      // kind: 'resolution' — the ONE thing that distinguishes this call
      // from app/maintenance/new.tsx's requester-photo upload. Everything
      // else (resize, mint, PUT, finalize, progress/retry) is the SAME
      // tested orchestration from maintenance-upload.ts.
      await uploadMaintenancePhoto(
        id,
        { uri: entry.uri, fileName: entry.fileName },
        (fraction) => {
          if (guard.isCurrent(entry.key, token)) patchResolvePhoto(entry.key, { progress: fraction });
        },
        resolutionPhotoUploadOptions(),
      );
      if (guard.isCurrent(entry.key, token)) {
        patchResolvePhoto(entry.key, { status: 'done', progress: 1, message: undefined });
      }
    } catch (e) {
      if (!guard.isCurrent(entry.key, token)) return;
      patchResolvePhoto(entry.key, { status: 'error', progress: 0, message: photoUploadErrorMessage(e) });
    }
  }

  async function addResolvePhotos(assets: { uri: string; fileName?: string }[]) {
    if (assets.length === 0) return;
    // Cap counts against BOTH the already-attached resolution photos
    // (server truth — `photos` state, split by kind) and this in-progress
    // queue, matching new.tsx's identical existing+pending+incoming
    // arithmetic.
    const existing =
      splitPhotosByKind(photos).resolution.length +
      resolvePhotos.filter((e) => e.status === 'done').length;
    const pending = resolvePhotos.filter((e) => e.status === 'uploading').length;
    const cap = checkPhotoCap({ existing, pending, incoming: assets.length });
    if (!cap.ok) {
      Alert.alert('Too many photos', cap.message);
      return;
    }
    const entries: MaintenancePhotoQueueEntry[] = assets.map((a) => ({
      key: localPhotoKey(),
      uri: a.uri,
      fileName: a.fileName,
      status: 'uploading',
      progress: 0,
    }));
    setResolvePhotos((prev) => [...prev, ...entries]);
    for (const entry of entries) {
      await runResolvePhotoUpload(entry);
    }
  }

  function retryResolvePhoto(key: string) {
    const entry = resolvePhotos.find((e) => e.key === key);
    if (!entry) return;
    const next: MaintenancePhotoQueueEntry = {
      ...entry,
      status: 'uploading',
      progress: 0,
      message: undefined,
    };
    patchResolvePhoto(key, { status: 'uploading', progress: 0, message: undefined });
    void runResolvePhotoUpload(next);
  }

  async function doResolve() {
    if (!id || !canConfirmResolve(resolveNote) || resolvePending) return;
    setResolvePending(true);
    setResolveError(null);
    try {
      await resolveMaintenanceRequest(id, resolveNote.trim());
      // Success: collapse the section, clear input, and reload the detail
      // — the RESOLUTION card + pill status this feeds are computed from
      // `detail`, never patched locally.
      setResolveOpen(false);
      setResolveNote('');
      setResolvePhotos([]);
      refreshDetail();
    } catch (e) {
      // Stays open on error, input AND staged photos preserved — mirrors
      // web's ResolveRequestDialog (never lose a typed note or uploaded
      // proof photos to a transient failure).
      setResolveError(mapActionError(e, RESOLVE_GENERIC_ERROR));
    } finally {
      setResolvePending(false);
    }
  }

  // ── CLOSE-OUT: Archive ────────────────────────────────────────────────
  async function doArchive() {
    if (!id || archivePending) return;
    setArchivePending(true);
    try {
      await archiveMaintenanceRequest(id);
      refreshDetail();
    } catch (e) {
      Alert.alert(ARCHIVE_BUTTON_LABEL, mapActionError(e, ARCHIVE_GENERIC_ERROR));
    } finally {
      setArchivePending(false);
    }
  }

  function confirmArchive() {
    Alert.alert(ARCHIVE_CONFIRM_TITLE, ARCHIVE_CONFIRM_MESSAGE, [
      { text: ARCHIVE_CANCEL_LABEL, style: 'cancel' },
      { text: ARCHIVE_BUTTON_LABEL, style: 'destructive', onPress: () => void doArchive() },
    ]);
  }

  // ── CLOSE-OUT: Assign owner + Internal notes share ONE member roster ──
  async function ensureMembersLoaded() {
    if (members !== null || membersLoading) return;
    setMembersLoading(true);
    setMembersError(null);
    try {
      const rows = await listMaintenanceMembers();
      setMembers(rows);
    } catch (e) {
      setMembersError(mapActionError(e, MEMBERS_LOAD_ERROR));
    } finally {
      setMembersLoading(false);
    }
  }

  function toggleAssignOpen() {
    const next = !assignOpen;
    setAssignOpen(next);
    if (next) void ensureMembersLoaded();
  }

  async function doAssign(userId: string | null) {
    if (!id || assignPending) return;
    setAssignPending(true);
    setMembersError(null);
    try {
      await assignMaintenanceOwner(id, userId);
      refreshDetail();
    } catch (e) {
      setMembersError(mapActionError(e, ASSIGN_OWNER_GENERIC_ERROR));
    } finally {
      setAssignPending(false);
    }
  }

  // ── CLOSE-OUT: Internal notes ──────────────────────────────────────────
  async function loadNotes() {
    if (!id) return;
    setNotesLoading(true);
    setNotesError(null);
    try {
      const rows = await listMaintenanceNotes(id);
      setNotes(rows);
    } catch (e) {
      setNotesError(mapActionError(e, NOTES_LOAD_ERROR));
    } finally {
      setNotesLoading(false);
    }
  }

  function toggleNotesOpen() {
    const next = !notesOpen;
    setNotesOpen(next);
    if (next) {
      void ensureMembersLoaded(); // author-name resolution, same roster
      void loadNotes();
    }
  }

  async function doAddNote() {
    const text = noteBody.trim();
    if (!id || !text || notePending) return;
    setNotePending(true);
    setNotesError(null);
    try {
      await addMaintenanceNote(id, text);
      setNoteBody('');
      // Refetch rather than optimistically fabricate a row — the server
      // owns createdAt/authorUserId and this is the one path guaranteed to
      // match what listNotes() will show on the NEXT load anyway.
      await loadNotes();
    } catch (e) {
      setNotesError(mapActionError(e, NOTES_ADD_GENERIC_ERROR));
    } finally {
      setNotePending(false);
    }
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/maintenance' as Href);
  };

  if (!enabled) {
    return (
      <GateScreen c={c} onBack={goBack}>
        Maintenance requests aren’t enabled for this workspace. Ask an admin to enable it in
        Settings → Modules.
      </GateScreen>
    );
  }

  if (loading) {
    return (
      <View style={[styles.root, { backgroundColor: c.paper }]}>
        <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
          <View style={styles.topbar}>
            <IconChip icon={ArrowLeft} onPress={goBack} />
          </View>
        </SafeAreaView>
        <ActivityIndicator color={c.ink4} style={{ marginTop: 40 }} />
      </View>
    );
  }

  if (loadError || !detail || !prepared) {
    return (
      <GateScreen c={c} onBack={goBack}>
        {loadError ?? "Couldn't load this request."}
      </GateScreen>
    );
  }

  const handle = formatMaintenanceRequestNumber(detail.requestNumber, detail.createdAt) ?? `#${detail.requestNumber}`;
  const pillStatus = statusPillTone(detail.status);
  const showCondensedNotice = shouldShowCondensedNotice(prepared);
  const showResolutionCard = shouldShowResolutionCard(detail);
  const { requester: requesterPhotos, resolution: resolutionPhotos } = splitPhotosByKind(photos);

  // Request-photo card. The add affordance follows web's gate and ONLY web's
  // gate — closed (archived/cancelled/resolved) hides it, nothing else. No
  // client-side role check is invented here: the real boundary is the
  // server's (submit + requester-owned-or-manage, re-enforced at mint AND
  // finalize), and a refusal surfaces as the server's own message on the
  // failed row rather than as a button that was never shown.
  const photosEditability = requestPhotosEditability({
    archivedAt: detail.archivedAt,
    cancelledAt: detail.cancelledAt,
    resolvedAt: detail.resolvedAt,
  });
  const photosEmptyCopy = requestPhotosEmptyCopy({
    photoCount: requesterPhotos.length,
    queued: requestPhotoQueue.length,
    canAdd: photosEditability.canAdd,
  });

  // Task 10 — CLOSE-OUT action visibility. `isOwnRequest` mirrors web
  // page.tsx's `isOwningRequester = detail.requesterUserId === ctx.userId`;
  // `actions.cancelNote` is computed but unused (see availableCloseoutActions'
  // own doc comment — no mobile Cancel UI exists yet).
  const isOwnRequest = Boolean(user?.id && detail.requesterUserId === user.id);
  const actions = availableCloseoutActions({
    canManage,
    isOwnRequest,
    archivedAt: detail.archivedAt,
    cancelledAt: detail.cancelledAt,
    resolvedAt: detail.resolvedAt,
  });
  const showCloseout = actions.resolve || actions.archive || actions.assignOwner || actions.notes;

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={goBack} />
        </View>
        <View style={styles.head}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Wrench size={16} color={c.ink3} strokeWidth={1.5} />
            <Eyebrow>{handle}</Eyebrow>
          </View>
          <Display size={26} style={{ marginTop: 8 }}>
            {detail.subject}
          </Display>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <Pill status={pillStatus} dot={false}>
              {MAINTENANCE_STATUS_LABELS[detail.status]}
            </Pill>
            <Pill status="default" dot={false}>
              {detail.priority}
            </Pill>
          </View>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Card padding={16}>
          <Eyebrow>DESCRIPTION</Eyebrow>
          <Body size={14} color={c.ink} style={{ marginTop: 8 }}>
            {detail.description}
          </Body>
        </Card>

        {showResolutionCard ? (
          <Card padding={16} style={{ marginTop: 14 }}>
            <Eyebrow>RESOLUTION</Eyebrow>
            <Body size={14} color={c.ink} style={{ marginTop: 8 }}>
              {detail.resolutionNote}
            </Body>
            <Body size={12.5} muted style={{ marginTop: 8 }}>
              {`Marked resolved by ${detail.resolvedByName} · ${
                detail.resolvedAt ? formatRelativeTime(detail.resolvedAt) : ''
              }`}
            </Body>
          </Card>
        ) : null}

        <Card padding={0} style={{ marginTop: 14 }}>
          <DetailRow label="REQUESTER" value={detail.requesterName} />
          <Hair inset={16} />
          <DetailRow label="SITE" value={detail.siteName} />
          <Hair inset={16} />
          <DetailRow label="BUILDING" value={detail.building} />
          <Hair inset={16} />
          <DetailRow label="ROOM OR AREA" value={detail.roomOrArea} />
          <Hair inset={16} />
          <DetailRow label="DEPARTMENT" value={detail.department} />
          <Hair inset={16} />
          <DetailRow label="CATEGORY" value={detail.category} />
          <Hair inset={16} />
          <DetailRow label="ACCESS INSTRUCTIONS" value={detail.accessInstructions} />
        </Card>

        {/* Request photos. Renders ALWAYS — web's own section does (page.tsx),
            and an add affordance that appears only once a photo exists could
            never be used to add the first one. This card IS the fix: before
            it, a phone could attach photos only inside new.tsx's post-create
            step, which nothing routed back to. */}
        <Card padding={16} style={{ marginTop: 14 }}>
          <Eyebrow>{requestPhotosHeading(requesterPhotos.length)}</Eyebrow>

          {requesterPhotos.length > 0 ? (
            <View style={styles.photoGrid}>
              {requesterPhotos.map((p) => (
                // Plain expo-image, no cacheKey/signing helper: these URLs
                // arrive already-signed from the server every load (Task 8's
                // MaintenanceAttachmentsService.signedViewUrls), and
                // image-cache.ts's signItemImage/CachedImage are hardcoded to
                // the UNRELATED item-images bucket — routing through them
                // would sign against the wrong bucket entirely.
                <Image
                  key={p.id}
                  source={{ uri: p.thumbUrl ?? p.url }}
                  style={styles.photoThumb}
                  contentFit="cover"
                />
              ))}
            </View>
          ) : null}

          {photosEmptyCopy ? (
            <Body size={12.5} muted style={{ marginTop: 10 }}>
              {photosEmptyCopy}
            </Body>
          ) : null}

          {photosEditability.canAdd ? (
            <>
              <Mono size={11} tracking={0.04} upper color={c.ink4} style={{ marginTop: 14 }}>
                {REQUEST_PHOTOS_ADD_LABEL}
              </Mono>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
                <PhotoSourceButton
                  icon={Camera}
                  label="CAMERA"
                  accessibilityLabel="Take a photo for this request"
                  onPress={() => void pickFromCamera().then(addRequestPhotos)}
                />
                <PhotoSourceButton
                  icon={ImageIcon}
                  label="LIBRARY"
                  accessibilityLabel="Choose a photo from your library for this request"
                  onPress={() => void pickFromLibrary().then(addRequestPhotos)}
                />
              </View>
            </>
          ) : null}

          {requestPhotoQueue.map((entry) => (
            <PhotoQueueRow
              key={entry.key}
              entry={entry}
              onRetry={() => retryRequestPhoto(entry.key)}
            />
          ))}

          {/* Upload succeeded, list did not refresh. Says exactly that — the
              finished row above stays put, so the photo is accounted for. */}
          {photosRefreshError ? (
            <Body size={12.5} color={ACCENT.crit} style={{ marginTop: 10 }}>
              {photosRefreshError}
            </Body>
          ) : null}

          {photosEditability.closedNotice ? (
            <Body size={11.5} muted style={{ marginTop: 10 }}>
              {photosEditability.closedNotice}
            </Body>
          ) : null}
        </Card>

        {resolutionPhotos.length > 0 ? (
          <Card padding={16} style={{ marginTop: 14 }}>
            {/* Labeled distinctly from the requester PHOTOS card above
                (Task 9's split — mirrors web's page.tsx "Resolution proof"
                section). Visibility is gated on resolutionPhotos.length
                alone, NOT on showResolutionCard/detail.resolvedAt — a
                manager can stage proof photos before ever confirming the
                Resolve dialog (Task 10), and hiding those rows here would
                be worse than showing them; the claim of resolution itself
                stays confined to the RESOLUTION card above, which IS gated
                on resolvedAt. */}
            <Eyebrow>{`RESOLUTION PROOF · ${resolutionPhotos.length}`}</Eyebrow>
            <View style={styles.photoGrid}>
              {resolutionPhotos.map((p) => (
                <Image
                  key={p.id}
                  source={{ uri: p.thumbUrl ?? p.url }}
                  style={styles.photoThumb}
                  contentFit="cover"
                />
              ))}
            </View>
            <Body size={12.5} muted style={{ marginTop: 8 }}>
              {resolutionProofCaption(detail.resolvedAt)}
            </Body>
          </Card>
        ) : null}

        <Card padding={16} style={{ marginTop: 14 }}>
          <Eyebrow>EMAIL</Eyebrow>
          <View style={{ marginTop: 10, gap: 4 }}>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Mono size={11} tracking={0.04} upper color={c.ink4}>
                To
              </Mono>
              <Body size={13} color={c.ink}>
                {prepared.draft.to}
              </Body>
            </View>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Mono size={11} tracking={0.04} upper color={c.ink4}>
                CC
              </Mono>
              <Body size={13} color={c.ink}>
                {prepared.draft.cc}
              </Body>
            </View>
          </View>
          <Body size={12.5} muted style={{ marginTop: 8 }}>
            {MAINTENANCE_CC_NOTICE}
          </Body>

          {showCondensedNotice ? (
            <Card padding={10} style={{ marginTop: 12 }}>
              <Body size={12.5} muted>
                {CONDENSED_NOTICE}
              </Body>
            </Card>
          ) : null}

          {!prepared.linkFits ? (
            <Card padding={10} style={{ marginTop: 12 }}>
              <Body size={12.5} muted>
                {OVERSIZED_MESSAGE}
              </Body>
            </Card>
          ) : null}

          <View style={{ marginTop: 14, gap: 10 }}>
            {prepared.linkFits ? (
              <Button
                block
                onPress={() => handleOpenPress('outlook')}
                disabled={busy}
                leading={<Mail size={16} color={c.paper} strokeWidth={1.5} />}
              >
                Open in Outlook
              </Button>
            ) : null}
            {prepared.linkFits ? (
              <Button
                block
                variant="outline"
                onPress={() => handleOpenPress('mailto')}
                disabled={busy}
                leading={<MailOpen size={16} color={c.ink} strokeWidth={1.5} />}
              >
                Open in Default Email App
              </Button>
            ) : null}
            <Button
              block
              variant="outline"
              onPress={() => setCopyOpen((v) => !v)}
              leading={<Copy size={16} color={c.ink} strokeWidth={1.5} />}
            >
              Copy Email Details
            </Button>
            {photos.length > 0 ? (
              <Button
                block
                variant="outline"
                disabled={sharePending}
                onPress={() => void generateShareLink()}
                leading={<Images size={16} color={c.ink} strokeWidth={1.5} />}
              >
                {shareLink || generatedShareUrl
                  ? 'Generate new photo share link'
                  : 'Generate photo share link'}
              </Button>
            ) : null}
            {generatedShareUrl ? (
              <Button
                block
                variant="outline"
                onPress={openPhotosPage}
                leading={<Images size={16} color={c.ink} strokeWidth={1.5} />}
              >
                View photos page
              </Button>
            ) : null}
          </View>

          {generatedShareUrl ? (
            <View style={{ marginTop: 12 }}>
              <Body size={12.5} color={c.ink}>
                {SHARE_LINK_SHOW_ONCE_NOTICE}
              </Body>
              {/* Same no-clipboard-module posture as the copy box above
                  (audit Q9): the selectable, read-only input IS the copy
                  affordance. Generated URLs also fold into the email drafts
                  automatically (withShareUrl above). */}
              <TextInput
                editable={false}
                selectTextOnFocus
                value={generatedShareUrl}
                style={[styles.copyBox, { color: c.ink, borderColor: c.hair, minHeight: 44, marginTop: 6 }]}
                accessibilityLabel="Photo share link to copy manually"
              />
              <Body size={11.5} muted style={{ marginTop: 6 }}>
                {COPY_HELPER_TEXT}
              </Body>
            </View>
          ) : shareLink ? (
            <Body size={11.5} muted style={{ marginTop: 10 }}>
              {SHARE_LINK_EXISTS_NOTICE}
            </Body>
          ) : null}

          {lastResult?.outcome === 'opened' ? (
            <Card padding={10} style={{ marginTop: 12 }}>
              <Body size={12.5} color={c.ink}>
                {successMessageFor(lastResult.used)}
              </Body>
            </Card>
          ) : null}
          {lastResult?.outcome === 'blocked' ? (
            <Card padding={10} style={{ marginTop: 12 }}>
              <Body size={12.5} color={c.ink}>
                {BLOCKED_HEADLINE}
              </Body>
              <Body size={12.5} muted style={{ marginTop: 4 }}>
                {BLOCKED_RETRY_MESSAGE}
              </Body>
            </Card>
          ) : null}

          {copyOpen ? (
            <View style={{ marginTop: 12 }}>
              {/* No clipboard module exists in the 1.1.0 binary (audit Q9) —
                  this selectable, read-only textarea IS the copy affordance,
                  not a fallback for a failed programmatic copy attempt. */}
              <TextInput
                multiline
                editable={false}
                selectTextOnFocus
                value={prepared.clipboardText}
                style={[styles.copyBox, { color: c.ink, borderColor: c.hair }]}
                accessibilityLabel="Maintenance request text to copy manually"
              />
              <Body size={11.5} muted style={{ marginTop: 6 }}>
                {COPY_HELPER_TEXT}
              </Body>
            </View>
          ) : null}
        </Card>

        {showCloseout ? (
          <Card padding={16} style={{ marginTop: 14 }}>
            <Eyebrow>CLOSE-OUT</Eyebrow>

            {actions.resolve ? (
              <View style={{ marginTop: 12 }}>
                <Button
                  block
                  variant="outline"
                  onPress={() => setResolveOpen((v) => !v)}
                  leading={<CheckCircle2 size={16} color={c.ink} strokeWidth={1.5} />}
                >
                  {RESOLVE_TOGGLE_LABEL}
                </Button>
                {resolveOpen ? (
                  <View style={{ marginTop: 12, gap: 10 }}>
                    <Body size={12.5} muted>
                      {MOBILE_RESOLVE_DISCLOSURE}
                    </Body>
                    <TextInput
                      multiline
                      numberOfLines={4}
                      value={resolveNote}
                      onChangeText={setResolveNote}
                      maxLength={MAINTENANCE_RESOLUTION_NOTE_MAX}
                      placeholder={RESOLVE_NOTE_PLACEHOLDER}
                      placeholderTextColor={c.ink4}
                      editable={!resolvePending}
                      style={[styles.textarea, { color: c.ink, borderColor: c.hair }]}
                    />
                    <Body size={11} muted>
                      {resolveNoteHelperText()}
                    </Body>

                    <Mono size={11} tracking={0.04} upper color={c.ink4}>
                      {RESOLVE_ADD_PHOTO_LABEL}
                    </Mono>
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                      <PhotoSourceButton
                        icon={Camera}
                        label="CAMERA"
                        accessibilityLabel="Take a proof photo"
                        onPress={() => void pickFromCamera().then(addResolvePhotos)}
                      />
                      <PhotoSourceButton
                        icon={ImageIcon}
                        label="LIBRARY"
                        accessibilityLabel="Choose a proof photo from your library"
                        onPress={() => void pickFromLibrary().then(addResolvePhotos)}
                      />
                    </View>

                    {resolvePhotos.map((entry) => (
                      <PhotoQueueRow
                        key={entry.key}
                        entry={entry}
                        onRetry={() => retryResolvePhoto(entry.key)}
                      />
                    ))}

                    {resolveError ? (
                      <Body size={13} color={ACCENT.crit}>
                        {resolveError}
                      </Body>
                    ) : null}

                    <Button
                      block
                      disabled={!canConfirmResolve(resolveNote) || resolvePending}
                      onPress={() => void doResolve()}
                    >
                      {resolvePending ? RESOLVE_PENDING_LABEL : RESOLVE_CONFIRM_LABEL}
                    </Button>
                  </View>
                ) : null}
              </View>
            ) : null}

            {actions.archive ? (
              <Button
                block
                variant="outline"
                style={{ marginTop: 12 }}
                disabled={archivePending}
                onPress={confirmArchive}
                leading={<Trash2 size={16} color={ACCENT.crit} strokeWidth={1.5} />}
              >
                {ARCHIVE_BUTTON_LABEL}
              </Button>
            ) : null}

            {actions.assignOwner ? (
              <View style={{ marginTop: 12 }}>
                <Button
                  block
                  variant="outline"
                  onPress={toggleAssignOpen}
                  leading={<Users size={16} color={c.ink} strokeWidth={1.5} />}
                >
                  {ASSIGN_OWNER_TOGGLE_LABEL}
                </Button>
                {assignOpen ? (
                  <View style={{ marginTop: 12, gap: 8 }}>
                    <Mono size={11} tracking={0.04} upper color={c.ink4}>
                      {ASSIGN_OWNER_SECTION_LABEL}
                    </Mono>
                    <Body size={11.5} muted>
                      {ASSIGN_OWNER_HELPER}
                    </Body>
                    {membersLoading ? <ActivityIndicator color={c.ink4} /> : null}
                    {membersError ? (
                      <Body size={13} color={ACCENT.crit}>
                        {membersError}
                      </Body>
                    ) : null}
                    <Pressable
                      onPress={() => void doAssign(null)}
                      disabled={assignPending}
                      style={styles.pickerRow}
                    >
                      <Body size={14} color={c.ink}>
                        {ASSIGN_OWNER_UNASSIGNED_LABEL}
                      </Body>
                      {!detail.localOwnerUserId ? (
                        <Check size={16} color={c.ink} strokeWidth={2} />
                      ) : null}
                    </Pressable>
                    {(members ?? []).map((member) => (
                      <Pressable
                        key={member.userId}
                        onPress={() => void doAssign(member.userId)}
                        disabled={assignPending}
                        style={styles.pickerRow}
                      >
                        <Body size={14} color={c.ink}>
                          {member.name}
                        </Body>
                        {detail.localOwnerUserId === member.userId ? (
                          <Check size={16} color={c.ink} strokeWidth={2} />
                        ) : null}
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}

            {actions.notes ? (
              <View style={{ marginTop: 12 }}>
                <Button
                  block
                  variant="outline"
                  onPress={toggleNotesOpen}
                  leading={<ClipboardList size={16} color={c.ink} strokeWidth={1.5} />}
                >
                  {NOTES_TOGGLE_LABEL}
                </Button>
                {notesOpen ? (
                  <View style={{ marginTop: 12, gap: 8 }}>
                    <Mono size={11} tracking={0.04} upper color={c.ink4}>
                      {NOTES_SECTION_LABEL}
                    </Mono>
                    <Body size={11.5} muted>
                      {NOTES_HELPER}
                    </Body>
                    {notesLoading ? <ActivityIndicator color={c.ink4} /> : null}
                    {notesError ? (
                      <Body size={13} color={ACCENT.crit}>
                        {notesError}
                      </Body>
                    ) : null}
                    {notes && notes.length === 0 ? (
                      <Body size={13} muted>
                        {NOTES_EMPTY}
                      </Body>
                    ) : null}
                    {(notes ?? []).map((n) => (
                      <Card key={n.id} padding={10}>
                        <Body size={13} color={c.ink}>
                          {n.body}
                        </Body>
                        <Body size={11} muted style={{ marginTop: 4 }}>
                          {`${resolveNoteAuthorName(n.authorUserId, members ?? [])} · ${formatRelativeTime(n.createdAt)}`}
                        </Body>
                      </Card>
                    ))}
                    {notes && notes.length >= 500 ? (
                      <Body size={11} muted>
                        {NOTES_TRUNCATED}
                      </Body>
                    ) : null}
                    <TextInput
                      multiline
                      numberOfLines={3}
                      value={noteBody}
                      onChangeText={setNoteBody}
                      maxLength={4000}
                      placeholder={NOTES_PLACEHOLDER}
                      placeholderTextColor={c.ink4}
                      editable={!notePending}
                      style={[styles.textarea, { color: c.ink, borderColor: c.hair }]}
                    />
                    <Button
                      block
                      disabled={!noteBody.trim() || notePending}
                      onPress={() => void doAddNote()}
                    >
                      {notePending ? NOTES_ADD_PENDING_LABEL : NOTES_ADD_LABEL}
                    </Button>
                  </View>
                ) : null}
              </View>
            ) : null}
          </Card>
        ) : null}

        <Body muted size={11.5} style={{ marginTop: 16, textAlign: 'center' }}>
          {SECTION_23_NOTE}
        </Body>
      </ScrollView>
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
  body: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 32,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  photoThumb: {
    width: 72,
    height: 72,
    borderRadius: 10,
    backgroundColor: '#e5e5e5',
  },
  copyBox: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 12.5,
    fontFamily: FONT.mono,
    minHeight: 140,
    textAlignVertical: 'top',
  },
  textarea: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13.5,
    minHeight: 90,
    textAlignVertical: 'top',
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  addPhotoBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  resolvePhotoThumb: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: '#e5e5e5',
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    marginTop: 6,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    borderRadius: 2,
  },
});

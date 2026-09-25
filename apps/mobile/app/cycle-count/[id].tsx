import * as Network from 'expo-network';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  COUNT_LINKED_EXCEPTIONS_UNAVAILABLE_COPY,
  CYCLE_COUNT_REFERENCE_UNAVAILABLE,
  cycleCountScopeLabel,
  exceptionUnrecognizedCopy,
  formatCycleCountNumber,
  offlineCaptureAt,
  offlineCaptureLabel,
  variantLabel,
} from '@stockpilot/core';

import { CycleCountReassignSheet } from '@/components/cycle-count-reassign-sheet';
import { CycleCountReleaseSheet } from '@/components/cycle-count-release-sheet';
import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { useAuth } from '@/lib/auth-context';
import {
  countFooter,
  fetchCountCloseGate,
  rememberedCloseGate,
  type CloseGateState,
} from '@/lib/count-close-gate';
import { showWriteCta } from '@/lib/cta-gating';
import { footerReservation } from '@/lib/dynamic-type-layout';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import {
  cacheCycleCount,
  getCycleCount,
  pendingCountFor,
  updateLocalLine,
  type CachedCycleCountHeader,
  type CachedCycleCountLine,
} from '@/lib/cycle-count-cache';
import { fetchAllCycleCountLines } from '@/lib/cycle-count-lines-fetch';
import { postCycleCountErrorMessage } from '@/lib/cycle-count-post-errors';
import { cycleCountSync, useSyncStatus } from '@/lib/cycle-count-sync';
import { postCycleCount } from '@/lib/cycle-counts-api';
import {
  getCountLinkedExceptions,
  linkedLineDestination,
  type MobileCountLinkedExceptions,
} from '@/lib/exceptions-api';
import { createDraftDebouncer } from '@/lib/draft-debouncer';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/lib/use-org';
import { TYPE_CEILING, capTo, radius, space, theme } from '@/lib/theme';

/** The joined item columns the variant label is built from. */
interface VariantItemRow {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  variant_size: string | null;
  jersey_number: string | null;
}

interface UiLine {
  id: string;
  itemId: string;
  itemName: string;
  itemSku: string;
  itemBarcode: string | null;
  /** "Size 10", "#12 · Size XL" — WHICH VARIANT this line is. Null for a
   *  non-sports item, where nothing extra renders. */
  itemVariantLabel: string | null;
  expected: number;
  counted: number | null;
  localDirty: boolean;
  /** When the server's count was physically taken, for a count synced from
   *  an offline phone (server 0369): measured against the book at that
   *  moment, so whoever posts sees when (owner default D7). */
  offlineCapturedAt: string | null;
}

const SAVE_DEBOUNCE_MS = 300;

export default function CycleCountDetail() {
  const router = useRouter();
  // A cold-start link (a notification tap with the app closed) opens this
  // screen with no history under it, and going back is then a no-op that
  // leaves the person stuck here. Fall back to the cycle-count list.
  const leave = React.useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/cycle-counts');
  }, [router]);
  // Counting + posting are WRITES (stock:adjust). A cycle_counts:read-only
  // viewer gets a read-only view: inputs frozen, no post footer — mirroring
  // the web detail's canAdjust=false mode. The API enforces server-side;
  // while permissions load, entry stays enabled.
  const perms = useEffectivePermissions();
  const canWrite = showWriteCta(perms, 'stock:adjust');
  // Manager+ proxy: only manager/admin/owner hold cycle_counts:assign, and the
  // server 0282 lock lets managers override the assignee. Used below.
  const canManage = showWriteCta(perms, 'cycle_counts:assign');
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const syncSnapshot = useSyncStatus();

  const { orgId } = useOrg();
  // The organization's timezone for the "Counted offline <time>" label, so
  // the phone and the web review name the same moment. Fail-soft: without it
  // (offline, a refused read) the device's own zone is used.
  const [orgTimeZone, setOrgTimeZone] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await supabase
          .from('organizations')
          .select('timezone')
          .eq('id', orgId)
          .maybeSingle();
        const tz = (data as { timezone?: unknown } | null)?.timezone;
        if (!cancelled && typeof tz === 'string' && tz) setOrgTimeZone(tz);
      } catch {
        // The label falls back to the device zone.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);
  const [header, setHeader] = React.useState<CachedCycleCountHeader | null>(null);
  const [lines, setLines] = React.useState<UiLine[]>([]);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(true);

  // Assignee lock (mirrors the server 0282 RLS + service guard): a count
  // assigned to another employee is READ-ONLY here for a non-manager —
  // inputs frozen and the Scan / AI Scan entry points hidden — so the count
  // screen matches what the server will actually allow. Unassigned counts
  // stay open (parity with the RLS `assigned_to IS NULL` predicate). Managers
  // override. Header not loaded yet → treat as writable so first paint isn't
  // wrongly frozen; the write itself is still server-enforced.
  const isAssignee = !header?.assignedTo || header.assignedTo === user?.id;
  const canAdjust = canWrite && (isAssignee || canManage);
  const [releaseOpen, setReleaseOpen] = React.useState(false);
  const [reassignOpen, setReassignOpen] = React.useState(false);
  const [posting, setPosting] = React.useState(false);
  // Measured height of the pinned post footer — its label wraps to three lines
  // at accessibility text sizes, so the list's bottom reservation follows it.
  const [footerHeight, setFooterHeight] = React.useState<number | null>(null);
  const [pendingForThis, setPendingForThis] = React.useState(0);
  const [emptyState, setEmptyState] = React.useState<
    'none' | 'offline-uncached' | 'read-failed'
  >('none');
  /** The server's own message for a refused read, shown instead of an empty
   *  count. Only ever set when there is no cached snapshot to fall back to. */
  const [readError, setReadError] = React.useState<string | null>(null);
  // The count's scope ('warehouse' | 'selection'), from the online read only:
  // the offline cache does not store it, so offline the subtitle falls back
  // to what the cache knows.
  const [scope, setScope] = React.useState<string | null>(null);
  const [conflictBanner, setConflictBanner] = React.useState<string | null>(null);

  // WHO MAY POST (F1-2). Staff count; managers post (ledger.post_cycle_count
  // is manager-only). The Post footer follows core cycleCountCloseGate, fed
  // the role and effective permissions from /api/v1/me/permissions, read
  // when the screen opens online and remembered for this session. Never
  // guessed: before an answer the footer says so.
  const userId = user?.id ?? null;
  const [closeGate, setCloseGate] = React.useState<CloseGateState>(() => {
    const known = rememberedCloseGate(userId, orgId);
    return known ? { kind: 'known', gate: known } : { kind: 'loading' };
  });
  const [closeGateNonce, setCloseGateNonce] = React.useState(0);

  // THE EXCEPTIONS A RECOUNT LINKED TO THIS COUNT (F1-2): a chip on each
  // linked line and, while the phone's line matches what the server read,
  // where its difference lands when posted. Online only; a failed read says
  // so, never "none".
  const [linked, setLinked] = React.useState<
    { kind: 'none' } | { kind: 'ready'; data: MobileCountLinkedExceptions } | { kind: 'failed' }
  >({ kind: 'none' });
  // The server's counted_location_id per line, from the online read (the
  // phone's cache does not keep it): the destination is shown only while it
  // matches the one the linked answer was worked out from.
  const [serverLocations, setServerLocations] = React.useState<ReadonlyMap<string, string | null>>(
    () => new Map(),
  );

  // Debounced local saves (updateLocalLine + the outbox row), FLUSHED on
  // unmount: a count typed within SAVE_DEBOUNCE_MS of leaving the screen used
  // to be dropped (see draft-debouncer.ts). Created once; the save touches
  // only stable state setters and module functions.
  const [lineSaver] = React.useState(() =>
    createDraftDebouncer(SAVE_DEBOUNCE_MS, (lineId, raw) => {
      void (async () => {
        if (raw.trim() === '') return; // empty input — don't persist a clear here
        const num = Number.parseFloat(raw);
        if (!Number.isFinite(num) || num < 0) return;

        await updateLocalLine(lineId, num);
        setLines((curr) =>
          curr.map((l) =>
            // A new local count replaces the server's, so its capture time
            // no longer describes this line.
            l.id === lineId ? { ...l, counted: num, localDirty: true, offlineCapturedAt: null } : l,
          ),
        );
        setDraft((d) => {
          const { [lineId]: _drop, ...rest } = d;
          return rest;
        });

        await cycleCountSync.refreshPendingCount();
        void cycleCountSync.forceSync();
      })();
    }),
  );

  // Resolve the user's org once — needed to scope server fetches.

  function hydrateFromSnapshot(snap: { header: CachedCycleCountHeader; lines: CachedCycleCountLine[] }) {
    setHeader(snap.header);
    const ui: UiLine[] = snap.lines
      .map((l) => ({
        id: l.id,
        itemId: l.itemId,
        itemName: l.itemName,
        itemSku: l.itemSku,
        itemBarcode: l.itemBarcode,
        itemVariantLabel: l.itemVariantLabel,
        expected: l.expected,
        counted: l.counted,
        localDirty: l.localDirty,
        offlineCapturedAt: l.offlineCapturedAt,
      }))
      .sort((a, b) => a.itemName.localeCompare(b.itemName));
    setLines(ui);
  }

  /**
   * Load order:
   *   1. Read SQLite cache → if hit, render immediately.
   *   2. If we're online, ALSO fetch fresh from Supabase and merge
   *      (server-wins for clean lines, local-wins for dirty).
   *   3. If cache missed AND offline → show empty state.
   */
  // NOTE: `loading` starts true and `emptyState`/`readError` start clean, so
  // load() needs no synchronous pre-await resets on mount; the retry buttons
  // reset those flags themselves before re-invoking load().
  const load = React.useCallback(async () => {
    if (!id) return;

    const cached = await getCycleCount(id);
    if (cached) {
      hydrateFromSnapshot(cached);
      setLoading(false);
    }

    let online = false;
    try {
      const ns = await Network.getNetworkStateAsync();
      online = Boolean(ns.isConnected && ns.isInternetReachable !== false);
    } catch {
      online = true;
    }

    if (!online) {
      if (!cached) {
        setEmptyState('offline-uncached');
        setLoading(false);
      }
      return;
    }
    if (!orgId) return;

    // Network fetch — populates / refreshes the cache.
    const [{ data: cc, error: ccErr }, { data: lineRows, error: lErr }] = await Promise.all([
      supabase
        .from('cycle_counts')
        .select(
          `id, count_number, organization_id, status, started_at, completed_at,
           warehouse_id, assigned_to, notes, scope,
           warehouse:warehouses!warehouse_id (name)`,
        )
        .eq('organization_id', orgId)
        .eq('id', id)
        .maybeSingle(),
      // Paged, NOT a bare select: PostgREST clamps one response to 1000 rows
      // (SP-032), so a >1000-line count used to arrive silently truncated —
      // the missing lines were uncountable and got cached that way.
      fetchAllCycleCountLines(supabase, id),
    ]);

    if (ccErr || lErr || !cc) {
      // Couldn't fetch — if we already have a cache hit, just show it (the
      // offline-first contract: cached data is real data, not a false claim).
      //
      // With NO cache this used to stop loading and render an empty count, so a
      // REFUSED read looked like a count with no lines. This read was widened by
      // the sports branch with 0298's `variant_size` / `jersey_number` on the
      // item embed, so a build running ahead of the database gets the whole
      // select refused — and a counter would have started tallying nothing.
      // Fail loud instead (release-order rule).
      if (!cached) {
        const message = (ccErr ?? lErr)?.message ?? null;
        setReadError(message);
        setEmptyState(message ? 'read-failed' : 'none');
        setLoading(false);
      }
      return;
    }

    const ccRow = cc as Record<string, unknown>;
    const wh = ccRow.warehouse as { name: string } | { name: string }[] | null;
    const whName = Array.isArray(wh) ? wh[0]?.name ?? null : wh?.name ?? null;

    setScope((ccRow.scope as string | null | undefined) ?? null);
    const fetchedHeader = {
      id: ccRow.id as string,
      organizationId: (ccRow.organization_id as string | null) ?? null,
      warehouseId: (ccRow.warehouse_id as string | null) ?? null,
      warehouseName: whName,
      status: (ccRow.status as string | null) ?? 'in_progress',
      startedAt: (ccRow.started_at as string | null) ?? new Date().toISOString(),
      postedAt: (ccRow.completed_at as string | null) ?? null,
      assignedTo: (ccRow.assigned_to as string | null) ?? null,
      // Permanent reference (server 0358). Null from a server without it: the
      // cache then keeps whatever number it already holds.
      countNumber: (ccRow.count_number as number | null | undefined) ?? null,
      notes: (ccRow.notes as string | null | undefined) ?? null,
    };

    const fetchedLines = ((lineRows ?? []) as Array<Record<string, unknown>>).map((r) => {
      const itm = r.item as
        | VariantItemRow
        | VariantItemRow[]
        | null;
      const item = Array.isArray(itm) ? itm[0] : itm;
      const updatedAt =
        (r.updated_at as string | null | undefined) ??
        (r.counted_at as string | null | undefined) ??
        null;
      return {
        id: r.id as string,
        itemId: item?.id ?? '',
        itemName: item?.name ?? 'Unknown',
        itemSku: item?.sku ?? '',
        itemBarcode: item?.barcode ?? null,
        // One shared builder, so the phone, the web row and the printed count
        // sheet all call this variant the same thing.
        itemVariantLabel: variantLabel({
          jerseyNumber: item?.jersey_number ?? null,
          size: item?.variant_size ?? null,
        }),
        expected: Number(r.expected_quantity),
        counted:
          r.counted_quantity === null || r.counted_quantity === undefined
            ? null
            : Number(r.counted_quantity),
        updatedAt,
        // Kept only for a line counted offline (the shared rule the web
        // review uses): an online record carries none.
        offlineCapturedAt: offlineCaptureAt({
          captured_at: (r.captured_at as string | null | undefined) ?? null,
          counted_at: (r.counted_at as string | null | undefined) ?? null,
        }),
      };
    });

    setServerLocations(
      new Map(
        ((lineRows ?? []) as Record<string, unknown>[]).map((r) => [
          r.id as string,
          (r.counted_location_id as string | null | undefined) ?? null,
        ]),
      ),
    );

    // Conflict detection: any line we have a pending edit for whose
    // server-side counted_quantity is newer than what we cached AND
    // differs from the value we're about to push? Surface a banner.
    if (cached) {
      const conflicts = fetchedLines.filter((s) => {
        const local = cached.lines.find((c) => c.id === s.id);
        if (!local || !local.localDirty) return false;
        if (s.counted === null) return false;
        if (s.counted === local.counted) return false;
        return true;
      });
      if (conflicts.length > 0) {
        setConflictBanner(
          `${conflicts.length} line${conflicts.length === 1 ? '' : 's'} updated on the server while you were offline — your local edits will overwrite when synced.`,
        );
      }
    }

    // The screen renders from the phone's cache, so the fetch is stored first.
    // If that write fails the screen must say so: a throw here used to go
    // unhandled (load() is fire-and-forget) and leave an uncached count
    // spinning forever.
    try {
      await cacheCycleCount(fetchedHeader, fetchedLines);
      const fresh = await getCycleCount(id);
      if (fresh) hydrateFromSnapshot(fresh);
    } catch (e) {
      console.warn('[cycle-count] could not store the count on this phone', e);
      if (!cached) {
        setReadError('This count could not be saved on this phone.');
        setEmptyState('read-failed');
      }
    }
    setLoading(false);

    // The linked exceptions, after the count is on screen (it never waits for
    // them). An answer for another workspace is never shown.
    try {
      const links = await getCountLinkedExceptions(id);
      setLinked(links.organizationId === orgId ? { kind: 'ready', data: links } : { kind: 'failed' });
    } catch {
      setLinked({ kind: 'failed' });
    }
  }, [id, orgId]);


  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount AND dep-change re-run: the flag resets are pre-await by necessity (the spinner must show during the fetch; a workspace switch re-runs this with stale content otherwise); everything else is post-await
    setLoading(true);
    setReadError(null);
    setEmptyState('none');
    void load();
  }, [load]);

  // Refresh per-cycle pending count whenever the global sync state changes.
  React.useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      const n = await pendingCountFor(id);
      if (!cancelled) setPendingForThis(n);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, syncSnapshot.pendingCount, syncSnapshot.status]);

  // The Post gate, read whenever the screen is online (a role changed since
  // is picked up on the next open). Every set is post-await.
  const gateOffline = syncSnapshot.status === 'offline';
  React.useEffect(() => {
    if (!userId || !orgId || gateOffline) return;
    let cancelled = false;
    fetchCountCloseGate(userId, orgId).then(
      (gate) => {
        if (!cancelled) setCloseGate({ kind: 'known', gate });
      },
      () => {
        if (cancelled) return;
        const known = rememberedCloseGate(userId, orgId);
        setCloseGate(known ? { kind: 'known', gate: known } : { kind: 'unknown', offline: false });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [userId, orgId, gateOffline, closeGateNonce]);

  // On unmount, SAVE what is still waiting for its debounce instead of
  // cancelling it. The state updates the save makes afterwards land on an
  // unmounted screen and are ignored; the local write and the outbox row are
  // what matter.
  React.useEffect(() => {
    return () => lineSaver.flushAll();
  }, [lineSaver]);

  function setDraftValue(lineId: string, v: string) {
    setDraft((d) => ({ ...d, [lineId]: v }));

    // Debounced persist + outbox enqueue. Local-only, no network.
    lineSaver.schedule(lineId, v);
  }

  async function postCount() {
    if (!header) return;
    // Only on a known yes (the footer shows no Post otherwise).
    if (closeGateView.kind !== 'known' || !closeGateView.gate.canPost) return;
    if (syncSnapshot.status === 'offline') {
      Alert.alert(
        'Offline',
        'Reconnect to post this cycle count. Your counts are saved locally and will sync first.',
      );
      return;
    }
    // Only THIS count's unsynced edits block posting it. The engine's global
    // pendingCount includes every kind on the device (a queued PO line, a
    // bundle distribution, another count) — none of which this post depends
    // on, and one permanently-refused row used to block every count forever.
    if (pendingForThis > 0) {
      Alert.alert(
        'Sync first',
        'There are unsynced edits. Wait for sync to finish (or tap the badge to retry) before posting.',
      );
      return;
    }

    const uncounted = lines.filter((l) => l.counted === null && draft[l.id] === undefined);
    const proceed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        'Post cycle count?',
        uncounted.length > 0
          ? `${uncounted.length} line${uncounted.length === 1 ? '' : 's'} not counted will be skipped (no variance applied).`
          : 'All lines will be applied as adjustments to inventory.',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Post', style: 'destructive', onPress: () => resolve(true) },
        ],
      );
    });
    if (!proceed) return;

    setPosting(true);
    try {
      // Through the Bearer twin, NOT the post_cycle_count RPC (SP-055).
      // The RPC alone applies the variance but skips the cycle_counts module
      // gate, the warehouse write-scope check, the `cycle_count.posted` audit
      // row and the `cycle_count.completed` integration event — so a count
      // posted from a phone moved stock while the audit console and every
      // connector stayed silent. The route runs the same service the web does.
      await postCycleCount(header.id);
    } catch (e) {
      // The route already maps every stable refusal to a sentence, so its
      // message is shown as-is; postCycleCountErrorMessage stays as the
      // FALLBACK for anything that still arrives as a raw code (0339's
      // stale_line / negative_result among them).
      Alert.alert(
        'Could not post',
        postCycleCountErrorMessage(e instanceof Error ? e.message : null),
      );
      return;
    } finally {
      setPosting(false);
    }
    Alert.alert('Posted', 'Variance adjustments applied.');
    leave();
  }

  const countedCount = lines.filter((l) => l.counted !== null).length;
  // The count's permanent reference, from the cache (filled by the snapshot
  // pull or the fetch above). Never made up when absent.
  const reference = formatCycleCountNumber(header?.countNumber);
  const offline = syncSnapshot.status === 'offline';
  const hasPending = pendingForThis > 0;
  // Only open (in_progress) counts are editable/postable. Completed or
  // canceled counts are opened from history read-only.
  const isOpen = (header?.status ?? 'in_progress') === 'in_progress';
  // What the footer shows (count-close-gate.ts): Post only on a known yes.
  // Offline with nothing known, it says posting needs a connection and who
  // posts.
  const closeGateView: CloseGateState =
    closeGate.kind === 'known' ? closeGate : offline ? { kind: 'unknown', offline: true } : closeGate;
  const footer = countFooter({
    gate: closeGateView,
    posting,
    offline,
    hasPending,
    countedCount,
    total: lines.length,
  });

  if (emptyState === 'read-failed') {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <Pressable onPress={leave} style={styles.backBtn}>
            <Text style={styles.backText}>← Back</Text>
          </Pressable>
        </View>
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Could not load this count</Text>
          <Text style={styles.emptyBody}>
            {readError}
            {'\n\n'}If the app was just updated, the server may still be catching up.
          </Text>
          <Pressable
            style={styles.retryBtn}
            onPress={() => {
              setLoading(true);
              setReadError(null);
              setEmptyState('none');
              void load();
            }}
          >
            <Text style={styles.retryLabel}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (emptyState === 'offline-uncached') {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <Pressable onPress={leave} style={styles.backBtn}>
            <Text style={styles.backText}>← Back</Text>
          </Pressable>
        </View>
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Not cached for offline use</Text>
          <Text style={styles.emptyBody}>
            Open this cycle count once while online to use it offline next time.
          </Text>
          <Pressable
            style={styles.retryBtn}
            onPress={() => {
              setLoading(true);
              setEmptyState('none');
              void load();
            }}
          >
            <Text style={styles.retryLabel}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable onPress={leave} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            {reference ? (
              <>
                <Text style={styles.eyebrow}>CYCLE COUNT</Text>
                {/* Selectable: a long press offers the system Copy, which is the
                    copy action here (this binary has no clipboard module, so the
                    app never claims a copy it cannot confirm). */}
                <Text
                  style={[styles.title, styles.reference]}
                  selectable
                  accessibilityLabel={`Cycle count ${reference}`}
                  accessibilityHint="Long press to copy the reference"
                >
                  {reference}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.title}>Cycle count</Text>
                <Text style={styles.subtitle}>{CYCLE_COUNT_REFERENCE_UNAVAILABLE}</Text>
              </>
            )}
            <Text style={styles.subtitle}>
              {header && scope
                ? cycleCountScopeLabel({
                    warehouseId: header.warehouseId,
                    warehouseName: header.warehouseName,
                    scope,
                  })
                : (header?.warehouseName ?? (header?.warehouseId ? '—' : 'No single warehouse'))}{' '}
              · {countedCount}/{lines.length} counted
            </Text>
          </View>
          {header && canAdjust && isOpen ? (
            <View style={{ flexDirection: 'row', gap: space.xs }}>
              <Pressable
                onPress={() => router.push(`/cycle-count/ai-scan/${header.id}`)}
                style={[styles.scanBtn, styles.aiScanBtn]}
              >
                <Text style={styles.scanBtnLabel} maxFontSizeMultiplier={SCAN_LABEL_CAP}>AI Scan</Text>
              </Pressable>
              <Pressable
                onPress={() => router.push(`/cycle-count/scan/${header.id}`)}
                style={styles.scanBtn}
              >
                <Text style={styles.scanBtnLabel} maxFontSizeMultiplier={SCAN_LABEL_CAP}>Scan</Text>
              </Pressable>
            </View>
          ) : header && isOpen && !isAssignee && !canManage ? (
            <Text style={styles.lockedNote}>Assigned to another employee</Text>
          ) : null}
        </View>
        <View style={styles.badgeRow}>
          <SyncStatusBadge />
          <View style={{ flexDirection: 'row', gap: space.xs }}>
            {isOpen && !!header?.assignedTo && (header.assignedTo === user?.id || canManage) ? (
              <Pressable
                onPress={() => setReleaseOpen(true)}
                style={styles.releaseBtn}
                hitSlop={8}
              >
                <Text style={styles.releaseBtnLabel} maxFontSizeMultiplier={SCAN_LABEL_CAP}>Release</Text>
              </Pressable>
            ) : null}
            {isOpen && canManage ? (
              <Pressable
                onPress={() => setReassignOpen(true)}
                style={styles.releaseBtn}
                hitSlop={8}
              >
                <Text style={styles.releaseBtnLabel} maxFontSizeMultiplier={SCAN_LABEL_CAP}>Reassign</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>

      {conflictBanner && (
        <View style={styles.conflictBanner}>
          <Text style={styles.conflictText}>{conflictBanner}</Text>
          <Pressable onPress={() => setConflictBanner(null)}>
            <Text style={styles.conflictDismiss}>Dismiss</Text>
          </Pressable>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.primary} />
        </View>
      ) : (
        // Dynamic Type: MEASURED footer reservation, not a constant. The post
        // button's label reads "Sync pending edits to post" and wraps to three
        // lines (~170pt) at accessibility sizes, well past the old 140pt
        // reservation, and covered the last count input. 140 stays the floor.
        <ScrollView
          contentContainerStyle={{
            padding: space.md,
            paddingBottom: footerReservation(footerHeight, 140),
          }}
        >
          {lines.length > 0 ? (
            <Text style={styles.expectedHint}>
              Expected is the system quantity when the line was counted (the quantity
              at session start until then). Stock that moves after a line is counted is
              kept when the count is posted.
            </Text>
          ) : null}
          {linked.kind === 'failed' ? (
            <Text style={styles.linkedNote} accessibilityRole="alert">
              {COUNT_LINKED_EXCEPTIONS_UNAVAILABLE_COPY}
            </Text>
          ) : linked.kind === 'ready' && exceptionUnrecognizedCopy(linked.data.unrecognized) ? (
            <Text style={styles.linkedNote}>{exceptionUnrecognizedCopy(linked.data.unrecognized)}</Text>
          ) : null}
          {lines.map((l) => {
            const draftVal = draft[l.id];
            const isDrafting = draftVal !== undefined;
            const display = isDrafting
              ? draftVal
              : l.counted !== null
                ? String(l.counted)
                : '';
            // Live variance — reflect whatever is currently in the box
            // (the draft while typing, else the persisted count) so the
            // delta updates immediately instead of only after the
            // debounce/sync. Shown for every counted line, including a
            // zero "matches expected".
            const parsedDraft =
              isDrafting && draftVal.trim() !== '' ? Number.parseFloat(draftVal) : NaN;
            const effectiveCounted = isDrafting
              ? Number.isFinite(parsedDraft)
                ? parsedDraft
                : null
              : l.counted;
            const variance =
              effectiveCounted !== null ? effectiveCounted - l.expected : null;
            // A count synced from an offline phone was measured against the
            // book when it was taken (server 0369); the reviewer sees when.
            // Not for a pending local edit, which is not the server's count.
            const capturedText =
              l.counted !== null && !l.localDirty && !isDrafting
                ? offlineCaptureLabel({ captured_at: l.offlineCapturedAt }, orgTimeZone)
                : null;
            // The exceptions a recount linked to this line's item, and where
            // its difference lands (only while the count is open and the
            // server's answer describes the line this phone holds); once the
            // count is closed, what it came to.
            const links =
              linked.kind === 'ready'
                ? linked.data.exceptions.filter((x) => x.occurrence.itemId === l.itemId)
                : [];
            const destination =
              links.length > 0 && linked.kind === 'ready'
                ? linkedLineDestination(
                    links[0]!,
                    {
                      counted: l.counted,
                      localDirty: l.localDirty,
                      drafting: isDrafting,
                      countedLocationId: serverLocations.get(l.id),
                    },
                    linked.data.status,
                  )
                : null;
            return (
              <View key={l.id} style={styles.card}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName} numberOfLines={2}>
                    {l.itemName}
                  </Text>
                  {l.itemVariantLabel ? (
                    <Text style={styles.itemVariant}>{l.itemVariantLabel}</Text>
                  ) : null}
                  <Text style={styles.itemSku}>{l.itemSku}</Text>
                  {capturedText ? (
                    <Text style={styles.captured}>{capturedText}</Text>
                  ) : null}
                  {links.length > 0 ? (
                    <View style={styles.linkRow}>
                      {links.map((x) => (
                        <Pressable
                          key={x.occurrence.id}
                          onPress={() => router.push(`/exceptions/${x.occurrence.id}`)}
                          style={styles.linkChip}
                          accessibilityRole="link"
                          accessibilityLabel={`Recount for exception ${x.occurrence.reference ?? ''}`.trim()}
                        >
                          <Text style={styles.linkChipText} maxFontSizeMultiplier={LINK_CHIP_CAP}>
                            {`Recount for ${x.occurrence.reference ?? 'an exception'}`}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                  {destination ? (
                    <Text style={destination.kind === 'review' ? styles.destination : styles.destinationPending}>
                      {destination.text}
                    </Text>
                  ) : null}
                  <Text style={styles.expected}>
                    Expected: {l.expected}
                    {l.localDirty && (
                      <Text style={{ color: theme.warning }}> · unsynced</Text>
                    )}
                  </Text>
                  {variance !== null && (
                    <Text
                      style={[
                        styles.variance,
                        {
                          color:
                            variance > 0
                              ? theme.success
                              : variance < 0
                                ? theme.destructive
                                : theme.textMuted,
                        },
                      ]}
                    >
                      {variance === 0
                        ? '✓ Matches expected'
                        : `Variance ${variance > 0 ? '+' : ''}${variance}`}
                    </Text>
                  )}
                </View>
                <View style={styles.countBox}>
                  <TextInput
                    style={styles.countInput}
                    value={display}
                    onChangeText={(v) => setDraftValue(l.id, v)}
                    editable={isOpen && canAdjust}
                    keyboardType="numeric"
                    placeholder="—"
                    placeholderTextColor={theme.textMuted}
                  />
                </View>
              </View>
            );
          })}

          {lines.length === 0 && (
            <Text style={styles.emptyText}>
              This count has no lines yet. Add lines from the web first.
            </Text>
          )}
        </ScrollView>
      )}

      {!loading && lines.length > 0 && isOpen && canAdjust && (
        <View
          style={styles.footer}
          onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
        >
          {footer.kind === 'post' ? (
            <Pressable
              onPress={postCount}
              disabled={footer.disabled}
              style={({ pressed }) => [
                styles.postBtn,
                footer.partial && { backgroundColor: theme.warning },
                (pressed || footer.disabled) && { opacity: 0.6 },
              ]}
            >
              <Text style={styles.postBtnText}>{footer.label}</Text>
            </Pressable>
          ) : (
            <View style={{ gap: space.sm }}>
              <Text style={styles.footerNote} accessibilityRole="text">
                {footer.text}
              </Text>
              {footer.kind === 'unknown' && footer.retry ? (
                <Pressable
                  onPress={() => {
                    setCloseGate({ kind: 'loading' });
                    setCloseGateNonce((n) => n + 1);
                  }}
                  style={styles.footerRetry}
                  accessibilityRole="button"
                >
                  <Text style={styles.releaseBtnLabel}>Check again</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </View>
      )}

      <CycleCountReleaseSheet
        visible={releaseOpen}
        cycleCountId={id}
        onClose={() => setReleaseOpen(false)}
        onReleased={() => {
          setReleaseOpen(false);
          // The count is no longer assigned to us — return to the list, which
          // reloads with the updated assignment.
          leave();
        }}
      />

      <CycleCountReassignSheet
        visible={reassignOpen}
        cycleCountId={id}
        orgId={orgId ?? null}
        currentAssigneeId={header?.assignedTo ?? null}
        onClose={() => setReassignOpen(false)}
        onReassigned={() => {
          setReassignOpen(false);
          // Reassigned away — reflect the new assignment by reloading the list.
          leave();
        }}
      />
    </SafeAreaView>
  );
}

/**
 * Chrome cap for the header's 13pt action labels (AI Scan / Scan / Release /
 * Reassign). They sit in a pinned header row beside a `flex: 1` title column,
 * so they cannot wrap or scroll and every point they grow is taken straight
 * out of the title.
 */
const SCAN_LABEL_CAP = capTo(13, TYPE_CEILING.chrome);

/**
 * Chrome cap for the linked-exception chip ("Recount for EX-000042"). Its box
 * is a minHeight with wrapping row (never a fixed height), so the capped label
 * still grows to 20pt and wraps instead of clipping. The destination line
 * under it is content and is not capped.
 */
const LINK_CHIP_CAP = capTo(12, TYPE_CEILING.chrome);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  backBtn: { paddingVertical: space.xs },
  backText: { color: theme.primary, fontSize: 14 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: 4 },
  title: { color: theme.text, fontSize: 22, fontWeight: '700' },
  eyebrow: { color: theme.textMuted, fontSize: 10.5, letterSpacing: 1.2, fontWeight: '600' },
  reference: { fontVariant: ['tabular-nums'], letterSpacing: 0.2 },
  subtitle: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  badgeRow: {
    marginTop: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  releaseBtn: {
    minHeight: 32,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.border,
    justifyContent: 'center',
  },
  releaseBtnLabel: { color: theme.text, fontSize: 13, fontWeight: '600' },
  scanBtn: {
    // Accessible 44pt touch target (Apple HIG / Android min) with a shared
    // minWidth so "Scan" and "AI Scan" render the same size instead of the
    // label-width mismatch. minWidth (not a fixed width) keeps long localized
    // labels from clipping. Centered so the label sits mid-button now that
    // minHeight exceeds the intrinsic content height.
    minHeight: 44,
    minWidth: 76,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    backgroundColor: theme.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiScanBtn: {
    // Slight purple tint so the AI button is visually distinct from
    // the regular Scan button — same hierarchy, different affordance.
    backgroundColor: '#7c3aed',
  },
  scanBtnLabel: { color: '#fff', fontSize: 13, fontWeight: '700' },
  lockedNote: {
    color: theme.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
    maxWidth: 140,
    textAlign: 'right',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  card: {
    flexDirection: 'row',
    backgroundColor: theme.card,
    padding: space.md,
    borderRadius: radius.md,
    marginBottom: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  itemName: { color: theme.text, fontSize: 14, fontWeight: '600' },
  itemVariant: { color: theme.primary, fontSize: 12, fontWeight: '600', marginTop: 1 },
  captured: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  itemSku: {
    color: theme.textMuted,
    fontFamily: 'Menlo',
    fontSize: 11,
    marginTop: 2,
  },
  expected: { color: theme.textMuted, fontSize: 12, marginTop: 4 },
  expectedHint: { color: theme.textMuted, fontSize: 12, marginBottom: space.sm },
  variance: { fontSize: 13, fontWeight: '700', marginTop: 4 },
  countBox: { alignItems: 'flex-end', justifyContent: 'center', minWidth: 110 },
  countInput: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    backgroundColor: theme.bg,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    minWidth: 80,
    textAlign: 'right',
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.md,
    backgroundColor: theme.bgElevated,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  postBtn: {
    backgroundColor: theme.primary,
    paddingVertical: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  postBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  emptyText: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: 'center',
    padding: space.xl,
  },
  emptyTitle: { color: theme.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  emptyBody: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginTop: space.sm,
  },
  retryBtn: {
    marginTop: space.lg,
    backgroundColor: theme.primary,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    borderRadius: radius.md,
  },
  retryLabel: { color: '#fff', fontWeight: '600' },
  conflictBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderColor: theme.warning,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  conflictText: { color: theme.text, fontSize: 12, flex: 1 },
  conflictDismiss: { color: theme.warning, fontWeight: '700', fontSize: 12 },
  footerNote: { color: theme.textMuted, fontSize: 14, textAlign: 'center' },
  footerRetry: {
    alignSelf: 'center',
    minHeight: 40,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.border,
    justifyContent: 'center',
  },
  linkedNote: { color: theme.textMuted, fontSize: 12, marginBottom: space.sm },
  linkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  linkChip: {
    minHeight: 24,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.warning,
    justifyContent: 'center',
    flexShrink: 1,
  },
  linkChipText: { color: theme.warning, fontSize: 12, fontWeight: '600' },
  destination: { color: theme.text, fontSize: 13, marginTop: 4 },
  destinationPending: { color: theme.textMuted, fontSize: 12, marginTop: 4 },
});

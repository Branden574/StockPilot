import * as Network from 'expo-network';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  COUNT_LINKED_EXCEPTIONS_UNAVAILABLE_COPY,
  CYCLE_COUNT_REFERENCE_UNAVAILABLE,
  countFromText,
  exceptionUnrecognizedCopy,
  offlineCaptureAt,
  offlineCaptureLabel,
  variantLabel,
} from '@stockpilot/core';

import { CycleCountReassignSheet } from '@/components/cycle-count-reassign-sheet';
import { CycleCountReleaseSheet } from '@/components/cycle-count-release-sheet';
import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { Button } from '@/components/ui/button';
import { StockBar } from '@/components/ui/stock-bar';
import { BUTTON_RADIUS, buttonTone, pillTone } from '@/components/ui/tones';
import { useAuth } from '@/lib/auth-context';
import {
  countFooter,
  fetchCountCloseGate,
  rememberedCloseGate,
  type CloseGateState,
} from '@/lib/count-close-gate';
import { showWriteCta } from '@/lib/cta-gating';
import { notACountMessage } from '@/lib/count-box-words';
import { footerReservation } from '@/lib/dynamic-type-layout';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import {
  cacheCycleCount,
  clearLocalLine,
  getCycleCount,
  pendingCountFor,
  updateLocalLine,
  type CachedCycleCountHeader,
  type CachedCycleCountLine,
} from '@/lib/cycle-count-cache';
import { cycleCountHeaderView, cycleCountIsOpen } from '@/lib/cycle-count-header';
import { fetchAllCycleCountLines } from '@/lib/cycle-count-lines-fetch';
import { postCycleCountErrorMessage } from '@/lib/cycle-count-post-errors';
import { cycleCountSync, useSyncStatus } from '@/lib/cycle-count-sync';
import { postCycleCount } from '@/lib/cycle-counts-api';
import { missingCountCopy, whyCountIsMissing, type MissingCount } from '@/lib/cycle-count-missing';
import {
  getCountLinkedExceptions,
  linkedLineDestination,
  type MobileCountLinkedExceptions,
} from '@/lib/exceptions-api';
import { createDraftDebouncer } from '@/lib/draft-debouncer';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/lib/use-org';
import { useOrgTimeZone } from '@/lib/org-zone';
import { FONT, RADIUS, TYPE_CEILING, capTo, radius, space } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

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

/** Said when the copy of this count saved on the phone cannot be read. */
const COUNT_UNREADABLE_ON_PHONE = 'This count could not be read on this phone.';

/** Whether a box holds nothing at all: emptied, or only spaces. */
function isEmptyBox(raw: string): boolean {
  return raw.trim() === '';
}

/**
 * The count a box holds, as the line saver reads it: a plain number of zero
 * or more, or null for an empty box and anything else (core countFromText,
 * the rule the web count screen and the AI review read a box by too). A lone
 * minus sign, a second point ("1.2.3") or a comma ("2,5") is not a count, and
 * is never read as the number before it: parseFloat saved "1.2.3" as 1.2 and
 * "2,5" as 2. The saver and Post both read a box through this one rule, so
 * they cannot disagree.
 */
function countFromBox(raw: string): number | null {
  if (isEmptyBox(raw)) return null;
  return countFromText(raw);
}

/**
 * Whether a box's edit has not finished saving. The line saver writes a box
 * SAVE_DEBOUNCE_MS after the last keystroke, and its save then waits its turn
 * among the phone's writes (a snapshot pull or the count's own caching can
 * hold that queue for a while); a box's draft is dropped only once its own
 * save has finished (withoutSavedDraft), and by then its outbox row is
 * queued. So any draft left is a save still waiting or running, and Post
 * waits for it ("Sync first").
 *
 * Every draft counts, whatever the line shows: the line's count on screen is
 * set only when its save finishes, so it can trail the phone's store. An
 * emptied box over a line still shown uncounted used to count as nothing to
 * save, while the count typed in it a moment before was still being written:
 * that count was then queued and sent after Post had said the line would be
 * skipped (B4a). A box that holds something that is not a count is never
 * saved; Post names those first (linesNotACount).
 */
function hasUnsavedEdit(draft: Readonly<Record<string, string>>): boolean {
  return Object.keys(draft).length > 0;
}

/**
 * The lines whose box holds something that is not a count of zero or more (a
 * lone minus sign, a stray point, a second point, a comma: countFromBox). The
 * saver saves nothing for such a box, so its line keeps the count saved
 * before, and a post would apply a number the box does not show. Post names
 * them and waits (B4a).
 */
function linesNotACount<L extends { id: string }>(
  draft: Readonly<Record<string, string>>,
  lines: readonly L[],
): L[] {
  return lines.filter((l) => {
    const raw = draft[l.id];
    return raw !== undefined && !isEmptyBox(raw) && countFromBox(raw) === null;
  });
}

/**
 * The drafts once a box's save has finished: its draft goes, so the box
 * shows what was saved, unless the person typed in the box again while the
 * save ran. That newer text is waiting for its own save, so it stays on
 * screen and still counts as unsaved (the box used to flick back to the
 * older value until the newer save landed).
 */
function withoutSavedDraft(
  draft: Record<string, string>,
  lineId: string,
  raw: string,
): Record<string, string> {
  if (draft[lineId] !== raw) return draft;
  const { [lineId]: _saved, ...rest } = draft;
  return rest;
}

export default function CycleCountDetail() {
  const router = useRouter();
  // The device's palette (it was the light-only legacy alias, so the screen
  // stayed light in dark mode under a sync badge that followed the device).
  const { c } = useTheme();
  const outline = buttonTone('outline', c);
  const post = buttonTone('primary', c);
  const warnPill = pillTone('warn', c);
  const insets = useSafeAreaInsets();
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
  // the phone and the web review name the same moment: the one known for the
  // organization, else read once (org-zone.ts). Without it (offline before
  // any read, a refused read) core's default zone, never the device's (B25).
  const orgTimeZone = useOrgTimeZone(orgId);
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
    'none' | 'offline-uncached' | 'read-failed' | MissingCount
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
        const num = countFromBox(raw);
        if (num === null) {
          // An emptied box clears the line's saved count, as the web count
          // screen does: the line is uncounted again and Post skips it. It
          // used to keep the count saved before, which Post then applied
          // while the box showed nothing (B4a). Anything else that is not a
          // count (a lone minus sign) saves nothing; Post waits on it.
          if (!isEmptyBox(raw)) return;
          const cleared = await clearLocalLine(lineId);
          if (cleared) {
            setLines((curr) =>
              curr.map((l) =>
                l.id === lineId
                  ? { ...l, counted: null, localDirty: true, offlineCapturedAt: null }
                  : l,
              ),
            );
          }
          setDraft((d) => withoutSavedDraft(d, lineId, raw));
          if (!cleared) return;
          await cycleCountSync.refreshPendingCount();
          void cycleCountSync.forceSync();
          return;
        }

        await updateLocalLine(lineId, num);
        setLines((curr) =>
          curr.map((l) =>
            // A new local count replaces the server's, so its capture time
            // no longer describes this line.
            l.id === lineId ? { ...l, counted: num, localDirty: true, offlineCapturedAt: null } : l,
          ),
        );
        setDraft((d) => withoutSavedDraft(d, lineId, raw));

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

    // The copy saved on this phone. A read that fails is said, never a
    // spinner that does not end: load() is fire-and-forget, so a throw here
    // went unhandled and left the screen loading with nothing to explain it.
    // Online, the fetch below still runs (and stores and re-reads the count).
    let cached: Awaited<ReturnType<typeof getCycleCount>> = null;
    let cacheUnreadable = false;
    try {
      cached = await getCycleCount(id);
    } catch {
      cacheUnreadable = true;
    }
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
        // "Not cached" only when the phone's store answered that it has no
        // copy; a store that could not be read says so.
        if (cacheUnreadable) {
          setReadError(COUNT_UNREADABLE_ON_PHONE);
          setEmptyState('read-failed');
        } else {
          setEmptyState('offline-uncached');
        }
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
        if (message) {
          setReadError(message);
          setEmptyState('read-failed');
        } else {
          // No row and no error: no count by this id in this workspace. This
          // rendered the count screen with nothing in it, which said "This
          // count has no lines yet" (B25). Now where it is, or that it is not
          // available (cycle-count-missing.ts).
          setEmptyState(await whyCountIsMissing(supabase, id, orgId));
        }
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

    const fetchedLines = ((lineRows ?? []) as Record<string, unknown>[]).map((r) => {
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
    // A box holding something that is not a count saves nothing, so its line
    // keeps the count saved before, and a post would apply a number the box
    // does not show (B4a). Name them, and post nothing until each box holds a
    // count or nothing.
    const notCounts = linesNotACount(draft, lines);
    if (notCounts.length > 0) {
      Alert.alert('Check the counts', notACountMessage(notCounts.map((l) => l.itemName)));
      return;
    }
    // A count typed a moment ago is still waiting for its save (the pause
    // after the last keystroke, then its turn among the phone's writes), so
    // it is neither saved nor queued, and a post sent now could reach the
    // server before it: the count would post without it, and the queued count
    // would be refused afterwards. Save what is still waiting at once; it is
    // an unsynced edit like any other, so posting waits for it. An emptied
    // box's clear waits the same way, and so does any box whose save is
    // still running (hasUnsavedEdit).
    const unsaved = hasUnsavedEdit(draft);
    if (unsaved) lineSaver.flushAll();
    // Only THIS count's unsynced edits block posting it. The engine's global
    // pendingCount includes every kind on the device (a queued PO line, a
    // bundle distribution, another count) — none of which this post depends
    // on, and one permanently-refused row used to block every count forever.
    // Read from the phone now: the tally on screen can trail a save that just
    // finished by a moment.
    let pending = pendingForThis;
    try {
      pending = await pendingCountFor(header.id);
    } catch {
      // The phone's outbox could not be read: the tally on screen decides.
    }
    if (unsaved || pending > 0) {
      Alert.alert(
        'Sync first',
        'There are unsynced edits. Wait for sync to finish (or tap the badge to retry) before posting.',
      );
      return;
    }

    // Every box's count, and every emptied box's clear, is saved and synced
    // by now, so a line with no saved count is one the post skips.
    const uncounted = lines.filter((l) => l.counted === null);
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
  // The header: the count's reference (from the cache, filled by the snapshot
  // pull or the fetch above; never made up when absent), its place and its
  // progress, or, before the count is known, that it is loading and nothing
  // else (cycle-count-header.ts; simulator walk 2026-09-27).
  const headerView = cycleCountHeaderView(header, {
    loading,
    scope,
    countedCount,
    lineTotal: lines.length,
  });
  const offline = syncSnapshot.status === 'offline';
  const hasPending = pendingForThis > 0;
  // Only open (in_progress) counts are editable/postable. Completed or
  // canceled counts are opened from history read-only, and a count still
  // loading is not open (no Reassign or Release on a count not yet known).
  const isOpen = cycleCountIsOpen(header);
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
      <SafeAreaView style={[styles.root, { backgroundColor: c.paper }]} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={[styles.header, { borderBottomColor: c.hair }]}>
          <Pressable
            onPress={leave}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Text style={[styles.backText, { color: c.ink }]}>← Back</Text>
          </Pressable>
        </View>
        <View style={styles.center}>
          <Text style={[styles.emptyTitle, { color: c.ink }]}>Could not load this count</Text>
          <Text style={[styles.emptyBody, { color: c.ink3 }]}>
            {readError}
            {'\n\n'}If the app was just updated, the server may still be catching up.
          </Text>
          <Button
            variant="outline"
            style={styles.retry}
            onPress={() => {
              setLoading(true);
              setReadError(null);
              setEmptyState('none');
              void load();
            }}
          >
            Retry
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  if (emptyState === 'other-workspace' || emptyState === 'not-available') {
    const missing = missingCountCopy(emptyState);
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: c.paper }]} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={[styles.header, { borderBottomColor: c.hair }]}>
          <Pressable
            onPress={leave}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Text style={[styles.backText, { color: c.ink }]}>← Back</Text>
          </Pressable>
        </View>
        <View style={styles.center}>
          <Text style={[styles.emptyTitle, { color: c.ink }]}>{missing.title}</Text>
          <Text style={[styles.emptyBody, { color: c.ink3 }]}>{missing.body}</Text>
          <Button
            variant="outline"
            style={styles.retry}
            onPress={() => {
              setLoading(true);
              setEmptyState('none');
              void load();
            }}
          >
            Retry
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  if (emptyState === 'offline-uncached') {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: c.paper }]} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={[styles.header, { borderBottomColor: c.hair }]}>
          <Pressable
            onPress={leave}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Text style={[styles.backText, { color: c.ink }]}>← Back</Text>
          </Pressable>
        </View>
        <View style={styles.center}>
          <Text style={[styles.emptyTitle, { color: c.ink }]}>Not cached for offline use</Text>
          <Text style={[styles.emptyBody, { color: c.ink3 }]}>
            Open this cycle count once while online to use it offline next time.
          </Text>
          <Button
            variant="outline"
            style={styles.retry}
            onPress={() => {
              setLoading(true);
              setEmptyState('none');
              void load();
            }}
          >
            Retry
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.paper }]} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { borderBottomColor: c.hair }]}>
        <Pressable
          onPress={leave}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Text style={[styles.backText, { color: c.ink }]}>← Back</Text>
        </Pressable>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            {headerView.kind === 'known' && headerView.reference ? (
              <>
                <Text style={[styles.eyebrow, { color: c.ink3 }]}>CYCLE COUNT</Text>
                {/* Selectable: a long press offers the system Copy, which is the
                    copy action here (this binary has no clipboard module, so the
                    app never claims a copy it cannot confirm). */}
                <Text
                  style={[styles.title, styles.reference, { color: c.ink }]}
                  selectable
                  accessibilityLabel={`Cycle count ${headerView.reference}`}
                  accessibilityHint="Long press to copy the reference"
                >
                  {headerView.reference}
                </Text>
              </>
            ) : (
              <>
                <Text style={[styles.title, { color: c.ink }]}>Cycle count</Text>
                {headerView.kind === 'known' ? (
                  <Text style={[styles.subtitle, { color: c.ink3 }]}>
                    {CYCLE_COUNT_REFERENCE_UNAVAILABLE}
                  </Text>
                ) : null}
              </>
            )}
            {headerView.kind === 'known' ? (
              <Text style={[styles.subtitle, { color: c.ink3 }]}>
                {headerView.place} · {headerView.progress}
              </Text>
            ) : headerView.kind === 'loading' ? (
              <Text style={[styles.subtitle, { color: c.ink3 }]}>{headerView.text}</Text>
            ) : null}
          </View>
          {header && canAdjust && isOpen ? (
            // AI Scan and Scan are the outline buttons: the count's one ink
            // button is the Post at the foot of the screen.
            <View style={styles.scanRow}>
              <Pressable
                onPress={() => router.push(`/cycle-count/ai-scan/${header.id}`)}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.scanBtn,
                  { backgroundColor: outline.bg, borderColor: outline.border },
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={[styles.scanBtnLabel, { color: outline.fg }]}
                  maxFontSizeMultiplier={SCAN_LABEL_CAP}
                >
                  AI Scan
                </Text>
              </Pressable>
              <Pressable
                onPress={() => router.push(`/cycle-count/scan/${header.id}`)}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.scanBtn,
                  { backgroundColor: outline.bg, borderColor: outline.border },
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={[styles.scanBtnLabel, { color: outline.fg }]}
                  maxFontSizeMultiplier={SCAN_LABEL_CAP}
                >
                  Scan
                </Text>
              </Pressable>
            </View>
          ) : header && isOpen && !isAssignee && !canManage ? (
            <Text style={[styles.lockedNote, { color: c.ink3 }]}>Assigned to another employee</Text>
          ) : null}
        </View>
        {/* The reference count card's progress bar (DESIGN-SPEC 6.11): the
            same counted-of-total the line above says, drawn, never a new
            number. */}
        {headerView.kind === 'known' && lines.length > 0 ? (
          <View style={styles.progress}>
            <StockBar value={countedCount} max={lines.length} height={4} />
          </View>
        ) : null}
        <View style={styles.badgeRow}>
          <SyncStatusBadge />
          <View style={styles.badgeActions}>
            {isOpen && !!header?.assignedTo && (header.assignedTo === user?.id || canManage) ? (
              <Pressable
                onPress={() => setReleaseOpen(true)}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.releaseBtn,
                  { backgroundColor: outline.bg, borderColor: outline.border },
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={[styles.releaseBtnLabel, { color: outline.fg }]}
                  maxFontSizeMultiplier={SCAN_LABEL_CAP}
                >
                  Release
                </Text>
              </Pressable>
            ) : null}
            {isOpen && canManage ? (
              <Pressable
                onPress={() => setReassignOpen(true)}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.releaseBtn,
                  { backgroundColor: outline.bg, borderColor: outline.border },
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={[styles.releaseBtnLabel, { color: outline.fg }]}
                  maxFontSizeMultiplier={SCAN_LABEL_CAP}
                >
                  Reassign
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>

      {conflictBanner && (
        <View
          style={[
            styles.conflictBanner,
            { backgroundColor: c.warnWash, borderBottomColor: c.hair },
          ]}
        >
          <Text style={[styles.conflictText, { color: c.ink }]}>{conflictBanner}</Text>
          <Pressable
            onPress={() => setConflictBanner(null)}
            accessibilityRole="button"
            style={styles.conflictDismissFrame}
          >
            <Text style={[styles.conflictDismiss, { color: c.warnText }]}>Dismiss</Text>
          </Pressable>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.ink} />
        </View>
      ) : (
        // Dynamic Type: MEASURED footer reservation, not a constant. The post
        // button's label reads "Sync pending edits to post" and wraps to three
        // lines (~170pt) at accessibility sizes, well past the old 140pt
        // reservation, and covered the last count input. 140 stays the floor.
        //
        // The keyboard: a count box opens a number pad, which covered the
        // lower lines with no way to scroll the last ones above it. The scroll
        // insets itself by the keyboard on iOS and brings the box being typed
        // in into view.
        <ScrollView
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={{
            padding: space.md,
            paddingBottom: footerReservation(footerHeight, 140),
          }}
        >
          {lines.length > 0 ? (
            <Text style={[styles.expectedHint, { color: c.ink3 }]}>
              Expected is the system quantity when the line was counted (the quantity
              at session start until then). Stock that moves after a line is counted is
              kept when the count is posted.
            </Text>
          ) : null}
          {linked.kind === 'failed' ? (
            <Text style={[styles.linkedNote, { color: c.ink3 }]} accessibilityRole="alert">
              {COUNT_LINKED_EXCEPTIONS_UNAVAILABLE_COPY}
            </Text>
          ) : linked.kind === 'ready' && exceptionUnrecognizedCopy(linked.data.unrecognized) ? (
            <Text style={[styles.linkedNote, { color: c.ink3 }]}>
              {exceptionUnrecognizedCopy(linked.data.unrecognized)}
            </Text>
          ) : null}
          {lines.map((l, i) => {
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
            // zero "matches expected". The draft is read by the saver's own
            // rule (countFromBox), so a box the saver will not save (a
            // negative number) shows no variance it will never apply.
            const effectiveCounted = isDrafting ? countFromBox(draftVal) : l.counted;
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
            // The lines are one card with a hairline between rows (the
            // reference count card's table, DESIGN-SPEC 6.7): the first row
            // draws the top edge and corners, the last the bottom ones.
            return (
              <View
                key={l.id}
                style={[
                  styles.line,
                  { backgroundColor: c.card, borderColor: c.hair },
                  i === 0 && styles.lineFirst,
                  i === lines.length - 1 && styles.lineLast,
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.itemName, { color: c.ink }]} numberOfLines={2}>
                    {l.itemName}
                  </Text>
                  {l.itemVariantLabel ? (
                    <Text style={[styles.itemVariant, { color: c.ink2 }]}>
                      {l.itemVariantLabel}
                    </Text>
                  ) : null}
                  <Text style={[styles.itemSku, { color: c.ink3 }]}>{l.itemSku}</Text>
                  {capturedText ? (
                    <Text style={[styles.captured, { color: c.ink3 }]}>{capturedText}</Text>
                  ) : null}
                  {links.length > 0 ? (
                    <View style={styles.linkRow}>
                      {links.map((x) => (
                        // A 44pt frame around the warning chip (the chip
                        // alone was 24pt tall).
                        <Pressable
                          key={x.occurrence.id}
                          onPress={() => router.push(`/exceptions/${x.occurrence.id}`)}
                          style={styles.linkFrame}
                          accessibilityRole="link"
                          accessibilityLabel={`Recount for exception ${x.occurrence.reference ?? ''}`.trim()}
                        >
                          <View
                            style={[
                              styles.linkChip,
                              { backgroundColor: warnPill.bg, borderColor: warnPill.border },
                            ]}
                          >
                            <Text
                              style={[styles.linkChipText, { color: warnPill.fg }]}
                              maxFontSizeMultiplier={LINK_CHIP_CAP}
                            >
                              {`Recount for ${x.occurrence.reference ?? 'an exception'}`}
                            </Text>
                          </View>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                  {destination ? (
                    <Text
                      style={
                        destination.kind === 'review'
                          ? [styles.destination, { color: c.ink }]
                          : [styles.destinationPending, { color: c.ink3 }]
                      }
                    >
                      {destination.text}
                    </Text>
                  ) : null}
                  <Text style={[styles.expected, { color: c.ink3 }]}>
                    Expected: {l.expected}
                    {l.localDirty && <Text style={{ color: c.warnText }}> · unsynced</Text>}
                  </Text>
                  {variance !== null && (
                    <View style={styles.varianceRow}>
                      {/* The check mark that led "Matches expected" is an icon
                          now; the words are the same. */}
                      {variance === 0 ? <Check size={14} color={c.ink3} strokeWidth={2} /> : null}
                      <Text
                        style={[
                          styles.variance,
                          {
                            color: variance > 0 ? c.accent : variance < 0 ? c.critText : c.ink3,
                          },
                        ]}
                      >
                        {variance === 0
                          ? 'Matches expected'
                          : `Variance ${variance > 0 ? '+' : ''}${variance}`}
                      </Text>
                    </View>
                  )}
                </View>
                <View style={styles.countBox}>
                  {/* The reference's count box: recessed, the stronger border,
                      mono and right-aligned. Named for its line, so VoiceOver
                      says which item a count is for (it read only the value). */}
                  <TextInput
                    style={[
                      styles.countInput,
                      { color: c.ink, backgroundColor: c.sunk, borderColor: c.hair2 },
                    ]}
                    value={display}
                    onChangeText={(v) => setDraftValue(l.id, v)}
                    editable={isOpen && canAdjust}
                    keyboardType="numeric"
                    placeholder="—"
                    placeholderTextColor={c.ink3}
                    accessibilityLabel={`Counted, ${l.itemName}`}
                  />
                </View>
              </View>
            );
          })}

          {header !== null && lines.length === 0 && (
            <Text style={[styles.emptyText, { color: c.ink3 }]}>
              This count has no lines yet. Add lines from the web first.
            </Text>
          )}
        </ScrollView>
      )}

      {!loading && lines.length > 0 && isOpen && canAdjust && (
        // Clear of the home indicator: the footer is pinned to the bottom of
        // the screen, and the Post button sat over the home indicator's strip.
        <View
          style={[
            styles.footer,
            {
              backgroundColor: c.paper,
              borderTopColor: c.hair,
              paddingBottom: space.md + insets.bottom,
            },
          ]}
          onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
        >
          {footer.kind === 'post' ? (
            // Post commits the count: the ink button. A partial post (some
            // lines not counted) keeps its warning fill, as before, with the
            // words in the page colour. The label wraps (no line limit): the
            // reservation above follows its measured height.
            <Pressable
              onPress={postCount}
              disabled={footer.disabled}
              accessibilityRole="button"
              accessibilityState={{ disabled: footer.disabled }}
              style={({ pressed }) => [
                styles.postBtn,
                { backgroundColor: post.bg, borderColor: post.border },
                footer.partial && { backgroundColor: c.warnText, borderColor: c.warnText },
                (pressed || footer.disabled) && { opacity: 0.6 },
              ]}
            >
              <Text style={[styles.postBtnText, { color: post.fg }]}>{footer.label}</Text>
            </Pressable>
          ) : (
            <View style={{ gap: space.sm }}>
              <Text style={[styles.footerNote, { color: c.ink3 }]} accessibilityRole="text">
                {footer.text}
              </Text>
              {footer.kind === 'unknown' && footer.retry ? (
                <Pressable
                  onPress={() => {
                    setCloseGate({ kind: 'loading' });
                    setCloseGateNonce((n) => n + 1);
                  }}
                  style={({ pressed }) => [
                    styles.footerRetry,
                    { backgroundColor: outline.bg, borderColor: outline.border },
                    pressed && styles.pressed,
                  ]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.releaseBtnLabel, { color: outline.fg }]}>Check again</Text>
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

/** The iOS minimum tap target, in points. */
const MIN_TAP = 44;

/**
 * The look (redesign package P5.9a): the device's palette in both modes (it
 * was the light-only legacy `theme` alias, so the screen stayed light in dark
 * mode while its sync badge followed the device); Inter Tight for words and
 * JetBrains Mono for the reference, the SKUs and the count boxes; the lines
 * as one hairline card; every control a 44pt target with a button role. The
 * sizes of the words are the ones the screen always had, with the same caps.
 */
const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // "← Back" is a button in a frame at least 44pt tall (it was the 25pt
  // text), read "Back" by VoiceOver (it read the arrow too, with no button
  // role). The frame takes the header's 8pt top padding and the 4pt gap to
  // the title (marginBottom -4 cancels headerRow's marginTop), so the title
  // row sits about 7pt lower than it did, and nothing overlaps.
  backBtn: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    marginTop: -space.sm,
    marginBottom: -4,
  },
  backText: { fontFamily: FONT.display, fontWeight: '500', fontSize: 14 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: 4 },
  title: { fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 22, letterSpacing: -0.4 },
  eyebrow: { fontFamily: FONT.mono, fontSize: 10.5, letterSpacing: 1.2 },
  // The reference is a code: mono, as the reference prints CC- ids.
  reference: { fontFamily: FONT.mono, fontWeight: '500', letterSpacing: 0.2 },
  subtitle: { fontFamily: FONT.displayRegular, fontSize: 12, marginTop: 2 },
  progress: { marginTop: space.sm },
  badgeRow: {
    marginTop: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  badgeActions: { flexDirection: 'row', gap: space.xs },
  // Release, Reassign: outline buttons in a real 44pt frame (they were 32pt
  // with hitSlop, which VoiceOver's outline does not show).
  releaseBtn: {
    minHeight: MIN_TAP,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: BUTTON_RADIUS.sm,
    borderWidth: 1,
    justifyContent: 'center',
  },
  releaseBtnLabel: { fontFamily: FONT.display, fontWeight: '500', fontSize: 13 },
  scanRow: { flexDirection: 'row', gap: space.xs },
  scanBtn: {
    // Accessible 44pt touch target (Apple HIG / Android min) with a shared
    // minWidth so "Scan" and "AI Scan" render the same size instead of the
    // label-width mismatch. minWidth (not a fixed width) keeps long localized
    // labels from clipping. Centered so the label sits mid-button now that
    // minHeight exceeds the intrinsic content height.
    minHeight: MIN_TAP,
    minWidth: 76,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: BUTTON_RADIUS.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanBtnLabel: { fontFamily: FONT.display, fontWeight: '500', fontSize: 13 },
  pressed: { opacity: 0.85 },
  lockedNote: {
    fontFamily: FONT.displayRegular,
    fontSize: 12,
    fontStyle: 'italic',
    maxWidth: 140,
    textAlign: 'right',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  retry: { marginTop: space.lg, minWidth: 160 },
  line: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.md,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
  },
  lineFirst: {
    borderTopWidth: 1,
    borderTopLeftRadius: RADIUS.card,
    borderTopRightRadius: RADIUS.card,
  },
  lineLast: {
    borderBottomLeftRadius: RADIUS.card,
    borderBottomRightRadius: RADIUS.card,
  },
  itemName: { fontFamily: FONT.display, fontWeight: '500', fontSize: 14 },
  itemVariant: { fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 12, marginTop: 1 },
  captured: { fontFamily: FONT.displayRegular, fontSize: 12, marginTop: 2 },
  itemSku: { fontFamily: FONT.monoRegular, fontSize: 11, marginTop: 2 },
  expected: { fontFamily: FONT.displayRegular, fontSize: 12, marginTop: 4 },
  expectedHint: { fontFamily: FONT.displayRegular, fontSize: 12, marginBottom: space.sm },
  varianceRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  variance: { fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 13 },
  countBox: { alignItems: 'flex-end', justifyContent: 'center', minWidth: 110 },
  // A 44pt target (the box was about 36pt tall); minHeight, so the typed
  // number still grows the box at the larger text sizes.
  countInput: {
    fontFamily: FONT.mono,
    fontSize: 18,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    minHeight: MIN_TAP,
    minWidth: 80,
    textAlign: 'right',
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space.md,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // The shared Button's md recipe (52pt, radius 14), drawn here because its
  // label must wrap (see the reservation above).
  postBtn: {
    minHeight: 52,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: BUTTON_RADIUS.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  postBtnText: { fontFamily: FONT.display, fontWeight: '500', fontSize: 16, textAlign: 'center' },
  emptyText: {
    fontFamily: FONT.displayRegular,
    fontSize: 14,
    textAlign: 'center',
    padding: space.xl,
  },
  emptyTitle: {
    fontFamily: FONT.displaySemi,
    fontWeight: '600',
    fontSize: 18,
    textAlign: 'center',
  },
  emptyBody: {
    fontFamily: FONT.displayRegular,
    fontSize: 14,
    textAlign: 'center',
    marginTop: space.sm,
  },
  conflictBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  conflictText: { fontFamily: FONT.displayRegular, fontSize: 12, flex: 1 },
  // Dismiss is a button in a frame at least 44pt tall and wide; it reaches
  // into the banner's 8pt padding, so a one-line banner grows only 12pt.
  conflictDismissFrame: {
    minHeight: MIN_TAP,
    minWidth: MIN_TAP,
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginVertical: -space.sm,
  },
  conflictDismiss: { fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 12 },
  footerNote: { fontFamily: FONT.displayRegular, fontSize: 14, textAlign: 'center' },
  footerRetry: {
    alignSelf: 'center',
    minHeight: MIN_TAP,
    paddingHorizontal: 16,
    borderRadius: BUTTON_RADIUS.sm,
    borderWidth: 1,
    justifyContent: 'center',
  },
  linkedNote: { fontFamily: FONT.displayRegular, fontSize: 12, marginBottom: space.sm },
  linkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  linkFrame: { minHeight: MIN_TAP, justifyContent: 'center', flexShrink: 1 },
  linkChip: {
    minHeight: 24,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    flexShrink: 1,
  },
  linkChipText: { fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 12 },
  destination: { fontFamily: FONT.displayRegular, fontSize: 13, marginTop: 4 },
  destinationPending: { fontFamily: FONT.displayRegular, fontSize: 12, marginTop: 4 },
});

import {
  GROUP_COPY,
  GROUPING_ERROR_TABLE,
  GROUPING_ERROR_WORDS,
  GROUPING_MAX_ITEMS,
  groupingPreviewKey,
  groupingRecordLine,
  indexDisplayGroupMemberships,
  randomRequestUuid,
  type DisplayGroupMembershipRow,
  type DisplayGroupRef,
  type GroupingBody,
  type GroupingOutcome,
  type GroupingPreview,
  type GroupingPreviewRecord,
} from '@stockpilot/core';

import { api, ApiError } from './api';
import { CONNECTION_FAILURE_COPY } from './connection-copy';
import type { PageResult } from './id-batches';
import { fetchAllRows } from './paginate';

/**
 * Group selected on the phone (migration 0400): the Items and Books lists show
 * an explicit display group's records under one header, the shared select bar
 * offers Group, the review screen (app/group-selected.tsx) groups them, and the
 * item screen names a record's group and offers Remove from group.
 *
 * A display group only shows records together. It never changes a SKU,
 * barcode or ISBN, charter, rack, stock or product family, and nothing else
 * reads it (orders, exchanges, PO matching, reports and exports never do).
 *
 * MEMBERSHIP is read next to the list's rows, never from inventory_items: a
 * membership lives in item_display_group_members, readable exactly when its
 * record is (RLS), and a group's name comes through a readable live record. A
 * failed read is decoration lost, never a failed list: the rows render
 * ungrouped, which is honest (no header claims records it could not confirm).
 *
 * WRITES are ONLINE ONLY, through the web's own service: POST
 * /api/v1/items/grouping/preview (reads only, so Cancel writes nothing) and
 * POST /api/v1/items/grouping (apply_item_grouping). They are never queued:
 * the review is the point, and a grouping decided later against records that
 * moved since could surprise the person. One key per body, kept for every
 * retry of that body (busy, a lost answer): the database replays the first
 * outcome instead of making a second group.
 */

/** The one key between the two tables, named so the embed is never
 *  ambiguous (PGRST201). The web's readers use the same select. */
export const MEMBERSHIP_SELECT =
  'item_id, group_id, item_display_groups!item_display_group_members_group_fk(id, name, version)';

/** A minimal Supabase client shape, so this module stays testable (the
 *  screens pass `supabase as never`, the tests a recording fake). Each read
 *  names its table and select right at `.from(...).select(...)`, so the
 *  PostgREST embed guard (apps/web/src/test/postgrest-embeds.guard.test.ts)
 *  resolves the embed and checks it against the relationship snapshot. */
interface MembershipClient {
  from: (table: string) => MembershipQuery;
}

interface MembershipQuery {
  select: (cols: string) => MembershipQuery;
  eq: (c: string, v: unknown) => MembershipQuery;
  order: (c: string, o: { ascending: boolean }) => MembershipQuery;
  range: (from: number, to: number) => PromiseLike<PageResult<DisplayGroupMembershipRow>>;
  limit: (n: number) => PromiseLike<PageResult<DisplayGroupMembershipRow>>;
}

/**
 * Every membership of the organization the member may read, with each open
 * group's name and version, by record id. The lists hold their whole filtered
 * set, so they read the organization's memberships whole too (paged past the
 * 1000-row cap) and core's display rule decides the headers. Never throws.
 */
export async function readDisplayGroups(
  client: MembershipClient,
  organizationId: string,
): Promise<Map<string, DisplayGroupRef>> {
  try {
    const rows = await fetchAllRows<DisplayGroupMembershipRow>((from, to) =>
      client
        .from('item_display_group_members')
        .select(MEMBERSHIP_SELECT)
        .eq('organization_id', organizationId)
        .order('item_id', { ascending: true })
        .range(from, to),
    );
    return indexDisplayGroupMemberships(rows);
  } catch (e) {
    console.warn(
      '[display-groups] membership read failed; rows render ungrouped:',
      e instanceof Error ? e.message : String(e),
    );
    return new Map();
  }
}

/** One record's group (the item screen), or null: none, or the read failed
 *  (the screen then says nothing). */
export async function readItemDisplayGroup(
  client: MembershipClient,
  organizationId: string,
  itemId: string,
): Promise<DisplayGroupRef | null> {
  try {
    const { data, error } = await client
      .from('item_display_group_members')
      .select(MEMBERSHIP_SELECT)
      .eq('organization_id', organizationId)
      .eq('item_id', itemId)
      .limit(1);
    if (error) return null;
    return indexDisplayGroupMemberships(data ?? []).get(itemId) ?? null;
  } catch {
    return null;
  }
}

/** Display group fields as the list rows carry them (the web's names). */
export interface DisplayGroupFields {
  display_group_id: string | null;
  display_group_name: string | null;
  display_group_version: number | null;
}

/** Rows with their display group attached (nulls when none or unknown). */
export function attachDisplayGroups<T extends { id: string }>(
  rows: readonly T[],
  groups: ReadonlyMap<string, DisplayGroupRef>,
): (T & DisplayGroupFields)[] {
  return rows.map((r) => {
    const g = groups.get(r.id);
    return {
      ...r,
      display_group_id: g?.id ?? null,
      display_group_name: g?.name ?? null,
      display_group_version: g?.version ?? null,
    };
  });
}

// ── A change elsewhere ─────────────────────────────────────────────────────
// After a Save the lists re-read memberships only (never the records: a
// display group changes nothing on them), so a group shows on return.

const changeListeners = new Set<() => void>();

/** Called after a grouping applied; answers an unsubscribe. */
export function onDisplayGroupsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export function notifyDisplayGroupsChanged(): void {
  for (const l of [...changeListeners]) l();
}

// ── A row's accessibility actions (people review P4) ──────────────────────
// A Pressable nested inside the row's Pressable is not its own element for
// VoiceOver (RN's Pressable is accessible), so "Add to group" could not be
// reached. The row carries it as an action instead: swipe up or down to it,
// double tap to run it. 'activate' is listed and handled explicitly, so a
// double tap on the row still does exactly what a tap on the row does.

export const ADD_TO_GROUP_ACTION = 'addToGroup';

/** The row's accessibility actions, or undefined when it offers no Add to
 *  group (the row then behaves as it always did). */
export function groupRowAccessibilityActions(
  canAddToGroup: boolean,
): { name: string; label?: string }[] | undefined {
  return canAddToGroup
    ? [{ name: 'activate' }, { name: ADD_TO_GROUP_ACTION, label: GROUP_COPY.addToGroup }]
    : undefined;
}

/** Runs the row action VoiceOver or TalkBack asked for; nothing for another. */
export function runGroupRowAccessibilityAction(
  actionName: string,
  on: { activate: () => void; addToGroup: () => void },
): void {
  if (actionName === ADD_TO_GROUP_ACTION) on.addToGroup();
  else if (actionName === 'activate') on.activate();
}

// ── The review's announcements (people review P11) ────────────────────────

export type ReviewLoadState =
  | { kind: 'loading' }
  | { kind: 'offline' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; records: number };

/**
 * What the review announces when its load state changes (iOS ignores
 * accessibilityLiveRegion, so VoiceOver heard nothing when the review loaded
 * or failed): the records ready to review, the failure's own words, or the
 * offline words; nothing when nothing changed or while loading.
 */
export function reviewAnnouncement(prev: ReviewLoadState, next: ReviewLoadState): string | null {
  if (next.kind === 'failed')
    return prev.kind === 'failed' && prev.message === next.message ? null : next.message;
  if (next.kind === 'offline') return prev.kind === 'offline' ? null : GROUP_COPY.offline;
  if (next.kind === 'ready')
    return prev.kind === 'ready' ? null : GROUP_COPY.reviewReady(next.records);
  return null;
}

// ── A header's count (people review P5) ────────────────────────────────────

/** Whether the list is narrowed: a search or a filter (a stock view, a
 *  category, a location, a charter). A sort does not narrow. One rule with
 *  the web's: an explicit header then says "N matching". */
export function listIsNarrowed(
  query: string,
  filter: {
    status: string;
    categoryIds: readonly string[];
    locationIds: readonly string[];
    charterIds: readonly string[];
  },
): boolean {
  return (
    query.trim() !== '' ||
    filter.status !== 'all' ||
    filter.categoryIds.length > 0 ||
    filter.locationIds.length > 0 ||
    filter.charterIds.length > 0
  );
}

// ── The select bar ─────────────────────────────────────────────────────────

/**
 * Whether the picks can be grouped, before the review opens: two or more
 * DISTINCT records (the shared selection holds ids, one per record), of one
 * type (the selection spans the Items and Books tabs), at most 100. The words
 * are core's, the same as the web bulk bar.
 */
export function phoneGroupingCheck(
  picks: readonly { id: string; itemType: string }[],
): { ok: true; view: 'items' | 'books' } | { ok: false; message: string } {
  const byId = new Map<string, string>();
  for (const p of picks) if (!byId.has(p.id)) byId.set(p.id, p.itemType);
  const types = new Set(byId.values());
  if (types.size > 1) return { ok: false, message: GROUPING_ERROR_WORDS.mixedTypes };
  if (byId.size < 2) return { ok: false, message: GROUP_COPY.blocked.tooFew };
  if (byId.size > GROUPING_MAX_ITEMS)
    return { ok: false, message: GROUPING_ERROR_WORDS.groupTooMany };
  return { ok: true, view: types.has('book') ? 'books' : 'items' };
}

// ── The review screen's route ──────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where the select bar and "Add to group" send the person. */
export function groupSelectedHref(args: {
  itemIds: readonly string[];
  view: 'items' | 'books';
  groupId?: string | null;
}): { pathname: '/group-selected'; params: Record<string, string> } {
  return {
    pathname: '/group-selected',
    params: {
      ids: [...new Set(args.itemIds)].join(','),
      view: args.view,
      ...(args.groupId ? { groupId: args.groupId } : {}),
    },
  };
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** A selection the Group review can review, read from its route. */
export interface GroupSelectedParams {
  itemIds: string[];
  view: 'items' | 'books';
  groupId: string | null;
}

/** The review screen's params, or null when they are not a selection it can
 *  review (the screen then says so instead of guessing). */
export function readGroupSelectedParams(p: {
  ids?: string | string[];
  view?: string | string[];
  groupId?: string | string[];
}): GroupSelectedParams | null {
  const raw = one(p.ids) ?? '';
  const ids = [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length < 1 || ids.length > GROUPING_MAX_ITEMS || !ids.every((id) => UUID.test(id)))
    return null;
  const view = one(p.view);
  if (view !== 'items' && view !== 'books') return null;
  const gid = one(p.groupId);
  if (gid !== undefined && gid !== '' && !UUID.test(gid)) return null;
  return { itemIds: ids, view, groupId: gid ? gid : null };
}

/**
 * Which review the route asks for (redesign Stage 6, F8). expo-router REUSES
 * the review screen when a link to /group-selected arrives while it is on
 * top, swapping only the params, and the review held the records it first
 * opened with in its own state: the books link said BOOKS · GROUP over the
 * items link's Pencils #2 HB and Glue Sticks. The screen mounts its review
 * under this key, so other records, another list or another target group
 * start a fresh review (records, name, choices, acknowledgement, result,
 * error), and params that name the same selection keep the person's edits
 * (the review holds the params it was mounted with, so they never preview
 * the records again). Ids compare as records do: in any order and any case.
 */
export function groupSelectedReviewKey(params: GroupSelectedParams | null): string {
  if (!params) return 'invalid';
  return JSON.stringify([
    params.view,
    params.groupId?.toLowerCase() ?? null,
    [...new Set(params.itemIds.map((id) => id.toLowerCase()))].sort(),
  ]);
}

/**
 * The records Try again reviews after a failed review (recheck R2-4): the
 * ones under review, or the ones the screen opened with when there are more
 * than one request takes (GROUPING_MAX_ITEMS), since that request could only
 * fail again. The screen's own "Add them to the selection" stays within the
 * cap; this keeps the way out if anything else ever pushes it past.
 */
export function reviewIdsForRetry(current: string[], opened: readonly string[]): string[] {
  return current.length > GROUPING_MAX_ITEMS ? [...opened] : current;
}

// ── The review ─────────────────────────────────────────────────────────────

/** A selected record as the review shows it: the preview's facts (read as the
 *  member) plus its charter, warehouse, rack line and picture. */
export interface PhoneGroupingRecord extends GroupingPreviewRecord {
  charterName: string | null;
  warehouseName: string | null;
  placementLabel: string | null;
  imageUrl: string | null;
}

export interface PhoneGroupingReview extends Omit<GroupingPreview, 'records'> {
  records: PhoneGroupingRecord[];
  previewKey: string;
}

export interface GroupingIdentity {
  organizationId: string;
  actorUserId: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const idsOk = (v: unknown): v is { id: string }[] =>
  Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === 'string');

const UNREADABLE = 'The answer could not be read.';

/**
 * The review for these records (and the target group, when one is chosen),
 * under the record's organization and ONLY the signed-in account. Reads only.
 * The answer must be for this organization and this selection: anything else
 * is refused rather than shown.
 */
export async function previewGrouping(args: {
  itemIds: readonly string[];
  groupId: string | null;
  organizationId: string;
  actorUserId: string;
}): Promise<{ review: PhoneGroupingReview; identity: GroupingIdentity }> {
  const raw = (await api('/api/v1/items/grouping/preview', {
    method: 'POST',
    body: { itemIds: [...args.itemIds], groupId: args.groupId },
    orgId: args.organizationId,
    asUserId: args.actorUserId,
  })) as unknown;
  if (!isObj(raw) || typeof raw.organizationId !== 'string' || typeof raw.actorUserId !== 'string')
    throw new Error(UNREADABLE);
  if (raw.organizationId.toLowerCase() !== args.organizationId.toLowerCase())
    throw new Error('The answer came from another organization.');
  if (raw.actorUserId.toLowerCase() !== args.actorUserId.toLowerCase())
    throw new Error(GROUPING_ERROR_WORDS.actorMismatch);
  const r = raw.review;
  if (!isObj(r) || !idsOk(r.records)) throw new Error(UNREADABLE);
  if (r.previewKey !== groupingPreviewKey(raw.organizationId, args.itemIds, args.groupId))
    throw new Error(UNREADABLE);
  const review: PhoneGroupingReview = {
    records: r.records as PhoneGroupingRecord[],
    unavailableCount: typeof r.unavailableCount === 'number' ? r.unavailableCount : 0,
    sameSkuSiblings: idsOk(r.sameSkuSiblings)
      ? (r.sameSkuSiblings as PhoneGroupingReview['sameSkuSiblings'])
      : [],
    candidateGroups: idsOk(r.candidateGroups)
      ? (r.candidateGroups as PhoneGroupingReview['candidateGroups'])
      : [],
    targetGroup:
      isObj(r.targetGroup) && typeof r.targetGroup.id === 'string'
        ? ({
            ...r.targetGroup,
            members: idsOk(r.targetGroup.members) ? r.targetGroup.members : [],
          } as PhoneGroupingReview['targetGroup'])
        : null,
    previewKey: r.previewKey,
  };
  return {
    review,
    identity: { organizationId: raw.organizationId, actorUserId: raw.actorUserId },
  };
}

/** The pending body of a Save: one key per body, kept for its retries. */
export interface PendingGroupingBody {
  json: string;
  body: GroupingBody;
}

/** The body to send: the pending one when the draft is unchanged (a retry
 *  keeps its key), else the draft with a fresh key. */
export function keyedGroupingBody(
  pending: PendingGroupingBody | null,
  draft: GroupingBody,
  mint: () => string = randomRequestUuid,
): PendingGroupingBody {
  const json = JSON.stringify({ ...draft, idempotencyKey: undefined });
  if (pending && pending.json === json) return pending;
  return { json, body: { ...draft, idempotencyKey: mint() } };
}

/**
 * Send a grouping (group, remove or rename), under the body's organization and
 * ONLY the signed-in account (api's asUserId: a request left by another
 * account on a shared phone never leaves). Throws ApiError for a refusal
 * (describeGroupingError words it).
 */
export async function postGrouping(body: GroupingBody): Promise<GroupingOutcome> {
  const raw = (await api('/api/v1/items/grouping', {
    method: 'POST',
    body,
    orgId: body.organizationId,
    asUserId: body.actorUserId,
  })) as unknown;
  if (!isObj(raw) || typeof raw.organizationId !== 'string' || !isObj(raw.result))
    throw new Error(UNREADABLE);
  if (raw.organizationId.toLowerCase() !== body.organizationId.toLowerCase())
    throw new Error('The answer came from another organization.');
  const o = raw.result;
  if (
    (o.action !== 'group' && o.action !== 'remove' && o.action !== 'rename') ||
    (o.outcome !== 'applied' && o.outcome !== 'noop') ||
    !Array.isArray(o.changes)
  )
    throw new Error(UNREADABLE);
  return o as unknown as GroupingOutcome;
}

/**
 * The words for a failed attempt, and whether the SAME body and key may be
 * sent again (busy, a rate limit, or no answer at all: if it did arrive, the
 * retry replays it). Anything else needs a new look at the records. Never a
 * raw code or a network error's text.
 */
export function describeGroupingError(e: unknown): { message: string; retrySame: boolean } {
  if (e instanceof ApiError) {
    const details = e.details as { reason?: unknown } | undefined;
    const reason = typeof details?.reason === 'string' ? details.reason : null;
    if (e.status === 401)
      return { message: GROUPING_ERROR_WORDS.unauthenticated, retrySame: false };
    if (e.status === 429) return { message: GROUPING_ERROR_WORDS.rateLimited, retrySame: true };
    if (e.status >= 500 && e.status !== 503)
      return { message: GROUPING_ERROR_WORDS.internal, retrySame: false };
    const sentence = e.message && !/^[a-z0-9_]+$/.test(e.message) ? e.message : null;
    const fromTable = reason ? GROUPING_ERROR_TABLE[reason]?.message : undefined;
    const retrySame = reason === 'busy' || e.status === 503;
    return { message: sentence ?? fromTable ?? GROUPING_ERROR_WORDS.internal, retrySame };
  }
  if (e instanceof Error && e.message === GROUPING_ERROR_WORDS.actorMismatch)
    return { message: e.message, retrySame: false };
  if (e instanceof Error && e.message === UNREADABLE)
    return { message: GROUPING_ERROR_WORDS.internal, retrySame: false };
  if (e instanceof Error && e.message === 'The answer came from another organization.')
    return { message: GROUPING_ERROR_WORDS.workspaceChanged, retrySame: false };
  return { message: CONNECTION_FAILURE_COPY, retrySame: true };
}

/**
 * One record's line in the review: its identifiers (a book's ISBN), size,
 * charter, rack, warehouse and on hand. Core's line, the one the web dialog
 * says ("No charter" only for a record with none, recheck R2-6).
 */
export function reviewRecordDetail(r: PhoneGroupingRecord, view: 'items' | 'books'): string {
  return groupingRecordLine(r, view);
}

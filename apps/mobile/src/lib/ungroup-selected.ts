import {
  GROUPING_ERROR_WORDS,
  GROUPING_MAX_ITEMS,
  groupingPreviewKey,
  parseUngroupSelectedOutcome,
  ungroupOfferKind,
  type SplitCandidate,
  type UngroupKind,
  type UngroupSelectedBody,
  type UngroupSelectedOutcome,
} from '@stockpilot/core';

import { api } from './api';
import type { GroupingIdentity, PhoneGroupingReview } from './display-groups';
import type { CountPick } from './use-count-selection';

/**
 * Ungroup anything on the phone (owner 2026-10-12, verbatim: "im supposed to
 * be able to check box whatever item and then group or ungroup it that was
 * the point."). The shared select bar offers Ungroup for ticked records with
 * something to leave; the review screen (app/ungroup-selected.tsx) lists every
 * ticked record with what happens to it (core planUngroupSelected, the web's
 * rule and words), and Save sends one body to POST
 * /api/v1/items/ungroup-selected, the web's own service: a record leaves its
 * display group, gets its own SKU, or leaves its size family, by the grouping
 * it is shown under on the list.
 *
 * ONLINE ONLY, never queued (the review is the point). Each keyed step's key
 * is minted once per body and kept for a retry of it, so the database replays
 * instead of applying twice.
 */

/** A minimal pick for the bar check: what the list knew when it was ticked. */
type UngroupPick = Pick<CountPick, 'id' | 'grouping'>;

/**
 * The select bar offers Ungroup: someone who can edit items, at least one
 * ticked record with something to leave that they may undo (core
 * ungroupOfferKind: a display group, a shared SKU, or a size family for
 * someone who may unlink one: sports:manage with the sports module on).
 */
export function phoneUngroupOffer(
  picks: readonly UngroupPick[],
  can: { editItems: boolean; unlinkFamilies: boolean },
): boolean {
  if (!can.editItems) return false;
  return picks.some((p) => {
    const g = p.grouping;
    if (!g) return false;
    return (
      ungroupOfferKind(
        { inGroup: !!g.displayGroupId, sharesSku: g.sharesSku, inFamily: !!g.familyId },
        g.shownUnder,
        can.unlinkFamilies,
      ) !== null
    );
  });
}

/** Before the review opens: one request takes at most 100 records. */
export function phoneUngroupCheck(
  picks: readonly { id: string; itemType: string }[],
): { ok: true; view: 'items' | 'books' } | { ok: false; message: string } {
  const ids = new Set(picks.map((p) => p.id));
  if (ids.size > GROUPING_MAX_ITEMS) return { ok: false, message: GROUPING_ERROR_WORDS.tooMany };
  // A review of books only reads them as books (ISBN, no size); any item
  // makes it the Items reading, where a book still shows its ISBN.
  return { ok: true, view: picks.every((p) => p.itemType === 'book') ? 'books' : 'items' };
}

// ── The review screen's route ──────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_LETTER: Record<UngroupKind, string> = { group: 'g', sku: 's', family: 'f' };
const LETTER_KIND: Record<string, UngroupKind> = { g: 'group', s: 'sku', f: 'family' };

/** Where the select bar sends the member: every ticked record, and where each
 *  is shown on the list (one letter per id: g, s, f, or - for none). */
export function ungroupSelectedHref(args: {
  picks: readonly UngroupPick[];
  view: 'items' | 'books';
}): { pathname: '/ungroup-selected'; params: Record<string, string> } {
  const seen = new Set<string>();
  const ids: string[] = [];
  let under = '';
  for (const p of args.picks) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    ids.push(p.id);
    const k = p.grouping?.shownUnder ?? null;
    under += k ? KIND_LETTER[k] : '-';
  }
  return { pathname: '/ungroup-selected', params: { ids: ids.join(','), view: args.view, under } };
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** A selection the Ungroup review can review, read from its route. */
export interface UngroupSelectedParams {
  itemIds: string[];
  view: 'items' | 'books';
  shownUnder: Map<string, UngroupKind>;
}

/** The review screen's params, or null when they are not a selection it can
 *  review (the screen then says so instead of guessing). */
export function readUngroupSelectedParams(p: {
  ids?: string | string[];
  view?: string | string[];
  under?: string | string[];
}): UngroupSelectedParams | null {
  const ids = (one(p.ids) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    ids.length < 1 ||
    ids.length > GROUPING_MAX_ITEMS ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) => UUID.test(id))
  )
    return null;
  const view = one(p.view);
  if (view !== 'items' && view !== 'books') return null;
  const under = one(p.under) ?? '';
  if (under.length !== ids.length || !/^[gsf-]*$/.test(under)) return null;
  const shownUnder = new Map<string, UngroupKind>();
  ids.forEach((id, i) => {
    const k = LETTER_KIND[under[i]!];
    if (k) shownUnder.set(id, k);
  });
  return { itemIds: ids, view, shownUnder };
}

/**
 * Which review the route asks for (redesign Stage 6, F8), the Group review's
 * rule (groupSelectedReviewKey): expo-router REUSES this screen when a link
 * to /ungroup-selected arrives while it is on top, swapping only the params.
 * The screen mounts its review under this key, so other records, another
 * list or another grouping a record is shown under start a fresh review (a
 * refused Save's error stayed over the new records before), and params that
 * name the same selection keep the person's choices. Ids compare as records
 * do: in any order and any case.
 */
export function ungroupSelectedReviewKey(params: UngroupSelectedParams | null): string {
  if (!params) return 'invalid';
  return JSON.stringify([
    params.view,
    [
      ...new Set(
        params.itemIds.map((id) => `${id.toLowerCase()}:${params.shownUnder.get(id) ?? '-'}`),
      ),
    ].sort(),
  ]);
}

// ── The review and the Save ────────────────────────────────────────────────

export interface PhoneUngroupReview {
  review: PhoneGroupingReview;
  /** The server's UngroupCandidate: the rack facts name the other racks'
   *  records of a SKU leaving its family with a ticked one. */
  candidates: (SplitCandidate & {
    barcode: string | null;
    placementLabel?: string | null;
    warehouseName?: string | null;
    quantityOnHand?: number | null;
  })[];
  canUnlinkFamilies: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const idsOk = (v: unknown): v is { id: string }[] =>
  Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === 'string');

const UNREADABLE = 'The answer could not be read.';

/**
 * The review for these records, under the record's organization and ONLY the
 * signed-in account. Reads only. The answer must be for this organization,
 * this account and this selection: anything else is refused rather than shown.
 */
export async function previewUngroupSelected(args: {
  itemIds: readonly string[];
  organizationId: string;
  actorUserId: string;
}): Promise<PhoneUngroupReview & { identity: GroupingIdentity }> {
  const raw = (await api('/api/v1/items/ungroup-selected/preview', {
    method: 'POST',
    body: { itemIds: [...args.itemIds] },
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
  if (!isObj(r) || !idsOk(r.records) || !idsOk(raw.candidates)) throw new Error(UNREADABLE);
  const key = groupingPreviewKey(raw.organizationId, args.itemIds, null);
  if (raw.previewKey !== key || r.previewKey !== key) throw new Error(UNREADABLE);
  return {
    review: {
      records: r.records as PhoneGroupingReview['records'],
      unavailableCount: typeof r.unavailableCount === 'number' ? r.unavailableCount : 0,
      sameSkuSiblings: [],
      candidateGroups: idsOk(r.candidateGroups)
        ? (r.candidateGroups as PhoneGroupingReview['candidateGroups'])
        : [],
      targetGroup: null,
      previewKey: key,
    },
    candidates: raw.candidates as PhoneUngroupReview['candidates'],
    canUnlinkFamilies: raw.canUnlinkFamilies === true,
    identity: { organizationId: raw.organizationId, actorUserId: raw.actorUserId },
  };
}

/**
 * Send an Ungroup, under the body's organization and ONLY the signed-in
 * account. The answer names every step (applied, refused, partly applied,
 * not tried); a refusal before any write throws ApiError (describeGroupingError
 * words it).
 */
export async function postUngroupSelected(
  body: UngroupSelectedBody,
): Promise<UngroupSelectedOutcome> {
  const raw = (await api('/api/v1/items/ungroup-selected', {
    method: 'POST',
    body,
    orgId: body.organizationId,
    asUserId: body.actorUserId,
  })) as unknown;
  if (!isObj(raw) || typeof raw.organizationId !== 'string') throw new Error(UNREADABLE);
  if (raw.organizationId.toLowerCase() !== body.organizationId.toLowerCase())
    throw new Error('The answer came from another organization.');
  const outcome = parseUngroupSelectedOutcome(raw.result);
  if (!outcome) throw new Error(UNREADABLE);
  return outcome;
}

// ── A change elsewhere ─────────────────────────────────────────────────────
// An Ungroup can change a record's SKU or size family, not only its group, so
// the lists re-read their rows (and memberships with them) after one.

const listeners = new Set<() => void>();

/** Called after an Ungroup changed any record; answers an unsubscribe. */
export function onRecordsUngrouped(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyRecordsUngrouped(): void {
  for (const l of [...listeners]) l();
}

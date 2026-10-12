/**
 * The grouping contract, as the web, the phone and the database speak it
 * (design-merged.md sections 3 and 6). Slice G1 carries Ungroup (split_sku):
 * give a record that shares its SKU a fresh SKU of its own, changing that
 * record only (migration 0399, split_item_sku). Slice G2 (Group selected,
 * migration 0400, apply_item_grouping and item_grouping_preview) adds the
 * actions group, remove and rename below, with the same key space, error map
 * and words; nothing of G1's changed.
 *
 *   - the request body (camelCase, what the bearer route and the action
 *     accept), parsed with exactly the database's shape rules, and its
 *     snake_case form for split_item_sku;
 *   - the error map, by the database's hint, never by message text (pattern
 *     28): each refusal's service code, HTTP status and plain words;
 *   - the answer the function gives;
 *   - what the screens need: which selected rows share a SKU with another
 *     loaded row (the bulk bar), the review dialog's plan, and the words.
 *
 * Nothing here changes how rows are grouped for display (groupPlacementsBySku
 * is untouched): a SKU is shared when two or more distinct records carry the
 * same raw, non-blank SKU, the same key the display groups by.
 *
 * Plain literals and pure functions only: importing this module runs nothing.
 */

import { isbnSearchKeys } from '../books/isbn';

import { stripSizeSuffix } from './size-run';

/** Every grouping request names at most this many records (one `.in()`). */
export const GROUPING_MAX_ITEMS = 100;

/** The actions item_grouping_requests admits (0399). G1 uses split_sku. */
export const GROUPING_ACTIONS = ['group', 'remove', 'rename', 'split_sku'] as const;
export type GroupingAction = (typeof GROUPING_ACTIONS)[number];

/** Where a request came from: the web app or the phone app. */
export type GroupingSurface = 'web' | 'app';

/** A SKU the database mints for a split record: generateSku's shape. */
export const SPLIT_SKU_SHAPE = /^SP-[0-9A-Z]{5}-[0-9A-Z]{7}$/;

/** The longest SKU a request may name (the database refuses longer). */
export const SPLIT_SKU_MAX_LENGTH = 255;

/** split_item_sku's uuid test, character for character. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** The database's blank test ('^\s*$'). */
const BLANK = /^\s*$/;

// ── The request ────────────────────────────────────────────────────────────

/** An Ungroup request as the app sends it. */
export interface SplitSkuBody {
  /** Minted once per Save (randomRequestUuid) and kept for every retry of it. */
  idempotencyKey: string;
  /** The organization the screen was showing; the server refuses another. */
  organizationId: string;
  /** The signed-in user; a retry another account left on a shared device is refused. */
  actorUserId: string;
  /** The records to split, distinct, 1 to 100. */
  itemIds: string[];
  /** Each record's SKU as the screen showed it: a changed one is refused. */
  expectedSkus: Record<string, string>;
  /** Records that keep their SKU, at most one per SKU (only where every record
   *  of that SKU the caller can see is selected). */
  anchorItemIds: string[];
}

export type SplitSkuField =
  | 'body'
  | 'idempotency_key'
  | 'organization_id'
  | 'actor_user_id'
  | 'item_ids'
  | 'expected_skus'
  | 'anchor_item_ids';

export type SplitSkuParse =
  | { ok: true; body: SplitSkuBody }
  | { ok: false; refusal: { reason: 'invalid'; field: SplitSkuField; message: string } };

const BODY_KEYS = new Set([
  'idempotencyKey',
  'organizationId',
  'actorUserId',
  'itemIds',
  'expectedSkus',
  'anchorItemIds',
]);

function refuse(field: SplitSkuField): SplitSkuParse {
  return {
    ok: false,
    refusal: { reason: 'invalid', field, message: GROUPING_ERROR_WORDS.invalid },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The body, with exactly split_item_sku's shape rules (0399
 * _item_grouping_split_request), so the app refuses what the database would,
 * naming the same field. Ids come back lower case, in the order sent.
 */
export function parseSplitSkuBody(raw: unknown): SplitSkuParse {
  if (!isRecord(raw)) return refuse('body');
  for (const k of Object.keys(raw)) if (!BODY_KEYS.has(k)) return refuse('body');
  const { idempotencyKey, organizationId, actorUserId, itemIds, expectedSkus, anchorItemIds } = raw;
  if (typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey))
    return refuse('idempotency_key');
  if (typeof organizationId !== 'string' || !UUID.test(organizationId))
    return refuse('organization_id');
  if (typeof actorUserId !== 'string' || !UUID.test(actorUserId)) return refuse('actor_user_id');

  if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > GROUPING_MAX_ITEMS)
    return refuse('item_ids');
  if (!itemIds.every((id) => typeof id === 'string' && UUID.test(id))) return refuse('item_ids');
  const ids = (itemIds as string[]).map((id) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) return refuse('item_ids');

  if (!isRecord(expectedSkus)) return refuse('expected_skus');
  const expected: Record<string, string> = {};
  for (const [k, v] of Object.entries(expectedSkus)) {
    if (
      !UUID.test(k) ||
      typeof v !== 'string' ||
      BLANK.test(v) ||
      v.length > SPLIT_SKU_MAX_LENGTH
    ) {
      return refuse('expected_skus');
    }
    expected[k.toLowerCase()] = v;
  }
  if (
    Object.keys(expectedSkus).length !== ids.length ||
    Object.keys(expected).length !== ids.length
  ) {
    return refuse('expected_skus');
  }
  if (!ids.every((id) => Object.prototype.hasOwnProperty.call(expected, id)))
    return refuse('expected_skus');

  let anchors: string[] = [];
  if (anchorItemIds !== undefined && anchorItemIds !== null) {
    if (!Array.isArray(anchorItemIds) || anchorItemIds.length > GROUPING_MAX_ITEMS)
      return refuse('anchor_item_ids');
    if (!anchorItemIds.every((id) => typeof id === 'string' && UUID.test(id)))
      return refuse('anchor_item_ids');
    anchors = (anchorItemIds as string[]).map((id) => id.toLowerCase());
    if (new Set(anchors).size !== anchors.length) return refuse('anchor_item_ids');
    if (!anchors.every((id) => ids.includes(id))) return refuse('anchor_item_ids');
    if (new Set(anchors.map((id) => expected[id])).size !== anchors.length)
      return refuse('anchor_item_ids');
  }

  return {
    ok: true,
    body: {
      idempotencyKey: idempotencyKey.toLowerCase(),
      organizationId: organizationId.toLowerCase(),
      actorUserId: actorUserId.toLowerCase(),
      itemIds: ids,
      expectedSkus: expected,
      anchorItemIds: anchors,
    },
  };
}

/** The arguments of split_item_sku(p_request, p_key) for a parsed body. */
export function toSplitSkuRpcRequest(
  body: SplitSkuBody,
  surface: GroupingSurface,
): { p_request: Record<string, unknown>; p_key: string } {
  return {
    p_key: body.idempotencyKey,
    p_request: {
      action: 'split_sku',
      organization_id: body.organizationId,
      actor_user_id: body.actorUserId,
      surface,
      item_ids: body.itemIds,
      expected_skus: body.expectedSkus,
      anchor_item_ids: body.anchorItemIds,
    },
  };
}

// ── The errors ─────────────────────────────────────────────────────────────

export type GroupingServiceErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation_error'
  | 'conflict'
  | 'internal_error';

export interface GroupingErrorEntry {
  code: GroupingServiceErrorCode;
  status: number;
  message: string;
  /** The same body and key may be sent again. */
  retryable?: boolean;
}

/** The words a refusal shows, on the web and the phone. None of them tells
 *  anyone to change a charter or a rack to get around anything. */
export const GROUPING_ERROR_WORDS = {
  unauthenticated: 'Sign in again.',
  actorMismatch: 'This was started by another account on this device. Reload and try again.',
  notMember: "You aren't a member of this organization any more. Reload and try again.",
  workspaceChanged: 'This was started in another organization. Reload and try again.',
  permission: "You don't have permission to edit items.",
  notWritable:
    "You can't edit one or more of these records: they are in a warehouse you can't change.",
  notFound: "One or more of these records isn't available any more. Reload and try again.",
  invalid: 'Check the selection and try again.',
  tooMany: 'Ungroup works on at most 100 records at a time. Select fewer and try again.',
  keyRequired: 'Reload and try again.',
  idempotencyConflict:
    'This request was already sent with different details. Reload and try again.',
  itemChanged: "A record's SKU changed since you opened this. Review it again.",
  notShared: 'No other record you can see shares this SKU, so there is nothing to ungroup.',
  family:
    'This record belongs to a product family of linked sizes. Remove it from the family before giving it its own SKU.',
  kit: "Kits keep their SKU and can't be ungrouped.",
  notGroupable: "One or more of these records can't be ungrouped.",
  siblingsChanged:
    'The records that share this SKU changed since you opened this. Review it again.',
  skuGeneration: "A new SKU couldn't be made. Try again.",
  busy: 'Someone is changing these records right now. Try again in a moment.',
  rateLimited: 'Too many requests. Wait a minute and try again.',
  internal: 'Something went wrong. Try again.',
  // Group selected (0400). None asks anyone to change a charter or a rack.
  groupTooMany:
    'Group selected works on at most 100 records at a time. Select fewer and try again.',
  groupNotFound: "This group isn't available any more. Reload and try again.",
  groupChanged: 'This group changed since you opened this. Review it again.',
  membershipChanged: "A record's group changed since you opened this. Review it again.",
  membershipConflict:
    'One or more of these records are already in another group. Choose to move them, or leave them out.',
  familyConflict:
    'One or more of these records are in a product family of linked sizes. Confirm that the list may show them in this group.',
  mixedTypes: 'Group books and items separately.',
  groupTooLarge: 'A group can hold at most 200 records.',
  renameNotPermitted: 'Only a manager can rename this group.',
  groupKit: "Kits can't be grouped: a kit keeps its own items.",
  groupRental: "Rentals can't be grouped.",
  groupNotGroupable: "One or more of these records can't be grouped.",
  groupItemChanged: 'A record changed since you opened this. Review it again.',
} as const;

const W = GROUPING_ERROR_WORDS;

/** Hint -> entry (design 3.4: 401, 403, 404, 409, 400, 503 on 55P03). */
export const GROUPING_ERROR_TABLE: Readonly<Record<string, GroupingErrorEntry>> = {
  unauthenticated: { code: 'unauthenticated', status: 401, message: W.unauthenticated },
  actor_mismatch: { code: 'forbidden', status: 403, message: W.actorMismatch },
  not_member: { code: 'forbidden', status: 403, message: W.notMember },
  permission: { code: 'forbidden', status: 403, message: W.permission },
  item_not_writable: { code: 'forbidden', status: 403, message: W.notWritable },
  item_not_found: { code: 'not_found', status: 404, message: W.notFound },
  grouping_invalid: { code: 'validation_error', status: 400, message: W.invalid },
  idempotency_key_required: { code: 'validation_error', status: 400, message: W.keyRequired },
  idempotency_key_invalid: { code: 'validation_error', status: 400, message: W.keyRequired },
  idempotency_conflict: { code: 'conflict', status: 409, message: W.idempotencyConflict },
  item_changed: { code: 'conflict', status: 409, message: W.itemChanged },
  not_shared: { code: 'conflict', status: 409, message: W.notShared },
  family_member_sku: { code: 'conflict', status: 409, message: W.family },
  not_groupable: { code: 'conflict', status: 409, message: W.notGroupable },
  sku_siblings_changed: { code: 'conflict', status: 409, message: W.siblingsChanged },
  sku_generation_failed: {
    code: 'conflict',
    status: 409,
    message: W.skuGeneration,
    retryable: true,
  },
  busy: { code: 'conflict', status: 503, message: W.busy, retryable: true },
  // Group selected (0400).
  group_not_found: { code: 'not_found', status: 404, message: W.groupNotFound },
  group_changed: { code: 'conflict', status: 409, message: W.groupChanged },
  membership_changed: { code: 'conflict', status: 409, message: W.membershipChanged },
  membership_conflict: { code: 'conflict', status: 409, message: W.membershipConflict },
  product_family_conflict: { code: 'conflict', status: 409, message: W.familyConflict },
  mixed_item_types: { code: 'conflict', status: 409, message: W.mixedTypes },
  group_too_large: { code: 'conflict', status: 409, message: W.groupTooLarge },
  rename_not_permitted: { code: 'forbidden', status: 403, message: W.renameNotPermitted },
};

const BUSY: GroupingErrorEntry = GROUPING_ERROR_TABLE.busy!;
const INTERNAL: GroupingErrorEntry = { code: 'internal_error', status: 500, message: W.internal };

/** A PostgREST / Postgres error as supabase-js hands it back. */
export interface GroupingDbError {
  code?: string | null;
  hint?: string | null;
  message?: string | null;
  details?: string | null;
}

export interface MappedGroupingError extends GroupingErrorEntry {
  /** The hint that matched, `busy`, or `internal_error`. */
  reason: string;
  /** The record ids the refusal names (only ids the caller sent). */
  itemIds: string[];
  /** grouping_invalid's field. */
  field: string | null;
}

/** The key a refusal is mapped by: its hint, and nothing else. */
export function groupingErrorKey(err: GroupingDbError | null | undefined): string | null {
  const hint = (err?.hint ?? '').trim();
  return hint && Object.prototype.hasOwnProperty.call(GROUPING_ERROR_TABLE, hint) ? hint : null;
}

function parseDetail(details: string | null | undefined): Record<string, unknown> | null {
  const text = (details ?? '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The words for a hint when the action matters: the same refusal reads
 * differently for Ungroup (split_sku) and for grouping (a kit "keeps its SKU"
 * against "keeps its own items"; a changed record is a changed SKU for a
 * split, any change for a grouping).
 */
function messageFor(
  key: string,
  detail: Record<string, unknown> | null,
  action: GroupingAction,
): string {
  const entry = GROUPING_ERROR_TABLE[key]!;
  if (action === 'split_sku') {
    return key === 'not_groupable' && detail?.reason === 'kit' ? W.kit : entry.message;
  }
  if (key === 'not_groupable') {
    return detail?.reason === 'kit'
      ? W.groupKit
      : detail?.reason === 'rental'
        ? W.groupRental
        : W.groupNotGroupable;
  }
  if (key === 'item_changed') return W.groupItemChanged;
  return entry.message;
}

/**
 * One refusal -> its entry. Specific before general: a hint wins; 55P03 (a
 * held row, or the grouping lock's lock_timeout) and 57014 (statement
 * timeout) are busy only when no hint matched; anything else is internal,
 * with the generic sentence (the raw text stays server-side). `action` picks
 * the words where Ungroup and grouping differ (default: Ungroup's).
 */
export function mapGroupingError(
  err: GroupingDbError | null | undefined,
  action: GroupingAction = 'split_sku',
): MappedGroupingError {
  const key = groupingErrorKey(err);
  const detail = parseDetail(err?.details);
  const itemIds = Array.isArray(detail?.itemIds)
    ? (detail!.itemIds as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  if (key) {
    const entry = GROUPING_ERROR_TABLE[key]!;
    const message = messageFor(key, detail, action);
    const field = key === 'grouping_invalid' ? (err?.details ?? '').trim() || null : null;
    return { ...entry, message, reason: key, itemIds, field };
  }
  if (err?.code === '55P03' || err?.code === '57014')
    return { ...BUSY, reason: 'busy', itemIds: [], field: null };
  return { ...INTERNAL, reason: 'internal_error', itemIds: [], field: null };
}

// ── The answer ─────────────────────────────────────────────────────────────

export interface SplitSkuOutcomeItem {
  id: string;
  beforeSku: string;
  afterSku: string;
  /** This record kept the SKU (it was the anchor). */
  kept: boolean;
  /** The record that kept the SKU, when every record of it the caller could
   *  see was selected; null otherwise. */
  anchorItemId: string | null;
}

export interface SplitSkuOutcome {
  /** True when the key had already applied: nothing was written this time. */
  replay: boolean;
  items: SplitSkuOutcomeItem[];
}

/** split_item_sku's answer, or null when it is not one. */
export function parseSplitSkuOutcome(raw: unknown): SplitSkuOutcome | null {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return null;
  const items: SplitSkuOutcomeItem[] = [];
  for (const it of raw.items) {
    if (!isRecord(it)) return null;
    const { id, before_sku, after_sku, kept, anchor_item_id } = it;
    if (
      typeof id !== 'string' ||
      typeof before_sku !== 'string' ||
      typeof after_sku !== 'string' ||
      typeof kept !== 'boolean'
    ) {
      return null;
    }
    items.push({
      id,
      beforeSku: before_sku,
      afterSku: after_sku,
      kept,
      anchorItemId: typeof anchor_item_id === 'string' ? anchor_item_id : null,
    });
  }
  return { replay: raw.replay === true, items };
}

// ── What the screens need ──────────────────────────────────────────────────

/** A raw, non-blank SKU, the key the display groups by; null when blank. */
export function sharedSkuKey(sku: string | null | undefined): string | null {
  return typeof sku === 'string' && sku.trim() ? sku : null;
}

/**
 * The selected records that share their SKU with at least one other loaded
 * record (the bulk bar offers Ungroup for these). Facts come from loaded rows
 * only (design 5): `rows` may repeat a record (one row per rack); `fullCounts`
 * (distinct records per SKU over the whole view, when the page knows it) wins
 * when it is larger. In the selected order.
 */
export function sharedSkuItemIds(
  selectedIds: readonly string[],
  rows: ReadonlyArray<{ id: string; sku: string | null }>,
  fullCounts?: ReadonlyMap<string, number> | null,
): string[] {
  const idsBySku = new Map<string, Set<string>>();
  const skuOf = new Map<string, string>();
  for (const r of rows) {
    const k = sharedSkuKey(r.sku);
    if (!k) continue;
    skuOf.set(r.id, k);
    let set = idsBySku.get(k);
    if (!set) idsBySku.set(k, (set = new Set()));
    set.add(r.id);
  }
  return selectedIds.filter((id) => {
    const k = skuOf.get(id);
    if (!k) return false;
    return Math.max(idsBySku.get(k)?.size ?? 0, fullCounts?.get(k) ?? 0) >= 2;
  });
}

/** One live record the caller can read, for the review dialog. */
export interface SplitCandidate {
  id: string;
  sku: string;
  name: string;
  isBundle: boolean;
  /** In a product family (group_id set). */
  inFamily: boolean;
  [k: string]: unknown;
}

export type SplitLeftOutReason = 'not_found' | 'kit' | 'family' | 'not_shared';

export interface SplitPlanGroup<T extends SplitCandidate = SplitCandidate> {
  sku: string;
  /** The selected records of this SKU that will be sent, in the server order. */
  selected: T[];
  /** The other readable records of this SKU: they keep it. */
  others: T[];
  /** Every readable record of this SKU is selected: one of them keeps it. */
  allSelected: boolean;
  /** The record that keeps the SKU unless another is chosen: the first in the
   *  server order (oldest by created_at, then id), or null. */
  defaultAnchorId: string | null;
}

export interface SplitPlan<T extends SplitCandidate = SplitCandidate> {
  groups: Array<SplitPlanGroup<T>>;
  /** Selected records left out, with the reason the database would give. */
  leftOut: Array<{ id: string; reason: SplitLeftOutReason }>;
  /** The records the request names, in the server order. */
  splitIds: string[];
}

/**
 * The review dialog's plan for `selectedIds`, from `candidates`: every live
 * record of the selected records' SKUs that the caller can read, in the
 * server's order (created_at, then id: the order the database's "oldest
 * keeps" rule uses). The same rules as split_item_sku, so the dialog shows
 * what will happen: a record the caller cannot read, a kit, a family member
 * or a record no other readable record shares a SKU with is left out (in that
 * order of precedence), and the rest are planned per SKU.
 */
export function planSkuSplit<T extends SplitCandidate>(
  selectedIds: readonly string[],
  candidates: readonly T[],
): SplitPlan<T> {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const countBySku = new Map<string, number>();
  for (const c of candidates) {
    const k = sharedSkuKey(c.sku);
    if (k) countBySku.set(k, (countBySku.get(k) ?? 0) + 1);
  }
  const leftOut: SplitPlan['leftOut'] = [];
  const sent = new Set<string>();
  for (const id of selectedIds) {
    const c = byId.get(id);
    const k = c ? sharedSkuKey(c.sku) : null;
    if (!c) leftOut.push({ id, reason: 'not_found' });
    else if (c.isBundle) leftOut.push({ id, reason: 'kit' });
    else if (c.inFamily) leftOut.push({ id, reason: 'family' });
    else if (!k || (countBySku.get(k) ?? 0) < 2) leftOut.push({ id, reason: 'not_shared' });
    else sent.add(id);
  }
  const groups: Array<SplitPlanGroup<T>> = [];
  const groupBySku = new Map<string, SplitPlanGroup<T>>();
  const splitIds: string[] = [];
  for (const c of candidates) {
    if (!sent.has(c.id)) continue;
    splitIds.push(c.id);
    let g = groupBySku.get(c.sku);
    if (!g) {
      g = { sku: c.sku, selected: [], others: [], allSelected: false, defaultAnchorId: null };
      groupBySku.set(c.sku, g);
      groups.push(g);
    }
    g.selected.push(c);
  }
  for (const g of groups) {
    g.others = candidates.filter((c) => c.sku === g.sku && !sent.has(c.id));
    g.allSelected = g.others.length === 0;
    g.defaultAnchorId = g.allSelected ? (g.selected[0]?.id ?? null) : null;
  }
  return { groups, leftOut, splitIds };
}

/**
 * The request for a plan. `anchorBySku` is the dialog's choice per SKU; a SKU
 * whose every readable record is selected always sends its anchor (the choice,
 * else the default), so the database never decides one the screen did not
 * show.
 */
export function splitSkuBodyForPlan(
  plan: SplitPlan,
  anchorBySku: Readonly<Record<string, string>>,
  ids: { idempotencyKey: string; organizationId: string; actorUserId: string },
): SplitSkuBody {
  const expectedSkus: Record<string, string> = {};
  const anchorItemIds: string[] = [];
  for (const g of plan.groups) {
    for (const r of g.selected) expectedSkus[r.id] = r.sku;
    if (g.allSelected) {
      const chosen = anchorBySku[g.sku];
      const anchor = chosen && g.selected.some((r) => r.id === chosen) ? chosen : g.defaultAnchorId;
      if (anchor) anchorItemIds.push(anchor);
    }
  }
  return { ...ids, itemIds: [...plan.splitIds], expectedSkus, anchorItemIds };
}

/** The words of the Ungroup dialog and the item screens. */
export const UNGROUP_COPY = {
  bulkAction: 'Ungroup',
  makeOwnItem: 'Make this its own item',
  title: 'Ungroup records that share a SKU',
  intro:
    'Ungroup gives each selected record its own new SKU. Only the selected records change. Stock, charter, rack, barcode/ISBN and history stay as they are.',
  getsNewSku: 'Gets a new SKU',
  keepsSku: (sku: string) => `Keeps SKU ${sku}`,
  othersKeep: (n: number, sku: string) =>
    `${n} other record${n === 1 ? '' : 's'} you can see keep${n === 1 ? 's' : ''} SKU ${sku}.`,
  anchorLegend: 'Every record you can see with this SKU is selected. Choose the one that keeps it:',
  barcodeNote:
    'Each record keeps its barcode/ISBN. When two records share a barcode, scanning it asks which one you mean.',
  leftOutReason: {
    not_found: "isn't available any more",
    kit: 'is a kit (kits keep their SKU)',
    family: 'is in a product family',
    not_shared: 'already has a SKU no other record you can see shares',
  } as Record<SplitLeftOutReason, string>,
  confirm: (n: number) => `Ungroup ${n} record${n === 1 ? '' : 's'}`,
  done: (n: number) =>
    `${n} record${n === 1 ? '' : 's'} now ${n === 1 ? 'has its' : 'have their'} own SKU.`,
  labelsHint: 'Labels without a barcode print the SKU. Reprint them for the records that changed.',
  /** Before Save, when a record that gets a new SKU has no barcode: its label
   *  prints the old SKU, so a scan of it finds the records that keep it. */
  labelsBefore:
    "Labels without a barcode print the SKU: until a changed record's label is reprinted, scanning it finds the records that keep the old SKU.",
  /** After Save, for a record the review said would get a new SKU but the
   *  database let keep it (the other records of its SKU changed meanwhile). */
  keptUnplanned: (sku: string) =>
    `Kept SKU ${sku}: the other records that had it changed since you opened this, so this one keeps it.`,
  offline: 'Making a record its own item needs a connection. Try again when you are online.',
  confirmOne:
    'This record gets its own new SKU. Only this record changes. Stock, charter, rack, barcode/ISBN and history stay as they are.',

  // ── Ungroup anything (owner 2026-10-12): the bulk bar's Ungroup for any
  // ticked records, on the web and the phone. Each record leaves the grouping
  // it shows under on the list (planUngroupSelected).
  selectedTitle: 'Ungroup the selected records',
  selectedIntro:
    'Each record leaves the grouping it shows under on the list: its group, the SKU it shares, or its size family. Stock, charter, rack, barcode/ISBN and history stay as they are.',
  /** What happens to a record that shares its SKU (split_item_sku). */
  getsOwnSku: 'Gets its own SKU',
  /** What happens to a record in a display group (apply_item_grouping remove). */
  leavesGroup: (name: string) => `Leaves group ${name}`,
  /** What happens to a record in a size family (unlinkItems). */
  leavesFamily: (name: string | null) =>
    name ? `Leaves the ${name} size family` : 'Leaves its size family',
  /** Said once when any record leaves a size family: the Returns exchange
   *  consequence, in plain words (exchanges offer a family's sizes for one
   *  another: 0396 exchange options and requester sizes read group_id). */
  familyNote:
    "A record taken out of its size family is no longer offered in Returns as an exchange for the family's other sizes, and they are no longer offered for it. Its SKU, stock, charter, rack and history stay as they are.",
  /** Why a ticked record is left out of an Ungroup. */
  selectedLeftOutReason: {
    kit: 'is a kit (kits keep their SKU and are never in a group)',
    nothing:
      'has nothing to ungroup: it is in no group or size family, and no other record you can see shares its SKU',
    not_writable: "is in a warehouse you can't change",
    family_permission:
      'is in a size family, and taking a record out of one needs permission to manage sports products',
    family_sku:
      'shares its SKU but is in a size family of linked sizes, so it keeps its SKU. Unlink it under Product groups first',
  } as Record<UngroupSelectedLeftOutReason, string>,
  /** The result lines, one per kind, counting the records that changed. */
  leftGroups: (n: number) =>
    `${n} record${n === 1 ? '' : 's'} left ${n === 1 ? 'its' : 'their'} group.`,
  leftFamilies: (n: number) =>
    `${n} record${n === 1 ? '' : 's'} left ${n === 1 ? 'its' : 'their'} size family.`,
  /** A step that was refused or not tried, after an earlier one applied. */
  partWhat: (kind: UngroupPartKind, n: number) => {
    const records = `${n} record${n === 1 ? '' : 's'}`;
    return kind === 'remove'
      ? `${records} leaving ${n === 1 ? 'its' : 'their'} group`
      : kind === 'split'
        ? `${records} getting ${n === 1 ? 'its' : 'their'} own SKU`
        : `${records} leaving ${n === 1 ? 'its' : 'their'} size family`;
  },
  partNotDone: (what: string, message: string) => `Not done: ${what}. ${message}`,
  partNotTried: (what: string) =>
    `Not tried: ${what}, because the step before it was not done. Review again to see where each record is now.`,
  /** The bulk Ungroup needs a connection (the web when offline, the phone). */
  selectedOffline: 'Ungroup needs a connection. Try again when you are online.',
  /** Nothing in the selection can be ungrouped by this person. */
  selectedNothing: 'None of the selected records has a grouping you can undo.',
  familyChanged: "A record's size family changed since you opened this. Review it again.",
  /** Taking records out of their families stopped and where each one is
   *  now could not be read back: say so, never guess. */
  unlinkUnknown:
    'Some of these records may have left their size family before this stopped. Review again to see where each one is now.',
  familyPermission:
    'Taking a record out of a size family needs permission to manage sports products.',
  /** The audit row's reason for an unlink made by Ungroup. */
  unlinkReason: (surface: GroupingSurface) =>
    `Taken out of its size family with Ungroup (${surface === 'web' ? 'web' : 'mobile app'})`,
} as const;

/**
 * Every field an edit of a record copies to the other records of its SKU, in
 * plain words: InventoryService SHARED_ITEM_FIELDS, the variant details
 * (width, fit, color, jersey number, the variant key) and the product-family
 * link among them. The edit form's banner and the item screens' note both
 * read it, so they always name the same fields (fix round 2, R2-3).
 */
export const SHARED_SKU_FIELDS_WORDS =
  'the name, SKU, cost, price, description, category, barcode, reorder levels, item type, size and other variant details, or product family';

/** Why a record keeps its SKU on an Ungroup: a kit, or a product-family
 *  member (the database refuses both: not_groupable kit, family_member_sku). */
export type SharedSkuKeeps = 'kit' | 'family' | null;

/**
 * The edit form's banner when other records the caller can see share the
 * SKU (the seed's wording item): how many, which fields are shared (every
 * field the edit fans out: InventoryService SHARED_ITEM_FIELDS, the variant
 * details and the family link among them), and how to change one record
 * alone, or, for a kit or a family member, why it cannot be. Null when no
 * other record shares it. It never counts records the caller cannot see.
 */
export function sharedSkuBannerCopy(
  othersVisible: number,
  keeps: SharedSkuKeeps = null,
): string | null {
  if (!Number.isFinite(othersVisible) || othersVisible < 1) return null;
  const n = Math.floor(othersVisible);
  const tail =
    keeps === 'kit'
      ? GROUPING_ERROR_WORDS.kit
      : keeps === 'family'
        ? GROUPING_ERROR_WORDS.family
        : `To change only this record, use ${UNGROUP_COPY.makeOwnItem} on the item page.`;
  return `This SKU is also used by ${n} other record${n === 1 ? '' : 's'} you can see. Saving ${SHARED_SKU_FIELDS_WORDS} changes every record with this SKU. ${tail}`;
}

/** The item screens' note next to Make this its own item (web item page and
 *  the phone's item screen): the same fields as the edit form's banner. */
export function sharedSkuNoteCopy(othersVisible: number, sku: string): string | null {
  if (!Number.isFinite(othersVisible) || othersVisible < 1) return null;
  const n = Math.floor(othersVisible);
  return `SKU ${sku} is also used by ${n} other record${n === 1 ? '' : 's'} you can see. Editing ${SHARED_SKU_FIELDS_WORDS} changes all of them.`;
}

// ═══ Group selected (slice G2, migration 0400) ═════════════════════════════
//
// apply_item_grouping(p_request, p_key) takes one of three actions:
//   group   put records in a NEW group (two or more) or an EXISTING one;
//   remove  take records out of the group they are in;
//   rename  rename a group.
// A display group only shows records together: it never changes a SKU,
// barcode/ISBN, charter, rack, stock or product family, and is never a kit, a
// substitute or an identity anything else reads (design 1a, owner decisions).

/** The longest group name (the database trims and checks the same). */
export const GROUP_NAME_MAX_LENGTH = 120;

/** Where the records go: a new group with a name, or an existing group at the
 *  version the screen saw. */
export type GroupTarget =
  { kind: 'new'; name: string } | { kind: 'existing'; groupId: string; expectedVersion: number };

export interface GroupBody {
  action: 'group';
  idempotencyKey: string;
  organizationId: string;
  actorUserId: string;
  /** Distinct records (two rack rows of one record are ONE id), 1 to 100; at
   *  least 2 for a new group. */
  itemIds: string[];
  target: GroupTarget;
  /** Each record's group as the screen saw it (null: none). */
  expectedGroups: Record<string, string | null>;
  /** Records the person explicitly chose to move out of another group. */
  moveItemIds: string[];
  /** The person confirmed that product-family members may show in the group. */
  acknowledgeProductFamily: boolean;
}

export interface RemoveFromGroupBody {
  action: 'remove';
  idempotencyKey: string;
  organizationId: string;
  actorUserId: string;
  itemIds: string[];
  /** The group each record is in, as the screen saw it. */
  expectedGroups: Record<string, string>;
}

export interface RenameGroupBody {
  action: 'rename';
  idempotencyKey: string;
  organizationId: string;
  actorUserId: string;
  groupId: string;
  expectedVersion: number;
  name: string;
}

export type GroupingBody = GroupBody | RemoveFromGroupBody | RenameGroupBody;

export type GroupingField =
  | 'body'
  | 'action'
  | 'idempotency_key'
  | 'organization_id'
  | 'actor_user_id'
  | 'item_ids'
  | 'target'
  | 'name'
  | 'expected_version'
  | 'expected_groups'
  | 'move_item_ids'
  | 'acknowledge_product_family'
  | 'group_id';

export type GroupingParse =
  | { ok: true; body: GroupingBody }
  | { ok: false; refusal: { reason: 'invalid'; field: GroupingField; message: string } };

const GROUPING_KEYS: Record<GroupingBody['action'], Set<string>> = {
  group: new Set([
    'action',
    'idempotencyKey',
    'organizationId',
    'actorUserId',
    'itemIds',
    'target',
    'expectedGroups',
    'moveItemIds',
    'acknowledgeProductFamily',
  ]),
  remove: new Set([
    'action',
    'idempotencyKey',
    'organizationId',
    'actorUserId',
    'itemIds',
    'expectedGroups',
  ]),
  rename: new Set([
    'action',
    'idempotencyKey',
    'organizationId',
    'actorUserId',
    'groupId',
    'expectedVersion',
    'name',
  ]),
};

function refuseGrouping(field: GroupingField): GroupingParse {
  return {
    ok: false,
    refusal: { reason: 'invalid', field, message: GROUPING_ERROR_WORDS.invalid },
  };
}

/** A version the database accepts: an integer from 1 to 2147483647. */
function isVersion(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 2147483647;
}

/** A group name the database accepts, trimmed; null when it would refuse it. */
export function normalizeGroupName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name.length >= 1 && [...name].length <= GROUP_NAME_MAX_LENGTH ? name : null;
}

function parseIdList(raw: unknown, min: number): string[] | null {
  if (!Array.isArray(raw) || raw.length < min || raw.length > GROUPING_MAX_ITEMS) return null;
  if (!raw.every((id) => typeof id === 'string' && UUID.test(id))) return null;
  const ids = (raw as string[]).map((id) => id.toLowerCase());
  return new Set(ids).size === ids.length ? ids : null;
}

/**
 * The body, with exactly apply_item_grouping's shape rules (0400
 * _display_grouping_request), so the app refuses what the database would,
 * naming the same field. Ids come back lower case, in the order sent; the
 * name trimmed; the decisions defaulted. A duplicate id is refused (the app
 * sends each record once, however many rack rows it has on screen).
 */
export function parseGroupingBody(raw: unknown): GroupingParse {
  if (!isRecord(raw)) return refuseGrouping('body');
  const action = raw.action;
  if (action !== 'group' && action !== 'remove' && action !== 'rename')
    return refuseGrouping('action');
  for (const k of Object.keys(raw))
    if (!GROUPING_KEYS[action].has(k)) return refuseGrouping('body');
  const { idempotencyKey, organizationId, actorUserId } = raw;
  if (typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey))
    return refuseGrouping('idempotency_key');
  if (typeof organizationId !== 'string' || !UUID.test(organizationId))
    return refuseGrouping('organization_id');
  if (typeof actorUserId !== 'string' || !UUID.test(actorUserId))
    return refuseGrouping('actor_user_id');
  const base = {
    idempotencyKey: idempotencyKey.toLowerCase(),
    organizationId: organizationId.toLowerCase(),
    actorUserId: actorUserId.toLowerCase(),
  };

  if (action === 'rename') {
    if (typeof raw.groupId !== 'string' || !UUID.test(raw.groupId))
      return refuseGrouping('group_id');
    if (!isVersion(raw.expectedVersion)) return refuseGrouping('expected_version');
    const name = normalizeGroupName(raw.name);
    if (!name) return refuseGrouping('name');
    return {
      ok: true,
      body: {
        action,
        ...base,
        groupId: raw.groupId.toLowerCase(),
        expectedVersion: raw.expectedVersion,
        name,
      },
    };
  }

  const ids = parseIdList(raw.itemIds, 1);
  if (!ids) return refuseGrouping('item_ids');
  if (!isRecord(raw.expectedGroups)) return refuseGrouping('expected_groups');
  const expected: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(raw.expectedGroups)) {
    if (!UUID.test(k)) return refuseGrouping('expected_groups');
    if (v === null) {
      if (action === 'remove') return refuseGrouping('expected_groups');
      expected[k.toLowerCase()] = null;
    } else if (typeof v === 'string' && UUID.test(v)) {
      expected[k.toLowerCase()] = v.toLowerCase();
    } else {
      return refuseGrouping('expected_groups');
    }
  }
  if (
    Object.keys(raw.expectedGroups).length !== ids.length ||
    Object.keys(expected).length !== ids.length ||
    !ids.every((id) => Object.prototype.hasOwnProperty.call(expected, id))
  ) {
    return refuseGrouping('expected_groups');
  }

  if (action === 'remove') {
    return {
      ok: true,
      body: { action, ...base, itemIds: ids, expectedGroups: expected as Record<string, string> },
    };
  }

  const t = raw.target;
  if (!isRecord(t)) return refuseGrouping('target');
  let target: GroupTarget;
  if (t.kind === 'new') {
    const name = normalizeGroupName(t.name);
    if (!name) return refuseGrouping('name');
    if (ids.length < 2) return refuseGrouping('item_ids');
    target = { kind: 'new', name };
  } else if (t.kind === 'existing') {
    if (typeof t.groupId !== 'string' || !UUID.test(t.groupId)) return refuseGrouping('target');
    if (!isVersion(t.expectedVersion)) return refuseGrouping('expected_version');
    target = {
      kind: 'existing',
      groupId: t.groupId.toLowerCase(),
      expectedVersion: t.expectedVersion,
    };
  } else {
    return refuseGrouping('target');
  }

  let move: string[] = [];
  if (raw.moveItemIds !== undefined && raw.moveItemIds !== null) {
    const m = parseIdList(raw.moveItemIds, 0);
    if (!m || !m.every((id) => ids.includes(id))) return refuseGrouping('move_item_ids');
    move = m;
  }
  const ack = raw.acknowledgeProductFamily;
  if (ack !== undefined && ack !== null && typeof ack !== 'boolean') {
    return refuseGrouping('acknowledge_product_family');
  }

  return {
    ok: true,
    body: {
      action,
      ...base,
      itemIds: ids,
      target,
      expectedGroups: expected,
      moveItemIds: move,
      acknowledgeProductFamily: ack === true,
    },
  };
}

/** The arguments of apply_item_grouping(p_request, p_key) for a parsed body. */
export function toGroupingRpcRequest(
  body: GroupingBody,
  surface: GroupingSurface,
): { p_request: Record<string, unknown>; p_key: string } {
  const head = {
    action: body.action,
    organization_id: body.organizationId,
    actor_user_id: body.actorUserId,
    surface,
  };
  if (body.action === 'rename') {
    return {
      p_key: body.idempotencyKey,
      p_request: {
        ...head,
        group_id: body.groupId,
        expected_version: body.expectedVersion,
        name: body.name,
      },
    };
  }
  if (body.action === 'remove') {
    return {
      p_key: body.idempotencyKey,
      p_request: { ...head, item_ids: body.itemIds, expected_groups: body.expectedGroups },
    };
  }
  return {
    p_key: body.idempotencyKey,
    p_request: {
      ...head,
      item_ids: body.itemIds,
      target:
        body.target.kind === 'new'
          ? { kind: 'new', name: body.target.name }
          : {
              kind: 'existing',
              group_id: body.target.groupId,
              expected_version: body.target.expectedVersion,
            },
      expected_groups: body.expectedGroups,
      move_item_ids: body.moveItemIds,
      acknowledge_product_family: body.acknowledgeProductFamily,
    },
  };
}

// ── The answer ─────────────────────────────────────────────────────────────

export interface GroupingOutcomeGroup {
  id: string;
  name: string;
  version: number;
  itemType: string;
  closed: boolean;
}

export interface GroupingOutcome {
  action: 'group' | 'remove' | 'rename';
  /** 'noop': nothing needed writing (a repeat, or records already there). */
  outcome: 'applied' | 'noop';
  /** True when the key had already applied: nothing was written this time. */
  replay: boolean;
  /** A new group was made by this request. */
  created: boolean;
  /** The group the records are in afterwards (group, rename); null for remove. */
  group: GroupingOutcomeGroup | null;
  changes: Array<{ itemId: string; fromGroupId: string | null; toGroupId: string | null }>;
  // No closed group ids (security review SEC-2): whether a group closed
  // depends on records the caller may not see (a group stays open while a
  // hidden record is in it), so the answer never says. The audit rows keep
  // group_closed for whoever may read the activity log.
}

/** apply_item_grouping's answer, or null when it is not one. */
export function parseGroupingOutcome(raw: unknown): GroupingOutcome | null {
  if (!isRecord(raw)) return null;
  const { action, outcome, group, changes } = raw;
  if (action !== 'group' && action !== 'remove' && action !== 'rename') return null;
  if (outcome !== 'applied' && outcome !== 'noop') return null;
  if (!Array.isArray(changes)) return null;
  let g: GroupingOutcomeGroup | null = null;
  if (group !== null && group !== undefined) {
    if (!isRecord(group) || typeof group.id !== 'string' || typeof group.name !== 'string')
      return null;
    g = {
      id: group.id,
      name: group.name,
      version: typeof group.version === 'number' ? group.version : 0,
      itemType: typeof group.item_type === 'string' ? group.item_type : 'product',
      closed: group.closed === true,
    };
  }
  const out: GroupingOutcome['changes'] = [];
  for (const c of changes) {
    if (!isRecord(c) || typeof c.item_id !== 'string') return null;
    out.push({
      itemId: c.item_id,
      fromGroupId: typeof c.from_group_id === 'string' ? c.from_group_id : null,
      toGroupId: typeof c.to_group_id === 'string' ? c.to_group_id : null,
    });
  }
  return {
    action,
    outcome,
    replay: raw.replay === true,
    created: raw.created === true,
    group: g,
    changes: out,
  };
}

// ── The preview (item_grouping_preview, read as the caller) ────────────────

export interface GroupingPreviewRecord {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  isbnFields: { isbn?: string | null; isbn13?: string | null; isbn10?: string | null } | null;
  itemType: string;
  isBundle: boolean;
  isRental: boolean;
  /** The certified product family (sports), never changed by grouping. */
  productGroupId: string | null;
  productGroupName: string | null;
  variantSize: string | null;
  charterId: string | null;
  warehouseId: string | null;
  binLocation: string | null;
  /** The record's custom fields (a book's stored rack keys), for the rack
   *  line; null when absent. */
  customFields: Record<string, unknown> | null;
  quantityOnHand: number;
  createdAt: string | null;
  /** The group the record is in now, as the caller may see it. */
  displayGroup: { id: string; name: string; version: number } | null;
  /** The caller may edit this record (caller_can_write_item). */
  writable: boolean;
}

export interface GroupingPreview {
  records: GroupingPreviewRecord[];
  /** Selected ids the caller cannot read (or that are gone): a count only. */
  unavailableCount: number;
  /** Readable records that share a selected record's SKU and are not selected. */
  sameSkuSiblings: Array<{
    id: string;
    name: string;
    sku: string;
    itemType: string;
    displayGroupId: string | null;
  }>;
  /** Readable open groups of the selected records' type: holding a selected
   *  record first. Suggestions only, never picked by a name. */
  candidateGroups: Array<{
    id: string;
    name: string;
    version: number;
    itemType: string;
    memberCount: number;
    holdsSelected: boolean;
  }>;
  /** The named target group with its readable records. */
  targetGroup: {
    id: string;
    name: string;
    version: number;
    itemType: string;
    members: Array<{ id: string; name: string; sku: string; quantityOnHand: number }>;
  } | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;

/** item_grouping_preview's answer, or null when it is not one. */
export function parseGroupingPreview(raw: unknown): GroupingPreview | null {
  if (!isRecord(raw) || !Array.isArray(raw.records)) return null;
  const records: GroupingPreviewRecord[] = [];
  for (const r of raw.records) {
    if (!isRecord(r) || typeof r.id !== 'string') return null;
    const dg =
      isRecord(r.display_group) && typeof r.display_group.id === 'string' ? r.display_group : null;
    const isbn = isRecord(r.isbn_fields) ? r.isbn_fields : null;
    records.push({
      id: r.id,
      name: str(r.name) ?? '',
      sku: str(r.sku) ?? '',
      barcode: str(r.barcode),
      isbnFields: isbn
        ? { isbn: str(isbn.isbn), isbn13: str(isbn.isbn13), isbn10: str(isbn.isbn10) }
        : null,
      itemType: str(r.item_type) ?? 'product',
      isBundle: r.is_bundle === true,
      isRental: r.is_rental === true,
      productGroupId: str(r.product_group_id),
      productGroupName: str(r.product_group_name),
      variantSize: str(r.variant_size),
      charterId: str(r.charter_id),
      warehouseId: str(r.warehouse_id),
      binLocation: str(r.bin_location),
      customFields: isRecord(r.custom_fields) ? r.custom_fields : null,
      quantityOnHand: num(r.quantity_on_hand),
      createdAt: str(r.created_at),
      displayGroup: dg
        ? { id: dg.id as string, name: str(dg.name) ?? '', version: num(dg.version) }
        : null,
      writable: r.writable === true,
    });
  }
  const list = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => isRecord(x)) : [];
  const t =
    isRecord(raw.target_group) && typeof raw.target_group.id === 'string' ? raw.target_group : null;
  return {
    records,
    unavailableCount: Math.max(0, num(raw.unavailable_count)),
    sameSkuSiblings: list(raw.same_sku_siblings)
      .filter((s) => typeof s.id === 'string')
      .map((s) => ({
        id: s.id as string,
        name: str(s.name) ?? '',
        sku: str(s.sku) ?? '',
        itemType: str(s.item_type) ?? 'product',
        displayGroupId: str(s.display_group_id),
      })),
    candidateGroups: list(raw.candidate_groups)
      .filter((g) => typeof g.id === 'string')
      .map((g) => ({
        id: g.id as string,
        name: str(g.name) ?? '',
        version: num(g.version),
        itemType: str(g.item_type) ?? 'product',
        memberCount: num(g.member_count),
        holdsSelected: g.holds_selected === true,
      })),
    targetGroup: t
      ? {
          id: t.id as string,
          name: str(t.name) ?? '',
          version: num(t.version),
          itemType: str(t.item_type) ?? 'product',
          members: list(t.members)
            .filter((m) => typeof m.id === 'string')
            .map((m) => ({
              id: m.id as string,
              name: str(m.name) ?? '',
              sku: str(m.sku) ?? '',
              quantityOnHand: num(m.quantity_on_hand),
            })),
        }
      : null,
  };
}

/**
 * What a review answer is for: the organization, the distinct selected ids
 * (sorted, lower case) and the target group. The dialog compares it with its
 * current selection and ignores a stale answer (a selection or workspace that
 * changed while the preview was in flight).
 */
export function groupingPreviewKey(
  organizationId: string,
  itemIds: readonly string[],
  groupId: string | null,
): string {
  const ids = [...new Set(itemIds.map((id) => id.toLowerCase()))].sort();
  return `${organizationId.toLowerCase()}|${ids.join(',')}|${groupId?.toLowerCase() ?? ''}`;
}

// ── What the screens need ──────────────────────────────────────────────────

/** The words of Group selected, on the web and the phone. */
export const GROUP_COPY = {
  bulkAction: 'Group selected',
  /** The phone's select bar says "Group" (it fits at large Dynamic Type; its
   *  accessibility label is bulkAction). What's New names it this way (P7). */
  bulkActionShort: 'Group',
  removeAction: 'Remove from group',
  renameAction: 'Rename group',
  /** Accessible names that start with the visible words and name the group
   *  (people review P11: every header's buttons shared one name). */
  removeFor: (group: string) => `Remove from group ${group}`,
  renameFor: (group: string) => `Rename group ${group}`,
  title: (n: number) => `Group ${n} record${n === 1 ? '' : 's'}`,
  /** The brief's sentence, verbatim. */
  intro:
    'Grouping organizes these records together. It does not combine stock, change ownership, or move items.',
  /** Where automatic same-SKU grouping still applies (people review P2: a
   *  record left outside a group is NOT shown with the grouped records of
   *  its SKU; display-units.test.ts pins the behaviour). */
  skuNote:
    'Records in a group show under its header. Records in no group that share a SKU still show together automatically, and one that shares a SKU with records in a group is marked Same SKU as records in that group, with Add to group.',
  targetNew: 'New group',
  targetExisting: 'Add to an existing group',
  nameLabel: 'Group name',
  defaultName: 'New group',
  existingLabel: 'Group',
  noCandidates: 'No group you can see holds records of this type yet.',
  previewLabel: 'How it will show',
  previewHeader: (name: string, records: number, onHand: number) =>
    `${name} · ${records} record${records === 1 ? '' : 's'} · ${onHand} on hand`,
  unavailable: (n: number) =>
    `${n} selected record${n === 1 ? ' is' : 's are'} no longer available to you.`,
  leftOutReason: {
    kit: "is a kit (kits can't be grouped)",
    rental: "is a rental (rentals can't be grouped)",
    not_writable: "is in a warehouse you can't change",
    chosen: 'stays in its group (you chose to leave it out)',
  } as Record<GroupLeftOutReason, string>,
  otherGroup: (name: string) => `Already in group ${name}.`,
  moveOne: 'Move it into this group',
  /** The other choice for a record already in another group (P10): it is not
   *  sent and stays where it is. */
  leaveOutOne: 'Leave it out',
  /** Each record's choice, named for its record so a screen reader tells two
   *  records in one group apart; it starts with the words on screen (recheck
   *  R2-5). The web and the phone use the same names. */
  moveOneFor: (record: string) => `Move it into this group: ${record}`,
  leaveOutOneFor: (record: string) => `Leave it out: ${record}`,
  /** A selected record that is already in the existing target (P6). */
  alreadyInTarget: 'Already in this group; it stays.',
  /** The existing target's other records the person can see (P8). */
  targetMembers: (name: string) => `Already in ${name}`,
  moreTargetMembers: (n: number) => `and ${n} more`,
  family: (name: string | null) =>
    `In the product family ${name ?? 'of linked sizes'}. Its sizes stay linked for exchanges and imports; only the list shows it in this group.`,
  acknowledgeFamily: 'Show product-family records in this group',
  sameSku: (n: number, sku: string) =>
    `${n} other record${n === 1 ? '' : 's'} you can see share${n === 1 ? 's' : ''} SKU ${sku} and ${n === 1 ? 'is' : 'are'} not selected. ${n === 1 ? 'It stays' : 'They stay'} outside this group.`,
  addSiblings: 'Add them to the selection',
  editions: (n: number) =>
    `These are ${n} different editions (ISBNs). Grouping shows them together; they stay separate books for ordering and Book Order Totals.`,
  editionsUnknown:
    'Not every one of these books has an ISBN, so they may be different editions. They stay separate books for ordering and Book Order Totals.',
  blocked: {
    tooFew: 'Choose at least two records for a new group.',
    tooFewExisting: 'Choose at least one record to add.',
    name: 'Give the group a name.',
    otherGroup: 'Decide for each record already in another group: move it, or leave it out.',
    family: 'Confirm the product-family records, or deselect them.',
    noTarget: 'Choose a group to add to.',
    targetType: 'This group holds records of another type.',
  },
  confirmNew: (n: number) => `Group ${n} record${n === 1 ? '' : 's'}`,
  /** n: the records that JOIN (not those already in the group, P6). */
  confirmExisting: (n: number, name: string) => `Add ${n} record${n === 1 ? '' : 's'} to ${name}`,
  /** The button when nothing would change (every record is already there). */
  noopConfirm: 'OK',
  done: (name: string) => `Grouped in ${name}.`,
  noop: (name: string) => `These records are already in ${name}.`,
  cancel: 'Cancel',
  offline: 'Grouping needs a connection. Try again when you are online.',
  /** Announced when the review has loaded (iOS ignores live regions, P11). */
  reviewReady: (n: number) => `${n} record${n === 1 ? '' : 's'} to review.`,
  removeTitle: (n: number) => `Remove ${n} record${n === 1 ? '' : 's'} from the group`,
  removeIntro:
    "Removing records from a group doesn't delete them or change their SKU, stock, charter or rack. Out of the group, a record shows together automatically with records in no group that share its SKU.",
  /** Why a selected record is not removed (people review P9). */
  removeLeftOutReason: {
    not_in_group: 'is in no group',
    not_writable: "is in a warehouse you can't change",
  } as Record<RemoveLeftOutReason, string>,
  /** The removal empties the group as far as the person can see (P9). It
   *  closes unless a record hidden from them is still in it, so the words
   *  claim no more than that. */
  removeLast: (name: string) =>
    `This removes the last records in ${name} that you can see. A group with no records left closes.`,
  /** Records the person can see stay in the group (P9): on this page or not. */
  removeStays: (n: number, name: string) =>
    `${n} other record${n === 1 ? '' : 's'} you can see stay${n === 1 ? 's' : ''} in ${name}.`,
  /** More records than one request takes (data review D3). */
  removeCapped: (total: number) =>
    `Remove from group takes ${GROUPING_MAX_ITEMS} records at a time: this removes the first ${GROUPING_MAX_ITEMS} of ${total}. Open it again for the rest.`,
  removeConfirm: (n: number) => `Remove ${n} record${n === 1 ? '' : 's'}`,
  removeDone: (n: number) => `${n} record${n === 1 ? '' : 's'} removed from the group.`,
  renameDone: (name: string) => `Renamed to ${name}.`,
  chipInGroup: (name: string) => `In group ${name}`,
  chipSameSku: (name: string) => `Same SKU as records in ${name}`,
  addToGroup: 'Add to group',
  /** A chip's Add to group, named for its group and its record (P11). */
  addToGroupFor: (group: string, record: string) => `Add to group ${group}: ${record}`,
  headerRecords: (n: number) => `${n} record${n === 1 ? '' : 's'}`,
  headerMatching: (n: number) => `${n} matching`,
  /** An explicit header's count, on the web and the phone (people review
   *  P5): "N matching" whenever a search, a filter or a stock view narrows
   *  the list, else "N records". */
  headerCount: (n: number, narrowed: boolean) =>
    narrowed ? `${n} matching` : `${n} record${n === 1 ? '' : 's'}`,
  itemPageInGroup: (name: string) => `In group ${name}`,
} as const;

/** What one record's line in a grouping review shows: the preview's facts
 *  plus the names the screen read for it. */
export interface GroupingRecordLineFacts {
  sku: string;
  barcode: string | null;
  isbnFields: GroupingPreviewRecord['isbnFields'];
  itemType: string;
  variantSize: string | null;
  charterId: string | null;
  /** The charter's name, or null when the record has none or its name could
   *  not be read. */
  charterName: string | null;
  placementLabel: string | null;
  warehouseName: string | null;
  quantityOnHand: number;
}

/**
 * One record's line in a grouping review, the same on the web and the phone:
 * its SKU, a book's ISBN (its edition), an item's size, its charter, rack,
 * warehouse and on hand. A charter's name when it was read; "No charter"
 * only for a record that has no charter. A charter whose name could not be
 * read (the read degrades to no name) is left out of the line rather than
 * said to be missing (recheck R2-6).
 */
export function groupingRecordLine(r: GroupingRecordLineFacts, view: 'items' | 'books'): string {
  const isbn =
    r.itemType === 'book'
      ? (r.barcode ?? r.isbnFields?.isbn13 ?? r.isbnFields?.isbn ?? null)
      : null;
  return [
    r.sku ? `SKU ${r.sku}` : null,
    isbn ? `ISBN ${isbn}` : null,
    view === 'items' && r.variantSize ? `Size ${r.variantSize}` : null,
    r.charterName ?? (r.charterId === null ? 'No charter' : null),
    r.placementLabel ?? 'No rack',
    r.warehouseName,
    `${r.quantityOnHand} on hand`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Why a selected record is not sent: a kit, a rental, a record the caller
 *  cannot edit, or one already in another group that the person chose to
 *  leave out ('chosen', P10). */
export type GroupLeftOutReason = 'kit' | 'rental' | 'not_writable' | 'chosen';

/** What the review plan decided about one Save. */
export interface GroupingDecisions {
  /** Records the person chose to move out of another group. */
  moveIds?: ReadonlySet<string>;
  /** Records already in another group the person chose to leave out: they
   *  are not sent and stay where they are (people review P10). Only honoured
   *  for a record in another group than the target. */
  leaveOutIds?: ReadonlySet<string>;
  /** The person confirmed the product-family records. */
  acknowledgeFamily?: boolean;
}

/** A person's choice for a selected record that is already in another group
 *  (P10), kept with the group the record was in when they chose (recheck
 *  R2-1). */
export interface GroupRecordChoice {
  choice: 'move' | 'leave';
  /** The group the record was in when the person chose. */
  fromGroupId: string;
}

/**
 * The choices that still hold for a review (recheck R2-1). A choice ("Move it
 * into this group" or "Leave it out") was made for the group a record was in
 * then, so it holds only while the record is still in that group. A choice
 * for a record that is now in another group (a colleague moved it between the
 * preview and Save, so Save was refused and the person pressed Review again),
 * in no group, or not in this review is dropped: its radios come back empty
 * and Save stays off until the person decides again, so a record is never
 * moved out of a group the person did not choose to move it from. Answers the
 * same map when every choice holds, so a screen that prunes its choices on
 * each new review does not render again for nothing.
 */
export function choicesForReview(
  choices: ReadonlyMap<string, GroupRecordChoice>,
  records: ReadonlyArray<{ id: string; displayGroup: { id: string } | null }>,
): ReadonlyMap<string, GroupRecordChoice> {
  const groupOf = new Map(records.map((r) => [r.id, r.displayGroup?.id ?? null]));
  const held = new Map<string, GroupRecordChoice>();
  for (const [id, c] of choices) if (groupOf.get(id) === c.fromGroupId) held.set(id, c);
  return held.size === choices.size ? choices : held;
}

/**
 * The plan's decisions from a screen's choices: only the choices that hold
 * for this review (choicesForReview) become a move or a leave-out, so a
 * choice made for another group never reaches planGrouping or the request.
 * The screens build their decisions with this and nothing else (R2-1).
 */
export function groupingDecisionsFor(
  choices: ReadonlyMap<string, GroupRecordChoice>,
  records: ReadonlyArray<{ id: string; displayGroup: { id: string } | null }>,
  acknowledgeFamily: boolean,
): Required<GroupingDecisions> {
  const moveIds = new Set<string>();
  const leaveOutIds = new Set<string>();
  for (const [id, c] of choicesForReview(choices, records)) {
    if (c.choice === 'move') moveIds.add(id);
    else leaveOutIds.add(id);
  }
  return { moveIds, leaveOutIds, acknowledgeFamily };
}

/** The target as the dialog holds it (the version comes from the preview). */
export type GroupDialogTarget =
  { kind: 'new'; name: string } | { kind: 'existing'; groupId: string | null };

export interface GroupingPlan {
  /** Readable selected records, in the order selected. */
  records: GroupingPreviewRecord[];
  unavailableCount: number;
  /** Selected records that will not be sent, with the reason. */
  leftOut: Array<{ id: string; reason: GroupLeftOutReason }>;
  /** The records the request names. */
  send: GroupingPreviewRecord[];
  /** Sent records not in the target yet: the ones that join or move. Save
   *  counts these (people review P6). */
  joining: GroupingPreviewRecord[];
  /** Sent records already in the existing target: nothing changes for them. */
  alreadyInTarget: GroupingPreviewRecord[];
  /** The existing target's readable records that are not selected, which the
   *  review lists so the person sees what the group holds (P8). */
  targetMembers: NonNullable<GroupingPreview['targetGroup']>['members'];
  conflicts: {
    /** Sent records in another group than the target: each needs a move. */
    otherGroup: GroupingPreviewRecord[];
    /** Sent product-family members (not already in the target). */
    family: GroupingPreviewRecord[];
    /** Readable unselected records of a selected SKU that stay OUTSIDE this
     *  group (informational). Records already in the existing target are
     *  not among them: they are listed with targetMembers (people review
     *  P1: "they stay outside this group" was said of the group's own
     *  records when Add to group came from a Same SKU chip). */
    sameSkuSiblings: GroupingPreview['sameSkuSiblings'];
    /** Books: distinct editions, and books with no ISBN. */
    editions: { editions: number; unknown: number } | null;
  };
  /** Why the same-SKU records cannot be added to the selection ("Add them to
   *  the selection"): the review would then cover more records than one
   *  request takes (GROUPING_MAX_ITEMS), so it could only fail (recheck
   *  R2-4). Null when they fit, or when there are none. */
  addSiblingsBlockedReason: string | null;
  /** Nothing would change: every record is already where the request puts it. */
  noop: { groupId: string; name: string } | null;
  /** "<name> · N records · Q on hand", as the list will show the group. */
  previewHeader: string | null;
  /** The existing target's version as the preview read it (sent back as
   *  expected_version); null for a new group or an unknown target. */
  targetVersion: number | null;
  canSave: boolean;
  /** Why Save is disabled, in plain words; null when it is not. */
  blockedReason: string | null;
}

/** Distinct editions among books (ISBN-10 and ISBN-13 of one book are one),
 *  and how many have no ISBN at all. */
export function bookEditionCount(
  books: ReadonlyArray<{ barcode: string | null; isbnFields: GroupingPreviewRecord['isbnFields'] }>,
): { editions: number; unknown: number } {
  const editions = new Set<string>();
  let unknown = 0;
  for (const b of books) {
    const candidates = [b.barcode, b.isbnFields?.isbn13, b.isbnFields?.isbn, b.isbnFields?.isbn10];
    let key: string | null = null;
    for (const c of candidates) {
      const keys = isbnSearchKeys(c ?? null);
      if (keys) {
        key = keys.find((k) => k.length === 13) ?? keys[0]!;
        break;
      }
    }
    if (key) editions.add(key);
    else unknown++;
  }
  return { editions: editions.size, unknown };
}

/**
 * The review dialog's plan: which selected records will be sent, which are
 * left out (kits, rentals, records the caller cannot edit, and records in
 * another group the person chose to leave out), which join and which are
 * already in an existing target (with the target's other records), the
 * conflicts that need an explicit decision (a record in another group: move
 * it or leave it out; a product-family member: confirm), and whether Save is
 * allowed. The database decides again under its locks; this only shows the
 * person what will happen.
 */
export function planGrouping(
  selectedIds: readonly string[],
  preview: GroupingPreview,
  target: GroupDialogTarget,
  decisions: GroupingDecisions,
): GroupingPlan {
  const byId = new Map(preview.records.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const records: GroupingPreviewRecord[] = [];
  for (const id of selectedIds) {
    const r = byId.get(id.toLowerCase()) ?? byId.get(id);
    if (r && !seen.has(r.id)) {
      seen.add(r.id);
      records.push(r);
    }
  }
  const targetId = target.kind === 'existing' ? target.groupId : null;
  const leftOut: GroupingPlan['leftOut'] = [];
  const send: GroupingPreviewRecord[] = [];
  for (const r of records) {
    if (r.isBundle) leftOut.push({ id: r.id, reason: 'kit' });
    else if (r.isRental) leftOut.push({ id: r.id, reason: 'rental' });
    else if (!r.writable) leftOut.push({ id: r.id, reason: 'not_writable' });
    else if (
      decisions.leaveOutIds?.has(r.id) &&
      r.displayGroup !== null &&
      r.displayGroup.id !== targetId
    )
      leftOut.push({ id: r.id, reason: 'chosen' });
    else send.push(r);
  }
  const tg = targetId && preview.targetGroup?.id === targetId ? preview.targetGroup : null;
  const cand = targetId ? preview.candidateGroups.find((g) => g.id === targetId) : undefined;
  const targetName =
    target.kind === 'new' ? normalizeGroupName(target.name) : (tg?.name ?? cand?.name ?? null);

  const changing = send.filter((r) => !(targetId && r.displayGroup?.id === targetId));
  const alreadyInTarget = send.filter((r) => !!targetId && r.displayGroup?.id === targetId);
  const otherGroup = changing.filter((r) => r.displayGroup !== null);
  const targetMembers = tg ? tg.members.filter((m) => !seen.has(m.id)) : [];
  const selected = new Set(selectedIds.map((id) => id.toLowerCase()));
  const sameSkuSiblings = preview.sameSkuSiblings.filter(
    (sib) => !selected.has(sib.id.toLowerCase()) && !(targetId && sib.displayGroupId === targetId),
  );
  // "Add them to the selection" reviews the selection and these records in
  // ONE request, which takes at most GROUPING_MAX_ITEMS (R2-4).
  const withSiblings = new Set([...selected, ...sameSkuSiblings.map((s) => s.id.toLowerCase())]);
  const addSiblingsBlockedReason =
    sameSkuSiblings.length > 0 && withSiblings.size > GROUPING_MAX_ITEMS
      ? GROUPING_ERROR_WORDS.groupTooMany
      : null;
  const family = changing.filter((r) => r.productGroupId !== null);
  const books = send.filter((r) => r.itemType === 'book');
  const editions = books.length >= 2 ? bookEditionCount(books) : null;
  const types = new Set(send.map((r) => r.itemType));

  // No-op: the database would answer it (and does, for a repeat).
  let noop: GroupingPlan['noop'] = null;
  if (send.length > 0 && target.kind === 'existing' && targetId && changing.length === 0) {
    noop = { groupId: targetId, name: targetName ?? send[0]!.displayGroup?.name ?? '' };
  } else if (
    target.kind === 'new' &&
    send.length >= 2 &&
    !send.some((r) => decisions.moveIds?.has(r.id))
  ) {
    const first = send[0]!.displayGroup;
    if (first && send.every((r) => r.displayGroup?.id === first.id)) {
      noop = { groupId: first.id, name: first.name };
    }
  }

  // The header the list will show: every record in the group afterwards.
  let previewHeader: string | null = null;
  if (targetName) {
    const after = new Map<string, number>();
    if (tg) for (const m of tg.members) after.set(m.id, m.quantityOnHand);
    for (const r of send) after.set(r.id, r.quantityOnHand);
    const onHand = [...after.values()].reduce((a, b) => a + b, 0);
    previewHeader = GROUP_COPY.previewHeader(targetName, after.size, onHand);
  }

  let blockedReason: string | null = null;
  const unresolvedMove = otherGroup.some((r) => !decisions.moveIds?.has(r.id));
  if (types.size > 1) blockedReason = GROUPING_ERROR_WORDS.mixedTypes;
  else if (target.kind === 'new' && send.length < 2) blockedReason = GROUP_COPY.blocked.tooFew;
  else if (target.kind === 'existing' && send.length < 1)
    blockedReason = GROUP_COPY.blocked.tooFewExisting;
  else if (target.kind === 'new' && !normalizeGroupName(target.name))
    blockedReason = GROUP_COPY.blocked.name;
  else if (target.kind === 'existing' && (!targetId || (!tg && !cand)))
    blockedReason = GROUP_COPY.blocked.noTarget;
  else if (
    target.kind === 'existing' &&
    (tg ?? cand) &&
    types.size === 1 &&
    !types.has((tg ?? cand)!.itemType)
  )
    blockedReason = GROUP_COPY.blocked.targetType;
  else if (send.length > GROUPING_MAX_ITEMS) blockedReason = GROUPING_ERROR_WORDS.groupTooMany;
  else if (!noop && unresolvedMove) blockedReason = GROUP_COPY.blocked.otherGroup;
  else if (!noop && family.length > 0 && !decisions.acknowledgeFamily)
    blockedReason = GROUP_COPY.blocked.family;

  return {
    records,
    unavailableCount: preview.unavailableCount,
    leftOut,
    send,
    joining: changing,
    alreadyInTarget,
    targetMembers,
    conflicts: { otherGroup, family, sameSkuSiblings, editions },
    addSiblingsBlockedReason,
    noop,
    previewHeader,
    targetVersion: target.kind === 'existing' ? (tg?.version ?? cand?.version ?? null) : null,
    canSave: blockedReason === null,
    blockedReason,
  };
}

/** The request for a plan (only when `plan.canSave`). The version of an
 *  existing target is the one the preview read. */
export function groupBodyForPlan(
  plan: GroupingPlan,
  target: GroupDialogTarget,
  decisions: GroupingDecisions,
  ids: { idempotencyKey: string; organizationId: string; actorUserId: string },
  targetVersion?: number,
): GroupBody {
  const expectedGroups: Record<string, string | null> = {};
  for (const r of plan.send) expectedGroups[r.id] = r.displayGroup?.id ?? null;
  const moveItemIds = plan.conflicts.otherGroup
    .filter((r) => decisions.moveIds?.has(r.id))
    .map((r) => r.id);
  const versionFromPlan = (): number => {
    if (target.kind !== 'existing') return 1;
    const inRecords = plan.send.find((r) => r.displayGroup?.id === target.groupId)?.displayGroup
      ?.version;
    return targetVersion ?? plan.targetVersion ?? inRecords ?? 1;
  };
  return {
    action: 'group',
    ...ids,
    itemIds: plan.send.map((r) => r.id),
    target:
      target.kind === 'new'
        ? { kind: 'new', name: normalizeGroupName(target.name) ?? '' }
        : { kind: 'existing', groupId: target.groupId ?? '', expectedVersion: versionFromPlan() },
    expectedGroups,
    moveItemIds,
    acknowledgeProductFamily:
      decisions.acknowledgeFamily === true && plan.conflicts.family.length > 0,
  };
}

/** Why a selected record is not in a removal (P9). */
export type RemoveLeftOutReason = 'not_in_group' | 'not_writable';

export interface RemovalPlan {
  /** Readable selected records, in the order selected. */
  records: GroupingPreviewRecord[];
  /** Selected ids the caller cannot read (or that are gone): a count only. */
  unavailableCount: number;
  /** The records the request names: in a group, and editable by the caller. */
  remove: GroupingPreviewRecord[];
  /** Selected records that are not removed, with the reason. */
  leftOut: Array<{ id: string; reason: RemoveLeftOutReason }>;
  /** Each group losing records: how many leave, and how many records the
   *  caller can see stay (null when the preview did not count the group).
   *  Hidden records are never counted, so 0 means "the last ones you can
   *  see", not "the group closes". */
  groups: Array<{ id: string; name: string; removing: number; staying: number | null }>;
}

/**
 * Remove from group's plan (people review P9): which selected records leave
 * their group, which are left out and why (in no group, or not editable by
 * the caller), and, per group, how many records the caller can see stay (the
 * preview's candidate count is the caller's readable live records), so the
 * dialog can say that a group is losing its last visible records or that
 * others stay, on this page or not.
 */
export function planRemoval(selectedIds: readonly string[], preview: GroupingPreview): RemovalPlan {
  const byId = new Map(preview.records.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const records: GroupingPreviewRecord[] = [];
  for (const id of selectedIds) {
    const r = byId.get(id.toLowerCase()) ?? byId.get(id);
    if (r && !seen.has(r.id)) {
      seen.add(r.id);
      records.push(r);
    }
  }
  const remove: GroupingPreviewRecord[] = [];
  const leftOut: RemovalPlan['leftOut'] = [];
  for (const r of records) {
    if (!r.displayGroup) leftOut.push({ id: r.id, reason: 'not_in_group' });
    else if (!r.writable) leftOut.push({ id: r.id, reason: 'not_writable' });
    else remove.push(r);
  }
  const counted = new Map(preview.candidateGroups.map((g) => [g.id, g.memberCount]));
  const groups = new Map<string, RemovalPlan['groups'][number]>();
  for (const r of remove) {
    const g = r.displayGroup!;
    const cur = groups.get(g.id) ?? { id: g.id, name: g.name, removing: 0, staying: null };
    cur.removing += 1;
    groups.set(g.id, cur);
  }
  for (const g of groups.values()) {
    const readable = counted.get(g.id);
    g.staying = readable === undefined ? null : Math.max(0, readable - g.removing);
  }
  return {
    records,
    unavailableCount: preview.unavailableCount,
    remove,
    leftOut,
    groups: [...groups.values()],
  };
}

/** Remove these records from the group each is in (as the screen saw it). */
export function removeBodyFor(
  records: ReadonlyArray<{ id: string; displayGroupId: string }>,
  ids: { idempotencyKey: string; organizationId: string; actorUserId: string },
): RemoveFromGroupBody {
  const expectedGroups: Record<string, string> = {};
  for (const r of records) expectedGroups[r.id] = r.displayGroupId;
  return { action: 'remove', ...ids, itemIds: records.map((r) => r.id), expectedGroups };
}

/** A shared start for a name: words the names have in common, from the
 *  start, cut back to a whole word. */
function commonWordPrefix(names: readonly string[]): string {
  if (names.length === 0) return '';
  let prefix = names[0]!;
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i]!.toLowerCase() === n[i]!.toLowerCase())
      i++;
    prefix = prefix.slice(0, i);
  }
  const whole = names.every((n) => n.length === prefix.length);
  if (!whole) {
    // Cut back to the last word boundary unless every name continues with a
    // boundary right here.
    const atBoundary = names.every(
      (n) => n.length === prefix.length || /[\s\-–—:,/]/.test(n[prefix.length]!),
    );
    if (!atBoundary) {
      const cut = prefix.search(/[\s\-–—:,/][^\s\-–—:,/]*$/);
      prefix = cut >= 0 ? prefix.slice(0, cut) : '';
    }
  }
  return prefix.replace(/[\s\-–—:,/]+$/, '').trim();
}

/**
 * A suggested name for a new group (an editable field: a suggestion, never a
 * link made on a name). Items: the base name the records share without a size
 * suffix ("Limits Tee - XS" and "Limits Tee - S" give "Limits Tee"; records
 * that all carry one name keep it whole). Books:
 * the title they share, with no size parsing and no edition claim. Falls back
 * to the first record's name, then to a plain default.
 */
export function suggestGroupName(
  records: ReadonlyArray<{ name: string }>,
  view: 'items' | 'books',
): string {
  const full = records.map((r) => (r.name ?? '').trim()).filter((n) => n.length > 0);
  if (full.length === 0) return GROUP_COPY.defaultName;
  // Records with one and the same name keep it whole (two "Polo XXXL"
  // records are XXXL polos; dropping the size would misname them).
  const same = full.every((n) => n.toLowerCase() === full[0]!.toLowerCase());
  const names =
    same || view === 'books'
      ? full
      : full.map((n) => stripSizeSuffix(n)).filter((n) => n.length > 0);
  if (names.length === 0) return GROUP_COPY.defaultName;
  const shared = commonWordPrefix(names);
  const pick = shared.length >= 3 ? shared : names[0]!;
  return [...pick].slice(0, GROUP_NAME_MAX_LENGTH).join('').trim() || GROUP_COPY.defaultName;
}

/**
 * The bulk bar's facts for Group selected, from the rows on screen only (no
 * query per row): the DISTINCT records selected (two rack rows of one record
 * count once), whether they mix item types, whether Group selected is offered
 * (two or more of one type), and which of them are in a group now (Remove
 * from group).
 *
 * A selected id no loaded row describes (picked on another page, or among
 * search hits before the search was cleared: the table keeps such a
 * selection) is of the view's own type, `defaultType` ('book' on Books), so
 * a Books selection across pages is not read as mixed (people review P3).
 * The review then reads each record's real type, and the server refuses a
 * mixed request on its own.
 */
export function groupingSelectionFacts(
  selectedItemIds: readonly string[],
  rows: ReadonlyArray<{ id: string; item_type?: string | null; display_group_id?: string | null }>,
  defaultType: string = 'product',
): { count: number; mixedTypes: boolean; canGroup: boolean; groupedIds: string[] } {
  const byId = new Map<string, { item_type?: string | null; display_group_id?: string | null }>();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
  const distinct = [...new Set(selectedItemIds)];
  const types = new Set(distinct.map((id) => byId.get(id)?.item_type ?? defaultType));
  const mixedTypes = types.size > 1;
  return {
    count: distinct.length,
    mixedTypes,
    canGroup: distinct.length >= 2 && !mixedTypes,
    groupedIds: distinct.filter((id) => !!byId.get(id)?.display_group_id),
  };
}

// ═══ Ungroup anything (owner 2026-10-12) ══════════════════════════════════
//
// "im supposed to be able to check box whatever item and then group or
// ungroup it that was the point." The bulk bar's Ungroup takes ANY ticked
// records, and each one leaves the grouping it has, by kind:
//   sku     it shares its SKU with another record the person can see: it gets
//           its own SKU (split_item_sku, 0399; the oldest keeps the SKU when
//           every record of it is ticked);
//   group   it is in a display group (0400): it leaves that group
//           (apply_item_grouping remove);
//   family  it is in a size family (a certified product group): it leaves
//           the family (unlinkItems, as Product groups > Unlink: SKU, stock,
//           rack, charter and history unchanged).
// A record with more than one leaves the one it is SHOWN under on the list
// (the header it appears beneath: core composeDisplayList, shownUnderByRecord
// in display-units.ts), since that is what the person sees as grouped. When
// the list shows it under none of them (a lone search hit, another page),
// the list's own precedence decides: group, then SKU, then family
// (UNGROUP_KIND_PRECEDENCE, the order composeDisplayList claims rows in).

/** The groupings Ungroup undoes. */
export type UngroupKind = 'group' | 'sku' | 'family';

/** The list's precedence (composeDisplayList: E, then K, then R). */
export const UNGROUP_KIND_PRECEDENCE: readonly UngroupKind[] = ['group', 'sku', 'family'];

/** Why a ticked record is left out of an Ungroup. */
export type UngroupSelectedLeftOutReason =
  'kit' | 'nothing' | 'not_writable' | 'family_permission' | 'family_sku';

/** The three steps of one Ungroup, in the order the server runs them. */
export type UngroupPartKind = 'remove' | 'split' | 'unlink';
export const UNGROUP_PART_ORDER: readonly UngroupPartKind[] = ['remove', 'split', 'unlink'];

/**
 * The kind a record leaves: the one it is shown under, when it has that kind;
 * else the first of its kinds in the list's precedence; null when it has none.
 */
export function chooseUngroupKind(
  kinds: ReadonlySet<UngroupKind>,
  shownUnder: UngroupKind | null | undefined,
): UngroupKind | null {
  if (shownUnder && kinds.has(shownUnder)) return shownUnder;
  for (const k of UNGROUP_KIND_PRECEDENCE) if (kinds.has(k)) return k;
  return null;
}

/**
 * The kind a ticked record would leave, from what a list holds about it, when
 * this person may undo it; null when nothing (no grouping, a kit, a size family
 * without permission to unlink one, or a family member that would need its own
 * SKU: the database refuses that split). The web's bulk bar
 * (ungroupableItemIds) and the phone's select bar ask this one rule; the review
 * decides again on what the server reads.
 */
export function ungroupOfferKind(
  facts: { inGroup: boolean; sharesSku: boolean; inFamily: boolean; isBundle?: boolean | null },
  shownUnder: UngroupKind | null | undefined,
  canUnlinkFamilies: boolean,
): UngroupKind | null {
  if (facts.isBundle) return null;
  const kinds = new Set<UngroupKind>();
  if (facts.inGroup) kinds.add('group');
  if (facts.sharesSku) kinds.add('sku');
  if (facts.inFamily) kinds.add('family');
  const kind = chooseUngroupKind(kinds, shownUnder);
  if (!kind) return null;
  if (kind === 'family' && !canUnlinkFamilies) return null;
  if (kind === 'sku' && facts.inFamily) return null;
  return kind;
}

/** The facts the bulk bar holds for a loaded row. */
export interface UngroupRowFacts {
  id: string;
  sku: string | null;
  display_group_id?: string | null;
  /** The record's size family (inventory_items.group_id). */
  group_id?: string | null;
  is_bundle?: boolean | null;
}

/**
 * The bulk bar's Ungroup: the ticked records that have something to leave
 * that this person may undo, from the LOADED rows only (no query per row): a
 * display group or a shared SKU for someone who can edit items, a size family
 * for someone who can also manage sports products (with the sports module on).
 * A record is judged on the kind it would leave (chooseUngroupKind), so a
 * family member shown under its family is not offered to someone who cannot
 * unlink it. Empty: no Ungroup button. The review reads every record again.
 */
export function ungroupableItemIds(
  selectedIds: readonly string[],
  rows: readonly UngroupRowFacts[],
  options: {
    canEditItems: boolean;
    canUnlinkFamilies: boolean;
    /** Distinct records per raw SKU over the whole view, when known. */
    fullSkuCounts?: ReadonlyMap<string, number> | null;
    shownUnder?: ReadonlyMap<string, UngroupKind> | null;
  },
): string[] {
  if (!options.canEditItems) return [];
  const byId = new Map<string, UngroupRowFacts>();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
  const shared = new Set(
    sharedSkuItemIds(
      selectedIds,
      rows.map((r) => ({ id: r.id, sku: r.sku })),
      options.fullSkuCounts,
    ),
  );
  const out: string[] = [];
  for (const id of new Set(selectedIds)) {
    const r = byId.get(id);
    if (!r) continue;
    const kind = ungroupOfferKind(
      {
        inGroup: !!r.display_group_id,
        sharesSku: shared.has(id),
        inFamily: !!r.group_id,
        isBundle: r.is_bundle,
      },
      options.shownUnder?.get(id),
      options.canUnlinkFamilies,
    );
    if (kind) out.push(id);
  }
  return out;
}

/** A ticked record as the Ungroup review reads it (item_grouping_preview). */
export type UngroupSelectedRecord = Pick<
  GroupingPreviewRecord,
  | 'id'
  | 'name'
  | 'sku'
  | 'isBundle'
  | 'writable'
  | 'displayGroup'
  | 'productGroupId'
  | 'productGroupName'
>;

export interface UngroupSelectedPlan<
  T extends UngroupSelectedRecord = UngroupSelectedRecord,
  C extends SplitCandidate = SplitCandidate,
> {
  /** The readable ticked records, in the order ticked. */
  records: T[];
  /** Ticked ids the person cannot read (or that are gone): a count only. */
  unavailableCount: number;
  /** The kind each planned record leaves. */
  kindOf: Map<string, UngroupKind>;
  /** Ticked records left out, with the reason. */
  leftOut: Array<{ id: string; reason: UngroupSelectedLeftOutReason }>;
  /** Records leaving their display group. */
  leaveGroup: T[];
  /** The SKU split for the records that share their SKU (planSkuSplit). */
  split: SplitPlan<C>;
  /** Records leaving their size family. */
  leaveFamily: T[];
  /** Per display group losing records: how many leave, how many records the
   *  person can see stay (null when not counted). */
  groups: RemovalPlan['groups'];
}

/**
 * The Ungroup review's plan for the ticked ids. `records` and
 * `unavailableCount` come from item_grouping_preview (read as the person),
 * `candidates` from the SKU preview (every live record of the ticked records'
 * SKUs the person can read, oldest first), `shownUnder` from the list's own
 * composition (shownUnderByRecord). A record is left out when it is a kit,
 * has nothing to ungroup, cannot be edited by the person, is in a size family
 * the person may not unlink, or would get its own SKU while in a family (the
 * database refuses that split).
 */
export function planUngroupSelected<T extends UngroupSelectedRecord, C extends SplitCandidate>(
  selectedIds: readonly string[],
  review: {
    records: readonly T[];
    unavailableCount: number;
    candidateGroups?: GroupingPreview['candidateGroups'];
  },
  candidates: readonly C[],
  options: {
    canUnlinkFamilies: boolean;
    shownUnder?: ReadonlyMap<string, UngroupKind> | null;
  },
): UngroupSelectedPlan<T, C> {
  const byId = new Map(review.records.map((r) => [r.id.toLowerCase(), r]));
  const skuCount = new Map<string, number>();
  for (const c of candidates) {
    const k = sharedSkuKey(c.sku);
    if (k) skuCount.set(k, (skuCount.get(k) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const records: T[] = [];
  const kindOf = new Map<string, UngroupKind>();
  const leftOut: UngroupSelectedPlan['leftOut'] = [];
  const leaveGroup: T[] = [];
  const splitIds: string[] = [];
  const leaveFamily: T[] = [];
  for (const raw of selectedIds) {
    const r = byId.get(raw.toLowerCase());
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    records.push(r);
    if (r.isBundle) {
      leftOut.push({ id: r.id, reason: 'kit' });
      continue;
    }
    const kinds = new Set<UngroupKind>();
    if (r.displayGroup) kinds.add('group');
    const k = sharedSkuKey(r.sku);
    if (k && (skuCount.get(k) ?? 0) >= 2) kinds.add('sku');
    if (r.productGroupId) kinds.add('family');
    const kind = chooseUngroupKind(
      kinds,
      options.shownUnder?.get(r.id) ?? options.shownUnder?.get(raw),
    );
    if (!kind) leftOut.push({ id: r.id, reason: 'nothing' });
    else if (!r.writable) leftOut.push({ id: r.id, reason: 'not_writable' });
    else if (kind === 'family' && !options.canUnlinkFamilies)
      leftOut.push({ id: r.id, reason: 'family_permission' });
    else if (kind === 'sku' && r.productGroupId) leftOut.push({ id: r.id, reason: 'family_sku' });
    else {
      kindOf.set(r.id, kind);
      if (kind === 'group') leaveGroup.push(r);
      else if (kind === 'sku') splitIds.push(r.id);
      else leaveFamily.push(r);
    }
  }
  const split = planSkuSplit(splitIds, candidates);
  // A planned split the SKU preview could not confirm (the record changed
  // between the two reads) is left out as nothing to ungroup, never sent.
  for (const l of split.leftOut) {
    kindOf.delete(l.id);
    leftOut.push({ id: l.id, reason: l.reason === 'family' ? 'family_sku' : 'nothing' });
  }
  const removal = planRemoval(
    leaveGroup.map((r) => r.id),
    {
      records: leaveGroup as unknown as GroupingPreviewRecord[],
      unavailableCount: 0,
      sameSkuSiblings: [],
      candidateGroups: review.candidateGroups ?? [],
      targetGroup: null,
    },
  );
  return {
    records,
    unavailableCount: review.unavailableCount,
    kindOf,
    leftOut,
    leaveGroup,
    split,
    leaveFamily,
    groups: removal.groups,
  };
}

/** The record that keeps a fully ticked SKU: the person's choice, else the
 *  oldest (the database's rule); null when not every record is ticked. */
export function ungroupAnchorFor(
  g: SplitPlanGroup,
  anchorBySku: Readonly<Record<string, string>>,
): string | null {
  if (!g.allSelected) return null;
  const chosen = anchorBySku[g.sku];
  return chosen && g.selected.some((r) => r.id === chosen) ? chosen : g.defaultAnchorId;
}

/** What happens to one ticked record, for its line in the review. */
export type UngroupRecordOutcome =
  | { kind: 'split'; keeps: false }
  | { kind: 'split'; keeps: true; sku: string }
  | { kind: 'group'; groupName: string }
  | { kind: 'family'; familyName: string | null }
  | { kind: 'left_out'; reason: UngroupSelectedLeftOutReason };

export function ungroupRecordOutcome(
  plan: UngroupSelectedPlan,
  id: string,
  anchorBySku: Readonly<Record<string, string>>,
): UngroupRecordOutcome | null {
  const out = plan.leftOut.find((l) => l.id === id);
  if (out) return { kind: 'left_out', reason: out.reason };
  const kind = plan.kindOf.get(id);
  if (kind === 'group') {
    const r = plan.leaveGroup.find((x) => x.id === id);
    return { kind: 'group', groupName: r?.displayGroup?.name ?? DISPLAY_GROUP_NAME_FALLBACK };
  }
  if (kind === 'family') {
    const r = plan.leaveFamily.find((x) => x.id === id);
    return { kind: 'family', familyName: r?.productGroupName ?? null };
  }
  if (kind === 'sku') {
    const g = plan.split.groups.find((x) => x.selected.some((r) => r.id === id));
    if (!g) return null;
    return ungroupAnchorFor(g, anchorBySku) === id
      ? { kind: 'split', keeps: true, sku: g.sku }
      : { kind: 'split', keeps: false };
  }
  return null;
}

/** The words of a record's outcome (web and phone). */
export function ungroupOutcomeWords(o: UngroupRecordOutcome): string {
  switch (o.kind) {
    case 'split':
      return o.keeps ? UNGROUP_COPY.keepsSku(o.sku) : UNGROUP_COPY.getsOwnSku;
    case 'group':
      return UNGROUP_COPY.leavesGroup(o.groupName);
    case 'family':
      return UNGROUP_COPY.leavesFamily(o.familyName);
    case 'left_out':
      return `Left out: ${UNGROUP_COPY.selectedLeftOutReason[o.reason]}`;
  }
}

/** A group name that could not be read (display-units' header word). */
const DISPLAY_GROUP_NAME_FALLBACK = 'Group';

/**
 * How many ticked records CHANGE on Save: those leaving a group or a family,
 * and those getting their own SKU (never the record that keeps a fully ticked
 * SKU). Save's label and the result line count the same records.
 */
export function ungroupChangeCount(
  plan: UngroupSelectedPlan,
  anchorBySku: Readonly<Record<string, string>>,
): number {
  let split = 0;
  for (const g of plan.split.groups) {
    split += g.selected.length - (ungroupAnchorFor(g, anchorBySku) ? 1 : 0);
  }
  return plan.leaveGroup.length + split + plan.leaveFamily.length;
}

// ── The request ────────────────────────────────────────────────────────────

/** One Ungroup Save. Each step names its own records (no record in two), with
 *  what the screen saw; the keyed steps carry their own idempotency key, kept
 *  for every retry of the same body. */
export interface UngroupSelectedBody {
  organizationId: string;
  actorUserId: string;
  /** Records leaving their display group (apply_item_grouping remove). */
  remove: {
    idempotencyKey: string;
    itemIds: string[];
    expectedGroups: Record<string, string>;
  } | null;
  /** Records getting their own SKU (split_item_sku), anchors included. */
  split: {
    idempotencyKey: string;
    itemIds: string[];
    expectedSkus: Record<string, string>;
    anchorItemIds: string[];
  } | null;
  /** Records leaving their size family (unlinkItems), each with the family
   *  the screen saw. Unkeyed: a record already out of it is done. */
  unlink: { itemIds: string[]; expectedFamilies: Record<string, string> } | null;
}

export type UngroupSelectedField =
  'body' | 'organization_id' | 'actor_user_id' | 'remove' | 'split' | 'unlink' | 'item_ids';

export type UngroupSelectedParse =
  | { ok: true; body: UngroupSelectedBody }
  | { ok: false; refusal: { reason: 'invalid'; field: UngroupSelectedField; message: string } };

function refuseUngroup(field: UngroupSelectedField): UngroupSelectedParse {
  return {
    ok: false,
    refusal: { reason: 'invalid', field, message: GROUPING_ERROR_WORDS.invalid },
  };
}

const UNGROUP_BODY_KEYS = new Set(['organizationId', 'actorUserId', 'remove', 'split', 'unlink']);

/**
 * The body, checked with each step's own rules (parseGroupingBody for the
 * removal, parseSplitSkuBody for the split, the same id rules for the
 * unlink), plus: at least one step, no record in two steps, at most
 * GROUPING_MAX_ITEMS records in all.
 */
export function parseUngroupSelectedBody(raw: unknown): UngroupSelectedParse {
  if (!isRecord(raw)) return refuseUngroup('body');
  for (const k of Object.keys(raw)) if (!UNGROUP_BODY_KEYS.has(k)) return refuseUngroup('body');
  const { organizationId, actorUserId } = raw;
  if (typeof organizationId !== 'string' || !UUID.test(organizationId))
    return refuseUngroup('organization_id');
  if (typeof actorUserId !== 'string' || !UUID.test(actorUserId))
    return refuseUngroup('actor_user_id');
  const head = { organizationId, actorUserId };

  let remove: UngroupSelectedBody['remove'] = null;
  if (raw.remove !== undefined && raw.remove !== null) {
    if (!isRecord(raw.remove)) return refuseUngroup('remove');
    const keys = Object.keys(raw.remove);
    if (!keys.every((k) => ['idempotencyKey', 'itemIds', 'expectedGroups'].includes(k)))
      return refuseUngroup('remove');
    const p = parseGroupingBody({ action: 'remove', ...head, ...raw.remove });
    if (!p.ok || p.body.action !== 'remove') return refuseUngroup('remove');
    remove = {
      idempotencyKey: p.body.idempotencyKey,
      itemIds: p.body.itemIds,
      expectedGroups: p.body.expectedGroups,
    };
  }

  let split: UngroupSelectedBody['split'] = null;
  if (raw.split !== undefined && raw.split !== null) {
    if (!isRecord(raw.split)) return refuseUngroup('split');
    const p = parseSplitSkuBody({ ...head, ...raw.split });
    if (!p.ok) return refuseUngroup('split');
    split = {
      idempotencyKey: p.body.idempotencyKey,
      itemIds: p.body.itemIds,
      expectedSkus: p.body.expectedSkus,
      anchorItemIds: p.body.anchorItemIds,
    };
  }

  let unlink: UngroupSelectedBody['unlink'] = null;
  if (raw.unlink !== undefined && raw.unlink !== null) {
    if (!isRecord(raw.unlink)) return refuseUngroup('unlink');
    if (!Object.keys(raw.unlink).every((k) => k === 'itemIds' || k === 'expectedFamilies'))
      return refuseUngroup('unlink');
    const ids = parseIdList(raw.unlink.itemIds, 1);
    const fams = raw.unlink.expectedFamilies;
    if (!ids || !isRecord(fams)) return refuseUngroup('unlink');
    const expectedFamilies: Record<string, string> = {};
    for (const [k, v] of Object.entries(fams)) {
      if (!UUID.test(k) || typeof v !== 'string' || !UUID.test(v)) return refuseUngroup('unlink');
      expectedFamilies[k.toLowerCase()] = v.toLowerCase();
    }
    if (
      Object.keys(fams).length !== ids.length ||
      Object.keys(expectedFamilies).length !== ids.length ||
      !ids.every((id) => Object.prototype.hasOwnProperty.call(expectedFamilies, id))
    )
      return refuseUngroup('unlink');
    unlink = { itemIds: ids, expectedFamilies };
  }

  if (!remove && !split && !unlink) return refuseUngroup('body');
  const all = [...(remove?.itemIds ?? []), ...(split?.itemIds ?? []), ...(unlink?.itemIds ?? [])];
  if (new Set(all).size !== all.length || all.length > GROUPING_MAX_ITEMS)
    return refuseUngroup('item_ids');
  return {
    ok: true,
    body: {
      organizationId: organizationId.toLowerCase(),
      actorUserId: actorUserId.toLowerCase(),
      remove,
      split,
      unlink,
    },
  };
}

/** The Save for a plan: each step's records with what the screen saw. The
 *  keys come from the caller (minted once per body, kept for its retries). */
export function ungroupSelectedBodyForPlan(
  plan: UngroupSelectedPlan,
  anchorBySku: Readonly<Record<string, string>>,
  ids: { organizationId: string; actorUserId: string; removeKey: string; splitKey: string },
): UngroupSelectedBody {
  const leave = plan.leaveGroup.filter((r) => r.displayGroup);
  const removal =
    leave.length > 0
      ? removeBodyFor(
          leave.map((r) => ({ id: r.id, displayGroupId: r.displayGroup!.id })),
          {
            idempotencyKey: ids.removeKey,
            organizationId: ids.organizationId,
            actorUserId: ids.actorUserId,
          },
        )
      : null;
  const sku =
    plan.split.splitIds.length > 0
      ? splitSkuBodyForPlan(plan.split, anchorBySku, {
          idempotencyKey: ids.splitKey,
          organizationId: ids.organizationId,
          actorUserId: ids.actorUserId,
        })
      : null;
  const fam = plan.leaveFamily.filter((r) => r.productGroupId);
  return {
    organizationId: ids.organizationId,
    actorUserId: ids.actorUserId,
    remove: removal
      ? {
          idempotencyKey: removal.idempotencyKey,
          itemIds: removal.itemIds,
          expectedGroups: removal.expectedGroups,
        }
      : null,
    split: sku
      ? {
          idempotencyKey: sku.idempotencyKey,
          itemIds: sku.itemIds,
          expectedSkus: sku.expectedSkus,
          anchorItemIds: sku.anchorItemIds,
        }
      : null,
    unlink:
      fam.length > 0
        ? {
            itemIds: fam.map((r) => r.id),
            expectedFamilies: Object.fromEntries(fam.map((r) => [r.id, r.productGroupId!])),
          }
        : null,
  };
}

/**
 * The body to send: the pending one when the draft (without its keys) is
 * unchanged, so a retry keeps both keys and the database replays; else the
 * draft with fresh keys.
 */
export function keyedUngroupSelectedBody(
  pending: { json: string; body: UngroupSelectedBody } | null,
  draft: UngroupSelectedBody,
  mint: () => string,
): { json: string; body: UngroupSelectedBody } {
  const strip = (b: UngroupSelectedBody) => ({
    ...b,
    remove: b.remove ? { ...b.remove, idempotencyKey: undefined } : null,
    split: b.split ? { ...b.split, idempotencyKey: undefined } : null,
  });
  const json = JSON.stringify(strip(draft));
  if (pending && pending.json === json) return pending;
  return {
    json,
    body: {
      ...draft,
      remove: draft.remove ? { ...draft.remove, idempotencyKey: mint() } : null,
      split: draft.split ? { ...draft.split, idempotencyKey: mint() } : null,
    },
  };
}

// ── The answer ─────────────────────────────────────────────────────────────

export type UngroupPartStatus = 'applied' | 'partial' | 'refused' | 'not_attempted';

/** One step's answer. A step runs only when every step before it applied. */
export interface UngroupPartResult {
  kind: UngroupPartKind;
  status: UngroupPartStatus;
  /** Records this step left in the asked state (out of the group or the
   *  family, or with their own SKU): never the record that kept a SKU. */
  changedItemIds: string[];
  /** Records this step named that it did not change (refused, or not tried). */
  notChangedItemIds: string[];
  /** The refusal's words (core's), or null. */
  message: string | null;
  reason: string | null;
  /** The SAME body may be sent again (busy, a rate limit). */
  retryable: boolean;
  /** The split's before and after SKUs (the split step only). */
  splitItems?: SplitSkuOutcomeItem[];
}

export interface UngroupSelectedOutcome {
  parts: UngroupPartResult[];
  /** Every step that ran applied. */
  complete: boolean;
}

/** The server's answer, or null when it is not one. */
export function parseUngroupSelectedOutcome(raw: unknown): UngroupSelectedOutcome | null {
  if (!isRecord(raw) || !Array.isArray(raw.parts)) return null;
  const parts: UngroupPartResult[] = [];
  const strs = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  for (const p of raw.parts) {
    if (!isRecord(p)) return null;
    if (p.kind !== 'remove' && p.kind !== 'split' && p.kind !== 'unlink') return null;
    if (
      p.status !== 'applied' &&
      p.status !== 'partial' &&
      p.status !== 'refused' &&
      p.status !== 'not_attempted'
    )
      return null;
    const changed = strs(p.changedItemIds);
    const notChanged = strs(p.notChangedItemIds);
    if (!changed || !notChanged) return null;
    let splitItems: SplitSkuOutcomeItem[] | undefined;
    if (p.splitItems !== undefined) {
      if (!Array.isArray(p.splitItems)) return null;
      splitItems = [];
      for (const it of p.splitItems) {
        if (
          !isRecord(it) ||
          typeof it.id !== 'string' ||
          typeof it.beforeSku !== 'string' ||
          typeof it.afterSku !== 'string' ||
          typeof it.kept !== 'boolean'
        )
          return null;
        splitItems.push({
          id: it.id,
          beforeSku: it.beforeSku,
          afterSku: it.afterSku,
          kept: it.kept,
          anchorItemId: typeof it.anchorItemId === 'string' ? it.anchorItemId : null,
        });
      }
    }
    parts.push({
      kind: p.kind,
      status: p.status,
      changedItemIds: changed,
      notChangedItemIds: notChanged,
      message: typeof p.message === 'string' ? p.message : null,
      reason: typeof p.reason === 'string' ? p.reason : null,
      retryable: p.retryable === true,
      ...(splitItems ? { splitItems } : {}),
    });
  }
  return { parts, complete: raw.complete === true };
}

/** The done screen's lines: what applied, one line per step that changed
 *  records, then what was not done or not tried, in the server's order. */
export function ungroupResultLines(outcome: UngroupSelectedOutcome): {
  done: string[];
  notDone: string[];
} {
  const done: string[] = [];
  const notDone: string[] = [];
  for (const p of outcome.parts) {
    const n = p.changedItemIds.length;
    if (n > 0) {
      done.push(
        p.kind === 'remove'
          ? UNGROUP_COPY.leftGroups(n)
          : p.kind === 'split'
            ? UNGROUP_COPY.done(n)
            : UNGROUP_COPY.leftFamilies(n),
      );
    }
    const m = p.notChangedItemIds.length;
    if (m === 0) continue;
    const what = UNGROUP_COPY.partWhat(p.kind, m);
    if (p.status === 'not_attempted') notDone.push(UNGROUP_COPY.partNotTried(what));
    else if (p.status === 'refused' || p.status === 'partial')
      notDone.push(UNGROUP_COPY.partNotDone(what, p.message ?? GROUPING_ERROR_WORDS.internal));
  }
  return { done, notDone };
}

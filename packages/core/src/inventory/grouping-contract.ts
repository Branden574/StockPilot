/**
 * The grouping contract, as the web, the phone and the database speak it
 * (design-merged.md sections 3 and 6). Slice G1 carries Ungroup (split_sku):
 * give a record that shares its SKU a fresh SKU of its own, changing that
 * record only (migration 0399, split_item_sku). Group selected (G2) adds its
 * actions here without changing these.
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
 * One refusal -> its entry. Specific before general: a hint wins; 55P03 (a
 * held row, or the grouping lock's lock_timeout) and 57014 (statement
 * timeout) are busy only when no hint matched; anything else is internal,
 * with the generic sentence (the raw text stays server-side).
 */
export function mapGroupingError(err: GroupingDbError | null | undefined): MappedGroupingError {
  const key = groupingErrorKey(err);
  const detail = parseDetail(err?.details);
  const itemIds = Array.isArray(detail?.itemIds)
    ? (detail!.itemIds as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  if (key) {
    const entry = GROUPING_ERROR_TABLE[key]!;
    const message = key === 'not_groupable' && detail?.reason === 'kit' ? W.kit : entry.message;
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
  offline: 'Making a record its own item needs a connection. Try again when you are online.',
  confirmOne:
    'This record gets its own new SKU. Only this record changes. Stock, charter, rack, barcode/ISBN and history stay as they are.',
} as const;

/**
 * The edit form's banner when other records the caller can see share the
 * SKU (the seed's wording item): how many, which fields are shared, and how
 * to change one record alone. Null when no other record shares it. It never
 * counts records the caller cannot see.
 */
export function sharedSkuBannerCopy(othersVisible: number): string | null {
  if (!Number.isFinite(othersVisible) || othersVisible < 1) return null;
  const n = Math.floor(othersVisible);
  return `This SKU is also used by ${n} other record${n === 1 ? '' : 's'} you can see. Saving name, SKU, cost, price, description, category, barcode, reorder levels, item type or size changes every record with this SKU. To change only this record, use ${UNGROUP_COPY.makeOwnItem} on the item page.`;
}

/** The item screens' note next to Make this its own item. */
export function sharedSkuNoteCopy(othersVisible: number, sku: string): string | null {
  if (!Number.isFinite(othersVisible) || othersVisible < 1) return null;
  const n = Math.floor(othersVisible);
  return `SKU ${sku} is also used by ${n} other record${n === 1 ? '' : 's'} you can see. Editing the name, SKU, cost, price or category changes all of them.`;
}

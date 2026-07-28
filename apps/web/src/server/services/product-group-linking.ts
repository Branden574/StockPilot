import 'server-only';

import {
  buildVariantKey,
  extractSize,
  normalizeJerseyNumber,
  normalizeSizeValue,
  sizeRunStyleKey,
  sortBySizeOrder,
  stripSizeSuffix,
  type CreateProductGroupInput,
} from '@stockpilot/core';

import { audit } from './audit';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  type ServiceContext,
} from './context';
import type { ProductGroupsService } from './product-groups';

/**
 * The opt-in group-linking review tool.
 *
 * OWNER DECISION 2026-07-27: "New items group at creation; existing families
 * link via a bulk review tool the owner drives. Display heuristics remain as
 * fallback. NO name-heuristic auto-backfill."
 *
 * So: `suggestFamilies` PROPOSES, using the same display heuristic the lists
 * already use. `linkFamily` WRITES, and only ever from an explicit call
 * carrying the exact item ids a human confirmed. There is no code path in
 * this file that writes group_id without an explicit item id list.
 *
 * WHY A BACKFILL WAS REFUSED, restated here because this file is where someone
 * would be tempted to add one: the heuristic reads a DISPLAY STRING. Two
 * genuinely different products whose names happen to share a base collapse
 * into one family, and a family whose names were never normalized does not
 * collapse at all. As a list rendering that is a cosmetic miss you can fix by
 * looking away; written into `group_id` it becomes persistent identity that
 * receiving, counting and PO matching all trust. Hence: suggest freely, write
 * only what a human named.
 *
 * WHAT THIS FILE MAY NEVER TOUCH: `quantity_on_hand`, `stock_movements`, or
 * `item_stock_levels`. Linking answers "which product is this?", never "how
 * much of it is there?" — the ledger invariant
 * (SUM(stock_movements.quantity_change) = quantity_on_hand) is not this
 * module's business and a write here would break it silently.
 */

/** Columns read for a suggestion. Deliberately narrow — this is a scan. */
const SUGGEST_COLUMNS =
  'id, name, sku, quantity_on_hand, category_id, warehouse_id, unit_of_measure, tracking_type';

/** Columns read before a WRITE: everything the variant key is computed from. */
const LINK_TARGET_COLUMNS =
  'id, name, sku, group_id, quantity_on_hand, variant_size, variant_size_original, ' +
  'variant_size_system, variant_width, variant_fit, variant_color, jersey_number, ' +
  'player_name, variant_key';

/** How many ungrouped rows one suggestion pass will read. */
const SUGGEST_SCAN_CAP = 2000;

/** Default number of families proposed per pass. */
const DEFAULT_SUGGESTION_LIMIT = 25;

/** Hard ceiling on one link call, so a runaway client cannot walk the catalog. */
const MAX_LINK_MEMBERS = 200;

export interface FamilySuggestionMember {
  id: string;
  name: string;
  sku: string;
  /** The size the NAME heuristic parsed. A guess, shown so a human can correct it. */
  parsedSize: string | null;
  quantity: number;
}

/**
 * How much the heuristic agrees with itself. NEVER 'high': a name-only match
 * is never strong evidence of identity (requirements 13), and a label saying
 * otherwise would invite exactly the unreviewed bulk accept the opt-in rule
 * exists to prevent.
 */
export type SuggestionConfidence = 'medium' | 'low';

export interface FamilySuggestion {
  styleKey: string;
  baseName: string;
  members: FamilySuggestionMember[];
  /** Why this is only a suggestion: what the heuristic could not tell. */
  caveats: string[];
  confidence: SuggestionConfidence;
}

interface SuggestRow {
  id: string;
  name: string;
  sku: string | null;
  quantity_on_hand: number | null;
  category_id: string | null;
  warehouse_id: string | null;
  unit_of_measure: string | null;
  tracking_type: string | null;
}

/**
 * Propose families among the org's UNGROUPED items, using the same name
 * heuristic the inventory lists already render with.
 *
 * READ ONLY. Nothing in this function writes, and a test asserts it: the value
 * of a review tool is that the reviewer, not the tool, decides.
 *
 * Scoped to `group_id IS NULL` because an item that already has an identity is
 * not a candidate — re-proposing it would invite a silent regroup, and moving
 * an item between groups is a separate, explicit call (`linkFamily` with
 * `force`).
 */
export async function suggestFamilies(
  deps: { supabase: ServiceContext['supabase']; organizationId: string },
  opts: { categoryId?: string | null; warehouseId?: string | null; limit?: number } = {},
): Promise<FamilySuggestion[]> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_SUGGESTION_LIMIT, 1), 100);

  let q = deps.supabase
    .from('inventory_items')
    .select(SUGGEST_COLUMNS)
    .eq('organization_id', deps.organizationId)
    .is('deleted_at', null)
    .is('group_id', null)
    .eq('status', 'active')
    .eq('is_rental', false)
    // Books are never sized (the lists gate size runs off for them for the
    // same reason), and a phantom awaiting its first receipt is not yet a
    // thing anyone can look at on a shelf to confirm a family.
    .neq('item_type', 'book')
    .eq('awaiting_first_receipt', false)
    .order('name', { ascending: true })
    .limit(SUGGEST_SCAN_CAP);
  if (opts.categoryId) q = q.eq('category_id', opts.categoryId);
  if (opts.warehouseId) q = q.eq('warehouse_id', opts.warehouseId);

  const { data, error } = await q;
  if (error) throw new ServiceError('internal_error', error.message);
  const rows = (data ?? []) as unknown as SuggestRow[];

  // Cluster on the SAME key the lists collapse on, so what the reviewer is
  // asked to confirm is exactly what they can already see collapsed.
  const byKey = new Map<string, SuggestRow[]>();
  for (const r of rows) {
    const key = sizeRunStyleKey(r.name);
    if (!key) continue;
    const arr = byKey.get(key);
    if (arr) arr.push(r);
    else byKey.set(key, [r]);
  }

  const out: FamilySuggestion[] = [];
  for (const [styleKey, members] of byKey) {
    // A one-member "family" is not a family — the same rule the list renderer
    // applies before it collapses anything.
    if (members.length < 2) continue;
    const ordered = sortBySizeOrder(members, (m) => extractSize(m.name));
    const caveats = buildCaveats(ordered);
    out.push({
      styleKey,
      baseName: stripSizeSuffix(members[0]!.name),
      members: ordered.map((m) => ({
        id: m.id,
        name: m.name,
        sku: m.sku ?? '',
        parsedSize: extractSize(m.name),
        quantity: Number(m.quantity_on_hand) || 0,
      })),
      caveats,
      // The first caveat is on every proposal (the name-only disclosure), so
      // "nothing else went wrong" is the ceiling, and the ceiling is 'medium'.
      confidence: caveats.length > 1 ? 'low' : 'medium',
    });
  }

  // Biggest families first: they are the ones worth a reviewer's attention,
  // and they are also the ones a wrong guess would damage most.
  out.sort((a, b) => b.members.length - a.members.length || a.baseName.localeCompare(b.baseName));
  return out.slice(0, limit);
}

/**
 * The honest disclosure attached to every proposal.
 *
 * Requirement 13: "Matching is deterministic and never name-string-only.
 * Ambiguous matches go to review." A name heuristic IS name-string-only, so
 * every one of these proposals is by definition ambiguous — the caveats say
 * WHICH way, so the reviewer knows what to check rather than being told a
 * confidence number they cannot audit.
 */
function buildCaveats(members: readonly SuggestRow[]): string[] {
  const caveats: string[] = [
    'Matched on the item name only. Brand, model, style number and colorway were not compared.',
  ];

  const categories = new Set(members.map((m) => m.category_id ?? ''));
  if (categories.size > 1) {
    caveats.push(`These items sit in ${categories.size} different categories.`);
  }
  const warehouses = new Set(members.map((m) => m.warehouse_id ?? ''));
  if (warehouses.size > 1) {
    caveats.push(`These items sit in ${warehouses.size} different warehouses.`);
  }
  const uoms = new Set(members.map((m) => (m.unit_of_measure ?? '').toLowerCase()));
  if (uoms.size > 1) {
    caveats.push('These items are counted in different units of measure.');
  }
  const trackings = new Set(members.map((m) => m.tracking_type ?? ''));
  if (trackings.size > 1) {
    caveats.push('These items do not all use the same tracking type.');
  }

  const sizes = members.map((m) => normalizeSizeValue(extractSize(m.name))).filter(Boolean);
  const dupSizes = sizes.filter((s, i) => sizes.indexOf(s) !== i);
  if (dupSizes.length > 0) {
    caveats.push(
      `More than one item parsed to the same size (${Array.from(new Set(dupSizes)).join(', ')}).`,
    );
  }
  if (sizes.length < members.length) {
    caveats.push('Not every item name ends in a size that could be read.');
  }
  return caveats;
}

/** One member of an explicit link. Every field is what a HUMAN confirmed. */
export interface LinkFamilyMember {
  itemId: string;
  variantSize: string | null;
  variantSizeOriginal: string | null;
  variantSizeSystem: string | null;
  jerseyNumber: string | null;
}

export interface LinkFamilyInput {
  /** The group to link into. Absent means create one from `group`. */
  groupId?: string;
  group?: CreateProductGroupInput & { subcategoryKey: string };
  /** EXPLICIT item ids. Nothing is inferred at write time. */
  members: LinkFamilyMember[];
  /** Required. Stored on the audit event. */
  reason: string;
  /**
   * Move items that ALREADY belong to a different group. Off by default: a
   * silent regroup would rewrite an identity another surface is already
   * trusting, so it takes a second, deliberate act.
   */
  force?: boolean;
}

interface LinkTargetRow {
  id: string;
  name: string;
  sku: string | null;
  group_id: string | null;
  quantity_on_hand: number | null;
  variant_size: string | null;
  variant_size_original: string | null;
  variant_size_system: string | null;
  variant_width: string | null;
  variant_fit: string | null;
  variant_color: string | null;
  jersey_number: string | null;
  player_name: string | null;
  variant_key: string | null;
}

/**
 * Link an EXPLICIT list of items into one product group.
 *
 * `variant_key` is SERVER-COMPUTED from the confirmed attributes, exactly as
 * every other write path computes it (`ProductGroupsService` documents why for
 * `group_key`, and the reasoning is the same one step down): the key is the
 * identity two variants are matched on, so a client-supplied key would let a
 * caller merge two physical sizes into one variant — and merge their stock
 * with them.
 *
 * Nothing is written until the WHOLE batch is resolved and checked: an item
 * from another org, an item in a different group, or two items claiming one
 * variant key (`assertNoVariantKeyCollision`) all refuse the call before the
 * first update.
 */
export async function linkFamily(
  deps: {
    groups: ProductGroupsService;
    supabase: ServiceContext['supabase'];
    ctx: ServiceContext;
  },
  input: LinkFamilyInput,
): Promise<{ groupId: string; linked: number }> {
  const { ctx, supabase, groups } = deps;
  assertPermission(ctx, 'sports:manage');
  assertModuleEnabled(ctx, 'sports');

  const reason = input.reason?.trim() ?? '';
  if (reason.length === 0) {
    throw new ServiceError('validation_error', 'A reason is required to link a product family.');
  }
  if (input.members.length === 0) {
    throw new ServiceError('validation_error', 'Select at least one item to link.');
  }
  if (input.members.length > MAX_LINK_MEMBERS) {
    throw new ServiceError(
      'validation_error',
      `Link at most ${MAX_LINK_MEMBERS} items at a time.`,
    );
  }
  const ids = input.members.map((m) => m.itemId);
  if (new Set(ids).size !== ids.length) {
    throw new ServiceError('validation_error', 'The same item was listed twice.');
  }
  if (!input.groupId && !input.group) {
    throw new ServiceError(
      'validation_error',
      'Pick an existing product group or supply one to create.',
    );
  }

  // NEVER TRUST CLIENT IDS. Read the targets back under the caller's org
  // before anything is resolved or written: an id from another org must fail
  // here, not be discovered by an .update().eq() quietly matching no rows
  // (that path is fail-OPEN — no error, no row, and a success response).
  const { data, error } = await supabase
    .from('inventory_items')
    .select(LINK_TARGET_COLUMNS)
    .eq('organization_id', ctx.organizationId)
    .in('id', ids)
    .is('deleted_at', null);
  if (error) throw new ServiceError('internal_error', error.message);
  const found = (data ?? []) as unknown as LinkTargetRow[];
  const byId = new Map(found.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new ServiceError(
      'not_found',
      `${missing.length} of the selected items are not in this organization.`,
    );
  }

  // Resolve the destination AFTER the ownership check, so a bad id can never
  // cause a group to be created as a side effect.
  let groupId: string;
  if (input.groupId) {
    // .get() re-asserts the module and scopes by org; a group from another
    // org surfaces as not_found rather than being linked into.
    groupId = (await groups.get(input.groupId)).id;
  } else {
    groupId = (await groups.findOrCreate(input.group!)).group.id;
  }

  // Refuse a silent regroup. Items already in the DESTINATION group are fine
  // (re-linking to correct a size is a normal edit); items in a DIFFERENT
  // group are the dangerous case.
  if (!input.force) {
    const conflicting = found.filter((r) => r.group_id && r.group_id !== groupId);
    if (conflicting.length > 0) {
      throw new ServiceError(
        'conflict',
        `${conflicting.length} of the selected items already belong to a different product group. ` +
          'Confirm the move to link them anyway.',
        { code: 'ITEM_ALREADY_GROUPED', itemIds: conflicting.map((r) => r.id) },
      );
    }
  }

  // Resolve every member's final attributes BEFORE writing anything, so the
  // duplicate-key check below sees the whole batch and a refusal costs no
  // half-applied link.
  const planned = input.members.map((member) => {
    const before = byId.get(member.itemId)!;

    // Normalize what the human typed, keeping the original text alongside it
    // (requirements: "Keep original imported text + normalized form"). An
    // explicit original wins; otherwise the typed value IS the original.
    const size = normalizeSizeValue(member.variantSize, member.variantSizeSystem);
    const sizeOriginal =
      member.variantSizeOriginal?.trim() || member.variantSize?.trim() || null;
    const sizeSystem = member.variantSizeSystem?.trim() || null;
    const jersey = normalizeJerseyNumber(member.jerseyNumber);

    // Attributes NOT under review (width / fit / colour / player) are carried
    // through from the row so the key describes the whole variant, not just
    // the two fields this screen happens to edit.
    const variantKey = buildVariantKey({
      size,
      sizeSystem,
      width: before.variant_width,
      fit: before.variant_fit,
      color: before.variant_color,
      jerseyNumber: jersey,
      playerName: before.player_name,
    });
    return { member, before, size, sizeOriginal, sizeSystem, jersey, variantKey };
  });

  await assertNoVariantKeyCollision({ supabase, ctx, groupId, planned });

  let linked = 0;
  for (const { member, before, size, sizeOriginal, sizeSystem, jersey, variantKey } of planned) {
    const patch = {
      group_id: groupId,
      variant_size: size,
      variant_size_original: sizeOriginal,
      variant_size_system: sizeSystem,
      jersey_number: jersey,
      variant_key: variantKey,
      updated_by: ctx.userId,
    };

    const { data: updated, error: updErr } = await supabase
      .from('inventory_items')
      .update(patch)
      .eq('organization_id', ctx.organizationId)
      .eq('id', member.itemId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();
    if (updErr) throw new ServiceError('internal_error', updErr.message);
    // .update().eq() is FAIL-OPEN when RLS hides the row: no error, no row.
    // A link that silently did nothing must not be reported as a link.
    if (!updated) {
      throw new ServiceError(
        'forbidden',
        'One of the selected items could not be updated. Nothing further was linked.',
      );
    }
    linked += 1;

    // One event per item, carrying who / before / after / why. A grouping that
    // later looks wrong has to be answerable, and "the review tool did it" is
    // not an answer — the actor and the reason are.
    void audit(
      {
        event: 'sports.item.group_matched',
        entityType: 'inventory_item',
        entityId: member.itemId,
        reason,
        before: {
          group_id: before.group_id,
          variant_size: before.variant_size,
          variant_size_original: before.variant_size_original,
          variant_size_system: before.variant_size_system,
          jersey_number: before.jersey_number,
          variant_key: before.variant_key,
        },
        after: {
          group_id: groupId,
          variant_size: size,
          variant_size_original: sizeOriginal,
          variant_size_system: sizeSystem,
          jersey_number: jersey,
          variant_key: variantKey,
        },
        extra: { source: 'group_linking_review', forced: input.force === true },
      },
      ctx,
    );
  }

  return { groupId, linked };
}

/** One resolved member, as `linkFamily` computed it before writing. */
interface PlannedLink {
  member: LinkFamilyMember;
  before: LinkTargetRow;
  variantKey: string;
}

/** SKU comparison for the collision rule below. Blank never equals blank: two
 *  unidentified rows are not evidence of the same placement. */
function sameSku(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? '').trim().toLowerCase();
  const y = (b ?? '').trim().toLowerCase();
  return x.length > 0 && x === y;
}

/**
 * Refuse a link that would leave TWO different items answering to one
 * `variant_key` inside one group.
 *
 * WHY THIS IS A HARD REFUSAL. `variant_key` carries no uniqueness constraint
 * (see `variantsByKey`, which deliberately returns every colliding row rather
 * than picking a winner), so nothing downstream errors — receiving, counting
 * and PO matching simply find two candidates for one size and have to send a
 * human back to fix an identity that a human already confirmed. Two "L" rows
 * linked into one group is that state, created on purpose. Cheaper to refuse
 * the two rows now, while the reviewer is looking at them.
 *
 * THE MODEL B EXCEPTION. Uniqueness on `inventory_items` is (org, sku, charter,
 * bin) — the SAME sku legitimately exists as several rows, one per placement.
 * Those rows are one variant in two bins, not two variants claiming one
 * identity, so a matching SKU is allowed through. Only DIFFERING skus collide.
 *
 * `force` does not bypass this. Force answers "move this item out of its other
 * group"; it says nothing about two items claiming one size.
 */
async function assertNoVariantKeyCollision(args: {
  supabase: ServiceContext['supabase'];
  ctx: ServiceContext;
  groupId: string;
  planned: readonly PlannedLink[];
}): Promise<void> {
  const { supabase, ctx, groupId, planned } = args;
  const conflicts: Array<{ itemId: string; message: string }> = [];

  // (a) Inside the batch itself: the "two L rows" case.
  const byKey = new Map<string, PlannedLink[]>();
  for (const p of planned) {
    const arr = byKey.get(p.variantKey);
    if (arr) arr.push(p);
    else byKey.set(p.variantKey, [p]);
  }
  for (const [, rows] of byKey) {
    if (rows.length < 2) continue;
    for (const row of rows) {
      const clash = rows.find((o) => o !== row && !sameSku(o.before.sku, row.before.sku));
      if (!clash) continue;
      conflicts.push({
        itemId: row.before.id,
        message: `"${row.before.name}" (${row.before.sku ?? 'no SKU'}) and "${clash.before.name}" (${clash.before.sku ?? 'no SKU'}) would both be the same variant.`,
      });
    }
  }

  // (b) Against what the destination group already holds. Probed by the exact
  // keys being written, so the read is bounded by the batch, never by the
  // group's size.
  const keys = Array.from(new Set(planned.map((p) => p.variantKey))).filter(Boolean);
  if (keys.length > 0) {
    const { data, error } = await supabase
      .from('inventory_items')
      .select('id, name, sku, variant_key')
      .eq('organization_id', ctx.organizationId)
      .eq('group_id', groupId)
      .in('variant_key', keys)
      .is('deleted_at', null);
    if (error) throw new ServiceError('internal_error', error.message);
    const existing = (data ?? []) as unknown as Array<{
      id: string;
      name: string;
      sku: string | null;
      variant_key: string | null;
    }>;
    const inBatch = new Set(planned.map((p) => p.before.id));
    for (const p of planned) {
      const clash = existing.find(
        (e) =>
          // Never the item against itself: re-linking to correct a size is a
          // normal edit, and the row it would "collide" with is the row being
          // rewritten.
          !inBatch.has(e.id) && e.variant_key === p.variantKey && !sameSku(e.sku, p.before.sku),
      );
      if (!clash) continue;
      conflicts.push({
        itemId: p.before.id,
        message: `"${p.before.name}" (${p.before.sku ?? 'no SKU'}) would duplicate "${clash.name}" (${clash.sku ?? 'no SKU'}), already in this group.`,
      });
    }
  }

  if (conflicts.length === 0) return;
  // Deduped per item so a row named in both halves is reported once.
  const seen = new Set<string>();
  const unique = conflicts.filter((c) => (seen.has(c.itemId) ? false : seen.add(c.itemId)));
  throw new ServiceError(
    'conflict',
    `${unique.length} ${unique.length === 1 ? 'item' : 'items'} would duplicate a variant that already exists in this group. ` +
      unique.map((c) => c.message).join(' ') +
      ' Give each one its own size or number, or leave the duplicates out.',
    {
      code: 'VARIANT_ALREADY_EXISTS',
      itemIds: unique.map((c) => c.itemId),
      rows: unique,
    },
  );
}

/**
 * Undo. A link is reversible precisely because nothing else depends on it.
 *
 * `variant_key` goes with the group (a variant key means nothing outside one),
 * but the OBSERVED attributes — size, size system, jersey number — are kept.
 * Those describe the physical thing on the shelf and were true before the link
 * and after it; clearing them would turn "I grouped this wrongly" into a data
 * loss.
 */
export async function unlinkItems(
  deps: { supabase: ServiceContext['supabase']; ctx: ServiceContext },
  input: { itemIds: string[]; reason: string },
): Promise<{ unlinked: number }> {
  const { ctx, supabase } = deps;
  assertPermission(ctx, 'sports:manage');
  assertModuleEnabled(ctx, 'sports');

  const reason = input.reason?.trim() ?? '';
  if (reason.length === 0) {
    throw new ServiceError('validation_error', 'A reason is required to unlink an item.');
  }
  const ids = Array.from(new Set(input.itemIds));
  if (ids.length === 0) {
    throw new ServiceError('validation_error', 'Select at least one item to unlink.');
  }
  if (ids.length > MAX_LINK_MEMBERS) {
    throw new ServiceError(
      'validation_error',
      `Unlink at most ${MAX_LINK_MEMBERS} items at a time.`,
    );
  }

  const { data, error } = await supabase
    .from('inventory_items')
    .select('id, group_id, variant_key')
    .eq('organization_id', ctx.organizationId)
    .in('id', ids)
    .is('deleted_at', null);
  if (error) throw new ServiceError('internal_error', error.message);
  const found = (data ?? []) as unknown as Array<{
    id: string;
    group_id: string | null;
    variant_key: string | null;
  }>;
  const byId = new Map(found.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new ServiceError(
      'not_found',
      `${missing.length} of the selected items are not in this organization.`,
    );
  }

  let unlinked = 0;
  for (const id of ids) {
    const before = byId.get(id)!;
    // Already ungrouped — nothing to undo, and no audit noise for a no-op.
    if (!before.group_id) continue;

    const { data: updated, error: updErr } = await supabase
      .from('inventory_items')
      .update({ group_id: null, variant_key: null, updated_by: ctx.userId })
      .eq('organization_id', ctx.organizationId)
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();
    if (updErr) throw new ServiceError('internal_error', updErr.message);
    if (!updated) {
      throw new ServiceError(
        'forbidden',
        'One of the selected items could not be updated. Nothing further was unlinked.',
      );
    }
    unlinked += 1;

    void audit(
      {
        event: 'sports.item.group_unlinked',
        entityType: 'inventory_item',
        entityId: id,
        reason,
        before: { group_id: before.group_id, variant_key: before.variant_key },
        after: { group_id: null, variant_key: null },
        extra: { source: 'group_linking_review' },
      },
      ctx,
    );
  }

  return { unlinked };
}

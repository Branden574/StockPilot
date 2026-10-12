import 'server-only';

import {
  can,
  GROUPING_ERROR_WORDS,
  GROUPING_MAX_ITEMS,
  parseUngroupSelectedBody,
  UNGROUP_COPY,
  type GroupingSurface,
  type UngroupPartKind,
  type UngroupPartResult,
  type UngroupSelectedOutcome,
} from '@stockpilot/core';

import { assertPermission, isModuleEnabled, ServiceError, type ServiceContext } from './context';
import {
  assertGroupingPermission,
  ItemGroupingService,
  type GroupingReview,
  type UngroupCandidate,
} from './item-grouping';
import { unlinkItems } from './product-group-linking';

/**
 * Ungroup anything (owner 2026-10-12): the bulk bar's Ungroup on Items and
 * Books, on the web and the phone, for ANY ticked records. Each record leaves
 * the grouping it is shown under (core planUngroupSelected decides; the
 * screens show it before Save):
 *   remove  a display group: apply_item_grouping 'remove' (0400);
 *   split   a shared SKU: split_item_sku (0399), the oldest keeping a fully
 *           ticked SKU;
 *   unlink  a size family: unlinkItems, as Product groups > Unlink (SKU,
 *           stock, rack, charter and history unchanged).
 * This service only REUSES those writes: ItemGroupingService.applyGrouping
 * and .splitSku (keyed, idempotent, each one transaction, a busy answer
 * retried with the same key) and unlinkItems (one update per family batch,
 * filtered on the family each record was reviewed in, audited, no key: a
 * record already out of its family is done).
 *
 * THE ORDER is fixed: remove, then split, then unlink (UNGROUP_PART_ORDER).
 * The two keyed, all-or-nothing steps go first; the unkeyed one, which can
 * stop part-way, goes last. A step runs only when every step before it applied: the
 * first refusal stops the run, and the answer names each step's records as
 * applied, refused, partly applied or not tried, so nothing is ever left
 * half-applied without saying so. Sending the SAME body again replays the
 * keyed steps that applied and finds the unlinked records already out of
 * their family, so "Try again" after busy or a lost answer is safe.
 *
 * BEFORE ANY WRITE: the gate (MFA floor and items:update, first, as every
 * grouping entry point), the body's shape (core), the organization and the
 * account; a family step also needs sports:manage with the sports module on
 * (unlinkItems' own gate, checked here first so a refusal writes nothing),
 * and each family record is read back under the caller's RLS: one that is
 * gone refuses the whole Save, one moved to another family since the review
 * refuses it ("changed since you opened this"), one already out is done.
 */

export interface UngroupSelectedReview {
  /** item_grouping_preview's records (group, family, whether the caller can
   *  edit each) with their names, rack line and picture. */
  review: GroupingReview;
  /** Every live record of the ticked records' SKUs the caller can read,
   *  oldest first (the split's anchor rule). */
  candidates: UngroupCandidate[];
  /** The caller may take records out of a size family (sports:manage with
   *  the sports module on). */
  canUnlinkFamilies: boolean;
  /** What the answer is for (core groupingPreviewKey of the ticked ids). */
  previewKey: string;
}

export interface UngroupSelectedResult {
  organizationId: string;
  outcome: UngroupSelectedOutcome;
}

type Unlink = typeof unlinkItems;

interface Deps {
  /** Injected by tests; real calls use the request's own service. */
  grouping?: Pick<
    ItemGroupingService,
    'previewGroup' | 'previewSplit' | 'applyGrouping' | 'splitSku'
  >;
  unlink?: Unlink;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The caller may unlink families: unlinkItems' own gate, as a yes or no. */
export function canUnlinkFamilies(ctx: ServiceContext): boolean {
  return can(ctx, 'sports:manage') && isModuleEnabled(ctx, 'sports');
}

/** A keyed step's (remove, split) refusal in core's words; never a raw
 *  message. One with no words of its own (a transport failure after the
 *  database committed, or an answer that could not be read) may have
 *  applied: it is 'unknown' and retryable, since the same keys replay
 *  (G2 security review LOW). */
function partWords(e: unknown): { message: string; reason: string; retryable: boolean } {
  if (e instanceof ServiceError && e.code !== 'internal_error') {
    const reason = typeof e.details?.reason === 'string' ? e.details.reason : e.code;
    return { message: e.message, reason, retryable: e.details?.retryable === true };
  }
  console.error('[ungroup-selected] step failed:', e instanceof Error ? e.message : String(e));
  return { message: UNGROUP_COPY.stepUnknown, reason: 'unknown', retryable: true };
}

/** unlinkItems' refusals in core's words (its own sentences name its screen). */
function unlinkWords(e: unknown): { message: string; reason: string; retryable: boolean } {
  if (e instanceof ServiceError) {
    const reason = typeof e.details?.reason === 'string' ? e.details.reason : null;
    if (reason === 'aal2_required' || reason === 'mfa_required')
      return { message: e.message, reason, retryable: false };
    if (e.code === 'forbidden')
      return { message: GROUPING_ERROR_WORDS.notWritable, reason: 'forbidden', retryable: false };
    if (e.code === 'not_found')
      return { message: GROUPING_ERROR_WORDS.notFound, reason: 'not_found', retryable: false };
    if (e.code === 'validation_error')
      return { message: GROUPING_ERROR_WORDS.invalid, reason: 'invalid', retryable: false };
    // A record moved to another family between the check and the write.
    if (e.code === 'conflict' && reason === 'family_changed')
      return { message: UNGROUP_COPY.familyChanged, reason, retryable: false };
  }
  console.error('[ungroup-selected] unlink failed:', e instanceof Error ? e.message : String(e));
  return { message: GROUPING_ERROR_WORDS.internal, reason: 'internal_error', retryable: false };
}

function notTried(kind: UngroupPartKind, ids: string[]): UngroupPartResult {
  return {
    kind,
    status: 'not_attempted',
    changedItemIds: [],
    notChangedItemIds: ids,
    message: null,
    reason: null,
    retryable: false,
  };
}

export class UngroupSelectedService {
  private readonly grouping: NonNullable<Deps['grouping']>;
  private readonly unlink: Unlink;

  constructor(
    private readonly ctx: ServiceContext,
    deps: Deps = {},
  ) {
    this.grouping = deps.grouping ?? new ItemGroupingService(ctx);
    this.unlink = deps.unlink ?? unlinkItems;
  }

  /**
   * The review: the ticked records the caller can read (the rest as a count)
   * with their group, family and whether the caller can edit each
   * (item_grouping_preview, as the caller), every live record of their SKUs
   * the caller can read (the split's anchor), and whether the caller may
   * take records out of a size family. Reads only: Cancel writes nothing.
   */
  async preview(itemIds: readonly string[]): Promise<UngroupSelectedReview> {
    assertGroupingPermission(this.ctx);
    if (itemIds.length > GROUPING_MAX_ITEMS) {
      throw new ServiceError('validation_error', GROUPING_ERROR_WORDS.tooMany, {
        reason: 'invalid',
        field: 'item_ids',
      });
    }
    if (itemIds.length === 0 || !itemIds.every((id) => UUID.test(id))) {
      throw new ServiceError('validation_error', GROUPING_ERROR_WORDS.invalid, {
        reason: 'invalid',
        field: 'item_ids',
      });
    }
    const [review, split] = await Promise.all([
      this.grouping.previewGroup(itemIds, null),
      this.grouping.previewSplit(itemIds),
    ]);
    return {
      review,
      candidates: split.candidates,
      canUnlinkFamilies: canUnlinkFamilies(this.ctx),
      previewKey: review.previewKey,
    };
  }

  /** Each family record's current family under the caller's RLS (live
   *  records only); null when the read failed. */
  private async readFamilies(ids: readonly string[]): Promise<Map<string, string | null> | null> {
    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, group_id')
      .eq('organization_id', this.ctx.organizationId)
      // in-list-bound: at most GROUPING_MAX_ITEMS (100) ids, parsed by core
      .in('id', [...ids])
      .is('deleted_at', null);
    if (error) return null;
    return new Map(
      ((data ?? []) as Array<{ id: string; group_id: string | null }>).map((r) => [
        r.id.toLowerCase(),
        r.group_id ? r.group_id.toLowerCase() : null,
      ]),
    );
  }

  /** One Ungroup Save (core UngroupSelectedBody), in the fixed order. */
  async apply(raw: unknown, surface: GroupingSurface): Promise<UngroupSelectedResult> {
    assertGroupingPermission(this.ctx);
    const parsed = parseUngroupSelectedBody(raw);
    if (!parsed.ok) {
      throw new ServiceError('validation_error', parsed.refusal.message, {
        reason: parsed.refusal.reason,
        field: parsed.refusal.field,
      });
    }
    const body = parsed.body;
    if (body.organizationId !== this.ctx.organizationId.toLowerCase()) {
      throw new ServiceError('forbidden', GROUPING_ERROR_WORDS.workspaceChanged, {
        reason: 'workspace_changed',
      });
    }
    if (body.actorUserId !== this.ctx.userId.toLowerCase()) {
      throw new ServiceError('forbidden', GROUPING_ERROR_WORDS.actorMismatch, {
        reason: 'actor_mismatch',
      });
    }

    // The family step's gate and its records, before anything is written.
    let toUnlink: string[] = [];
    let alreadyOut: string[] = [];
    if (body.unlink) {
      try {
        assertPermission(this.ctx, 'sports:manage');
      } catch (e) {
        const reason = e instanceof ServiceError ? e.details?.reason : null;
        if (reason === 'aal2_required' || reason === 'mfa_required') throw e;
        throw new ServiceError('forbidden', UNGROUP_COPY.familyPermission, {
          reason: 'family_permission',
        });
      }
      if (!isModuleEnabled(this.ctx, 'sports')) {
        throw new ServiceError('forbidden', UNGROUP_COPY.familyPermission, {
          reason: 'family_permission',
        });
      }
      const current = await this.readFamilies(body.unlink.itemIds);
      if (!current)
        throw new ServiceError('internal_error', 'ungroup-selected: family read failed');
      const gone = body.unlink.itemIds.filter((id) => !current.has(id));
      if (gone.length > 0) {
        throw new ServiceError('not_found', GROUPING_ERROR_WORDS.notFound, {
          reason: 'item_not_found',
          itemIds: gone,
        });
      }
      const moved = body.unlink.itemIds.filter((id) => {
        const now = current.get(id) ?? null;
        return now !== null && now !== body.unlink!.expectedFamilies[id];
      });
      if (moved.length > 0) {
        throw new ServiceError('conflict', UNGROUP_COPY.familyChanged, {
          reason: 'family_changed',
          itemIds: moved,
        });
      }
      alreadyOut = body.unlink.itemIds.filter((id) => current.get(id) === null);
      toUnlink = body.unlink.itemIds.filter((id) => current.get(id) !== null);
    }

    const parts: UngroupPartResult[] = [];
    let stopped = false;

    // 1. Records leaving their display group.
    if (body.remove) {
      const ids = body.remove.itemIds;
      try {
        const answer = await this.grouping.applyGrouping(
          {
            action: 'remove',
            idempotencyKey: body.remove.idempotencyKey,
            organizationId: body.organizationId,
            actorUserId: body.actorUserId,
            itemIds: ids,
            expectedGroups: body.remove.expectedGroups,
          },
          surface,
        );
        // Applied (or a replay of it): the records it took out. The rest, and
        // every record on a no-op, were already out of any group and were
        // left as they are: named as not changed, never as leaving.
        const changed = ids.filter((id) =>
          answer.outcome.changes.some((c) => c.itemId.toLowerCase() === id),
        );
        parts.push({
          kind: 'remove',
          status: 'applied',
          changedItemIds: changed,
          notChangedItemIds: ids.filter((id) => !changed.includes(id)),
          message: null,
          reason: null,
          retryable: false,
        });
      } catch (e) {
        const w = partWords(e);
        parts.push({
          kind: 'remove',
          status: 'refused',
          changedItemIds: [],
          notChangedItemIds: ids,
          ...w,
        });
        stopped = true;
      }
    }

    // 2. Records getting their own SKU.
    if (body.split) {
      const ids = body.split.itemIds;
      if (stopped) parts.push(notTried('split', ids));
      else {
        try {
          const answer = await this.grouping.splitSku(
            {
              idempotencyKey: body.split.idempotencyKey,
              organizationId: body.organizationId,
              actorUserId: body.actorUserId,
              itemIds: ids,
              expectedSkus: body.split.expectedSkus,
              anchorItemIds: body.split.anchorItemIds,
            },
            surface,
          );
          parts.push({
            kind: 'split',
            status: 'applied',
            // A record that kept the SKU (the anchor) did not change.
            changedItemIds: answer.items.filter((i) => !i.kept).map((i) => i.id),
            notChangedItemIds: [],
            message: null,
            reason: null,
            retryable: false,
            splitItems: answer.items,
          });
        } catch (e) {
          const w = partWords(e);
          parts.push({
            kind: 'split',
            status: 'refused',
            changedItemIds: [],
            notChangedItemIds: ids,
            ...w,
          });
          stopped = true;
        }
      }
    }

    // 3. Records leaving their size family (it can stop part-way: read back
    //    which ones left when it does).
    if (body.unlink) {
      const ids = body.unlink.itemIds;
      if (stopped) parts.push(notTried('unlink', ids));
      else if (toUnlink.length === 0) {
        parts.push({
          kind: 'unlink',
          status: 'applied',
          changedItemIds: alreadyOut,
          notChangedItemIds: [],
          message: null,
          reason: null,
          retryable: false,
        });
      } else {
        try {
          await this.unlink(
            { supabase: this.ctx.supabase, ctx: this.ctx },
            {
              itemIds: toUnlink,
              reason: UNGROUP_COPY.unlinkReason(surface),
              source: 'ungroup',
              surface,
              // The write is filtered on the family each record was reviewed in.
              expectedFamilies: body.unlink.expectedFamilies,
            },
          );
          parts.push({
            kind: 'unlink',
            status: 'applied',
            changedItemIds: [...alreadyOut, ...toUnlink],
            notChangedItemIds: [],
            message: null,
            reason: null,
            retryable: false,
          });
        } catch (e) {
          const w = unlinkWords(e);
          const now = await this.readFamilies(toUnlink).catch(() => null);
          if (!now) {
            parts.push({
              kind: 'unlink',
              status: 'refused',
              changedItemIds: alreadyOut,
              notChangedItemIds: toUnlink,
              message: UNGROUP_COPY.unlinkUnknown,
              reason: 'unknown',
              retryable: false,
            });
          } else {
            const left = toUnlink.filter((id) => now.has(id) && now.get(id) === null);
            const changed = [...alreadyOut, ...left];
            parts.push({
              kind: 'unlink',
              status: changed.length > 0 ? 'partial' : 'refused',
              changedItemIds: changed,
              notChangedItemIds: toUnlink.filter((id) => !left.includes(id)),
              ...w,
            });
          }
        }
      }
    }

    return {
      organizationId: this.ctx.organizationId,
      outcome: { parts, complete: parts.every((p) => p.status === 'applied') },
    };
  }
}

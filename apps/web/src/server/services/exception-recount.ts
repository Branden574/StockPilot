import 'server-only';

import {
  formatCycleCountNumber,
  isRecountableRule,
  isRecountSkipReason,
  RECOUNT_MANAGER_ONLY_COPY,
  RECOUNT_MAX_ITEMS,
  recountNotes,
  type RecountSkipReason,
} from '@stockpilot/core';

import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';

import { audit } from './audit';
import { ServiceError, withContext, type ServiceContext } from './context';
import { CycleCountsService, NO_COUNTABLE_PICKS_COPY } from './cycle-counts';
import { personFor, type OccurrencePerson } from './exception-occurrences';
import { assertAcceptedMember, assertCountStartFloors, gateCountItems } from './lib/count-start-preflight';
import { fetchAllRowsByIds, rawErrorText, reportDegradedRead } from './lib/fetch-by-ids';
import { postgrestErrorText } from './lib/postgrest-error';

/**
 * TARGETED RECOUNTS FROM THE EXCEPTION CENTER (F1-2, migration 0372).
 *
 * A manager picks open count_variance / over_reserved exceptions (or an item)
 * and starts ONE recount. It is an ordinary cycle count: staff record it
 * online or offline, a manager posts it through post_cycle_count, and the
 * after-post check decides whether each exception cleared. Nothing here writes
 * stock, and nothing here resolves an exception.
 *
 * ═══ THE ORDER OF CHECKS (the same as CycleCountsService.start) ═══
 *
 *   1. assertCountStartFloors  module, cycle_counts:assign + stock:adjust, the
 *                              manager role (lib/count-start-preflight.ts);
 *   2. assertAcceptedMember    the assignee, before anything is created;
 *   3. the occurrences, read under the caller's RLS (a missing one is 404);
 *   4. gateCountItems          write access to every warehouse the countable
 *                              items sit in;
 *   5. start_targeted_recount  one transaction: idempotency, per-item locks,
 *                              link to counts already in progress, one new
 *                              selection count for the rest, links;
 *   6. CycleCountsService.assign, AFTER the count exists, so the assign
 *      trigger fires the existing cycle_count.assigned notification. A failed
 *      assign keeps the count and says it is unassigned;
 *   7. ONE audit row with the id arrays (pattern #30).
 *
 * Steps 1, 2 and 4 are the SAME functions start() calls (pattern #26).
 *
 * ═══ ONE COUNT, EVEN WHEN TAPPED TWICE ═══
 *
 * The caller mints an idempotency key once per submission and sends the same
 * key on a retry. The database answers a repeat with the first call's count
 * (replay) instead of creating a second one, and refuses the same key for a
 * different selection (409). A retryable refusal (a lock wait past 5 s, a
 * statement timeout) rolled everything back, so resending the same key is
 * safe.
 *
 * ═══ NOTES REACH A LOCK SCREEN ═══
 *
 * The count's notes are the title of the assignee's push, so they say which
 * item (or how many) and never why: "Recount: <item>" or "Recount: N items"
 * (core recountNotes, at most 80 characters). They describe the NEW count's
 * items; if some items were already being counted elsewhere, the notes are
 * corrected before the assignee is notified.
 */

export interface ExceptionRecountInput {
  /** Open count_variance / over_reserved occurrences to recount. */
  occurrenceIds?: readonly string[] | null;
  /** Items to recount directly ("Count this item"). */
  itemIds?: readonly string[] | null;
  /** Assign the NEW count to this accepted member (null = unassigned). */
  assignedTo?: string | null;
  /** One per submission; resend the same key on a retry. */
  idempotencyKey?: string | null;
}

/** A count that already held some of the items: they were linked to it. */
export interface RecountLinkedExisting {
  cycleCountId: string;
  countNumber: number | null;
  /** "CC-000042", or null before the count has a number. */
  reference: string | null;
  /** Its assignee as the reader sees them; null when nobody is assigned. */
  assignedTo: RecountPerson | null;
  startedAt: string | null;
  itemIds: string[];
  /** The named occurrences linked to it. */
  occurrenceIds: string[];
}

/** A person as the reader sees them; `label` is null when their profile
 *  could not be read this time. */
export interface RecountPerson {
  id: string;
  label: string | null;
}

export interface RecountSkipped {
  /** The occurrence that was skipped, or null for an explicit item. */
  occurrenceId: string | null;
  itemId: string;
  /** The item's name when it could be read. */
  itemName: string | null;
  reason: RecountSkipReason;
}

export interface ExceptionRecountResult {
  /** The NEW count; null when every item was already being counted, or
   *  skipped. */
  cycleCountId: string | null;
  countNumber: number | null;
  reference: string | null;
  /** Lines in the new count; null on a replay. */
  lineCount: number | null;
  created: boolean;
  /** This key already started a recount: its count is returned, nothing new
   *  was made and nothing else was linked. */
  replay: boolean;
  /** Who the new count ended up assigned to (null = unassigned). Believe this
   *  over what was asked for. */
  assignedTo: string | null;
  /** An assignee was asked for and assigning failed: the count is kept,
   *  unassigned, and nobody was notified. */
  assignmentFailed: boolean;
  /** The new count's notes. */
  notes: string | null;
  /** Occurrences linked to the new count. */
  linked: string[];
  linkedExisting: RecountLinkedExisting[];
  skipped: RecountSkipped[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Longest idempotency key the database accepts (0372). */
const IDEMPOTENCY_KEY_MAX = 200;

/** The RPC's answer, as returned (see 0372's header for the shape). */
interface RpcResult {
  cycleCountId: string | null;
  countNumber: number | null;
  lineCount: number | null;
  created: boolean;
  replay: boolean;
  linked: string[];
  linkedExisting: Array<{
    cycleCountId: string;
    countNumber: number | null;
    assignedTo: string | null;
    startedAt: string | null;
    itemIds: string[];
    occurrenceIds: string[];
  }>;
  skipped: Array<{ occurrenceId: string | null; itemId: string; reason: RecountSkipReason }>;
}

function uniqueIds(values: readonly string[] | null | undefined, what: 'exception' | 'item'): string[] {
  const out = new Set<string>();
  for (const v of values ?? []) {
    const id = typeof v === 'string' ? v.trim() : '';
    if (!UUID.test(id)) {
      throw new ServiceError('validation_error', `That ${what} id is not valid.`, { reason: 'invalid_argument' });
    }
    out.add(id.toLowerCase());
  }
  return [...out];
}

function tooMany(): ServiceError {
  return new ServiceError(
    'validation_error',
    `A recount can include at most ${RECOUNT_MAX_ITEMS} items. Choose fewer and try again.`,
    { reason: 'recount_too_many_items' },
  );
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The RPC's jsonb, checked. A shape it cannot trust is an internal error:
 *  the count may exist, so it is never reported as "nothing started". */
function parseRpcResult(data: unknown): RpcResult {
  const r = (data !== null && typeof data === 'object' && !Array.isArray(data) ? data : null) as Record<
    string,
    unknown
  > | null;
  if (!r || typeof r.created !== 'boolean' || typeof r.replay !== 'boolean') {
    throw new ServiceError('internal_error', 'start_targeted_recount returned an unexpected shape');
  }
  const linkedExisting: RpcResult['linkedExisting'] = [];
  for (const e of Array.isArray(r.linkedExisting) ? r.linkedExisting : []) {
    const x = e as Record<string, unknown>;
    const id = str(x?.cycleCountId);
    if (!id) throw new ServiceError('internal_error', 'start_targeted_recount returned a count with no id');
    linkedExisting.push({
      cycleCountId: id,
      countNumber: num(x.countNumber),
      assignedTo: str(x.assignedTo),
      startedAt: str(x.startedAt),
      itemIds: strArray(x.itemIds),
      occurrenceIds: strArray(x.occurrenceIds),
    });
  }
  const skipped: RpcResult['skipped'] = [];
  for (const e of Array.isArray(r.skipped) ? r.skipped : []) {
    const x = e as Record<string, unknown>;
    const itemId = str(x?.itemId);
    if (!itemId || !isRecountSkipReason(x.reason)) {
      throw new ServiceError('internal_error', 'start_targeted_recount returned an unknown skip');
    }
    skipped.push({ occurrenceId: str(x.occurrenceId), itemId, reason: x.reason });
  }
  return {
    cycleCountId: str(r.cycleCountId),
    countNumber: num(r.countNumber),
    lineCount: num(r.lineCount),
    created: r.created,
    replay: r.replay,
    linked: strArray(r.linked),
    linkedExisting,
    skipped,
  };
}

/** A retry-safe refusal: the transaction rolled back, so resending the same
 *  idempotency key starts (or replays) the recount. */
function retryable(message: string, reason: string): ServiceError {
  return new ServiceError('conflict', message, { reason, retryable: true });
}

/**
 * start_targeted_recount's refusals, mapped by SQLSTATE and hint (never by
 * message text alone, pattern #28; the one exception is start_cycle_count's
 * own `cycle_count_no_items`, which carries no hint). Never 40001/40P01: the
 * functions raise neither (0367).
 */
export function mapRecountError(error: {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
}): ServiceError {
  const message = (error.message ?? '').trim();
  const hint = error.hint ?? null;
  switch (error.code) {
    case '42501':
      if (message === 'not_authenticated') {
        return new ServiceError('unauthenticated', 'Sign in again to start a recount.');
      }
      return new ServiceError('forbidden', RECOUNT_MANAGER_ONLY_COPY);
    case 'P0002': {
      const copy: Record<string, string> = {
        occurrence_not_found: 'An exception in this recount was not found. Refresh and try again.',
        item_not_found: 'An item in this recount was not found. Refresh and try again.',
        cycle_count_not_found: 'The count for this recount was not found. Refresh and try again.',
      };
      const reason = Object.hasOwn(copy, message) ? message : 'not_found';
      return new ServiceError('not_found', copy[reason] ?? 'Not found. Refresh and try again.', { reason });
    }
    case '22023': {
      const copy: Record<string, string> = {
        invalid_argument: 'This recount request is not valid.',
        recount_nothing_selected: 'Choose at least one exception or item to recount.',
        recount_too_many_items: `A recount can include at most ${RECOUNT_MAX_ITEMS} items. Choose fewer and try again.`,
        notes_too_long: 'The recount notes are too long.',
        idempotency_key_too_long: 'The request id is too long.',
      };
      const reason = hint && Object.hasOwn(copy, hint) ? hint : 'invalid_argument';
      return new ServiceError('validation_error', copy[reason]!, { reason });
    }
    case 'P0001':
      switch (hint) {
        case 'idempotency_conflict':
          return new ServiceError(
            'conflict',
            'This recount request was already used for a different selection. Refresh and try again.',
            { reason: 'idempotency_conflict' },
          );
        case 'recount_already_linked':
          return new ServiceError(
            'conflict',
            'An exception in this recount is already linked to another recount in progress. Refresh to see it.',
            { reason: 'recount_already_linked' },
          );
        case 'occurrence_resolved':
          return new ServiceError(
            'conflict',
            'An exception in this recount has already been resolved. Refresh and try again.',
            { reason: 'occurrence_resolved' },
          );
        case 'not_recountable':
          return new ServiceError('validation_error', 'A recount cannot settle this kind of exception.', {
            reason: 'not_recountable',
          });
        case 'recount_count_not_open':
        case 'recount_item_not_in_count':
        case 'recount_items_changed':
          return retryable('The counts changed while the recount was starting. Try again.', hint);
        default:
          break;
      }
      if (!hint && /^cycle_count_no_items\b/.test(message)) {
        return new ServiceError('validation_error', NO_COUNTABLE_PICKS_COPY, { reason: 'cycle_count_no_items' });
      }
      break;
    case '55P03':
    case '57014':
      return retryable(
        'Another recount or check is working on these items right now. Try again in a moment.',
        'recount_busy',
      );
    default:
      break;
  }
  return new ServiceError('internal_error', postgrestErrorText({ message: error.message ?? '' }), {
    code: error.code ?? null,
    hint,
  });
}

export class ExceptionRecountService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser(): Promise<ExceptionRecountService> {
    return new ExceptionRecountService(await withContext());
  }

  /** Start (or replay) a targeted recount. See the header for the steps. */
  async start(input: ExceptionRecountInput): Promise<ExceptionRecountResult> {
    // ── 1. The start floors (shared with CycleCountsService.start) ─────────
    assertCountStartFloors(this.ctx);

    const occurrenceIds = uniqueIds(input.occurrenceIds, 'exception');
    const explicitItemIds = uniqueIds(input.itemIds, 'item');
    if (occurrenceIds.length === 0 && explicitItemIds.length === 0) {
      throw new ServiceError('validation_error', 'Choose at least one exception or item to recount.', {
        reason: 'recount_nothing_selected',
      });
    }
    if (occurrenceIds.length > RECOUNT_MAX_ITEMS || explicitItemIds.length > RECOUNT_MAX_ITEMS) throw tooMany();
    const key = (input.idempotencyKey ?? '').trim() || null;
    if (key !== null && Array.from(key).length > IDEMPOTENCY_KEY_MAX) {
      throw new ServiceError('validation_error', 'The request id is too long.', {
        reason: 'idempotency_key_too_long',
      });
    }
    const assignee = (input.assignedTo ?? '').trim() || null;
    if (assignee !== null && !UUID.test(assignee)) {
      throw new ServiceError('validation_error', 'That user is not an active member of this organization.');
    }

    // ── 2. The assignee, before anything is created (SP-123) ───────────────
    if (assignee) await assertAcceptedMember(this.ctx, assignee);

    // ── 3. The occurrences, under the caller's RLS ─────────────────────────
    const occurrences = await this.readOccurrences(occurrenceIds);
    if (occurrences.length !== occurrenceIds.length) {
      throw new ServiceError('not_found', 'An exception in this recount was not found. Refresh and try again.', {
        reason: 'occurrence_not_found',
      });
    }
    const recountItemIds = [
      ...new Set([
        ...explicitItemIds,
        ...occurrences.filter((o) => o.resolved_at === null && isRecountableRule(o.rule)).map((o) => o.item_id),
      ]),
    ];
    if (recountItemIds.length > RECOUNT_MAX_ITEMS) throw tooMany();

    // ── 4. Write access per warehouse (shared with start), and the names ───
    const allItemIds = [...new Set([...recountItemIds, ...occurrences.map((o) => o.item_id)])];
    const [gate, names] = await Promise.all([this.gate(recountItemIds), this.readItemNames(allItemIds)]);
    const nameOf = (id: string) => names.get(id) ?? null;
    const notes = recountNotes(gate.items.map((i) => ({ name: nameOf(i.id) })));

    // ── 5. One transaction in the database ─────────────────────────────────
    const { data, error } = await this.ctx.supabase.rpc('start_targeted_recount', {
      p_org: this.ctx.organizationId,
      p_occurrence_ids: occurrenceIds.length > 0 ? occurrenceIds : null,
      p_item_ids: explicitItemIds.length > 0 ? explicitItemIds : null,
      p_notes: notes,
      p_idempotency_key: key,
    });
    if (error) throw mapRecountError(error);
    const res = parseRpcResult(data);

    // Notes belong to a count this call created (none on a replay, or when
    // every item was already being counted or was skipped), and they name the
    // NEW count's items. When some requested items were already being counted,
    // fewer went into it: correct the notes before the assignee is notified
    // (the push title reads them).
    let finalNotes = res.created ? notes : null;
    if (res.created && res.cycleCountId && res.lineCount !== null && res.lineCount !== gate.items.length) {
      finalNotes = await this.correctNotes(res, gate.items, nameOf, notes);
    }

    // ── 6. Assign, after the count exists ──────────────────────────────────
    let assignedTo: string | null = null;
    let assignmentFailed = false;
    if (res.cycleCountId && (res.created || res.replay)) {
      const outcome = await this.assignNewCount(res, assignee);
      assignedTo = outcome.assignedTo;
      assignmentFailed = outcome.failed;
    }

    const linkedExisting = await this.withAssigneeLabels(res.linkedExisting);
    const result: ExceptionRecountResult = {
      cycleCountId: res.cycleCountId,
      countNumber: res.countNumber,
      reference: formatCycleCountNumber(res.countNumber),
      lineCount: res.lineCount,
      created: res.created,
      replay: res.replay,
      assignedTo,
      assignmentFailed,
      notes: finalNotes,
      linked: res.linked,
      linkedExisting,
      skipped: res.skipped.map((s) => ({ ...s, itemName: nameOf(s.itemId) })),
    };

    // ── 7. One audit row (a replay did nothing new) ────────────────────────
    if (!res.replay) {
      await audit(
        {
          event: 'exception.recount_started',
          entityType: 'cycle_count',
          entityId: res.cycleCountId,
          after: {
            occurrenceIds,
            itemIds: explicitItemIds,
            cycleCountId: res.cycleCountId,
            countNumber: res.countNumber,
            lineCount: res.lineCount,
            notes: finalNotes,
            linked: res.linked,
            linkedExisting: res.linkedExisting.map((e) => ({
              cycleCountId: e.cycleCountId,
              itemIds: e.itemIds,
              occurrenceIds: e.occurrenceIds,
            })),
            skipped: res.skipped,
            assignedTo,
            assignmentFailed,
          },
        },
        this.ctx,
      );
    }
    return result;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async readOccurrences(
    ids: readonly string[],
  ): Promise<Array<{ id: string; item_id: string; rule: string; resolved_at: string | null }>> {
    const ctx = this.ctx;
    return fetchAllRowsByIds<{ id: string; item_id: string; rule: string; resolved_at: string | null }>(
      ids,
      (batch) => (from, to) =>
        ctx.supabase
          .from('exception_occurrences')
          .select('id, item_id, rule, resolved_at')
          .eq('organization_id', ctx.organizationId)
          .in('id', batch)
          .order('id', { ascending: true })
          .range(from, to),
    );
  }

  /** gateCountItems, with a warehouse refusal as the service's forbidden (the
   *  /api/v1/exceptions routes answer ServiceErrors only). */
  private async gate(itemIds: readonly string[]) {
    try {
      return await gateCountItems(this.ctx, itemIds);
    } catch (e) {
      if (e instanceof ForbiddenError) throw new ServiceError('forbidden', e.message);
      throw e;
    }
  }

  /** Item names for the notes and the skipped list. Cosmetic: a failed read
   *  is reported and the result carries no names ("Recount: 1 item"). */
  private async readItemNames(ids: readonly string[]): Promise<Map<string, string>> {
    const ctx = this.ctx;
    try {
      const rows = await fetchAllRowsByIds<{ id: string; name: string | null }>(
        ids,
        (batch) => (from, to) =>
          ctx.supabase
            .from('inventory_items')
            .select('id, name')
            .eq('organization_id', ctx.organizationId)
            .in('id', batch)
            .order('id', { ascending: true })
            .range(from, to),
      );
      return new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name as string]));
    } catch (err) {
      reportDegradedRead('exceptions.recount.item_names', err, { count: ids.length });
      return new Map();
    }
  }

  /** The notes for the items the new count actually holds. Best effort: the
   *  count stands either way, so a failed update is reported, not raised. */
  private async correctNotes(
    res: RpcResult,
    gated: ReadonlyArray<{ id: string }>,
    nameOf: (id: string) => string | null,
    requested: string | null,
  ): Promise<string | null> {
    const elsewhere = new Set(res.linkedExisting.flatMap((e) => e.itemIds));
    const inCount = gated.filter((i) => !elsewhere.has(i.id));
    if (inCount.length !== res.lineCount) return requested;
    const notes = recountNotes(inCount.map((i) => ({ name: nameOf(i.id) })));
    if (notes === requested) return requested;
    const { data, error } = await this.ctx.supabase
      .from('cycle_counts')
      .update({ notes })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', res.cycleCountId!)
      .eq('status', 'in_progress')
      .select('id')
      .maybeSingle();
    if (error || !data) {
      void reportError(new Error('Recount notes could not be corrected'), {
        tag: 'exceptions.recount.notes_not_corrected',
        level: 'warning',
        organizationId: this.ctx.organizationId,
        extra: { cycleCountId: res.cycleCountId, detail: error ? rawErrorText(error) : 'no row' },
      });
      return requested;
    }
    return notes;
  }

  /**
   * Assign the count through CycleCountsService.assign (the 0282 RPC, whose
   * UPDATE of assigned_to fires the existing notification). A new count is
   * unassigned; a replayed one is assigned only while it is still open and
   * unassigned (a first attempt whose assign failed), never re-pointed.
   */
  private async assignNewCount(
    res: RpcResult,
    assignee: string | null,
  ): Promise<{ assignedTo: string | null; failed: boolean }> {
    const id = res.cycleCountId!;
    let current: string | null = null;
    if (res.replay) {
      const { data, error } = await this.ctx.supabase
        .from('cycle_counts')
        .select('status, assigned_to')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', id)
        .maybeSingle();
      if (error || !data) {
        reportDegradedRead('exceptions.recount.replay_header', error ?? new Error('no row'), {});
        return { assignedTo: null, failed: assignee !== null };
      }
      const header = data as { status: string; assigned_to: string | null };
      current = header.assigned_to;
      if (current !== null || header.status !== 'in_progress' || assignee === null) {
        return { assignedTo: current, failed: false };
      }
    }
    if (assignee === null) return { assignedTo: null, failed: false };
    try {
      const row = await new CycleCountsService(this.ctx).assign(id, assignee, null);
      return { assignedTo: row.assigned_to ?? assignee, failed: false };
    } catch (e) {
      // The count is KEPT (it is the snapshot the manager asked for); the
      // caller learns it is unassigned and can assign it from the count.
      void reportError(e, {
        tag: 'exceptions.recount.assign_failed',
        level: 'warning',
        organizationId: this.ctx.organizationId,
        extra: { cycleCountId: id },
      });
      return { assignedTo: null, failed: true };
    }
  }

  /** The assignees of the counts that already held items, as the reader sees
   *  them. Cosmetic: a failed read leaves the labels null. */
  private async withAssigneeLabels(list: RpcResult['linkedExisting']): Promise<RecountLinkedExisting[]> {
    const ids = [...new Set(list.map((e) => e.assignedTo).filter((v): v is string => v !== null))];
    const profiles = new Map<string, { full_name: string | null; email: string | null }>();
    let readable = true;
    if (ids.length > 0) {
      const ctx = this.ctx;
      try {
        const rows = await fetchAllRowsByIds<{ id: string; full_name: string | null; email: string | null }>(
          ids,
          (batch) => (from, to) =>
            ctx.supabase
              .from('user_profiles')
              .select('id, full_name, email')
              .in('id', batch)
              .order('id', { ascending: true })
              .range(from, to),
        );
        for (const r of rows) profiles.set(r.id, { full_name: r.full_name, email: r.email });
      } catch (err) {
        readable = false;
        reportDegradedRead('exceptions.recount.assignee_names', err, { count: ids.length });
      }
    }
    return list.map((e) => {
      let assignedTo: RecountPerson | null = null;
      if (e.assignedTo) {
        const p: OccurrencePerson = personFor(e.assignedTo, profiles.get(e.assignedTo) ?? null);
        assignedTo = { id: e.assignedTo, label: readable ? p.label : null };
      }
      return {
        cycleCountId: e.cycleCountId,
        countNumber: e.countNumber,
        reference: formatCycleCountNumber(e.countNumber),
        assignedTo,
        startedAt: e.startedAt,
        itemIds: e.itemIds,
        occurrenceIds: e.occurrenceIds,
      };
    });
  }
}

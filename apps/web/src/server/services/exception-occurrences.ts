import 'server-only';

import {
  can,
  EXCEPTION_RESOLVED_WINDOW_DAYS,
  EXCEPTION_RULE_IDS,
  formatCycleCountNumber,
  formatOccurrenceNumber,
  isExceptionRule,
  isManagerOrAbove,
  isRecountableRule,
  presentWhenTrackingBegan,
  recountOutcome,
  resolveOrgTimezone,
  varianceDestination,
  varianceReviewLine,
  type ExceptionCheckNotScheduledReason,
  type ExceptionRule,
  type OccurrenceEventKind,
  type OccurrenceRecountRef,
  type OccurrenceResolvedReason,
  type RecountOutcome,
  type RecountUnavailableReason,
  type VarianceDestination,
} from '@stockpilot/core';

import { assertWarehouseAccess, ForbiddenError, getWarehouseAccess } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { mapWithConcurrency } from '@/lib/supabase/in-filter';

import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { ExceptionsService } from './exceptions';
import { countStartBlock } from './lib/count-start-preflight';
import { fetchAllRowsByIds, rawErrorText, reportDegradedRead } from './lib/fetch-by-ids';
import { scheduleExceptionSync, type ExceptionSyncReason } from './lib/exception-sync-schedule';
import { fetchAllRows } from './lib/paginate';
import { postgrestErrorText } from './lib/postgrest-error';
import { buildSystemContext } from './lib/system-context';

/**
 * STORED EXCEPTION OCCURRENCES (F1-1, migration 0370).
 *
 * Conditions are derived by ExceptionsService.evaluateForSync; this service
 * owns what is STORED about them:
 *
 *   - list / get / listForCount: what a person reads, ALWAYS through their
 *     own client, so exception_occurrences RLS (_exc_occurrence_visible: item
 *     and holding visibility) decides what they see. No service-role read
 *     here. Each row carries its recount (F1-2) and what that count came to
 *     for its item (core recountOutcome), and whether Recount is offered.
 *   - act: acknowledge or add a note, through exception_occurrence_act (the
 *     RPC re-checks everything below). Nobody resolves a row.
 *   - syncOrg: the SYSTEM applying one org-wide evaluation through
 *     exceptions_sync. Service role, never on a person's request path: it runs
 *     from the cron, or after the response once a count is posted or
 *     cancelled, or after "Check now" returned.
 *
 * ═══ FRESHNESS WITHOUT SLOWING ANYTHING DOWN (owner decision, F1 Q9) ═══
 *
 * No read here syncs, and nothing waits for a sync. Pages and the phone render
 * the stored state with "Checked at <last_synced_at>"; before an org's first
 * sync they say the first check runs within 15 minutes, never an empty
 * "all clear".
 */

/** An unforced sync within this long of the last one does nothing. */
export const EXCEPTION_SYNC_THROTTLE_MS = 60_000;

/** "Check now" starts at most one check per org in this window, whoever asks
 *  and through whichever surface (the web action and the phone's route). */
export const EXCEPTION_CHECK_NOW_WINDOW_MS = 60_000;

/** Ceilings on the list reads, disclosed through `truncated`. Open rows are
 *  tens to hundreds in practice. */
const OPEN_LIST_CAP = 5_000;
const RESOLVED_LIST_CAP = 1_000;
/** The Resolved tab shows the last 30 days (core, so the copy agrees). */
const RESOLVED_WINDOW_DAYS = EXCEPTION_RESOLVED_WINDOW_DAYS;
/** Earlier occurrences of the same identity shown on the detail. */
const HISTORY_LIMIT = 50;
/** Timeline events read for one occurrence (a backstop far above real use). */
const TIMELINE_CAP = 2_000;
/** recount_linked events read for one count (a backstop far above real use:
 *  a recount holds at most 200 items). */
const COUNT_LINKS_CAP = 5_000;
/** Counts whose outcome one read works out at once. */
const OUTCOME_CONCURRENCY = 4;

// Every embed names its foreign key: exception_occurrence_events links
// exception_occurrences to user_profiles and cycle_counts as well, and
// PostgREST refuses an embed that more than one relationship could satisfy.
// Single string literals, so supabase-js can type the rows.
const OCCURRENCE_SELECT =
  'id, occurrence_number, rule, item_id, location_id, warehouse_id, facts, condition_since, first_seen_at, last_seen_at, acknowledged_at, acknowledged_by, recount_cycle_count_id, resolved_at, resolved_reason, previous_occurrence_id, recurrence_index, item:inventory_items!exception_occurrences_item_id_fkey(name, sku), location:locations!exception_occurrences_location_id_fkey(name, kind, deleted_at), recount:cycle_counts!exception_occurrences_recount_cycle_count_id_fkey(id, count_number, status, completed_at), acknowledger:user_profiles!exception_occurrences_acknowledged_by_fkey(full_name, email)';

const EVENT_SELECT =
  'id, kind, actor_user_id, cycle_count_id, evidence_id, maintenance_request_id, note, created_at, actor:user_profiles!exception_occurrence_events_actor_user_id_fkey(full_name, email), cycle_count:cycle_counts!exception_occurrence_events_cycle_count_id_fkey(count_number)';

const SYNC_STATE_SELECT =
  'tracking_started_at, last_evaluated_at, last_synced_at, complete_rules, failed_rules, truncated_rules';

// ── Public shapes (the API returns these as JSON) ──────────────────────────

/** A person as the reader can see them. `label` is their name, else email;
 *  "Former member" when the profile is no longer visible (they left, or the
 *  account was deleted). */
export interface OccurrencePerson {
  id: string | null;
  label: string;
}

export interface ExceptionOccurrence {
  id: string;
  /** occurrence_number; `reference` is its display form ("EX-000042"). */
  number: number;
  reference: string | null;
  rule: ExceptionRule;
  itemId: string;
  /** The item as it reads NOW (live, under the reader's RLS); null if unreadable. */
  item: { name: string; sku: string | null } | null;
  locationId: string | null;
  location: { name: string; kind: string | null; archived: boolean } | null;
  warehouseId: string | null;
  /** Rendered by core describeOccurrence(rule, facts, …). */
  facts: Record<string, unknown>;
  conditionSince: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** First seen by the org's very first sync: "Already present when tracking
   *  began". */
  presentWhenTrackingBegan: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: OccurrencePerson | null;
  /** The ACTIVE recount (F1-2); feeds core occurrenceState. `outcome` is
   *  core recountOutcome for this item in that count (in progress n of m, or
   *  what the posted count found); worded by recountOutcomeCopy. */
  recount: ExceptionOccurrenceRecount | null;
  resolvedAt: string | null;
  resolvedReason: OccurrenceResolvedReason | null;
  previousOccurrenceId: string | null;
  recurrenceIndex: number;
  /** Whether this reader may acknowledge / add a note, mirroring the RPC's
   *  gate (stock:adjust and write access to the warehouse, or a manager when
   *  it has none). A hint for the UI; the RPC decides. */
  canAct: boolean;
  /** Whether Recount is offered for this row (F1-2): open, a recountable
   *  rule (count_variance, over_reserved), and a reader who may start counts
   *  (the cycle_counts module, cycle_counts:assign, stock:adjust and the
   *  manager role; the same preflight the recount runs). A hint for the UI;
   *  the service and start_targeted_recount decide. */
  canRecount: boolean;
  /** Why Recount is withheld from this reader on this open, recountable row
   *  (the Cycle Counts module is off, or not a manager with both
   *  permissions); null when it is offered or the row is not one a recount
   *  could settle. Worded by core recountUnavailableCopy. */
  recountUnavailableReason: RecountUnavailableReason | null;
}

/** The recount an occurrence points at, with what came of it for its item. */
export type ExceptionOccurrenceRecount = OccurrenceRecountRef & { outcome: RecountOutcome };

/** exception_sync_state, or null before the org's first sync. */
export interface ExceptionSyncState {
  trackingStartedAt: string;
  lastEvaluatedAt: string;
  /** "Checked at". */
  lastSyncedAt: string;
  completeRules: ExceptionRule[];
  failedRules: ExceptionRule[];
  truncatedRules: ExceptionRule[];
  /** Failed or truncated rule names this build does not know (a newer
   *  build's rule). Unknown means not clean: no all-clear while above 0. */
  unrecognizedUncheckedRules: number;
}

export type OccurrenceListStatus = 'open' | 'resolved';

export interface OccurrenceListResult {
  status: OccurrenceListStatus;
  occurrences: ExceptionOccurrence[];
  /** True when the read stopped at its ceiling: the list is not complete. */
  truncated: boolean;
  syncState: ExceptionSyncState | null;
  /** Managers may ask for a check now. */
  canCheckNow: boolean;
  /** This reader may start recounts ("Recount selected", F1-2). Each row's
   *  own `canRecount` says whether that row can be picked. */
  canRecount: boolean;
  /** Why this reader may not (null when they may). */
  recountUnavailableReason: RecountUnavailableReason | null;
  /** Rows of a rule this build cannot word (a newer build's rule), left out
   *  of `occurrences`. They are open all the same: a surface never shows the
   *  all-clear state while this is above 0 (core exceptionUnrecognizedCopy). */
  unrecognized: number;
  /** The org's time zone, so every surface prints the same clock time. */
  timeZone: string;
}

/** The event kinds, from core (describeOccurrenceEvent words each one). */
export type { OccurrenceEventKind };

export interface OccurrenceEvent {
  id: string;
  kind: OccurrenceEventKind;
  at: string;
  /** null = the system (raised, recount_closed, resolved). */
  actor: OccurrencePerson | null;
  note: string | null;
  /** The count the event names. On a recount_closed event, `outcome` is what
   *  that count came to for this item (recountOutcome): "Matched the book",
   *  "Book corrected from 10 to 11 (+1)", "Cancelled before it was posted". */
  cycleCount: { id: string; countNumber: number | null; outcome?: RecountOutcome } | null;
  maintenanceRequestId: string | null;
  evidenceId: string | null;
}

export interface OccurrenceHistoryEntry {
  id: string;
  number: number;
  reference: string | null;
  firstSeenAt: string;
  resolvedAt: string | null;
  resolvedReason: OccurrenceResolvedReason | null;
  recurrenceIndex: number;
  isCurrent: boolean;
}

export interface OccurrenceDetail {
  occurrence: ExceptionOccurrence;
  /** Oldest first. */
  timeline: OccurrenceEvent[];
  /** Every occurrence of the same identity, newest first, this one included. */
  history: OccurrenceHistoryEntry[];
  historyTruncated: boolean;
  syncState: ExceptionSyncState | null;
  /** The org's time zone, so every surface prints the same clock time. */
  timeZone: string;
}

/** One exception linked to a count as its recount (F1-2), with the item's
 *  line in that count. */
export interface CountLinkedException {
  occurrence: ExceptionOccurrence;
  /** True while this count is the occurrence's active recount; false for a
   *  link that has since closed (the history still names the count). */
  active: boolean;
  /** The item's line in this count; null when it could not be found. */
  line: {
    id: string;
    countedQuantity: number | null;
    /** The book when the line was counted (its expected quantity). */
    expectedQuantity: number | null;
    /** cycle_count_lines.counted_location_id: lets the phone tell whether the
     *  destination below still describes the line it holds. */
    countedLocationId: string | null;
    /** The shelf location the count was attributed to (read for linked
     *  lines only), or null: not recorded. */
    countedLocation: { name: string; kind: string | null; archived: boolean } | null;
  } | null;
  /** What this count came to for the item (recountOutcome). */
  outcome: RecountOutcome;
  /** Where the line's difference lands when the count is posted (core
   *  varianceDestination, mirroring post_cycle_count); null when uncounted,
   *  when the count is closed, or when the line cannot re-check the item. */
  destination: VarianceDestination | null;
  /** "Counted 11, book 10 (+1): adds to Rack 12-A" (core varianceReviewLine),
   *  or that the line was counted before a later count of the item; null
   *  when uncounted or when the count is closed (read `outcome` then). */
  reviewLine: string | null;
}

export interface CountLinkedExceptions {
  cycleCountId: string;
  countNumber: number | null;
  reference: string | null;
  status: string;
  exceptions: CountLinkedException[];
  /** Linked rows of a rule this build cannot word, left out but counted. */
  unrecognized: number;
  syncState: ExceptionSyncState | null;
  timeZone: string;
}

export type OccurrenceAction = 'acknowledge' | 'note';

export interface OccurrenceActInput {
  action: OccurrenceAction;
  note?: string | null;
  /** Idempotency key from the client (the phone's retry): a replay adds
   *  nothing and returns the row. */
  clientEventId?: string | null;
}

export interface ExceptionCheckRequest {
  /** False when the last sync is under a minute old, or a check was already
   *  started for this org under a minute ago. */
  scheduled: boolean;
  /** Why not, when not scheduled (core exceptionCheckNowCopy words it). */
  reason: ExceptionCheckNotScheduledReason | null;
  lastSyncedAt: string | null;
  /** Seconds until a check can be scheduled again (0 when scheduled). */
  retryAfterSeconds: number;
}

export type ExceptionSyncOutcome =
  | {
      status: 'applied';
      raised: number;
      seen: number;
      resolved: number;
      recountsClosed: number;
      dropped: number;
      /** Rows applied with empty facts because theirs were too large. */
      factsOmitted: number;
    }
  /** A newer evaluation was already applied. */
  | { status: 'stale' }
  /** Unforced, and the last sync is under a minute old. */
  | { status: 'throttled'; lastSyncedAt: string }
  /** The org has no accepted owner/admin to act as the system for. */
  | { status: 'no_system_actor' }
  /** Another sync held the org's lock past lock_timeout (5 s); the next run
   *  applies. */
  | { status: 'busy' }
  /** Reported as exceptions.sync_failed. */
  | { status: 'failed' };

// ── Row mapping ────────────────────────────────────────────────────────────

type ProfileEmbed = { full_name: string | null; email: string | null } | null;

type OccurrenceRow = {
  id: string;
  occurrence_number: number | string;
  rule: string;
  item_id: string;
  location_id: string | null;
  warehouse_id: string | null;
  facts: unknown;
  condition_since: string | null;
  first_seen_at: string;
  last_seen_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  recount_cycle_count_id: string | null;
  resolved_at: string | null;
  resolved_reason: OccurrenceResolvedReason | null;
  previous_occurrence_id: string | null;
  recurrence_index: number;
  item?: { name: string; sku: string | null } | null;
  location?: { name: string; kind: string | null; deleted_at: string | null } | null;
  recount?: {
    id: string;
    count_number: number | string | null;
    status: string;
    completed_at: string | null;
  } | null;
  acknowledger?: ProfileEmbed;
};

type EventRow = {
  id: string;
  kind: OccurrenceEventKind;
  actor_user_id: string | null;
  cycle_count_id: string | null;
  evidence_id: string | null;
  maintenance_request_id: string | null;
  note: string | null;
  created_at: string;
  actor?: ProfileEmbed;
  cycle_count?: { count_number: number | string | null } | null;
};

type SyncStateRow = {
  tracking_started_at: string;
  last_evaluated_at: string;
  last_synced_at: string;
  complete_rules: string[] | null;
  failed_rules: string[] | null;
  truncated_rules: string[] | null;
};

/** The profile as the reader sees it. user_profiles_select_orgmates shows a
 *  profile only while its owner still belongs to one of the reader's orgs, so
 *  an invisible profile (or a deleted account, which nulls the id) is a
 *  former member. Same wording as the PO-imports uploader label. */
export function personFor(id: string | null, profile: ProfileEmbed | undefined): OccurrencePerson {
  if (!profile) return { id, label: 'Former member' };
  return { id, label: profile.full_name?.trim() || profile.email?.trim() || 'Unknown' };
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function rulesOf(values: string[] | null): ExceptionRule[] {
  const set = new Set(values ?? []);
  return EXCEPTION_RULE_IDS.filter((r) => set.has(r));
}

/** Distinct failed or truncated rule names this build does not know. */
function unrecognizedRuleCount(...lists: Array<string[] | null>): number {
  const names = new Set<string>();
  for (const list of lists) for (const r of list ?? []) if (!isExceptionRule(r)) names.add(r);
  return names.size;
}

function mapSyncState(row: SyncStateRow | null): ExceptionSyncState | null {
  if (!row) return null;
  return {
    trackingStartedAt: row.tracking_started_at,
    lastEvaluatedAt: row.last_evaluated_at,
    lastSyncedAt: row.last_synced_at,
    completeRules: rulesOf(row.complete_rules),
    failedRules: rulesOf(row.failed_rules),
    truncatedRules: rulesOf(row.truncated_rules),
    unrecognizedUncheckedRules: unrecognizedRuleCount(row.failed_rules, row.truncated_rules),
  };
}

type ActGate = (row: OccurrenceRow) => boolean;

/** The outcome a recount's status alone implies, before its line is read:
 *  in progress (progress unknown), cancelled, or unavailable until enriched. */
function outcomeFromStatus(status: string): RecountOutcome {
  return recountOutcome({ status }, null);
}

function mapOccurrence(
  row: OccurrenceRow,
  syncState: ExceptionSyncState | null,
  canActOn: ActGate,
  recountBlock: RecountUnavailableReason | null,
): ExceptionOccurrence | null {
  // A rule a newer build stored is not one this build can describe; the
  // caller reports it instead of rendering a broken row.
  if (!isExceptionRule(row.rule)) return null;
  const number = toNumber(row.occurrence_number) ?? 0;
  const rc = row.recount ?? null;
  return {
    id: row.id,
    number,
    reference: formatOccurrenceNumber(number),
    rule: row.rule,
    itemId: row.item_id,
    item: row.item ? { name: row.item.name, sku: row.item.sku ?? null } : null,
    locationId: row.location_id,
    location: row.location
      ? { name: row.location.name, kind: row.location.kind ?? null, archived: row.location.deleted_at !== null }
      : null,
    warehouseId: row.warehouse_id,
    facts:
      row.facts !== null && typeof row.facts === 'object' && !Array.isArray(row.facts)
        ? (row.facts as Record<string, unknown>)
        : {},
    conditionSince: row.condition_since,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    presentWhenTrackingBegan: presentWhenTrackingBegan(
      row.first_seen_at,
      syncState?.trackingStartedAt ?? null,
    ),
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy:
      row.acknowledged_at === null ? null : personFor(row.acknowledged_by, row.acknowledger),
    recount:
      row.recount_cycle_count_id && rc
        ? {
            cycleCountId: rc.id,
            countNumber: toNumber(rc.count_number),
            status: rc.status,
            completedAt: rc.completed_at,
            outcome: outcomeFromStatus(rc.status),
          }
        : null,
    resolvedAt: row.resolved_at,
    resolvedReason: row.resolved_reason,
    previousOccurrenceId: row.previous_occurrence_id,
    recurrenceIndex: row.recurrence_index ?? 0,
    canAct: row.resolved_at === null && canActOn(row),
    canRecount: recountBlock === null && row.resolved_at === null && isRecountableRule(row.rule),
    recountUnavailableReason:
      recountBlock !== null && row.resolved_at === null && isRecountableRule(row.rule) ? recountBlock : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The key recountOutcomes answers under. */
function pairKey(cycleCountId: string, itemId: string): string {
  return `${cycleCountId}:${itemId}`;
}

/** A numeric(14,4) quantity from PostgREST (a number, or a string for very
 *  large values), or null. */
function toQuantity(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ── Service ────────────────────────────────────────────────────────────────

export class ExceptionOccurrencesService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser(): Promise<ExceptionOccurrencesService> {
    return new ExceptionOccurrencesService(await withContext());
  }

  /**
   * The Open list (every open occurrence) or the Resolved list (the last 30
   * days), with the org's sync state. Never syncs. A failed read THROWS: the
   * caller renders "unavailable", never an empty list (pattern #1: an empty
   * list here would read as "nothing wrong").
   */
  async list(
    opts: {
      status?: OccurrenceListStatus;
      /** Only this item's occurrences (the item page's open issues, and the
       *  exceptions "Count this item" links to its recount). */
      itemId?: string | null;
    } = {},
  ): Promise<OccurrenceListResult> {
    assertPermission(this.ctx, 'items:read');
    const status: OccurrenceListStatus = opts.status === 'resolved' ? 'resolved' : 'open';
    const orgId = this.ctx.organizationId;
    const itemId = opts.itemId ?? null;
    if (itemId !== null && !UUID.test(itemId)) {
      throw new ServiceError('validation_error', 'That item id is not valid.', { reason: 'invalid_item_id' });
    }
    const cap = status === 'open' ? OPEN_LIST_CAP : RESOLVED_LIST_CAP;
    const since = new Date(Date.now() - RESOLVED_WINDOW_DAYS * 86_400_000).toISOString();

    const [rows, syncState, gate, timeZone] = await Promise.all([
      fetchAllRows<Record<string, unknown>>(
        (from, to) => {
          const base = this.ctx.supabase
            .from('exception_occurrences')
            .select(OCCURRENCE_SELECT)
            .eq('organization_id', orgId);
          const q = itemId === null ? base : base.eq('item_id', itemId);
          return status === 'open'
            ? q.is('resolved_at', null).order('occurrence_number', { ascending: true }).range(from, to)
            : q
                .gte('resolved_at', since)
                .order('resolved_at', { ascending: false })
                .order('occurrence_number', { ascending: false })
                .range(from, to);
        },
        { cap },
      ) as Promise<unknown> as Promise<OccurrenceRow[]>,
      this.readSyncState(),
      this.actGate(),
      this.readOrgTimeZone(),
    ]);

    const recountBlock = countStartBlock(this.ctx);
    const occurrences: ExceptionOccurrence[] = [];
    let unknown = 0;
    for (const row of rows) {
      const mapped = mapOccurrence(row, syncState, gate, recountBlock);
      if (mapped) occurrences.push(mapped);
      else unknown += 1;
    }
    if (unknown > 0) this.reportUnknownRules(unknown);
    await this.withRecountOutcomes(occurrences);

    return {
      status,
      occurrences,
      truncated: rows.length >= cap,
      syncState,
      canCheckNow: isManagerOrAbove(this.ctx.role),
      canRecount: recountBlock === null,
      recountUnavailableReason: recountBlock,
      unrecognized: unknown,
      timeZone,
    };
  }

  /**
   * One occurrence with its timeline and every occurrence of the same
   * identity (the recurrence chain). Not visible, or not found: not_found,
   * the same answer either way, so existence is not leaked.
   */
  async get(id: string): Promise<OccurrenceDetail> {
    assertPermission(this.ctx, 'items:read');
    if (!UUID.test(id)) throw new ServiceError('not_found', 'Exception not found.');
    const orgId = this.ctx.organizationId;

    const [row, events, syncState, gate, timeZone] = await Promise.all([
      this.readOccurrenceRow(id),
      fetchAllRows<Record<string, unknown>>(
        (from, to) =>
          this.ctx.supabase
            .from('exception_occurrence_events')
            .select(EVENT_SELECT)
            .eq('organization_id', orgId)
            .eq('occurrence_id', id)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
        { cap: TIMELINE_CAP },
      ) as Promise<unknown> as Promise<EventRow[]>,
      this.readSyncState(),
      this.actGate(),
      this.readOrgTimeZone(),
    ]);
    if (!row) throw new ServiceError('not_found', 'Exception not found.');
    const occurrence = mapOccurrence(row, syncState, gate, countStartBlock(this.ctx));
    if (!occurrence) {
      this.reportUnknownRules(1);
      throw new ServiceError('not_found', 'Exception not found.');
    }
    // What each recount came to for this item: the active one, and every
    // closed one the timeline names ("Recount CC-000031 closed: Matched the
    // book"). One set of reads for both.
    const closedCounts = events
      .filter((e) => e.kind === 'recount_closed' && e.cycle_count_id !== null)
      .map((e) => e.cycle_count_id as string);
    const outcomes = await this.recountOutcomes(
      [
        ...(occurrence.recount ? [occurrence.recount.cycleCountId] : []),
        ...closedCounts,
      ].map((cycleCountId) => ({ cycleCountId, itemId: occurrence.itemId })),
    );
    if (occurrence.recount) {
      occurrence.recount.outcome =
        outcomes.get(pairKey(occurrence.recount.cycleCountId, occurrence.itemId)) ?? occurrence.recount.outcome;
    }

    // The chain is every occurrence of the same identity: at most one is
    // open, and each later one links to the latest earlier one, so reading by
    // identity returns the whole chain in one query.
    let hq = this.ctx.supabase
      .from('exception_occurrences')
      .select('id, occurrence_number, first_seen_at, resolved_at, resolved_reason, recurrence_index')
      .eq('organization_id', orgId)
      .eq('rule', row.rule)
      .eq('item_id', row.item_id);
    hq = row.location_id === null ? hq.is('location_id', null) : hq.eq('location_id', row.location_id);
    const { data: historyRows, error: historyError } = await hq
      .order('occurrence_number', { ascending: false })
      .limit(HISTORY_LIMIT + 1);
    if (historyError) {
      throw new ServiceError('internal_error', postgrestErrorText(historyError));
    }
    const chain = (historyRows ?? []) as Array<{
      id: string;
      occurrence_number: number | string;
      first_seen_at: string;
      resolved_at: string | null;
      resolved_reason: OccurrenceResolvedReason | null;
      recurrence_index: number;
    }>;

    return {
      occurrence,
      timeline: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        at: e.created_at,
        actor: e.actor_user_id === null ? systemOrFormer(e) : personFor(e.actor_user_id, e.actor),
        note: e.note,
        cycleCount: e.cycle_count_id
          ? {
              id: e.cycle_count_id,
              countNumber: toNumber(e.cycle_count?.count_number),
              ...(e.kind === 'recount_closed'
                ? {
                    outcome: outcomes.get(pairKey(e.cycle_count_id, occurrence.itemId)) ?? {
                      kind: 'unavailable' as const,
                    },
                  }
                : {}),
            }
          : null,
        maintenanceRequestId: e.maintenance_request_id,
        evidenceId: e.evidence_id,
      })),
      history: chain.slice(0, HISTORY_LIMIT).map((h) => {
        const number = toNumber(h.occurrence_number) ?? 0;
        return {
          id: h.id,
          number,
          reference: formatOccurrenceNumber(number),
          firstSeenAt: h.first_seen_at,
          resolvedAt: h.resolved_at,
          resolvedReason: h.resolved_reason,
          recurrenceIndex: h.recurrence_index ?? 0,
          isCurrent: h.id === id,
        };
      }),
      historyTruncated: chain.length > HISTORY_LIMIT,
      syncState,
      timeZone,
    };
  }

  /**
   * Acknowledge an occurrence or add a note. The app gate mirrors the RPC's
   * (pattern #4): stock:adjust, and write access to the occurrence's
   * warehouse, or the manager role when it has none. The RPC re-checks all of
   * it (and the item's charter), refuses a resolved row, and never resolves.
   */
  async act(id: string, input: OccurrenceActInput): Promise<ExceptionOccurrence> {
    assertPermission(this.ctx, 'items:read');
    assertPermission(this.ctx, 'stock:adjust');
    if (!UUID.test(id)) throw new ServiceError('not_found', 'Exception not found.');
    if (input.action !== 'acknowledge' && input.action !== 'note') {
      throw new ServiceError('validation_error', 'Choose acknowledge or note.', { reason: 'invalid_action' });
    }
    const note = (input.note ?? '').trim() || null;
    if (input.action === 'note' && note === null) {
      throw new ServiceError('validation_error', 'Add a note.', { reason: 'note_required' });
    }
    if (note !== null && Array.from(note).length > 1000) {
      throw new ServiceError('validation_error', 'Notes can be at most 1,000 characters.', {
        reason: 'note_too_long',
      });
    }
    const clientEventId = (input.clientEventId ?? '').trim() || null;
    if (clientEventId !== null && Array.from(clientEventId).length > 200) {
      throw new ServiceError('validation_error', 'The request id is too long.', {
        reason: 'client_event_id_too_long',
      });
    }

    const row = await this.readOccurrenceRow(id);
    if (!row) throw new ServiceError('not_found', 'Exception not found.');
    await this.assertCanAct(row);

    const { error } = await this.ctx.supabase.rpc('exception_occurrence_act', {
      p_id: id,
      p_action: input.action,
      p_note: note,
      p_client_event_id: clientEventId,
    });
    if (error) throw mapActError(error);

    // Re-read with the embeds so the caller gets the same shape the list and
    // detail return (the RPC returns the bare row).
    const [fresh, syncState, gate] = await Promise.all([
      this.readOccurrenceRow(id),
      this.readSyncState(),
      this.actGate(),
    ]);
    const mapped = fresh ? mapOccurrence(fresh, syncState, gate, countStartBlock(this.ctx)) : null;
    if (!mapped) throw new ServiceError('not_found', 'Exception not found.');
    await this.withRecountOutcomes([mapped]);
    return mapped;
  }

  /**
   * The exceptions linked to one count as its recount (F1-2), for the count's
   * detail on the web and the phone: every occurrence a recount_linked event
   * names for this count (the pointer is cleared once the count closes, the
   * events stay), each with its item's line in the count, what the count came
   * to for it, and where the line's difference lands when posted.
   *
   * Everything is read through the caller's own client, so occurrence RLS
   * decides which links they see. The counted location is read for these
   * lines only (the count's line page is unchanged). A failed read THROWS:
   * the caller shows "unavailable", never "no linked exceptions".
   */
  async listForCount(cycleCountId: string): Promise<CountLinkedExceptions> {
    assertPermission(this.ctx, 'items:read');
    if (!UUID.test(cycleCountId)) throw new ServiceError('not_found', 'Cycle count not found.');
    const orgId = this.ctx.organizationId;

    const [header, links, syncState, gate, timeZone] = await Promise.all([
      this.ctx.supabase
        .from('cycle_counts')
        .select('id, count_number, status')
        .eq('organization_id', orgId)
        .eq('id', cycleCountId)
        .maybeSingle(),
      fetchAllRows<{ occurrence_id: string }>(
        (from, to) =>
          this.ctx.supabase
            .from('exception_occurrence_events')
            .select('id, occurrence_id')
            .eq('organization_id', orgId)
            .eq('cycle_count_id', cycleCountId)
            .eq('kind', 'recount_linked')
            .order('id', { ascending: true })
            .range(from, to),
        { cap: COUNT_LINKS_CAP },
      ),
      this.readSyncState(),
      this.actGate(),
      this.readOrgTimeZone(),
    ]);
    if (header.error) throw new ServiceError('internal_error', postgrestErrorText(header.error));
    const count = header.data as { id: string; count_number: number | string | null; status: string } | null;
    if (!count) throw new ServiceError('not_found', 'Cycle count not found.');

    const occurrenceIds = [...new Set(links.map((l) => l.occurrence_id))];
    const ctx = this.ctx;
    const rows = (await fetchAllRowsByIds<Record<string, unknown>>(
      occurrenceIds,
      (batch) => (from, to) =>
        ctx.supabase
          .from('exception_occurrences')
          .select(OCCURRENCE_SELECT)
          .eq('organization_id', orgId)
          .in('id', batch)
          .order('id', { ascending: true })
          .range(from, to),
    )) as unknown as OccurrenceRow[];

    const recountBlock = countStartBlock(this.ctx);
    const occurrences: ExceptionOccurrence[] = [];
    let unknown = 0;
    for (const row of rows) {
      const mapped = mapOccurrence(row, syncState, gate, recountBlock);
      if (mapped) occurrences.push(mapped);
      else unknown += 1;
    }
    if (unknown > 0) this.reportUnknownRules(unknown);
    occurrences.sort((a, b) => a.number - b.number);

    type LineRow = {
      id: string;
      item_id: string;
      counted_quantity: number | string | null;
      expected_quantity: number | string | null;
      counted_location_id: string | null;
      counted_location: { name: string; kind: string | null; deleted_at: string | null } | null;
      /** cycle_count_line_rechecks (0372), a computed field: false when the
       *  line was counted before a later count of the item was posted. */
      rechecks: boolean | null;
    };
    const itemIds = [...new Set(occurrences.map((o) => o.itemId))];
    const [lineRows, progress] = await Promise.all([
      fetchAllRowsByIds<Record<string, unknown>>(
        itemIds,
        (batch) => (from, to) =>
          ctx.supabase
            .from('cycle_count_lines')
            .select(
              'id, item_id, counted_quantity, expected_quantity, counted_location_id, counted_location:locations!cycle_count_lines_counted_location_id_fkey(name, kind, deleted_at), rechecks:cycle_count_line_rechecks',
            )
            .eq('cycle_count_id', cycleCountId)
            .in('item_id', batch)
            .order('id', { ascending: true })
            .range(from, to),
      ) as unknown as Promise<LineRow[]>,
      count.status === 'in_progress' ? this.readProgressSoft(cycleCountId) : Promise.resolve(null),
    ]);
    const lineByItem = new Map(lineRows.map((l) => [l.item_id, l]));
    // The other occurrences' active recounts (a link that has since moved on
    // to another count), worked out like the list does.
    await this.withRecountOutcomes(occurrences.filter((o) => o.recount?.cycleCountId !== cycleCountId));

    const exceptions: CountLinkedException[] = occurrences.map((o) => {
      const l = lineByItem.get(o.itemId) ?? null;
      const countedLocation = l?.counted_location
        ? {
            name: l.counted_location.name,
            kind: l.counted_location.kind ?? null,
            archived: l.counted_location.deleted_at !== null,
          }
        : null;
      const line = l
        ? {
            id: l.id,
            countedQuantity: toQuantity(l.counted_quantity),
            expectedQuantity: toQuantity(l.expected_quantity),
            countedLocationId: l.counted_location_id ?? null,
            countedLocation,
          }
        : null;
      const rechecks = typeof l?.rechecks === 'boolean' ? l.rechecks : null;
      const outcome = recountOutcome(
        { status: count.status, countedLines: progress?.counted ?? null, totalLines: progress?.total ?? null },
        line ? { countedQuantity: line.countedQuantity, expectedQuantity: line.expectedQuantity, rechecks } : null,
      );
      const active = o.recount?.cycleCountId === cycleCountId;
      if (active && o.recount) o.recount.outcome = outcome;
      // Where the difference lands is a statement about posting, so it is made
      // only while the count is open (a closed count reads its outcome). A
      // line that cannot re-check the item has no destination: posting it
      // applies nothing for the exception (or is refused as superseded).
      const destInput =
        line && count.status === 'in_progress'
          ? { countedQuantity: line.countedQuantity, expectedQuantity: line.expectedQuantity, countedLocation, rechecks }
          : null;
      return {
        occurrence: o,
        active,
        line,
        outcome,
        destination: destInput && rechecks !== false ? varianceDestination(destInput) : null,
        reviewLine: destInput ? varianceReviewLine(destInput) : null,
      };
    });

    const countNumber = toNumber(count.count_number);
    return {
      cycleCountId,
      countNumber,
      reference: formatCycleCountNumber(countNumber),
      status: count.status,
      exceptions,
      unrecognized: unknown,
      syncState,
      timeZone,
    };
  }

  /**
   * "Check now" (managers): schedule a sync to run AFTER the response and
   * return at once. At most one per org per minute, by two checks:
   *
   *   1. the stored "Checked at" (read through the caller's own client;
   *      members can read their org's sync state): under a minute old, no;
   *   2. a per-org CLAIM, taken before scheduling. "Checked at" moves only
   *      when a sync COMMITS, so on its own it let every click made while the
   *      first check was still running schedule another full org-wide
   *      evaluation (a double-click, a second manager, or the action called
   *      in a loop). The claim is shared by the web action and the phone's
   *      route, because both come through here. It fails CLOSED: if the
   *      limiter cannot answer, no check is started (the cron still runs).
   *
   * The scheduled sync runs UNFORCED, so if another sync landed in between
   * (the cron, a posted count), it does nothing.
   */
  async requestCheck(): Promise<ExceptionCheckRequest> {
    assertPermission(this.ctx, 'items:read');
    if (!isManagerOrAbove(this.ctx.role)) {
      throw new ServiceError('forbidden', 'Only a manager can run a check now.');
    }
    const state = await this.readSyncState();
    const last = state?.lastSyncedAt ?? null;
    const elapsed = last ? Date.now() - Date.parse(last) : Number.POSITIVE_INFINITY;
    if (elapsed < EXCEPTION_SYNC_THROTTLE_MS) {
      return {
        scheduled: false,
        reason: 'recently_checked',
        lastSyncedAt: last,
        retryAfterSeconds: Math.max(1, Math.ceil((EXCEPTION_SYNC_THROTTLE_MS - elapsed) / 1000)),
      };
    }
    const claim = await checkRateLimit(
      `exceptions-check-now:org:${this.ctx.organizationId}`,
      1,
      EXCEPTION_CHECK_NOW_WINDOW_MS,
      'closed',
    );
    if (!claim.allowed) {
      return {
        scheduled: false,
        reason: 'already_requested',
        lastSyncedAt: last,
        retryAfterSeconds: Math.max(1, Math.ceil((claim.resetAt - Date.now()) / 1000)),
      };
    }
    scheduleExceptionSync(this.ctx.organizationId, 'check_now', { force: false });
    return { scheduled: true, reason: null, lastSyncedAt: last, retryAfterSeconds: 0 };
  }

  /**
   * Apply one org-wide evaluation, as the system. NEVER THROWS: every failure
   * is reported as `exceptions.sync_failed` and returned as `failed`, because
   * every caller is a cron loop or after-response tail work that must not be
   * broken by it.
   *
   * Unforced, it does nothing when the org synced under a minute ago.
   */
  static async syncOrg(
    orgId: string,
    opts: { force?: boolean; reason: ExceptionSyncReason },
  ): Promise<ExceptionSyncOutcome> {
    try {
      const admin = createAdminClient();
      if (!opts.force) {
        const { data, error } = await admin
          .from('exception_sync_state')
          .select('last_synced_at')
          .eq('organization_id', orgId)
          .maybeSingle();
        if (error) throw new ServiceError('internal_error', postgrestErrorText(error));
        const last = (data as { last_synced_at: string } | null)?.last_synced_at ?? null;
        if (last && Date.now() - Date.parse(last) < EXCEPTION_SYNC_THROTTLE_MS) {
          return { status: 'throttled', lastSyncedAt: last };
        }
      }

      const sysCtx = await buildSystemContext(admin, orgId);
      if (!sysCtx) return await ExceptionOccurrencesService.noSystemActor(admin, orgId, opts);

      const ev = await ExceptionsService.evaluateForSync(sysCtx);
      const { data, error } = await admin.rpc('exceptions_sync', {
        p_org: orgId,
        p_evaluated_at: ev.evaluatedAt,
        p_complete_rules: ev.completeRules,
        p_failed_rules: ev.failedRules,
        p_truncated_rules: ev.truncatedRules,
        p_present: ev.present,
        p_hold: ev.hold,
      });
      if (error) {
        // lock_timeout: another sync of this org held the lock past 5 s. It
        // is applying an evaluation of its own; the next run catches up. (The
        // 5 s is below the API statement timeout of 8 s on purpose, so this
        // answer arrives before a 57014, which stays a reported failure.)
        if (error.code === '55P03') return { status: 'busy' };
        throw new ServiceError('internal_error', postgrestErrorText(error), {
          code: error.code ?? null,
          hint: error.hint ?? null,
        });
      }
      const res = (data ?? {}) as {
        skipped?: boolean;
        raised?: number;
        seen?: number;
        resolved?: number;
        recountsClosed?: number;
        dropped?: number;
        factsOmitted?: number;
      };
      if (res.skipped) return { status: 'stale' };
      const factsOmitted = res.factsOmitted ?? 0;
      if (factsOmitted > 0) {
        // The rows applied; only their stored words were dropped. The
        // evaluator clips every name, so this means a facts shape grew.
        void reportError(new Error('Exception facts too large to store'), {
          tag: 'exceptions.facts_omitted',
          level: 'warning',
          organizationId: orgId,
          extra: { count: factsOmitted, reason: opts.reason },
        });
      }
      return {
        status: 'applied',
        raised: res.raised ?? 0,
        seen: res.seen ?? 0,
        resolved: res.resolved ?? 0,
        recountsClosed: res.recountsClosed ?? 0,
        dropped: res.dropped ?? 0,
        factsOmitted,
      };
    } catch (err) {
      void reportError(err, {
        tag: 'exceptions.sync_failed',
        organizationId: orgId,
        extra: { reason: opts.reason, force: opts.force === true, detail: rawErrorText(err) },
      });
      return { status: 'failed' };
    }
  }

  /**
   * buildSystemContext came back empty. The shared helper ignores its read
   * errors (its body is pinned identical to the route copies by the
   * daily-briefing guard, so it is not changed here), which made a FAILED
   * members read look exactly like an org with no owner or admin: the sync
   * was dropped with no report, and a posted count's re-check silently waited
   * for the cron. So the members read is repeated with its error bound:
   *   - it fails: thrown, and reported by syncOrg as exceptions.sync_failed;
   *   - it finds an actor after all (the first read failed transiently):
   *     thrown the same way;
   *   - there really is none: reported as a warning
   *     (exceptions.sync_no_actor) and returned as no_system_actor.
   */
  private static async noSystemActor(
    admin: ReturnType<typeof createAdminClient>,
    orgId: string,
    opts: { force?: boolean; reason: ExceptionSyncReason },
  ): Promise<ExceptionSyncOutcome> {
    const { data, error } = await admin
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', orgId)
      .in('role', ['owner', 'admin'])
      .not('accepted_at', 'is', null)
      .is('impersonation_expires_at', null)
      .limit(1);
    if (error) {
      throw new ServiceError('internal_error', postgrestErrorText(error), { step: 'system_actor' });
    }
    if ((data ?? []).length > 0) {
      throw new ServiceError('internal_error', 'The system context could not be built.', {
        step: 'system_context',
      });
    }
    void reportError(new Error('Exception sync skipped: the org has no accepted owner or admin'), {
      tag: 'exceptions.sync_no_actor',
      level: 'warning',
      organizationId: orgId,
      extra: { reason: opts.reason },
    });
    return { status: 'no_system_actor' };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * The org's time zone, read through the caller's own client (members read
   * their org's row). Formatting only, so a failed read falls back to the
   * shared default (core resolveOrgTimezone, the same fallback the web page
   * uses) instead of failing the list.
   */
  private async readOrgTimeZone(): Promise<string> {
    try {
      const { data, error } = await this.ctx.supabase
        .from('organizations')
        .select('timezone')
        .eq('id', this.ctx.organizationId)
        .maybeSingle();
      if (error) return resolveOrgTimezone(null);
      return resolveOrgTimezone((data as { timezone?: string | null } | null)?.timezone ?? null);
    } catch {
      return resolveOrgTimezone(null);
    }
  }

  private async readOccurrenceRow(id: string): Promise<OccurrenceRow | null> {
    const { data, error } = await this.ctx.supabase
      .from('exception_occurrences')
      .select(OCCURRENCE_SELECT)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', postgrestErrorText(error));
    return (data as OccurrenceRow | null) ?? null;
  }

  private async readSyncState(): Promise<ExceptionSyncState | null> {
    const { data, error } = await this.ctx.supabase
      .from('exception_sync_state')
      .select(SYNC_STATE_SELECT)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', postgrestErrorText(error));
    return mapSyncState((data as SyncStateRow | null) ?? null);
  }

  /**
   * The per-row "can act" hint, mirroring exception_occurrence_act. Reads the
   * caller's warehouse access once. A failed access read answers "no" for
   * every row (fail closed) rather than failing the page: the RPC is the
   * authority either way.
   */
  private async actGate(): Promise<ActGate> {
    if (!can(this.ctx, 'stock:adjust')) return () => false;
    const manager = isManagerOrAbove(this.ctx.role);
    let access: { hasAllAccess: boolean; writableIds: string[] } | null = null;
    try {
      access = await getWarehouseAccess(this.ctx);
    } catch (err) {
      void reportError(err, {
        tag: 'exceptions.act_gate_unavailable',
        level: 'warning',
        organizationId: this.ctx.organizationId,
      });
      return () => false;
    }
    const viewer = this.ctx.role === 'viewer';
    return (row) => {
      if (row.warehouse_id === null) return manager;
      if (viewer) return false;
      return access!.hasAllAccess || access!.writableIds.includes(row.warehouse_id);
    };
  }

  private async assertCanAct(row: OccurrenceRow): Promise<void> {
    if (row.warehouse_id === null) {
      if (!isManagerOrAbove(this.ctx.role)) {
        throw new ServiceError('forbidden', 'Only a manager can act on an exception with no warehouse.');
      }
      return;
    }
    try {
      await assertWarehouseAccess(row.warehouse_id, 'write', this.ctx);
    } catch (e) {
      if (e instanceof ForbiddenError) {
        throw new ServiceError('forbidden', 'You do not have write access to this warehouse.');
      }
      throw e;
    }
  }

  /**
   * Replace each occurrence's recount outcome (from its status alone) with
   * what the count came to for its item. Cosmetic: see recountOutcomes.
   */
  private async withRecountOutcomes(occurrences: ExceptionOccurrence[]): Promise<void> {
    const withRecount = occurrences.filter((o) => o.recount !== null);
    if (withRecount.length === 0) return;
    const outcomes = await this.recountOutcomes(
      withRecount.map((o) => ({ cycleCountId: o.recount!.cycleCountId, itemId: o.itemId })),
    );
    for (const o of withRecount) {
      const found = outcomes.get(pairKey(o.recount!.cycleCountId, o.itemId));
      if (found) o.recount!.outcome = found;
    }
  }

  /**
   * What each (count, item) pair came to (core recountOutcome): the count's
   * status, its progress while in progress (lines counted of lines), and the
   * item's line (with whether it re-checks the item, 0372) while in progress
   * and once posted. All read through the caller's client (count headers and
   * lines are readable by every member).
   *
   * COSMETIC, and never a wrong answer: a failed read is reported and every
   * pair reads "Result not available" (unavailable), never "matched" and
   * never a failed list. Bounded: one header read, then per count at most
   * OUTCOME_CONCURRENCY at once, each batched by item.
   */
  private async recountOutcomes(
    pairs: ReadonlyArray<{ cycleCountId: string; itemId: string }>,
  ): Promise<Map<string, RecountOutcome>> {
    const out = new Map<string, RecountOutcome>();
    const byCount = new Map<string, Set<string>>();
    for (const p of pairs) {
      const items = byCount.get(p.cycleCountId) ?? new Set<string>();
      items.add(p.itemId);
      byCount.set(p.cycleCountId, items);
    }
    if (byCount.size === 0) return out;
    const ctx = this.ctx;
    try {
      const counts = await fetchAllRowsByIds<{ id: string; status: string }>(
        [...byCount.keys()],
        (batch) => (from, to) =>
          ctx.supabase
            .from('cycle_counts')
            .select('id, status')
            .eq('organization_id', ctx.organizationId)
            .in('id', batch)
            .order('id', { ascending: true })
            .range(from, to),
      );
      const statusOf = new Map(counts.map((c) => [c.id, c.status]));
      type OutcomeLine = {
        item_id: string;
        counted_quantity: number | string | null;
        expected_quantity: number | string | null;
        rechecks: boolean | null;
      };
      // The item's line, with whether it re-checks the item (0372's computed
      // field): a line counted before a later count of the item was posted
      // is "counted before a later count", never "matched the book".
      const readLines = (ccId: string, items: ReadonlySet<string>) =>
        fetchAllRowsByIds<OutcomeLine>(
          [...items],
          (batch) => (from, to) =>
            ctx.supabase
              .from('cycle_count_lines')
              .select('item_id, counted_quantity, expected_quantity, rechecks:cycle_count_line_rechecks')
              .eq('cycle_count_id', ccId)
              .in('item_id', batch)
              .order('id', { ascending: true })
              .range(from, to),
        );
      const lineInput = (l: OutcomeLine | undefined) =>
        l
          ? {
              countedQuantity: l.counted_quantity,
              expectedQuantity: l.expected_quantity,
              rechecks: typeof l.rechecks === 'boolean' ? l.rechecks : null,
            }
          : null;
      await mapWithConcurrency([...byCount.entries()], OUTCOME_CONCURRENCY, async ([ccId, items]) => {
        const status = statusOf.get(ccId);
        if (status === 'completed' || status === 'in_progress') {
          const [lines, progress] = await Promise.all([
            readLines(ccId, items),
            status === 'in_progress' ? this.readProgress(ccId) : Promise.resolve(null),
          ]);
          const byItem = new Map(lines.map((l) => [l.item_id, l]));
          for (const itemId of items) {
            out.set(
              pairKey(ccId, itemId),
              recountOutcome(
                { status, countedLines: progress?.counted ?? null, totalLines: progress?.total ?? null },
                lineInput(byItem.get(itemId)),
              ),
            );
          }
          return;
        }
        for (const itemId of items) {
          out.set(pairKey(ccId, itemId), recountOutcome(status === undefined ? null : { status }, null));
        }
      });
      return out;
    } catch (err) {
      reportDegradedRead('exceptions.recount_outcome', err, { counts: byCount.size });
      const unavailable = new Map<string, RecountOutcome>();
      for (const p of pairs) unavailable.set(pairKey(p.cycleCountId, p.itemId), { kind: 'unavailable' });
      return unavailable;
    }
  }

  /** Lines in a count, and lines counted so far. Throws on a failed read. */
  private async readProgress(cycleCountId: string): Promise<{ total: number; counted: number }> {
    const [total, counted] = await Promise.all([
      this.ctx.supabase
        .from('cycle_count_lines')
        .select('id', { count: 'exact', head: true })
        .eq('cycle_count_id', cycleCountId),
      this.ctx.supabase
        .from('cycle_count_lines')
        .select('id', { count: 'exact', head: true })
        .eq('cycle_count_id', cycleCountId)
        .not('counted_quantity', 'is', null),
    ]);
    if (total.error) throw new ServiceError('internal_error', postgrestErrorText(total.error));
    if (counted.error) throw new ServiceError('internal_error', postgrestErrorText(counted.error));
    if (typeof total.count !== 'number' || typeof counted.count !== 'number') {
      throw new ServiceError('internal_error', 'cycle_count_lines count missing');
    }
    return { total: total.count, counted: counted.count };
  }

  /** readProgress for a display line: a failed read is reported and gives
   *  null (the outcome then reads "In progress" with no numbers). */
  private async readProgressSoft(cycleCountId: string): Promise<{ total: number; counted: number } | null> {
    try {
      return await this.readProgress(cycleCountId);
    } catch (err) {
      reportDegradedRead('exceptions.recount_progress', err, {});
      return null;
    }
  }

  private reportUnknownRules(count: number): void {
    void reportError(new Error('Exception occurrence with a rule this build does not know'), {
      tag: 'exceptions.unknown_rule',
      level: 'warning',
      organizationId: this.ctx.organizationId,
      extra: { count },
    });
  }
}

/** The event kinds only the system writes (exceptions_sync). */
const SYSTEM_EVENT_KINDS: ReadonlySet<OccurrenceEventKind> = new Set([
  'raised',
  'recount_closed',
  'resolved',
]);

/** An event with no actor id: the system's own for a system kind; for a kind
 *  a person writes, the account was deleted (actor_user_id is ON DELETE SET
 *  NULL), which reads as a former member, never as "the system". */
function systemOrFormer(e: EventRow): OccurrencePerson | null {
  return SYSTEM_EVENT_KINDS.has(e.kind) ? null : { id: null, label: 'Former member' };
}

/** exception_occurrence_act's refusals, by SQLSTATE and hint (never by
 *  message text alone; pattern #28). */
function mapActError(error: { code?: string; message: string; hint?: string | null }): ServiceError {
  switch (error.code) {
    case '42501':
      return new ServiceError('forbidden', 'You do not have permission to act on this exception.');
    case 'P0002':
      return new ServiceError('not_found', 'Exception not found.');
    case 'P0001':
      if (error.hint === 'occurrence_resolved') {
        return new ServiceError('conflict', 'This exception has already been resolved.', {
          reason: 'occurrence_resolved',
        });
      }
      if (error.hint === 'client_event_id_conflict') {
        // The id was already used for a different request (another exception,
        // a different note or action). The client mints a new id and sends
        // again; nothing was saved by this call.
        return new ServiceError('conflict', 'This could not be saved as sent. Please try again.', {
          reason: 'client_event_id_conflict',
        });
      }
      break;
    case '22023': {
      const copy: Record<string, string> = {
        invalid_action: 'Choose acknowledge or note.',
        note_required: 'Add a note.',
        note_too_long: 'Notes can be at most 1,000 characters.',
        client_event_id_too_long: 'The request id is too long.',
      };
      const reason = error.hint ?? 'invalid_argument';
      return new ServiceError('validation_error', copy[reason] ?? 'Invalid request.', { reason });
    }
  }
  return new ServiceError('internal_error', postgrestErrorText(error));
}

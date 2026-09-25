import 'server-only';

import {
  can,
  EXCEPTION_RESOLVED_WINDOW_DAYS,
  EXCEPTION_RULE_IDS,
  formatOccurrenceNumber,
  isExceptionRule,
  isManagerOrAbove,
  presentWhenTrackingBegan,
  resolveOrgTimezone,
  type ExceptionCheckNotScheduledReason,
  type ExceptionRule,
  type OccurrenceEventKind,
  type OccurrenceRecountRef,
  type OccurrenceResolvedReason,
} from '@stockpilot/core';

import { assertWarehouseAccess, ForbiddenError, getWarehouseAccess } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';

import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { ExceptionsService } from './exceptions';
import { rawErrorText } from './lib/fetch-by-ids';
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
 *   - list / get: what a person reads, ALWAYS through their own client, so
 *     exception_occurrences RLS (_exc_occurrence_visible: item and holding
 *     visibility) decides what they see. No service-role read here.
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
  /** The ACTIVE recount (F1-2); feeds core occurrenceState. */
  recount: OccurrenceRecountRef | null;
  resolvedAt: string | null;
  resolvedReason: OccurrenceResolvedReason | null;
  previousOccurrenceId: string | null;
  recurrenceIndex: number;
  /** Whether this reader may acknowledge / add a note, mirroring the RPC's
   *  gate (stock:adjust and write access to the warehouse, or a manager when
   *  it has none). A hint for the UI; the RPC decides. */
  canAct: boolean;
}

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
  cycleCount: { id: string; countNumber: number | null } | null;
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
function personFor(id: string | null, profile: ProfileEmbed | undefined): OccurrencePerson {
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

function mapOccurrence(
  row: OccurrenceRow,
  syncState: ExceptionSyncState | null,
  canActOn: ActGate,
): ExceptionOccurrence | null {
  // A rule a newer build stored (count_variance, F1-2) is not one this build
  // can describe; the caller reports it instead of rendering a broken row.
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
          }
        : null,
    resolvedAt: row.resolved_at,
    resolvedReason: row.resolved_reason,
    previousOccurrenceId: row.previous_occurrence_id,
    recurrenceIndex: row.recurrence_index ?? 0,
    canAct: row.resolved_at === null && canActOn(row),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  async list(opts: { status?: OccurrenceListStatus } = {}): Promise<OccurrenceListResult> {
    assertPermission(this.ctx, 'items:read');
    const status: OccurrenceListStatus = opts.status === 'resolved' ? 'resolved' : 'open';
    const orgId = this.ctx.organizationId;
    const cap = status === 'open' ? OPEN_LIST_CAP : RESOLVED_LIST_CAP;
    const since = new Date(Date.now() - RESOLVED_WINDOW_DAYS * 86_400_000).toISOString();

    const [rows, syncState, gate, timeZone] = await Promise.all([
      fetchAllRows<Record<string, unknown>>(
        (from, to) => {
          const q = this.ctx.supabase
            .from('exception_occurrences')
            .select(OCCURRENCE_SELECT)
            .eq('organization_id', orgId);
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

    const occurrences: ExceptionOccurrence[] = [];
    let unknown = 0;
    for (const row of rows) {
      const mapped = mapOccurrence(row, syncState, gate);
      if (mapped) occurrences.push(mapped);
      else unknown += 1;
    }
    if (unknown > 0) this.reportUnknownRules(unknown);

    return {
      status,
      occurrences,
      truncated: rows.length >= cap,
      syncState,
      canCheckNow: isManagerOrAbove(this.ctx.role),
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
    const occurrence = mapOccurrence(row, syncState, gate);
    if (!occurrence) {
      this.reportUnknownRules(1);
      throw new ServiceError('not_found', 'Exception not found.');
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
          ? { id: e.cycle_count_id, countNumber: toNumber(e.cycle_count?.count_number) }
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
    const mapped = fresh ? mapOccurrence(fresh, syncState, gate) : null;
    if (!mapped) throw new ServiceError('not_found', 'Exception not found.');
    return mapped;
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

import 'server-only';

import { assertWarehouseAccess, ForbiddenError } from '@/lib/auth/warehouse';

import { audit } from './audit';
import {
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

import type {
  CreateScheduleEventInput,
  ScheduleStatus,
  UpdateScheduleEventInput,
} from '@stockpilot/core';

export interface ScheduleEventRow {
  id: string;
  organizationId: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  locationText: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  requesterName: string | null;
  details: string | null;
  status: ScheduleStatus;
  bundleId: string | null;
  bundleQuantity: number | null;
  bundleWarehouseId: string | null;
  /** True when at least one bundle_distributions row references this event. */
  bundleDistributed: boolean;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

// Embed only warehouse — that FK is unambiguous (warehouse_id →
// warehouses.id). Creator name is resolved in a separate batched
// query below; PostgREST can't reliably embed user_profiles via the
// auth.users → user_profiles chain, and a failed embed produces the
// dreaded "Something broke" page on the calendar.
const SELECT_COLUMNS = `
  id, organization_id, title, starts_at, ends_at, all_day,
  location_text, warehouse_id, requester_name, details, status,
  bundle_id, bundle_quantity, bundle_warehouse_id,
  created_by, updated_by, created_at, updated_at,
  warehouse:warehouses!warehouse_id (name)
`;

/**
 * Hard cap on a single range query — protects the calendar page from
 * a month with 10k events (unlikely but possible if a bulk-import
 * goes wrong). When hit, we log a warning so we know to paginate.
 */
const RANGE_LIMIT = 500;

/**
 * Allowed status transitions. The form's status dropdown lets the
 * user pick any of the four, but the service rejects illegal moves
 * (e.g. completed → in_progress requires going through Reopen, which
 * the UI exposes as a one-click action). Keeps the lifecycle clean
 * and the audit trail readable.
 *
 * `scheduled` is the implicit reset target — Reopen flips both
 * 'completed' and 'cancelled' back to it.
 */
const ALLOWED_STATUS_TRANSITIONS: Record<ScheduleStatus, ReadonlyArray<ScheduleStatus>> = {
  scheduled: ['scheduled', 'in_progress', 'cancelled'],
  in_progress: ['in_progress', 'completed', 'cancelled', 'scheduled'],
  // Reopen flows: completed/cancelled → scheduled. Direct completed
  // ↔ cancelled flips are blocked — must reopen first. This matters
  // because going cancelled → completed used to silently re-fire
  // distribution (the auto-distribute gate was `!= 'completed'`,
  // which is true for 'cancelled' too).
  completed: ['completed', 'scheduled'],
  cancelled: ['cancelled', 'scheduled'],
};

function mapRow(
  raw: Record<string, unknown>,
  creatorByUserId: Map<string, string> = new Map(),
  distributedEventIds: Set<string> = new Set(),
): ScheduleEventRow {
  const wh = raw.warehouse as { name?: string } | { name?: string }[] | null | undefined;
  const warehouseName = Array.isArray(wh) ? wh[0]?.name ?? null : wh?.name ?? null;
  const createdBy = raw.created_by as string;
  const id = raw.id as string;
  return {
    id,
    organizationId: raw.organization_id as string,
    title: raw.title as string,
    startsAt: raw.starts_at as string,
    endsAt: (raw.ends_at as string | null) ?? null,
    allDay: Boolean(raw.all_day),
    locationText: (raw.location_text as string | null) ?? null,
    warehouseId: (raw.warehouse_id as string | null) ?? null,
    warehouseName,
    requesterName: (raw.requester_name as string | null) ?? null,
    details: (raw.details as string | null) ?? null,
    status: raw.status as ScheduleStatus,
    bundleId: (raw.bundle_id as string | null) ?? null,
    bundleQuantity:
      raw.bundle_quantity == null ? null : Number(raw.bundle_quantity),
    bundleWarehouseId: (raw.bundle_warehouse_id as string | null) ?? null,
    bundleDistributed: distributedEventIds.has(id),
    createdBy,
    createdByName: creatorByUserId.get(createdBy) ?? null,
    createdAt: raw.created_at as string,
    updatedAt: raw.updated_at as string,
  };
}

/**
 * Returns the set of schedule_event ids that already have at least one
 * bundle_distributions row pointing back at them. Used to decide whether
 * a "Mark complete" action should fire a distribution or skip it.
 */
async function loadDistributedEventIds(
  ctx: ServiceContext,
  eventIds: string[],
): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  const { data } = await ctx.supabase
    .from('bundle_distributions')
    .select('schedule_event_id')
    .eq('organization_id', ctx.organizationId)
    .in('schedule_event_id', eventIds);
  const set = new Set<string>();
  for (const row of (data ?? []) as Array<{ schedule_event_id: string | null }>) {
    if (row.schedule_event_id) set.add(row.schedule_event_id);
  }
  return set;
}

/**
 * Batched creator-name lookup. Takes the unique createdBy ids off a
 * page of events and returns Map<userId, displayName>. Skipped (empty
 * map returned) if user_profiles isn't readable for some reason —
 * then mapRow leaves createdByName null, which the UI handles cleanly.
 */
async function loadCreatorNames(
  ctx: ServiceContext,
  rows: Array<{ created_by?: string | null }>,
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.created_by).filter((v): v is string => Boolean(v)))];
  if (ids.length === 0) return new Map();
  // user_profiles.id is the PK and references auth.users(id) directly
  // (see migration 0001_init.sql) — no separate user_id column.
  const { data, error } = await ctx.supabase
    .from('user_profiles')
    .select('id, full_name, email')
    .in('id', ids);
  if (error) return new Map();
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{
    id: string;
    full_name: string | null;
    email: string | null;
  }>) {
    const display = row.full_name?.trim() || row.email || null;
    if (display) map.set(row.id, display);
  }
  return map;
}

export class ScheduleService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ScheduleService(await withContext());
  }

  /**
   * List events whose [starts_at, ends_at) intersects [from, to). Open-
   * ended events (ends_at is null) are treated as ending at starts_at
   * for filtering purposes — they always show on their start day.
   */
  async listInRange(from: Date, to: Date): Promise<ScheduleEventRow[]> {
    const { data, error } = await this.ctx.supabase
      .from('schedule_events')
      .select(SELECT_COLUMNS)
      .eq('organization_id', this.ctx.organizationId)
      .lt('starts_at', to.toISOString())
      .or(`ends_at.is.null,ends_at.gte.${from.toISOString()}`)
      .order('starts_at', { ascending: true })
      // Hard cap so a runaway month doesn't OOM the calendar page.
      // If we ever legitimately hit this, the WARN below tells us to
      // paginate the calendar instead of bumping the limit.
      .limit(RANGE_LIMIT);
    if (error) throw new ServiceError('internal_error', error.message);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    if (rows.length >= RANGE_LIMIT) {
      console.warn(
        `[schedule.listInRange] hit cap of ${RANGE_LIMIT} events for org ` +
          `${this.ctx.organizationId} (${from.toISOString()} → ${to.toISOString()}). ` +
          `Consider paginating — some events are missing from the view.`,
      );
    }
    const ids = rows.map((r) => r.id as string);
    const [creators, distributed] = await Promise.all([
      loadCreatorNames(this.ctx, rows as Array<{ created_by?: string }>),
      loadDistributedEventIds(this.ctx, ids),
    ]);
    return rows.map((r) => mapRow(r, creators, distributed));
  }

  /** All upcoming events from now forward, capped — used for dashboards. */
  async listUpcoming(limit = 25): Promise<ScheduleEventRow[]> {
    const { data, error } = await this.ctx.supabase
      .from('schedule_events')
      .select(SELECT_COLUMNS)
      .eq('organization_id', this.ctx.organizationId)
      .gte('starts_at', new Date().toISOString())
      .in('status', ['scheduled', 'in_progress'])
      .order('starts_at', { ascending: true })
      .limit(Math.min(limit, 100));
    if (error) throw new ServiceError('internal_error', error.message);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const ids = rows.map((r) => r.id as string);
    const [creators, distributed] = await Promise.all([
      loadCreatorNames(this.ctx, rows as Array<{ created_by?: string }>),
      loadDistributedEventIds(this.ctx, ids),
    ]);
    return rows.map((r) => mapRow(r, creators, distributed));
  }

  async get(id: string): Promise<ScheduleEventRow> {
    const { data, error } = await this.ctx.supabase
      .from('schedule_events')
      .select(SELECT_COLUMNS)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Event not found');
    const [creators, distributed] = await Promise.all([
      loadCreatorNames(this.ctx, [data as { created_by?: string }]),
      loadDistributedEventIds(this.ctx, [id]),
    ]);
    return mapRow(data as Record<string, unknown>, creators, distributed);
  }

  async create(input: CreateScheduleEventInput): Promise<ScheduleEventRow> {
    assertPermission(this.ctx, 'schedule:manage');

    // Verify the caller can write to the event's warehouse + (if a
    // bundle is linked) the distribute-from warehouse. RLS already
    // gates the event's own warehouse, but it does NOT check
    // bundle_warehouse_id — that field doesn't show up in the
    // schedule_events RLS policy at all. Without this guard, a
    // warehouse-scoped manager could schedule a kit to be auto-
    // distributed FROM a warehouse they have no rights to.
    if (input.warehouseId) {
      try {
        await assertWarehouseAccess(input.warehouseId, 'write', this.ctx);
      } catch (e) {
        if (e instanceof ForbiddenError) throw new ServiceError('forbidden', e.message);
        throw e;
      }
    }
    if (input.bundleWarehouseId) {
      try {
        await assertWarehouseAccess(input.bundleWarehouseId, 'write', this.ctx);
      } catch (e) {
        if (e instanceof ForbiddenError) throw new ServiceError('forbidden', e.message);
        throw e;
      }
    }

    const { data, error } = await this.ctx.supabase
      .from('schedule_events')
      .insert({
        organization_id: this.ctx.organizationId,
        title: input.title,
        starts_at: input.startsAt,
        ends_at: input.endsAt ?? null,
        all_day: input.allDay,
        location_text: input.locationText ?? null,
        warehouse_id: input.warehouseId ?? null,
        requester_name: input.requesterName ?? null,
        details: input.details ?? null,
        status: input.status,
        bundle_id: input.bundleId ?? null,
        bundle_quantity: input.bundleQuantity ?? null,
        bundle_warehouse_id: input.bundleWarehouseId ?? null,
        created_by: this.ctx.userId,
        updated_by: this.ctx.userId,
      })
      .select(SELECT_COLUMNS)
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    const creators = await loadCreatorNames(this.ctx, [data as { created_by?: string }]);
    const row = mapRow(data as Record<string, unknown>, creators);

    await audit(
      {
        event: 'schedule.created',
        entityType: 'schedule_event',
        entityId: row.id,
        warehouseId: row.warehouseId,
        after: {
          title: row.title,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          status: row.status,
          bundleId: row.bundleId,
          bundleQuantity: row.bundleQuantity,
          bundleWarehouseId: row.bundleWarehouseId,
        },
      },
      this.ctx,
    );

    return row;
  }

  async update(id: string, patch: UpdateScheduleEventInput): Promise<ScheduleEventRow> {
    assertPermission(this.ctx, 'schedule:manage');

    // Load the current row up-front so we can: enforce the status
    // transition matrix, gate auto-distribute on the *prior* status,
    // and lock down bundle fields once a distribution has fired.
    const { data: beforeRow, error: beforeErr } = await this.ctx.supabase
      .from('schedule_events')
      .select(
        'status, bundle_id, bundle_quantity, bundle_warehouse_id, warehouse_id',
      )
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (beforeErr) throw new ServiceError('internal_error', beforeErr.message);
    if (!beforeRow) throw new ServiceError('not_found', 'Event not found');
    const beforeStatus = beforeRow.status as ScheduleStatus;

    // Validate status transition before we touch anything else.
    if (patch.status !== undefined && patch.status !== beforeStatus) {
      const allowed = ALLOWED_STATUS_TRANSITIONS[beforeStatus] ?? [];
      if (!allowed.includes(patch.status)) {
        throw new ServiceError(
          'validation_error',
          `Cannot move event from "${beforeStatus}" to "${patch.status}". ` +
            `Reopen the event first.`,
        );
      }
    }

    // Verify caller has write access to any warehouse mentioned in the
    // patch — both the event-pin warehouse and the bundle-source
    // warehouse. Same reasoning as create(): bundle_warehouse_id isn't
    // covered by RLS on schedule_events.
    if (patch.warehouseId) {
      try {
        await assertWarehouseAccess(patch.warehouseId, 'write', this.ctx);
      } catch (e) {
        if (e instanceof ForbiddenError) throw new ServiceError('forbidden', e.message);
        throw e;
      }
    }
    if (patch.bundleWarehouseId) {
      try {
        await assertWarehouseAccess(patch.bundleWarehouseId, 'write', this.ctx);
      } catch (e) {
        if (e instanceof ForbiddenError) throw new ServiceError('forbidden', e.message);
        throw e;
      }
    }

    // Lock down bundle fields after distribution has fired — once kits
    // are out the door the linkage is historical and must not change.
    // The form already disables these inputs, but the service is the
    // source of truth.
    const distributedBefore = await loadDistributedEventIds(this.ctx, [id]);
    const lockedAfterDistribution = distributedBefore.has(id);
    if (lockedAfterDistribution) {
      const touchesBundle =
        patch.bundleId !== undefined ||
        patch.bundleQuantity !== undefined ||
        patch.bundleWarehouseId !== undefined;
      if (touchesBundle) {
        const wouldChange =
          (patch.bundleId !== undefined &&
            (patch.bundleId ?? null) !== (beforeRow.bundle_id as string | null)) ||
          (patch.bundleQuantity !== undefined &&
            Number(patch.bundleQuantity ?? -1) !==
              Number(beforeRow.bundle_quantity ?? -1)) ||
          (patch.bundleWarehouseId !== undefined &&
            (patch.bundleWarehouseId ?? null) !==
              (beforeRow.bundle_warehouse_id as string | null));
        if (wouldChange) {
          throw new ServiceError(
            'validation_error',
            'Bundle linkage is locked: this event already triggered a ' +
              'distribution. Adjust on the bundle page if needed.',
          );
        }
      }
    }

    const updates: Record<string, unknown> = {
      updated_by: this.ctx.userId,
    };
    if (patch.title !== undefined) updates.title = patch.title;
    if (patch.startsAt !== undefined) updates.starts_at = patch.startsAt;
    if (patch.endsAt !== undefined) updates.ends_at = patch.endsAt ?? null;
    if (patch.allDay !== undefined) updates.all_day = patch.allDay;
    if (patch.locationText !== undefined)
      updates.location_text = patch.locationText ?? null;
    if (patch.warehouseId !== undefined)
      updates.warehouse_id = patch.warehouseId ?? null;
    if (patch.requesterName !== undefined)
      updates.requester_name = patch.requesterName ?? null;
    if (patch.details !== undefined) updates.details = patch.details ?? null;
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.bundleId !== undefined) updates.bundle_id = patch.bundleId ?? null;
    if (patch.bundleQuantity !== undefined)
      updates.bundle_quantity = patch.bundleQuantity ?? null;
    if (patch.bundleWarehouseId !== undefined)
      updates.bundle_warehouse_id = patch.bundleWarehouseId ?? null;

    const { data, error } = await this.ctx.supabase
      .from('schedule_events')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select(SELECT_COLUMNS)
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Event not found');

    // Auto-distribute on first transition INTO 'completed' FROM
    // 'in_progress'. The old gate (status !== 'completed') let a
    // cancelled event re-fire on completion. We tighten to require
    // the prior status to be exactly 'in_progress' — the normal
    // workflow path. Reopen → in_progress → complete still works.
    let autoDistFailed: { message: string; bundleId: string } | null = null;
    if (
      patch.status === 'completed' &&
      beforeStatus === 'in_progress'
    ) {
      const bundleId =
        (patch.bundleId ?? (beforeRow.bundle_id as string | null)) ?? null;
      const bundleQuantity =
        (patch.bundleQuantity ??
          (beforeRow.bundle_quantity == null
            ? null
            : Number(beforeRow.bundle_quantity))) ?? null;
      const bundleWarehouseId =
        (patch.bundleWarehouseId ??
          (beforeRow.bundle_warehouse_id as string | null)) ??
        null;

      if (bundleId && bundleQuantity && bundleWarehouseId) {
        // Defense in depth: the in-process duplicate check + the new
        // unique partial index on bundle_distributions(schedule_event_id)
        // together prevent double-fire. If the unique constraint trips
        // (23505) we treat it as benign — another concurrent caller
        // already distributed for this event.
        if (!distributedBefore.has(id)) {
          // assertWarehouseAccess guards above only cover the case
          // where the patch mutates bundle_warehouse_id. When the
          // caller is just flipping status and the bundle warehouse
          // was set by someone else earlier, re-check now.
          try {
            await assertWarehouseAccess(bundleWarehouseId, 'write', this.ctx);
          } catch (e) {
            if (e instanceof ForbiddenError) {
              throw new ServiceError(
                'forbidden',
                `Cannot auto-distribute: no write access to source warehouse. ${e.message}`,
              );
            }
            throw e;
          }

          const { error: distErr } = await this.ctx.supabase.rpc(
            'distribute_bundle',
            {
              p_bundle_id: bundleId,
              p_quantity: bundleQuantity,
              p_warehouse_id: bundleWarehouseId,
              p_allow_shortage: true, // event-driven: log shortage rather than block
              p_schedule_event_id: id,
              p_notes: 'Auto-distributed on event completion',
            },
          );
          if (distErr) {
            // 23505 = unique_violation. The unique partial index on
            // bundle_distributions(schedule_event_id) is the source
            // of truth — if it trips, somebody else already
            // distributed. Swallow + move on.
            const code = (distErr as { code?: string }).code;
            const msg = distErr.message ?? '';
            const isDup =
              code === '23505' ||
              msg.includes('bundle_distributions_event_uniq') ||
              msg.toLowerCase().includes('duplicate key');
            if (!isDup) {
              // Status flip already succeeded. Capture the failure
              // so we can surface a soft error to the UI after
              // emitting audit events.
              autoDistFailed = { message: distErr.message, bundleId };
            }
          }
        }
      }
    }

    const [creators, distributedAfter] = await Promise.all([
      loadCreatorNames(this.ctx, [data as { created_by?: string }]),
      loadDistributedEventIds(this.ctx, [id]),
    ]);
    const row = mapRow(data as Record<string, unknown>, creators, distributedAfter);

    // Audit: emit a status-specific event for completed/canceled
    // transitions, plus a generic .updated for everything else
    // (title, time, bundle reassignment, etc.).
    if (patch.status === 'completed' && beforeStatus !== 'completed') {
      await audit(
        {
          event: 'schedule.completed',
          entityType: 'schedule_event',
          entityId: id,
          warehouseId: row.warehouseId,
          before: { status: beforeStatus },
          after: { status: 'completed' },
          extra: { autoDistributed: row.bundleDistributed },
        },
        this.ctx,
      );
    } else if (patch.status === 'cancelled' && beforeStatus !== 'cancelled') {
      await audit(
        {
          event: 'schedule.canceled',
          entityType: 'schedule_event',
          entityId: id,
          warehouseId: row.warehouseId,
          before: { status: beforeStatus },
          after: { status: 'cancelled' },
        },
        this.ctx,
      );
    } else {
      // Non-status updates (title, time, bundle reassignment, etc.) get
      // a generic schedule.updated entry. The patch shape doesn't carry
      // updated_by, so we forward it as-is — audit_logs already records
      // user_id separately.
      await audit(
        {
          event: 'schedule.updated',
          entityType: 'schedule_event',
          entityId: id,
          warehouseId: row.warehouseId,
          before: { status: beforeStatus },
          after: patch,
        },
        this.ctx,
      );
    }

    if (autoDistFailed) {
      throw new ServiceError(
        'conflict',
        `Event marked complete, but bundle distribution failed: ` +
          `${autoDistFailed.message}. Retry from /dashboard/bundles/${autoDistFailed.bundleId}.`,
      );
    }

    return row;
  }

  async delete(id: string): Promise<void> {
    assertPermission(this.ctx, 'schedule:manage');

    // Read the row first so the audit entry can record what was
    // removed (title + status + warehouse). Cheap; the index covers it.
    const { data: prior } = await this.ctx.supabase
      .from('schedule_events')
      .select('title, status, warehouse_id, bundle_id, starts_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();

    const { error } = await this.ctx.supabase
      .from('schedule_events')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);

    await audit(
      {
        event: 'schedule.deleted',
        entityType: 'schedule_event',
        entityId: id,
        warehouseId: (prior?.warehouse_id as string | null) ?? null,
        before: prior ?? null,
      },
      this.ctx,
    );
  }
}

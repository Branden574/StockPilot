import 'server-only';

import {
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
      .order('starts_at', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
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
    return mapRow(data as Record<string, unknown>, creators);
  }

  async update(id: string, patch: UpdateScheduleEventInput): Promise<ScheduleEventRow> {
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

    // Detect a 'completed' transition that has a linked bundle attached
    // and no prior distribution. We only fire distribution on the first
    // such transition; subsequent re-completions (e.g. user reopens then
    // completes again) are no-ops on the distribution side, so we never
    // double-distribute the same kit.
    const beforeRes =
      patch.status === 'completed'
        ? await this.ctx.supabase
            .from('schedule_events')
            .select('status, bundle_id, bundle_quantity, bundle_warehouse_id')
            .eq('organization_id', this.ctx.organizationId)
            .eq('id', id)
            .maybeSingle()
        : null;

    const { data, error } = await this.ctx.supabase
      .from('schedule_events')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select(SELECT_COLUMNS)
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Event not found');

    // Auto-distribute on first transition into 'completed'.
    if (
      patch.status === 'completed' &&
      beforeRes &&
      beforeRes.data &&
      beforeRes.data.status !== 'completed'
    ) {
      const bundleId =
        (patch.bundleId ?? (beforeRes.data.bundle_id as string | null)) ?? null;
      const bundleQuantity =
        (patch.bundleQuantity ??
          (beforeRes.data.bundle_quantity == null
            ? null
            : Number(beforeRes.data.bundle_quantity))) ?? null;
      const bundleWarehouseId =
        (patch.bundleWarehouseId ??
          (beforeRes.data.bundle_warehouse_id as string | null)) ??
        null;

      if (bundleId && bundleQuantity && bundleWarehouseId) {
        // Only fire if no prior distribution exists for this event.
        const distributed = await loadDistributedEventIds(this.ctx, [id]);
        if (!distributed.has(id)) {
          const { error: distErr } = await this.ctx.supabase.rpc('distribute_bundle', {
            p_bundle_id: bundleId,
            p_quantity: bundleQuantity,
            p_warehouse_id: bundleWarehouseId,
            p_allow_shortage: true, // event-driven distribution: log shortage rather than block
            p_schedule_event_id: id,
            p_notes: 'Auto-distributed on event completion',
          });
          if (distErr) {
            // The event status change already succeeded. Surface the
            // distribution failure as a soft error so the caller (UI)
            // can show a toast — they can retry from the bundle page.
            throw new ServiceError(
              'conflict',
              `Event marked complete, but bundle distribution failed: ${distErr.message}. Retry from /dashboard/bundles/${bundleId}.`,
            );
          }
        }
      }
    }

    const [creators, distributedAfter] = await Promise.all([
      loadCreatorNames(this.ctx, [data as { created_by?: string }]),
      loadDistributedEventIds(this.ctx, [id]),
    ]);
    return mapRow(data as Record<string, unknown>, creators, distributedAfter);
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.ctx.supabase
      .from('schedule_events')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
  }
}

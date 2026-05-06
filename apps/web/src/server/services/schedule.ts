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
  created_by, updated_by, created_at, updated_at,
  warehouse:warehouses!warehouse_id (name)
`;

function mapRow(
  raw: Record<string, unknown>,
  creatorByUserId: Map<string, string> = new Map(),
): ScheduleEventRow {
  const wh = raw.warehouse as { name?: string } | { name?: string }[] | null | undefined;
  const warehouseName = Array.isArray(wh) ? wh[0]?.name ?? null : wh?.name ?? null;
  const createdBy = raw.created_by as string;
  return {
    id: raw.id as string,
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
    createdBy,
    createdByName: creatorByUserId.get(createdBy) ?? null,
    createdAt: raw.created_at as string,
    updatedAt: raw.updated_at as string,
  };
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
  const { data, error } = await ctx.supabase
    .from('user_profiles')
    .select('user_id, full_name, email')
    .in('user_id', ids);
  if (error) return new Map();
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{
    user_id: string;
    full_name: string | null;
    email: string | null;
  }>) {
    const display = row.full_name?.trim() || row.email || null;
    if (display) map.set(row.user_id, display);
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
    const creators = await loadCreatorNames(this.ctx, rows as Array<{ created_by?: string }>);
    return rows.map((r) => mapRow(r, creators));
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
    const creators = await loadCreatorNames(this.ctx, rows as Array<{ created_by?: string }>);
    return rows.map((r) => mapRow(r, creators));
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
    const creators = await loadCreatorNames(this.ctx, [data as { created_by?: string }]);
    return mapRow(data as Record<string, unknown>, creators);
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

    const { data, error } = await this.ctx.supabase
      .from('schedule_events')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select(SELECT_COLUMNS)
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Event not found');
    const creators = await loadCreatorNames(this.ctx, [data as { created_by?: string }]);
    return mapRow(data as Record<string, unknown>, creators);
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

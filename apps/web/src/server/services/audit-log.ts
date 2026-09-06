import 'server-only';

import { can } from '@stockpilot/core';

import { parseFromDateParam, parseToDateParam } from '@/lib/movements-filters';

import { ServiceError, withContext, type ServiceContext } from './context';

export interface AuditLogActor {
  userId: string;
  fullName: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface AuditLogRow {
  id: string;
  event: string;
  createdAt: string;
  actor: AuditLogActor | null;
  metadata: Record<string, unknown>;
  ip: string | null;
}

export interface AuditLogFilters {
  event?: string;
  /**
   * Filter by event-name prefix (e.g. 'stock.' → every stock event). Drives
   * the category quick-chips on /dashboard/audit. Ignored when `event` is
   * set (an exact match is always narrower).
   */
  eventPrefix?: string;
  userId?: string;
  entityType?: string;
  /**
   * Filter by metadata.entity_id. Used by the recovery page's "View
   * history" deep-link so a single soft-deleted row's audit trail
   * surfaces. Always paired with entityType for correctness.
   */
  entityId?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

/**
 * Shape of a row when joined with `user_profiles` via the user_id FK.
 * Database is typed as `any` org-wide, so we cast at the boundary
 * to keep the rest of the file in real types.
 */
interface RawAuditRow {
  id: string;
  event: string;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
  actor:
    | {
        id: string;
        full_name: string | null;
        email: string | null;
        avatar_url: string | null;
      }
    | null;
}

/** `<input type="date">` shape — the only thing /dashboard/audit ever sends. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalises the `since`/`until` filters before they reach PostgREST.
 *
 * SP-042: the audit filter bar is two `<input type="date">` fields, so both
 * bounds arrive as 'YYYY-MM-DD' and used to be handed straight to
 * `.gte`/`.lte('created_at', …)`. Postgres casts a bare date to midnight UTC,
 * so `created_at <= '2026-09-10'` kept ONLY rows stamped exactly at
 * 00:00:00Z — picking Since = Until = one day rendered "No entries" while
 * that day was full of events, and the only workaround (set Until to
 * tomorrow) is one nobody would guess. So a date-only upper bound becomes an
 * EXCLUSIVE next-midnight `lt`, which covers the whole selected day. This is
 * exactly what the Movements page has always done — parseFrom/ToDateParam in
 * lib/movements-filters.ts is that shared, pure helper, reused here rather
 * than copied so the two pages can't drift (recurring pattern #26).
 *
 * A full ISO timestamp (no caller sends one today, but the filter type
 * allows it) is left alone on an inclusive `lte`. Anything unparseable —
 * '2026-13-45', a hand-edited '?until=garbage' — drops the bound instead of
 * letting Postgres 500 the page on a bad cast, matching how the Movements
 * page treats a mangled param.
 *
 * KNOWN LIMIT: the day boundary is UTC, not the viewer's timezone, so a
 * late-evening US event lands on the next UTC day. Same caveat the Movements
 * page carries; if a zone-aware helper lands (SP-079), use it here too.
 */
function normalizeSince(raw: string): string | undefined {
  if (DATE_ONLY.test(raw)) return parseFromDateParam(raw);
  return Number.isNaN(Date.parse(raw)) ? undefined : raw;
}

function normalizeUntil(raw: string): { op: 'lt' | 'lte'; value: string } | undefined {
  if (DATE_ONLY.test(raw)) {
    const exclusive = parseToDateParam(raw);
    return exclusive ? { op: 'lt', value: exclusive } : undefined;
  }
  return Number.isNaN(Date.parse(raw)) ? undefined : { op: 'lte', value: raw };
}

const SELECT_COLUMNS =
  'id, event, metadata, ip, created_at, actor:user_id (id, full_name, email, avatar_url)';

function toRow(raw: RawAuditRow): AuditLogRow {
  // PostgREST sometimes returns embedded foreign rows as a single object
  // (one-to-one) and sometimes as an array — the `audit_logs.user_id`
  // FK is one-to-one but the type system can't always tell. Normalize
  // both shapes here.
  const actorObj = Array.isArray(raw.actor) ? raw.actor[0] ?? null : raw.actor;
  return {
    id: raw.id,
    event: raw.event,
    createdAt: raw.created_at,
    metadata: (raw.metadata ?? {}) as Record<string, unknown>,
    ip: raw.ip,
    actor: actorObj
      ? {
          userId: actorObj.id,
          fullName: actorObj.full_name,
          email: actorObj.email,
          avatarUrl: actorObj.avatar_url,
        }
      : null,
  };
}

export class AuditLogService {
  private constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new AuditLogService(await withContext());
  }

  /**
   * Global audit feed. RLS (mig 0279) restricts SELECT on audit_logs to
   * holders of `activity_logs:read`, but we throw a clear "forbidden"
   * up-front so the UI doesn't have to interpret an empty list as "denied".
   *
   * Gates on the EFFECTIVE `activity_logs:read` (via can(), so matrix
   * grants apply — a viewer granted the permission, e.g. via the Auditor
   * preset, passes) matching the page-level check at /dashboard/audit.
   * Manager and above carry this permission by default.
   */
  async list(filters: AuditLogFilters = {}): Promise<{ rows: AuditLogRow[]; total: number }> {
    if (!can(this.ctx, 'activity_logs:read')) {
      throw new ServiceError('forbidden', 'Audit log access requires the activity_logs:read permission.');
    }

    const limit = Math.min(Math.max(1, filters.limit ?? 50), 200);
    const offset = Math.max(0, filters.offset ?? 0);

    let query = this.ctx.supabase
      .from('audit_logs')
      .select(SELECT_COLUMNS, { count: 'exact' })
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filters.event) query = query.eq('event', filters.event);
    else if (filters.eventPrefix) query = query.like('event', `${filters.eventPrefix}%`);
    if (filters.userId) query = query.eq('user_id', filters.userId);
    if (filters.entityType) {
      query = query.filter('metadata->>entity_type', 'eq', filters.entityType);
    }
    if (filters.entityId) {
      query = query.filter('metadata->>entity_id', 'eq', filters.entityId);
    }
    if (filters.since) {
      // See normalizeSince/normalizeUntil above (SP-042): a date-only bound
      // must span the WHOLE day, so the upper bound is exclusive-of-next-day.
      const since = normalizeSince(filters.since);
      if (since) query = query.gte('created_at', since);
    }
    if (filters.until) {
      const until = normalizeUntil(filters.until);
      if (until?.op === 'lt') query = query.lt('created_at', until.value);
      else if (until) query = query.lte('created_at', until.value);
    }

    const { data, error, count } = await query;
    if (error) {
      throw new ServiceError('internal_error', `Failed to load audit log: ${error.message}`);
    }
    const rows = ((data ?? []) as unknown as RawAuditRow[]).map(toRow);
    return { rows, total: count ?? rows.length };
  }
}

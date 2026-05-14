import 'server-only';

import { isAdminRole } from '@stockpilot/core';

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
   * Global audit feed for admins. RLS already restricts SELECT on
   * audit_logs to admins, but we throw a clear "forbidden" up-front so
   * the UI doesn't have to interpret an empty list as "denied".
   *
   * No `audit:read` permission exists in @stockpilot/core's registry,
   * so we gate on role directly (admin or owner).
   */
  async list(filters: AuditLogFilters = {}): Promise<{ rows: AuditLogRow[]; total: number }> {
    if (!isAdminRole(this.ctx.role)) {
      throw new ServiceError('forbidden', 'Audit log access requires admin role.');
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
    if (filters.userId) query = query.eq('user_id', filters.userId);
    if (filters.entityType) {
      query = query.filter('metadata->>entity_type', 'eq', filters.entityType);
    }
    if (filters.entityId) {
      query = query.filter('metadata->>entity_id', 'eq', filters.entityId);
    }
    if (filters.since) query = query.gte('created_at', filters.since);
    if (filters.until) query = query.lte('created_at', filters.until);

    const { data, error, count } = await query;
    if (error) {
      throw new ServiceError('internal_error', `Failed to load audit log: ${error.message}`);
    }
    const rows = ((data ?? []) as unknown as RawAuditRow[]).map(toRow);
    return { rows, total: count ?? rows.length };
  }

  /**
   * Per-entity history. Not role-gated at the service level — RLS on
   * audit_logs is admin-only so non-admins will simply get an empty
   * list. That matches the read access model for v1.
   */
  async forEntity(
    entityType: string,
    entityId: string,
    limit = 30,
  ): Promise<AuditLogRow[]> {
    const cap = Math.min(Math.max(1, limit), 200);

    const { data, error } = await this.ctx.supabase
      .from('audit_logs')
      .select(SELECT_COLUMNS)
      .eq('organization_id', this.ctx.organizationId)
      .filter('metadata->>entity_type', 'eq', entityType)
      .filter('metadata->>entity_id', 'eq', entityId)
      .order('created_at', { ascending: false })
      .limit(cap);

    if (error) {
      // forEntity is rendered inline on detail pages — surface as empty
      // rather than crashing the parent page. The error reporter on the
      // writer side covers diagnosis.
      return [];
    }
    return ((data ?? []) as unknown as RawAuditRow[]).map(toRow);
  }
}

import 'server-only';

import { ServiceContext, withContext } from './context';

export interface ActivityEvent {
  id: string;
  kind: 'movement' | 'audit';
  type: string;
  createdAt: string;
  /** Movement: numeric delta. Audit: null. */
  delta: number | null;
  /** Movement: post-change quantity. Audit: null. */
  quantityAfter: number | null;
  /** Free-text description suitable for a single-line event row. */
  summary: string | null;
  /** Display name of the actor (or "System") if attribution missing. */
  actor: string;
  actorEmail: string | null;
}

export class ActivityService {
  private constructor(private ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ActivityService(await withContext());
  }

  /**
   * Returns a unified, time-sorted activity feed for the given item:
   * stock movements + audit-log entries that reference the item via
   * metadata.entity_id. Capped at `limit` total rows.
   */
  async forItem(itemId: string, limit = 30): Promise<ActivityEvent[]> {
    const halfLimit = Math.ceil(limit / 1.5);

    const [movementsRes, auditRes] = await Promise.all([
      this.ctx.supabase
        .from('stock_movements')
        .select(
          'id, movement_type, quantity_change, new_quantity, reason, notes, created_at, user_id',
        )
        .eq('organization_id', this.ctx.organizationId)
        .eq('item_id', itemId)
        .order('created_at', { ascending: false })
        .limit(halfLimit),
      this.ctx.supabase
        .from('audit_logs')
        .select('id, event, metadata, created_at, user_id')
        .eq('organization_id', this.ctx.organizationId)
        // Extracted-text equality so Postgres can use the
        // audit_logs_org_entity_created_idx expression index added in
        // migration 0135. The previous `.contains(metadata, …)` form
        // forced a sequential scan because @> can't use a BTREE on
        // the extracted text path.
        .eq('metadata->>entity_id', itemId)
        .order('created_at', { ascending: false })
        .limit(halfLimit),
    ]);

    const userIds = new Set<string>();
    for (const m of movementsRes.data ?? []) {
      const uid = m.user_id as string | null;
      if (uid) userIds.add(uid);
    }
    for (const a of auditRes.data ?? []) {
      const uid = a.user_id as string | null;
      if (uid) userIds.add(uid);
    }

    const profiles = new Map<string, { name: string; email: string | null }>();
    if (userIds.size > 0) {
      const { data } = await this.ctx.supabase
        .from('user_profiles')
        .select('id, full_name, email')
        .in('id', Array.from(userIds));
      for (const p of data ?? []) {
        profiles.set(p.id as string, {
          name: ((p.full_name as string | null) || (p.email as string | null) || 'Unknown').trim(),
          email: (p.email as string | null) ?? null,
        });
      }
    }

    function actor(uid: string | null): { name: string; email: string | null } {
      if (!uid) return { name: 'System', email: null };
      return profiles.get(uid) ?? { name: 'Unknown', email: null };
    }

    const movementEvents: ActivityEvent[] = (movementsRes.data ?? []).map((m) => {
      const a = actor(m.user_id as string | null);
      const reason = (m.reason as string | null) ?? (m.notes as string | null);
      return {
        id: `m:${m.id as string}`,
        kind: 'movement',
        type: m.movement_type as string,
        createdAt: m.created_at as string,
        delta: Number(m.quantity_change),
        quantityAfter: Number(m.new_quantity),
        summary: reason,
        actor: a.name,
        actorEmail: a.email,
      };
    });

    const auditEvents: ActivityEvent[] = (auditRes.data ?? []).map((row) => {
      const a = actor(row.user_id as string | null);
      const meta = (row.metadata as Record<string, unknown> | null) ?? {};
      const reason = (meta.reason as string | null) ?? null;
      return {
        id: `a:${row.id as string}`,
        kind: 'audit',
        type: row.event as string,
        createdAt: row.created_at as string,
        delta: null,
        quantityAfter: null,
        summary: reason,
        actor: a.name,
        actorEmail: a.email,
      };
    });

    return [...movementEvents, ...auditEvents]
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .slice(0, limit);
  }
}

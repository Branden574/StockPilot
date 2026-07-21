import 'server-only';

import { assertWarehouseAccess } from '@/lib/auth/warehouse';

import { audit } from './audit';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  type ServiceContext,
} from './context';

export type SizeCountMode = 'rapid_pass' | 'box_overview';
export type SizeCountStatus = 'active' | 'review' | 'completed' | 'canceled';

export interface SizeCountSessionRow {
  id: string;
  organization_id: string;
  warehouse_id: string | null;
  purchase_order_id: string | null;
  supplier_id: string | null;
  style_key: string | null;
  box_id: string | null;
  mode: SizeCountMode;
  status: SizeCountStatus;
  expected_quantity: number | null;
  started_by: string | null;
  started_at: string;
  completed_at: string | null;
  model_version: string | null;
  created_offline: boolean;
}

/** One count event from the mobile outbox. `idempotencyKey` is a client UUID
 *  so a replayed batch never double-counts. */
export interface SizeCountEventInput {
  idempotencyKey: string;
  size: string;
  quantityDelta?: number; // default +1; -1 for an undo
  confidence?: number | null;
  recognitionMethod?:
    | 'rapid_pass_gate'
    | 'box_overview'
    | 'manual'
    | 'ai_review'
    | 'barcode';
  ephemeralTrackId?: string | null;
  reason?: string | null;
  modelVersion?: string | null;
  countedAt?: string | null;
}

/**
 * Instant Size Count — server service. Owns session lifecycle + the idempotent
 * event ledger that the mobile offline outbox drains into. Inventory
 * application (finalize → adjust_stock) is intentionally NOT here yet: it needs
 * the add-vs-set semantic + size→item resolution decision (Phase 0 spec).
 */
export class SizeCountsService {
  constructor(private ctx: ServiceContext) {}

  async createSession(input: {
    mode?: SizeCountMode;
    warehouseId?: string | null;
    purchaseOrderId?: string | null;
    supplierId?: string | null;
    styleKey?: string | null;
    boxId?: string | null;
    expectedQuantity?: number | null;
    deviceId?: string | null;
    modelVersion?: string | null;
    createdOffline?: boolean;
  }): Promise<SizeCountSessionRow> {
    assertModuleEnabled(this.ctx, 'instant_size_count');
    assertPermission(this.ctx, 'stock:adjust');
    if (input.warehouseId) {
      await assertWarehouseAccess(input.warehouseId, 'write', this.ctx);
    }
    const { data, error } = await this.ctx.supabase
      .from('size_count_sessions')
      .insert({
        organization_id: this.ctx.organizationId,
        warehouse_id: input.warehouseId ?? null,
        purchase_order_id: input.purchaseOrderId ?? null,
        supplier_id: input.supplierId ?? null,
        style_key: input.styleKey ?? null,
        box_id: input.boxId ?? null,
        mode: input.mode ?? 'rapid_pass',
        expected_quantity: input.expectedQuantity ?? null,
        started_by: this.ctx.userId,
        device_id: input.deviceId ?? null,
        model_version: input.modelVersion ?? null,
        created_offline: input.createdOffline ?? false,
      })
      .select('*')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      throw new ServiceError('forbidden', 'Could not start the size count.');
    }
    await audit(
      { event: 'size_count.started', entityType: 'size_count_session', entityId: (data as { id: string }).id },
      this.ctx,
    );
    return data as unknown as SizeCountSessionRow;
  }

  /**
   * Idempotently append a batch of count events. Replays (same
   * session_id + idempotency_key) are silently ignored via upsert, so the
   * mobile outbox can safely re-send after a flaky network. Returns the
   * number of NEW events that landed.
   */
  async appendEvents(
    sessionId: string,
    events: SizeCountEventInput[],
  ): Promise<{ inserted: number }> {
    assertModuleEnabled(this.ctx, 'instant_size_count');
    assertPermission(this.ctx, 'stock:adjust');
    if (events.length === 0) return { inserted: 0 };

    // Confirm the session exists in this org and is still open (RLS also
    // enforces org scope; this yields a clean 404/409 before the write).
    const { data: session, error: sErr } = await this.ctx.supabase
      .from('size_count_sessions')
      .select('warehouse_id, status')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', sessionId)
      .maybeSingle();
    if (sErr) throw new ServiceError('internal_error', sErr.message);
    if (!session) throw new ServiceError('not_found', 'Size count not found.');
    const s = session as { warehouse_id: string | null; status: SizeCountStatus };
    if (s.status === 'completed' || s.status === 'canceled') {
      throw new ServiceError('conflict', 'This size count is closed — it can no longer be counted.');
    }
    if (s.warehouse_id) {
      await assertWarehouseAccess(s.warehouse_id, 'write', this.ctx);
    }

    const rows = events.map((e) => ({
      session_id: sessionId,
      organization_id: this.ctx.organizationId,
      idempotency_key: e.idempotencyKey,
      size: e.size,
      quantity_delta: e.quantityDelta ?? 1,
      confidence: e.confidence ?? null,
      recognition_method: e.recognitionMethod ?? 'rapid_pass_gate',
      ephemeral_track_id: e.ephemeralTrackId ?? null,
      reason: e.reason ?? null,
      counted_by: this.ctx.userId,
      counted_at: e.countedAt ?? new Date().toISOString(),
      model_version: e.modelVersion ?? null,
    }));

    // Idempotent: ignore rows whose (session_id, idempotency_key) already
    // exists. `.select()` returns only the rows that actually inserted.
    const { data, error } = await this.ctx.supabase
      .from('size_count_events')
      .upsert(rows, {
        onConflict: 'session_id,idempotency_key',
        ignoreDuplicates: true,
      })
      .select('id');
    if (error) throw new ServiceError('internal_error', error.message);
    return { inserted: (data as unknown[] | null)?.length ?? 0 };
  }

  /**
   * Complete a session: LOCK the review list (status -> completed). This
   * feature does NOT write inventory (owner decision) — completing just
   * finalizes the per-size tally for review. No adjust_stock, no size->item
   * resolution. Idempotent-ish: re-completing a completed session is a no-op
   * conflict surfaced by the status guard.
   */
  async completeSession(sessionId: string): Promise<SizeCountSessionRow> {
    assertModuleEnabled(this.ctx, 'instant_size_count');
    assertPermission(this.ctx, 'stock:adjust');
    const { data, error } = await this.ctx.supabase
      .from('size_count_sessions')
      .update({
        status: 'completed',
        completed_by: this.ctx.userId,
        completed_at: new Date().toISOString(),
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', sessionId)
      .eq('status', 'active') // only an active session can be completed (guard)
      .select('*')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      throw new ServiceError(
        'conflict',
        'Size count not found, or it is already completed or canceled.',
      );
    }
    await audit(
      { event: 'size_count.completed', entityType: 'size_count_session', entityId: sessionId },
      this.ctx,
    );
    return data as unknown as SizeCountSessionRow;
  }

  /** Session header + the per-size tally (SUM of quantity_delta by size). */
  async getSession(sessionId: string): Promise<{
    session: SizeCountSessionRow;
    tally: Array<{ size: string; quantity: number }>;
  }> {
    assertModuleEnabled(this.ctx, 'instant_size_count');
    const { data: session, error } = await this.ctx.supabase
      .from('size_count_sessions')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', sessionId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!session) throw new ServiceError('not_found', 'Size count not found.');

    const { data: events, error: eErr } = await this.ctx.supabase
      .from('size_count_events')
      .select('size, quantity_delta')
      .eq('session_id', sessionId);
    if (eErr) throw new ServiceError('internal_error', eErr.message);

    const bySize = new Map<string, number>();
    for (const row of (events ?? []) as Array<{ size: string; quantity_delta: number }>) {
      bySize.set(row.size, (bySize.get(row.size) ?? 0) + row.quantity_delta);
    }
    const tally = Array.from(bySize.entries())
      .map(([size, quantity]) => ({ size, quantity }))
      .filter((t) => t.quantity !== 0);

    return { session: session as unknown as SizeCountSessionRow, tally };
  }
}

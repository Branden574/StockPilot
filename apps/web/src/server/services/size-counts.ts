import 'server-only';

import type { CountingUnit } from '@stockpilot/core';

import { assertWarehouseAccess } from '@/lib/auth/warehouse';
import { scanDocumentBytes, THREAT_MESSAGES } from '@/lib/document-threat-scan';
import {
  isSniffedKindAllowedInBucket,
  MIME_FOR_KIND,
  sniffImage,
} from '@/lib/image-signature';
import { createAdminClient } from '@/lib/supabase/admin';

import { audit } from './audit';
import { fetchAllRows } from './lib/paginate';
import { ProductGroupsService } from './product-groups';
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
  /** Display-only legacy key derived from the item NAME. Kept for pre-0302
   *  sessions and for ungrouped inventory; never the durable identity. */
  style_key: string | null;
  /** The product group these sizes belong to (migration 0302). The durable
   *  identity that replaces style_key. NULL on every pre-0302 session and in
   *  any org that has not opted into groups. */
  product_group_id: string | null;
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
    /** Legacy display key. Still accepted for orgs with no sports module. */
    styleKey?: string | null;
    /** The product group being counted. Preferred over styleKey: renaming an
     *  item cannot detach the count from it. */
    productGroupId?: string | null;
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
        // Org consistency is ALSO enforced by the 0302 policy arm
        // (product_group_in_org): a group id is a client-supplied uuid, and a
        // plain FK cannot say "and it must be ours".
        product_group_id: input.productGroupId ?? null,
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

  /**
   * Record one opt-in LABELED training sample (photo + ground-truth size, or
   * NONE for a hard negative) into the private size-count-training bucket +
   * the samples table. This is Step 1 of the on-device-model track — the
   * dataset the detector trains on. Uploads via the service-role admin client
   * (the request is already authorized here); the row insert runs on the
   * user client so RLS (staff + captured_by=self) applies.
   */
  async recordTrainingSample(input: {
    imageBytes: ArrayBuffer;
    mimeType: string;
    sizeLabel: string;
    isNegative?: boolean;
    metadata?: Record<string, unknown>;
    deviceId?: string | null;
  }): Promise<{ id: string }> {
    assertModuleEnabled(this.ctx, 'instant_size_count');
    assertPermission(this.ctx, 'stock:adjust');
    // ═══ SNIFF BEFORE THE WRITE ═══
    //
    // `input.mimeType` is the caller's declared type, and the bucket's own
    // allowed_mime_types only ever checks that same declared value — so a
    // renamed binary reaches this bucket by claiming image/webp. This is the
    // largest object store in the system (2,174 objects at the time of the
    // upload-hardening audit) and its contents are fed to a vision model as
    // training data, so unverified bytes here are both a payload host and a
    // poisoned corpus.
    //
    // The bytes pass THROUGH this method, so the check goes before the upload
    // rather than as the fetch-back-and-delete a client-direct finalize needs.
    // Nothing unverified reaches storage at all.
    const sniffed = sniffImage(new Uint8Array(input.imageBytes));
    if (!sniffed || !isSniffedKindAllowedInBucket(sniffed.kind, 'size-count-training')) {
      throw new ServiceError(
        'validation_error',
        'This file could not be uploaded because it failed our security checks.',
      );
    }
    // And whether anything is hiding after the end of the image.
    const threat = scanDocumentBytes(new Uint8Array(input.imageBytes), sniffed.kind);
    if (threat) throw new ServiceError('validation_error', THREAT_MESSAGES[threat.code]);

    // Extension and stored content-type both follow the BYTES, not the claim.
    const ext = sniffed.kind === 'webp' ? 'webp' : sniffed.kind === 'png' ? 'png' : 'jpg';
    const path = `${this.ctx.organizationId}/${crypto.randomUUID()}.${ext}`;
    const admin = createAdminClient();
    const { error: upErr } = await admin.storage
      .from('size-count-training')
      .upload(path, input.imageBytes, {
        contentType: MIME_FOR_KIND[sniffed.kind],
        upsert: false,
      });
    if (upErr) throw new ServiceError('internal_error', upErr.message);

    const { data, error } = await this.ctx.supabase
      .from('size_count_training_samples')
      .insert({
        organization_id: this.ctx.organizationId,
        captured_by: this.ctx.userId,
        image_storage_path: path,
        size_label: input.sizeLabel,
        is_negative: input.isNegative ?? false,
        metadata: input.metadata ?? {},
        device_id: input.deviceId ?? null,
      })
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      // Orphaned upload — best-effort cleanup so a failed row insert doesn't
      // leave a dangling training image.
      await admin.storage.from('size-count-training').remove([path]);
      throw new ServiceError('forbidden', 'Could not save the training sample.');
    }
    return { id: (data as { id: string }).id };
  }

  /**
   * Per-size counts of TRAINING samples captured so far for this org (drives
   * the capture screen's persistent progress, so leaving + returning shows the
   * real running totals — not a per-visit reset). Reads only the label column.
   */
  async getTrainingStats(): Promise<{ counts: Record<string, number>; total: number }> {
    assertModuleEnabled(this.ctx, 'instant_size_count');
    // Counted by PAGING TO EXHAUSTION, not by one bare .select().
    //
    // PostgREST clamps every response to [api] max_rows = 1000
    // (supabase/config.toml), and a plain select gives no hint it truncated. So
    // once an org passed 1000 samples this counter silently stopped rising and
    // under-reported the dataset by more than half: the owner had 2,171 photos
    // and the capture screen was summing only the first 1,000, which reads as
    // "my work is not saving" (reported 2026-07-22).
    //
    // The label set is open (LABELS on the capture screen already lists nine
    // sizes and more may be added), so a per-label head-count would need this
    // service to know that list and would silently drop any label it did not
    // know about. Paging the label column keeps it label-agnostic and is one
    // round trip per 1000 samples on a column-only read.
    const rows = await fetchAllRows<{ size_label: string }>((from, to) =>
      this.ctx.supabase
        .from('size_count_training_samples')
        .select('id, size_label')
        .eq('organization_id', this.ctx.organizationId)
        .order('id')
        .range(from, to),
    );
    const counts: Record<string, number> = {};
    for (const r of rows) {
      counts[r.size_label] = (counts[r.size_label] ?? 0) + 1;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { counts, total };
  }

  /**
   * List recent training samples with short-lived SIGNED image URLs so the
   * mobile review grid can render the private-bucket thumbnails. Newest first,
   * optionally filtered by size.
   */
  async listTrainingSamples(opts?: {
    size?: string;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      sizeLabel: string;
      isNegative: boolean;
      capturedAt: string;
      url: string | null;
    }>
  > {
    assertModuleEnabled(this.ctx, 'instant_size_count');
    let q = this.ctx.supabase
      .from('size_count_training_samples')
      .select('id, size_label, is_negative, image_storage_path, captured_at')
      .eq('organization_id', this.ctx.organizationId)
      .order('captured_at', { ascending: false })
      .limit(Math.min(opts?.limit ?? 500, 1000));
    if (opts?.size) q = q.eq('size_label', opts.size);
    const { data, error } = await q;
    if (error) throw new ServiceError('internal_error', error.message);
    const rows = (data ?? []) as Array<{
      id: string;
      size_label: string;
      is_negative: boolean;
      image_storage_path: string;
      captured_at: string;
    }>;
    if (rows.length === 0) return [];
    const admin = createAdminClient();
    const { data: signed } = await admin.storage
      .from('size-count-training')
      .createSignedUrls(rows.map((r) => r.image_storage_path), 3600);
    const urlByPath = new Map<string, string>();
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
    }
    return rows.map((r) => ({
      id: r.id,
      sizeLabel: r.size_label,
      isNegative: r.is_negative,
      capturedAt: r.captured_at,
      url: urlByPath.get(r.image_storage_path) ?? null,
    }));
  }

  /** Delete one training sample (row + its storage object). Manager-gated by
   *  the 0284 RLS; a non-manager gets a clean forbidden. */
  async deleteTrainingSample(id: string): Promise<void> {
    assertModuleEnabled(this.ctx, 'instant_size_count');
    const { data: row, error } = await this.ctx.supabase
      .from('size_count_training_samples')
      .select('image_storage_path')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!row) throw new ServiceError('not_found', 'Training sample not found.');
    const path = (row as { image_storage_path: string }).image_storage_path;

    const { data: del, error: dErr } = await this.ctx.supabase
      .from('size_count_training_samples')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (dErr) throw new ServiceError('internal_error', dErr.message);
    if (!del) {
      throw new ServiceError('forbidden', 'Only a manager can delete training samples.');
    }
    // Row gone — best-effort remove the storage object.
    const admin = createAdminClient();
    await admin.storage.from('size-count-training').remove([path]);
  }

  /**
   * The group a session is counting, in the shape a tally screen needs: what
   * to call it, what its quantities are counted in, and WHICH SIZES EXIST.
   *
   * The size list is the point. Before 0302 the phone's chips were nine
   * hardcoded garment sizes (XS..5XL), so a shoe count could not tally a 9.5
   * at all. A grouped session drives its chips from the group's own size
   * scale instead.
   *
   * Returns null for an ungrouped session — which is every pre-0302 session
   * and every org without the sports module — and the caller falls back to
   * the legacy chip set, unchanged.
   *
   * The sports module is CHECKED, not asserted: a session keeps its group
   * after an org turns the module off, and reading back a count list you
   * already made must not start failing with a 403.
   */
  private async groupContext(groupId: string | null): Promise<{
    id: string;
    name: string;
    countingUnit: CountingUnit;
    sizes: string[];
  } | null> {
    if (!groupId) return null;
    if (!this.ctx.enabledModules.has('sports')) return null;
    const groups = new ProductGroupsService(this.ctx);
    const display = (await groups.displayByIds([groupId])).get(groupId);
    if (!display) return null;
    // sizeOrder is value -> sort_order; render them in the scale's own order.
    const sizes = Array.from(display.sizeOrder.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([value]) => value);
    return {
      id: groupId,
      name: display.name,
      countingUnit: display.countingUnit,
      sizes,
    };
  }

  /** Session header + the per-size tally (SUM of quantity_delta by size). */
  async getSession(sessionId: string): Promise<{
    session: SizeCountSessionRow;
    tally: Array<{ size: string; quantity: number }>;
    /** The counted group's identity + size scale, or null when ungrouped. */
    group: { id: string; name: string; countingUnit: CountingUnit; sizes: string[] } | null;
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

    // PAGED TO EXHAUSTION, for the same reason `getTrainingStats` in this file
    // is: PostgREST clamps every response to [api] max_rows = 1000
    // (supabase/config.toml) and a bare .select() gives no hint that it
    // truncated. A tally is one EVENT PER TAP — the whole point of the counter
    // is that a person taps it hundreds of times — so a long session (or one
    // where undos double the row count) silently under-reported its own totals
    // once past 1000 events, which reads as "the count is wrong" on the one
    // screen whose only output is that number. The owner hit this exact clamp on
    // the sibling read at 2,171 rows.
    const events = await fetchAllRows<{ size: string; quantity_delta: number }>((from, to) =>
      this.ctx.supabase
        .from('size_count_events')
        .select('id, size, quantity_delta')
        .eq('session_id', sessionId)
        // Stable paging key (fetchAllRows header): without it the same event
        // can land on two windows and be counted twice.
        .order('id')
        .range(from, to),
    );

    const bySize = new Map<string, number>();
    for (const row of events) {
      bySize.set(row.size, (bySize.get(row.size) ?? 0) + row.quantity_delta);
    }
    const tally = Array.from(bySize.entries())
      .map(([size, quantity]) => ({ size, quantity }))
      .filter((t) => t.quantity !== 0);

    const row = session as unknown as SizeCountSessionRow;
    return { session: row, tally, group: await this.groupContext(row.product_group_id) };
  }
}

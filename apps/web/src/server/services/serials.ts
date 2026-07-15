import 'server-only';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

/**
 * The 6 lifecycle statuses a registered serial can be in — mirrors the
 * serial_registry.current_status CHECK constraint (migration 0015).
 */
export const SERIAL_STATUSES = [
  'available',
  'reserved',
  'damaged',
  'rejected',
  'sold',
  'rma',
] as const;
export type SerialStatus = (typeof SERIAL_STATUSES)[number];

export const SERIALS_PAGE_SIZE = 50;
/** Hard cap per add() call — keeps a single insert round-trip reasonable. */
export const MAX_SERIALS_PER_ADD = 500;
export const MAX_SERIAL_LENGTH = 128;

export interface SerialRow {
  id: string;
  serialNumber: string;
  currentStatus: SerialStatus;
  warehouseId: string;
  /** Resolved from warehouses in a second query; null if the name can't load. */
  warehouseName: string | null;
  /** Non-null ⇒ captured at PO receipt; null ⇒ manually added. */
  receiptLineId: string | null;
  createdAt: string;
}

export interface SerialsPage {
  rows: SerialRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface RawSerialRow {
  id: string;
  serial_number: string;
  current_status: SerialStatus;
  warehouse_id: string;
  receipt_line_id: string | null;
  created_at: string;
}

/**
 * Normalize a raw serial list for insertion: trim, drop empties, and
 * de-duplicate within the input while preserving first-seen order.
 */
function normalizeSerials(serialNumbers: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of serialNumbers) {
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * SerialsService — manual serial-number management for serialized items.
 *
 * Serial rows were historically ONLY written by PO receiving
 * (post_receipt_v2 → serial_registry, receipt_line_id set). This service adds
 * the manual surface: list/add/edit/delete registry rows from the item detail
 * page. RLS already permits staff+ writes (has_org_role(org,'staff') +
 * warehouse_in_org with_check — migs 0046/0140/0203), so no migration is
 * needed; the app layer gates on 'items:update' and org-verifies every id.
 */
export class SerialsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new SerialsService(await withContext());
  }

  /**
   * Org+item-scoped page of serials, newest first, 50/page with total count.
   *
   * Fail-closed READ (repo pattern): on any error, log + return an empty page
   * instead of throwing — a transient registry read must degrade the panel,
   * not crash the whole item-detail page.
   */
  async list(itemId: string, opts: { page?: number } = {}): Promise<SerialsPage> {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const from = (page - 1) * SERIALS_PAGE_SIZE;
    const to = from + SERIALS_PAGE_SIZE - 1;

    const { data, error, count } = await this.ctx.supabase
      .from('serial_registry')
      .select('id, serial_number, current_status, warehouse_id, receipt_line_id, created_at', {
        count: 'exact',
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', itemId)
      .order('created_at', { ascending: false })
      // Tie-break on id so pagination is stable when a batch-add lands many
      // rows with the same created_at timestamp.
      .order('id', { ascending: false })
      .range(from, to);

    if (error || !data) {
      console.error('[SerialsService.list] read failed:', error);
      return { rows: [], total: 0, page, pageSize: SERIALS_PAGE_SIZE };
    }

    const rows = data as unknown as RawSerialRow[];

    // Resolve warehouse names in a second (org-scoped) query. A name-lookup
    // failure degrades to null names — the serial rows still render.
    const nameById = new Map<string, string>();
    const warehouseIds = [...new Set(rows.map((r) => r.warehouse_id))];
    if (warehouseIds.length > 0) {
      const { data: whs, error: whError } = await this.ctx.supabase
        .from('warehouses')
        .select('id, name')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', warehouseIds);
      if (whError) {
        console.error('[SerialsService.list] warehouse name lookup failed:', whError);
      }
      for (const w of (whs ?? []) as Array<{ id: string; name: string }>) {
        nameById.set(w.id, w.name);
      }
    }

    return {
      rows: rows.map((r) => ({
        id: r.id,
        serialNumber: r.serial_number,
        currentStatus: r.current_status,
        warehouseId: r.warehouse_id,
        warehouseName: nameById.get(r.warehouse_id) ?? null,
        receiptLineId: r.receipt_line_id,
        createdAt: r.created_at,
      })),
      total: count ?? 0,
      page,
      pageSize: SERIALS_PAGE_SIZE,
    };
  }

  /**
   * Manually register serials for an item at a warehouse. Rows are created
   * with current_status='available' and receipt_line_id=null (the "Manual"
   * source marker — deletable later, unlike receipt-captured rows).
   */
  async add(
    itemId: string,
    warehouseId: string,
    serialNumbers: string[],
  ): Promise<{ added: number }> {
    assertPermission(this.ctx, 'items:update');

    const serials = normalizeSerials(serialNumbers);
    if (serials.length === 0) {
      throw new ServiceError('validation_error', 'Enter at least one serial number.');
    }
    if (serials.length > MAX_SERIALS_PER_ADD) {
      throw new ServiceError(
        'validation_error',
        `Add at most ${MAX_SERIALS_PER_ADD} serial numbers at a time.`,
      );
    }
    const tooLong = serials.find((s) => s.length > MAX_SERIAL_LENGTH);
    if (tooLong) {
      throw new ServiceError(
        'validation_error',
        `Serial numbers must be ${MAX_SERIAL_LENGTH} characters or fewer ("${tooLong.slice(0, 40)}…" is too long).`,
      );
    }

    // Item must belong to the caller's org and not be deleted.
    const { data: item, error: itemError } = await this.ctx.supabase
      .from('inventory_items')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', itemId)
      .is('deleted_at', null)
      .maybeSingle();
    if (itemError) throw new ServiceError('internal_error', itemError.message);
    if (!item) throw new ServiceError('not_found', 'Item not found.');

    // TENANT-ISOLATION GUARD: the warehouse must belong to the caller's org.
    // RLS's with_check (warehouse_in_org, mig 0203) would reject this anyway;
    // checking first turns an opaque RLS failure into a clear message.
    const { data: warehouse, error: whError } = await this.ctx.supabase
      .from('warehouses')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', warehouseId)
      .maybeSingle();
    if (whError) throw new ServiceError('internal_error', whError.message);
    if (!warehouse) {
      throw new ServiceError('validation_error', 'Warehouse not found in your organization.');
    }

    // Pre-check for already-registered serials so the conflict names them
    // (the raw 23505 message doesn't say WHICH serial collided).
    const { data: existing, error: existingError } = await this.ctx.supabase
      .from('serial_registry')
      .select('serial_number')
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', itemId)
      .in('serial_number', serials);
    if (existingError) throw new ServiceError('internal_error', existingError.message);
    const duplicates = ((existing ?? []) as Array<{ serial_number: string }>).map(
      (r) => r.serial_number,
    );
    if (duplicates.length > 0) {
      const shown = duplicates.slice(0, 5).join(', ');
      const more = duplicates.length > 5 ? ` (+${duplicates.length - 5} more)` : '';
      throw new ServiceError(
        'conflict',
        `Already registered for this item: ${shown}${more}. Remove the duplicate${duplicates.length === 1 ? '' : 's'} and try again.`,
        { duplicates },
      );
    }

    const { error: insertError } = await this.ctx.supabase.from('serial_registry').insert(
      serials.map((serial) => ({
        organization_id: this.ctx.organizationId,
        item_id: itemId,
        serial_number: serial,
        warehouse_id: warehouseId,
        current_status: 'available',
        receipt_line_id: null,
      })),
    );
    if (insertError) {
      // Race fallback: a serial registered between the pre-check and the
      // insert still trips UNIQUE(org, item, serial_number).
      if (insertError.code === '23505') {
        throw new ServiceError(
          'conflict',
          'One or more of those serial numbers were just registered for this item. Refresh and try again.',
        );
      }
      throw new ServiceError('internal_error', insertError.message);
    }

    await audit(
      {
        event: 'item.serials.added',
        entityType: 'inventory_item',
        entityId: itemId,
        warehouseId,
        extra: { count: serials.length },
      },
      this.ctx,
    );

    return { added: serials.length };
  }

  /**
   * Edit a serial's number and/or status.
   *
   * serialNumber edits are allowed on ALL rows — including receipt-captured
   * ones (typo correction at receiving is the whole point) — but every change
   * is audited with {from, to} so the paper trail survives the correction.
   */
  async updateSerial(
    id: string,
    patch: { serialNumber?: string; status?: string },
  ): Promise<{ id: string; itemId: string; serialNumber: string; currentStatus: SerialStatus }> {
    assertPermission(this.ctx, 'items:update');

    const updates: Record<string, unknown> = {};

    if (patch.serialNumber !== undefined) {
      const serial = patch.serialNumber.trim();
      if (!serial) {
        throw new ServiceError('validation_error', 'Serial number cannot be empty.');
      }
      if (serial.length > MAX_SERIAL_LENGTH) {
        throw new ServiceError(
          'validation_error',
          `Serial numbers must be ${MAX_SERIAL_LENGTH} characters or fewer.`,
        );
      }
      updates.serial_number = serial;
    }

    if (patch.status !== undefined) {
      if (!(SERIAL_STATUSES as readonly string[]).includes(patch.status)) {
        throw new ServiceError('validation_error', 'Invalid serial status.');
      }
      updates.current_status = patch.status;
    }

    if (Object.keys(updates).length === 0) {
      throw new ServiceError('validation_error', 'Nothing to update.');
    }

    // Org-scoped fetch FIRST — not_found before any write, and it gives us
    // the {from} side of the audit metadata.
    const { data: existing, error: fetchError } = await this.ctx.supabase
      .from('serial_registry')
      .select('id, item_id, serial_number, current_status, receipt_line_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (fetchError) throw new ServiceError('internal_error', fetchError.message);
    if (!existing) throw new ServiceError('not_found', 'Serial not found.');
    const before = existing as unknown as {
      id: string;
      item_id: string;
      serial_number: string;
      current_status: SerialStatus;
      receipt_line_id: string | null;
    };

    // Fail-open guard (recurring pattern #2): .update().eq() succeeds on 0
    // rows, so require .select().maybeSingle() to prove a row was written.
    const { data: updated, error: updateError } = await this.ctx.supabase
      .from('serial_registry')
      .update(updates)
      .eq('id', id)
      .eq('organization_id', this.ctx.organizationId)
      .select('id, item_id, serial_number, current_status')
      .maybeSingle();
    if (updateError) {
      if (updateError.code === '23505') {
        throw new ServiceError('conflict', 'That serial number already exists for this item.');
      }
      throw new ServiceError('internal_error', updateError.message);
    }
    if (!updated) throw new ServiceError('not_found', 'Serial not found.');
    const after = updated as unknown as {
      id: string;
      item_id: string;
      serial_number: string;
      current_status: SerialStatus;
    };

    await audit(
      {
        event: 'item.serial.updated',
        // entityType/entityId point at the ITEM (not the serial_registry
        // row) so this edit surfaces in the item's Activity feed
        // (ActivityService.forItem filters on entity_id = item id). The
        // serial's own id still rides along in `extra.serial_id`.
        entityType: 'inventory_item',
        entityId: before.item_id,
        before: { serialNumber: before.serial_number, status: before.current_status },
        after: { serialNumber: after.serial_number, status: after.current_status },
        extra: {
          serial_id: id,
          from: before.serial_number,
          to: after.serial_number,
          receipt_captured: before.receipt_line_id !== null,
        },
      },
      this.ctx,
    );

    return {
      id: after.id,
      itemId: after.item_id,
      serialNumber: after.serial_number,
      currentStatus: after.current_status,
    };
  }

  /**
   * Delete a MANUALLY-added serial (receipt_line_id IS NULL). Serials
   * captured at PO receipt are part of the receiving record — they must be
   * marked damaged/rejected instead of erased.
   */
  async remove(id: string): Promise<{ itemId: string }> {
    assertPermission(this.ctx, 'items:update');

    const { data: existing, error: fetchError } = await this.ctx.supabase
      .from('serial_registry')
      .select('id, item_id, serial_number, receipt_line_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (fetchError) throw new ServiceError('internal_error', fetchError.message);
    if (!existing) throw new ServiceError('not_found', 'Serial not found.');
    const row = existing as unknown as {
      id: string;
      item_id: string;
      serial_number: string;
      receipt_line_id: string | null;
    };

    if (row.receipt_line_id !== null) {
      // 'conflict' (409, true state conflict) — the ServiceError/ActionError
      // unions have no 'invalid_state' code and packages/core is out of scope
      // for this change.
      throw new ServiceError(
        'conflict',
        "Serials captured from a PO receipt can't be deleted — mark them damaged/rejected instead.",
      );
    }

    // .select().maybeSingle() proves a row was actually deleted — a 0-row
    // DELETE (concurrent double-delete, or an RLS floor above the app gate)
    // returns success with no error (recurring fail-open pattern #2).
    const { data: deleted, error: deleteError } = await this.ctx.supabase
      .from('serial_registry')
      .delete()
      .eq('id', id)
      .eq('organization_id', this.ctx.organizationId)
      .select('id')
      .maybeSingle();
    if (deleteError) throw new ServiceError('internal_error', deleteError.message);
    if (!deleted) throw new ServiceError('not_found', 'Serial not found.');

    await audit(
      {
        event: 'item.serial.deleted',
        // Same entityId rationale as updateSerial above — points at the
        // ITEM so this deletion surfaces in the item's Activity feed.
        entityType: 'inventory_item',
        entityId: row.item_id,
        before: { serialNumber: row.serial_number },
        extra: { serial_id: id },
      },
      this.ctx,
    );

    return { itemId: row.item_id };
  }
}

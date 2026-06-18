import 'server-only';

import { assertWarehouseAccess } from '@/lib/auth/warehouse';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

export type BinType =
  | 'receiving'
  | 'storage'
  | 'qa_hold'
  | 'damaged'
  | 'rejected'
  | 'shipping';

export interface BinRow {
  id: string;
  organization_id: string;
  warehouse_id: string;
  code: string;
  name: string;
  bin_type: BinType;
  is_default: boolean;
  status: 'active' | 'inactive' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface CreateBinInput {
  warehouseId: string;
  code: string;
  name: string;
  binType: BinType;
  isDefault?: boolean;
}

/**
 * B8: bin codes are referenced in URLs, labels, pick paths, and PDFs.
 * Restrict to uppercase letters, digits, dash, and underscore to keep
 * them URL-safe and visually unambiguous across fonts. Service-side
 * upper-cases the input first, so we only need to check the rest.
 */
const BIN_CODE_RE = /^[A-Z0-9_-]+$/;

export class BinsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new BinsService(await withContext());
  }

  async list(): Promise<BinRow[]> {
    // B10: keep the existing server-side sort by (warehouse_id,
    // bin_type, code). The UI already groups by warehouse with a
    // warehouse-name header, so client-side resorts by name happen in
    // the page component. Sorting by warehouse name here would require
    // a join the bins query doesn't carry today.
    const { data, error } = await this.ctx.supabase
      .from('bins')
      .select(
        'id, organization_id, warehouse_id, code, name, bin_type, is_default, status, created_at, updated_at',
      )
      .eq('organization_id', this.ctx.organizationId)
      .neq('status', 'archived')
      .order('warehouse_id')
      .order('bin_type')
      .order('code');
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as BinRow[];
  }

  /**
   * B1: org-scoped existence check for a `warehouses.id`. Without this,
   * a caller could create a bin in a warehouse that belongs to another
   * organization. RLS on `bins` only gates by `bins.organization_id`,
   * not by the referenced warehouse's org.
   */
  private async assertWarehouseBelongsToOrg(warehouseId: string): Promise<void> {
    const { data, error } = await this.ctx.supabase
      .from('warehouses')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', warehouseId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      throw new ServiceError(
        'validation_error',
        'Warehouse not found in this organization.',
      );
    }
  }

  async create(input: CreateBinInput): Promise<{ id: string }> {
    // B6: bins are physical-location admin work; `locations:manage`
    // matches the concept and is granted to manager+ (the same roles
    // the RLS policy `bins_write` already allows). Previously this
    // gated on `organization:update` which is admin-only, causing a
    // mismatch with RLS.
    assertPermission(this.ctx, 'locations:manage');

    const code = input.code.trim().toUpperCase();
    const name = input.name.trim();
    if (!code || !name) {
      throw new ServiceError('validation_error', 'Code and name are required');
    }
    // B8: validate code charset after upper-casing.
    if (!BIN_CODE_RE.test(code)) {
      throw new ServiceError(
        'validation_error',
        'Bin code can only contain letters, numbers, dashes, and underscores.',
      );
    }

    // B1: validate the referenced warehouse belongs to this org BEFORE
    // doing any writes.
    await this.assertWarehouseBelongsToOrg(input.warehouseId);
    // H4: enforce warehouse-scope access for warehouse-scoped roles.
    // `locations:manage` is org-wide, but a warehouse-scoped manager
    // shouldn't be able to spin up bins inside a warehouse they aren't
    // assigned to. Owners/admins/org-wide managers pass through unchanged.
    await assertWarehouseAccess(input.warehouseId, 'write', this.ctx);

    // B3: if marked as default, insert FIRST then call the atomic
    // `set_default_bin()` function so the clear-others + set-default
    // pair is one transaction. Previously we did the clear in the
    // application layer, leaving a window where a concurrent insert
    // could land between the two writes.
    const { data, error } = await this.ctx.supabase
      .from('bins')
      .insert({
        organization_id: this.ctx.organizationId,
        warehouse_id: input.warehouseId,
        code,
        name,
        bin_type: input.binType,
        // Insert with is_default=false; if requested, set_default_bin()
        // promotes atomically below.
        is_default: false,
        status: 'active',
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ServiceError(
          'conflict',
          `A bin with code "${code}" already exists in this warehouse.`,
        );
      }
      throw new ServiceError('internal_error', error.message);
    }
    const id = data.id as string;

    if (input.isDefault) {
      const { error: setErr } = await this.ctx.supabase.rpc(
        'set_default_bin',
        {
          p_organization_id: this.ctx.organizationId,
          p_warehouse_id: input.warehouseId,
          p_bin_type: input.binType,
          p_bin_id: id,
        },
      );
      if (setErr) {
        // If the RPC failed, the bin still exists but isn't default.
        // Surface the error so the UI can prompt the user to retry the
        // promotion; we don't roll back the insert because the bin row
        // is still useful even without default status.
        throw new ServiceError('internal_error', setErr.message);
      }
    }

    await audit(
      {
        event: 'bin.created',
        entityType: 'bin',
        entityId: id,
        warehouseId: input.warehouseId,
        after: { code, name, binType: input.binType, isDefault: !!input.isDefault },
      },
      this.ctx,
    );
    return { id };
  }

  async archive(id: string): Promise<void> {
    // B6: same permission alignment as create().
    assertPermission(this.ctx, 'locations:manage');

    // H4: warehouse-scope access — look up the bin's warehouse and refuse
    // archive if the caller is a warehouse-scoped role with no write
    // access to it. Read first (org-scoped) so we get a clean not_found
    // for cross-org or missing rows before the scope check fires.
    const { data: binRow, error: binErr } = await this.ctx.supabase
      .from('bins')
      .select('warehouse_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (binErr) throw new ServiceError('internal_error', binErr.message);
    if (!binRow) throw new ServiceError('not_found', 'Bin not found');
    await assertWarehouseAccess(
      (binRow as { warehouse_id: string }).warehouse_id,
      'write',
      this.ctx,
    );

    // B4: when archiving a bin that is currently the default for its
    // (warehouse, bin_type) pair, also flip is_default=false so the
    // partial unique index on (warehouse_id, bin_type) WHERE is_default
    // doesn't block another bin from being promoted later. Doing this
    // in a single UPDATE keeps it atomic.
    const { data: row, error } = await this.ctx.supabase
      .from('bins')
      .update({ status: 'archived', is_default: false })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // Fail closed: a 0-row update means the bin vanished between the read
    // above and the write — don't audit an archive that didn't land.
    if (!row) throw new ServiceError('not_found', 'Bin not found.');

    // B2: emit a bin.archived audit event. Previously this method had
    // no audit at all, so an archive could fly under the radar.
    await audit(
      {
        event: 'bin.archived',
        entityType: 'bin',
        entityId: id,
      },
      this.ctx,
    );
  }
}

// B5: `public.default_bin_for(uuid, text)` exists in 0018 but is not
// referenced by any application code today. Left in place — removing
// it would be a separate cleanup migration if/when we're confident no
// external script depends on it.

import 'server-only';

import { z } from 'zod';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

/**
 * Structured mailing address for a charter campus. Mirrors `WarehouseAddress`
 * (warehouses.ts) so the shipping `to_address` and the shared
 * `formatAddressLines` renderer treat both the same way. Persisted to the
 * `charters.address` jsonb column added in migration 0149.
 */
export const charterAddressSchema = z.object({
  line1: z.string().max(200).optional(),
  line2: z.string().max(200).optional(),
  city: z.string().max(120).optional(),
  region: z.string().max(120).optional(),
  postalCode: z.string().max(32).optional(),
  country: z.string().max(120).optional(),
});
export type CharterAddress = z.infer<typeof charterAddressSchema>;

export const createCharterSchema = z.object({
  name: z.string().min(1).max(120).trim(),
  code: z.string().max(32).trim().optional(),
  description: z.string().max(2000).optional(),
  notes: z.string().max(2000).optional(),
  status: z.enum(['active', 'inactive', 'archived']).default('active'),
  /** Mailing address used as the shipping destination for delivery orders. */
  address: charterAddressSchema.optional(),
  contactName: z.string().max(120).optional(),
  contactEmail: z.string().email().max(254).optional().or(z.literal('')),
  contactPhone: z.string().max(40).optional(),
});
export type CreateCharterInput = z.infer<typeof createCharterSchema>;

export const updateCharterSchema = createCharterSchema.partial();
export type UpdateCharterInput = z.infer<typeof updateCharterSchema>;

export interface CharterRow {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  notes: string | null;
  status: 'active' | 'inactive' | 'archived';
  address: CharterAddress | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  warehouse_count: number;
  user_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * Trims an address down to the non-empty fields. Returns `null` when every
 * field is blank so we persist a clean `null` (not `{}`) — keeping the
 * partial `charters_org_with_address_idx` accurate and the "missing address"
 * hint reliable.
 */
function normalizeAddress(address: CharterAddress | undefined): CharterAddress | null {
  if (!address) return null;
  const entries = Object.entries(address)
    .map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v] as const)
    .filter(([, v]) => typeof v === 'string' && v.length > 0);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries) as CharterAddress;
}

export class ChartersService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ChartersService(await withContext());
  }

  /**
   * Lists charters for the manager view. By default returns rows with
   * `status = 'active'`. When `opts.includeArchived` is true, returns
   * ONLY rows with `status = 'archived'`. Inactive rows don't appear in
   * either view by design.
   */
  async list(opts: { includeArchived?: boolean } = {}): Promise<CharterRow[]> {
    const targetStatus = opts.includeArchived ? 'archived' : 'active';
    const { data, error } = await this.ctx.supabase
      .from('charters')
      .select(
        `id, name, code, description, notes, status, created_at, updated_at,
         address, contact_name, contact_email, contact_phone,
         warehouses:warehouse_charters!charter_id (warehouse_id),
         users:user_warehouse_assignments!charter_id (user_id)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .eq('status', targetStatus)
      .order('name', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);

    return (data ?? []).map((r) => {
      const warehouses = (r as { warehouses?: unknown }).warehouses;
      const users = (r as { users?: unknown }).users;
      return {
        id: r.id as string,
        name: r.name as string,
        code: (r.code as string | null) ?? null,
        description: (r.description as string | null) ?? null,
        notes: (r.notes as string | null) ?? null,
        status: r.status as 'active' | 'inactive' | 'archived',
        address: (r.address as CharterAddress | null) ?? null,
        contact_name: (r.contact_name as string | null) ?? null,
        contact_email: (r.contact_email as string | null) ?? null,
        contact_phone: (r.contact_phone as string | null) ?? null,
        warehouse_count: Array.isArray(warehouses) ? warehouses.length : 0,
        user_count: Array.isArray(users)
          ? new Set(users.map((u) => (u as { user_id: string }).user_id)).size
          : 0,
        created_at: r.created_at as string,
        updated_at: r.updated_at as string,
      };
    });
  }

  async create(input: CreateCharterInput) {
    assertPermission(this.ctx, 'organization:update');
    const { data, error } = await this.ctx.supabase
      .from('charters')
      .insert({
        organization_id: this.ctx.organizationId,
        name: input.name,
        code: input.code ?? null,
        description: input.description ?? null,
        notes: input.notes ?? null,
        status: input.status,
        address: normalizeAddress(input.address),
        contact_name: input.contactName ?? null,
        contact_email: input.contactEmail ? input.contactEmail.toLowerCase() : null,
        contact_phone: input.contactPhone ?? null,
        created_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({ event: 'charter.created', entityType: 'charter', entityId: data.id as string, after: input }, this.ctx);
    return { id: data.id as string };
  }

  async update(id: string, patch: UpdateCharterInput) {
    assertPermission(this.ctx, 'organization:update');
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.code !== undefined) updates.code = patch.code ?? null;
    if (patch.description !== undefined) updates.description = patch.description ?? null;
    if (patch.notes !== undefined) updates.notes = patch.notes ?? null;
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.address !== undefined) updates.address = normalizeAddress(patch.address);
    if (patch.contactName !== undefined) updates.contact_name = patch.contactName ?? null;
    if (patch.contactEmail !== undefined)
      updates.contact_email = patch.contactEmail ? patch.contactEmail.toLowerCase() : null;
    if (patch.contactPhone !== undefined) updates.contact_phone = patch.contactPhone ?? null;
    const { error } = await this.ctx.supabase
      .from('charters')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({ event: 'charter.updated', entityType: 'charter', entityId: id, after: patch }, this.ctx);
  }

  async archive(id: string) {
    assertPermission(this.ctx, 'organization:update');
    const { error } = await this.ctx.supabase
      .from('charters')
      .update({ status: 'archived' })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({ event: 'charter.archived', entityType: 'charter', entityId: id }, this.ctx);
  }

  /**
   * Restore an archived charter — sets status back to 'active'. Same
   * permission gate as archive(). Restoring goes to 'active' (not
   * 'inactive') because that's the inverse of archive.
   */
  async restore(id: string) {
    assertPermission(this.ctx, 'organization:update');
    const { error } = await this.ctx.supabase
      .from('charters')
      .update({ status: 'active' })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({ event: 'charter.restored', entityType: 'charter', entityId: id }, this.ctx);
  }
}

import 'server-only';

import { z } from 'zod';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

export const createSupplierSchema = z.object({
  name: z.string().min(1).max(120).trim(),
  contactName: z.string().max(120).optional(),
  email: z.string().email().max(254).optional().or(z.literal('')),
  phone: z.string().max(40).optional(),
  website: z.string().url().optional().or(z.literal('')),
  notes: z.string().max(2000).optional(),
});
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = createSupplierSchema.partial();
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

export class SuppliersService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new SuppliersService(await withContext());
  }

  /**
   * Lists active suppliers by default. When `opts.includeArchived` is true,
   * returns ONLY archived rows (rows with `deleted_at` set). The active
   * vs. archived view is a binary toggle — there's no combined "show all"
   * mode.
   */
  async list(opts: { includeArchived?: boolean } = {}) {
    let query = this.ctx.supabase
      .from('suppliers')
      .select('id, name, contact_name, email, phone, website, notes, deleted_at, created_at, updated_at')
      .eq('organization_id', this.ctx.organizationId)
      .order('name', { ascending: true });
    query = opts.includeArchived
      ? query.not('deleted_at', 'is', null)
      : query.is('deleted_at', null);
    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return data ?? [];
  }

  async create(input: CreateSupplierInput) {
    assertPermission(this.ctx, 'suppliers:manage');
    const { data, error } = await this.ctx.supabase
      .from('suppliers')
      .insert({
        organization_id: this.ctx.organizationId,
        name: input.name,
        contact_name: input.contactName ?? null,
        email: input.email ? input.email.toLowerCase() : null,
        phone: input.phone ?? null,
        website: input.website || null,
        notes: input.notes ?? null,
      })
      .select('*')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return data;
  }

  async update(id: string, patch: UpdateSupplierInput) {
    assertPermission(this.ctx, 'suppliers:manage');
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.contactName !== undefined) updates.contact_name = patch.contactName ?? null;
    if (patch.email !== undefined) updates.email = patch.email ? patch.email.toLowerCase() : null;
    if (patch.phone !== undefined) updates.phone = patch.phone ?? null;
    if (patch.website !== undefined) updates.website = patch.website || null;
    if (patch.notes !== undefined) updates.notes = patch.notes ?? null;
    const { data, error } = await this.ctx.supabase
      .from('suppliers')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return data;
  }

  async archive(id: string) {
    assertPermission(this.ctx, 'suppliers:manage');
    const { error } = await this.ctx.supabase
      .from('suppliers')
      .update({ deleted_at: new Date().toISOString() })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    void audit({ event: 'supplier.archived', entityType: 'supplier', entityId: id }, this.ctx);
  }

  /**
   * Restore an archived supplier — flips `deleted_at` back to null so it
   * reappears in the active list. Same permission gate as archive().
   */
  async restore(id: string) {
    assertPermission(this.ctx, 'suppliers:manage');
    const { error } = await this.ctx.supabase
      .from('suppliers')
      .update({ deleted_at: null })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    void audit({ event: 'supplier.restored', entityType: 'supplier', entityId: id }, this.ctx);
  }
}

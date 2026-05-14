import 'server-only';

import { z } from 'zod';

import { audit } from './audit';
import { assertPermission, assertPlanLimit, ServiceError, withContext, type ServiceContext } from './context';

export const createLocationSchema = z.object({
  name: z.string().min(1).max(120).trim(),
  type: z.enum(['warehouse', 'room', 'shelf', 'bin', 'vehicle', 'jobsite', 'other']).optional(),
  parentId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).optional(),
});
export type CreateLocationInput = z.infer<typeof createLocationSchema>;

export const updateLocationSchema = createLocationSchema.partial();
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

export class LocationsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new LocationsService(await withContext());
  }

  /**
   * Lists active locations by default. When `opts.includeArchived` is true,
   * returns ONLY archived rows (rows with `deleted_at` set).
   */
  async list(opts: { includeArchived?: boolean } = {}) {
    let query = this.ctx.supabase
      .from('locations')
      .select('id, parent_id, name, type, notes, warehouse_id, deleted_at, created_at, updated_at')
      .eq('organization_id', this.ctx.organizationId)
      .order('name', { ascending: true });
    query = opts.includeArchived
      ? query.not('deleted_at', 'is', null)
      : query.is('deleted_at', null);
    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return data ?? [];
  }

  async create(input: CreateLocationInput) {
    assertPermission(this.ctx, 'locations:manage');
    await assertPlanLimit(this.ctx, 'locations');
    const { data, error } = await this.ctx.supabase
      .from('locations')
      .insert({
        organization_id: this.ctx.organizationId,
        name: input.name,
        type: input.type ?? null,
        parent_id: input.parentId ?? null,
        notes: input.notes ?? null,
      })
      .select('*')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return data;
  }

  async update(id: string, patch: UpdateLocationInput) {
    assertPermission(this.ctx, 'locations:manage');
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.type !== undefined) updates.type = patch.type ?? null;
    if (patch.parentId !== undefined) updates.parent_id = patch.parentId ?? null;
    if (patch.notes !== undefined) updates.notes = patch.notes ?? null;
    const { data, error } = await this.ctx.supabase
      .from('locations')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return data;
  }

  async archive(id: string) {
    assertPermission(this.ctx, 'locations:manage');
    const { error } = await this.ctx.supabase
      .from('locations')
      .update({ deleted_at: new Date().toISOString(), deleted_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    void audit({ event: 'location.archived', entityType: 'location', entityId: id }, this.ctx);
  }

  /**
   * Restore an archived location — flips `deleted_at` back to null so it
   * reappears in the active list. Same permission gate as archive().
   */
  async restore(id: string) {
    assertPermission(this.ctx, 'locations:manage');
    const { error } = await this.ctx.supabase
      .from('locations')
      .update({ deleted_at: null, deleted_by: null })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    void audit({ event: 'location.restored', entityType: 'location', entityId: id }, this.ctx);
  }
}

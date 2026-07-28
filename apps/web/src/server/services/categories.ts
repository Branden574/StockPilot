import 'server-only';

import { z } from 'zod';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

export const createCategorySchema = z.object({
  name: z.string().min(1).max(120).trim(),
  description: z.string().max(2000).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #6366f1')
    .optional(),
  parentId: z.string().uuid().nullable().optional(),
  supportsSizes: z.boolean().optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = createCategorySchema.partial();
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export class CategoriesService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new CategoriesService(await withContext());
  }

  /**
   * Lists active categories by default. When `opts.includeArchived` is true,
   * returns ONLY archived rows (rows with `deleted_at` set).
   */
  async list(opts: { includeArchived?: boolean } = {}) {
    let query = this.ctx.supabase
      .from('categories')
      // A single string literal, deliberately not built via `+` concatenation:
      // postgrest-js's select-string parser needs a literal type to resolve
      // column-by-column, and splitting this across `+` widens it to plain
      // `string` — which the parser can't narrow, so it falls back to
      // `GenericStringError` for the whole row type (surfaced everywhere this
      // service's return value is destructured, not just here).
      .select(
        'id, parent_id, name, description, color, icon, supports_sizes, public_visibility, tracking_mode, size_scale_id, default_unit_of_measure, sports_subcategory_key, deleted_at, created_at, updated_at',
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('name', { ascending: true });
    query = opts.includeArchived
      ? query.not('deleted_at', 'is', null)
      : query.is('deleted_at', null);
    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return data ?? [];
  }

  async create(input: CreateCategoryInput) {
    assertPermission(this.ctx, 'categories:manage');
    const { data, error } = await this.ctx.supabase
      .from('categories')
      .insert({
        organization_id: this.ctx.organizationId,
        name: input.name,
        description: input.description ?? null,
        color: input.color ?? null,
        parent_id: input.parentId ?? null,
        supports_sizes: input.supportsSizes ?? false,
      })
      .select('*')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    void audit(
      { event: 'category.created', entityType: 'category', entityId: data.id as string },
      this.ctx,
    );
    return data;
  }

  async update(id: string, patch: UpdateCategoryInput) {
    assertPermission(this.ctx, 'categories:manage');
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.description !== undefined) updates.description = patch.description ?? null;
    if (patch.color !== undefined) updates.color = patch.color ?? null;
    if (patch.parentId !== undefined) updates.parent_id = patch.parentId ?? null;
    if (patch.supportsSizes !== undefined) updates.supports_sizes = patch.supportsSizes;
    const { data, error } = await this.ctx.supabase
      .from('categories')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    void audit(
      {
        event: 'category.updated',
        entityType: 'category',
        entityId: id,
        extra: { changed_keys: Object.keys(updates) },
      },
      this.ctx,
    );
    return data;
  }

  async archive(id: string) {
    assertPermission(this.ctx, 'categories:manage');
    const { data: row, error } = await this.ctx.supabase
      .from('categories')
      .update({ deleted_at: new Date().toISOString(), deleted_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!row) throw new ServiceError('not_found', 'Category not found.');
    void audit({ event: 'category.archived', entityType: 'category', entityId: id }, this.ctx);
  }

  /**
   * Restore an archived category — flips `deleted_at` back to null so it
   * reappears in the active list. Same permission gate as archive().
   */
  async restore(id: string) {
    assertPermission(this.ctx, 'categories:manage');
    const { data: row, error } = await this.ctx.supabase
      .from('categories')
      .update({ deleted_at: null, deleted_by: null })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!row) throw new ServiceError('not_found', 'Category not found.');
    void audit({ event: 'category.restored', entityType: 'category', entityId: id }, this.ctx);
  }
}

import 'server-only';

import type {
  CreateProcedureCategoryInput,
  UpdateProcedureCategoryInput,
} from '@stockpilot/core';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

export interface ProcedureCategoryRow {
  id: string;
  name: string;
  color: string | null;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * ProcedureCategoriesService — per-org picklist of SOP categories
 * (Plumbing / Lighting / HVAC / …). Reads are open to org members; writes
 * gate on `organization:update` so only admins+ can rearrange the
 * taxonomy. RLS already enforces admin-only writes — this is the
 * application-layer mirror so we throw a friendly forbidden instead of
 * a raw RLS denial.
 */
export class ProcedureCategoriesService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ProcedureCategoriesService(await withContext());
  }

  /** All non-archived categories, sorted by sort_order then name. */
  async list(): Promise<ProcedureCategoryRow[]> {
    const { data, error } = await this.ctx.supabase
      .from('procedure_categories')
      .select('id, name, color, sort_order, archived_at, created_at, updated_at')
      .eq('organization_id', this.ctx.organizationId)
      .is('archived_at', null)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as ProcedureCategoryRow[];
  }

  async create(input: CreateProcedureCategoryInput): Promise<ProcedureCategoryRow> {
    assertPermission(this.ctx, 'organization:update');
    const { data, error } = await this.ctx.supabase
      .from('procedure_categories')
      .insert({
        organization_id: this.ctx.organizationId,
        name: input.name,
        color: input.color ?? null,
        sort_order: input.sortOrder ?? 0,
      })
      .select('id, name, color, sort_order, archived_at, created_at, updated_at')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ServiceError('conflict', 'A category with that name already exists');
      }
      throw new ServiceError('internal_error', error.message);
    }
    return data as ProcedureCategoryRow;
  }

  async update(id: string, patch: UpdateProcedureCategoryInput): Promise<ProcedureCategoryRow> {
    assertPermission(this.ctx, 'organization:update');
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.color !== undefined) updates.color = patch.color ?? null;
    if (patch.sortOrder !== undefined) updates.sort_order = patch.sortOrder;
    if (Object.keys(updates).length === 0) {
      const { data, error } = await this.ctx.supabase
        .from('procedure_categories')
        .select('id, name, color, sort_order, archived_at, created_at, updated_at')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', id)
        .maybeSingle();
      if (error) throw new ServiceError('internal_error', error.message);
      if (!data) throw new ServiceError('not_found', 'Category not found');
      return data as ProcedureCategoryRow;
    }
    const { data, error } = await this.ctx.supabase
      .from('procedure_categories')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id, name, color, sort_order, archived_at, created_at, updated_at')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ServiceError('conflict', 'A category with that name already exists');
      }
      throw new ServiceError('internal_error', error.message);
    }
    return data as ProcedureCategoryRow;
  }

  /**
   * Soft-delete: sets archived_at so the row stays linked to procedures.
   * Emits `category.archived` (reused across the categories family —
   * see audit.ts union) so the activity log surfaces the rename in the
   * org timeline.
   */
  async archive(id: string): Promise<void> {
    assertPermission(this.ctx, 'organization:update');
    // Only archive a live row. Re-archiving an already-archived category
    // would otherwise silently succeed but not represent a real state
    // change, so we treat it as not_found (the caller's id refers to a
    // row that isn't a live archive target).
    const { data, error } = await this.ctx.supabase
      .from('procedure_categories')
      .update({ archived_at: new Date().toISOString() })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .is('archived_at', null)
      .select('id, name')
      .single();
    if (error) {
      if (error.code === 'PGRST116') {
        throw new ServiceError(
          'not_found',
          'Category not found or already archived',
        );
      }
      throw new ServiceError('internal_error', error.message);
    }
    void audit(
      {
        event: 'category.archived',
        entityType: 'procedure_category',
        entityId: (data as { id: string }).id,
        extra: { name: (data as { name: string }).name },
      },
      this.ctx,
    );
  }
}

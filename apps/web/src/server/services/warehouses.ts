import 'server-only';

import { z } from 'zod';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

export const createWarehouseSchema = z.object({
  name: z.string().min(1).max(120).trim(),
  code: z.string().min(1).max(32).trim(),
  charterId: z.string().uuid().nullable().optional(),
  contactName: z.string().max(120).optional(),
  contactEmail: z.string().email().max(254).optional().or(z.literal('')),
  contactPhone: z.string().max(40).optional(),
  managerUserId: z.string().uuid().nullable().optional(),
  address: z
    .object({
      line1: z.string().optional(),
      line2: z.string().optional(),
      city: z.string().optional(),
      region: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    })
    .optional(),
  notes: z.string().max(2000).optional(),
  status: z.enum(['active', 'inactive', 'archived']).default('active'),
});
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;

export const updateWarehouseSchema = createWarehouseSchema.partial();
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;

export interface WarehouseRow {
  id: string;
  name: string;
  code: string;
  charter_id: string | null;
  charter_name: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  manager_user_id: string | null;
  manager_name: string | null;
  status: 'active' | 'inactive' | 'archived';
  notes: string | null;
  user_count: number;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export class WarehousesService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new WarehousesService(await withContext());
  }

  async list(): Promise<WarehouseRow[]> {
    const { data, error } = await this.ctx.supabase
      .from('warehouses')
      .select(
        `id, name, code, charter_id, contact_name, contact_email, contact_phone,
         manager_user_id, status, notes, created_at, updated_at,
         charter:charters!charter_id (name),
         manager:user_profiles!manager_user_id (full_name, email),
         assignments:user_warehouse_assignments!warehouse_id (user_id),
         items:inventory_items!warehouse_id (id)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .neq('status', 'archived')
      .order('name', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);

    return (data ?? []).map((r) => {
      const ch = (r as { charter?: unknown }).charter;
      const charter = Array.isArray(ch) ? ch[0] : ch;
      const mg = (r as { manager?: unknown }).manager;
      const manager = Array.isArray(mg) ? mg[0] : mg;
      const assignments = (r as { assignments?: unknown }).assignments;
      const items = (r as { items?: unknown }).items;
      const userIds = Array.isArray(assignments)
        ? new Set(assignments.map((a) => (a as { user_id: string }).user_id)).size
        : 0;
      return {
        id: r.id as string,
        name: r.name as string,
        code: r.code as string,
        charter_id: (r.charter_id as string | null) ?? null,
        charter_name: (charter as { name?: string } | null)?.name ?? null,
        contact_name: (r.contact_name as string | null) ?? null,
        contact_email: (r.contact_email as string | null) ?? null,
        contact_phone: (r.contact_phone as string | null) ?? null,
        manager_user_id: (r.manager_user_id as string | null) ?? null,
        manager_name:
          (manager as { full_name?: string; email?: string } | null)?.full_name ??
          (manager as { full_name?: string; email?: string } | null)?.email ??
          null,
        status: r.status as 'active' | 'inactive' | 'archived',
        notes: (r.notes as string | null) ?? null,
        user_count: userIds,
        item_count: Array.isArray(items) ? items.length : 0,
        created_at: r.created_at as string,
        updated_at: r.updated_at as string,
      };
    });
  }

  async create(input: CreateWarehouseInput) {
    assertPermission(this.ctx, 'organization:update');
    const { data, error } = await this.ctx.supabase
      .from('warehouses')
      .insert({
        organization_id: this.ctx.organizationId,
        name: input.name,
        code: input.code,
        charter_id: input.charterId ?? null,
        contact_name: input.contactName ?? null,
        contact_email: input.contactEmail ? input.contactEmail.toLowerCase() : null,
        contact_phone: input.contactPhone ?? null,
        manager_user_id: input.managerUserId ?? null,
        address: input.address ?? null,
        notes: input.notes ?? null,
        status: input.status,
        created_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ServiceError('conflict', `A warehouse with code "${input.code}" already exists.`);
      }
      throw new ServiceError('internal_error', error.message);
    }
    await audit({
      event: 'warehouse.created',
      entityType: 'warehouse',
      entityId: data.id as string,
      warehouseId: data.id as string,
      after: input,
    });
    return { id: data.id as string };
  }

  async update(id: string, patch: UpdateWarehouseInput) {
    assertPermission(this.ctx, 'organization:update');
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.code !== undefined) updates.code = patch.code;
    if (patch.charterId !== undefined) updates.charter_id = patch.charterId ?? null;
    if (patch.contactName !== undefined) updates.contact_name = patch.contactName ?? null;
    if (patch.contactEmail !== undefined)
      updates.contact_email = patch.contactEmail ? patch.contactEmail.toLowerCase() : null;
    if (patch.contactPhone !== undefined) updates.contact_phone = patch.contactPhone ?? null;
    if (patch.managerUserId !== undefined) updates.manager_user_id = patch.managerUserId ?? null;
    if (patch.address !== undefined) updates.address = patch.address ?? null;
    if (patch.notes !== undefined) updates.notes = patch.notes ?? null;
    if (patch.status !== undefined) updates.status = patch.status;
    const { error } = await this.ctx.supabase
      .from('warehouses')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({
      event: 'warehouse.updated',
      entityType: 'warehouse',
      entityId: id,
      warehouseId: id,
      after: patch,
    });
  }

  async archive(id: string) {
    assertPermission(this.ctx, 'organization:update');
    const { error } = await this.ctx.supabase
      .from('warehouses')
      .update({ status: 'archived' })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({ event: 'warehouse.archived', entityType: 'warehouse', entityId: id, warehouseId: id });
  }
}

import 'server-only';

import {
  CUSTOM_FIELD_TYPES,
  RESERVED_CUSTOM_FIELD_KEYS,
  isSnakeCaseKey,
  type CustomFieldDefinition,
  type CustomFieldOption,
  type CustomFieldType,
} from '@stockpilot/core';

// Re-export the canonical reserved-key set so existing importers (server
// action, tests) keep their import path working. The single source of truth
// lives in @stockpilot/core/customization/custom-fields.
export { RESERVED_CUSTOM_FIELD_KEYS };

import { ServiceError, withContext, type ServiceContext } from './context';

type CustomFieldEntity = 'item';

/** A row from `custom_field_definitions` as returned by PostgREST. */
interface CustomFieldDefinitionRow {
  id: string;
  organization_id: string;
  entity: string;
  field_key: string;
  label: string;
  field_type: string;
  options: unknown;
  required: boolean;
  sort_order: number;
  archived: boolean;
}

export interface CreateCustomFieldInput {
  entity?: CustomFieldEntity;
  fieldKey: string;
  label: string;
  fieldType: CustomFieldType;
  options?: CustomFieldOption[] | null;
  required?: boolean;
  sortOrder?: number;
}

export interface UpdateCustomFieldInput {
  label?: string;
  fieldType?: CustomFieldType;
  options?: CustomFieldOption[] | null;
  required?: boolean;
  sortOrder?: number;
}

function mapRow(row: CustomFieldDefinitionRow): CustomFieldDefinition {
  return {
    id: row.id,
    organizationId: row.organization_id,
    entity: (row.entity as 'item') ?? 'item',
    fieldKey: row.field_key,
    label: row.label,
    fieldType: row.field_type as CustomFieldType,
    options: normalizeOptions(row.options),
    required: !!row.required,
    sortOrder: row.sort_order ?? 0,
    archived: !!row.archived,
  };
}

/** Coerce stored jsonb options into a clean {value,label}[] or null. */
function normalizeOptions(raw: unknown): CustomFieldOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CustomFieldOption[] = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const value = (o as { value?: unknown }).value;
    const label = (o as { label?: unknown }).label;
    if (typeof value !== 'string') continue;
    out.push({ value, label: typeof label === 'string' && label.length > 0 ? label : value });
  }
  return out;
}

/**
 * Per-org registry of typed custom field definitions for items. Org-scoped via
 * the request `ServiceContext` (RLS-bound supabase client) and permission-gated:
 * reads require org membership, writes require owner/admin.
 *
 * The validation of field_key / type / options is enforced AUTHORITATIVELY in
 * the server action (zod) before these methods are reached; this service is the
 * data layer + the admin permission backstop.
 */
export class CustomFieldsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new CustomFieldsService(await withContext());
  }

  /**
   * List definitions for an entity. By default ACTIVE definitions only (for
   * forms); pass `{ includeArchived: true }` for the settings editor.
   */
  async listDefinitions(
    entity: CustomFieldEntity = 'item',
    opts: { includeArchived?: boolean } = {},
  ): Promise<CustomFieldDefinition[]> {
    let query = this.ctx.supabase
      .from('custom_field_definitions')
      .select(
        'id, organization_id, entity, field_key, label, field_type, options, required, sort_order, archived',
      )
      .eq('organization_id', this.ctx.organizationId)
      .eq('entity', entity);
    if (!opts.includeArchived) query = query.eq('archived', false);
    query = query.order('sort_order', { ascending: true }).order('label', { ascending: true });

    const { data, error } = await query;
    // Fail CLOSED on a READ error: mirror getModulesForRequest
    // (lib/dashboard/request-cache.ts) — log and return a safe default
    // ([]) instead of throwing. The `custom_field_definitions` table may be
    // missing (migration 0159 not applied: deploy-before-migrate, rollback,
    // preview branches, fresh/local/CI DBs) or any read may transiently fail.
    // Throwing here would crash EVERY page that lists definitions (item
    // create/edit/detail, books create/edit, rentals new, the settings page)
    // AND the item create/update WRITE path (InventoryService
    // .assertCustomFieldsValid calls this). Every caller tolerates [] (no
    // custom fields shown / validation skipped), so [] is the safe floor.
    // Writes (createDefinition/updateDefinition/archiveDefinition) still throw.
    if (error) {
      console.error('[CustomFieldsService.listDefinitions] read failed:', error);
      return [];
    }
    return ((data ?? []) as CustomFieldDefinitionRow[]).map(mapRow);
  }

  /** Owner/admin only. Creates a new definition. */
  async createDefinition(input: CreateCustomFieldInput): Promise<CustomFieldDefinition> {
    this.assertAdmin();
    const entity: CustomFieldEntity = input.entity ?? 'item';

    // Defense in depth (the action validates first): reject reserved keys,
    // bad key shape, and unknown types here too so a direct service caller
    // can't bypass the action's gate.
    if (!isSnakeCaseKey(input.fieldKey)) {
      throw new ServiceError('validation_error', 'Field key must be snake_case.');
    }
    if (RESERVED_CUSTOM_FIELD_KEYS.has(input.fieldKey)) {
      throw new ServiceError('validation_error', 'That field key is reserved.');
    }
    if (!CUSTOM_FIELD_TYPES.includes(input.fieldType)) {
      throw new ServiceError('validation_error', 'Unknown field type.');
    }
    const options = input.fieldType === 'select' ? normalizeOptions(input.options) : null;
    if (input.fieldType === 'select' && (!options || options.length === 0)) {
      throw new ServiceError('validation_error', 'Select fields need at least one option.');
    }

    const { data, error } = await this.ctx.supabase
      .from('custom_field_definitions')
      .insert({
        organization_id: this.ctx.organizationId,
        entity,
        field_key: input.fieldKey,
        label: input.label,
        field_type: input.fieldType,
        options,
        required: input.required ?? false,
        sort_order: input.sortOrder ?? 0,
        archived: false,
      })
      .select(
        'id, organization_id, entity, field_key, label, field_type, options, required, sort_order, archived',
      )
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ServiceError('conflict', 'A field with that key already exists.');
      }
      throw new ServiceError('internal_error', error.message);
    }
    return mapRow(data as CustomFieldDefinitionRow);
  }

  /**
   * Owner/admin only. Updates label/type/options/required/sort_order. The
   * field_key + entity are immutable (they're the jsonb contract with existing
   * item rows), so they're intentionally not patchable.
   */
  async updateDefinition(
    id: string,
    patch: UpdateCustomFieldInput,
  ): Promise<CustomFieldDefinition> {
    this.assertAdmin();

    const updates: Record<string, unknown> = {};
    if (patch.label !== undefined) updates.label = patch.label;
    if (patch.required !== undefined) updates.required = patch.required;
    if (patch.sortOrder !== undefined) updates.sort_order = patch.sortOrder;

    // Type + options move together: if the type changes to/from select, the
    // options must be consistent. Resolve the effective type to decide.
    if (patch.fieldType !== undefined) {
      if (!CUSTOM_FIELD_TYPES.includes(patch.fieldType)) {
        throw new ServiceError('validation_error', 'Unknown field type.');
      }
      updates.field_type = patch.fieldType;
    }
    if (patch.fieldType !== undefined || patch.options !== undefined) {
      const effectiveType = patch.fieldType ?? (await this.requireType(id));
      if (effectiveType === 'select') {
        const options = normalizeOptions(patch.options);
        if (!options || options.length === 0) {
          throw new ServiceError('validation_error', 'Select fields need at least one option.');
        }
        updates.options = options;
      } else {
        updates.options = null;
      }
    }

    if (Object.keys(updates).length === 0) {
      // Nothing to change — return the current row.
      return this.requireDefinition(id);
    }

    const { data, error } = await this.ctx.supabase
      .from('custom_field_definitions')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select(
        'id, organization_id, entity, field_key, label, field_type, options, required, sort_order, archived',
      )
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return mapRow(data as CustomFieldDefinitionRow);
  }

  /**
   * Owner/admin only. Soft-archive (never hard delete — existing item rows may
   * still carry the key's data). Archived defs are hidden from forms but shown
   * in the settings editor for un-archive.
   */
  async archiveDefinition(id: string, archived = true): Promise<CustomFieldDefinition> {
    this.assertAdmin();
    const { data, error } = await this.ctx.supabase
      .from('custom_field_definitions')
      .update({ archived })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select(
        'id, organization_id, entity, field_key, label, field_type, options, required, sort_order, archived',
      )
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return mapRow(data as CustomFieldDefinitionRow);
  }

  private async requireDefinition(id: string): Promise<CustomFieldDefinition> {
    const { data, error } = await this.ctx.supabase
      .from('custom_field_definitions')
      .select(
        'id, organization_id, entity, field_key, label, field_type, options, required, sort_order, archived',
      )
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Custom field not found.');
    return mapRow(data as CustomFieldDefinitionRow);
  }

  private async requireType(id: string): Promise<CustomFieldType> {
    const def = await this.requireDefinition(id);
    return def.fieldType;
  }

  /**
   * Config tables are admin-managed. Mirror the action's gates inside the
   * service so a non-admin (or AAL1-in-mfa-required-org) caller is rejected
   * even if a future caller forgets to gate. Fail CLOSED on the MFA gate,
   * matching the central `assertPermission` ordering (MFA first, then role).
   */
  private assertAdmin(): void {
    if (this.ctx.mfaRequired && !this.ctx.mfaSatisfied) {
      throw new ServiceError(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
        { reason: 'mfa_required' },
      );
    }
    if (this.ctx.role !== 'owner' && this.ctx.role !== 'admin') {
      throw new ServiceError('forbidden', 'Only owners and admins can manage custom fields.');
    }
  }
}

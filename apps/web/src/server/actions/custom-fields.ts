'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';
import {
  CustomFieldsService,
  RESERVED_CUSTOM_FIELD_KEYS,
} from '@/server/services/custom-fields';

import {
  CUSTOM_FIELD_TYPES,
  err,
  isSnakeCaseKey,
  ok,
  type ActionResult,
  type CustomFieldDefinition,
} from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Server-side validation — AUTHORITATIVE. Mirrors nav/module/dashboard
// settings actions: validate cheaply BEFORE touching context, then
// withContext() → MFA gate (fail CLOSED) → owner/admin gate → mutate → audit →
// revalidate. The service re-checks the role + reserved keys as defense in
// depth, but this is the trust boundary.
// ---------------------------------------------------------------------------

const KEY_MAX = 64;
const LABEL_MAX = 60;
const OPTION_MAX = 60;
const MAX_OPTIONS = 100;
const SORT_MAX = 100000;

const typeSchema = z.enum(CUSTOM_FIELD_TYPES as unknown as [string, ...string[]]);

const optionSchema = z.object({
  value: z.string().min(1).max(OPTION_MAX),
  label: z.string().min(1).max(OPTION_MAX),
});

const fieldKeySchema = z
  .string()
  .min(1)
  .max(KEY_MAX)
  .refine((k) => isSnakeCaseKey(k), 'Field key must be snake_case (e.g. "warranty_months").')
  .refine((k) => !RESERVED_CUSTOM_FIELD_KEYS.has(k), 'That field key is reserved by the item form.');

const createSchema = z
  .object({
    fieldKey: fieldKeySchema,
    label: z.string().min(1).max(LABEL_MAX),
    fieldType: typeSchema,
    options: z.array(optionSchema).max(MAX_OPTIONS).optional().nullable(),
    required: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(SORT_MAX).optional(),
  })
  .refine(
    (v) => v.fieldType !== 'select' || (Array.isArray(v.options) && v.options.length > 0),
    { message: 'Select fields need at least one option.', path: ['options'] },
  );

const updateSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().min(1).max(LABEL_MAX).optional(),
    fieldType: typeSchema.optional(),
    options: z.array(optionSchema).max(MAX_OPTIONS).optional().nullable(),
    required: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(SORT_MAX).optional(),
  })
  .refine(
    (v) => v.fieldType !== 'select' || (Array.isArray(v.options) && v.options.length > 0),
    { message: 'Select fields need at least one option.', path: ['options'] },
  );

const archiveSchema = z.object({
  id: z.string().uuid(),
  archived: z.boolean().optional(),
});

type CreateInput = z.infer<typeof createSchema>;
type UpdateInput = z.infer<typeof updateSchema>;
type ArchiveInput = z.infer<typeof archiveSchema>;

function revalidate(): void {
  revalidatePath('/dashboard', 'layout');
  revalidatePath('/dashboard/settings/custom-fields');
}

/** Owner/admin only. Create a new item custom field definition. */
export async function createCustomFieldAction(
  input: CreateInput,
): Promise<ActionResult<{ definition: CustomFieldDefinition }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid custom field.');
  }

  try {
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      return err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      );
    }
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only owners and admins can manage custom fields.');
    }

    const service = new CustomFieldsService(ctx);
    const definition = await service.createDefinition({
      entity: 'item',
      fieldKey: parsed.data.fieldKey,
      label: parsed.data.label,
      fieldType: parsed.data.fieldType as CustomFieldDefinition['fieldType'],
      options: parsed.data.fieldType === 'select' ? (parsed.data.options ?? []) : null,
      required: parsed.data.required ?? false,
      sortOrder: parsed.data.sortOrder ?? 0,
    });

    await audit({
      event: 'custom_field_definition.created',
      entityType: 'custom_field_definition',
      entityId: definition.id,
      after: definition,
    });

    revalidate();
    return ok({ definition });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

/** Owner/admin only. Update label/type/options/required/sort_order. */
export async function updateCustomFieldAction(
  input: UpdateInput,
): Promise<ActionResult<{ definition: CustomFieldDefinition }>> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid custom field.');
  }

  try {
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      return err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      );
    }
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only owners and admins can manage custom fields.');
    }

    const service = new CustomFieldsService(ctx);
    const { id, ...patch } = parsed.data;
    const definition = await service.updateDefinition(id, {
      label: patch.label,
      fieldType: patch.fieldType as CustomFieldDefinition['fieldType'] | undefined,
      options: patch.options ?? undefined,
      required: patch.required,
      sortOrder: patch.sortOrder,
    });

    await audit({
      event: 'custom_field_definition.updated',
      entityType: 'custom_field_definition',
      entityId: definition.id,
      after: definition,
    });

    revalidate();
    return ok({ definition });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

/** Owner/admin only. Soft-archive (or un-archive) a definition. */
export async function archiveCustomFieldAction(
  input: ArchiveInput,
): Promise<ActionResult<{ definition: CustomFieldDefinition }>> {
  const parsed = archiveSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid request.');
  }

  try {
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      return err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      );
    }
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only owners and admins can manage custom fields.');
    }

    const archived = parsed.data.archived ?? true;
    const service = new CustomFieldsService(ctx);
    const definition = await service.archiveDefinition(parsed.data.id, archived);

    await audit({
      event: 'custom_field_definition.archived',
      entityType: 'custom_field_definition',
      entityId: definition.id,
      after: { archived: definition.archived },
    });

    revalidate();
    return ok({ definition });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

'use server';

import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';
import {
  parseSharedPresetConfig,
  type SharedExportPresetConfig,
} from '@/lib/exports/preset-config';

import { can, err, ok, type ActionResult } from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Org-shared Export Builder presets (export_presets, migration 0338).
//
// Every read and write goes through ctx.supabase (USER-authed): RLS is the
// floor — member SELECT, items:export INSERT, creator-or-admin DELETE — and
// the action-level gates below mirror it so refusals arrive as words instead
// of silent 0-row no-ops. Both mutating writes are proven by the RETURNED
// ROW, never by the absence of an error (pattern #22: .update()/.delete()
// under RLS "succeed" with 0 rows).
//
// THE STORED CONFIG IS CLIENT-INFLUENCED DATA, in both directions:
//   save — parseSharedPresetConfig re-validates against the live registry
//     and REFUSES anything it had to drop (a real dialog only produces known
//     field keys; unknowns here are a forged request).
//   list — the same parser runs on every stored row; unknown field ids are
//     dropped and REPORTED per-preset so the dialog shows a visible note.
// PERMISSION-GATED FIELDS ARE DELIBERATELY NOT FILTERED HERE. The only field
// permission gate is resolveExportFields, which POST /api/inventory/export
// runs against the CURRENT user on every export — a preset's field list rides
// the request's `fields` array straight into it. Filtering at load would be
// a second gate that drifts from the real one.
//
// DEPLOY-ORDER SAFETY (code before migration 0338): a missing table is
// Postgres 42P01 through PostgREST. list maps it to { available: false } —
// the dialog simply doesn't grow the presets UI — and save/delete surface a
// humane "not available yet" error. Today's export behaviour is untouched.
// ---------------------------------------------------------------------------

const MISSING_TABLE = '42P01';
const UNIQUE_VIOLATION = '23505';

const DUPLICATE_NAME_MESSAGE =
  'A preset with this name already exists in your organization. Delete it first, or pick another name.';
const UNAVAILABLE_MESSAGE = 'Shared presets are not available yet. Try again after the next update.';

export interface SharedExportPresetDto {
  id: string;
  name: string;
  createdBy: string | null;
  createdAt: string;
  /** null = the stored config is unreadable (out-of-band write): the preset
   *  cannot be applied, only deleted. */
  config: SharedExportPresetConfig | null;
  /** Field ids the current registry no longer knows — the dialog owes the
   *  user a visible note when this is non-empty. */
  droppedFieldKeys: string[];
  /** Whether the CURRENT user may delete this preset (creator or admin) —
   *  mirrors the RLS delete policy so the UI never offers a dead button. */
  canDelete: boolean;
}

export interface ListSharedExportPresetsResult {
  /** false = the table does not exist yet (code-before-migration window):
   *  render the dialog exactly as it is today, no presets UI at all. */
  available: boolean;
  presets: SharedExportPresetDto[];
}

interface PresetRow {
  id: string;
  name: string;
  config: unknown;
  created_by: string | null;
  created_at: string;
}

function isMissingTable(error: { code?: string | null } | null): boolean {
  return error?.code === MISSING_TABLE;
}

export async function listSharedExportPresetsAction(): Promise<
  ActionResult<ListSharedExportPresetsResult>
> {
  try {
    const ctx = await withContext();
    // The one consumer is the export dialog, which items:export gates —
    // matching the save gate keeps a non-exporter from probing the list.
    // (RLS SELECT itself stays member-wide; this is the action's gate.)
    if (!can(ctx, 'items:export')) {
      return err('forbidden', 'You do not have permission to export items.');
    }

    const { data, error } = await ctx.supabase
      .from('export_presets')
      .select('id, name, config, created_by, created_at')
      .eq('organization_id', ctx.organizationId)
      .order('name', { ascending: true });
    if (error) {
      if (isMissingTable(error)) return ok({ available: false, presets: [] });
      throw new ServiceError('internal_error', error.message);
    }

    const isAdmin = ctx.role === 'owner' || ctx.role === 'admin';
    const presets = ((data ?? []) as PresetRow[]).map((row): SharedExportPresetDto => {
      const parsed = parseSharedPresetConfig(row.config);
      return {
        id: row.id,
        name: row.name,
        createdBy: row.created_by,
        createdAt: row.created_at,
        config: parsed.ok ? parsed.config : null,
        droppedFieldKeys: parsed.ok ? parsed.droppedFieldKeys : [],
        canDelete: isAdmin || (row.created_by !== null && row.created_by === ctx.userId),
      };
    });

    return ok({ available: true, presets });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export interface SaveSharedExportPresetInput {
  name: string;
  config: SharedExportPresetConfig;
}

export async function saveSharedExportPresetAction(
  input: SaveSharedExportPresetInput,
): Promise<ActionResult<SharedExportPresetDto>> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0 || name.length > 60) {
    return err('validation_error', 'Preset names are 1 to 60 characters.');
  }
  // Re-validate through the SAME parser every reader runs — never trust the
  // client's config object. At save time, anything the parser would drop is
  // a refusal, not a repair: the live dialog cannot produce unknown fields.
  const parsed = parseSharedPresetConfig(input.config);
  if (!parsed.ok) {
    return err('validation_error', parsed.reason);
  }
  if (parsed.droppedFieldKeys.length > 0) {
    return err(
      'validation_error',
      `Unknown export fields cannot be saved: ${parsed.droppedFieldKeys.join(', ')}.`,
    );
  }
  if (parsed.config.fieldKeys.length === 0) {
    return err('validation_error', 'Choose at least one field before saving a preset.');
  }

  try {
    const ctx = await withContext();
    // The exact permission the export route checks (items:export), mirrored
    // by the RLS insert policy — one gate, stated twice, drifting never.
    if (!can(ctx, 'items:export')) {
      return err('forbidden', 'You do not have permission to export items.');
    }

    const { data, error } = await ctx.supabase
      .from('export_presets')
      .insert({
        organization_id: ctx.organizationId,
        name,
        config: parsed.config,
        created_by: ctx.userId,
      })
      .select('id, name, config, created_by, created_at')
      .maybeSingle();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return err('conflict', DUPLICATE_NAME_MESSAGE);
      if (isMissingTable(error)) return err('validation_error', UNAVAILABLE_MESSAGE);
      throw new ServiceError('internal_error', error.message);
    }
    // Insert is proven by the returned row (pattern #22 posture; with RLS an
    // insert violation raises, but the returned row is the proof either way).
    if (!data) {
      throw new ServiceError('forbidden', 'Your role cannot save shared presets.');
    }
    const row = data as PresetRow;

    await audit({
      event: 'export_preset.saved',
      entityType: 'export_preset',
      entityId: row.id,
      // The full stored config: a preset that later looks wrong is
      // attributable to the exact save that wrote it.
      after: {
        name,
        itemTypeKind: parsed.config.itemTypeKind,
        fieldKeys: parsed.config.fieldKeys,
        format: parsed.config.format ?? null,
      },
    });

    return ok({
      id: row.id,
      name: row.name,
      createdBy: row.created_by,
      createdAt: row.created_at,
      config: parsed.config,
      droppedFieldKeys: [],
      canDelete: true,
    });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function deleteSharedExportPresetAction(input: {
  id: string;
}): Promise<ActionResult<{ id: string }>> {
  if (typeof input.id !== 'string' || input.id.length === 0) {
    return err('validation_error', 'Missing preset id.');
  }
  try {
    const ctx = await withContext();
    if (!can(ctx, 'items:export')) {
      return err('forbidden', 'You do not have permission to export items.');
    }

    // RLS is the authority on WHO may delete (creator or admin). The proof of
    // deletion is the RETURNED ROW: under RLS a refused delete "succeeds"
    // with 0 rows (pattern #22), which must surface as a refusal, never as
    // silence.
    const { data, error } = await ctx.supabase
      .from('export_presets')
      .delete()
      .eq('id', input.id)
      .eq('organization_id', ctx.organizationId)
      .select('id, name, config, created_by, created_at')
      .maybeSingle();
    if (error) {
      if (isMissingTable(error)) return err('validation_error', UNAVAILABLE_MESSAGE);
      throw new ServiceError('internal_error', error.message);
    }
    if (!data) {
      return err(
        'forbidden',
        'This preset was not deleted. It may already be gone, or it belongs to someone else and you are not an admin.',
      );
    }
    const row = data as PresetRow;

    await audit({
      event: 'export_preset.deleted',
      entityType: 'export_preset',
      entityId: row.id,
      // What was removed — delete is the only way a shared preset ever
      // changes, so this row is the whole history of the change.
      before: { name: row.name, createdBy: row.created_by, config: row.config },
    });

    return ok({ id: row.id });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

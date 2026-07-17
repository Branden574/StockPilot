'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { assertPermission, ServiceError, withContext } from '@/server/services/context';
import { audit } from '@/server/services/audit';

import { err, ok, type ActionResult } from '@stockpilot/core';

/**
 * Edit (or add) the free-text note on a single stock movement.
 *
 * The stock_movements ledger is append-only: the ONLY mutable column is
 * `notes`, and it's mutated exclusively through the SECURITY DEFINER RPC
 * `edit_movement_note` (mig 0274), which re-asserts the same
 * manager-or-`movements:edit_notes` gate in SQL and raises `insufficient_
 * privilege` (42501) otherwise. This action is the web entry point: it
 * app-gates first (fast, override-aware, MFA-aware — the twin of the SQL
 * gate) and then writes an audit_logs row keyed to the movement's ITEM so
 * the change surfaces on the item Activity feed AND the global audit log.
 */
const editMovementNoteSchema = z.object({
  movementId: z.string().uuid(),
  // The RPC also caps length (<=2000) and trims/nullifies; validate here too
  // so an oversized payload never reaches the DB. Empty string is allowed —
  // it clears the note (the RPC stores NULL for a blank/whitespace note).
  // Length is checked on the TRIMMED value so it aligns with the RPC's
  // `length(btrim(...)) > 2000` — a value that's ≤2000 after trimming isn't
  // rejected upstream while the RPC would accept it.
  note: z
    .string()
    .refine((s) => s.trim().length <= 2000, 'Note is too long (max 2000 characters).'),
});

export type EditMovementNoteInput = z.infer<typeof editMovementNoteSchema>;

export async function editMovementNoteAction(
  input: EditMovementNoteInput,
): Promise<ActionResult<{ note: string | null }>> {
  const parsed = editMovementNoteSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const { movementId, note } = parsed.data;
  // Normalize exactly as the RPC does (btrim → NULL on empty) so the value we
  // report in the audit row's `after` matches what actually landed in the DB.
  const nextNote = note.trim() ? note.trim() : null;

  try {
    const ctx = await withContext();
    // App-layer gate — override-aware (per-user grants of the FULLY_GRANTABLE
    // permission take effect) and MFA-aware, the twin of the SQL gate inside
    // the RPC. Throws ServiceError('forbidden'); the RPC re-checks regardless.
    assertPermission(ctx, 'movements:edit_notes');

    const { data, error } = await ctx.supabase.rpc('edit_movement_note', {
      p_movement_id: movementId,
      p_note: note,
    });
    if (error) {
      // The RPC raises insufficient_privilege (42501) when the SQL gate
      // rejects — surface it as a clean forbidden rather than a 500.
      if ((error as { code?: string }).code === '42501') {
        return err('forbidden', 'You do not have permission to edit movement notes.');
      }
      // 22023 = the RPC's system-managed guard: the note on a pre-0231
      // 'receipt_line' row holds a machine reference (the receipt UUID that
      // resolves the PO number), so it can never be overwritten. Surface a
      // clean validation error, not a 500.
      if ((error as { code?: string }).code === '22023') {
        return err(
          'validation_error',
          "This movement's note is managed by the system and can't be edited.",
        );
      }
      // Never leak raw DB text (S13 boundary) — log server-side, return generic.
      console.error(error);
      return err('internal_error', 'Something went wrong. Please try again.');
    }

    // Table-returning RPC → array of rows; the single row carries the movement's
    // item_id + the pre-update note (for the audit before/after).
    const row = (Array.isArray(data) ? data[0] : data) as
      | { item_id?: string | null; old_note?: string | null }
      | null
      | undefined;
    const itemId = row?.item_id ?? null;
    const oldNote = row?.old_note ?? null;

    // Key the audit row to the ITEM (entity_type=inventory_item, entity_id=
    // item_id) so it lands on the item Activity feed (which queries by
    // metadata.entity_id) as well as the global audit log. Best-effort —
    // audit() never throws to the caller.
    if (itemId) {
      await audit(
        {
          event: 'stock_movement.note_edited',
          entityType: 'inventory_item',
          entityId: itemId,
          before: { notes: oldNote },
          after: { notes: nextNote },
          reason: 'movement_note_edited',
          extra: { movement_id: movementId },
        },
        ctx,
      );
    }

    // Reflect the write on the global Movements ledger and every detail route
    // that renders the item's Activity/Movements feed.
    revalidatePath('/dashboard/movements');
    if (itemId) {
      revalidatePath(`/dashboard/inventory/${itemId}`);
      revalidatePath(`/dashboard/books/${itemId}`);
      revalidatePath(`/dashboard/rentals/items/${itemId}`);
    }
    return ok({ note: nextNote });
  } catch (e) {
    if (e instanceof ServiceError) {
      return err(e.code, e.message);
    }
    console.error(e);
    return err('internal_error', 'Something went wrong. Please try again.');
  }
}

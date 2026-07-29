import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/server/services/audit';
import { assertPermission, ServiceError, serviceErrorStatus } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile "Add / edit movement note" — the REST parity for the web
 * editMovementNoteAction (Unit 2), which runs only as a Next.js Server Action
 * bound to the browser session and so isn't a stable contract the React Native
 * Bearer client can call. This route gives it one.
 *
 * Why mobile MUST go through the RPC and not a raw client `.update()`:
 * `stock_movements` is an APPEND-ONLY ledger — it has SELECT + INSERT RLS and
 * deliberately NO UPDATE policy, so a bare `ctx.supabase.from('stock_movements')
 * .update(...)` would silently affect ZERO rows (fail-open) for every caller.
 * The single sanctioned mutation is the SECURITY DEFINER `edit_movement_note`
 * RPC (mig 0274) which (a) touches ONLY the `notes` column — quantity/type/
 * actor/timestamp are never written, preserving ledger integrity — and (b)
 * re-asserts the SAME additive gate this route asserts up front
 * (`has_org_role(org,'manager') OR has_permission(org,'movements:edit_notes')`),
 * so a member without the permission can't edit a note by hitting the DB
 * directly.
 *
 * Body: { note?: string | null } — free text, max 2000 (mirrors the RPC's own
 * length cap). null / empty / whitespace CLEARS the note (a valid edit), so the
 * stored value + the audit `after` both normalize to `trim() || null`, matching
 * the RPC's `nullif(btrim(...), '')`.
 */
const bodySchema = z.object({
  // Length is checked on the TRIMMED value so it aligns with the RPC's
  // `length(btrim(...)) > 2000` — a value that's ≤2000 after trimming isn't
  // rejected upstream while the RPC would accept it.
  note: z
    .string()
    .refine((s) => s.trim().length <= 2000, 'Note is too long (max 2000 characters).')
    .nullable()
    .optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Per-user throttle — defense-in-depth on top of the permission gate, matching
  // the transfer/restore routes (60/min is far above a human editing notes).
  const rl = await checkRateLimit(`movement-note:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many requests — slow down.' },
      {
        status: 429,
        headers: {
          'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
        },
      },
    );
  }

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'Invalid movement id.' },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }
  const rawNote = parsed.data.note ?? null;
  // Normalize to what the RPC actually stores (`nullif(btrim(...), '')`) so the
  // returned note and the audit `after` reflect the persisted value, not the raw
  // input.
  const normalized = rawNote && rawNote.trim() !== '' ? rawNote.trim() : null;

  try {
    // Fail-fast on authorization BEFORE calling the RPC — a caller without the
    // permission shouldn't even reach the DB. Throws ServiceError('forbidden')
    // → 403; the RPC re-asserts the same additive gate internally (defense in
    // depth), same relationship as transfer/stock:transfer.
    assertPermission(ctx, 'movements:edit_notes');

    const { data, error } = await ctx.supabase.rpc('edit_movement_note', {
      p_movement_id: id,
      p_note: rawNote,
    });

    if (error) {
      // 42501 = the RPC's additive-gate denial (a viewer/staff without the
      // grant, or a cross-org movement id the caller can't manage) → 403.
      if (error.code === '42501') {
        return NextResponse.json(
          { error: 'forbidden', message: 'You do not have permission to edit this note.' },
          { status: 403 },
        );
      }
      // 22023 = the RPC's system-managed guard: the note holds the receipt
      // UUID that resolves the row's PO number — a machine reference that must
      // never be overwritten. Since mig 0307 the guard keys on the note's SHAPE
      // (a bare UUID) as well as the pre-0231 `receipt_line` reason, so this
      // branch now also fires for post-0231 `PO {number}` / `receipt_reversal`
      // rows — which is exactly what stops a Bearer caller bypassing the UI's
      // refusal. Surface a clean 422 rather than a 500.
      if (error.code === '22023') {
        return NextResponse.json(
          {
            error: 'validation_error',
            message: "This movement's note is managed by the system and can't be edited.",
          },
          { status: 422 },
        );
      }
      const msg = (error.message ?? '').toLowerCase();
      // The RPC raises a bare 'movement not found' (P0001) for an unknown id.
      if (msg.includes('not found')) {
        return NextResponse.json(
          { error: 'not_found', message: 'Movement not found.' },
          { status: 404 },
        );
      }
      // Belt-and-suspenders: the body schema already caps at 2000, but map the
      // RPC's own overflow guard cleanly if it ever fires.
      if (msg.includes('note too long')) {
        return NextResponse.json(
          { error: 'validation_error', message: 'Note is too long (max 2000 characters).' },
          { status: 400 },
        );
      }
      void reportError(error, { tag: 'api.v1.movements.note' });
      return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }

    // The RPC returns `table(item_id uuid, old_note text)` — one row.
    const row = (Array.isArray(data) ? data[0] : data) as
      | { item_id?: string | null; old_note?: string | null }
      | null;
    const itemId = row?.item_id ?? null;
    const oldNote = row?.old_note ?? null;

    // Route the audit at the ITEM (entityType inventory_item / entityId item_id)
    // so it surfaces on the item Activity feed + global audit log, exactly like
    // the web action (Unit 2). Bearer/API caller MUST pass ctx or audit()'s
    // withContext() fallback throws NEXT_REDIRECT and drops the row. Only audit
    // when the RPC returned an item_id — a null entityId would write a useless,
    // unroutable audit row (matches the web action's `if (itemId)` guard).
    if (itemId) {
      await audit(
        {
          event: 'stock_movement.note_edited',
          entityType: 'inventory_item',
          entityId: itemId,
          before: { notes: oldNote },
          after: { notes: normalized },
          reason: 'movement_note_edited',
          extra: { movement_id: id },
        },
        ctx,
      );
    }

    return NextResponse.json({ ok: true, note: normalized });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.movements.note' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

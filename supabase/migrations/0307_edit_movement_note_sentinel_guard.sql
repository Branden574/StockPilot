-- 0307_edit_movement_note_sentinel_guard.sql
-- Widen edit_movement_note's system-managed guard from a legacy REASON string
-- to the note's actual SHAPE.
--
-- THE GAP. Migration 0274 refuses a note edit only when `reason = 'receipt_line'`
-- — the shape post_receipt_v2 wrote BEFORE migration 0231. Since 0231 the
-- receiving RPCs write `PO {number}` (and reverse_receipt writes
-- `receipt_reversal`) while STILL stashing the receipt UUID in `notes` as a
-- machine sentinel (0231's own header: "p_notes stays the receipt id — do not
-- change it"; current writer: 0296_post_receipt_v2_serial_optional.sql). So the
-- 0274 guard stopped matching the rows it exists to protect. Measured in prod
-- 2026-07-29 across 2 orgs: 97 movements carry a bare-UUID note, the reason test
-- covers 17, and 80 (49 `PO {number}` receipts + 31 `receipt_reversal`
-- corrections) were editable at the DATABASE boundary. That sentinel is the ONLY
-- link from those rows back to their receipt — `InventoryService.stagedWorklist`
-- resolves provenance through it — and the ledger is append-only, so an
-- overwrite is permanent.
--
-- The shipped UIs already refuse to offer the edit (packages/core's
-- `isMovementNoteEditable`), but a UI-side refusal is not a boundary: the same
-- RPC is reachable from the Bearer surface (PATCH /api/v1/movements/[id]/note)
-- and from any future client or direct PostgREST call. This closes it in the DB.
--
-- WHAT CHANGES. Exactly one condition. The guard now ALSO fires when the row's
-- CURRENT note is a bare UUID and nothing else — the same anchored shape test
-- the display layer shares (packages/core/src/inventory/movement-note-sentinel.ts,
-- `RECEIPT_NOTE_SENTINEL_RE`). `~*` mirrors that regex's `i` flag; Postgres
-- `^`/`$` are not newline-sensitive by default, matching JS's non-`m` anchors, so
-- a multi-line note is not a sentinel.
--
-- THE TRIM IS NOT `btrim(x)`. Postgres' ONE-ARGUMENT `btrim()` strips SPACES
-- ONLY, whereas the TS side trims with JS `.trim()`, which strips ALL
-- whitespace. A guard built on the one-arg form would let a sentinel padded with
-- a newline or a tab through — masked on every screen, yet overwritable over the
-- wire — which is precisely the hole this migration exists to close, reopened at
-- a smaller size. So the trim here is an explicit regexp_replace over
-- `[\s\ufeff]`, verified against every character JS `.trim()` strips: ASCII
-- whitespace (space, tab, CR, LF, FF, VT), the Unicode space separators
-- (U+00A0, U+2000-200A, U+3000, U+2028/9 — all matched by Postgres `\s` under
-- this database's ctype) and U+FEFF, which Postgres `\s` does NOT match and so
-- is named explicitly. pgTAP case (d) pins the newline/tab case so this parity
-- is asserted by a test rather than by this paragraph.
--
-- The existing `reason = 'receipt_line'` term is KEPT, deliberately: nothing that
-- is refused today may become allowed. (All 17 live receipt_line rows do carry a
-- UUID note, so the term is belt-and-braces — but the guard must not depend on a
-- coincidence about the data.)
--
-- CONTRACT PRESERVED. Same errcode (22023) and the same message text, because
-- both callers branch on `error.code === '22023'`
-- (apps/web/src/server/actions/movements.ts → validation_error;
-- apps/web/src/app/api/v1/movements/[id]/note/route.ts → HTTP 422) and the 0274
-- pgTAP suite asserts on that code. Guard ORDER is unchanged too: the permission
-- gate still runs FIRST, so a non-permitted caller still gets 42501 and never
-- learns whether the row is system-managed.
--
-- NOT CHANGED: the length cap, the single-column write, the return shape, the
-- grant. Nothing else in this function moves.
--
-- A note that is EXACTLY a bare UUID and was genuinely typed by a person becomes
-- uneditable. That is the same accepted tradeoff the display layer already
-- makes — the bytes are indistinguishable from the sentinel — and prod contains
-- no such row. A UUID *inside* a sentence is still an ordinary, editable note.

create or replace function public.edit_movement_note(p_movement_id uuid, p_note text)
returns table(item_id uuid, old_note text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org     uuid;
  v_item_id uuid;
  v_old     text;
  v_reason  text;
begin
  -- Resolve the movement's org + item + current note + reason (definer bypasses
  -- RLS). `reason` is loaded so the system-managed guard below can reject edits
  -- to pre-0231 'receipt_line' rows.
  select sm.organization_id, sm.item_id, sm.notes, sm.reason
    into v_org, v_item_id, v_old, v_reason
    from public.stock_movements sm
   where sm.id = p_movement_id;

  if not found then
    raise exception 'movement not found';
  end if;

  -- Additive permission gate — manager role OR the grantable permission. A
  -- caller who is not a member/manager of the movement's org (e.g. a cross-org
  -- movement id) fails both terms and is denied here. Checked BEFORE the
  -- system-managed guard so a non-permitted caller always gets 42501 first
  -- (never a hint that the row is a receipt_line).
  if not (
    public.has_org_role(v_org, 'manager')
    or public.has_permission(v_org, 'movements:edit_notes')
  ) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  -- System-managed guard. The receiving RPCs stash a receipt UUID in `notes` as
  -- a MACHINE reference — the ONLY link back to the receipt and therefore to the
  -- PO number (parsed by activity.ts/movements.ts/mobile movement-display).
  -- Overwriting it would permanently destroy that resolution AND the typed note
  -- would be invisible anyway (every surface masks a sentinel note).
  --
  -- Two terms, because they do not cover the same rows:
  --   * the note's SHAPE — a bare UUID and nothing else. This is what the row
  --     actually IS, so it covers every writer regardless of its reason string
  --     (the 80 post-0231 `PO {number}` / `receipt_reversal` rows included) and
  --     stops the next reason change from re-opening this hole.
  --   * reason = 'receipt_line' — the pre-0231 shape, kept so that nothing
  --     refused before this migration becomes allowed after it.
  --
  -- The trim is regexp_replace, NOT one-arg btrim(): btrim(x) strips spaces
  -- only, while the TS mask trims with JS `.trim()` (all whitespace). See the
  -- header — a sentinel padded with a newline or tab must not slip through a
  -- guard that every UI already applies.
  if v_reason = 'receipt_line'
     or regexp_replace(coalesce(v_old, ''), '^[\s\ufeff]+|[\s\ufeff]+$', '', 'g') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'movement note is system-managed and cannot be edited'
      using errcode = '22023';
  end if;

  -- Cap the note length (free text, but bounded).
  if length(btrim(coalesce(p_note, ''))) > 2000 then
    raise exception 'note too long';
  end if;

  -- The ONLY write into the append-only ledger: the notes column, nothing else.
  update public.stock_movements
     set notes = nullif(btrim(p_note), '')
   where id = p_movement_id;

  return query select v_item_id, v_old;
end;
$$;

grant execute on function public.edit_movement_note(uuid, text) to authenticated;

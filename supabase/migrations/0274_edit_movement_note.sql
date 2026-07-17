-- 0274_edit_movement_note.sql
-- Movement note editing — the ONLY sanctioned mutation path into the
-- append-only stock_movements ledger.
--
-- CONTEXT: stock_movements is APPEND-ONLY. It has SELECT + INSERT RLS policies
-- and deliberately NO UPDATE policy — that absence is how ledger immutability is
-- enforced. We do NOT add an UPDATE policy here. Instead, note edits go through
-- a single SECURITY DEFINER RPC that touches ONLY the `notes` column. The
-- quantity/type/actor/timestamp columns (previous_quantity, new_quantity,
-- quantity_change, movement_type, reference_*, item_id, user_id, created_at) are
-- never written, so the financial/audit integrity of the ledger is preserved.
--
-- PERMISSION GATE is ADDITIVE (mirrors migration 0208): a caller passes when
--   has_org_role(org,'manager') OR has_permission(org,'movements:edit_notes').
-- The has_org_role term guarantees a bad override row can never lock a manager
-- out; the has_permission term lets an admin grant a specific staff/viewer the
-- new 'movements:edit_notes' permission (role- or user-level override) and
-- revoke it later.
--
-- PARITY: role_default_permissions is the SQL mirror of ROLE_PERMISSIONS
-- (packages/core). We add the two default rows (admin + manager) that match the
-- TS map addition; pgTAP (0207 + 0274 tests) guards the parity.

-- ── 1. Default-permission mirror (admin + manager get it by default) ────────
insert into public.role_default_permissions (role, permission) values
  ('admin',   'movements:edit_notes'),
  ('manager', 'movements:edit_notes')
on conflict (role, permission) do nothing;

-- ── 2. The append-only-safe note editor ────────────────────────────────────
-- Returns the item_id (so the caller can revalidate/route the audit entry to the
-- item Activity feed) and the PRE-edit note (so the caller can record old→new in
-- the audit log). SECURITY DEFINER so it can read the row + write the single
-- notes column regardless of the (intentionally UPDATE-less) RLS on the table;
-- the additive permission gate below is the real access control.
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
begin
  -- Resolve the movement's org + item + current note (definer bypasses RLS).
  select sm.organization_id, sm.item_id, sm.notes
    into v_org, v_item_id, v_old
    from public.stock_movements sm
   where sm.id = p_movement_id;

  if not found then
    raise exception 'movement not found';
  end if;

  -- Cap the note length (free text, but bounded).
  if length(btrim(coalesce(p_note, ''))) > 2000 then
    raise exception 'note too long';
  end if;

  -- Additive permission gate — manager role OR the grantable permission. A
  -- caller who is not a member/manager of the movement's org (e.g. a cross-org
  -- movement id) fails both terms and is denied here.
  if not (
    public.has_org_role(v_org, 'manager')
    or public.has_permission(v_org, 'movements:edit_notes')
  ) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  -- The ONLY write into the append-only ledger: the notes column, nothing else.
  update public.stock_movements
     set notes = nullif(btrim(p_note), '')
   where id = p_movement_id;

  return query select v_item_id, v_old;
end;
$$;

grant execute on function public.edit_movement_note(uuid, text) to authenticated;

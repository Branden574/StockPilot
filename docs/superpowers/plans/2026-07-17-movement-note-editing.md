# Movement note editing (manager-grantable, append-only-safe, fully audited)

Base main. Owner-approved design: managers+ (via a NEW grantable permission `movements:edit_notes`) can ADD or EDIT the free-text note on a stock movement. Ledger stays append-only — only the `notes` column is mutable, via a SECURITY DEFINER RPC; quantity/type/actor/timestamp are never touched. Every edit writes an audit_logs row (old→new note, who, when) that surfaces on the item Activity feed + global audit log. Web + mobile.

## Global constraints
- Migration to prod via `supabase db push --linked` after merge (assistant). Local pgTAP needs `supabase db reset` after new migs.
- Additive permission gate (never lock a manager out): `has_org_role(org,'manager') OR has_permission(org,'movements:edit_notes')` — mirror mig 0208 pattern.
- NO Claude/Anthropic co-author trailer. Web+mobile parity. Verify live in Demo Co / L4L.
- Ledger integrity: the RPC updates ONLY `stock_movements.notes`. Never previous_quantity/new_quantity/quantity_change/movement_type/reference_*/item_id/user_id/created_at.

### Unit 1 — Foundation: permission catalog + RPC + audit event + pgTAP
- `packages/core/src/constants/permissions.ts`: add `'movements:edit_notes'` to `PERMISSIONS` array; add it to `ROLE_PERMISSIONS.manager` (admin auto-included via the ALL-except-billing filter — verify); add to `FULLY_GRANTABLE_PERMISSIONS` (so it can be granted to staff/viewer); add a `PERMISSION_META` entry (reuse an existing group like 'Inventory'; label 'Edit movement notes'; description 'Add or change the note on a stock movement. Every change is recorded in the audit log.').
- `apps/web/src/server/services/audit.ts`: add `'stock_movement.note_edited'` to the AuditEvent union. Check `apps/web/src/lib/audit/format.ts` renders it acceptably (generic fallback ok; nicer label welcome).
- Migration `supabase/migrations/0274_edit_movement_note.sql`: (a) `insert into public.role_default_permissions (role,permission) values ('admin','movements:edit_notes'),('manager','movements:edit_notes') on conflict do nothing;` (SQL mirror of the TS map). (b) `create or replace function public.edit_movement_note(p_movement_id uuid, p_note text) returns table(item_id uuid, old_note text) language plpgsql security definer set search_path=public as $$` — resolve the movement's organization_id + item_id + current notes; if not found raise; assert `has_org_role(org,'manager') or has_permission(org,'movements:edit_notes')` else raise insufficient_privilege; `update stock_movements set notes = nullif(btrim(p_note),'') where id = p_movement_id`; return item_id + the pre-update note. Cap note length (<=2000) — raise on overflow. Grant execute to authenticated.
- pgTAP `supabase/tests/0274_edit_movement_note.test.sql`: viewer WITHOUT the perm → RPC raises; viewer GRANTED the perm (user_permission_overrides) → succeeds + only notes changed (assert previous_quantity/new_quantity/movement_type/user_id/created_at all unchanged); manager → succeeds; cross-org movement → raises/no-op. BUMP the permission-count assertion in the 0207 test (+1 default rows for admin+manager = +2 role_default rows; adjust the exact count the 0207 test asserts).
- Core unit test: `hasPermission('manager','movements:edit_notes')===true`, `hasPermission('viewer',...)===false`, and it's in FULLY_GRANTABLE.

### Unit 2 — Web (action + UI)
- Server action `editMovementNoteAction({movementId, note})` in `apps/web/src/server/actions/` (movements or inventory): withContext; `assertPermission(role,'movements:edit_notes')`; call `ctx.supabase.rpc('edit_movement_note', {...})`; then `audit({event:'stock_movement.note_edited', entityType:'inventory_item', entityId: item_id, before:{notes: old_note}, after:{notes: note}, reason:'movement_note_edited', extra:{movement_id}}, ctx)` so it lands on the item Activity feed + global audit; revalidate the movements page. Return updated note.
- UI gate: pass `canEditNotes = can(role,'movements:edit_notes')` from the (server) movements page + item-detail into the client tables.
- Global Movements page (`.../dashboard/movements`): on the NOTE cell, when canEditNotes, show a subtle edit affordance (pencil / "Add note" when empty) → inline editor or small dialog → action. Everyone else read-only.
- Item-detail Movements tab (ActivityFeed movement rows): same affordance.
- Tests: action (permission denied for viewer; success path calls RPC + audit); component gate (control hidden without perm).

### Unit 3 — Mobile (endpoint + UI)
- Bearer `PATCH /api/v1/movements/[id]/note` (`withApiContext`, `assertPermission(ctx.role,'movements:edit_notes')`, same RPC + audit()). checkRateLimit.
- Mobile item-detail Movements tab MovementCard: add/edit note action gated on the permission (mobile permission hook). Optimistic update + inline error.
- Tests: endpoint (401 unauth, 403 without perm, 200 + only-notes with perm).

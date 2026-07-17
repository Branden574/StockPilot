# Movement note editing — Unit 3 (MOBILE: Bearer endpoint + UI)

Branch: `worktree-agent-a69c83bf51a30046a` (ff-merged Unit 1 `feat/movement-note-editing`
so the permission `movements:edit_notes`, the `edit_movement_note` RPC, and the
`stock_movement.note_edited` AuditEvent are present).

## What shipped

### 1. Bearer endpoint — `apps/web/src/app/api/v1/movements/[id]/note/route.ts`
`PATCH` handler mirroring the transfer/restore v1 route structure exactly:
- `withApiContext(req)` → **401** `unauthenticated` when no context.
- `checkRateLimit('movement-note:<userId>', 60, 60_000)` → **429** with `retry-after`.
- UUID-validates `params.id` → **400** on a bad id.
- Body `{ note?: string | null }` via zod, `max(2000)` → **400** on overflow (never
  reaches the DB). null/empty/whitespace CLEARS the note.
- `assertPermission(ctx, 'movements:edit_notes')` **before** the RPC → **403**
  `forbidden` (fail-fast; the RPC re-asserts the same additive gate, defense in depth).
- `ctx.supabase.rpc('edit_movement_note', { p_movement_id, p_note })` (user-authed
  client → RLS applies; RPC is SECURITY DEFINER and touches ONLY `notes`).
- Error mapping: RPC `42501` → **403**; `'movement not found'` → **404**;
  `'note too long'` → **400**; else `reportError` + **500**.
- On success `audit({ event:'stock_movement.note_edited', entityType:'inventory_item',
  entityId: item_id, before:{notes: old_note}, after:{notes: trimmed||null},
  reason:'movement_note_edited', extra:{movement_id} }, ctx)` — ctx passed so audit()
  doesn't hit the NEXT_REDIRECT withContext() fallback on the API path. Routes at the
  item → surfaces on the item Activity feed + global audit log.
- Returns `{ ok: true, note: <normalized> }`.

### 2. Mobile UI — `apps/mobile/app/item/[id].tsx`
- Gate: `canEditNotes = isManager || can({role,permissions}, 'movements:edit_notes')`
  — same additive shape as the RLS/RPC gate, using the existing effective-permission
  hook (`useEffectivePermissions`) + role, like the file's `canTransfer`/`canRestore`.
- `MovementCard` gains `canEditNotes` + `onNoteSaved` props (passed at both render
  sites — Movements tab and Activity tab). When `canEditNotes`, a subtle
  `Edit3` + "Add note"/"Edit note" affordance appears; tapping opens
  `MovementNoteModal` (bottom-sheet reusing the AdjustModal/Serials scaffolding — no
  new UI lib) with a multiline `TextInput` capped at 2000.
- Save → `api(PATCH /api/v1/movements/[id]/note, { note })`; success optimistically
  updates the card note across BOTH movement arrays via the pure `applyNoteToMovements`;
  failure shows an inline persistent error (project modal-error rule). Save disabled
  when the normalized draft equals the current note (no-op guard).
- Extracted `apps/mobile/src/lib/movement-note.ts`: `normalizeMovementNote`
  (mirrors `nullif(btrim(...),'')`), `applyNoteToMovements`, `MOVEMENT_NOTE_MAX=2000`.

### 3. Tests
- `apps/web/src/app/api/v1/movements/[id]/note/route.test.ts` — **8 tests**: 401 unauth
  (no audit); 403 viewer-without-perm (RPC never called, no audit); 200 manager +
  RPC called with right args + audit old→new + note trimmed; null clears note
  (after=null); RPC 42501→403 (no audit); RPC not-found→404; >2000 chars→400 (no RPC);
  bad uuid→400.
- `apps/mobile/src/lib/movement-note.test.ts` — **9 tests** (normalize trim/empty/null,
  cap; apply replaces-matching-only/clears/new-array/by-reference/absent-id no-op).

## Verification
- `pnpm --filter @stockpilot/web typecheck` — clean.
- `pnpm --filter @stockpilot/mobile typecheck` — clean.
- ESLint on all touched files (web route + test, mobile screen + helper + test) — clean.
- Web route test: 8/8 pass. Mobile helper test: 9/9 pass.

## Notes / concerns
- The worktree branch was created off base main (ad3b1042), NOT off Unit 1 as the brief
  stated — I fast-forward-merged `feat/movement-note-editing` in so Unit 1 is present.
- Did NOT touch packages/core, audit.ts's union, or migrations (Unit 1 owns them).
- No Claude/Anthropic co-author trailer.
- Live simulator hand-test in Demo Co still owed (owner rule) — not runnable here.

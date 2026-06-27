# Editable Device Names Implementation Plan

> **For agentic workers:** small, tightly-coupled vertical slice on top of the
> shipped Active Sessions feature (mig 0213). Implemented directly with full
> context, then verified by a multi-lens adversarial review. Spec:
> `docs/superpowers/specs/2026-06-26-editable-device-names-design.md`.

**Goal:** Let a user rename each device in the web Active Sessions list; names are
session-scoped and cascade away with their session.

**Architecture:** New `public.user_session_names` table reached only via
`auth.uid()`-scoped `SECURITY DEFINER` fns (mirrors mig 0213). `list_my_sessions`
gains a `custom_name` column; a `renameSessionAction` upserts via
`set_my_session_name`; inline edit in `active-sessions.tsx`.

**Tech Stack:** Supabase Postgres + RLS, Next.js 16 server actions, React client component.

## Global Constraints

- No `Co-Authored-By: Claude`/Anthropic trailer on any commit (owner shows only Branden574).
- Web typecheck (`pnpm -C apps/web typecheck`) must be clean before commit.
- All session-name access is `auth.uid()`-scoped in the DB; no spoofable user id from the app.
- Name is bounded to 60 chars; empty = clear; rendered as React text (no XSS).

---

### Task 1: Migration `0214_user_session_names.sql` + pgTAP

**Files:**
- Create: `supabase/migrations/0214_user_session_names.sql`
- Test: `supabase/tests/0214_user_session_names.test.sql`

Migration: create the locked table (RLS-on/no-policy, grants revoked, FK CASCADE
to `auth.sessions`), `set_my_session_name(uuid,text)` definer fn (ownership check
→ trim/clear/cap60 → upsert), and `drop`+recreate `list_my_sessions()` with a
`custom_name` column via left join. Grants: execute to `authenticated`.

pgTAP (plan 7): seed 2 users + sessions; become A → name own session appears in
`list_my_sessions().custom_name`; name B's session = no-op (returns 0); B's list
shows no name; empty clears; >60 truncates; revoke cascades the name away.

### Task 2: Service `rename()` + `customName` field

**Files:** Modify `apps/web/src/server/services/sessions.ts`

Add `custom_name` to `SessionRow`, `customName` to `SessionInfo`, map it in
`list()`, add `rename(sessionId, name)` calling rpc `set_my_session_name`.

### Task 3: `renameSessionAction`

**Files:** Modify `apps/web/src/server/actions/sessions.ts`

`renameSessionAction({ sessionId, name })`: zod (sessionId uuid, name string
max 60, empty allowed), `SessionsService.rename`, `revalidatePath`. No broadcast/audit.

### Task 4: Inline edit UI

**Files:** Modify `apps/web/src/components/settings/active-sessions.tsx`

Pencil on every row → inline input (pre-filled with customName) → Enter save /
Esc cancel / empty clears. Primary = `customName ?? label`; show `label` as
subtext when a custom name is set. `router.refresh()` after save.

### Verification

- `pnpm -C apps/web typecheck` clean.
- pgTAP `0214` green (local stack).
- Multi-lens adversarial review (RLS/cross-user, SQL security, correctness, UX/a11y).
- Ship: apply 0214 to prod (`supabase db push --linked`) + `git push origin main`.

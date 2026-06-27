# Editable Device Names — Design

**Date:** 2026-06-26
**Owner ask:** in the web Active Sessions list, let a user rename each device so they
know which device a row actually is (disambiguate two "Chrome on macOS" rows, label
a lost/known device).

## Decision (approved)

- **Scope of a name:** **session-scoped.** The custom name attaches to the
  `auth.sessions` row (one login). It persists for the life of that login
  (typically weeks) and auto-clears when the device is signed out / the session
  expires. Re-login = new session = re-name once. No client device-id plumbing,
  no mobile build. (Device-persistent naming was considered and declined as
  larger scope.)
- **Where:** web only — same Settings → Security → "Active sessions" list. No
  mobile sessions UI exists, so nothing to change there.

## Architecture

`auth.sessions` is Supabase-managed (can't add columns), so names live in a new
`public` table reached **only** through `auth.uid()`-scoped `SECURITY DEFINER`
functions — identical airtight pattern to `list_my_sessions` / `revoke_my_session`
(mig 0213). The table is not client-readable/writable (RLS on + no policies +
grants revoked); only the definer fns (running as owner) touch it.

### A. Data + access — migration `0214_user_session_names.sql`

- **Table** `public.user_session_names`:
  - `session_id uuid primary key references auth.sessions(id) on delete cascade`
    — **CASCADE**: the name dies with its session (revoke/expire) → no orphans.
  - `user_id uuid not null` — owner (for the join filter + defense in depth).
  - `name text not null` — the custom label.
  - `created_at`, `updated_at timestamptz not null default now()`.
  - `alter table … enable row level security;` with **no policies** + `revoke all
    … from public, anon, authenticated` — table is unreachable by clients.
- **`set_my_session_name(p_session_id uuid, p_name text) returns integer`** —
  `security definer`, `set search_path = auth, public`:
  - Ownership check first: `if not exists (select 1 from auth.sessions where id =
    p_session_id and user_id = auth.uid()) then return 0;` — naming a session
    that isn't yours is a silent no-op (no spoofable user id).
  - `v_name := nullif(btrim(coalesce(p_name,'')), '')`. If null → DELETE the row
    (clear → revert to auto label), return 1.
  - Cap: `if length(v_name) > 60 then v_name := left(v_name, 60)`.
  - `insert … on conflict (session_id) do update set name = excluded.name,
    updated_at = now()`. Return 1.
- **`list_my_sessions()`** gains a `custom_name text` column via
  `left join public.user_session_names n on n.session_id = s.id and n.user_id =
  s.user_id`. The OUT-column shape changes → must `drop function` first, then
  recreate (CREATE OR REPLACE can't alter return columns). Re-grant after.
- `revoke all` from public + `grant execute … to authenticated` on both fns.

### B. Service — `apps/web/src/server/services/sessions.ts`

- `SessionRow` gains `custom_name: string | null`.
- `SessionInfo` gains `customName: string | null` (keep `label` = auto-detected
  user-agent label).
- New method `rename(sessionId: string, name: string): Promise<void>` → rpc
  `set_my_session_name({ p_session_id, p_name })`.

### C. Action — `apps/web/src/server/actions/sessions.ts`

- `renameSessionAction({ sessionId, name }): Promise<ActionResult<null>>`:
  zod-validate `sessionId` (uuid) + `name` (string, max 60, `.trim()`, EMPTY
  ALLOWED = clear), call `SessionsService.rename`, `revalidatePath`.
- **No broadcast** (rename only affects your own list view). **No MFA re-confirm**
  (cosmetic). **No audit** (benign cosmetic self-action; revokes stay audited).

### D. UI — `apps/web/src/components/settings/active-sessions.tsx`

- Primary line shows **`customName ?? label`**. When a custom name is set, show
  the auto-detected `label` ("Chrome on macOS") as small subtext so the real
  device is still visible.
- A pencil/edit affordance on **every** row (incl. "This device"). Click → inline
  text input pre-filled with the current custom name → Enter saves / Esc cancels.
  Empty + save = clear. Disabled/spinner while saving; `router.refresh()` after.
- Keep MFA badge + "This device" tag + IP/last-active subline.

## Security (this is an auth-adjacent surface — must sweep)

- All access via `auth.uid()`-scoped `SECURITY DEFINER` fns; table locked
  (RLS-on/no-policy + grants revoked). A user can only name **their own**
  sessions; naming another user's session id is a no-op and reads nothing.
- `set search_path = auth, public` pinned (no shadowing). Name length-bounded
  (60) — no unbounded-write DoS. Name rendered as React text (no XSS).
- `list_my_sessions` join filters `n.user_id = s.user_id` AND the outer
  `where s.user_id = auth.uid()` — a name row can never surface on another
  user's session.

## Testing

- **pgTAP** `0214_user_session_names.test.sql`: seed 2 users + sessions; become A:
  `set_my_session_name` on own session sets a name that appears in
  `list_my_sessions().custom_name`; on B's session is a no-op (returns 0, no row,
  B sees nothing); empty name clears; length >60 is truncated; revoking the
  session cascades the name away.
- **Gate:** web typecheck. Then a multi-lens adversarial review (RLS/cross-user,
  SQL-fn security, correctness, UX/a11y, completeness).

## Non-goals

- No device-persistent naming (no client device-id). No mobile UI. No audit of
  renames. No realtime push of renames.

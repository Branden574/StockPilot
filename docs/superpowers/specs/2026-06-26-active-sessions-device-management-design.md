# Active Sessions / Device Management — Design

**Date:** 2026-06-26
**Owner ask:** in web account settings, a user should see every device/session
they're logged into and be able to **sign out** any of them (lost, unrecognized,
or a device they forgot to log out of) — as a self-service security control.

## Decisions (approved)

- **Management UI:** web only — Settings → Security → "Active sessions". It lists
  ALL of the user's sessions across every device (incl. mobile) and can sign any
  out remotely.
- **Sign-out:** one-click (no password/MFA re-confirm) — it's a defensive action
  affecting only your own sessions.
- **Realtime:** force-logout is **live** for online devices (no refresh), via the
  Broadcast mechanism already built for permission push.

## Architecture

The authoritative, revocable unit is the **Supabase `auth.sessions` row** (one
per login; carries `user_agent`, `ip`, `created_at`, `refreshed_at`, `aal`).
Deleting a row kills that session's refresh token.

### A. Data + access — migration (3 `SECURITY DEFINER` fns, `auth.uid()`-scoped)

`auth.sessions` lives in the `auth` schema (not RLS-exposed to clients), so
access goes through `SECURITY DEFINER` functions that scope to `auth.uid()` —
the **database** enforces "only your own sessions," with no service-role in the
app and no spoofable user-id parameter (mirrors `has_org_role` / `has_permission`).

- `public.list_my_sessions()` → returns the caller's `auth.sessions`:
  `id, user_agent, ip::text, created_at, refreshed_at, aal::text, not_after`,
  `where user_id = auth.uid()`, newest-active first.
- `public.revoke_my_session(p_session_id uuid)` → `delete from auth.sessions
  where id = p_session_id and user_id = auth.uid()`; returns deleted-count.
- `public.revoke_my_other_sessions(p_keep uuid)` → delete all of the caller's
  sessions except `p_keep`.
- `grant execute … to authenticated`. No new tables.

### B. Current-session identity

The user's JWT carries a `session_id` claim (decode it like the existing
`aalFromJwt` helper). Used to (1) tag "This device" in the list, and (2) pass as
`p_keep` for "sign out all other devices," and (3) let the client listener know
its own session id.

### C. Web UI — Settings → Security → "Active sessions"

- Server-loads `list_my_sessions()` via the user's RLS client. Each row renders:
  a friendly device/browser label (parsed from `user_agent`), approximate
  location (IP), "last active" (`refreshed_at`), an **MFA badge** when `aal=aal2`,
  and a **"This device"** tag on the current session.
- Per-row **Sign out** (one-click); **Sign out all other devices** button.
- Server actions `revokeSessionAction(sessionId)` / `revokeOtherSessionsAction()`
  call the rpc, then **broadcast** + audit (`security.session_revoked` →
  the existing Slack security feed) + `revalidatePath`.
- A small `user_agent` → label parser (e.g. "Chrome on macOS", "StockPilot iOS
  app") in a pure, unit-tested helper.

### D. Realtime force-logout (the "live" part)

- On revoke, the server posts to a per-user broadcast channel
  `perms`-style: `user:{userId}:sessions`, event `revoked`, payload
  `{ sessionIds?: string[], keepId?: string }`. Reuses the Broadcast REST helper
  (`lib/realtime/broadcast.ts`) — generalize it to take a channel + event +
  payload.
- A client listener subscribes to `user:{myUserId}:sessions`; on a `revoked`
  event that targets THIS device (its `session_id` ∈ `sessionIds`, or
  `≠ keepId` for the "others" case) → `supabase.auth.signOut()` + redirect to
  `/signin` + a toast "You were signed out from another device."
  - **Web:** mount in `DashboardShell` (next to `PermissionsRealtime`).
  - **Mobile:** the same listener (so signing the phone out from the web logs it
    out live). The web management UI stays web-only, but the *listener* lives on
    both platforms so any device can be killed live. Mobile is JS → OTA-able.

### E. Caveat (shown in the UI)

Revoking instantly kills the refresh token; an **online** device logs out live
via the broadcast. An **offline** device keeps its current access token until it
expires (~1h) and is locked out when it reconnects / next refresh fails. (A
global shorter JWT TTL is a separate, out-of-scope change.)

## Security (adversarial sweep — this IS a security feature)

- All listing/revoking is **DB-enforced** via `auth.uid()`; a tampered request
  can never list or revoke another user's session.
- `revoke_my_session` / `_other_sessions` are the only write paths and only
  delete `where user_id = auth.uid()`.
- The broadcast channel is non-sensitive: payload is opaque session uuids + a
  "log out" nudge; a client subscribing to another user's channel learns nothing
  and can only sign out if ITS OWN session id matches (it won't). The real
  revocation is the DB delete, not the broadcast.
- Every revoke is audited; new-device-login alerts (mig 0168) already cover the
  "someone signed in" half.

## Testing

- **pgTAP:** `list_my_sessions()` returns only the caller's rows (seed 2 users +
  sessions, become each); `revoke_my_session` deletes only the caller's session
  and is a no-op on another user's id; `revoke_my_other_sessions` keeps the
  current one.
- **vitest:** the `user_agent` → label parser.
- **manual:** log in on two browsers; sign one out from the other → confirm the
  target lands on /signin live, and the row disappears.

## Non-goals

- No mobile management UI (web-only, per decision) — only the force-logout
  listener ships to mobile.
- No global JWT-TTL change.
- No per-request token denylist (the broadcast + refresh-revocation covers it).

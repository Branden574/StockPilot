# Active Sessions / Device Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a web user see every device they're logged into (Settings → Security → "Active sessions") and sign any of them out, with online devices logged out **live** via realtime.

**Architecture:** `auth.sessions` is the revocable unit. Access goes through three `SECURITY DEFINER` SQL functions scoped to `auth.uid()` (DB-enforced "your sessions only"). A web UI lists/revokes; server actions also Broadcast a force-logout to `user:{id}:sessions`; a client listener on web + mobile signs the targeted device out instantly. Offline devices lock out within the access-token TTL.

**Tech Stack:** Next.js 16 App Router (RSC + server actions), Supabase Postgres + Auth + Realtime Broadcast, Expo/React Native, vitest, pgTAP.

## Global Constraints

- NEVER add `Co-Authored-By: Claude/Anthropic` trailers to commits (owner rule).
- Migrations are applied to prod via `supabase db push --linked` AFTER merge; next number is **0213**.
- pgTAP runs via `supabase test db` (needs `supabase migration up --local` first to apply the new migration to the running local DB).
- Reuse, don't duplicate: the Broadcast REST plumbing already exists at `apps/web/src/lib/realtime/broadcast.ts`; the JWT-claim-read pattern at `apps/web/src/lib/auth/api-context.ts` (`aalFromJwt`); the realtime-listener pattern at `apps/web/src/components/realtime/permissions-realtime.tsx` + `apps/mobile/src/lib/use-permissions-realtime.ts`.
- Server actions return `ActionResult` via `ok()` / `err()` from `@stockpilot/core`.
- All session scoping MUST be DB-enforced via `auth.uid()` — never trust a client-supplied user/session id beyond the `auth.uid()` match inside the SECURITY DEFINER functions.

---

### Task 1: Migration 0213 — `auth.uid()`-scoped session functions + pgTAP

**Files:**
- Create: `supabase/migrations/0213_user_sessions_management.sql`
- Test: `supabase/tests/0213_user_sessions_management.test.sql`

**Interfaces:**
- Produces (callable via `ctx.supabase.rpc(...)`):
  - `public.list_my_sessions()` → setof rows `(id uuid, user_agent text, ip text, created_at timestamptz, refreshed_at timestamptz, aal text, not_after timestamptz)`
  - `public.revoke_my_session(p_session_id uuid)` → `integer` (rows deleted: 0 or 1)
  - `public.revoke_my_other_sessions(p_keep_session_id uuid)` → `integer` (rows deleted)

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/0213_user_sessions_management.test.sql`:

```sql
-- pgTAP: auth.uid()-scoped session management (migration 0213).
begin;
select plan(6);

\set userA '\'c1000000-0000-0000-0000-0000000000a1\''
\set userB '\'c1000000-0000-0000-0000-0000000000b2\''
\set sessA1 '\'c1a10000-0000-0000-0000-000000000001\''
\set sessA2 '\'c1a20000-0000-0000-0000-000000000002\''
\set sessB1 '\'c1b10000-0000-0000-0000-000000000003\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:userA, 'a@sess.test', '{}'::jsonb),
  (:userB, 'b@sess.test', '{}'::jsonb);
-- Two sessions for A, one for B. created_at/refreshed_at are NOT NULL in auth.sessions.
insert into auth.sessions (id, user_id, created_at, updated_at) values
  (:sessA1, :userA, now() - interval '2 hours', now() - interval '10 min'),
  (:sessA2, :userA, now() - interval '1 hour',  now() - interval '5 min'),
  (:sessB1, :userB, now() - interval '3 hours', now() - interval '1 min');

-- Become user A.
set local "request.jwt.claim.sub" to 'c1000000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (select count(*)::int from public.list_my_sessions()),
  2,
  'list_my_sessions returns only the caller''s 2 sessions'
);
select ok(
  not exists (select 1 from public.list_my_sessions() where id = 'c1b10000-0000-0000-0000-000000000003'),
  'list_my_sessions never returns another user''s session'
);
-- Cannot revoke another user's session (no-op).
select is(
  public.revoke_my_session('c1b10000-0000-0000-0000-000000000003'),
  0,
  'revoke_my_session is a no-op on another user''s session'
);
-- Can revoke own session.
select is(
  public.revoke_my_session('c1a10000-0000-0000-0000-000000000001'),
  1,
  'revoke_my_session deletes the caller''s own session'
);
-- Revoke-others keeps the current one.
select is(
  public.revoke_my_other_sessions('c1a20000-0000-0000-0000-000000000002'),
  0,
  'revoke_my_other_sessions: nothing else left to revoke (A2 kept, A1 already gone)'
);
reset role;

-- B's session survived A's actions.
select ok(
  exists (select 1 from auth.sessions where id = 'c1b10000-0000-0000-0000-000000000003'),
  'user B''s session was never touched by user A'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/brandenvincent-walker/Developer/InventorySystem && supabase test db 2>&1 | grep -E "0213|Result:"`
Expected: FAIL — `function public.list_my_sessions() does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0213_user_sessions_management.sql`:

```sql
-- 0213_user_sessions_management.sql
-- Self-service active-session management. auth.sessions is the revocable unit
-- (one row per login; carries user_agent/ip/refreshed_at/aal). It lives in the
-- auth schema (not RLS-exposed to clients), so access goes through SECURITY
-- DEFINER functions scoped to auth.uid() — the DB enforces "only your own
-- sessions", with no service-role in the app and no spoofable id param.

create or replace function public.list_my_sessions()
returns table (
  id uuid,
  user_agent text,
  ip text,
  created_at timestamptz,
  refreshed_at timestamptz,
  aal text,
  not_after timestamptz
)
language sql
stable
security definer
set search_path = auth, public
as $$
  select s.id,
         s.user_agent,
         host(s.ip),
         s.created_at,
         s.refreshed_at::timestamptz,
         s.aal::text,
         s.not_after
  from auth.sessions s
  where s.user_id = auth.uid()
  order by s.refreshed_at desc nulls last, s.created_at desc;
$$;

create or replace function public.revoke_my_session(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = auth, public
as $$
declare
  n integer;
begin
  delete from auth.sessions
   where id = p_session_id and user_id = auth.uid();
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.revoke_my_other_sessions(p_keep_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = auth, public
as $$
declare
  n integer;
begin
  delete from auth.sessions
   where user_id = auth.uid()
     and id is distinct from p_keep_session_id;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.list_my_sessions() from public;
revoke all on function public.revoke_my_session(uuid) from public;
revoke all on function public.revoke_my_other_sessions(uuid) from public;
grant execute on function public.list_my_sessions() to authenticated;
grant execute on function public.revoke_my_session(uuid) to authenticated;
grant execute on function public.revoke_my_other_sessions(uuid) to authenticated;
```

- [ ] **Step 4: Apply locally + run the test to verify it passes**

Run:
```bash
cd /Users/brandenvincent-walker/Developer/InventorySystem
supabase migration up --local 2>&1 | grep -iE "applying|up to date"
supabase test db 2>&1 | grep -E "0213|Result:"
```
Expected: `0213_user_sessions_management.test.sql ... ok` and `Result: PASS`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0213_user_sessions_management.sql supabase/tests/0213_user_sessions_management.test.sql
git commit -m "feat(sessions): auth.uid()-scoped list/revoke session SQL fns (mig 0213)"
```

---

### Task 2: `user_agent` → friendly label parser

**Files:**
- Create: `apps/web/src/lib/auth/user-agent.ts`
- Test: `apps/web/src/lib/auth/user-agent.test.ts`

**Interfaces:**
- Produces: `parseUserAgent(ua: string | null): { browser: string; os: string; label: string }`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/auth/user-agent.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { parseUserAgent } from './user-agent';

describe('parseUserAgent', () => {
  it('parses Chrome on macOS', () => {
    const r = parseUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    );
    expect(r.browser).toBe('Chrome');
    expect(r.os).toBe('macOS');
    expect(r.label).toBe('Chrome on macOS');
  });

  it('parses Safari on iPhone', () => {
    const r = parseUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    );
    expect(r.browser).toBe('Safari');
    expect(r.os).toBe('iOS');
  });

  it('labels the native mobile app (Expo user agent)', () => {
    const r = parseUserAgent('StockPilot/1.0.2 (iPhone; iOS 17.0) Expo');
    expect(r.label).toBe('StockPilot app on iOS');
  });

  it('falls back gracefully on null / unknown', () => {
    expect(parseUserAgent(null).label).toBe('Unknown device');
    expect(parseUserAgent('weird-bot/1.0').label).toBe('Unknown browser on Unknown OS');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/lib/auth/user-agent.test.ts 2>&1 | tail -6`
Expected: FAIL — cannot find module `./user-agent`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/auth/user-agent.ts`:

```ts
/**
 * Best-effort, dependency-free user-agent → friendly label. Used by the active-
 * sessions list (and reusable elsewhere). Intentionally simple substring
 * matching — exact UA parsing is not worth a dependency for a display label.
 */
export function parseUserAgent(ua: string | null): {
  browser: string;
  os: string;
  label: string;
} {
  if (!ua || !ua.trim()) return { browser: 'Unknown', os: 'Unknown', label: 'Unknown device' };

  // The native app sends a "StockPilot/<ver> (... iOS|Android ...) Expo" UA.
  if (/StockPilot\//i.test(ua) || /Expo/i.test(ua)) {
    const os = /iPhone|iOS|iPad/i.test(ua) ? 'iOS' : /Android/i.test(ua) ? 'Android' : 'mobile';
    return { browser: 'StockPilot app', os, label: `StockPilot app on ${os}` };
  }

  const os =
    /iPhone|iPad|iOS/i.test(ua) ? 'iOS'
    : /Android/i.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
    : /Windows/i.test(ua) ? 'Windows'
    : /Linux/i.test(ua) ? 'Linux'
    : 'Unknown OS';

  const browser =
    /Edg\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
    : /Brave/i.test(ua) ? 'Brave'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Safari\//i.test(ua) ? 'Safari'
    : 'Unknown browser';

  return { browser, os, label: `${browser} on ${os}` };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && pnpm vitest run src/lib/auth/user-agent.test.ts 2>&1 | tail -6`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/auth/user-agent.ts apps/web/src/lib/auth/user-agent.test.ts
git commit -m "feat(sessions): user-agent -> friendly label parser"
```

---

### Task 3: Sessions service (read + revoke via rpc) + current-session id helper

**Files:**
- Create: `apps/web/src/server/services/sessions.ts`
- Modify: `apps/web/src/lib/auth/api-context.ts` (export a `sessionIdFromJwt` next to `aalFromJwt`, ~line 27-38)

**Interfaces:**
- Consumes: `parseUserAgent` (Task 2); `ctx.supabase.rpc` (Task 1 functions).
- Produces:
  - `sessionIdFromJwt(token: string): string | null`
  - `class SessionsService` with:
    - `static forCurrentUser(): Promise<SessionsService>`
    - `list(currentSessionId: string | null): Promise<SessionInfo[]>` where
      `SessionInfo = { id: string; label: string; ip: string | null; lastActiveAt: string | null; createdAt: string | null; isMfa: boolean; isCurrent: boolean }`
    - `revoke(sessionId: string): Promise<void>`
    - `revokeOthers(keepSessionId: string): Promise<void>`

- [ ] **Step 1: Add `sessionIdFromJwt` to `api-context.ts`**

Add directly after the existing `aalFromJwt` function (it carries the same shape; the Supabase access token includes a `session_id` claim):

```ts
/** Reads the `session_id` claim from a Supabase access token (already validated
 *  upstream). Used to identify the caller's CURRENT auth.sessions row. */
export function sessionIdFromJwt(token: string): string | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
      session_id?: unknown;
    };
    return typeof payload.session_id === 'string' ? payload.session_id : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Write the service**

Create `apps/web/src/server/services/sessions.ts`:

```ts
import 'server-only';

import { parseUserAgent } from '@/lib/auth/user-agent';

import { ServiceError, withContext, type ServiceContext } from './context';

export interface SessionInfo {
  id: string;
  label: string;
  ip: string | null;
  lastActiveAt: string | null;
  createdAt: string | null;
  isMfa: boolean;
  isCurrent: boolean;
}

interface SessionRow {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string | null;
  refreshed_at: string | null;
  aal: string | null;
  not_after: string | null;
}

export class SessionsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser(): Promise<SessionsService> {
    return new SessionsService(await withContext());
  }

  async list(currentSessionId: string | null): Promise<SessionInfo[]> {
    const { data, error } = await this.ctx.supabase.rpc('list_my_sessions');
    if (error) throw new ServiceError('internal_error', error.message);
    const rows = (data ?? []) as SessionRow[];
    return rows.map((r) => ({
      id: r.id,
      label: parseUserAgent(r.user_agent).label,
      ip: r.ip,
      lastActiveAt: r.refreshed_at ?? r.created_at,
      createdAt: r.created_at,
      isMfa: r.aal === 'aal2',
      isCurrent: !!currentSessionId && r.id === currentSessionId,
    }));
  }

  async revoke(sessionId: string): Promise<void> {
    const { error } = await this.ctx.supabase.rpc('revoke_my_session', {
      p_session_id: sessionId,
    });
    if (error) throw new ServiceError('internal_error', error.message);
  }

  async revokeOthers(keepSessionId: string): Promise<void> {
    const { error } = await this.ctx.supabase.rpc('revoke_my_other_sessions', {
      p_keep_session_id: keepSessionId,
    });
    if (error) throw new ServiceError('internal_error', error.message);
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && pnpm typecheck 2>&1 | tail -5`
Expected: no errors. (`ctx.supabase.rpc(...)` typechecks because the generated `Database` type is `any`.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/server/services/sessions.ts apps/web/src/lib/auth/api-context.ts
git commit -m "feat(sessions): SessionsService (list/revoke via rpc) + sessionIdFromJwt"
```

---

### Task 4: Generalize the Broadcast helper

**Files:**
- Modify: `apps/web/src/lib/realtime/broadcast.ts`

**Interfaces:**
- Produces: `broadcastToChannel(topic: string, event: string, payload: Record<string, unknown>): Promise<void>`
- `broadcastPermissionsChanged` is refactored to call it (behavior unchanged).

- [ ] **Step 1: Add the generic helper + refactor**

Replace the body of `broadcastPermissionsChanged`'s `fetch(...)` with a call to a new exported `broadcastToChannel`. Final file shape:

```ts
import 'server-only';

import { env } from '@/lib/env';

/**
 * Posts a Realtime Broadcast message to a public channel (best-effort; never
 * throws). Plain pub/sub — no RLS/replica-identity/token dependency. Callers
 * carry only non-sensitive routing data in `payload`.
 */
export async function broadcastToChannel(
  topic: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ messages: [{ topic, event, payload, private: false }] }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) {
    console.error(`[broadcastToChannel ${topic}/${event}] failed (non-fatal):`, e);
  }
}

/** Permission-change ping (mig 0207+). See reference_realtime_permission_push_broadcast. */
export async function broadcastPermissionsChanged(
  organizationId: string,
  target: { role?: string; userId?: string },
): Promise<void> {
  await broadcastToChannel(`perms:${organizationId}`, 'changed', target);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && pnpm typecheck 2>&1 | tail -5`
Expected: no errors (existing callers of `broadcastPermissionsChanged` unchanged).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/realtime/broadcast.ts
git commit -m "refactor(realtime): generic broadcastToChannel; perms helper reuses it"
```

---

### Task 5: Server actions + audit event

**Files:**
- Create: `apps/web/src/server/actions/sessions.ts`
- Modify: `apps/web/src/server/services/audit.ts` (add `'security.session_revoked'` to the `AuditEvent` union, near the other `security.*` / `user.*` entries ~line 13-15)

**Interfaces:**
- Consumes: `SessionsService` (Task 3), `sessionIdFromJwt` (Task 3), `broadcastToChannel` (Task 4), `audit` (existing).
- Produces:
  - `revokeSessionAction(input: { sessionId: string }): Promise<ActionResult<null>>`
  - `revokeOtherSessionsAction(): Promise<ActionResult<{ revoked: 'others' }>>`

- [ ] **Step 1: Add the audit event**

In `apps/web/src/server/services/audit.ts`, add to the `AuditEvent` union (next to `user.password.changed`):

```ts
  | 'security.session_revoked'
```

- [ ] **Step 2: Write the actions**

Create `apps/web/src/server/actions/sessions.ts`:

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { sessionIdFromJwt } from '@/lib/auth/api-context';
import { broadcastToChannel } from '@/lib/realtime/broadcast';
import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';
import { SessionsService } from '@/server/services/sessions';

import { err, ok, type ActionResult } from '@stockpilot/core';

const revokeSchema = z.object({ sessionId: z.string().uuid() });

async function currentSessionId(): Promise<string | null> {
  const ctx = await withContext();
  const {
    data: { session },
  } = await ctx.supabase.auth.getSession();
  return session?.access_token ? sessionIdFromJwt(session.access_token) : null;
}

export async function revokeSessionAction(input: {
  sessionId: string;
}): Promise<ActionResult<null>> {
  const parsed = revokeSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid session id');
  try {
    const ctx = await withContext();
    const svc = new SessionsService(ctx);
    await svc.revoke(parsed.data.sessionId);
    // Live force-logout for the targeted device if it's online.
    await broadcastToChannel(`user:${ctx.userId}:sessions`, 'revoked', {
      sessionIds: [parsed.data.sessionId],
    });
    await audit(
      { event: 'security.session_revoked', entityType: 'session', entityId: parsed.data.sessionId },
      ctx,
    );
    revalidatePath('/dashboard/settings/security');
    return ok(null);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Failed to sign out device');
  }
}

export async function revokeOtherSessionsAction(): Promise<ActionResult<{ revoked: 'others' }>> {
  try {
    const ctx = await withContext();
    const keep = await currentSessionId();
    const svc = new SessionsService(ctx);
    await svc.revokeOthers(keep ?? '00000000-0000-0000-0000-000000000000');
    await broadcastToChannel(`user:${ctx.userId}:sessions`, 'revoked', {
      keepId: keep ?? null,
    });
    await audit({ event: 'security.session_revoked', entityType: 'session', extra: { scope: 'others' } }, ctx);
    revalidatePath('/dashboard/settings/security');
    return ok({ revoked: 'others' });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Failed to sign out devices');
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && pnpm typecheck 2>&1 | tail -5`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/server/actions/sessions.ts apps/web/src/server/services/audit.ts
git commit -m "feat(sessions): revoke actions + broadcast force-logout + audit event"
```

---

### Task 6: Web UI — Active sessions section

**Files:**
- Create: `apps/web/src/components/settings/active-sessions.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/settings/security/page.tsx` (load sessions + render the new card)

**Interfaces:**
- Consumes: `SessionsService` (Task 3), `sessionIdFromJwt` (Task 3), `revokeSessionAction` / `revokeOtherSessionsAction` (Task 5), `SessionInfo` (Task 3).

- [ ] **Step 1: Write the client component**

Create `apps/web/src/components/settings/active-sessions.tsx`:

```tsx
'use client';

import { Loader2, MonitorSmartphone, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  revokeOtherSessionsAction,
  revokeSessionAction,
} from '@/server/actions/sessions';
import type { SessionInfo } from '@/server/services/sessions';

function formatLastActive(iso: string | null): string {
  if (!iso) return 'unknown';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

export function ActiveSessions({ sessions }: { sessions: SessionInfo[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const others = sessions.filter((s) => !s.isCurrent);

  async function signOut(id: string) {
    setBusyId(id);
    const res = await revokeSessionAction({ sessionId: id });
    setBusyId(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Signed out of that device.');
    router.refresh();
  }

  async function signOutOthers() {
    setBusyId('others');
    const res = await revokeOtherSessionsAction();
    setBusyId(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Signed out of all other devices.');
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <ul className="divide-border divide-y rounded-md border">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-3 py-3">
            <MonitorSmartphone className="text-muted-foreground h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="truncate">{s.label}</span>
                {s.isMfa && (
                  <ShieldCheck className="h-3.5 w-3.5 text-[hsl(var(--accent))]" aria-label="MFA verified" />
                )}
                {s.isCurrent && (
                  <span className="rounded-full bg-[hsl(var(--accent)/0.12)] px-2 py-0.5 text-[10.5px] font-medium text-[hsl(var(--accent))]">
                    This device
                  </span>
                )}
              </div>
              <div className="text-muted-foreground text-xs">
                {s.ip ?? 'unknown IP'} · active {formatLastActive(s.lastActiveAt)}
              </div>
            </div>
            {!s.isCurrent && (
              <Button
                variant="outline"
                size="sm"
                disabled={busyId === s.id}
                onClick={() => signOut(s.id)}
              >
                {busyId === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Sign out'}
              </Button>
            )}
          </li>
        ))}
      </ul>

      {others.length > 0 && (
        <Button variant="outline" size="sm" disabled={busyId === 'others'} onClick={signOutOthers}>
          {busyId === 'others' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            'Sign out all other devices'
          )}
        </Button>
      )}
      <p className="text-muted-foreground text-xs">
        Signing out takes effect immediately on devices that are online; a device
        that&apos;s offline is signed out within the hour.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into the security page**

In `apps/web/src/app/(dashboard)/dashboard/settings/security/page.tsx`:
1. Add imports at the top:
```ts
import { ActiveSessions } from '@/components/settings/active-sessions';
import { sessionIdFromJwt } from '@/lib/auth/api-context';
import { SessionsService } from '@/server/services/sessions';
```
2. After `const supabase = await createClient();` (≈ line 24), load the sessions:
```ts
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const currentSessionId = session?.access_token ? sessionIdFromJwt(session.access_token) : null;
  const activeSessions = await new SessionsService(await import('@/server/services/context').then((m) => m.withContext()))
    .list(currentSessionId)
    .catch(() => []);
```
   (If the file already calls `withContext()`/has a ctx, use that instead of the inline import — prefer reusing the existing context; the `.catch(() => [])` keeps the page rendering if the rpc errors.)
3. Add a new Card after the "Authenticator app" card (mirror the existing Card markup):
```tsx
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Active sessions</CardTitle>
            <CardDescription>
              Devices you&apos;re signed in on. Sign out any you don&apos;t recognize.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActiveSessions sessions={activeSessions} />
          </CardContent>
        </Card>
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd apps/web && pnpm typecheck 2>&1 | tail -5 && npx eslint src/components/settings/active-sessions.tsx 2>&1 | tail -3`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/settings/active-sessions.tsx "apps/web/src/app/(dashboard)/dashboard/settings/security/page.tsx"
git commit -m "feat(sessions): Active sessions UI in Settings -> Security"
```

---

### Task 7: Web force-logout listener

**Files:**
- Create: `apps/web/src/components/realtime/session-revocation-listener.tsx`
- Modify: `apps/web/src/components/dashboard/dashboard-shell.tsx` (mount it next to `PermissionsRealtime`; pass `userId`)

**Interfaces:**
- Consumes: the broadcast `user:{userId}:sessions` / event `revoked` / payload `{ sessionIds?: string[]; keepId?: string | null }` (Task 5); the browser supabase client; `sessionIdFromJwt` is NOT used here — the client reads its own session id from `getSession()`.

- [ ] **Step 1: Write the listener**

Create `apps/web/src/components/realtime/session-revocation-listener.tsx` (mirrors `permissions-realtime.tsx`):

```tsx
'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';

/**
 * Listens for a "you've been signed out" broadcast targeting THIS device and, if
 * matched, signs out + redirects to /signin live. Mirrors PermissionsRealtime.
 * Fail-silent: if the socket can't open, the refresh-token revocation + token
 * expiry still lock the device out within the hour.
 */
export function SessionRevocationListener({ userId }: { userId: string }) {
  const router = useRouter();
  const supabaseRef = React.useRef<ReturnType<typeof createClient> | null>(null);
  if (supabaseRef.current === null) {
    try {
      supabaseRef.current = createClient();
    } catch {
      // eslint-disable-next-line react-hooks/refs -- ref init, not setState
      supabaseRef.current = null;
    }
  }
  const mySessionIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const supabase = supabaseRef.current;
    if (!supabase) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    async function start() {
      const {
        data: { session },
      } = await supabase!.auth.getSession();
      // session_id claim identifies our own auth.sessions row.
      const token = session?.access_token;
      if (token) {
        try {
          const payload = JSON.parse(
            Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
          ) as { session_id?: string };
          mySessionIdRef.current = payload.session_id ?? null;
        } catch {
          mySessionIdRef.current = null;
        }
      }
      if (cancelled) return;
      channel = supabase!.channel(`user:${userId}:sessions`);
      channel.on('broadcast', { event: 'revoked' }, ({ payload }) => {
        const p = (payload ?? {}) as { sessionIds?: string[]; keepId?: string | null };
        const mine = mySessionIdRef.current;
        const targeted =
          (Array.isArray(p.sessionIds) && !!mine && p.sessionIds.includes(mine)) ||
          ('keepId' in p && !!mine && p.keepId !== mine);
        if (!targeted) return;
        void supabase!.auth.signOut().finally(() => {
          toast.message('You were signed out from another device.');
          router.replace('/signin');
        });
      });
      channel.subscribe();
    }
    void start();

    return () => {
      cancelled = true;
      if (channel && supabase) {
        try {
          supabase.removeChannel(channel);
        } catch {
          /* noop */
        }
      }
    };
  }, [userId, router]);

  return null;
}
```

NOTE: `Buffer` is available in the Next.js client bundle (polyfilled). If lint/build flags it, replace with `atob(token.split('.')[1])` + `JSON.parse`.

- [ ] **Step 2: Mount in DashboardShell**

In `apps/web/src/components/dashboard/dashboard-shell.tsx`, import it and render next to `<PermissionsRealtime …/>` (DashboardShell already has `userId` in scope):
```tsx
import { SessionRevocationListener } from '@/components/realtime/session-revocation-listener';
```
```tsx
      <PermissionsRealtime organizationId={organizationId} userId={userId} role={role} />
      <SessionRevocationListener userId={userId} />
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd apps/web && pnpm typecheck 2>&1 | tail -5 && npx eslint src/components/realtime/session-revocation-listener.tsx 2>&1 | tail -3`
Expected: no errors. (If `Buffer` is flagged, switch to `atob` per the note and re-run.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/realtime/session-revocation-listener.tsx apps/web/src/components/dashboard/dashboard-shell.tsx
git commit -m "feat(sessions): web realtime force-logout listener"
```

---

### Task 8: Mobile force-logout listener

**Files:**
- Create: `apps/mobile/src/lib/use-session-revocation.ts`
- Modify: `apps/mobile/src/components/drawer-content.tsx` (call the hook, like `usePermissionsRealtime`)

**Interfaces:**
- Consumes: the same broadcast `user:{userId}:sessions` / `revoked` / `{ sessionIds?, keepId? }`; the mobile supabase client; `useAuth` (user id + signOut).

- [ ] **Step 1: Write the hook**

Create `apps/mobile/src/lib/use-session-revocation.ts` (mirrors `use-permissions-realtime.ts`):

```ts
import * as React from 'react';

import { supabase } from './supabase';

/**
 * Force-logout listener: when the server broadcasts that THIS device's session
 * was revoked from another device, sign out locally. Mirrors the web
 * SessionRevocationListener. Fail-silent (the refresh-token revocation still
 * logs the device out within the access-token TTL).
 */
export function useSessionRevocation(userId: string | null, onSignedOut: () => void): void {
  React.useEffect(() => {
    if (!userId) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    let mySessionId: string | null = null;

    async function start() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (token) {
        try {
          const seg = token.split('.')[1] ?? '';
          // base64url -> JSON
          const json = decodeURIComponent(
            atob(seg.replace(/-/g, '+').replace(/_/g, '/'))
              .split('')
              .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
              .join(''),
          );
          mySessionId = (JSON.parse(json) as { session_id?: string }).session_id ?? null;
        } catch {
          mySessionId = null;
        }
      }
      if (cancelled) return;
      channel = supabase.channel(`user:${userId}:sessions`);
      channel.on('broadcast', { event: 'revoked' }, ({ payload }) => {
        const p = (payload ?? {}) as { sessionIds?: string[]; keepId?: string | null };
        const targeted =
          (Array.isArray(p.sessionIds) && !!mySessionId && p.sessionIds.includes(mySessionId)) ||
          ('keepId' in p && !!mySessionId && p.keepId !== mySessionId);
        if (!targeted) return;
        void supabase.auth.signOut().finally(onSignedOut);
      });
      channel.subscribe();
    }
    void start();

    return () => {
      cancelled = true;
      if (channel) {
        try {
          void supabase.removeChannel(channel);
        } catch {
          /* noop */
        }
      }
    };
  }, [userId, onSignedOut]);
}
```

- [ ] **Step 2: Wire into drawer-content**

In `apps/mobile/src/components/drawer-content.tsx`, near the existing `usePermissionsRealtime({...})` call:
```ts
import { useSessionRevocation } from '@/lib/use-session-revocation';
import { useRouter } from 'expo-router';
```
```ts
  const router = useRouter();
  useSessionRevocation(user?.id ?? null, React.useCallback(() => router.replace('/sign-in'), [router]));
```
(Use the app's actual sign-in route — confirm the route name in `apps/mobile/app/`; it may be `/sign-in` or `/(auth)/sign-in`. Match what `signOut` flows to elsewhere.)

- [ ] **Step 3: Typecheck**

Run: `cd apps/mobile && pnpm typecheck 2>&1 | tail -5`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/lib/use-session-revocation.ts apps/mobile/src/components/drawer-content.tsx
git commit -m "feat(mobile): realtime force-logout listener for remote sign-out"
```

---

## Final steps (after all tasks)

- [ ] **Apply migration to prod:** `supabase db push --linked` (applies 0213).
- [ ] **Push:** `git push origin main`.
- [ ] **OTA the mobile listener:** `cd apps/mobile && pnpm dlx eas-cli@20.3.0 update --channel production --message "remote device sign-out listener" --non-interactive`.
- [ ] **Manual verification:** log into the web app in two browsers (or a browser + the phone); on browser A, Settings → Security → Active sessions → Sign out browser B → confirm B lands on /signin live and its row disappears from A after refresh.

## Self-Review notes (done)

- **Spec coverage:** functions (Task 1) ✓; UI list with label/IP/last-active/MFA/this-device (Tasks 2,3,6) ✓; one-click revoke + revoke-others (Tasks 5,6) ✓; realtime force-logout web+mobile (Tasks 7,8) ✓; offline caveat in UI (Task 6) ✓; DB-enforced `auth.uid()` scoping + pgTAP (Task 1) ✓; audit (Task 5) ✓.
- **Type consistency:** `SessionInfo` shape defined in Task 3 and consumed verbatim in Task 6; broadcast payload `{ sessionIds?, keepId? }` produced in Task 5 and consumed in Tasks 7,8; `sessionIdFromJwt` defined in Task 3, used in Task 5.
- **Known confirm-at-implementation:** the mobile sign-in route name (Task 8 Step 2) and whether `Buffer` vs `atob` is needed in the web client bundle (Task 7 Step 1 note).

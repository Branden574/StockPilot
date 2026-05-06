-- 0030_ai_chat_history.sql
-- ============================================================================
-- AI assistant chat history. Stores per-user chat sessions and their messages
-- so refreshes don't wipe the conversation. Retention is 30 days — anything
-- older is purged by `purge_ai_chat_history()` (called from a daily cron).
--
-- Scoping rules:
--   • Each session is owned by exactly one (organization, user) pair.
--   • RLS only lets a user see/modify their own sessions in their own org.
--   • Messages inherit access via session_id → ai_chat_sessions.
-- ============================================================================

create table if not exists public.ai_chat_sessions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  title           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists ai_chat_sessions_user_idx
  on public.ai_chat_sessions(user_id, organization_id, updated_at desc);
create index if not exists ai_chat_sessions_purge_idx
  on public.ai_chat_sessions(updated_at);

create table if not exists public.ai_chat_messages (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.ai_chat_sessions(id) on delete cascade,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  tool_calls  jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists ai_chat_messages_session_idx
  on public.ai_chat_messages(session_id, created_at);

alter table public.ai_chat_sessions enable row level security;
alter table public.ai_chat_messages enable row level security;

drop policy if exists ai_chat_sessions_select on public.ai_chat_sessions;
create policy ai_chat_sessions_select on public.ai_chat_sessions
  for select to authenticated
  using (user_id = auth.uid() and public.is_org_member(organization_id));

drop policy if exists ai_chat_sessions_insert on public.ai_chat_sessions;
create policy ai_chat_sessions_insert on public.ai_chat_sessions
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_org_member(organization_id));

drop policy if exists ai_chat_sessions_update on public.ai_chat_sessions;
create policy ai_chat_sessions_update on public.ai_chat_sessions
  for update to authenticated
  using (user_id = auth.uid() and public.is_org_member(organization_id))
  with check (user_id = auth.uid() and public.is_org_member(organization_id));

drop policy if exists ai_chat_sessions_delete on public.ai_chat_sessions;
create policy ai_chat_sessions_delete on public.ai_chat_sessions
  for delete to authenticated
  using (user_id = auth.uid() and public.is_org_member(organization_id));

drop policy if exists ai_chat_messages_select on public.ai_chat_messages;
create policy ai_chat_messages_select on public.ai_chat_messages
  for select to authenticated
  using (
    exists (
      select 1
        from public.ai_chat_sessions s
       where s.id = ai_chat_messages.session_id
         and s.user_id = auth.uid()
         and public.is_org_member(s.organization_id)
    )
  );

drop policy if exists ai_chat_messages_insert on public.ai_chat_messages;
create policy ai_chat_messages_insert on public.ai_chat_messages
  for insert to authenticated
  with check (
    exists (
      select 1
        from public.ai_chat_sessions s
       where s.id = ai_chat_messages.session_id
         and s.user_id = auth.uid()
         and public.is_org_member(s.organization_id)
    )
  );

drop policy if exists ai_chat_messages_delete on public.ai_chat_messages;
create policy ai_chat_messages_delete on public.ai_chat_messages
  for delete to authenticated
  using (
    exists (
      select 1
        from public.ai_chat_sessions s
       where s.id = ai_chat_messages.session_id
         and s.user_id = auth.uid()
         and public.is_org_member(s.organization_id)
    )
  );

-- ─────────────────────────────────────────────────────────────────────
-- Touch the parent session's updated_at whenever a message is added.
-- Lets the API list sessions ordered by recent activity without an
-- extra query, and powers the 30-day TTL (we purge by updated_at so
-- an active session doesn't get reaped mid-conversation).
-- ─────────────────────────────────────────────────────────────────────

create or replace function public._touch_ai_chat_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ai_chat_sessions
     set updated_at = now()
   where id = new.session_id;
  return new;
end;
$$;

drop trigger if exists ai_chat_messages_touch_session on public.ai_chat_messages;
create trigger ai_chat_messages_touch_session
  after insert on public.ai_chat_messages
  for each row execute function public._touch_ai_chat_session();

-- ─────────────────────────────────────────────────────────────────────
-- 30-day TTL purge. Deleting the session cascades to its messages.
-- Safe to call from any scheduler (pg_cron, Supabase scheduled function,
-- Vercel cron). No-op if there's nothing to clean up.
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.purge_ai_chat_history()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted int;
begin
  delete from public.ai_chat_sessions
   where updated_at < now() - interval '30 days';
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

grant execute on function public.purge_ai_chat_history() to service_role;

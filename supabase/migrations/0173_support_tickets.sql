-- 0173_support_tickets.sql
-- ─────────────────────────────────────────────────────────────────────
-- Public support / "report a problem" tickets. Submitted from the public
-- /support page (anonymous visitors OR signed-in users) and triaged by
-- platform admins (StockPilot's own support team) at /dashboard/admin/support.
--
-- These are PLATFORM-level tickets, not per-org records, so access is entirely
-- server-mediated: RLS is ON with NO policies, which means the anon/authed
-- Supabase clients cannot touch this table at all. The only access paths are:
--   • create  → service-role insert from createSupportTicketAction (rate-limited
--               per-IP + per-email, fail-closed)
--   • triage  → service-role read/update from the admin page, gated by
--               isPlatformAdmin(session.email)
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.support_tickets (
  id               uuid primary key default gen_random_uuid(),
  -- nullable: an anonymous visitor reporting a problem has no org/user
  organization_id  uuid references public.organizations(id) on delete set null,
  submitted_by     uuid references public.user_profiles(id) on delete set null,
  name             text,
  email            text not null,
  category         text not null default 'other'
                     check (category in ('bug', 'billing', 'account', 'feature', 'other')),
  priority         text not null default 'normal'
                     check (priority in ('low', 'normal', 'high', 'urgent')),
  subject          text not null,
  message          text not null,
  status           text not null default 'open'
                     check (status in ('open', 'in_progress', 'resolved', 'closed')),
  page_url         text,
  user_agent       text,
  admin_notes      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  resolved_at      timestamptz
);

create index if not exists support_tickets_status_idx
  on public.support_tickets (status, created_at desc);

-- RLS ON, NO policies → only the service-role client (server code) can read or
-- write. Public create + admin triage both go through gated server actions.
alter table public.support_tickets enable row level security;

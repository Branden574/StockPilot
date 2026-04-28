-- ============================================================================
-- 0001_init.sql — Extensions, helper functions, identity tables
-- Phase 1 foundation: organizations, user profiles, memberships, invites.
-- ============================================================================

-- Extensions ---------------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "citext";
-- pgvector available for AI features in Phase 9
create extension if not exists "vector" with schema extensions;

-- Common: updated_at trigger ----------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- ORGANIZATIONS
-- ============================================================================
create table public.organizations (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null check (length(name) between 1 and 200),
  slug                    citext unique not null check (length(slug) between 2 and 64),
  logo_url                text,
  industry                text,
  size                    text,
  timezone                text not null default 'UTC',
  currency                text not null default 'USD',
  plan                    text not null default 'free'
                          check (plan in ('free','pro','business','enterprise')),
  stripe_customer_id      text unique,
  stripe_subscription_id  text,
  trial_ends_at           timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.tg_set_updated_at();

create index organizations_plan_idx on public.organizations(plan);

-- ============================================================================
-- USER PROFILES (mirror of auth.users)
-- ============================================================================
create table public.user_profiles (
  id                       uuid primary key references auth.users(id) on delete cascade,
  email                    citext not null,
  full_name                text,
  avatar_url               text,
  default_organization_id  uuid references public.organizations(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create trigger user_profiles_set_updated_at
  before update on public.user_profiles
  for each row execute function public.tg_set_updated_at();

create index user_profiles_email_idx on public.user_profiles(email);

-- Bootstrap a profile row whenever a new auth.users record is created.
create or replace function public.tg_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.tg_handle_new_auth_user();

-- ============================================================================
-- ORGANIZATION MEMBERSHIPS
-- ============================================================================
create table public.organization_members (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null references public.user_profiles(id) on delete cascade,
  role             text not null check (role in ('owner','admin','manager','staff','viewer')),
  invited_by       uuid references public.user_profiles(id) on delete set null,
  invited_at       timestamptz,
  accepted_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members(user_id);
create index organization_members_org_idx  on public.organization_members(organization_id);

-- ============================================================================
-- ORGANIZATION INVITES
-- ============================================================================
create table public.organization_invites (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  email            citext not null,
  role             text not null check (role in ('admin','manager','staff','viewer')),
  token            text unique not null,
  expires_at       timestamptz not null,
  invited_by       uuid not null references public.user_profiles(id) on delete cascade,
  accepted_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index organization_invites_token_idx on public.organization_invites(token);
create index organization_invites_org_email_idx on public.organization_invites(organization_id, email);

-- ============================================================================
-- HELPER FUNCTIONS — used by RLS and the application layer
-- ============================================================================

-- Returns true if the current auth.uid() is a member of the org.
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.accepted_at is not null
  );
$$;

-- Returns the role of auth.uid() in the org, or null if not a member.
create or replace function public.user_org_role(org_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.organization_members
  where organization_id = org_id
    and user_id = auth.uid()
    and accepted_at is not null
  limit 1;
$$;

-- Returns true if auth.uid() has at least the requested role in the org.
create or replace function public.has_org_role(org_id uuid, min_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with role_rank(role, rank) as (
    values
      ('owner',   100),
      ('admin',    80),
      ('manager',  60),
      ('staff',    40),
      ('viewer',   20)
  ),
  user_role as (
    select rr.rank
    from public.organization_members m
    join role_rank rr on rr.role = m.role
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.accepted_at is not null
    limit 1
  )
  select coalesce((select rank from user_role), 0)
       >= coalesce((select rank from role_rank where role = min_role), 999);
$$;

-- ============================================================================
-- ENABLE RLS — policies defined in 0003_rls.sql
-- ============================================================================
alter table public.organizations         enable row level security;
alter table public.user_profiles         enable row level security;
alter table public.organization_members  enable row level security;
alter table public.organization_invites  enable row level security;

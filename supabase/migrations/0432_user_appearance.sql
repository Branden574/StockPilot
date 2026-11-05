-- 0432_user_appearance.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- A person's chosen appearance, so the choice follows the same account across
-- the web and the phone. Two separate choices: the Design (`style`: Liquid
-- Glass or Classic) and the Theme (Light, Dark or System). The number is a
-- placeholder: it is fixed at push time to the next free number, and nothing
-- in this file names it.
--
-- Design: stockpilot-work/liquid-glass/IMPLEMENTATION-PLAN.md section 3.2
-- (persistence) and 3.4 (how the device and the account are reconciled; the
-- pure reducer is packages/core/src/appearance/reconcile.ts), as revised by
-- plans/REVISION-DEFAULT.md R3. This file was rewritten in place for that
-- revision (one `appearance` word became two nullable columns); it had never
-- been pushed. Before it is pushed, `supabase migration list --linked` must
-- show no user_appearance migration in production; if one ever had been
-- pushed, this would instead be a forward migration (add the two columns,
-- backfill from `appearance`, drop it).
--
-- WHY A TABLE OF ITS OWN
--   user_profiles is read through a column-list SELECT grant (0402) and its
--   SELECT policy admits organization-mates' rows, so a column there would be
--   readable by every org-mate once granted. user_onboarding (0259) holds tour
--   state, user_release_state (0353) is written through one fixed function,
--   notification_preferences holds notification switches, and auth user
--   metadata is unvalidated and rides in every token. A self-only table is the
--   smallest store that fits.
--
-- WHAT IT ADDS (tier A: additive only)
--   1. public.user_appearance: one row per person; `style` ('liquid-glass' or
--      'classic') and `theme` ('light', 'dark' or 'system'), each nullable,
--      because a person may choose only one of them: null means "not chosen on
--      any device", and each device then keeps its own value. CHECKs admit
--      only the known words and refuse a row with neither. updated_at, which
--      the shared tg_set_updated_at trigger moves on every update, is the
--      clock the reconcile reads. The apps save only the column the person
--      chose (an upsert naming only that column), so saving a Theme never
--      clears a Design.
--   2. Own-row RLS, the 0259 / 0353 shape: select, insert and update where
--      user_id = auth.uid(); no delete policy. Like user_onboarding and
--      user_release_state (see 0310's note) it carries no disabled-account
--      guard: nothing here is visible to anyone else, and a disabled account
--      cannot reach the API.
--   3. Explicit privileges (the D1 rule, apps/web/src/test/migration-grants.ts):
--      anon gets nothing; authenticated gets select, insert and update (never
--      delete or truncate); service_role keeps select, insert, update, delete.
--   No existing row, table, function, policy, trigger or grant changes, and
--   nothing is backfilled: only choices people make after release are written.
--
-- ACCOUNT DELETION
--   user_id cascades from auth.users, like user_onboarding: deleting an
--   account deletes its appearance row.
--
-- ROLLBACK
--   Leave the table in place: nothing reads it once the app is rolled back.
--   If it ever has to go: drop table public.user_appearance;
-- ─────────────────────────────────────────────────────────────────────────────

create table public.user_appearance (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  style      text        null,
  theme      text        null,
  updated_at timestamptz not null default now(),
  constraint user_appearance_style_known
    check (style is null or style in ('liquid-glass', 'classic')),
  constraint user_appearance_theme_known
    check (theme is null or theme in ('light', 'dark', 'system')),
  constraint user_appearance_something_chosen
    check (style is not null or theme is not null)
);

comment on table public.user_appearance is
  'A person''s chosen Design (style: liquid-glass or classic) and Theme (light, dark or system), each null until chosen, synced across web and phone. Own-row RLS; no delete policy.';

alter table public.user_appearance enable row level security;

create policy user_appearance_select on public.user_appearance
  for select to authenticated using (user_id = (select auth.uid()));
create policy user_appearance_insert on public.user_appearance
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy user_appearance_update on public.user_appearance
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create trigger user_appearance_touch_updated_at
  before update on public.user_appearance
  for each row execute function public.tg_set_updated_at();

-- Supabase's default privileges grant every new public table to anon,
-- authenticated and service_role (until 2026-10-30; after it, nothing). Take
-- the API roles' privileges back and grant exactly what each needs, so the
-- table ends with the same ACL whichever defaults applied.
revoke all on table public.user_appearance from public, anon, authenticated;
grant select, insert, update on table public.user_appearance to authenticated;
grant select, insert, update, delete on table public.user_appearance to service_role;

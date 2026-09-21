-- 0355_request_context.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- get_request_context(): everything a signed-in request needs to know about WHO
-- is asking, in ONE round trip.
--
-- WHY. Every server render, prefetch and server action resolves the same context
-- before it does anything else, and it did so with seven reads in three serial
-- waves:
--
--   wave 1   user_profiles (own row)  |  organization_members (+ organizations)
--   wave 2   role_permission_overrides  |  user_permission_overrides
--   wave 3   organizations (settings row)  |  organization_modules
--
-- Measured in production on 2026-09-20/21 (Supabase gateway logs): one dashboard
-- load plus one Inventory navigation made about 93 Supabase calls, and about 44
-- of them were these six reads repeated by every request (user_profiles 10x,
-- organizations 8x, the two override tables 7x each, organization_members 7x,
-- organization_modules 5x; the auth-user and warehouses reads repeat too and are
-- not covered here). At about 16 ms a call (p50 while the project is busy) nobody
-- notices. In quiet hours a call costs 70 to 170 ms at p50, and 200 to 400 ms
-- after 90 seconds of nothing, and the three waves are serial. Measured with one
-- visitor after two quiet minutes, a dashboard load took 1.0 to 2.7 s against
-- about 0.8 s when warm. That is the slowness the owner reported.
--
-- WHAT IT RETURNS. For the CALLER ONLY (auth.uid()):
--   profile       the same six columns the session loader selected
--   memberships   every ACCEPTED membership, oldest first, each with its
--                 organization's settings row, the permission overrides for that
--                 role and for that user, and the enabled module ids
--
-- WHAT DOES NOT CHANGE, and why this is safe:
--   * SECURITY INVOKER. Every table is read under the caller's own row level
--     security, exactly as the seven PostgREST reads were. The function can
--     return nothing the caller could not already select. No definer rights, so
--     nothing here belongs to the "definer helper without a gate" class (0346).
--   * No caching and no staleness: it is evaluated on every request, so a
--     revoked permission, a removed membership or a disabled account takes
--     effect on the next request, as before.
--   * It applies no policy. Which membership is the active one, what the
--     effective permissions are, whether the account is active, whether MFA is
--     satisfied: all of that stays in the application code that already owns it.
--     The ONE choice made here is the ORDER of the memberships (oldest first,
--     then organization id), which settles the organization of a user who has
--     several and no valid default. The application's own membership reads use
--     the same order, so every path lands on the same organization.
--   * The application keeps the seven reads as its fallback. If this function is
--     missing or fails, the request is resolved the old way.
--
-- STABLE + no writes, so PostgREST can serve it from a read-only transaction
-- (the application calls it with GET).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.get_request_context()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'profile', (
      select jsonb_build_object(
               'id', p.id,
               'email', p.email,
               'full_name', p.full_name,
               'avatar_url', p.avatar_url,
               'default_organization_id', p.default_organization_id,
               'disabled_at', p.disabled_at)
        from public.user_profiles p
       where p.id = auth.uid()
    ),
    'memberships', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'organization_id', m.organization_id,
                 'role', m.role,
                 'organization', (
                   select jsonb_build_object(
                            'id', o.id,
                            'name', o.name,
                            'logo_url', o.logo_url,
                            'terminology', o.terminology,
                            'mfa_policy', o.mfa_policy,
                            'timezone', o.timezone,
                            'nav_overrides', o.nav_overrides,
                            'dashboard_layout', o.dashboard_layout,
                            'order_status_config', o.order_status_config,
                            'all_modules_comp', o.all_modules_comp)
                     from public.organizations o
                    where o.id = m.organization_id),
                 'role_overrides', coalesce((
                   select jsonb_agg(jsonb_build_object('permission', r.permission, 'granted', r.granted)
                                    order by r.permission)
                     from public.role_permission_overrides r
                    where r.organization_id = m.organization_id
                      and r.role = m.role), '[]'::jsonb),
                 'user_overrides', coalesce((
                   select jsonb_agg(jsonb_build_object('permission', u.permission, 'granted', u.granted)
                                    order by u.permission)
                     from public.user_permission_overrides u
                    where u.organization_id = m.organization_id
                      and u.user_id = m.user_id), '[]'::jsonb),
                 'enabled_modules', coalesce((
                   select jsonb_agg(om.module_id order by om.module_id)
                     from public.organization_modules om
                    where om.organization_id = m.organization_id
                      and om.enabled), '[]'::jsonb)
               )
               order by m.created_at, m.organization_id)
        from public.organization_members m
       where m.user_id = auth.uid()
         and m.accepted_at is not null
    ), '[]'::jsonb)
  );
$$;

comment on function public.get_request_context() is
  'Caller-only request context (profile, accepted memberships, org settings, permission overrides, enabled modules) in one round trip. SECURITY INVOKER: reads under the caller''s RLS. Applies no policy; the application resolves org, permissions, account status and MFA from it. See 0355.';

revoke all on function public.get_request_context() from public;
revoke all on function public.get_request_context() from anon;
grant execute on function public.get_request_context() to authenticated;
grant execute on function public.get_request_context() to service_role;

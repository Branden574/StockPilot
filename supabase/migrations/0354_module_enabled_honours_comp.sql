-- 0354_module_enabled_honours_comp.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- module_enabled() learns the "Comped: all modules" flag.
--
-- organizations.all_modules_comp was added in 0175 with this comment: "When
-- true, the entitlement layer treats every premium module as enabled". Only
-- part of the entitlement layer ever did:
--
--   honoured it   the dashboard's module resolver (sidebar, navigation, page
--                 context), the inventory loader, and org_can_enable_module()
--   ignored it    THIS function, and with it every RLS policy that calls it
--                 (maintenance_requests insert + update, maintenance_request_notes
--                 insert, maintenance_request_attachments insert) and the
--                 dashboard's page gate, which asks this function; and the API
--                 context behind /api/v1 and the mobile snapshot (fixed in the
--                 same change, in TypeScript)
--
-- So a comped organization was OFFERED a module in its navigation and then told
-- "not enabled" by the page, or refused by RLS. It stayed hidden because the
-- only comped organization had been switched on module by module; the two it
-- never switched on (price_tracking, api_access) are where it showed.
--
-- THE RULE, now the same everywhere: a module is on through an explicit
-- organization_modules row with enabled = true, OR because the organization is
-- comped. The comp wins even over an explicit enabled = false. That matters
-- more than it sounds: seed_org_modules() writes a row for every module when an
-- organization is created, most of them enabled = false, so "comped with an
-- explicit false" is the ordinary state of a comped organization, not an edge.
--
-- WHAT DOES NOT CHANGE
--   * Still a read-only boolean predicate: it writes nothing and returns one
--     boolean about a caller-supplied uuid, which is why it may sit on the
--     security invariants' allowlist E.
--   * It discloses NOTHING NEW across tenants, and that took a gate. An
--     unconditional comp arm would have made module_enabled(<any org>, 'x') true
--     exactly when that organization is comped: a billing fact about a stranger.
--     org_can_enable_module() already leaks that bit for most organizations,
--     but not for enterprise-tier or trial ones, where the tier masks it. So the
--     comp arm answers only for the organization's OWN people (is_org_member,
--     which accepts a live platform act-as grant) and for contexts with no end
--     user at all (service role, migrations: auth.uid() is null; anon holds no
--     EXECUTE). Everyone else gets exactly the pre-0354 answer.
--   * Still SECURITY DEFINER (it must read organizations and
--     organization_modules regardless of the caller's RLS, from inside RLS).
--   * Same signature, so every policy that references it keeps working with no
--     policy rewritten. CREATE OR REPLACE keeps the grants; they are restated
--     anyway, because a function whose grants are implicit is one DROP away
--     from being open to everyone (INV-25 is the tripwire, 0318 the history).
--   * A organization that is NOT comped behaves exactly as before.
--
-- search_path gains pg_temp, the house pin for definer functions since 0346.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.module_enabled(p_org uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
           select 1
             from public.organization_modules om
            where om.organization_id = p_org
              and om.module_id = p_module
              and om.enabled
         )
      or (
           coalesce(
             (select o.all_modules_comp from public.organizations o where o.id = p_org),
             false
           )
           and ((select auth.uid()) is null or public.is_org_member(p_org))
         );
$$;

revoke execute on function public.module_enabled(uuid, text) from public, anon;
grant  execute on function public.module_enabled(uuid, text) to authenticated, service_role;

comment on function public.module_enabled(uuid, text) is
  'Is this module on for this organization? True for an explicit enabled row, OR when the organization is comped (organizations.all_modules_comp), which wins even over an explicit false. The comp is answered only to the organization''s own members and to contexts with no end user; a stranger gets the rows-only answer, so it is not a cross-tenant comp oracle. Read-only boolean predicate evaluated inside RLS and by the dashboard page gate. Mirrors lib/modules/effective-modules.ts: change both or neither.';

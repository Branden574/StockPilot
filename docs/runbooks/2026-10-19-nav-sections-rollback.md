# Before a web rollback past the navigation regroup (2026-10-19)

## When this applies

The owner's regroup of 2026-10-19 split the sidebar's Inventory and Workspace
sections into Inventory, Fulfillment, Purchasing, Insights and Workspace. Since
then, Settings > Navigation saves each section's order under its own key in
`organizations.nav_overrides` (`order.fulfillment`, `order.purchasing`,
`order.insights`) and lets an admin add a custom link to any section, saved as
`custom[].section`.

Run this runbook before the web is rolled back to a build from before the
regroup, that is a build whose sections are only overview, inventory,
workspace, tools and admin. If the web was already rolled back without it, run
it now: it works the same with the earlier build live. It is not needed when
Part 1 returns no rows, or when the build you roll back to already has the
regroup. The phone app does not use `nav_overrides`, so its OTA rollback
(`docs/runbooks/mobile-ota.md`) is separate and needs nothing from here.

## What goes wrong without it

On a build from before the regroup, in each organization with a custom link
saved under Fulfillment, Purchasing or Insights:

- **The link disappears.** The earlier `applyNavOverrides` skips any custom
  link whose section it does not know, so the link is gone from the sidebar of
  every member of the organization.
- **Every save in Settings > Navigation fails.** The earlier editor has no
  panel for those sections and no section control on a custom link, so it can
  neither show nor move the link. It still sends the link with every save, and
  the earlier server action's schema refuses the whole save ("Invalid enum
  value. Expected 'overview' | 'inventory' | 'workspace' | 'tools' | 'admin',
  received 'insights'"). The only save that still works is Reset to default,
  which also wipes every hidden link, renamed link, saved order and custom
  link.

In every organization:

- **Order lists under the new keys are ignored**, which needs no fix. The links
  that moved are back in Inventory and Workspace and follow those sections'
  saved lists, where a link a list does not name comes after the ones it names,
  in default order. The earlier editor drops the new lists on its next save.
- **Hidden and renamed links keep working.** Both are keyed by the link's href,
  not its section.

## Part 1: read-only preview (run first; safe)

Lists every custom link saved under fulfillment, purchasing or insights: the
links the regroup's build draws and a build from before it does not. (The
server accepts only the eight section keys, and these three are the ones the
earlier build lacks.)

```sql
select o.id as organization_id,
       o.name as organization,
       l.link ->> 'section' as section,
       l.link ->> 'label' as label,
       l.link ->> 'href' as href
  from public.organizations o
 cross join lateral jsonb_array_elements(
         case when jsonb_typeof(o.nav_overrides -> 'custom') = 'array'
              then o.nav_overrides -> 'custom' else '[]'::jsonb end) as l(link)
 where l.link ->> 'section' in ('fulfillment', 'purchasing', 'insights')
 order by o.name, l.link ->> 'section', l.link ->> 'label';
```

- **No rows:** nothing to do. Roll back.
- **Rows:** note how many organizations they cover. Part 3 should change that
  many.

## Part 2: data dump (before any write)

Take a data dump before any write, as for any change to production data, for
example `pnpm exec supabase db dump --linked --data-only -f <file>` from a
machine linked to production. Keep the file out of the repository. Part 3 also
records each organization's saved navigation as it was, in the audit row it
writes.

## Part 3: the update (not run; the owner authorises)

Moves every custom link saved under fulfillment, purchasing or insights to
inventory and changes nothing else: not the link's id, label, address, icon or
place in the list, and no other key of `nav_overrides`. It writes one
`nav_overrides.updated` audit row per organization it changes, with the saved
navigation before and after, no user, and this runbook's path.

Why Inventory for all three: the earlier Inventory section held every link
that moved to Fulfillment and Purchasing, and Reports. A custom link is drawn
at the end of its section, so the end of Inventory is the spot just above
Workspace, where the new sections were drawn. In Workspace, a link would be
drawn below every Workspace link.

Why the order lists stay: the earlier build ignores them, so leaving them
breaks nothing, and a later roll forward reads them again. Folding them into
`order.inventory` faithfully would need each section's default order, which
only the code knows, and a plain append would put Orders above Items for an
organization that never saved an Inventory order.

The block runs as one transaction in any SQL client. It writes only when every
check passes: the number of organizations changed equals the number that had
such a link, no link is left under fulfillment, purchasing or insights, and no
organization changed beyond a link's section. Otherwise it raises an error
naming the counts, and nothing is written. An admin saving Settings >
Navigation while it runs makes the counts differ; run it again.

```sql
do $$
declare
  v_expected int;
  v_written int;
  v_left int;
  v_damaged int;
begin
  -- Organizations with a custom link under a section the regroup added.
  select count(*) into v_expected
    from public.organizations o
   where exists (
           select 1
             from jsonb_array_elements(
                    case when jsonb_typeof(o.nav_overrides -> 'custom') = 'array'
                         then o.nav_overrides -> 'custom' else '[]'::jsonb end) as l(link)
            where l.link ->> 'section' in ('fulfillment', 'purchasing', 'insights'));

  -- Move those links to inventory and write one audit row per organization.
  with targets as (
    select o.id, o.nav_overrides as before
      from public.organizations o
     where exists (
             select 1
               from jsonb_array_elements(
                      case when jsonb_typeof(o.nav_overrides -> 'custom') = 'array'
                           then o.nav_overrides -> 'custom' else '[]'::jsonb end) as l(link)
              where l.link ->> 'section' in ('fulfillment', 'purchasing', 'insights'))
  ),
  moved as (
    update public.organizations o
       set nav_overrides = jsonb_set(
             t.before, '{custom}',
             (select jsonb_agg(
                       case when l.link ->> 'section' in ('fulfillment', 'purchasing', 'insights')
                            then jsonb_set(l.link, '{section}', '"inventory"'::jsonb)
                            else l.link end
                       order by l.ord)
                from jsonb_array_elements(t.before -> 'custom') with ordinality as l(link, ord)))
      from targets t
     where o.id = t.id
       and o.nav_overrides = t.before -- not saved again since it was read
    returning o.id, t.before, o.nav_overrides as after
  )
  insert into public.audit_logs (organization_id, user_id, event, ip, user_agent, metadata)
  select m.id, null, 'nav_overrides.updated', null, null,
         jsonb_build_object(
           'entity_type', 'organization',
           'entity_id', m.id,
           'warehouse_id', null,
           'before', jsonb_build_object('navOverrides', m.before),
           'after', jsonb_build_object('navOverrides', m.after),
           'reason', 'Moved the custom links saved under Fulfillment, Purchasing or Insights to Inventory before the web was rolled back past the 2026-10-19 navigation regroup.',
           'runbook', 'docs/runbooks/2026-10-19-nav-sections-rollback.md')
    from moved m;
  get diagnostics v_written = row_count;

  -- Custom links still under a section the regroup added (must be 0).
  select count(*) into v_left
    from public.organizations o
   cross join lateral jsonb_array_elements(
           case when jsonb_typeof(o.nav_overrides -> 'custom') = 'array'
                then o.nav_overrides -> 'custom' else '[]'::jsonb end) as l(link)
   where l.link ->> 'section' in ('fulfillment', 'purchasing', 'insights');

  -- Organizations this run changed beyond a link's section (must be 0).
  select count(*) into v_damaged
    from public.audit_logs a
   where a.event = 'nav_overrides.updated'
     and a.metadata ->> 'runbook' = 'docs/runbooks/2026-10-19-nav-sections-rollback.md'
     and a.created_at = now() -- written by this transaction
     and ((a.metadata -> 'before' -> 'navOverrides') - 'custom'
            is distinct from (a.metadata -> 'after' -> 'navOverrides') - 'custom'
          or jsonb_array_length(a.metadata -> 'before' -> 'navOverrides' -> 'custom')
            <> jsonb_array_length(a.metadata -> 'after' -> 'navOverrides' -> 'custom')
          or exists (
               select 1
                 from jsonb_array_elements(a.metadata -> 'before' -> 'navOverrides' -> 'custom')
                        with ordinality as b(link, ord)
                 join jsonb_array_elements(a.metadata -> 'after' -> 'navOverrides' -> 'custom')
                        with ordinality as c(link, ord) on c.ord = b.ord
                where case when jsonb_typeof(b.link) = 'object' then b.link - 'section' else b.link end
                        is distinct from
                      case when jsonb_typeof(c.link) = 'object' then c.link - 'section' else c.link end
                   or (c.link ->> 'section') is distinct from
                      (case when b.link ->> 'section' in ('fulfillment', 'purchasing', 'insights')
                            then 'inventory' else b.link ->> 'section' end)));

  if v_written <> v_expected or v_left <> 0 or v_damaged <> 0 then
    raise exception 'Nothing was written: % organization(s) had a link to move, % changed, % link(s) left under fulfillment, purchasing or insights, % changed beyond a section',
      v_expected, v_written, v_left, v_damaged;
  end if;
  raise notice 'Moved the links of % organization(s) to Inventory', v_written;
end
$$;
```

Then read what was written (read-only). The organizations should be the ones
Part 1 listed:

```sql
select o.name as organization,
       a.organization_id,
       a.created_at,
       (select string_agg((b.link ->> 'label') || ' (was ' || (b.link ->> 'section') || ')', ', ' order by b.ord)
          from jsonb_array_elements(a.metadata -> 'before' -> 'navOverrides' -> 'custom')
                 with ordinality as b(link, ord)
         where b.link ->> 'section' in ('fulfillment', 'purchasing', 'insights')) as moved_to_inventory
  from public.audit_logs a
  join public.organizations o on o.id = a.organization_id
 where a.event = 'nav_overrides.updated'
   and a.metadata ->> 'runbook' = 'docs/runbooks/2026-10-19-nav-sections-rollback.md'
 order by a.created_at desc, o.name;
```

## Part 4: roll back, then check again

Roll the web back. Once the earlier build is live, run Part 1 again: it must
return no rows. A row means an admin saved Settings > Navigation between
Part 3 and the rollback going live and put a link back under a new section.
Run Part 3 again; it changes only those organizations. The earlier build
cannot save a link under a new section, so one check after the rollback is
enough.

## Rolling forward again

On a build with the regroup, the moved links stay under Inventory, and the
order lists Part 3 left in place apply again, unless an admin saved Settings >
Navigation on the earlier build, whose editor drops them. Each Part 3 audit
row keeps the organization's saved navigation as it was
(`metadata.before.navOverrides`). An admin can put a link back by removing it
and adding it again under its section in Settings > Navigation, or that value
can be restored for an organization whose `nav_overrides` still equals the
row's `metadata.after.navOverrides`, so that no later save is overwritten.

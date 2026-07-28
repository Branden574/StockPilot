-- 0302_size_count_product_group.sql
--
-- Re-keys Instant Size Count from the display-only style_key to a real
-- product_group_id.
--
-- WHY: size_count_sessions.style_key is a nullable, unindexed text column
-- holding the output of packages/core/src/inventory/size-run.ts —
-- `stripSizeSuffix(name).toLowerCase()`. That key is derived from the item
-- NAME, so renaming an item silently detaches every historical count from the
-- product it counted. It is also never actually populated: mobile's
-- app/size-count/new.tsx posts only { mode, boxId }.
--
-- style_key is KEPT, not dropped. Existing rows carry it, the display-only
-- fallback still uses it for ungrouped inventory, and dropping it would
-- destroy the little provenance those rows have.
--
-- Instant Size Count remains REVIEW-ONLY (owner decision 2026-07-21): it does
-- not write inventory, and naming a group does not change that. The group is
-- identity, and identity only — product_groups own no quantity, ever.
--
-- This file contains ZERO DML. No insert, no update, no delete, on any table.

alter table public.size_count_sessions
  add column if not exists product_group_id uuid
    references public.product_groups(id) on delete set null;

comment on column public.size_count_sessions.product_group_id is
  'The product group these counted sizes belong to. Replaces the display-only '
  'style_key as the durable identity — style_key is derived from the item NAME '
  'and breaks when an item is renamed. style_key is retained for existing rows '
  'and for ungrouped inventory.';

create index if not exists size_count_sessions_group_idx
  on public.size_count_sessions (product_group_id)
  where product_group_id is not null;

-- ── Org consistency on the new FK ───────────────────────────────────────────
-- A plain FK cannot express "and it must belong to the SAME org", so without
-- this arm a staff member in org B could file their size count under org A's
-- product group: the group id is a client-supplied uuid and nothing else on the
-- insert path checks its org. Same shape and lineage as the charter_in_org /
-- supplier_in_org / product_group_in_org arms added by 0201-0206 and 0298.
--
-- `alter policy ... with check` REPLACES the whole expression, so the CURRENT
-- predicate is reproduced verbatim below (captured from pg_policy at 0301) and
-- the new arm is appended. USING is left untouched by this form.
alter policy size_count_sessions_insert on public.size_count_sessions
  with check (
    (
      (select public.has_org_role(size_count_sessions.organization_id, 'staff'::text))
      and (
        warehouse_id is null
        or (select public.warehouse_in_org(size_count_sessions.warehouse_id, size_count_sessions.organization_id))
      )
    )
    and (select public.product_group_in_org(size_count_sessions.product_group_id, size_count_sessions.organization_id))
  );

alter policy size_count_sessions_update on public.size_count_sessions
  with check (
    (
      (select public.has_org_role(size_count_sessions.organization_id, 'staff'::text))
      and (
        warehouse_id is null
        or (select public.warehouse_in_org(size_count_sessions.warehouse_id, size_count_sessions.organization_id))
      )
    )
    and (select public.product_group_in_org(size_count_sessions.product_group_id, size_count_sessions.organization_id))
  );

-- NO BACKFILL. Mapping an old style_key to a group would be exactly the
-- name-heuristic inference the owner ruled out on 2026-07-27. Historical
-- sessions keep their style_key and no group.

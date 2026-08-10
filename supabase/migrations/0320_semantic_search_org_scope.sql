-- 0320_semantic_search_org_scope.sql
-- HI-3: give the semantic-search match function an ORGANIZATION parameter and
-- filter inside the database. Replaces the org-blind signature from 0094.
--
-- THE BUG
-- -------
-- 0094 created:
--
--   match_inventory_items_by_embedding(p_query vector(1536), p_limit int,
--                                      p_min_score float)
--
-- with this comment: "SECURITY INVOKER so the caller's RLS on inventory_items
-- decides which rows are visible — same org-scoping the rest of the app uses."
--
-- The first half is true. The second half is not. RLS on inventory_items admits
-- every organization the caller is a MEMBER of. That is not the same set as
-- "the organization this request is acting in". Every other read path in the
-- app narrows to one org explicitly on top of RLS (`.eq('organization_id',
-- ctx.organizationId)`); this function had no org parameter, so it could not,
-- and neither did its caller.
--
-- Result: for a user who belongs to more than one organization, an AI chat in
-- org A ranked org B's items by vector similarity and returned their names and
-- quantities into org A's model context. Cosine distance has no notion of
-- tenancy — nothing in the ordering prefers the current org's rows, so the
-- leak is not even probabilistic, it is just whichever rows are semantically
-- closest. The same hole is the one any future "act as / support view" path
-- would fall into.
--
-- THE SIGNATURE DECISION (deliberate, per review requirement)
-- ----------------------------------------------------------
-- The old 3-argument signature is DROPPED, not kept alongside the new one.
--
--   * Keeping it would leave a callable function whose ONLY behaviour is the
--     bug. It is EXECUTE-able by `authenticated`, so any logged-in user could
--     reach the org-blind version directly over PostgREST
--     (POST /rest/v1/rpc/match_inventory_items_by_embedding) and get exactly
--     the cross-org result set this migration exists to prevent. A fix that
--     leaves the vulnerable entry point in place is not a fix.
--   * An overload pair is also an ambiguity trap: a caller that omits p_org_id
--     would silently bind to the unscoped version instead of failing.
--
-- The sole caller (apps/web/src/lib/ai/tools.ts, searchInventorySemantic) is
-- updated in this same change and now passes p_org_id from ctx.organizationId —
-- never from the model.
--
-- SAFE TO APPLY BEFORE THE CODE DEPLOYS
-- -------------------------------------
-- Required by our migration-first rule, and it holds. In the window where this
-- migration is live but the old code is still serving, the old 3-argument call
-- finds no matching function and PostgREST returns an error. searchInventorySemantic
-- already handles that path: it returns `{ error: 'search_failed' }`, and
-- SYSTEM_PROMPT instructs the model to fall back to keyword searchInventory
-- automatically without bothering the user. So the interim degrades semantic
-- search to keyword search — it does not error a page, break a write, or widen
-- exposure. Failing closed is the correct direction for this window.
--
-- p_org_id is placed FIRST and has no default, on purpose: a future caller
-- cannot forget it, because omitting it is a hard "function does not exist".
--
-- GRANTS
-- ------
-- Per the precedent set in 0318: Postgres defaults every new function to
-- EXECUTE TO PUBLIC, and this project additionally runs Supabase's default
-- privileges granting execute to anon/authenticated/service_role — so a `create
-- function` with no grant statements is OPEN to anonymous callers, and
-- revoking from PUBLIC alone does not close anon. Both grantees are named
-- explicitly below. 0094 got this right for the old signature; the new one
-- needs its own grants because it is a new function, not a replacement.
--
-- SECURITY INVOKER is retained deliberately (0094's posture, and the right one
-- here): RLS on inventory_items stays in force and is now ANDed with the
-- explicit org filter, so the two controls are independent. A SECURITY DEFINER
-- version would have to re-implement the membership check itself and would
-- turn any bug in that check into a full cross-tenant read.
--
-- search_path is pinned (`public, extensions`) — extensions is required for the
-- vector type and the <=> operator. Without the pin, a caller-controlled
-- search_path could resolve `inventory_items` or the operator to something
-- else. The old 0094 definition had no pin.

-- Drop the org-blind version. Named with its full argument list so this is
-- unambiguous even if other overloads ever exist.
drop function if exists public.match_inventory_items_by_embedding(
  extensions.vector(1536), int, float
);

-- Org-scoped replacement. Body is 0094's, plus the organization_id predicate.
create or replace function public.match_inventory_items_by_embedding(
  p_org_id    uuid,
  p_query     extensions.vector(1536),
  p_limit     int default 10,
  p_min_score float default 0.0
) returns table (
  id          uuid,
  name        text,
  sku         text,
  warehouse_id uuid,
  quantity_on_hand numeric,
  similarity  float
)
language plpgsql
security invoker
stable
set search_path to 'public', 'extensions'
as $$
begin
  if p_org_id is null then
    raise exception 'p_org_id is required';
  end if;

  return query
  select
    i.id,
    i.name,
    i.sku,
    i.warehouse_id,
    i.quantity_on_hand,
    (1 - (i.embedding <=> p_query))::float as similarity
  from public.inventory_items i
  where i.organization_id = p_org_id
    and i.embedding is not null
    and i.deleted_at is null
    and i.status = 'active'
    and (1 - (i.embedding <=> p_query)) >= p_min_score
  order by i.embedding <=> p_query
  limit greatest(1, least(p_limit, 50));
end;
$$;

-- Grants. `revoke ... from public, anon` closes both the Postgres PUBLIC
-- default and the direct anon=X entry Supabase's default privileges add; the
-- explicit grant states the intended end state so the revoke cannot strip the
-- privilege we mean to keep (0318's reasoning).
revoke execute on function public.match_inventory_items_by_embedding(
  uuid, extensions.vector(1536), int, float
) from public, anon;
grant execute on function public.match_inventory_items_by_embedding(
  uuid, extensions.vector(1536), int, float
) to authenticated, service_role;

comment on function public.match_inventory_items_by_embedding(
  uuid, extensions.vector(1536), int, float
) is
  'Vector similarity search over inventory_items.embedding, scoped to one organization. p_org_id is REQUIRED and must come from the server-side request context, never from a model or a client body — RLS alone is not org scoping, because it admits every org the caller belongs to (mig 0320, HI-3).';

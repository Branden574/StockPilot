-- 0350_location_facts_gate_and_catalog_metadata.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Three catalog-level corrections found by the 2026-09-05 sweep. One closes a
-- tenant-membership oracle; two make the catalog stop lying to the next
-- reviewer. No application change accompanies this migration.
--
-- ═══ 1. _cycle_count_location_facts (0342) gets an in-body gate ═══
--
-- WHAT WAS WRONG (reproduced on the 0347 head in a rolled-back transaction —
-- see supabase/tests/0350_location_facts_gate_and_catalog_metadata.test.sql):
-- the helper is SECURITY DEFINER, `authenticated` holds EXECUTE, and its body
-- had no auth.uid()/membership check at all:
--
--     select l.organization_id, l.warehouse_id, l.kind, l.deleted_at
--       from public.locations l where l.id = p_location_id;
--
-- PostgREST publishes every EXECUTE-able function in `public` at
-- POST /rest/v1/rpc/<name> (the posture 0318 spelled out), so ANY signed-in
-- user — a viewer of an unrelated org, or a user with no org membership at
-- all — could hand it a location uuid picked up from a cycle-count export, a
-- pick slip or a mobile payload and learn which organization and warehouse own
-- it and whether it is archived. RLS on locations (locations_select =
-- is_org_member(organization_id)) denies exactly that read. It is only four
-- metadata fields and no quantities, hence P3 — but it is still a membership
-- oracle that the rest of the schema refuses.
--
-- WHY THIS REVERSES 0346's EXPLICIT "DELIBERATELY NOT GATED" NOTE. 0346 left
-- this helper alone on the reasoning that "reading past RLS is the point — a
-- foreign location must be seen so the post refuses LOUDLY". That reasoning is
-- preserved here, not discarded, because of where the loudness actually lives:
-- post_cycle_count treats a MISS and a foreign org identically —
--
--     select * into v_loc from public._cycle_count_location_facts(...);
--     if not found or v_loc.organization_id is distinct from v_cc.organization_id
--       then raise exception 'cycle_count_location_out_of_org' ... '42501';
--
-- (0343:120-129). A gate that returns zero rows for a foreign location lands on
-- the `not found` half of that same OR and raises the SAME error with the same
-- errcode, at the same point, before any reconciliation runs. What 0342 was
-- protecting against — the pre-0342 behaviour where an invisible row skipped
-- every validation branch and quietly reconciled through Staging — cannot come
-- back, because the miss is a refusal now.
--
-- WHY THE FLOOR IS `manager`, AND WHY DEFINER IS STILL EARNED. The gate mirrors
-- post_cycle_count's own floor (has_org_role(v_cc.organization_id, 'manager'),
-- 0343:52), exactly as 0327's _cycle_count_org_stock_sum mirrors it — "this is
-- what makes the SECURITY DEFINER read grant nothing new". The check is
-- ORG-level, while RLS on locations may narrow further (the AR-2 work already
-- did that to item_stock_levels), so the DEFINER read still does its job: a
-- manager of the owning org sees the location even if a future warehouse- or
-- charter-scoped locations policy would hide it from them. An outsider or an
-- org-less user gets zero rows — fail-closed, which is what RLS would have
-- given them anyway.
--
-- auth.uid() IS NULL is the service_role / postgres path and is left UNCHANGED,
-- the same shape 0331 (apply_level_delta), 0341 (publish_outbox) and 0346 (the
-- three stock helpers) use. anon and PUBLIC hold no EXECUTE, so a null subject
-- means a connection that can already read public.locations directly and is
-- granted nothing by passing through here. Keeping the escape hatch means this
-- migration cannot break a future admin-client caller the way a fail-closed
-- null branch would.
--
-- Signature and grants are re-stated unchanged so post_cycle_count (0343) does
-- NOT have to be re-stated (pattern #24: never re-copy a body you are not
-- changing).
--
-- ═══ 2. _cycle_count_org_stock_sum's catalog comment (0327) ═══
--
-- Its `comment on function` still ends "apply_level_delta's draw-down selection
-- is still caller-scoped, so that narrowing remains blocked (AR-2)". Both
-- halves became false with 0331: apply_level_delta is SECURITY DEFINER with its
-- own staff gate, and item_stock_levels_select was recreated warehouse-scoped.
-- docs/security/SECURITY-INVARIANTS.md s.7 records AR-2 as RESOLVED (0331), and
-- INV-C2 in that document says the CATALOG, not migration prose, is what a
-- reviewer is expected to trust — pg_description IS catalog. A reviewer reading
-- `\df+` or Studio today is told the narrowing is still blocked and could
-- "restore" the org-wide policy. Text corrected; the function is untouched.
--
-- ═══ 3. next_po_number (0005) gets its search_path pin ═══
--
-- 0329's header claims "Every other first-party function already carries
-- `set search_path = public`" and pins 22 by name. next_po_number was not among
-- them and is, on the live catalog, the ONLY non-extension function in `public`
-- with no search_path entry in proconfig. No exploit: it is SECURITY INVOKER,
-- and its body touches only public.purchase_orders (schema-qualified) plus
-- pg_catalog builtins, which resolve first regardless of the session path. The
-- damage is documentary — the repo asserted an invariant it did not hold — so
-- this migration pins it and security_invariants.test.sql now SWEEPS the class
-- (INV-27) instead of enumerating names, which is why 0329's name list could
-- not see the miss. 0329 itself is never edited (migrations are append-only).
--
-- anon's EXECUTE goes at the same time. 0329 closed anon on the user RPCs "that
-- never need it" and missed this one too; it is harmless today (invoker + RLS
-- means an anon caller counts 0 purchase orders) but there is no anon caller,
-- and consistency here is what keeps the sweep honest.
--
-- Everything below is idempotent and safe to re-run.
--
-- ROLLBACK (manual, for reference — do not ship):
--   -- 1. Drop the gate (restores the 0342 body verbatim):
--   --   create or replace function public._cycle_count_location_facts(p_location_id uuid)
--   --   returns table (organization_id uuid, warehouse_id uuid, kind text, deleted_at timestamptz)
--   --   language sql security definer stable set search_path to 'public' as $$
--   --     select l.organization_id, l.warehouse_id, l.kind, l.deleted_at
--   --       from public.locations l where l.id = p_location_id; $$;
--   -- 2. alter function public.next_po_number(uuid) reset search_path;
--   --    grant execute on function public.next_po_number(uuid) to anon;
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. _cycle_count_location_facts: manager of the location's own org ───────
create or replace function public._cycle_count_location_facts(p_location_id uuid)
returns table (organization_id uuid, warehouse_id uuid, kind text, deleted_at timestamptz)
language sql
security definer
stable
set search_path to 'public'
as $function$
  -- *** 0350 authorization gate — see header. ***
  -- has_org_role is ORG-level and reads auth.uid() itself, so:
  --   * the legitimate caller (post_cycle_count, already a manager of the
  --     count's org) sees the row exactly as before, including a location any
  --     narrower RLS policy would hide from them — that is the DEFINER's job;
  --   * a foreign location yields NO ROW, which post_cycle_count's
  --     `if not found or ... is distinct from ...` turns into the SAME
  --     cycle_count_location_out_of_org / 42501 refusal (0343:127);
  --   * an outsider or an org-less user gets no row — fail-closed, and no more
  --     than RLS on locations already gives them;
  --   * auth.uid() IS NULL is the service_role / postgres path, unchanged
  --     (anon and PUBLIC hold no EXECUTE, so a null subject is already trusted).
  select l.organization_id, l.warehouse_id, l.kind, l.deleted_at
    from public.locations l
   where l.id = p_location_id
     and (auth.uid() is null or public.has_org_role(l.organization_id, 'manager'));
$function$;

revoke all on function public._cycle_count_location_facts(uuid) from public, anon;
grant execute on function public._cycle_count_location_facts(uuid) to authenticated, service_role;

comment on function public._cycle_count_location_facts(uuid) is
  'Privileged read of one location''s org/warehouse/kind/deleted_at for post_cycle_count''s counted-location validation (0342). SECURITY DEFINER on purpose: post_cycle_count is SECURITY INVOKER, and a location hidden by a narrower RLS policy would come back "not found" and skip every validation branch. Self-authorizing since 0350 with post_cycle_count''s own gate (has_org_role manager on the LOCATION''s org; service callers with auth.uid() null pass unchanged) — without it any signed-in user could resolve any location uuid to its owning org, which RLS denies. A foreign location now returns no row, which post_cycle_count raises as cycle_count_location_out_of_org (42501), the same refusal it raised before.';

-- ── 2. Correct the stale AR-2 claim in 0327's catalog comment ───────────────
-- Same text as 0327 up to the final sentence; only the AR-2 status changes.
comment on function public._cycle_count_org_stock_sum(uuid, uuid) is
  'Privileged Σ item_stock_levels for one item within one org, for post_cycle_count''s reconciliation (0327). SECURITY DEFINER on purpose: post_cycle_count is SECURITY INVOKER, and computing this sum under the caller''s RLS makes it come back SHORT whenever a holding is hidden from them — the delta is then computed against the wrong base and the RPC writes a WRONG quantity with no error (the 0322 s.4 silent-corruption failure mode). Self-authorizes with post_cycle_count''s own gate (has_org_role manager). This was the prerequisite for warehouse-narrowing item_stock_levels_select, and both halves are now in place: apply_level_delta is SECURITY DEFINER since 0331 with its own staff gate, and item_stock_levels_select is warehouse-scoped since 0331, so AR-2 is RESOLVED (see docs/security/SECURITY-INVARIANTS.md s.7). The 0327 text asserted the opposite and was corrected by 0350.';

-- ── 3. next_po_number: pin search_path, close anon ─────────────────────────
-- ALTER FUNCTION ... SET does not change the body, ownership, or ACLs.
-- ═══ PRODUCTION DRIFT, found while pushing this migration (2026-09-06) ═══
--
-- This statement was written as a bare `alter function` because the LOCAL
-- catalog has next_po_number: a `supabase db reset` replays 0005, which
-- creates it. Production does NOT have it — the push failed here with
-- `function public.next_po_number(uuid) does not exist` (42883).
--
-- The consequence had been live since 2026-05-20 and nothing reported it,
-- because BOTH callers discard the RPC error and fall back:
--     purchase-orders.ts:606 / po-imports.ts:1618
--     const { data } = await supabase.rpc('next_po_number', ...)
--     poNumber = (data as string | null) ?? `PO-${Date.now()}`
-- So every auto-numbered PO in production got an epoch timestamp. Measured on
-- prod before this migration: 27 POs shaped `PO-<13 digits>` (most recent
-- PO-1788277456195), and ZERO of the intended `PO-YYYY-NNNN` shape.
--
-- So: CREATE it (idempotently, byte-identical to 0005 — this is a restore, not
-- a redesign) and then pin the search_path. `create or replace` is a no-op on
-- every environment that already has it.
--
-- BEHAVIOUR CHANGE, deliberate and flagged: once this lands, newly
-- auto-numbered production POs become `PO-2026-NNNN` instead of `PO-<epoch>`.
-- That is the format 0005 always intended. Existing PO numbers are untouched,
-- and no collision is possible — the existing rows are epoch- or
-- supplier-shaped, never `PO-YYYY-NNNN`.
create or replace function public.next_po_number(p_org_id uuid)
returns text
language sql
stable
as $$
  select 'PO-' || to_char(now(), 'YYYY') || '-' || lpad(((
    select count(*) from public.purchase_orders where organization_id = p_org_id
  ) + 1)::text, 4, '0')
$$;

alter function public.next_po_number(uuid) set search_path = public;

revoke execute on function public.next_po_number(uuid) from public, anon;
grant execute on function public.next_po_number(uuid) to authenticated, service_role;

comment on function public.next_po_number(uuid) is
  'Per-org sequential PO number (PO-YYYY-NNNN) generated at approve time (0005). SECURITY INVOKER: the count runs under the caller''s RLS, so it only ever counts purchase orders the caller can see. search_path pinned and anon EXECUTE closed by 0350 — 0329 pinned 22 functions by name and missed this one, which is why INV-27 now sweeps the class instead of listing names.';

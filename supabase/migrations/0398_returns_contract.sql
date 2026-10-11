-- 0398_returns_contract.sql
--
-- RETURNS AND EXCHANGES, SLICE RX-4 (part 2 of 2): the contract (plan
-- stockpilot-work/returns-exchange/plan.md sections 3.8 "Contract" and 4
-- RX-4; brief sections 31, 33, 42). The migration number is a placeholder
-- fixed at push time (plan 1.3).
--
-- RX-1 (0394) expanded: every RMA transition became a gated SECURITY DEFINER
-- function, and the API kept only what old web tabs still sent through the
-- skew window: INSERT on returns and return_lines, and UPDATE on exactly the
-- eight returns columns of the approve, deny, receive and cancel edges. No
-- current code sends them (every app path calls the functions; the census of
-- 2026-10-11 found only reads of both tables in the web, the phone and core),
-- and the push precondition (the rollout kit's R0) is at least 12 hours after
-- RX-1's web deploy. This file takes them away:
--
--   authenticated: INSERT on returns and return_lines, and UPDATE on the
--                  eight returns columns, revoked. SELECT stays (returns_select
--                  and return_lines_select are unchanged).
--   anon:          holds nothing on either table since 0394 (checked below,
--                  before and after).
--   DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN: none since 0394 (the
--                  post-check asks every one of them; fix round 1, desk
--                  check security S3).
--
-- Afterwards the only writers of both tables are the RMA functions (as
-- postgres) and the service role. The four write policies and the two API
-- guards (trg_returns_zz_api_guard, trg_return_lines_zz_api_guard) stay as
-- defence in depth: a grant restored by mistake still meets them.
--
-- Not in this file, on purpose (RX4-NOTES decisions B2 and B3):
--   * the idempotency_keys policy keeps its scopes: every return-scope writer
--     takes over a key row it did not complete and never trusts a stored
--     response (0394 F11 and X4, 0396 change_return_replacement), and a
--     policy statement would make supautils lock every policy_grants table
--     (auth, storage, realtime) at push time;
--   * public.process_return_disposition (the frozen 0359 wrapper) keeps its
--     EXECUTE grants (plan 1.5, P30): a returns:manage holder with write
--     access to the order's warehouse can still close through it, with every
--     stock rule held, but without a decision row or audit (INV-C6 residual).
--
-- No row is written, no function changes and no comment is set. GRANT and
-- REVOKE update the catalog only; they take no lock on returns or
-- return_lines (scripts/db-concurrency/0398_migration_lock_footprint.sh
-- proves it on the local stack), so the file needs no lock prelude.

set lock_timeout = '5s';

-- ═══ 0. Preflight: the expand state, exactly as 0394 left it ══════════════
-- (production, read-only, 2026-10-11: returns and return_lines
-- {postgres=arwdDxtm, authenticated=ar, service_role=arwdDxtm}; the eight
-- returns columns {authenticated=w}; no other column ACL; anon nothing).
-- Anything else is drift: stop before changing anything.
do $preflight$
declare
  v_bad  text := '';
  v_cols text;
begin
  if to_regprocedure('public.close_return_replacement_rest(uuid,integer,text,text)') is null then
    v_bad := v_bad || ' the RX-4 follow-ups are missing (push 0397 first);';
  end if;
  if to_regclass('public.return_exchange_lines') is null then
    v_bad := v_bad || ' the RX-2 objects are missing (push 0396 first);';
  end if;

  if not (has_table_privilege('authenticated', 'public.returns', 'SELECT')
          and has_table_privilege('authenticated', 'public.returns', 'INSERT')
          and has_table_privilege('authenticated', 'public.return_lines', 'SELECT')
          and has_table_privilege('authenticated', 'public.return_lines', 'INSERT')) then
    v_bad := v_bad || ' authenticated does not hold SELECT and INSERT on both tables as 0394 left it;';
  end if;
  if has_table_privilege('authenticated', 'public.returns', 'UPDATE')
     or has_table_privilege('authenticated', 'public.return_lines', 'UPDATE')
     or has_any_column_privilege('authenticated', 'public.return_lines', 'UPDATE')
     or has_table_privilege('authenticated', 'public.returns', 'DELETE')
     or has_table_privilege('authenticated', 'public.return_lines', 'DELETE')
     or has_table_privilege('authenticated', 'public.returns', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.return_lines', 'TRUNCATE') then
    v_bad := v_bad || ' authenticated holds more than 0394 left it;';
  end if;
  if has_any_column_privilege('anon', 'public.returns', 'SELECT, INSERT, UPDATE, REFERENCES')
     or has_any_column_privilege('anon', 'public.return_lines', 'SELECT, INSERT, UPDATE, REFERENCES')
     or has_table_privilege('anon', 'public.returns', 'DELETE')
     or has_table_privilege('anon', 'public.return_lines', 'DELETE') then
    v_bad := v_bad || ' anon holds a privilege on a return table;';
  end if;

  -- Column ACLs: exactly the eight returns columns, update only, for
  -- authenticated alone; none on return_lines.
  select string_agg(c.relname || '.' || a.attname || '=' || a.attacl::text, ',' order by c.relname, a.attname)
    into v_cols
    from pg_attribute a join pg_class c on c.oid = a.attrelid
   where c.oid in ('public.returns'::regclass, 'public.return_lines'::regclass)
     and a.attnum > 0 and not a.attisdropped and a.attacl is not null;
  if v_cols is distinct from
       'returns.approved_at={authenticated=w/postgres},returns.approved_by={authenticated=w/postgres},'
       || 'returns.denial_reason={authenticated=w/postgres},returns.denied_at={authenticated=w/postgres},'
       || 'returns.denied_by={authenticated=w/postgres},returns.received_at={authenticated=w/postgres},'
       || 'returns.received_by={authenticated=w/postgres},returns.status={authenticated=w/postgres}' then
    v_bad := v_bad || format(' column ACLs are not 0394''s (%s);', coalesce(v_cols, 'none'));
  end if;

  if v_bad <> '' then
    raise exception 'rx4_contract_preflight: %', v_bad
      using errcode = '55000', hint = 'rx4_contract_preflight';
  end if;
end
$preflight$;

-- ═══ 1. The contract (plan 3.8) ═══════════════════════════════════════════
revoke insert on public.returns, public.return_lines from authenticated;
revoke update (status, approved_by, approved_at, received_by, received_at, denied_by, denied_at, denial_reason)
  on public.returns from authenticated;

-- ═══ 2. Post-check: authenticated reads, nothing else ═════════════════════
do $postcheck$
declare
  v_bad text := '';
begin
  if not (has_table_privilege('authenticated', 'public.returns', 'SELECT')
          and has_table_privilege('authenticated', 'public.return_lines', 'SELECT')) then
    v_bad := v_bad || ' authenticated lost SELECT;';
  end if;
  if has_any_column_privilege('authenticated', 'public.returns', 'INSERT, UPDATE, REFERENCES')
     or has_any_column_privilege('authenticated', 'public.return_lines', 'INSERT, UPDATE, REFERENCES')
     or has_table_privilege('authenticated', 'public.returns', 'DELETE, TRUNCATE, TRIGGER, MAINTAIN')
     or has_table_privilege('authenticated', 'public.return_lines', 'DELETE, TRUNCATE, TRIGGER, MAINTAIN') then
    v_bad := v_bad || ' authenticated still holds a write privilege;';
  end if;
  if has_any_column_privilege('anon', 'public.returns', 'SELECT, INSERT, UPDATE, REFERENCES')
     or has_any_column_privilege('anon', 'public.return_lines', 'SELECT, INSERT, UPDATE, REFERENCES')
     or has_table_privilege('anon', 'public.returns', 'DELETE, TRUNCATE, TRIGGER, MAINTAIN')
     or has_table_privilege('anon', 'public.return_lines', 'DELETE, TRUNCATE, TRIGGER, MAINTAIN') then
    v_bad := v_bad || ' anon holds a privilege on a return table;';
  end if;
  if exists (select 1 from pg_attribute a
              where a.attrelid in ('public.returns'::regclass, 'public.return_lines'::regclass)
                and a.attnum > 0 and not a.attisdropped and a.attacl is not null) then
    v_bad := v_bad || ' a column ACL is left;';
  end if;
  if not (has_table_privilege('service_role', 'public.returns', 'INSERT, UPDATE, DELETE')
          and has_table_privilege('service_role', 'public.return_lines', 'INSERT, UPDATE, DELETE')) then
    v_bad := v_bad || ' service_role lost a privilege;';
  end if;
  if v_bad <> '' then
    raise exception 'rx4_contract_postcheck: %', v_bad
      using errcode = '55000', hint = 'rx4_contract_postcheck';
  end if;
end
$postcheck$;

reset lock_timeout;

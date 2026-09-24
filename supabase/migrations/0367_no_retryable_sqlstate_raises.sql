-- 0367_no_retryable_sqlstate_raises.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- A function reached through PostgREST must never RAISE SQLSTATE 40001
-- (serialization_failure) for a refusal that will happen again.
--
-- PostgREST before v16 (production runs v14.5) treats 40001 as a transient
-- serialization failure and re-runs the whole transaction, with no retry
-- limit. A refusal that raises 40001 deterministically therefore never
-- returns: the request hangs until the gateway gives up (60 s, 504), and the
-- PostgREST pool connection and its Postgres backend keep re-running the call
-- about 2,000 times a second after the client has gone, until the backend is
-- terminated or PostgREST restarts. Every such call pins one connection of
-- the shared API pool.
-- (https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b)
--
-- Two live functions did exactly that for their idempotency refusal (the same
-- key sent again with a different request):
--   ledger.post_receipt_v2    (public.post_receipt_v2 wrapper, 0359) since 0013
--   ledger.distribute_bundle  (public.distribute_bundle wrapper, 0359) since 0347
-- Reproduced on the local stack pinned to production's images (Postgres
-- 17.6.1.166, PostgREST v14.5): a manager posts a receipt with key K, then
-- posts K again with an edited line -> no response, 3,933 rollbacks in 3 s,
-- still looping after the client disconnected. That second post is not only
-- an abuse path: it is the documented recovery case of the mobile receive
-- screen (first post committed, its answer lost, the receiver edits the
-- quantities and retries), so the "Already received" message the phone and
-- web were built to show could never arrive.
--
-- The fix keeps the message ('idempotency_conflict', which every caller maps
-- on: receiving.ts, bundles.ts, api/v1 receipts, mobile receipt-post-error)
-- and changes only the SQLSTATE to 55000 (object_not_in_prerequisite_state:
-- the key is already bound to another request). No caller maps on the code.
--
-- How: each function is rewritten from its CURRENT definition
-- (pg_get_functiondef) with that one raise changed. The rewrite refuses to
-- run unless the old raise appears exactly once and nothing else in the
-- definition changes, so a definition that drifted from the one this was
-- written against stops the migration instead of being silently replaced.
-- CREATE OR REPLACE keeps the owner, grants, comment, search_path and every
-- other property.
--
-- save_purchase_order_draft (0366) was written with 55000 from the start.
-- supabase/tests/0367_no_retryable_sqlstate_raises.test.sql keeps the class
-- closed: no function outside the system schemas may raise 40001 or 40P01.
--
-- Deploy: independent of any web or mobile build (the message is unchanged).
-- Rollback: none needed; re-raising 40001 would bring the loop back.

set lock_timeout = '5s';

do $migration$
declare
  v_fn     text;
  v_def    text;
  v_new    text;
  v_old    constant text := $q$raise exception 'idempotency_conflict' using errcode = '40001'$q$;
  v_fixed  constant text := $q$raise exception 'idempotency_conflict' using errcode = '55000'$q$;
  v_count  int;
begin
  foreach v_fn in array array[
    'ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)',
    'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'
  ] loop
    v_def := pg_get_functiondef(v_fn::regprocedure);
    v_count := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_count <> 1 then
      raise exception '0367: expected exactly one idempotency_conflict 40001 raise in %, found %', v_fn, v_count;
    end if;
    v_new := replace(v_def, v_old, v_fixed);
    if length(v_new) <> length(v_def) then
      raise exception '0367: rewrite of % changed more than the SQLSTATE', v_fn;
    end if;
    execute v_new;
    if (select p.prosrc ~* $re$errcode\s*=\s*'(40001|40p01)'$re$ from pg_proc p where p.oid = v_fn::regprocedure) then
      raise exception '0367: % still raises a retryable SQLSTATE', v_fn;
    end if;
  end loop;
end
$migration$;

-- The 0347 comment named the old SQLSTATE.
comment on function ledger.distribute_bundle(uuid, numeric, uuid, boolean, uuid, text, text) is
  'Distributes p_quantity kits of a bundle from a warehouse (phantom first, then components). 0347: optional p_idempotency_key (scope bundle_distribution) makes a replay return the original distribution id; same key with a different request raises idempotency_conflict (55000 since 0367; never 40001, which PostgREST retries forever). SECURITY INVOKER; manager floor.';

reset lock_timeout;

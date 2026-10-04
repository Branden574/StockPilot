-- 0392_order_secrets_contract.sql
--
-- SECURITY (slice C, "order secrets, contract", with slice E "delivery write
-- cleanup" and plan section 10 item 14). 0389 (slice B) stored every NEW
-- signature token as its SHA-256 digest and put new return and track tokens
-- in the service-only order_request_secrets. This migration finishes the job
-- for the tokens minted before 0389, and closes the user-client write paths
-- that slices B and D moved into order RPCs:
--
--   1. Live raw signature tokens (an unsigned order at packing_slip_generated,
--      staged_for_pickup, staged_for_delivery or in_transit whose column is
--      not the digest of a side token) are copied to order_request_secrets,
--      so the order page's "Collect signature" link and the warehouse slip's
--      QR still carry them.
--   2. Every raw signature token, live or dead, is replaced in place by its
--      digest. A printed QR or an emailed link still works: the sign route
--      hashes the presented token and compares the column (0389). A digest
--      minted by 0389's generate_order_packing_slips (a side token hashes to
--      it) is left exactly as it is. Dead tokens (signed, cancelled, denied,
--      completed or backordered orders, which can never be signed again) are
--      NOT copied: after this file their raw values exist only in the
--      pre-push backup (R1).
--   3. Return and track tokens move to order_request_secrets with the same
--      values (emailed links keep working) and the order columns are nulled.
--   4. (Not here.) Stored signature images move in 0393, which ships only
--      when the phone update that reads them through the API has reached
--      enough phones (owner decision O1, critique K6). This file leaves
--      signature_data_url untouched and its checks prove it.
--   5. authenticated loses UPDATE on signature_token,
--      signature_token_expires_at and packing_slip_generated_at/by: since
--      0389 only generate_order_packing_slips writes them.
--   6. Slice E: authenticated loses UPDATE on assigned_delivery_user_id,
--      assigned_delivery_by, assigned_delivery_at, in_transit_at and
--      in_transit_by: since 0390 only assign_order_delivery and
--      mark_order_in_transit write them. A raw PATCH can no longer name a
--      driver who is not a member (the 0384 follow-up, plan section 10
--      item 17's prerequisite).
--   7. tg_order_requests_workflow_guard is restated (one body, below):
--        - four edges for API roles, not six: picking_complete ->
--          packing_slip_generated is generate_order_packing_slips' since 0389
--          and staged_for_delivery -> in_transit is mark_order_in_transit's
--          since 0390;
--        - the nine columns of 5 and 6 refused for API roles behind their
--          revokes (column_through_rpc_only), as 0387 holds the approval
--          stamps behind theirs;
--        - item 14: the stamps of the remaining user-client edges change only
--          on their own edge, with *_by the caller (auth.uid()) and *_at the
--          database's clock; denied_reason only on the deny; staged_for_pickup
--          only for a pickup order and staged_for_delivery only for a delivery
--          order (the service checks all of this; the database did not);
--        - (review) the row never takes a return or track token again, for
--          the admin client (service_role) as for the API roles.
--      tg_order_requests_insert_guard is restated too (the 0365 body plus one
--      rule): the admin client may not insert an order carrying a return
--      token, a track token or a signature image. postgres (the order RPCs,
--      FK actions, migrations) is held by neither rule: its writers are the
--      pinned DEFINER bodies (0387 AL9c/AL9d).
--   8. Hygiene: the 9 expired signature tokens of the removed shipments
--      feature are nulled, with shipments.updated_at kept (critique K12).
--
-- ── WHY ITEM 14 IS IN THE GUARD AND NOT IN NEW RPCs (evidence) ───────────
-- After 5 and 6 the user client writes order_requests for exactly four
-- things (services/order-requests.ts at fd7dd1a6): deny (status and
-- denied_reason, compare-and-set on pending_approval), the pick slip (status,
-- pick_slip_generated_at, pick_slip_generated_by = ctx.userId, CAS on
-- approved), staging (status, staged_at, staged_by = ctx.userId, CAS on
-- packing_slip_generated, after the service refused a pickup/delivery
-- mismatch) and the internal notes. ctx.userId is the auth user id of the
-- same session (lib/auth/api-context.ts), so every one of these writes
-- already has exactly the shape the guard now demands: the guard needs no
-- app change, ships with this file, and refuses nothing the app sends.
-- Moving the three edges into SECURITY DEFINER functions instead needs an
-- expand (the functions plus a web deploy) and a contract (the revokes) at
-- least 12 hours apart (Vercel skew protection), so two more slices, with the
-- raw PATCH open until the second; it would also add three DEFINER writers to
-- the 0387 AL9c census, each needing its own gate review, and move the
-- edges' audit rows, emails, webhooks and schedule sync out of the service.
-- The guard keeps the one rule in one place for every API-role update.
-- The *_at stamp of an edge is set by the guard to now() (the clock every
-- order RPC stamps with) rather than checked against the web server's clock:
-- it can then never refuse a legitimate write and never carries a forged
-- time. Item 2 (warehouse scope on these edges) stays a follow-up: not in
-- this batch (plan section 10).
--
-- ── WHO STILL WRITES (unchanged) ─────────────────────────────────────────
-- Every order RPC is SECURITY DEFINER and runs as postgres; the admin client
-- is service_role; FK actions run as the table owner: none is an API role,
-- so the guard lets them all through (0387). The phone never writes the
-- table. The four user-client writes above pass, exactly as they are sent.
-- Old browser tabs (12-hour skew window): this file is pushed at least 12
-- hours after slice B's web deploy (no tab mints or reads the column token
-- through the user client any more) and after slice D's (no tab assigns or
-- marks in transit through it).
--
-- ── DATA SAFETY ───────────────────────────────────────────────────────────
-- The data steps run in ONE DO block that counts and compares before and
-- after each write and raises (P0001, aborting the whole push, nothing
-- applied) on any difference:
--   - every signature token is 64 lowercase hex (else nothing is touched);
--   - digests + raw = every token; no live raw token already belongs to
--     another order's side row; no live raw token sits on an order whose side
--     row holds no signature token (a 0389 digest that lost its side token
--     looks exactly like a raw token: copying it would turn the digest every
--     member could read into a session-free link); the rows copied = the live raw set, and the
--     side copies equal the column values (checksum over id and value);
--   - the rows hashed = the raw set, and every hashed column equals
--     sha256(its old value) (checksum computed before the write); the copied
--     set is the live part of the hashed set; every 0389 digest and every
--     other side token is unchanged; afterwards every unsigned order at a
--     live status with a token has column = sha256(its side token);
--   - every track token is 64 hex; no side return or track token differs
--     from a non-null column, and none belongs to another order; no track
--     token is held by two orders' columns; the rows
--     copied = the orders holding one; every column value is present and
--     equal in the side table BEFORE any column is nulled; the rows nulled =
--     the same set; afterwards no column token remains and the side table's
--     values equal the old column values (checksums);
--   - the shipments rows nulled = the expired-token set, and every other
--     shipments column (updated_at included) is unchanged;
--   - no signature token, on an order or in the side table, moves after
--     steps 1 and 2 (checksum);
--   - every other order_requests column, updated_at and signature_data_url
--     included, is byte for byte unchanged on every row (checksum over
--     to_jsonb(row) minus the three token columns), and both updated_at
--     triggers are enabled again at the end.
-- Only order_requests_set_updated_at and shipments_set_updated_at are
-- disabled, inside that block and only around the writes. The 0387 guard is
-- never disabled: the block runs as postgres, which it lets through. No
-- token value is ever raised, logged or returned: errors carry counts only.
-- Any error the checks do not foresee (a constraint error prints the whole
-- row in its detail; production holds one NOT VALID check) is re-raised as
-- order_secrets_contract_unexpected_error with its SQLSTATE and object names
-- only.
-- Expected at the 2026-10-04 census: step 1 copies 2 (the two signable L4L
-- orders), step 2 hashes 81, step 3 copies 78 orders (48 return and 49 track
-- tokens) and nulls the same 78, step 8 nulls 9 shipments.
-- The data block is not idempotent by design: a dead token it hashed has no
-- side row, so a second run would hash it again. It runs once, as part of
-- this migration; never re-run it by hand.
--
-- ── LOCKS (critique K3) ───────────────────────────────────────────────────
-- The push runs this file as one transaction, so every lock is held to the
-- end. Before anything else touches a table, one prelude takes, all NOWAIT:
--   * order_requests EXCLUSIVE: blocks every writer and SELECT ... FOR
--     UPDATE (ROW SHARE), never a plain read. Without it, ALTER TABLE ...
--     DISABLE TRIGGER's SHARE ROW EXCLUSIVE would let an order RPC lock a row
--     (FOR UPDATE is ROW SHARE) and then wait on the table for its UPDATE
--     while this file's UPDATE waits on that row: a deadlock, which Postgres
--     ends with 40P01 on one side, possibly a customer's hand-over
--     (confirm_order_signature).
--   * order_request_secrets EXCLUSIVE: found in this build. A side-row
--     insert (order_return_token_ensure, the public submit) takes ROW
--     EXCLUSIVE on the side table and inserts its row, then its foreign-key
--     check needs ROW SHARE on order_requests; holding order_requests alone,
--     this file's INSERT ... ON CONFLICT on the same order would wait on
--     that uncommitted row while it waits on this file: the same deadlock.
--   * shipments EXCLUSIVE (step 8; no writer since the feature was removed).
--   * FOR KEY SHARE on the organizations rows the side inserts reference
--     (their foreign-key checks take exactly that): a transaction deleting an
--     organization holds its row and then waits on order_requests.
-- With every lock NOWAIT the file never waits while holding a lock, so it is
-- never part of a wait cycle. A busy instant fails the attempt at once with
-- 55P03; its subtransaction rolls back and releases what it took, and the
-- prelude tries again after 50 to 150 ms holding nothing, up to 40 attempts
-- (the 0390 prelude, proven by 0390_migration_lock_footprint.sh). Only after
-- 40 busy attempts does the file fail with 55P03, apply nothing, and need a
-- re-run off-peak. Inside DO because the CLI batch is not a transaction block
-- (a top-level LOCK TABLE refuses there, 0373). After the prelude no
-- statement waits for a lock (DISABLE/ENABLE TRIGGER's SHARE ROW EXCLUSIVE
-- and COMMENT ON COLUMN's SHARE UPDATE EXCLUSIVE conflict with nothing this
-- file does not already exclude; GRANT/REVOKE and CREATE OR REPLACE FUNCTION
-- take no table lock); lock_timeout 900ms, below deadlock_timeout (1s),
-- bounds anything unforeseen. Plain reads of orders (order pages, RLS
-- subqueries, exports) never wait; order writes and row locks queue for the
-- few hundred milliseconds the file runs. Push off-peak.
--
-- ── NOTIFICATIONS AND REALTIME ────────────────────────────────────────────
-- No step changes a status: trg_order_requests_notify returns at once (no
-- notification, no push), the transition trigger (UPDATE OF status) does not
-- fire, the 0388 marker trigger (UPDATE OF requester_user_id) does not fire.
-- order_requests is in supabase_realtime, so an open order page refreshes
-- once (its payload carries the digest and the nulled columns).
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- The push: P0001 (a data check, message order_secrets_contract_* or
-- order_secret_copy_mismatch, counts in the detail; anything unforeseen as
-- order_secrets_contract_unexpected_error with its SQLSTATE and object names)
-- or 55P03 (busy), each with nothing applied. The guard: 42501 only, hints
-- approval_through_rpc_only, status_through_rpc_only, column_through_rpc_only,
-- stamp_through_edge_only, stamp_by_caller_only, stage_fulfillment_mismatch
-- and secret_through_side_table_only; the insert guard adds
-- secret_through_side_table_only (42501). Never 40001 or 40P01 (PostgREST
-- retries those forever).

set lock_timeout = '900ms';

-- ═══ 0. The lock prelude (critique K3), before anything else touches a table ═
do $c392_lock$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.order_requests in exclusive mode nowait;
      lock table only public.order_request_secrets in exclusive mode nowait;
      lock table only public.shipments in exclusive mode nowait;
      perform 1
        from public.organizations g
       where exists (select 1
                       from public.order_requests o
                      where o.organization_id = g.id
                        and (o.signature_token is not null
                             or o.return_token is not null
                             or o.public_track_token is not null))
         for key share of g nowait;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $c392_lock$;

-- ═══ 1-3 and 8. The data steps, each counted and compared ═════════════════
do $c392_move$
declare
  v_other_before  text;
  v_other_after   text;
  v_tokens        bigint;
  v_bad           bigint;
  v_n             bigint;
  v_sum           text;
  v_digest_ids    uuid[];
  v_digest_sum    text;
  v_raw_ids       uuid[];
  v_raw_sum       text;
  v_live_ids      uuid[];
  v_live_sum      text;
  v_side_other    text;
  v_link_ids      uuid[];
  v_ret_ids       uuid[];
  v_ret_sum       text;
  v_trk_ids       uuid[];
  v_trk_sum       text;
  v_ship_ids      uuid[];
  v_ship_before   text;
  v_ship_after    text;
  v_sig_after     text;
  v_e_state       text;
  v_e_msg         text;
  v_e_table       text;
  v_e_column      text;
  v_e_constraint  text;
begin
  -- Every column the steps do not own, on every order row, updated_at and
  -- signature_data_url included.
  select md5(coalesce(string_agg(o.id::text || ':'
                                 || (to_jsonb(o) - 'signature_token' - 'return_token' - 'public_track_token')::text,
                                 E'\n' order by o.id), ''))
    into v_other_before
    from public.order_requests o;

  alter table public.order_requests disable trigger order_requests_set_updated_at;

  -- ── Signature tokens: classify ──────────────────────────────────────────
  select count(*) into v_tokens from public.order_requests where signature_token is not null;
  select count(*) into v_bad
    from public.order_requests
   where signature_token is not null and signature_token !~ '^[0-9a-f]{64}$';
  if v_bad > 0 then
    raise exception 'order_secrets_contract_token_off_format'
      using errcode = 'P0001',
            detail  = format('%s of %s signature tokens are not 64 lowercase hex characters; nothing was changed.', v_bad, v_tokens);
  end if;

  -- 0389 digests: a side token hashes to the column. Left exactly as they are.
  select coalesce(array_agg(o.id order by o.id), '{}'::uuid[]),
         md5(coalesce(string_agg(o.id::text || ':' || o.signature_token, E'\n' order by o.id), ''))
    into v_digest_ids, v_digest_sum
    from public.order_requests o
   where o.signature_token is not null
     and exists (select 1 from public.order_request_secrets s
                  where s.order_request_id = o.id
                    and s.signature_token is not null
                    and encode(extensions.digest(s.signature_token, 'sha256'), 'hex') = o.signature_token);

  -- Raw: every other token. The checksum is over what each column must hold
  -- after step 2.
  select coalesce(array_agg(o.id order by o.id), '{}'::uuid[]),
         md5(coalesce(string_agg(o.id::text || ':' || encode(extensions.digest(o.signature_token, 'sha256'), 'hex'),
                                 E'\n' order by o.id), ''))
    into v_raw_ids, v_raw_sum
    from public.order_requests o
   where o.signature_token is not null
     and not (o.id = any (v_digest_ids));

  -- Live raw: an unsigned order at a status that can still reach the
  -- hand-over. The checksum is over what the side table must hold after
  -- step 1.
  select coalesce(array_agg(o.id order by o.id), '{}'::uuid[]),
         md5(coalesce(string_agg(o.id::text || ':' || o.signature_token, E'\n' order by o.id), ''))
    into v_live_ids, v_live_sum
    from public.order_requests o
   where o.id = any (v_raw_ids)
     and o.signed_at is null
     and o.status in ('packing_slip_generated', 'staged_for_pickup', 'staged_for_delivery', 'in_transit');

  if cardinality(v_digest_ids) + cardinality(v_raw_ids) <> v_tokens then
    raise exception 'order_secrets_contract_token_count'
      using errcode = 'P0001',
            detail  = format('%s digests and %s raw tokens do not add up to %s tokens; nothing was changed.',
                             cardinality(v_digest_ids), cardinality(v_raw_ids), v_tokens);
  end if;

  select count(*) into v_bad
    from public.order_requests o
    join public.order_request_secrets s
      on s.signature_token = o.signature_token and s.order_request_id <> o.id
   where o.id = any (v_live_ids);
  if v_bad > 0 then
    raise exception 'order_secrets_contract_token_collision'
      using errcode = 'P0001',
            detail  = format('%s live raw tokens already belong to another order''s side row; nothing was changed.', v_bad);
  end if;
  -- A 0389 digest whose side token is gone cannot be told from a raw token
  -- (both 64 hex). Copied as raw, the digest every member could read would
  -- become a session-free link and the printed QR would stop working. A live
  -- raw token on an order that already has a side row without a signature
  -- token is such an orphan, or a pre-deploy tab's mint on an order the
  -- public submit gave a side row; neither can arise once B's 12-hour window
  -- has closed (R0d counts both before the push). Refuse it.
  select count(*) into v_bad
    from public.order_requests o
    join public.order_request_secrets s on s.order_request_id = o.id
   where o.id = any (v_live_ids)
     and s.signature_token is null;
  if v_bad > 0 then
    raise exception 'order_secrets_contract_live_orphan'
      using errcode = 'P0001',
            detail  = format('%s live tokens that no side token hashes to sit on an order whose side row holds no signature token (possibly a 0389 digest that lost its side token); nothing was changed.', v_bad);
  end if;
  -- order_requests_signature_token_idx is unique: a digest that equals
  -- another order's column would stop step 2 half way. Refuse it up front.
  select count(*) into v_bad
    from public.order_requests a
    join public.order_requests b
      on b.signature_token = encode(extensions.digest(a.signature_token, 'sha256'), 'hex')
   where a.id = any (v_raw_ids);
  if v_bad > 0 then
    raise exception 'order_secrets_contract_token_collision'
      using errcode = 'P0001',
            detail  = format('%s raw tokens hash to another order''s column value; nothing was changed.', v_bad);
  end if;

  -- Every side token of an order outside the live set: none may move.
  select md5(coalesce(string_agg(s.order_request_id::text || ':' || coalesce(s.signature_token, '-'),
                                 E'\n' order by s.order_request_id), ''))
    into v_side_other
    from public.order_request_secrets s
   where not (s.order_request_id = any (v_live_ids));

  -- ── Step 1: copy the live raw tokens ────────────────────────────────────
  insert into public.order_request_secrets (order_request_id, organization_id, signature_token)
  select o.id, o.organization_id, o.signature_token
    from public.order_requests o
   where o.id = any (v_live_ids)
  on conflict (order_request_id) do update
    set signature_token = excluded.signature_token,
        updated_at      = now();
  get diagnostics v_n = row_count;
  if v_n <> cardinality(v_live_ids) then
    raise exception 'order_secrets_contract_copy_count'
      using errcode = 'P0001',
            detail  = format('%s side rows written for %s live raw tokens.', v_n, cardinality(v_live_ids));
  end if;
  select md5(coalesce(string_agg(s.order_request_id::text || ':' || s.signature_token, E'\n' order by s.order_request_id), ''))
    into v_sum
    from public.order_request_secrets s
   where s.order_request_id = any (v_live_ids);
  if v_sum is distinct from v_live_sum then
    raise exception 'order_secrets_contract_copy_mismatch'
      using errcode = 'P0001',
            detail  = format('The side copies of %s live raw tokens are not the column values.', cardinality(v_live_ids));
  end if;

  -- ── Step 2: hash every raw token in place ───────────────────────────────
  update public.order_requests o
     set signature_token = encode(extensions.digest(o.signature_token, 'sha256'), 'hex')
   where o.id = any (v_raw_ids);
  get diagnostics v_n = row_count;
  if v_n <> cardinality(v_raw_ids) then
    raise exception 'order_secrets_contract_hash_count'
      using errcode = 'P0001',
            detail  = format('%s rows hashed for %s raw tokens.', v_n, cardinality(v_raw_ids));
  end if;
  select md5(coalesce(string_agg(o.id::text || ':' || coalesce(o.signature_token, '-'), E'\n' order by o.id), ''))
    into v_sum
    from public.order_requests o
   where o.id = any (v_raw_ids);
  if v_sum is distinct from v_raw_sum then
    raise exception 'order_secrets_contract_hash_mismatch'
      using errcode = 'P0001',
            detail  = format('The %s hashed columns are not sha256 of their old values.', cardinality(v_raw_ids));
  end if;

  -- The copied tokens are exactly the live part of the hashed ones, and each
  -- column is now sha256 of its side copy.
  select count(*) into v_bad
    from unnest(v_live_ids) l(id)
    left join public.order_requests o on o.id = l.id
    left join public.order_request_secrets s on s.order_request_id = l.id
   where not (l.id = any (v_raw_ids))
      or s.signature_token is null
      or encode(extensions.digest(s.signature_token, 'sha256'), 'hex') is distinct from o.signature_token;
  if v_bad > 0 then
    raise exception 'order_secrets_contract_live_unverified'
      using errcode = 'P0001',
            detail  = format('%s of %s copied tokens do not verify against their hashed column.', v_bad, cardinality(v_live_ids));
  end if;

  select md5(coalesce(string_agg(o.id::text || ':' || coalesce(o.signature_token, '-'), E'\n' order by o.id), ''))
    into v_sum
    from public.order_requests o
   where o.id = any (v_digest_ids);
  if v_sum is distinct from v_digest_sum then
    raise exception 'order_secrets_contract_digest_moved'
      using errcode = 'P0001',
            detail  = format('A 0389 digest changed (%s digests).', cardinality(v_digest_ids));
  end if;
  select md5(coalesce(string_agg(s.order_request_id::text || ':' || coalesce(s.signature_token, '-'),
                                 E'\n' order by s.order_request_id), ''))
    into v_sum
    from public.order_request_secrets s
   where not (s.order_request_id = any (v_live_ids));
  if v_sum is distinct from v_side_other then
    raise exception 'order_secrets_contract_digest_moved'
      using errcode = 'P0001',
            detail  = 'A side token outside the live set changed.';
  end if;

  select count(*) into v_n from public.order_requests where signature_token is not null;
  select count(*) into v_bad
    from public.order_requests
   where signature_token is not null and signature_token !~ '^[0-9a-f]{64}$';
  if v_n <> v_tokens or v_bad > 0 then
    raise exception 'order_secrets_contract_token_count'
      using errcode = 'P0001',
            detail  = format('%s tokens after (%s before), %s not 64 hex.', v_n, v_tokens, v_bad);
  end if;

  -- Every order that can still be handed over verifies against its side
  -- token: what the order page, the warehouse slip and the sign route read.
  select count(*) into v_bad
    from public.order_requests o
   where o.signature_token is not null
     and o.signed_at is null
     and o.status in ('packing_slip_generated', 'staged_for_pickup', 'staged_for_delivery', 'in_transit')
     and not exists (select 1 from public.order_request_secrets s
                      where s.order_request_id = o.id
                        and s.signature_token is not null
                        and encode(extensions.digest(s.signature_token, 'sha256'), 'hex') = o.signature_token);
  if v_bad > 0 then
    raise exception 'order_secrets_contract_live_unverified'
      using errcode = 'P0001',
            detail  = format('%s unsigned orders at a live status have no side token that hashes to their column.', v_bad);
  end if;

  -- The signature tokens as steps 1 and 2 left them, on the orders and in the
  -- side table (rows holding one; step 3 adds side rows without one): nothing
  -- after this point may move one.
  select md5(coalesce(string_agg(o.id::text || ':' || coalesce(o.signature_token, '-'), E'\n' order by o.id), ''))
         || md5(coalesce((select string_agg(s.order_request_id::text || ':' || coalesce(s.signature_token, '-'),
                                            E'\n' order by s.order_request_id)
                            from public.order_request_secrets s
                           where s.signature_token is not null), ''))
    into v_sig_after
    from public.order_requests o;

  -- ── Step 3: return and track tokens move, same values ───────────────────
  select count(*) into v_bad
    from public.order_requests
   where public_track_token is not null and public_track_token !~ '^[0-9a-f]{64}$';
  if v_bad > 0 then
    raise exception 'order_secrets_contract_track_off_format'
      using errcode = 'P0001',
            detail  = format('%s track tokens are not 64 lowercase hex characters.', v_bad);
  end if;
  select count(*) into v_bad
    from public.order_requests o
    join public.order_request_secrets s on s.order_request_id = o.id
   where (o.return_token is not null and s.return_token is not null and s.return_token <> o.return_token)
      or (o.public_track_token is not null and s.public_track_token is not null and s.public_track_token <> o.public_track_token);
  if v_bad > 0 then
    raise exception 'order_secret_copy_mismatch'
      using errcode = 'P0001',
            detail  = format('%s orders hold a return or track token that differs from their side row.', v_bad);
  end if;
  select count(*) into v_bad
    from public.order_requests o
    join public.order_request_secrets s
      on s.order_request_id <> o.id
     and (s.return_token = o.return_token or s.public_track_token = o.public_track_token);
  if v_bad > 0 then
    raise exception 'order_secrets_contract_link_collision'
      using errcode = 'P0001',
            detail  = format('%s return or track tokens already belong to another order''s side row.', v_bad);
  end if;
  -- The track column has no unique index (the return column has one): a
  -- track token held by two orders would stop the side insert on its unique
  -- key. Refuse it here, with a count.
  select count(*) into v_bad
    from (select o.public_track_token
            from public.order_requests o
           where o.public_track_token is not null
           group by o.public_track_token
          having count(*) > 1) d;
  if v_bad > 0 then
    raise exception 'order_secrets_contract_link_collision'
      using errcode = 'P0001',
            detail  = format('%s track tokens are held by more than one order.', v_bad);
  end if;

  select coalesce(array_agg(o.id order by o.id), '{}'::uuid[])
    into v_link_ids
    from public.order_requests o
   where o.return_token is not null or o.public_track_token is not null;
  select coalesce(array_agg(o.id order by o.id), '{}'::uuid[]),
         md5(coalesce(string_agg(o.id::text || ':' || o.return_token::text, E'\n' order by o.id), ''))
    into v_ret_ids, v_ret_sum
    from public.order_requests o
   where o.return_token is not null;
  select coalesce(array_agg(o.id order by o.id), '{}'::uuid[]),
         md5(coalesce(string_agg(o.id::text || ':' || o.public_track_token, E'\n' order by o.id), ''))
    into v_trk_ids, v_trk_sum
    from public.order_requests o
   where o.public_track_token is not null;

  insert into public.order_request_secrets (order_request_id, organization_id, return_token, public_track_token)
  select o.id, o.organization_id, o.return_token, o.public_track_token
    from public.order_requests o
   where o.id = any (v_link_ids)
  on conflict (order_request_id) do update
    set return_token       = coalesce(public.order_request_secrets.return_token, excluded.return_token),
        public_track_token = coalesce(public.order_request_secrets.public_track_token, excluded.public_track_token),
        updated_at         = now();
  get diagnostics v_n = row_count;
  if v_n <> cardinality(v_link_ids) then
    raise exception 'order_secrets_contract_link_count'
      using errcode = 'P0001',
            detail  = format('%s side rows written for %s orders holding a return or track token.', v_n, cardinality(v_link_ids));
  end if;

  -- Every value is in the side table, equal, before any column is nulled.
  select count(*) into v_bad
    from public.order_requests o
    left join public.order_request_secrets s on s.order_request_id = o.id
   where o.id = any (v_link_ids)
     and ((o.return_token is not null and s.return_token is distinct from o.return_token)
          or (o.public_track_token is not null and s.public_track_token is distinct from o.public_track_token));
  if v_bad > 0 then
    raise exception 'order_secret_copy_mismatch'
      using errcode = 'P0001',
            detail  = format('%s orders'' return or track tokens are not in the side table; no column was nulled.', v_bad);
  end if;

  update public.order_requests o
     set return_token       = null,
         public_track_token = null
   where o.id = any (v_link_ids);
  get diagnostics v_n = row_count;
  if v_n <> cardinality(v_link_ids) then
    raise exception 'order_secrets_contract_link_count'
      using errcode = 'P0001',
            detail  = format('%s rows nulled for %s orders holding a return or track token.', v_n, cardinality(v_link_ids));
  end if;
  select count(*) into v_bad
    from public.order_requests
   where return_token is not null or public_track_token is not null;
  if v_bad > 0 then
    raise exception 'order_secrets_contract_link_left'
      using errcode = 'P0001',
            detail  = format('%s orders still hold a return or track token in their columns.', v_bad);
  end if;
  select md5(coalesce(string_agg(s.order_request_id::text || ':' || coalesce(s.return_token::text, '-'),
                                 E'\n' order by s.order_request_id), ''))
    into v_sum
    from public.order_request_secrets s
   where s.order_request_id = any (v_ret_ids);
  if v_sum is distinct from v_ret_sum then
    raise exception 'order_secret_copy_mismatch'
      using errcode = 'P0001',
            detail  = format('The side table does not hold the %s return tokens the columns held.', cardinality(v_ret_ids));
  end if;
  select md5(coalesce(string_agg(s.order_request_id::text || ':' || coalesce(s.public_track_token, '-'),
                                 E'\n' order by s.order_request_id), ''))
    into v_sum
    from public.order_request_secrets s
   where s.order_request_id = any (v_trk_ids);
  if v_sum is distinct from v_trk_sum then
    raise exception 'order_secret_copy_mismatch'
      using errcode = 'P0001',
            detail  = format('The side table does not hold the %s track tokens the columns held.', cardinality(v_trk_ids));
  end if;

  -- ── Step 8: the removed shipments feature's expired tokens (K12) ────────
  select md5(coalesce(string_agg(s.id::text || ':'
                                 || (to_jsonb(s) - 'signature_token' - 'signature_token_expires_at')::text,
                                 E'\n' order by s.id), ''))
    into v_ship_before
    from public.shipments s;
  select coalesce(array_agg(s.id order by s.id), '{}'::uuid[])
    into v_ship_ids
    from public.shipments s
   where s.signature_token is not null and s.signature_token_expires_at < now();

  alter table public.shipments disable trigger shipments_set_updated_at;
  update public.shipments s
     set signature_token            = null,
         signature_token_expires_at = null
   where s.id = any (v_ship_ids);
  get diagnostics v_n = row_count;
  alter table public.shipments enable trigger shipments_set_updated_at;
  if v_n <> cardinality(v_ship_ids) then
    raise exception 'order_secrets_contract_shipments_count'
      using errcode = 'P0001',
            detail  = format('%s shipments nulled for %s expired tokens.', v_n, cardinality(v_ship_ids));
  end if;
  select md5(coalesce(string_agg(s.id::text || ':'
                                 || (to_jsonb(s) - 'signature_token' - 'signature_token_expires_at')::text,
                                 E'\n' order by s.id), ''))
    into v_ship_after
    from public.shipments s;
  if v_ship_after is distinct from v_ship_before then
    raise exception 'order_secrets_contract_shipments_changed'
      using errcode = 'P0001',
            detail  = 'A shipments column other than the two token columns changed (updated_at included).';
  end if;

  alter table public.order_requests enable trigger order_requests_set_updated_at;

  -- ── Nothing else moved ──────────────────────────────────────────────────
  select md5(coalesce(string_agg(o.id::text || ':' || coalesce(o.signature_token, '-'), E'\n' order by o.id), ''))
         || md5(coalesce((select string_agg(s.order_request_id::text || ':' || coalesce(s.signature_token, '-'),
                                            E'\n' order by s.order_request_id)
                            from public.order_request_secrets s
                           where s.signature_token is not null), ''))
    into v_sum
    from public.order_requests o;
  if v_sum is distinct from v_sig_after then
    raise exception 'order_secrets_contract_signature_moved'
      using errcode = 'P0001',
            detail  = 'A signature token, on an order or in the side table, changed after steps 1 and 2.';
  end if;

  select md5(coalesce(string_agg(o.id::text || ':'
                                 || (to_jsonb(o) - 'signature_token' - 'return_token' - 'public_track_token')::text,
                                 E'\n' order by o.id), ''))
    into v_other_after
    from public.order_requests o;
  if v_other_after is distinct from v_other_before then
    raise exception 'order_secrets_contract_other_columns_changed'
      using errcode = 'P0001',
            detail  = 'An order column other than the three token columns changed (updated_at and signature_data_url included).';
  end if;

  select count(*) into v_bad
    from pg_trigger t
   where t.tgname in ('order_requests_set_updated_at', 'shipments_set_updated_at')
     and t.tgrelid in ('public.order_requests'::regclass, 'public.shipments'::regclass)
     and t.tgenabled <> 'O';
  if v_bad > 0 then
    raise exception 'order_secrets_contract_trigger_state'
      using errcode = 'P0001',
            detail  = format('%s updated_at triggers are not enabled again.', v_bad);
  end if;
exception
  -- Busy (lock_timeout): its message names no value; nothing was applied.
  when lock_not_available then
    raise;
  -- Anything else: the block's own checks pass through as they are (counts
  -- only). Any other error (a constraint the prechecks did not foresee, such
  -- as a NOT VALID check a row breaks when it is rewritten) would print the
  -- whole row in its detail, raw link tokens and the image included, to the
  -- push output and the database log: it is re-raised with its SQLSTATE and
  -- object names only. Everything the block did is undone either way.
  when others then
    get stacked diagnostics v_e_state = returned_sqlstate, v_e_msg = message_text,
                            v_e_table = table_name, v_e_column = column_name, v_e_constraint = constraint_name;
    if v_e_state = 'P0001' and v_e_msg ~ '^order_secret(s_contract_[a-z_]+|_copy_mismatch)$' then
      raise;
    end if;
    raise exception 'order_secrets_contract_unexpected_error'
      using errcode = 'P0001',
            detail  = format('SQLSTATE %s (table %s, column %s, constraint %s); nothing was changed. The message and detail are withheld: they can carry a token.',
                             v_e_state, coalesce(nullif(v_e_table, ''), '-'), coalesce(nullif(v_e_column, ''), '-'),
                             coalesce(nullif(v_e_constraint, ''), '-'));
end $c392_move$;

-- ═══ 5 and 6. The write side: the order RPCs alone (slices C and E) ═══════
-- The mint is generate_order_packing_slips' since 0389; the delivery
-- assignment and the in-transit mark are assign_order_delivery's and
-- mark_order_in_transit's since 0390. No user-client path writes these.
revoke update (signature_token, signature_token_expires_at,
               packing_slip_generated_at, packing_slip_generated_by)
  on table public.order_requests from authenticated;
revoke update (assigned_delivery_user_id, assigned_delivery_by, assigned_delivery_at,
               in_transit_at, in_transit_by)
  on table public.order_requests from authenticated;

-- ═══ 7. The workflow guard, restated (0387 + slices C and E + item 14) ════
create or replace function public.tg_order_requests_workflow_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid;
begin
  -- Only the API roles are held here. The order RPCs are SECURITY DEFINER and
  -- run as postgres, the server's admin client is service_role, and foreign-key
  -- actions (approved_by ON DELETE SET NULL) run as the table owner, so none of
  -- them is 'authenticated' or 'anon' here. SECURITY INVOKER on purpose: a
  -- DEFINER trigger always sees postgres and would never enforce. Never key
  -- this on auth.uid() or JWT claims: a DEFINER body and a cascade still carry
  -- the caller's JWT (0359).
  --
  -- 0392: the return and track tokens live in order_request_secrets, so the
  -- member-readable row never takes one again: held for the admin client
  -- (service_role) too. postgres is not held: the order RPCs and FK actions
  -- run as it, and its writers are pinned DEFINER bodies. A value already on
  -- a row may stay through another write or be cleared.
  if current_user in ('authenticated', 'anon', 'service_role')
     and ((new.return_token is not null and new.return_token is distinct from old.return_token)
          or (new.public_track_token is not null and new.public_track_token is distinct from old.public_track_token)) then
    raise exception 'order_secret_through_side_table_only'
      using errcode = '42501',
            hint    = 'secret_through_side_table_only',
            detail  = 'An order''s return and track tokens live in order_request_secrets since 0392; the order row never carries one.';
  end if;

  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if new.approved_by is distinct from old.approved_by
     or new.approved_at is distinct from old.approved_at then
    raise exception 'order_approval_through_rpc_only'
      using errcode = '42501',
            hint    = 'approval_through_rpc_only',
            detail  = 'An order''s approver and approval time are set only by approve_order_request or approve_partial.';
  end if;

  -- The edge, never the value: a notes save on an approved order keeps
  -- status = 'approved' and must pass. Four edges since 0392: the packing
  -- slip is generate_order_packing_slips' (0389) and in transit is
  -- mark_order_in_transit's (0390).
  if new.status is distinct from old.status
     and (old.status, new.status) not in (
       ('pending_approval',       'denied'),
       ('approved',               'pick_slip_generated'),
       ('packing_slip_generated', 'staged_for_pickup'),
       ('packing_slip_generated', 'staged_for_delivery')
     ) then
    raise exception 'order_status_through_rpc_only'
      using errcode = '42501',
            hint    = 'status_through_rpc_only',
            detail  = format('An order moves from %s to %s only through its order action.', old.status, new.status);
  end if;

  -- 0392: the columns only an order RPC writes since 0389 and 0390, held here
  -- behind their column revokes, as the approval stamps are.
  if new.signature_token is distinct from old.signature_token
     or new.signature_token_expires_at is distinct from old.signature_token_expires_at
     or new.packing_slip_generated_at is distinct from old.packing_slip_generated_at
     or new.packing_slip_generated_by is distinct from old.packing_slip_generated_by
     or new.assigned_delivery_user_id is distinct from old.assigned_delivery_user_id
     or new.assigned_delivery_by is distinct from old.assigned_delivery_by
     or new.assigned_delivery_at is distinct from old.assigned_delivery_at
     or new.in_transit_at is distinct from old.in_transit_at
     or new.in_transit_by is distinct from old.in_transit_by then
    raise exception 'order_column_through_rpc_only'
      using errcode = '42501',
            hint    = 'column_through_rpc_only',
            detail  = 'An order''s signature token, packing-slip stamps, delivery driver and in-transit stamps are set only by their order actions.';
  end if;

  -- 0392 (item 14): each remaining stamp changes only on its own edge, by the
  -- caller, at the database's clock.
  v_uid := auth.uid();

  if new.denied_reason is distinct from old.denied_reason
     and not (old.status = 'pending_approval' and new.status = 'denied') then
    raise exception 'order_stamp_through_edge_only'
      using errcode = '42501',
            hint    = 'stamp_through_edge_only',
            detail  = 'A denial reason is written only with the denial itself.';
  end if;

  if old.status = 'approved' and new.status = 'pick_slip_generated' then
    if v_uid is null or new.pick_slip_generated_by is distinct from v_uid then
      raise exception 'order_stamp_not_caller'
        using errcode = '42501',
              hint    = 'stamp_by_caller_only',
              detail  = 'A pick slip is stamped with the id of the person who generates it.';
    end if;
    new.pick_slip_generated_at := now();
  elsif new.pick_slip_generated_at is distinct from old.pick_slip_generated_at
        or new.pick_slip_generated_by is distinct from old.pick_slip_generated_by then
    raise exception 'order_stamp_through_edge_only'
      using errcode = '42501',
            hint    = 'stamp_through_edge_only',
            detail  = 'The pick-slip stamps are written only with the pick slip itself.';
  end if;

  if old.status = 'packing_slip_generated' and new.status in ('staged_for_pickup', 'staged_for_delivery') then
    if (new.status = 'staged_for_pickup' and new.fulfillment_type is distinct from 'pickup')
       or (new.status = 'staged_for_delivery' and new.fulfillment_type is distinct from 'delivery') then
      raise exception 'order_stage_fulfillment_mismatch'
        using errcode = '42501',
              hint    = 'stage_fulfillment_mismatch',
              detail  = 'A pickup order is staged for pickup and a delivery order for delivery.';
    end if;
    if v_uid is null or new.staged_by is distinct from v_uid then
      raise exception 'order_stamp_not_caller'
        using errcode = '42501',
              hint    = 'stamp_by_caller_only',
              detail  = 'Staging is stamped with the id of the person who stages the order.';
    end if;
    new.staged_at := now();
  elsif new.staged_at is distinct from old.staged_at
        or new.staged_by is distinct from old.staged_by then
    raise exception 'order_stamp_through_edge_only'
      using errcode = '42501',
            hint    = 'stamp_through_edge_only',
            detail  = 'The staging stamps are written only with the staging itself.';
  end if;

  return new;
end;
$$;

comment on function public.tg_order_requests_workflow_guard() is
  'BEFORE UPDATE guard (0387, restated by 0392): an API-role caller may not change approved_by or '
  'approved_at; may change status only along the four edges the app writes through the user client '
  '(deny, pick slip, staging for pickup or for delivery); may not change the signature token, the '
  'packing-slip stamps, the delivery driver or the in-transit stamps (their order RPCs own them); and '
  'changes denied_reason only on the deny, the pick-slip and staging stamps only on their own edge with '
  '*_by the caller (*_at is set to now()), and stages a pickup order only for pickup and a delivery '
  'order only for delivery. The order RPCs (SECURITY DEFINER), the admin client and FK actions are not '
  'API roles and pass those rules. Neither an API role nor the admin client (service_role) may put a '
  'return or track token on the row (they live in order_request_secrets since 0392).';

revoke all on function public.tg_order_requests_workflow_guard() from public, anon, authenticated;

-- ═══ The insert guard, restated (0365 + one rule): no secret on a new row ═
-- The 0365 body, unchanged for the API roles, plus: the admin client
-- (service_role) may not insert an order carrying a return token, a track
-- token or a signature image (they live in order_request_secrets; the public
-- submit has written its track token there since 0389). postgres is not
-- held (DEFINER bodies, migrations), as before.
create or replace function public.tg_order_requests_insert_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    if current_user = 'service_role'
       and num_nonnulls(new.return_token, new.public_track_token, new.signature_data_url) > 0 then
      raise exception 'order_secret_through_side_table_only'
        using errcode = '42501',
              hint    = 'secret_through_side_table_only',
              detail  = 'An order''s return and track tokens and its signature image live in order_request_secrets since 0392; a new order row never carries one.';
    end if;
    return new;
  end if;
  if new.status is distinct from 'pending_approval' then
    raise exception 'A new order request starts pending approval.'
      using errcode = '42501';
  end if;
  if num_nonnulls(
       new.approved_by, new.approved_at, new.denied_reason, new.packaging_at, new.ready_at,
       new.delivered_at, new.cancelled_at, new.cancelled_by, new.confirmation_token_hash,
       new.confirmation_token_expires_at, new.assigned_picker_id, new.pick_slip_generated_at,
       new.pick_slip_generated_by, new.picking_completed_at, new.picking_completed_by,
       new.packing_slip_generated_at, new.packing_slip_generated_by, new.staged_at, new.staged_by,
       new.assigned_delivery_user_id, new.assigned_delivery_by, new.assigned_delivery_at,
       new.in_transit_at, new.in_transit_by, new.signature_token, new.signature_token_expires_at,
       new.signed_by_name, new.signed_by_email, new.signature_data_url, new.signed_at,
       new.completed_at, new.completed_by, new.return_token, new.picking_claimed_at,
       new.picking_claimed_by, new.signature_method, new.return_prompt_sent_at,
       new.public_track_token, new.customer_id) > 0 then
    raise exception 'A new order request cannot carry approval, picking, delivery or signature details.'
      using errcode = '42501';
  end if;
  new.created_at := now();
  return new;
end;
$$;

comment on function public.tg_order_requests_insert_guard() is
  'BEFORE INSERT guard (0365, restated by 0392): an API-role order request starts pending approval with '
  'every workflow column empty and a database creation time; the admin client (service_role) may not '
  'insert an order carrying a return token, a track token or a signature image (order_request_secrets '
  'holds them since 0392).';

revoke all on function public.tg_order_requests_insert_guard() from public, anon, authenticated;

-- ═══ The order columns say what they now hold ═════════════════════════════
comment on column public.order_requests.signature_token is
  'sha256 hex of the raw signature token, which lives only in order_request_secrets (0389 for new '
  'mints; 0392 hashed every older raw value in place and copied the live ones to the side table). '
  'Written only by generate_order_packing_slips (authenticated holds no UPDATE on it since 0392). '
  'confirm_order_signature compares this column with its argument, so the sign route passes the digest. '
  'Cleared by reopen_picking and resume_fulfillment.';
comment on column public.order_requests.return_token is
  'Always null since 0392: the requester return token lives in order_request_secrets.return_token '
  '(order_return_token_ensure). Kept for older readers; nothing writes it.';
comment on column public.order_requests.public_track_token is
  'Always null since 0392: the public track token lives in order_request_secrets.public_track_token '
  '(written by the public submit). Kept for older readers; nothing writes it.';

reset lock_timeout;

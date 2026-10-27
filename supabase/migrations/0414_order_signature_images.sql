-- 0403_order_signature_images.sql
--
-- SECURITY (slice C step 4, owner decision O1, default yes): a customer's
-- captured signature image leaves the member-readable order row.
-- order_requests_select admits every accepted member, viewers included, and
-- authenticated holds SELECT on every column, so every member reads every
-- stored signature (PostgREST, the realtime UPDATE that records a hand-over,
-- an old phone's order screen), against the app's own rule that only an
-- approver or the order's driver may view it
-- (app/api/orders/[id]/signature/route.ts).
--
-- HISTORY: written as 0393 on fix/order-signature-images-0393 (2026-10-04)
-- to ship after 0392 (critique K6), and never pushed; 0393 then shipped as
-- the account deletion, so this file is 0403. Its statements are unchanged.
--
-- THE PHONE GATE (met). Phones read the image straight from the order row
-- until they run slice B's update (EAS group f0a24abc, published 2026-10-04
-- 04:27Z), which reads it through GET /api/v1/orders/[id]/signature, the
-- web route's alias with the same gate. The rule was: push only once 95% of
-- the production channel's 1.4.0 launches run that update or a later one,
-- or 7 days after its publish. The 7 days passed on 2026-10-11 04:27Z, and
-- every update published since (07d19d8b, the redesign, 2026-10-20, among
-- them) reads through the route; the app is still on runtime 1.4.0. A
-- phone that has not loaded an update since 2026-10-04, and every phone on
-- a native version older than 1.4.0 (which never receives one), shows the
-- signer's name and time without the image until it updates; nothing errors
-- (the dialog's empty branch).
--
-- RELEASE ORDER. This file first, the web change second. The web route in
-- production reads order_request_secrets first and the order column second
-- (since 0389), so it serves every image before and after this push. The
-- route's side-only read ships in the same pull request and must reach
-- production only after this file is pushed: before the push the images
-- are still on the rows and a side-only route would show none of them. No
-- phone update is needed.
--
-- MIGRATION PUSH ORDER (set 2026-10-24): 0402 (explicit grants, #376),
-- then this file (#372), 0404 (bundle component checks), 0405 (order
-- functions' warehouse scope), 0406 (receiving checklist, #377). The CLI
-- refuses a push when a version already applied has no file in the
-- checkout, and refuses an older pending file once a newer one is applied
-- (unless --include-all), so each migration branch is rebased onto main
-- after the one before it merges. For this file: once 0402 is merged and
-- pushed, rebase this branch onto origin/main (this file's statements stay
-- unchanged), let CI re-run, and push from the rebased head, where
-- supabase migration list --linked and supabase db push --linked --dry-run
-- must show exactly 0403 pending. If the CLI suggests supabase migration
-- repair or supabase db pull, run neither. Squash-merge right after the
-- post-push checks pass: once this file is applied the CLI refuses any
-- checkout without it, so the next migration push waits for that merge.
-- 0405 restates resume_fulfillment and reopen_picking, whose md5s the
-- preflight's P4 and the 0403 suite's P5 pin (2e2d5aab, 14e49293): this
-- file goes before 0405, and 0405's branch re-pins P5 when it rebases.
--
-- GRANTS (Supabase stops auto-granting on 2026-10-30). This file creates no
-- table, view or sequence. The capture function's EXECUTE is revoked from
-- public, anon, authenticated and service_role below: a trigger function
-- needs no EXECUTE to fire, and nobody may call it. Table privileges are
-- unchanged and deliberate: authenticated keeps SELECT on order_requests
-- (the column it reads is null from now on) and holds no UPDATE on
-- signature_data_url or signed_at (0387) and nothing on
-- order_request_secrets (0389); anon holds nothing on either table;
-- service_role keeps SELECT, INSERT, UPDATE and DELETE on
-- order_request_secrets, which the trigger needs when the admin client
-- writes an image (SECURITY INVOKER).
--
-- CHECKED AGAINST MAIN AT 0401 (since the file was written): 0393 validated
-- order_requests_delivery_target_chk, so no NOT VALID check on order_requests
-- can stop the null-out; 0395 restated confirm_physical_signature (still
-- writes no image) and reopen_picking (refuses a signed order); 0396's
-- replacement triggers are WHEN-gated on columns this file does not write,
-- and both notify triggers return at once when the status is unchanged, so
-- the move writes no notification for an ordinary or a replacement order.
-- confirm_order_signature (0248) and resume_fulfillment (0390) are the
-- bodies this file was written against.
--
-- WHAT IT DOES
--   1. Every stored image is copied to order_request_secrets.signature_data_url
--      (the column 0389 added empty; the signature route has read it first
--      since 0389), checked byte for byte, and only then nulled on the order.
--   2. tg_order_requests_signature_image_capture, a BEFORE UPDATE OF
--      signature_data_url, signed_at trigger, keeps it that way without
--      touching a frozen body: confirm_order_signature (md5 8afdbb68, never
--      changed) still writes the image to the order row, and the trigger
--      moves it to the side table before the row is stored, so it never
--      reaches the row, the realtime payload or a member. When
--      resume_fulfillment resets a hand-over (signed_at back to null, image
--      nulled), the trigger clears the side copy too. confirm_physical_signature
--      (image null, signed_at set) changes nothing in the side table.
--      SECURITY INVOKER (the plan said DEFINER; INVOKER is narrower and
--      enough): every caller that can name either column runs as postgres
--      (the order RPCs) or service_role (the admin client), both of which
--      may write the side table; authenticated holds no UPDATE on either
--      column (0387), so it never fires the trigger, and if it ever could,
--      the side write would fail closed (permission denied) instead of
--      writing as the owner.
--
-- DATA SAFETY (one DO block, raising P0001 on any difference, nothing
-- applied): no image is longer than the side CHECK (524288); no side image
-- already differs from its row's image; the rows copied = the orders holding
-- an image; every side copy equals its row's image exactly (text equality,
-- byte for byte) BEFORE any row is nulled; the rows nulled = the same set;
-- afterwards no row holds an image, and the side images equal the old row
-- images (checksum over id, md5 and length of each image), and every side
-- image of another order is unchanged; every other order_requests column,
-- updated_at included, is unchanged on every row; the updated_at trigger is
-- enabled again. Any error those checks do not foresee (a constraint error
-- prints the whole row in its detail) is re-raised as
-- order_secrets_images_unexpected_error with its SQLSTATE and object names
-- only. Only order_requests_set_updated_at is disabled, inside the
-- block and only around the writes; the 0387 guard is never disabled (the
-- block runs as postgres). At the 2026-10-04 census: 35 images (all on
-- completed, digitally signed orders; the longest 92,574 characters,
-- 1,394,930 in all); the read-only preflight before the push records the
-- count, the lengths and the checksum this block must reproduce.
--
-- LOCKS: the 0392 prelude, for the same reasons (critique K3 and the side
-- table's foreign-key deadlock): order_requests and order_request_secrets
-- EXCLUSIVE NOWAIT and the referenced organizations rows FOR KEY SHARE
-- NOWAIT, retried up to 40 times holding nothing between attempts, then
-- 55P03 with nothing applied. Plain reads never wait. CREATE OR REPLACE
-- TRIGGER takes SHARE ROW EXCLUSIVE on order_requests, which this file
-- already excludes. lock_timeout 900ms.
--
-- No status changes: no notification, no push. ERRORS: P0001 (a data check,
-- message order_secrets_images_*, counts in the detail; anything unforeseen
-- as order_secrets_images_unexpected_error) or 55P03, each with nothing
-- applied. The trigger raises nothing of its own. Never 40001 or
-- 40P01.

set lock_timeout = '900ms';

do $c403_lock$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.order_requests in exclusive mode nowait;
      lock table only public.order_request_secrets in exclusive mode nowait;
      perform 1
        from public.organizations g
       where exists (select 1
                       from public.order_requests o
                      where o.organization_id = g.id
                        and o.signature_data_url is not null)
         for key share of g nowait;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $c403_lock$;

do $c403_move$
declare
  v_other_before text;
  v_other_after  text;
  v_ids          uuid[];
  v_img_sum      text;
  v_side_other   text;
  v_sum          text;
  v_n            bigint;
  v_bad          bigint;
  v_e_state      text;
  v_e_msg        text;
  v_e_table      text;
  v_e_column     text;
  v_e_constraint text;
begin
  select md5(coalesce(string_agg(o.id::text || ':' || (to_jsonb(o) - 'signature_data_url')::text,
                                 E'\n' order by o.id), ''))
    into v_other_before
    from public.order_requests o;

  alter table public.order_requests disable trigger order_requests_set_updated_at;

  select count(*) into v_bad
    from public.order_requests
   where signature_data_url is not null and length(signature_data_url) > 524288;
  if v_bad > 0 then
    raise exception 'order_secrets_images_too_long'
      using errcode = 'P0001',
            detail  = format('%s stored images exceed the side table''s 524288 characters; nothing was changed.', v_bad);
  end if;
  select count(*) into v_bad
    from public.order_requests o
    join public.order_request_secrets s on s.order_request_id = o.id
   where o.signature_data_url is not null
     and s.signature_data_url is not null
     and s.signature_data_url <> o.signature_data_url;
  if v_bad > 0 then
    raise exception 'order_secrets_images_conflict'
      using errcode = 'P0001',
            detail  = format('%s orders already hold a different image in the side table; nothing was changed.', v_bad);
  end if;

  select coalesce(array_agg(o.id order by o.id), '{}'::uuid[]),
         md5(coalesce(string_agg(o.id::text || ':' || md5(o.signature_data_url) || ':' || length(o.signature_data_url),
                                 E'\n' order by o.id), ''))
    into v_ids, v_img_sum
    from public.order_requests o
   where o.signature_data_url is not null;
  select md5(coalesce(string_agg(s.order_request_id::text || ':' || coalesce(md5(s.signature_data_url), '-'),
                                 E'\n' order by s.order_request_id), ''))
    into v_side_other
    from public.order_request_secrets s
   where not (s.order_request_id = any (v_ids));

  insert into public.order_request_secrets (order_request_id, organization_id, signature_data_url)
  select o.id, o.organization_id, o.signature_data_url
    from public.order_requests o
   where o.id = any (v_ids)
  on conflict (order_request_id) do update
    set signature_data_url = excluded.signature_data_url,
        updated_at         = now();
  get diagnostics v_n = row_count;
  if v_n <> cardinality(v_ids) then
    raise exception 'order_secrets_images_count'
      using errcode = 'P0001',
            detail  = format('%s side rows written for %s stored images.', v_n, cardinality(v_ids));
  end if;

  -- Byte for byte, before any row is nulled.
  select count(*) into v_bad
    from public.order_requests o
    left join public.order_request_secrets s on s.order_request_id = o.id
   where o.id = any (v_ids)
     and s.signature_data_url is distinct from o.signature_data_url;
  if v_bad > 0 then
    raise exception 'order_secrets_images_copy_mismatch'
      using errcode = 'P0001',
            detail  = format('%s of %s side copies are not byte-identical to their row; no row was nulled.', v_bad, cardinality(v_ids));
  end if;

  update public.order_requests o
     set signature_data_url = null
   where o.id = any (v_ids);
  get diagnostics v_n = row_count;
  if v_n <> cardinality(v_ids) then
    raise exception 'order_secrets_images_count'
      using errcode = 'P0001',
            detail  = format('%s rows nulled for %s stored images.', v_n, cardinality(v_ids));
  end if;
  select count(*) into v_bad from public.order_requests where signature_data_url is not null;
  if v_bad > 0 then
    raise exception 'order_secrets_images_left'
      using errcode = 'P0001',
            detail  = format('%s orders still hold an image on the row.', v_bad);
  end if;

  select md5(coalesce(string_agg(s.order_request_id::text || ':' || coalesce(md5(s.signature_data_url), '-') || ':'
                                 || coalesce(length(s.signature_data_url), -1),
                                 E'\n' order by s.order_request_id), ''))
    into v_sum
    from public.order_request_secrets s
   where s.order_request_id = any (v_ids);
  if v_sum is distinct from v_img_sum then
    raise exception 'order_secrets_images_copy_mismatch'
      using errcode = 'P0001',
            detail  = format('The side table does not hold the %s images the rows held.', cardinality(v_ids));
  end if;
  select md5(coalesce(string_agg(s.order_request_id::text || ':' || coalesce(md5(s.signature_data_url), '-'),
                                 E'\n' order by s.order_request_id), ''))
    into v_sum
    from public.order_request_secrets s
   where not (s.order_request_id = any (v_ids));
  if v_sum is distinct from v_side_other then
    raise exception 'order_secrets_images_copy_mismatch'
      using errcode = 'P0001',
            detail  = 'A side image of an order that held none on its row changed.';
  end if;

  alter table public.order_requests enable trigger order_requests_set_updated_at;

  select md5(coalesce(string_agg(o.id::text || ':' || (to_jsonb(o) - 'signature_data_url')::text,
                                 E'\n' order by o.id), ''))
    into v_other_after
    from public.order_requests o;
  if v_other_after is distinct from v_other_before then
    raise exception 'order_secrets_images_other_columns_changed'
      using errcode = 'P0001',
            detail  = 'An order column other than signature_data_url changed (updated_at included).';
  end if;
  select count(*) into v_bad
    from pg_trigger t
   where t.tgrelid = 'public.order_requests'::regclass
     and t.tgname = 'order_requests_set_updated_at'
     and t.tgenabled <> 'O';
  if v_bad > 0 then
    raise exception 'order_secrets_images_trigger_state'
      using errcode = 'P0001',
            detail  = 'order_requests_set_updated_at is not enabled again.';
  end if;
exception
  -- Busy (lock_timeout): its message names no value; nothing was applied.
  when lock_not_available then
    raise;
  -- The block's own checks pass through (counts only). Any other error (a
  -- constraint the prechecks did not foresee) would print the whole side row
  -- in its detail, its tokens and the image included: it is re-raised with
  -- its SQLSTATE and object names only. Everything the block did is undone.
  when others then
    get stacked diagnostics v_e_state = returned_sqlstate, v_e_msg = message_text,
                            v_e_table = table_name, v_e_column = column_name, v_e_constraint = constraint_name;
    if v_e_state = 'P0001' and v_e_msg ~ '^order_secrets_images_[a-z_]+$' then
      raise;
    end if;
    raise exception 'order_secrets_images_unexpected_error'
      using errcode = 'P0001',
            detail  = format('SQLSTATE %s (table %s, column %s, constraint %s); nothing was changed. The message and detail are withheld: they can carry a token or an image.',
                             v_e_state, coalesce(nullif(v_e_table, ''), '-'), coalesce(nullif(v_e_column, ''), '-'),
                             coalesce(nullif(v_e_constraint, ''), '-'));
end $c403_move$;

create or replace function public.tg_order_requests_signature_image_capture()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- confirm_order_signature (frozen) writes the image onto the order row; it
  -- goes to the side table instead, before the row is stored, so it never
  -- reaches the row, the realtime payload or a member.
  if new.signature_data_url is not null then
    insert into public.order_request_secrets (order_request_id, organization_id, signature_data_url)
    values (new.id, new.organization_id, new.signature_data_url)
    on conflict (order_request_id) do update
      set signature_data_url = excluded.signature_data_url,
          updated_at         = now();
    new.signature_data_url := null;
  -- resume_fulfillment (frozen) resets the hand-over: the image goes with it.
  elsif old.signed_at is not null and new.signed_at is null then
    update public.order_request_secrets
       set signature_data_url = null,
           updated_at         = now()
     where order_request_id = new.id
       and signature_data_url is not null;
  end if;
  return new;
end;
$$;

comment on function public.tg_order_requests_signature_image_capture() is
  'BEFORE UPDATE OF signature_data_url, signed_at on order_requests (0403): moves a captured signature '
  'image into order_request_secrets before the row is stored (confirm_order_signature keeps writing '
  'the column), and clears the side copy when a hand-over is reset (signed_at back to null, '
  'resume_fulfillment). SECURITY INVOKER: its callers are the order RPCs (postgres) and the admin '
  'client (service_role); authenticated holds no UPDATE on either column.';

revoke all on function public.tg_order_requests_signature_image_capture() from public, anon, authenticated, service_role;

create or replace trigger trg_order_requests_signature_image_capture
  before update of signature_data_url, signed_at on public.order_requests
  for each row execute function public.tg_order_requests_signature_image_capture();

comment on column public.order_requests.signature_data_url is
  'Always null since 0403: the captured signature image lives in order_request_secrets.signature_data_url, '
  'moved there by trg_order_requests_signature_image_capture before the row is stored. Read through '
  '/api/orders/<id>/signature (an approver or the order''s driver).';

reset lock_timeout;

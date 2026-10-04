-- 0393_order_signature_images.sql
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
-- SHIPS SEPARATELY FROM 0392, ON PURPOSE (critique K6). Phones read the
-- image straight from the order row until they run slice B's update
-- (EAS group f0a24abc, published 2026-10-04 04:27Z), which reads it through
-- GET /api/v1/orders/<id>/signature instead. Push this file only when, at
-- push time, at least 95% of the production channel's 1.4.0 launches run
-- that update or a later one (`eas channel:insights`), or 7 days have passed
-- since 04:27Z (the exception-confirm R2 rule). Record the number in R0.
-- A phone that has not updated, and every phone on a native runtime older
-- than 1.4.0 (which never receives the update), shows the signer's name and
-- time without the image until it updates; nothing errors (the dialog's
-- empty branch). If the gate is not met, 0392 ships alone and this file
-- follows in a later push; nothing in 0392 depends on it.
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
-- enabled again. Only order_requests_set_updated_at is disabled, inside the
-- block and only around the writes; the 0387 guard is never disabled (the
-- block runs as postgres). Expected at the 2026-10-04 census: 35 images
-- (all on completed, digitally signed orders; the longest 92,574 characters,
-- 1,394,930 in all).
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
-- message order_secrets_images_*, counts in the detail) or 55P03, each with
-- nothing applied. The trigger raises nothing of its own. Never 40001 or
-- 40P01.

set lock_timeout = '900ms';

do $c393_lock$
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
end $c393_lock$;

do $c393_move$
declare
  v_other_before text;
  v_other_after  text;
  v_ids          uuid[];
  v_img_sum      text;
  v_side_other   text;
  v_sum          text;
  v_n            bigint;
  v_bad          bigint;
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
end $c393_move$;

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
  'BEFORE UPDATE OF signature_data_url, signed_at on order_requests (0393): moves a captured signature '
  'image into order_request_secrets before the row is stored (confirm_order_signature keeps writing '
  'the column), and clears the side copy when a hand-over is reset (signed_at back to null, '
  'resume_fulfillment). SECURITY INVOKER: its callers are the order RPCs (postgres) and the admin '
  'client (service_role); authenticated holds no UPDATE on either column.';

revoke all on function public.tg_order_requests_signature_image_capture() from public, anon, authenticated, service_role;

create or replace trigger trg_order_requests_signature_image_capture
  before update of signature_data_url, signed_at on public.order_requests
  for each row execute function public.tg_order_requests_signature_image_capture();

comment on column public.order_requests.signature_data_url is
  'Always null since 0393: the captured signature image lives in order_request_secrets.signature_data_url, '
  'moved there by trg_order_requests_signature_image_capture before the row is stored. Read through '
  '/api/orders/<id>/signature (an approver or the order''s driver).';

reset lock_timeout;

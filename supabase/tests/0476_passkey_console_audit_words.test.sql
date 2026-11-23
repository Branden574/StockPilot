-- supabase/tests/0476_passkey_console_audit_words.test.sql
-- pgTAP proof for migration 0476: platform_admin_audit's action check accepts
-- the console's two passkey switch words and every word it accepted before,
-- and nothing else, and it is validated; the table's posture (row security
-- on, no policy) is unchanged. Clock-independent; made-up ids.
--
-- The inserts name a real fixture actor (an auth.users row, whose profile the
-- 0001 on_auth_user_created trigger writes), as 0308's test does: since 0393,
-- platform_admin_audit_actor_user_id_deleted_chk refuses a null actor that is
-- not stamped deleted, with the same SQLSTATE (23514) as the action check. The
-- refusals below therefore match the action check's own message, so a refusal
-- by any other constraint cannot pass them.
begin;
select plan(8);

\set actor '\'ad760000-0000-4000-8000-0000000000d1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:actor, 'actor@ad76.test', '{}'::jsonb) on conflict (id) do nothing;

select is(
  (select string_agg(m[1], ',' order by m[1])
     from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') as m
    where c.conrelid = 'public.platform_admin_audit'::regclass and c.conname = 'platform_admin_audit_action_check'),
  'acted_as_end,acted_as_start,billing_changed,deletion_passphrase_set,org_deleted,org_passkeys_switched,'
  'org_provisioned,passkeys_switched,password_reset_sent,permission_exception_changed,ticket_updated,'
  'user_disabled,user_reenabled,viewed_org',
  '0476/1: the check accepts the twelve words 0413 left plus passkeys_switched and org_passkeys_switched, and nothing else');

select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action, detail)
    values ('ad760000-0000-4000-8000-0000000000d1', 'actor@ad76.test', 'passkeys_switched',
            '{"setting":"passkeys_on","from":false,"to":true}'::jsonb)$$,
  '0476/2: a platform passkey switch can be recorded');

select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action, target_organization_id, detail)
    values ('ad760000-0000-4000-8000-0000000000d1', 'actor@ad76.test', 'org_passkeys_switched', null,
            '{"from":true,"to":false}'::jsonb)$$,
  '0476/3: an organization passkey switch can be recorded');

select throws_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action, detail)
    values ('ad760000-0000-4000-8000-0000000000d1', 'actor@ad76.test', 'passkeys_switched_x', '{}'::jsonb)$$,
  '23514',
  'new row for relation "platform_admin_audit" violates check constraint "platform_admin_audit_action_check"',
  '0476/4: a word outside the vocabulary is still refused, by the action check');

select throws_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action, detail)
    values ('ad760000-0000-4000-8000-0000000000d1', 'actor@ad76.test', 'org_passkey_switched', '{}'::jsonb)$$,
  '23514',
  'new row for relation "platform_admin_audit" violates check constraint "platform_admin_audit_action_check"',
  '0476/5: a near miss of the new word is refused, by the action check');

-- The posture of the table is unchanged: row security on, no policy.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.platform_admin_audit'::regclass),
  '0476/6: row security stays on');
select is(
  (select count(*)::int from pg_policy where polrelid = 'public.platform_admin_audit'::regclass),
  0,
  '0476/7: no policy on platform_admin_audit (service role only)');
select ok(
  (select c.convalidated from pg_constraint c
    where c.conrelid = 'public.platform_admin_audit'::regclass and c.conname = 'platform_admin_audit_action_check'),
  '0476/8: the check is validated (every existing row was read against it)');

select * from finish();
rollback;

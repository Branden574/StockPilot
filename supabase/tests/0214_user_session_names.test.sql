-- pgTAP: editable session-scoped device names (migration 0214).
begin;
select plan(13);

\set userA '\'d2000000-0000-0000-0000-0000000000a1\''
\set userB '\'d2000000-0000-0000-0000-0000000000b2\''
\set sessA1 '\'d2a10000-0000-0000-0000-000000000001\''
\set sessA2 '\'d2a20000-0000-0000-0000-000000000002\''
\set sessB1 '\'d2b10000-0000-0000-0000-000000000003\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:userA, 'a@names.test', '{}'::jsonb),
  (:userB, 'b@names.test', '{}'::jsonb);
insert into auth.sessions (id, user_id, created_at, updated_at) values
  (:sessA1, :userA, now() - interval '2 hours', now() - interval '10 min'),
  (:sessA2, :userA, now() - interval '1 hour',  now() - interval '5 min'),
  (:sessB1, :userB, now() - interval '3 hours', now() - interval '1 min');

-- Become user A.
set local "request.jwt.claim.sub" to 'd2000000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  public.set_my_session_name(:sessA1, 'Front desk PC'),
  1,
  'set_my_session_name names the caller''s own session'
);
select is(
  (select custom_name from public.list_my_sessions() where id = :sessA1),
  'Front desk PC',
  'custom_name surfaces through list_my_sessions for that session'
);
select is(
  public.set_my_session_name(:sessB1, 'hax'),
  0,
  'set_my_session_name is a no-op on another user''s session'
);
select is(
  public.set_my_session_name(:sessA2, repeat('x', 70)),
  1,
  'set_my_session_name accepts an over-long name'
);
select is(
  (select length(custom_name) from public.list_my_sessions() where id = :sessA2),
  60,
  'an over-long name is capped at 60 chars'
);
select is(
  public.set_my_session_name(:sessA1, repeat('y', 60)),
  1,
  'set_my_session_name accepts a name at exactly the 60-char limit'
);
select is(
  (select length(custom_name) from public.list_my_sessions() where id = :sessA1),
  60,
  'a name of exactly 60 chars is stored intact (not truncated)'
);
select is(
  public.set_my_session_name(:sessA1, '   '),
  1,
  'a blank/whitespace name clears the custom name'
);
select ok(
  (select custom_name from public.list_my_sessions() where id = :sessA1) is null,
  'a cleared name reverts to null (auto label)'
);
select is(
  public.set_my_session_name(:sessA1, null),
  1,
  'an explicit NULL name is accepted and treated as clear'
);
select is(
  public.revoke_my_session(:sessA2),
  1,
  'revoke_my_session deletes the caller''s named session (primes cascade)'
);

-- Become user B (same authenticated role, switch the JWT subject).
set local "request.jwt.claim.sub" to 'd2000000-0000-0000-0000-0000000000b2';
select ok(
  (select count(*)::int from public.list_my_sessions()) = 1
    and (select custom_name from public.list_my_sessions() where id = :sessB1) is null,
  'user B sees only their own 1 session and no custom name (A''s attempt never landed)'
);

reset role;

select ok(
  not exists (select 1 from public.user_session_names where session_id = :sessA2)
    and not exists (select 1 from public.user_session_names where session_id = :sessB1),
  'name row cascades away on revoke, and no row was ever written for another user''s session'
);

select * from finish();
rollback;

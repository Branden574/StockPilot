-- pgTAP: auth.uid()-scoped session management (migration 0213).
begin;
select plan(6);

\set userA '\'c1000000-0000-0000-0000-0000000000a1\''
\set userB '\'c1000000-0000-0000-0000-0000000000b2\''
\set sessA1 '\'c1a10000-0000-0000-0000-000000000001\''
\set sessA2 '\'c1a20000-0000-0000-0000-000000000002\''
\set sessB1 '\'c1b10000-0000-0000-0000-000000000003\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:userA, 'a@sess.test', '{}'::jsonb),
  (:userB, 'b@sess.test', '{}'::jsonb);
-- Two sessions for A, one for B. created_at/refreshed_at are NOT NULL in auth.sessions.
insert into auth.sessions (id, user_id, created_at, updated_at) values
  (:sessA1, :userA, now() - interval '2 hours', now() - interval '10 min'),
  (:sessA2, :userA, now() - interval '1 hour',  now() - interval '5 min'),
  (:sessB1, :userB, now() - interval '3 hours', now() - interval '1 min');

-- Become user A.
set local "request.jwt.claim.sub" to 'c1000000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (select count(*)::int from public.list_my_sessions()),
  2,
  'list_my_sessions returns only the caller''s 2 sessions'
);
select ok(
  not exists (select 1 from public.list_my_sessions() where id = 'c1b10000-0000-0000-0000-000000000003'),
  'list_my_sessions never returns another user''s session'
);
-- Cannot revoke another user's session (no-op).
select is(
  public.revoke_my_session('c1b10000-0000-0000-0000-000000000003'),
  0,
  'revoke_my_session is a no-op on another user''s session'
);
-- Can revoke own session.
select is(
  public.revoke_my_session('c1a10000-0000-0000-0000-000000000001'),
  1,
  'revoke_my_session deletes the caller''s own session'
);
-- Revoke-others keeps the current one.
select is(
  public.revoke_my_other_sessions('c1a20000-0000-0000-0000-000000000002'),
  0,
  'revoke_my_other_sessions: nothing else left to revoke (A2 kept, A1 already gone)'
);
reset role;

-- B's session survived A's actions.
select ok(
  exists (select 1 from auth.sessions where id = 'c1b10000-0000-0000-0000-000000000003'),
  'user B''s session was never touched by user A'
);

select * from finish();
rollback;

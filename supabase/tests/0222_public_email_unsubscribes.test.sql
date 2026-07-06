-- supabase/tests/0222_public_email_unsubscribes.test.sql
-- Proves migration 0222: public_email_unsubscribes is service-role-only —
-- anon and authenticated can neither read nor write (default grants revoked
-- on top of policy-less RLS, so probes hit 42501 instead of an RLS-empty
-- read that could be mistaken for "not unsubscribed") — and the lowercase
-- check constraint holds.

begin;
select plan(6);

-- Seed as superuser — stands in for the service-role writer, which
-- bypasses RLS the same way.
insert into public.public_email_unsubscribes (email) values ('optout@example.com');

select ok(
  (select relrowsecurity from pg_class
    where oid = 'public.public_email_unsubscribes'::regclass),
  'RLS is enabled on public_email_unsubscribes'
);

select throws_ok(
  $$ insert into public.public_email_unsubscribes (email) values ('MiXeD@Example.com') $$,
  '23514', null,
  'check constraint rejects a non-lowercased email'
);

-- ── anon: no read, no write ────────────────────────────────────────────────
set local "request.jwt.claim.role" to 'anon';
set local role to 'anon';
select throws_ok(
  $$ select * from public.public_email_unsubscribes $$,
  '42501', null,
  'anon cannot read the unsubscribe list'
);
select throws_ok(
  $$ insert into public.public_email_unsubscribes (email) values ('anon@example.com') $$,
  '42501', null,
  'anon cannot insert into the unsubscribe list'
);
reset role;

-- ── authenticated: no read, no write ───────────────────────────────────────
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ select * from public.public_email_unsubscribes $$,
  '42501', null,
  'authenticated cannot read the unsubscribe list'
);
select throws_ok(
  $$ insert into public.public_email_unsubscribes (email) values ('member@example.com') $$,
  '42501', null,
  'authenticated cannot insert into the unsubscribe list'
);
reset role;

select * from finish();
rollback;

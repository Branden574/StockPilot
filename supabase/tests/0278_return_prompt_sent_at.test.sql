-- supabase/tests/0278_return_prompt_sent_at.test.sql
-- Proves migration 0278: order_requests.return_prompt_sent_at — the
-- idempotency marker for the one-time return-prompt email.
--   P1. Column exists.
--   P2. Type is timestamptz.
--   P3. No default — so P4 is structural, not incidental.
--   P4. A freshly inserted order starts with the marker NULL (never sent).
-- Namespace ab027800. Wrapped in begin/rollback (mirrors 0254's fixture).

begin;

select plan(4);

\set org '\'ab027800-0000-0000-0000-00000000000a\''
\set wh  '\'ab027800-0000-0000-0000-0000000000a1\''
\set ord '\'ab027800-0000-0000-0000-0000000000c1\''

insert into public.organizations (id, name, slug) values
  (:org, 'ReturnPrompt Org', 'returnprompt-0278')
  on conflict (id) do nothing;
insert into public.warehouses (id, organization_id, name, code, status) values
  (:wh, :org, 'RP WH', 'WH-RP-0278', 'active')
  on conflict (id) do nothing;

select has_column(
  'public', 'order_requests', 'return_prompt_sent_at',
  'P1: return_prompt_sent_at exists');

select col_type_is(
  'public', 'order_requests', 'return_prompt_sent_at',
  'timestamp with time zone',
  'P2: return_prompt_sent_at is timestamptz');

select col_hasnt_default(
  'public', 'order_requests', 'return_prompt_sent_at',
  'P3: return_prompt_sent_at has no default');

-- source defaults to 'internal', which requires requester_user_id or
-- requester_email (order_requests_identity_chk, 0116/0251) — same fixture
-- shape as 0254.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, fulfillment_type, requester_name, requester_email)
  values (:ord, :org, :wh, 'pending_approval', 'pickup', 'RP Tester', 'rp@returnprompt-0278.test');

select is(
  (select return_prompt_sent_at from public.order_requests where id = :ord),
  null::timestamptz,
  'P4: a fresh order starts with return_prompt_sent_at NULL');

select * from finish();

rollback;

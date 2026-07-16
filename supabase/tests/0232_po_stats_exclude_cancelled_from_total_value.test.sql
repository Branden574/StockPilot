-- pgTAP: purchase_orders_stats.total_value excludes cancelled POs (0232).
begin;
select plan(4);

-- Minimal, self-contained org + POs. purchase_orders_stats is SECURITY INVOKER;
-- running as the test superuser bypasses RLS so it aggregates the seeded rows.
insert into public.organizations (id, name, slug)
values ('00000000-0000-0000-0000-0000000000aa', 'PGTAP PO Stats Org', 'pgtap-po-stats-org');

-- Three POs: one draft ($50), one received ($30), one cancelled ($100).
-- Correct total_value = 50 + 30 = 80 (cancelled excluded). committed_value = 50
-- (open-status only). total_count = 3 (all rows still counted).
insert into public.purchase_orders (id, organization_id, po_number, status, total)
values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000aa', 'PO-DRAFT',  'draft',    50),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000aa', 'PO-RECV',   'received', 30),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000aa', 'PO-CANCEL', 'cancelled',100);

select is(
  (select total_value from public.purchase_orders_stats('00000000-0000-0000-0000-0000000000aa'))::numeric,
  80::numeric,
  'total_value excludes the cancelled PO (50 + 30, not + 100)'
);

select is(
  (select committed_value from public.purchase_orders_stats('00000000-0000-0000-0000-0000000000aa'))::numeric,
  50::numeric,
  'committed_value is open-status only (draft 50)'
);

select is(
  (select total_count from public.purchase_orders_stats('00000000-0000-0000-0000-0000000000aa'))::bigint,
  3::bigint,
  'total_count still counts ALL PO rows including cancelled'
);

-- An org whose only PO is cancelled reports total_value 0, not the PO total.
insert into public.organizations (id, name, slug)
values ('00000000-0000-0000-0000-0000000000cc', 'PGTAP All-Cancelled Org', 'pgtap-all-cancelled-org');
insert into public.purchase_orders (id, organization_id, po_number, status, total)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000cc', 'PO-ONLY-CANCEL', 'cancelled', 999);

select is(
  (select total_value from public.purchase_orders_stats('00000000-0000-0000-0000-0000000000cc'))::numeric,
  0::numeric,
  'all-cancelled org has total_value 0'
);

select * from finish();
rollback;

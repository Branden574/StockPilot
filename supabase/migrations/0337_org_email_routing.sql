-- 0337_org_email_routing.sql
--
-- Per-org compose-email routing for the delivery-request and maintenance
-- email actions. NULL / absent key = that feature's email action is HIDDEN.
-- Readers fall back to the compiled L4L constants ONLY while this column
-- does not exist (the code-before-migration window; Postgres 42703 at the
-- reader); a present-but-invalid value fails CLOSED for that org and never
-- falls back to another org's mailboxes.
--
-- RLS is INHERITED from public.organizations on purpose — zero new policies,
-- zero `alter policy ... with check` surface (recurring pattern #24 cannot
-- fire on a policy this migration does not touch):
--   organizations_select  (is_org_member)      — every member can read; the
--     TO/CC are not secrets, they are printed in the email UI, and every
--     member who can render the compose button needs them.
--   organizations_update  (has_org_role admin) — only admins write.
-- Both directions are pinned in supabase/tests/0337_org_email_routing.test.sql.

alter table public.organizations add column email_routing jsonb;

comment on column public.organizations.email_routing is
  'Per-feature compose-email routing: {delivery_request?, maintenance_request?}, each {to, cc, toName?, ccName?}. Address validity is enforced in TS at the branded recipient factories (packages/core); this CHECK is a shape floor only.';

-- SHAPE FLOOR ONLY. Address validity is deliberately NOT re-implemented in
-- SQL: the TS branded factories (assertRoutableAddress /
-- assertSafeDisplayName in packages/core/src/email/outlook-compose.ts) are
-- the acceptance gate, and a second SQL definition of "routable" would
-- drift from it. A value that passes this CHECK but fails the factory is
-- 'invalid' to every reader and fails closed (action hidden, reason shown
-- to admins).
-- NULL-PROPAGATION NOTE (caught by pgTAP before this ever shipped): a CHECK
-- whose expression evaluates to SQL NULL PASSES. `jsonb_typeof(entry ->
-- 'cc')` is NULL when the key is absent, `NULL = 'string'` is NULL, and the
-- whole conjunction goes NULL — so an entry MISSING its mandatory cc would
-- have been admitted. Every typeof-equality on a possibly-absent key is
-- therefore coalesced to false. The `- key = '{}'` no-unknown-keys term is
-- CASE-guarded because `-` on a scalar jsonb raises rather than returning
-- false, and SQL does not contractually promise AND evaluation order.
alter table public.organizations add constraint organizations_email_routing_shape check (
  email_routing is null or (
    jsonb_typeof(email_routing) = 'object'
    and case when jsonb_typeof(email_routing) = 'object'
             then email_routing - 'delivery_request' - 'maintenance_request' = '{}'::jsonb
             else false end
    and (not (email_routing ? 'delivery_request') or (
      jsonb_typeof(email_routing -> 'delivery_request') = 'object'
      and coalesce(jsonb_typeof(email_routing -> 'delivery_request' -> 'to') = 'string', false)
      and coalesce(jsonb_typeof(email_routing -> 'delivery_request' -> 'cc') = 'string', false)))
    and (not (email_routing ? 'maintenance_request') or (
      jsonb_typeof(email_routing -> 'maintenance_request') = 'object'
      and coalesce(jsonb_typeof(email_routing -> 'maintenance_request' -> 'to') = 'string', false)
      and coalesce(jsonb_typeof(email_routing -> 'maintenance_request' -> 'cc') = 'string', false)))
  ));

-- Seed L4L with today's exact values (the compiled constants in
-- packages/core/src/orders/delivery-request-recipients.ts and
-- packages/core/src/maintenance/constants.ts): nothing changes for the one
-- tenant whose acceptance gate (the mandatory CC) these encode.
update public.organizations set email_routing = jsonb_build_object(
  'delivery_request', jsonb_build_object(
    'to', 'dc4@learn4life.org',
    'cc', 'arosas@cvwest.org',
    'toName', 'Fresno Warehouse DC4',
    'ccName', 'Andrew Rosas'),
  'maintenance_request', jsonb_build_object(
    'to', 'dc4@learn4life.org',
    'cc', 'arosas@cvwest.org',
    'toName', 'Fresno Warehouse DC4',
    'ccName', 'Andrew Rosas'))
where id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';

-- Seed Demo Co with reserved-TLD demo values (.invalid, RFC 2606: can never
-- resolve or deliver, yet passes the TS ROUTABLE_ADDRESS grammar): the demo
-- org can walk the ENTIRE flow — button, preview, notice, compose window —
-- and an accidental real Send bounces in the sender's own mail client
-- instead of reaching anyone. Before this feature, Demo Co's compose was
-- wired to L4L's REAL mailboxes.
update public.organizations set email_routing = jsonb_build_object(
  'delivery_request', jsonb_build_object(
    'to', 'warehouse-demo@stockpilot-demo.invalid',
    'cc', 'manager-demo@stockpilot-demo.invalid',
    'toName', 'Demo Warehouse Intake',
    'ccName', 'Demo Warehouse Manager'),
  'maintenance_request', jsonb_build_object(
    'to', 'warehouse-demo@stockpilot-demo.invalid',
    'cc', 'manager-demo@stockpilot-demo.invalid',
    'toName', 'Demo Warehouse Intake',
    'ccName', 'Demo Warehouse Manager'))
where id = '71b27a4a-7948-4638-bc3f-535974713bd2';

-- The Card Quest (7b9b4b5b-9218-4051-889a-15ff64dc4bba) is deliberately left
-- NULL: unconfigured -> the email actions disappear there. That is the fix
-- landing, not a regression — the org has zero order_requests, so nobody
-- loses a workflow in use; before this migration its surfaces were wired to
-- L4L's real mailboxes.
--
-- Both UPDATEs are idempotent no-ops where the row is absent (local resets),
-- so this migration is safe everywhere.

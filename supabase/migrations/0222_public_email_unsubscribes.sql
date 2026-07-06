-- 0222_public_email_unsubscribes.sql
--
-- Opt-out store for order-request emails sent to ANONYMOUS recipients
-- (public-link requesters with no user account). Signed-in users keep
-- their per-event notification_preferences (migration 0113); everyone
-- else had NO working opt-out — the email footer pointed at the
-- login-gated dashboard prefs page, which dead-ends an anonymous
-- requester on /signin. That's a broken unsubscribe promise and a
-- Gmail/Yahoo bulk-sender compliance gap.
--
-- The flow:
--   1. Every order-request email to a public requester carries a signed
--      `/unsubscribe?e=<email>&t=<hmac>` link (+ RFC 8058 one-click
--      List-Unsubscribe-Post headers).
--   2. POST /unsubscribe (never GET — mail scanners prefetch links)
--      verifies the HMAC and upserts the address here via the
--      service-role client.
--   3. lib/email/order-requests.ts checks this table before every
--      lifecycle send to a public requester. The confirm_request
--      double-opt-in email is exempt on purpose: it's the consent email
--      the requester just triggered by submitting the form, and nothing
--      else can ever be sent unless they DO confirm.
--
-- Deliberately org-agnostic (email is the PK): the recipient opted out
-- of OUR emails, not one tenant's — the same address can be a requester
-- at several orgs and a single click must silence them all (that's the
-- one-click semantics Gmail/Yahoo expect).

create table public.public_email_unsubscribes (
  -- Lowercased at write time by the app; the check keeps a manual
  -- backfill from sneaking in a case-variant the sender's lowercased
  -- lookup would miss.
  email      text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);

alter table public.public_email_unsubscribes enable row level security;

-- No policies — deny-all for anon/authenticated. Reads and writes
-- happen exclusively through the service-role client (which bypasses
-- RLS) in the /unsubscribe route and the email sender. Revoke the
-- default grants too so the failure mode is 42501, not an RLS-empty
-- read that could be mistaken for "not unsubscribed".
revoke all on table public.public_email_unsubscribes from anon, authenticated;

comment on table public.public_email_unsubscribes is
  'Opt-out list for order-request emails to anonymous (no-account) '
  'recipients. Service-role only: written by POST /unsubscribe, read by '
  'lib/email/order-requests.ts before each send.';

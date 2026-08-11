-- 0330_share_token_hash_at_rest.sql
-- Security MED-26: three share/public-link token columns stored the RAW
-- bearer token at rest. A database leak (dump, misconfigured replica,
-- compromised read path) therefore handed out working credentials:
--
--   1. public_request_links.token            (0261) — /r/<token> catalogs
--   2. maintenance_request_share_links.token (0314) — /m/<token> photo pages
--   3. organizations.public_request_token    (0044) — legacy /r fallback +
--                                             public order tracking scope
--
-- This migration replaces each with an UNSALTED SHA-256 hash, mirroring the
-- pattern 0108 already established for order_requests.confirmation_token_hash:
-- every token is 64 hex chars minted from 32 CSPRNG bytes (256 bits), so
-- offline guessing against an unsalted digest is infeasible and no pepper or
-- new secret is needed. The app hashes the presented token server-side and
-- compares equality on the hash column; the plaintext exists only in the
-- moment of minting (returned once to the caller) and in the URLs users
-- already hold.
--
-- SHOW-ONCE CONSEQUENCE (deliberate): after this migration the app can no
-- longer re-display an existing link URL. Every surface that used to offer
-- "Copy URL" on a stored link now offers copy-at-mint plus a
-- rotate/regenerate action that mints a fresh token (invalidating the old).
--
-- PLAINTEXT-COLUMN REFERENCES AUDITED (grep over supabase/migrations):
--   - public_link_eligible_items (0261) never reads .token — unaffected.
--   - No RLS policy on any of the three tables references the token column.
--   - confirm_public_order_request (0108) uses confirmation_token_hash —
--     unrelated and already hashed.
--   - 0261's backfill INSERT..SELECT of o.public_request_token already ran;
--     shipped files are never edited (house rule), and nothing re-runs them.
--
-- TRACK-LINK CONTINUITY: order-status emails to PUBLIC (anonymous)
-- requesters embed a /r/track?...&t=<token> CTA that was built by reading
-- organizations.public_request_token at SEND time. With the org token hashed
-- that read is impossible, so public tracking moves to a PER-REQUEST token:
-- order_requests.public_track_token, minted at public submit, stored raw —
-- the same accepted posture as order_requests.return_token (0156) and
-- signature_token (both per-request, single-order scope, raw at rest; MED-26
-- explicitly scopes only the three org/link-level columns above). Its grant
-- is the redacted status view of ONE order, and only alongside the matching
-- requester email; the org/link-level catalog tokens it replaces in emails
-- granted org-wide catalog access.
--
-- Prod contains exactly 3 rows total across the three token tables
-- (verified 2026-08-11), so the backfills are trivial.

-- ── 1) public_request_links.token → token_hash ──────────────────────────────

alter table public.public_request_links
  add column if not exists token_hash text;

update public.public_request_links
   set token_hash = encode(extensions.digest(token, 'sha256'), 'hex')
 where token_hash is null;

alter table public.public_request_links
  alter column token_hash set not null;

-- Same 64-lowercase-hex shape check 0108's confirmation_token_hash relies on
-- (sha256 hex output is always exactly this shape; the check pins it so a
-- future writer can never store a plaintext token here by mistake — a 64-hex
-- PLAINTEXT would pass the shape, but every app mint path stores
-- sha256(token), and the shape at least refuses every non-hex/short value).
alter table public.public_request_links
  add constraint public_request_links_token_hash_shape
  check (token_hash ~ '^[0-9a-f]{64}$');

create unique index if not exists public_request_links_token_hash_uniq
  on public.public_request_links (token_hash);

alter table public.public_request_links
  drop column token;

-- ── 2) maintenance_request_share_links.token → token_hash ───────────────────

alter table public.maintenance_request_share_links
  add column if not exists token_hash text;

update public.maintenance_request_share_links
   set token_hash = encode(extensions.digest(token, 'sha256'), 'hex')
 where token_hash is null;

alter table public.maintenance_request_share_links
  alter column token_hash set not null;

alter table public.maintenance_request_share_links
  add constraint maintenance_request_share_links_token_hash_shape
  check (token_hash ~ '^[0-9a-f]{64}$');

create unique index if not exists maintenance_request_share_links_token_hash_uniq
  on public.maintenance_request_share_links (token_hash);

alter table public.maintenance_request_share_links
  drop column token;

-- ── 3) organizations.public_request_token → public_request_token_hash ───────
-- Nullable like the original (orgs without the public-requests feature have
-- no token at all); the unique index stays PARTIAL exactly like 0044's
-- organizations_public_request_token_idx. Dropping the column drops that old
-- index with it.

alter table public.organizations
  add column if not exists public_request_token_hash text;

update public.organizations
   set public_request_token_hash = encode(extensions.digest(public_request_token, 'sha256'), 'hex')
 where public_request_token is not null
   and public_request_token_hash is null;

alter table public.organizations
  add constraint organizations_public_request_token_hash_shape
  check (public_request_token_hash is null
         or public_request_token_hash ~ '^[0-9a-f]{64}$');

create unique index if not exists organizations_public_request_token_hash_idx
  on public.organizations (public_request_token_hash)
  where public_request_token_hash is not null;

alter table public.organizations
  drop column public_request_token;

-- ── 4) order_requests.public_track_token (per-request track credential) ─────
-- See TRACK-LINK CONTINUITY above. Raw at rest by design (the status emails
-- must embed the plaintext at every later send), matching return_token /
-- signature_token. Minted only for public (anonymous) submissions; internal
-- requesters track through the authenticated dashboard and never get one.
-- Backfill every existing public submission so in-flight orders keep getting
-- working track CTAs in their remaining status emails.

alter table public.order_requests
  add column if not exists public_track_token text
    check (public_track_token is null or public_track_token ~ '^[0-9a-f]{64}$');

update public.order_requests
   set public_track_token = encode(extensions.gen_random_bytes(32), 'hex')
 where requester_user_id is null
   and public_track_token is null;

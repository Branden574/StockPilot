# B2B Customer Portal (Phase 6) — Design

**Status:** DRAFT — needs owner review before implementation (introduces an
external-customer auth principal; several decisions below are product calls).
**Goal:** An authenticated, branded portal where an org's B2B customers log in,
browse THEIR catalog at THEIR prices, place orders, see order history, and
reorder — replacing the anonymous one-token /r/[token] request page for orgs
that sell to repeat wholesale customers.

---

## 1. What exists today (grounding)

- **Public request portal:** one org-wide `public_request_token` → `/r/[token]`
  landing page; anonymous; books-only catalog (`item_type='book'` hardcoded in
  public-catalog.ts); NO prices shown (deliberate leak prevention); per-order
  tracking via a separate `/r/track` token. No accounts, no history, no reorder.
- **Order machinery:** `order_requests` already distinguishes internal
  (`requester_user_id`) vs external (`requester_email`) requesters, has the full
  approval → pick → deliver pipeline, signature capture, backorder handling,
  and requester emails. **This is reusable as-is** — the portal creates
  `order_requests`, nothing new.
- **Two principals only:** org members (authenticated) and anonymous
  token-holders. No customer identity, no per-customer pricing, no RLS story
  for a customer principal.
- Registry has `api_access` + `price_tracking` reserved; **no `b2b_portal`
  module id** (the warehouse-OS review reserves the name).

## 2. Architecture (recommended)

**New principal: customer user.** Real Supabase auth users (magic-link/OTP
only — no passwords to manage) mapped through two new tables:

```
customers            (id, organization_id, name, status, price_list_id?, notes)
customer_users       (customer_id, user_id, email, invited_by, accepted_at)
price_lists          (id, organization_id, name)
price_list_items     (price_list_id, item_id, unit_price)       -- explicit prices only
customer_catalog     (customer_id, item_id)                     -- allowlist; empty = org default catalog
```

- A customer user is NOT an `organization_member` — they never see the
  dashboard. A dedicated portal surface (`/portal/[orgSlug]`) with its own
  layout/auth guard keeps the two worlds apart.
- **RLS:** new `is_customer_user(org_id)` / `customer_allowed_item(item_id)`
  helpers (zero-arg-set pattern from mig 0229 — hashed SubPlans, measured as
  authenticated). Customer users get SELECT on exactly: their customer row,
  their allowlisted items (name/sku/image/availability boolean + THEIR price —
  never cost), their own order_requests. INSERT only `order_requests` +
  lines (server action re-validates the allowlist + prices server-side).
- **Ordering:** portal checkout creates a normal `order_requests` with
  `requester_user_id` = the customer user + a new `customer_id` column (one
  ALTER) so history/reorder is one indexed query. The org-side pipeline is
  untouched — orders arrive exactly like today's requests, feed the same
  approval/backorder flow.
- **Module:** `b2b_portal`, off by default, `dependsOn: ['orders']`,
  Business+ plan gate (`planAllowsB2bPortal`). Org-side management UI lives at
  `/dashboard/customers` (list customers, invite users, assign price list +
  catalog, see their orders).
- **Branding:** reuse the org logo + name on the portal chrome (already stored);
  custom domains out of scope v1.

## 3. Phasing

- **P1 — identity + org-side management:** tables + RLS + migrations;
  /dashboard/customers CRUD; magic-link invites (generateLink + Resend — same
  infra as platform invites; NEVER inviteUserByEmail per auth-email memory).
- **P2 — portal catalog + checkout:** /portal auth guard + catalog page
  (allowlist + price list) + cart + submit → order_requests; order
  confirmation email.
- **P3 — history + reorder:** order list + detail (status timeline reusing
  ORDER_STATUS_META labels) + one-tap "reorder" (clones lines into a new cart).
- **P4 — mobile:** org-side customers management parity (portal itself is
  web-first; customer-side native app explicitly out of scope v1).

## 4. Open decisions (owner)

1. **Price exposure default:** items with no price-list entry — hidden from the
   portal (recommended; explicit-only prevents accidental price leaks) or shown
   as "request quote"?
2. **Who approves portal orders:** same pending_approval flow as internal
   requests (recommended — zero new pipeline) or auto-approve for trusted
   customers (a per-customer flag, can come later)?
3. **Availability display:** show on-hand quantities to customers (real
   number vs in-stock/out-of-stock badge — recommended: badge only)?
4. **Naming:** "Customers" vs "Accounts" in the dashboard nav (charter-school
   orgs may prefer "Programs"— the label can ride ORDER_STATUS_META-style
   per-org config later).

## 5. Out of scope (v1)

Custom portal domains; customer-side payments/invoicing (orders remain
fulfillment requests, not paid carts); customer-side native app; multi-org
customer identities (one auth user CAN belong to customers in different orgs —
the customer_users mapping handles it naturally, but no cross-org UI);
self-registration (invite-only).

## 6. Effort

P1+P2 ≈ one focused day each with review; P3 half-day; P4 half-day. Biggest
risk surface = RLS for the new principal (pgTAP per-persona suites like 0229's
+ an adversarial cross-tenant pass before any customer invite goes out).

# B2B Customer Portal (Phase 6) — Design

**Status:** APPROVED for implementation (2026-07-24). The four open product
decisions are resolved — see section 4. Introduces an external-customer auth
principal, so the RLS surface is the highest-risk part of the build and gets an
adversarial cross-tenant pass before any customer is invited.
**Goal:** An authenticated, branded portal where an org's repeat customers log
in, browse THEIR catalog, place orders, see order history, and reorder.

**It does NOT replace the public request link.** The anonymous `/r/[token]`
page has its own job and stays: letting someone **without an account** place a
request when they need to. The two coexist — the portal serves known, repeat
buyers who benefit from history and reorder; the public link serves one-off
accountless requests.

**Charging is per-organization, and many orgs do not charge at all.** L4L North
Region distributes to its schools at no cost. So price display is an ORG-LEVEL
setting, not a product-wide default (section 4, decision 1). Anything that
assumes "customer + catalog implies prices" is wrong for the no-charge case.

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

## 4. Decisions (RESOLVED by owner 2026-07-24)

1. **Pricing is an ORG-LEVEL MODE, not a product-wide default.** An org sets
   how its portal treats money, because some orgs charge and some do not:
   - `no_charge` — the portal shows NO prices anywhere and no cart totals.
     Items are simply requestable. This is L4L North Region's mode: it
     distributes to its schools at no cost, so a price column, a "request
     quote" action, and an order total would all be meaningless there.
     Per-customer price lists are inert in this mode.
   - `priced` — customer-specific prices from their price list. Items in the
     customer's catalog that have NO price-list entry are still SHOWN, with no
     price and a "request quote" action (owner's choice; the alternative was
     hiding them). Note this only ever applies to items already allowlisted for
     that customer — the catalog allowlist, not the price list, controls what a
     customer can see at all.
   The mode must be explicit per org with `no_charge` as the safer default, so
   a misconfigured org cannot accidentally display prices. Cost price is NEVER
   exposed in either mode.
2. **Approvals:** portal orders land in the SAME `pending_approval` queue as
   internal requests. No new pipeline, no per-customer auto-approve in v1.
3. **Availability:** show REAL on-hand quantities to customers. Owner chose
   this over an in-stock/out badge. Recorded tradeoff: invited customers can
   therefore see actual stock levels, including when the org is low; revisit if
   that proves undesirable (it is a display-layer change, not structural).
4. **Naming:** "Accounts" in the dashboard nav (not "Customers"). The
   underlying tables keep the `customers` / `customer_users` names; this is a
   label-only decision and can ride per-org terminology config later.

## 4b. The public request link (unchanged, and why)

The existing anonymous `/r/[token]` page keeps its current behaviour and shows
NO prices. That is already the right shape for a no-charge org like L4L, whose
entire model is accountless requesting at no cost, and it remains the deliberate
leak-prevention posture for everyone else. Putting prices on the public link is
NOT part of this work: an anonymous link has no customer identity, so there is
no price list to resolve against, and org-wide pricing on a public URL is a
different (and riskier) feature. If a charging org ever wants that, it is its
own spec.

Consequence for this build: the portal must not assume it is the only external
ordering path. Both create ordinary `order_requests`, so the org-side pipeline
already treats them identically; nothing in P1-P4 may narrow or reroute the
public path.

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

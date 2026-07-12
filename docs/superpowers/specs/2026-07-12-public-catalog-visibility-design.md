# Public Request Catalog — Visibility Controls (Owner PRD, 2026-07-12)

Owner-delivered verbatim requirement (condensed; full intent preserved).
GOAL: the public request ordering page must be a CURATED catalog, not a
mirror of the internal Orders catalog. Admins control exactly what each
public link exposes.

## Core model
- TWO catalog views over the SAME inventory records (no duplicate DB):
  internal (authed, role-driven, full) vs public (per-link, explicit).
- Public visibility statuses: internal_only | public_and_internal |
  hidden | selected_public_links. DEFAULT for new/imported items:
  internal_only (nothing becomes public by accident).
- Category-level visibility is the DEFAULT; item-level overrides win;
  UI must show inherited-vs-override clearly. Rules: public category +
  internal-only item = hidden; internal category + item enabled on a
  specific link = visible ONLY on that link; archived/disabled = never
  public; empty public categories don't render.
- Books get identical controls (section toggle, book categories,
  individual titles, qty display, multi-copy policy).
- Module/inventory-type visibility per link (items/books/devices/...).

## Per-link catalogs
Each public link: own catalog config + name, purpose, allowed
categories/items/books, request qty limits (min/max, per item/request/
user/link), availability dates, active flag, audience/charter
restrictions, custom instructions/branding, expiration. Visible on one
link ≠ visible on others.

## Admin UI
"Public request links" management area: link list (status, audience,
counts, edit/copy/disable) + per-link Catalog Visibility editor (search,
filters by category/charter/warehouse/availability/type, bulk enable/
disable/add/remove/limits with confirmation summary, copy-config-from-
link) + "Preview as public user". Item detail/edit + bulk item actions
also expose visibility. Public-facing fields: public display name/
description/image/instructions (separate from internal). Qty display
choices: exact | in stock | limited | unavailable | none.

## Enforcement (backend, non-negotiable)
- Public API returns ONLY eligible items (link active + item active +
  allowed on that link + category/item visibility + charter/warehouse/
  audience + date window + not archived/hidden). NO frontend-only
  filtering; no hidden data in network responses; ID manipulation must
  fail. Submission re-validates every line (still available on that
  link, qty within limits, link active) — reject with "This item is no
  longer available through this request form..."
- NEVER expose: cost, vendor, source PO, serials, rack locations,
  internal notes, charter assignments, reserved details. SKU only if
  intentionally enabled.
- Cache invalidation on any config change (no stale public catalogs).
- Historical orders keep their item details forever.
- Permissions: new admin perms for managing public catalogs/links
  (bump 0207 pgTAP count per configurable-permissions memory).
- Audit history for every visibility change (user, when, link, before/
  after) — surfaces in activity log.

## Migration for existing links
Do NOT suddenly expose everything or hide everything: preserve each
existing link's currently-visible catalog as its explicit config;
require admin review. New inventory defaults internal_only.

## Acceptance: 24 criteria + 10 test scenarios in owner message
(internal-only item, category/override matrix, multi-link isolation,
books, qty limit enforcement, mid-session removal, PO-import defaults,
disabled link, historical order integrity).

## Also requested same message (separate small items)
1. Blue-hued primary buttons ("+ New category", "+ New item", etc.)
   → switch to the green used on the Orders page ("+ Place order").
2. Public orders page should look like the internal storefront
   (/dashboard/orders/new) — same design language.

## Required first step next session
Investigation pass: current public-link architecture (public_link
source on order_requests, public request page + API), storefront
catalog loaders (server/loaders/orders-new-catalog.ts — perf memory:
loaders MUST stay there), item/book models, caching, import defaults.
Determine if the public page reuses the internal catalog endpoint; if
so, split public query + response schema FIRST. Then brainstorm →
phased plan (superpowers flow) like the onboarding program.

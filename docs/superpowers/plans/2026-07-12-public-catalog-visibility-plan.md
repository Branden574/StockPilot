# Public Catalog Visibility — Implementation Plan

> Spec: docs/superpowers/specs/2026-07-12-public-catalog-visibility-design.md
> Investigation (file:line evidence): docs/superpowers/specs/2026-07-12-public-catalog-investigation.md
> Read BOTH before any task.

**Goal:** per-link curated public request catalogs, backend-enforced, with
zero behavior change for existing public links at migration time.

## Locked design decisions

1. **Link model** — new `public_request_links` table (org fk, name, purpose,
   instructions, token unique 64-hex, active, expires_at, available_from/
   until, availability_display 'exact'|'bucket'|'none' default 'bucket',
   books_enabled bool default true, items_enabled bool default false,
   include_public_pool bool default false, default_max_qty int null,
   created_by, timestamps) + `public_link_catalog_entries`
   (link_id, item_id, max_qty_per_request int null, pk(link_id,item_id)).
   **Migration freezes behavior:** every org with a non-null
   organizations.public_request_token gets one "General request link" row
   carrying the SAME token (existing URLs keep working) and explicit
   catalog entries for every currently-eligible book (active, not deleted,
   in an is_public_orderable warehouse). organizations.public_request_token
   stays but the read path resolves links-table-first (legacy fallback can
   be dropped once verified).
2. **Item visibility field** — inventory_items.public_visibility text check
   ('internal_only','public','hidden') DEFAULT 'internal_only' (imports/new
   items never leak). 'selected links' is expressed by catalog entries, not
   a status. user_categories.public_visibility ('public','internal_only')
   default 'public'.
3. **Runtime eligibility on link L** (single SQL predicate, enforced in BOTH
   the catalog query and submit validation): item active AND not deleted
   AND warehouse orderable AND item.public_visibility != 'hidden' AND
   ( entry(L,item) EXISTS OR (L.include_public_pool AND
   item.public_visibility='public' AND category.public_visibility='public') )
   AND link active/not expired/date-window AND per-type toggle
   (books_enabled/items_enabled by item_type).
4. **Separate public schema** — new PublicCatalogItem (id, displayName
   [public_display_name fallback name], publicDescription fallback null,
   imageUrl, categoryLabel, availability bucket per link setting, maxQty).
   NEVER: cost, sku (unless later flag), locations, reserved, charters.
   Add inventory_items.public_display_name + public_description text null.
5. **Qty enforcement** — submit clamps to entry.max_qty_per_request ??
   link.default_max_qty ?? unlimited; violations → 400 invalid_line with
   the spec's user-facing message.
6. **Permissions** — new perms `public_links:manage` (owner/admin default)
   gating all link/catalog mutations; bump 0207 pgTAP count per memory.
7. **Audit** — audit_logs events: public_link.created/updated/disabled,
   public_catalog.entry_added/entry_removed/bulk_change, item.public_visibility_changed
   (metadata: link_id, item_id, before, after).
8. **Caching** — public catalog loader = unstable_cache keyed
   [linkId, warehouseId], tag `public-catalog-<linkId>`; every admin
   mutation calls revalidateTag(tag, 'max') (NEVER updateTag — it throws at
   runtime in this Next config, see memory).

## Phases

**P1 (backend core — this dispatch):**
- Mig 0261: tables/columns/backfill above + RLS (org-member read for links;
  writes via has_permission('public_links:manage'); entries same; public
  surfaces keep using the service-role path like today).
- server/services/public-links.ts: CRUD + token mint (reuse generateToken
  pattern), rotate, list w/ counts.
- server/services/public-catalog.ts: link-aware catalog (eligibility
  predicate, PublicCatalogItem mapping, cache+tags). Keep the exported
  legacy function signature working during transition.
- app/r/[token]: resolve link (links-first, org-token fallback), respect
  active/expiry/dates, pass link config down.
- POST /api/v1/public/order-requests: accept link token, re-validate every
  line against the SAME eligibility predicate + qty caps.
- pgTAP for the migration (eligibility + RLS).
**P2 (admin UI):** settings/public-requests → links list + per-link catalog
editor (search/filters/bulk with confirmation summary) + preview-as-public
+ copy-config; wire audit events; new perm in roles UI.
**P3 (item/category controls):** visibility select on item detail/edit +
Items-table bulk action + category toggle + inherited/override indicator.
**P4 (public page):** restyle to match internal storefront (owner request),
green primary buttons app-wide (owner request), public display fields,
availability display modes, configured empty-state message.
**P5 (verification):** the spec's 10 test scenarios live in Demo Co + a
second scratch link; mobile-web pass on /r/*.

Global constraints: migrations applied by session owner via
`supabase db push --linked`; state-machine/mirror rules n/a; NO Claude
commit trailers; live verification before "done"; loaders for the INTERNAL
storefront stay in server/loaders/orders-new-catalog.ts untouched.

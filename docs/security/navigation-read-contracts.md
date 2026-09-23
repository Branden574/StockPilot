# Navigation: caches, freshness and read contracts

Status 2026-09-22, after the navigation-recovery work (`perf/nav-recovery`,
`sec/nav-brief-findings`, merged on `nav/combined`). Numbers marked LAB come
from a local production build against the local Supabase stack with
production's per-call cost put back in (`apps/web/scripts/perf-lab/lab`): they
compare builds under one condition, they are not production numbers.

## 1. One owner per copy of the data

| Copy | Owner | Key | Fresh for | Emptied by | A failed read |
| --- | --- | --- | --- | --- | --- |
| Request context (profile, memberships, org row, modules) | `lib/auth/request-context-bundle.ts`, React `cache()` | one render | the render | nothing | legacy reads, only once the cookie session is verified to be the header's user |
| Service context (RLS client, role, permissions, MFA state) | `server/services/context.ts` `withContext`, React `cache()` | one render | the render | nothing | throws |
| Items/Books default list, dataset, lookups, value, trend buckets | `server/loaders/inventory-list.ts`, `unstable_cache` | org + warehouse key + view | 60 s, then stale-while-revalidate | tag `inventory-list-<org>` (`expire: 0`), by every service stock write (guard: `inventory-list-invalidation.guard.test.ts`) and by the realtime watcher | throws, nothing cached; the page takes the live path |
| New-order catalog | `server/loaders/orders-new-catalog.ts`, `unstable_cache` | org + warehouse + scope key | 60 s, SWR | `orders-new-v2-catalog` | throws, nothing cached |
| Catalog scope key | `resolveCatalogScopeKey`, computed per request from the same SQL helpers `inventory_items_select` uses, as the caller | not cached | per request | n/a | throws: the storefront fails closed |
| Signed photo URLs | `server/services/item-images.ts`, per-path `unstable_cache` + 1 h instance memo | storage path | 25 days (URL valid 30) | never | nothing cached; the photo's own fallback shows |
| Client router cache | Next, `staleTimes: { dynamic: 90, static: 180 }` | tab, URL, segment | visited pages 90 s; prefetched loading shells 180 s | any Server Action that revalidated (purges it and re-prefetches visible links); sign-in and sign-out | n/a |
| Items instant dataset (local search, sort, filter, pages) | `components/inventory/inventory-table.tsx` | tab | while the page is mounted | a re-render with a new dataset | the table stays in server mode |
| Tour state | `lib/onboarding/tour-state-cache.ts` | user | the browser session | sign-out, user change | not kept |

Rules that hold for all of them:

- Org-shared caches are read only for manager and above with `items:read`
  (`canUseSharedInventoryCaches`). Staff and viewers always read live under
  their own RLS.
- No permission decision is cached across requests. An access read that fails
  denies.
- A failed read is never stored as an empty answer.

## 2. The three navigation paths

**The destination is already in the tab** (revisit within 90 s, Back,
Forward): drawn from the router cache, no server trip. LAB: Back 42 ms, Forward
20 ms; on Items, next page, search, sort and filter are local (instant mode):
29-65 ms.

**The destination has to be fetched.** The click is acknowledged in about
30 ms (progress bar, link spinner, the tab's own underline). The route's
loading skeleton appears as soon as the route's shape is known: ~50 ms for
sidebar routes (warmed ahead of time) and, since item rows warm their route
when the pointer arrives, ~80 ms for an item (was 166). Content follows when
the render arrives, but never earlier than 300 ms after the skeleton appeared
(section 4).

**The data changed, or access changed.** A stock write expires the org's list
cache at commit, in the service. The saving tab's action response carries the
re-rendered page (no `router.refresh()` after it). Other tabs get one refresh
per database transaction (the realtime watcher merges the events of one
commit). The notification bell re-renders only the Notifications page. Hidden
tabs do no server work and refresh once when visible again. A permission change
refreshes through `PermissionsRealtime`; "sign out this device" signs a web
tab out live, once GoTrue confirms the session is gone.

## 3. Read contracts

What each navigation must read before its content can be shown, and what it
reads beside. LAB trace (production-median call cost, 5 navigations each):
Supabase calls, and how many of them waited for the one before.

| Navigation | Access prerequisites | Primary content | Also read (same render) | Calls, in a row: before -> after |
| --- | --- | --- | --- | --- |
| Items (manager+) | request context RPC, GoTrue factors (MFA) | shared list cache (rows, totals, value) | saved views, racks | 4, 2 -> 4, 2 |
| Books (manager+) | module gate, request context, GoTrue factors | shared dataset cache | saved views, racks | 4, 3 -> 4, 2 |
| Orders | module gate, request context, GoTrue factors | order list | | 3, 3 -> 3, 2 |
| Item, Overview tab | request context, GoTrue; item row + warehouse access + staged holdings | the row (with its last editor), holdings, locations | photos + signing, cost history (two reads, now together), custom fields, serials, reservations, category, supplier | 16, 3 -> 15, 3 |
| Item, Movements or Activity tab | as Overview | the row, holdings, locations, the feed (movements + audit) | nothing only Overview shows | 18, 3 -> 9, 2 |
| Order | request context, GoTrue | header, then lines + reservations + warehouse + requester/picker names | stock-shortage check, pickers, returns; the timeline streams after | 10, 7 -> 10, 5 |
| One stock adjustment (saving tab, 2.5 s after Apply) | action: request context, GoTrue | pre-write checks, `adjust_stock` | the page re-render in the action response, one realtime echo | 79 -> 41 calls |

The GoTrue factors read stays on every navigation on purpose: it is how a soft
navigation enforces the organization's MFA policy (the layout does not re-run
on a soft navigation).

## 4. Why content can wait after its data has arrived

React holds a Suspense boundary's content until 300 ms after its fallback
appeared (`FALLBACK_THROTTLE_MS`, react-dom). Every dashboard route's
`loading.tsx` is such a fallback, and `loading.tsx` creates a boundary around
each child slot of its layout, so every section sits inside two new
boundaries (the dashboard's and its own). LAB, production-median call cost,
130 ms round trip: Items' page data was complete at 141 ms and shown at 352 ms;
Books 183 -> 349; Orders 186 -> 348.

Going below that floor needs either the destination's data in the tab before
the click, or no fallback on fast navigations. The second is measured on
`exp/deferred-route-skeleton` (the four busiest routes lose their
`loading.tsx`; a navigation still waiting after 400 ms draws the destination's
skeleton from ordinary state, which React does not hold). It changes what a
slow navigation looks like, so it is an owner decision, not a fix.

LAB, same conditions, median of 40: Items 351 -> 218 ms, Books 351 -> 210,
Orders 348 -> 181, Item 382 -> 215, Order 380 -> 313; the click is still
acknowledged in 30-50 ms. Under production's call-time spread, slow
navigations showed the skeleton at ~430 ms instead of ~50-80 ms. Open before
it could ship: the late skeleton and the progress bar follow link clicks only
(Back/Forward to a page the tab no longer holds, and navigations started from
code, would show nothing until the page arrives), and the bar's 8 s give-up
would remove the skeleton while the request is still out.

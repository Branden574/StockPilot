# Viewer Category Visibility — Design

**Date:** 2026-05-19
**Status:** Draft (awaiting user review)
**Owner:** Branden

## Problem

Today every viewer in an org can see every active inventory item across the warehouses they're assigned to. There's no way to restrict a viewer to a subset of categories — e.g. "Electronics + Wellness, but NOT Swag." The org's admin needs a way to limit viewers to a category whitelist so partner-facing or read-only accounts only see what's relevant to their function.

## Goals

- Admin can pick a set of categories that a specific viewer is allowed to see.
- Viewer reading inventory_items only gets back rows in their granted categories. Same for categories list itself, search, reports, PDFs, the orders/new picker — *every* surface that lists items.
- When a new category is created later, admin can re-open the viewer's profile and add the new category to their grant.
- Hard security: enforcement lives in Postgres RLS, not application code.

## Non-goals

- Restricting staff role (per user decision — staff keeps full warehouse visibility).
- Restricting based on tags, item types, suppliers, or anything besides category.
- Per-warehouse category grants (a viewer's grants apply across all warehouses they have access to — combined with warehouse scoping for the final set).
- Migrating existing viewers — when this ships, all current viewers see everything (no rows in the new table → unrestricted).

## Hard constraint

**RLS is the security floor.** Every other layer (service methods, UI filters, AI tools) is convenience on top. If RLS denies a row, no code path in the app can return it.

## Mental model

A viewer is **restricted** if they have at least one row in `user_category_assignments`. Otherwise they're **unrestricted** (today's behavior).

```
viewer with ZERO rows in user_category_assignments    →  sees everything (back-compat default)
viewer with rows for Categories {A, B, C}             →  sees ONLY items in A, B, or C; never sees uncategorized items
manager / admin / owner                               →  always unrestricted (this feature doesn't apply)
staff                                                 →  always unrestricted (out of scope)
```

Uncategorized items (`inventory_items.category_id IS NULL`) are **invisible** to restricted viewers. Stricter is better than chasing leaks.

## Database

### Table

```sql
create table public.user_category_assignments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.user_profiles(id) on delete cascade,
  category_id     uuid not null references public.categories(id) on delete cascade,
  assigned_by     uuid references public.user_profiles(id) on delete set null,
  assigned_at     timestamptz not null default now(),
  unique (user_id, category_id)
);

create index user_category_assignments_user_idx on public.user_category_assignments(user_id);
create index user_category_assignments_category_idx on public.user_category_assignments(category_id);
```

`on delete cascade` everywhere — when a category is deleted, the assignment row goes with it; when a user is removed, their grants go with them.

### Helper RPC

```sql
create or replace function public.user_can_see_item_category(
  p_user_id     uuid,
  p_category_id uuid
) returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  -- Manager/admin/owner: always true.
  -- Staff: always true (this feature is viewer-only).
  -- Viewer with no rows in user_category_assignments: always true (unrestricted default).
  -- Viewer with rows: true iff p_category_id is in their assignment set.
  -- p_category_id IS NULL: false for restricted viewers, true for everyone else.

  with role_row as (
    select role::text as role, organization_id
    from public.user_organization_memberships uom
    where uom.user_id = p_user_id
    limit 1
  )
  select case
    when (select role from role_row) in ('owner','admin','manager','staff') then true
    when (select role from role_row) = 'viewer' then
      case
        when not exists (
          select 1 from public.user_category_assignments uca
          where uca.user_id = p_user_id
        ) then true                                            -- unrestricted viewer
        when p_category_id is null then false                  -- restricted viewer can't see uncategorized
        else exists (
          select 1 from public.user_category_assignments uca
          where uca.user_id = p_user_id and uca.category_id = p_category_id
        )
      end
    else false
  end;
$$;
```

`security definer` so RLS policies can call it without needing to grant the caller direct read access to `user_organization_memberships` or `user_category_assignments` (both are sensitive tables).

### RLS policies

Add a SELECT filter to `inventory_items` AND to `categories` so a restricted viewer can't even enumerate categories they can't see.

```sql
create policy inventory_items_category_visibility
  on public.inventory_items
  for select
  to authenticated
  using (
    public.user_can_see_item_category(auth.uid(), category_id)
  );

create policy categories_visibility
  on public.categories
  for select
  to authenticated
  using (
    public.user_can_see_item_category(auth.uid(), id)
  );
```

These compose with the existing org + warehouse-access policies (Postgres ANDs all matching USING clauses across policies of the same role+command).

### Storage policy for item-images

Item photos shouldn't be reachable to a viewer who can't see the parent item. The existing `item-images` bucket policy already references `item_images.item_id`, which joins to `inventory_items` (and thus RLS-filters). Verify in the implementation phase; add a join-based RLS check if not already there.

## Application surface

### Orders flow (the picker the user just rebuilt)

When a restricted viewer opens `/dashboard/orders/new`, they should see the same restriction applied:

- **Aisle pills** show only their granted categories (the `categories` RLS policy handles this — they literally can't enumerate the others).
- **Card grid** shows only items in those categories (the `inventory_items` RLS policy handles this).
- **Quick-add row** shows only frequently-ordered items in those categories (the `/api/orders/freq` endpoint goes through the user's RLS-scoped client; restricted items are filtered out automatically).
- **Cart submit** — server action revalidates each line's item_id against the user's access on the way in, so even a hand-crafted POST with a hidden item_id is rejected.

The two cached server paths the orders picker uses (`loadCatalogItemsCached`, `loadChartersForWarehouseCached`) bypass RLS via admin client. **These MUST receive the user's accessibleCategoryIds and apply the filter manually**, or the cache will leak across viewers. Cache key must include the user's category-access hash so a restricted viewer doesn't read a manager's cached payload. This is the single highest-risk integration point — call it out in the plan, test it explicitly.

Same applies to the public link (`/r/[token]`) — but public link is anonymous (no logged-in viewer), so category restrictions don't apply there. Public link continues to show everything in the warehouse that's marked `item_type = 'book'`.

### Service layer (defense in depth)

`InventoryService.list()` and related read paths receive an `accessibleCategoryIds: Set<string> | null` from a new helper `loadCategoryAccess(ctx)`:

- Returns `null` for unrestricted users (admin/manager/owner, staff, viewer with no rows).
- Returns the explicit set for restricted viewers.

When non-null, the service explicitly `.in('category_id', [...set])` (or matches the filter) so the result is correct even if RLS has a future bug. Belt-and-suspenders.

### Admin UI

New section on the user edit page (or invite flow):

```
┌────────────────────────────────────────────────────────┐
│ Category access                                         │
│ (only applies to viewers; leave empty for unrestricted) │
│                                                         │
│  ☑ Electronics      ☑ Wellness Items                    │
│  ☐ Swag             ☑ Books                             │
│  ☐ Conference Item  ☑ Apparel                           │
│  ☐ Novel            ☐ Textbook                          │
│                                                         │
│  [Save changes]   No categories selected = sees all     │
└────────────────────────────────────────────────────────┘
```

- Only renders when the user's role is `viewer` (with a note "Convert to viewer to set category restrictions" if it's another role).
- Checkbox grid lists every active category in the org, alphabetically.
- When a new category is added later, the next time admin opens this user's page, the new category appears as an unchecked checkbox. Admin can grant access by checking it.
- "Select all" / "Clear all" helpers.
- Toast on save: "Updated category access for {viewer name}. They can now see {N} categories."
- Audit log: emit `user.category_access.updated` event with the grant delta.

### Service action

```typescript
// server action: setUserCategoryAccess(userId: string, categoryIds: string[])
// - Requires manager+ role on the calling user
// - Validates target user is in the same org
// - Atomic replace: delete existing rows for user, insert the new set
// - Emits audit event
// - revalidatePath('/dashboard/users')
```

## Edge cases

| Case | Behavior |
| --- | --- |
| Viewer is granted Category X, then X is deleted | Cascade-delete drops the row. Viewer's grant set shrinks automatically. If their grant set becomes empty → they become unrestricted again. Admin sees this when reopening the user page. |
| Admin tries to set category access on a manager | UI shows "Category access doesn't apply to managers — they see everything." Save button hidden. |
| Viewer is restricted to Category A, places an order request with an item in Category B | Can't happen — they couldn't even see the item to put it in their cart. The orders/new picker server-loads items via the same RLS-scoped query. Defense in depth: server action validates each line's item_id is visible to the caller before creating the order. |
| Viewer with restrictions opens a saved view that filtered to Category B (which they can't see) | View loads with empty results. Cleaner UX than an error. |
| Item is moved from a viewer-visible category to one they can't see | They lose visibility on next read. No notification — this is normal admin work. |
| Soft-deleted items | Still filtered by category_id; deletion doesn't bypass the policy. |
| Cycle counts referencing a hidden item | Counts don't surface to that viewer (RLS at the join). |
| Reports (valuation, dead stock, etc.) | Numbers reflect only what the viewer can see. Acceptable — they're scoped to their slice. If a viewer is partial-restricted, their valuation total ≠ org total, by design. |
| AI search / chatbot for restricted viewer | Goes through same query path → RLS catches everything. No leakage. |

## Permissions

Two new permission constants:

- `users:assign_categories` — required to grant/revoke category access. Granted to admin and manager by default.

Existing constants (`users:invite`, `users:update`) cover the rest of the user-management UI; no new ones needed there.

## Files to add

- `supabase/migrations/0128_viewer_category_access.sql` — table + RPC + RLS policies + grants
- `apps/web/src/server/services/user-categories.ts` — `getAccessibleCategoryIds(ctx)`, `setUserCategoryAccess(targetUserId, categoryIds)`
- `apps/web/src/server/actions/user-categories.ts` — server action wrapping the service
- `apps/web/src/components/users/category-access-card.tsx` — checkbox grid on the user edit page
- `apps/web/src/server/services/user-categories.test.ts` — service unit tests
- `apps/web/src/server/services/inventory.category-rls.test.ts` — integration test asserting RLS denies restricted viewers

## Files to modify

- `packages/core/src/constants/permissions.ts` — add `users:assign_categories`
- `apps/web/src/server/services/audit.ts` — add `user.category_access.updated` AuditEvent
- `apps/web/src/app/(dashboard)/dashboard/users/[id]/page.tsx` (or wherever the user-edit page lives) — mount the new `CategoryAccessCard`

## Testing

### Unit
- `user_can_see_item_category` truth table: all 4 roles × {has-assignments, no-assignments} × {null-category, granted-category, ungranted-category}.
- Service: setUserCategoryAccess atomic replace.

### Integration (RLS, against real Postgres)
- As a viewer with grants for Category A only:
  - SELECT inventory_items where category_id = A → returns rows ✓
  - SELECT inventory_items where category_id = B → empty ✓
  - SELECT inventory_items where category_id IS NULL → empty ✓
  - SELECT categories → only A
- As a viewer with NO grants:
  - SELECT inventory_items → all items in their warehouses (current behavior preserved) ✓
- As a manager:
  - SELECT inventory_items → everything in org (current behavior preserved) ✓

### E2E (manual)
1. Create a viewer account
2. Grant them access to Categories {Electronics, Wellness}
3. Sign in as that viewer; verify /dashboard/inventory shows only those categories
4. Verify /dashboard/orders/new aisle pills show only those categories
5. Verify reports total only those categories
6. Create a new category "Test Cat"; verify it's invisible to the viewer
7. As admin, reopen the viewer's page, check "Test Cat", save
8. As viewer, refresh; verify "Test Cat" items now appear
9. As admin, uncheck all categories on the viewer
10. As viewer, refresh; verify they're back to seeing everything (zero-grants = unrestricted)

## Risk surfaces

- **Admin client (createAdminClient) call sites.** Audit each one — these bypass RLS. List of current uses: `withApiContext`, `catalog-thumbnails` endpoints, signed-URL services, public-order-request POST, `loadCatalogItemsCached` (orders new v2), `loadChartersForWarehouseCached`. Each needs review: if it returns inventory_items or categories, it must apply the category filter manually.
- **`security definer` RPCs.** Audit: `confirm_order_signature`, `duplicate_inventory_item`, `inventory_set_rack`, the new `order_request_top_skus_for_warehouse`. None currently return category data to the caller; verify in the implementation.
- **Caching layer.** The `unstable_cache` wrappers around catalog loads must include `auth.uid()` in the cache key OR be invalidated when category access changes. Otherwise a manager's cached payload could serve to a viewer. Plan: cache key includes `accessibleCategoryIds` hash (already varies per user — but unstable_cache caches across users by default unless keyed). Critical to get right.

## Out of scope (future)

- Per-warehouse category grants
- Restricting other read surfaces (tags, suppliers, locations) the same way
- Self-service: a viewer requesting access to additional categories
- Logging viewer attempts to access denied items (RLS just returns empty; no warn)

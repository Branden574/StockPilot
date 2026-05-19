# Viewer Category Visibility — Manual RLS Verification

**Pairs with:** `docs/superpowers/specs/2026-05-19-viewer-category-visibility-design.md` · `docs/superpowers/plans/2026-05-19-viewer-category-visibility.md`

This file documents the SQL commands to run against the production (or staging) Postgres to verify the RLS policies from migration 0128 work as designed. Run these BEFORE marking Task 10 (manual E2E) complete — they prove the policy enforces visibility at the row level, independent of any application code.

Open the Supabase dashboard SQL editor (or `psql` to the prod DB) and run each block in order.

## Prep — capture some test ids

Pick a real org, a real warehouse, a real viewer, and at least two real categories. Substitute the IDs below.

```sql
-- Replace these:
\set org_id    '00000000-0000-0000-0000-000000000000'
\set wh_id     '11111111-1111-1111-1111-111111111111'
\set viewer_id '22222222-2222-2222-2222-222222222222'  -- a viewer's user_profiles.id
\set cat_a_id  '33333333-3333-3333-3333-333333333333'  -- a category that has items
\set cat_b_id  '44444444-4444-4444-4444-444444444444'  -- another category that has items
```

## Truth table verification

Run each scenario and confirm the row count matches the expected column.

### Scenario 1 — viewer with NO grants (unrestricted default)

```sql
-- Clear any existing grants
delete from public.user_category_assignments where user_id = :'viewer_id';

-- Simulate the viewer's request. RLS will scope to their warehouses
-- via the existing policies; we override just the JWT claim Supabase
-- uses for auth.uid().
set local role to authenticated;
set local "request.jwt.claim.sub" to :'viewer_id';

-- Expected: NON-ZERO row count (sees everything in their warehouse)
select count(*) from public.inventory_items where warehouse_id = :'wh_id';

reset role;
reset "request.jwt.claim.sub";
```

### Scenario 2 — viewer granted Category A only

```sql
-- Grant only Category A
delete from public.user_category_assignments where user_id = :'viewer_id';
insert into public.user_category_assignments (organization_id, user_id, category_id)
values (:'org_id', :'viewer_id', :'cat_a_id');

set local role to authenticated;
set local "request.jwt.claim.sub" to :'viewer_id';

-- Expected: only items in Category A
select count(*) from public.inventory_items
where warehouse_id = :'wh_id' and category_id = :'cat_a_id';
-- Should match the unrestricted count for Cat A.

-- Expected: ZERO items in Category B
select count(*) from public.inventory_items
where warehouse_id = :'wh_id' and category_id = :'cat_b_id';

-- Expected: ZERO uncategorized items (restricted hides null-category)
select count(*) from public.inventory_items
where warehouse_id = :'wh_id' and category_id is null;

-- Expected: categories table shows ONLY Category A (no leaking other names)
select id, name from public.categories
where organization_id = :'org_id'
order by name;

reset role;
reset "request.jwt.claim.sub";
```

### Scenario 3 — manager sees everything (unaffected by this feature)

```sql
-- Pick a manager:
\set manager_id '55555555-5555-5555-5555-555555555555'

set local role to authenticated;
set local "request.jwt.claim.sub" to :'manager_id';

-- Expected: SAME total as the unrestricted count from Scenario 1
select count(*) from public.inventory_items where warehouse_id = :'wh_id';

-- Expected: full category list visible
select count(*) from public.categories where organization_id = :'org_id';

reset role;
reset "request.jwt.claim.sub";
```

### Scenario 4 — viewer's grants are revoked → back to unrestricted

```sql
delete from public.user_category_assignments where user_id = :'viewer_id';

set local role to authenticated;
set local "request.jwt.claim.sub" to :'viewer_id';

-- Expected: NON-ZERO row count (sees everything again)
select count(*) from public.inventory_items where warehouse_id = :'wh_id';

reset role;
reset "request.jwt.claim.sub";
```

## Helper RPC truth table

Optional but useful: probe `user_can_see_item_category` directly to confirm each branch returns the expected boolean.

```sql
-- For each of these calls, set the claim, then check the result.

set local role to authenticated;
set local "request.jwt.claim.sub" to :'viewer_id';

-- Viewer with grants on A, asked about A → true
select public.user_can_see_item_category(:'viewer_id', :'cat_a_id');

-- Viewer with grants on A, asked about B → false
select public.user_can_see_item_category(:'viewer_id', :'cat_b_id');

-- Viewer with grants on A, asked about NULL → false
select public.user_can_see_item_category(:'viewer_id', null);

reset role;
reset "request.jwt.claim.sub";
```

## Cleanup

```sql
delete from public.user_category_assignments where user_id = :'viewer_id';
```

## Pass criteria

All scenarios behave EXACTLY as the "Expected" comment notes. If any return unexpected counts:

1. Confirm migration 0128 actually applied (`\df+ public.user_can_see_item_category` should show the function).
2. Confirm the policies exist: `\d+ public.inventory_items` should list `inventory_items_category_visibility`.
3. Confirm the test viewer is actually a viewer in `organization_members` (not a manager/admin).

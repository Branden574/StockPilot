# Viewer Category Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **HARD CONSTRAINT:** This is a security feature. RLS is the floor — every task that touches read paths must preserve or strengthen the policy. Cache-key correctness is the single highest-risk integration point; do not skip Task 7 verification.

**Goal:** Restrict viewer accounts to a category whitelist. Admin picks which categories a viewer can see; restrictions enforced by Postgres RLS.

**Architecture:**
1. New table `user_category_assignments` + helper RPC `user_can_see_item_category` (security definer).
2. RLS SELECT policies on `inventory_items` and `categories` call the RPC.
3. Service-layer + cache-key invalidation as defense in depth.
4. New admin UI inside the existing user-edit dialog (`team-manager.tsx`).

**Tech Stack:** Postgres 15 RLS · Supabase · Next.js 16 · React 19 · zod · vitest. No new deps.

**Spec:** `docs/superpowers/specs/2026-05-19-viewer-category-visibility-design.md`

---

## File structure

### Create
- `supabase/migrations/0128_viewer_category_access.sql` — table + RPC + policies + grants
- `apps/web/src/server/services/user-categories.ts` — `getAccessibleCategoryIds(ctx)`, `setUserCategoryAccess(targetUserId, categoryIds)`
- `apps/web/src/server/services/user-categories.test.ts` — unit tests for the service
- `apps/web/src/server/actions/user-categories.ts` — server action
- `apps/web/src/components/team/category-access-card.tsx` — checkbox grid inside the existing user-edit dialog

### Modify
- `packages/core/src/constants/permissions.ts` — add `users:assign_categories`
- `apps/web/src/server/services/audit.ts` — add `user.category_access.updated` AuditEvent
- `apps/web/src/server/services/inventory.ts` — `list()` accepts an optional accessible-categories filter; cache key respects it
- `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx` — `loadCatalogItemsCached` cache key includes the user's category-access hash; payload is filtered server-side too
- `apps/web/src/components/team/team-manager.tsx` — mount `<CategoryAccessCard>` inside the user-edit dialog when role === 'viewer'

---

## Task 1: Migration — table, RPC, RLS policies

**Files:** Create `supabase/migrations/0128_viewer_category_access.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0128_viewer_category_access.sql
--
-- Restrict viewer accounts to a category whitelist. Admin assigns
-- categories; a viewer with ANY rows in user_category_assignments
-- sees only items in those categories. A viewer with ZERO rows is
-- unrestricted (preserves back-compat for existing viewers). This
-- feature does not apply to staff/manager/admin/owner.
--
-- Architecture: RLS is the security floor. user_can_see_item_category
-- is security definer so RLS policies can call it without granting
-- read access to user_category_assignments (sensitive) or
-- organization_members (sensitive). The policies on inventory_items
-- and categories both invoke it.

create table public.user_category_assignments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.user_profiles(id) on delete cascade,
  category_id     uuid not null references public.categories(id) on delete cascade,
  assigned_by     uuid references public.user_profiles(id) on delete set null,
  assigned_at     timestamptz not null default now(),
  unique (user_id, category_id)
);

create index user_category_assignments_user_idx
  on public.user_category_assignments(user_id);
create index user_category_assignments_cat_idx
  on public.user_category_assignments(category_id);

alter table public.user_category_assignments enable row level security;

-- Org-scoped read/write for the assignment table itself. Service-role
-- bypasses; manager+ in the org can manage; users can read their own.
create policy user_category_assignments_select
  on public.user_category_assignments
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.has_org_role(organization_id, 'manager')
  );

create policy user_category_assignments_write
  on public.user_category_assignments
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

grant select, insert, update, delete on public.user_category_assignments to authenticated;

-- Helper: visibility check for a (user, category) pair.
-- Returns:
--   true  → the user can see items in this category
--   false → the user cannot
--
-- Truth table:
--   role = owner|admin|manager|staff               → true
--   role = viewer + no assignments                  → true (unrestricted default)
--   role = viewer + assignments + category in set   → true
--   role = viewer + assignments + category NULL     → false (restricted hide uncategorized)
--   role = viewer + assignments + category NOT in   → false
--   no role row                                     → false
create or replace function public.user_can_see_item_category(
  p_user_id     uuid,
  p_category_id uuid
) returns boolean
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
declare
  v_role text;
begin
  -- Get role. organization_members is the source of truth.
  select role::text into v_role
  from public.organization_members
  where user_id = p_user_id
  limit 1;

  if v_role is null then
    return false;
  end if;

  if v_role in ('owner','admin','manager','staff') then
    return true;
  end if;

  -- viewer branch
  if v_role = 'viewer' then
    -- Unrestricted if no assignments
    if not exists (
      select 1 from public.user_category_assignments
      where user_id = p_user_id
    ) then
      return true;
    end if;

    -- Restricted: null category never visible
    if p_category_id is null then
      return false;
    end if;

    return exists (
      select 1 from public.user_category_assignments
      where user_id = p_user_id and category_id = p_category_id
    );
  end if;

  return false;
end;
$$;

revoke all on function public.user_can_see_item_category(uuid, uuid) from public, anon;
grant execute on function public.user_can_see_item_category(uuid, uuid) to authenticated;

-- RLS: SELECT filter on inventory_items by category visibility.
-- ANDs with the existing org + warehouse-access policies; a restricted
-- viewer must satisfy ALL of them (org match + warehouse match + this).
create policy inventory_items_category_visibility
  on public.inventory_items
  for select to authenticated
  using (
    public.user_can_see_item_category(auth.uid(), category_id)
  );

-- RLS: SELECT filter on categories themselves so a restricted viewer
-- can't even enumerate categories they can't access (no leaking
-- "Swag" exists by name).
create policy categories_visibility
  on public.categories
  for select to authenticated
  using (
    public.user_can_see_item_category(auth.uid(), id)
  );
```

- [ ] **Step 2: Commit + push (user will apply)**

```bash
git add supabase/migrations/0128_viewer_category_access.sql
git commit -m "feat(db): viewer category visibility — table, RPC, RLS policies

Adds user_category_assignments + user_can_see_item_category() RPC +
SELECT policies on inventory_items and categories so a viewer with
any grants sees only items in those categories; null-category items
always invisible to restricted viewers. Viewer with no grants =
unrestricted (back-compat default). Other roles unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

- [ ] **Step 3: Pause for user to apply 0128 in Supabase**

Per project policy. Do not proceed to Task 2 until confirmed.

---

## Task 2: Permission constant + AuditEvent

**Files:**
- Modify `packages/core/src/constants/permissions.ts`
- Modify `apps/web/src/server/services/audit.ts`

- [ ] **Step 1: Add the permission constant**

In `packages/core/src/constants/permissions.ts`, find the `PERMISSIONS` array and add:

```typescript
'users:assign_categories',
```

In the role grants below, add `'users:assign_categories'` to the `admin` and `manager` arrays. In the per-permission definitions block, add:

```typescript
'users:assign_categories': {
  description: 'Grant or revoke category visibility for a viewer.',
  minRole: 'manager',
},
```

- [ ] **Step 2: Add the AuditEvent**

In `apps/web/src/server/services/audit.ts`, add to the `AuditEvent` union:

```typescript
| 'user.category_access.updated'
```

- [ ] **Step 3: Verify build**

```bash
cd "/Users/brandenvincent-walker/Desktop/Inventory System App/apps/web"
pnpm typecheck
pnpm lint
```

Both clean.

- [ ] **Step 4: Commit + push**

```bash
git add packages/core/src/constants/permissions.ts apps/web/src/server/services/audit.ts
git commit -m "feat(core): users:assign_categories permission + audit event"
git push
```

---

## Task 3: User-categories service (TDD)

**Files:**
- Create `apps/web/src/server/services/user-categories.ts`
- Create `apps/web/src/server/services/user-categories.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/server/services/user-categories.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(public code: string, message: string) { super(message); }
  },
  assertPermission: vi.fn(),
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
}));

import { UserCategoriesService } from './user-categories';

function makeCtx(opts: {
  targetUserOrgId?: string;
  existingAssignments?: string[];   // category_ids currently assigned to target user
  deletedRows?: number;
  insertError?: { code: string; message: string };
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const supabase = {
    from(table: string) {
      if (table === 'user_category_assignments') {
        return {
          select: () => ({
            eq: () => ({
              then: (cb: (v: { data: Array<{ category_id: string }>; error: null }) => void) =>
                cb({
                  data: (opts.existingAssignments ?? []).map((c) => ({ category_id: c })),
                  error: null,
                }),
            }),
          }),
          insert: (rows: Array<Record<string, unknown>>) => {
            if (opts.insertError) {
              return Promise.resolve({ data: null, error: opts.insertError });
            }
            inserted.push(...rows);
            return Promise.resolve({ data: rows, error: null });
          },
          delete: () => ({
            eq: () => ({
              then: (cb: (v: { error: null; count: number }) => void) => {
                deleted.push('all');
                cb({ error: null, count: opts.deletedRows ?? 0 });
              },
            }),
          }),
        };
      }
      if (table === 'organization_members') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: opts.targetUserOrgId
                    ? { organization_id: opts.targetUserOrgId, role: 'viewer' }
                    : null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown;
  return {
    ctx: {
      supabase,
      organizationId: 'org-1',
      userId: 'caller-1',
      role: 'admin',
    } as unknown as ConstructorParameters<typeof UserCategoriesService>[0],
    inserted,
    deleted,
  };
}

describe('UserCategoriesService.setUserCategoryAccess', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts assignment rows for granted categories', async () => {
    const { ctx, inserted } = makeCtx({ targetUserOrgId: 'org-1', existingAssignments: [] });
    const svc = new UserCategoriesService(ctx);
    await svc.setUserCategoryAccess('user-2', ['cat-a', 'cat-b']);
    expect(inserted).toHaveLength(2);
    expect(inserted.map((r) => r.category_id).sort()).toEqual(['cat-a', 'cat-b']);
  });

  it('rejects when target user is in a different organization', async () => {
    const { ctx } = makeCtx({ targetUserOrgId: 'org-2' });
    const svc = new UserCategoriesService(ctx);
    await expect(
      svc.setUserCategoryAccess('user-2', ['cat-a']),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects when target user is not in any org', async () => {
    const { ctx } = makeCtx({ targetUserOrgId: undefined });
    const svc = new UserCategoriesService(ctx);
    await expect(
      svc.setUserCategoryAccess('user-2', ['cat-a']),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('clears all assignments when called with empty array', async () => {
    const { ctx, inserted, deleted } = makeCtx({
      targetUserOrgId: 'org-1',
      existingAssignments: ['cat-a', 'cat-b'],
    });
    const svc = new UserCategoriesService(ctx);
    await svc.setUserCategoryAccess('user-2', []);
    expect(inserted).toHaveLength(0);
    expect(deleted).toContain('all');
  });
});
```

- [ ] **Step 2: Run test, expect FAIL (no service yet)**

```bash
cd apps/web && pnpm test src/server/services/user-categories.test.ts
```

- [ ] **Step 3: Write the service**

```typescript
// apps/web/src/server/services/user-categories.ts
import { ServiceContext, ServiceError, assertPermission } from './context';
import { audit } from './audit';

export class UserCategoriesService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Returns the category_ids the given user is allowed to see.
   *   - null = unrestricted (sees every category)
   *   - Set  = explicit allow-list (restricted viewer)
   *
   * Mirrors the RLS truth table; used in service-layer defense-in-depth
   * and to compute cache keys that vary per viewer.
   */
  async getAccessibleCategoryIds(userId: string): Promise<Set<string> | null> {
    // Caller already has a ServiceContext; we ONLY need to know if this
    // user is a viewer + has assignments. Single round-trip.
    const { data: member } = await this.ctx.supabase
      .from('organization_members')
      .select('role')
      .eq('user_id', userId)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    const role = (member as { role?: string } | null)?.role;
    if (!role) return new Set();             // no membership → no access
    if (role !== 'viewer') return null;      // unrestricted

    const { data: rows } = await this.ctx.supabase
      .from('user_category_assignments')
      .select('category_id')
      .eq('user_id', userId);
    const list = ((rows ?? []) as Array<{ category_id: string }>).map((r) => r.category_id);
    if (list.length === 0) return null;      // viewer with no grants = unrestricted
    return new Set(list);
  }

  /**
   * Atomic-replace: clear the target user's existing assignments and
   * insert the new set. Caller must be manager+ in the same org as the
   * target user.
   */
  async setUserCategoryAccess(targetUserId: string, categoryIds: string[]): Promise<void> {
    assertPermission(this.ctx, 'users:assign_categories');

    // Verify target user is in OUR org.
    const { data: member } = await this.ctx.supabase
      .from('organization_members')
      .select('organization_id, role')
      .eq('user_id', targetUserId)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    if (!member) throw new ServiceError('not_found', 'User is not a member of this organization.');
    const m = member as { organization_id: string; role: string };
    if (m.organization_id !== this.ctx.organizationId) {
      throw new ServiceError('forbidden', 'Cannot manage users outside your organization.');
    }

    // Atomic-replace: clear + insert. RLS on user_category_assignments
    // gates the writes; this is defense in depth.
    await this.ctx.supabase
      .from('user_category_assignments')
      .delete()
      .eq('user_id', targetUserId);

    if (categoryIds.length > 0) {
      const rows = categoryIds.map((category_id) => ({
        organization_id: this.ctx.organizationId,
        user_id: targetUserId,
        category_id,
        assigned_by: this.ctx.userId,
      }));
      const { error } = await this.ctx.supabase
        .from('user_category_assignments')
        .insert(rows);
      if (error) throw new ServiceError('internal_error', error.message);
    }

    void audit(
      {
        event: 'user.category_access.updated',
        entityType: 'user_profile',
        entityId: targetUserId,
        extra: { category_count: categoryIds.length },
      },
      this.ctx,
    );
  }
}
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd apps/web && pnpm test src/server/services/user-categories.test.ts
```

- [ ] **Step 5: Run typecheck + lint**

Both must be clean.

- [ ] **Step 6: Commit + push**

```bash
git add apps/web/src/server/services/user-categories.ts \
        apps/web/src/server/services/user-categories.test.ts
git commit -m "feat(users): UserCategoriesService — get + set category access

getAccessibleCategoryIds returns the user's allow-list (or null for
unrestricted), used in service-layer defense-in-depth + cache-key
hashing. setUserCategoryAccess atomic-replaces the target viewer's
grants, gated by users:assign_categories permission and same-org
membership."
git push
```

---

## Task 4: Server action

**Files:** Create `apps/web/src/server/actions/user-categories.ts`

- [ ] **Step 1: Write the action**

```typescript
'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { z } from 'zod';

import { ServiceError } from '@/server/services/context';
import { UserCategoriesService } from '@/server/services/user-categories';

import { err, ok, type ActionResult } from '@stockpilot/core';

const setSchema = z.object({
  userId: z.string().uuid(),
  categoryIds: z.array(z.string().uuid()).max(500),
});

export async function setUserCategoryAccessAction(
  input: z.input<typeof setSchema>,
): Promise<ActionResult<{ count: number }>> {
  const parsed = setSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = new UserCategoriesService(await (await import('@/server/services/context')).withContext());
    await svc.setUserCategoryAccess(parsed.data.userId, parsed.data.categoryIds);
    // Bust ALL caches that may have leaked content based on previous
    // visibility. Hard but correct.
    revalidateTag('orders-new-v2-catalog');
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    revalidatePath('/dashboard/team');
    return ok({ count: parsed.data.categoryIds.length });
  } catch (error) {
    if (error instanceof ServiceError) return err(error.code, error.message);
    console.error(error);
    return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
  }
}
```

- [ ] **Step 2: Verify build**

```bash
cd apps/web && pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 3: Commit + push**

```bash
git add apps/web/src/server/actions/user-categories.ts
git commit -m "feat(users): setUserCategoryAccessAction server action

Wraps UserCategoriesService.setUserCategoryAccess; invalidates the
orders-new-v2-catalog cache tag + the team/inventory paths so the
new visibility takes effect immediately for the target viewer."
git push
```

---

## Task 5: Category-access card UI

**Files:** Create `apps/web/src/components/team/category-access-card.tsx`

- [ ] **Step 1: Write the component**

```typescript
'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { setUserCategoryAccessAction } from '@/server/actions/user-categories';

interface Props {
  targetUserId: string;
  targetUserName: string;
  allCategories: Array<{ id: string; name: string }>;
  initiallyGranted: string[];
}

/**
 * Checkbox grid for granting a viewer access to specific categories.
 * Mounted inside the existing "Edit user" dialog in team-manager.
 * Only renders when the target user's role is 'viewer' — managers and
 * above always see every category, so this control is meaningless.
 *
 * No grants = unrestricted. Saving with zero boxes checked removes
 * all restrictions. The note below the grid spells this out.
 */
export function CategoryAccessCard({
  targetUserId,
  targetUserName,
  allCategories,
  initiallyGranted,
}: Props) {
  const [granted, setGranted] = useState<Set<string>>(new Set(initiallyGranted));
  const [pending, startTransition] = useTransition();

  function toggle(id: string) {
    setGranted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setGranted(new Set(allCategories.map((c) => c.id)));
  }
  function clearAll() {
    setGranted(new Set());
  }

  function save() {
    startTransition(async () => {
      const result = await setUserCategoryAccessAction({
        userId: targetUserId,
        categoryIds: [...granted],
      });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      const n = result.data.count;
      toast.success(
        n === 0
          ? `${targetUserName} can now see all categories.`
          : `${targetUserName} can now see ${n} categor${n === 1 ? 'y' : 'ies'}.`,
      );
    });
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Category access</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Pick which categories {targetUserName} can see. Leave empty for
          unrestricted access (sees everything in their warehouses).
        </p>
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={selectAll}>
          Select all
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={clearAll}>
          Clear all
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {allCategories.map((c) => (
          <label
            key={c.id}
            className="border-border hover:bg-muted/40 flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm"
          >
            <Checkbox
              checked={granted.has(c.id)}
              onCheckedChange={() => toggle(c.id)}
              disabled={pending}
            />
            <span className="truncate">{c.name}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-[11px]">
          {granted.size === 0
            ? 'No categories selected — sees everything.'
            : `${granted.size} categor${granted.size === 1 ? 'y' : 'ies'} selected.`}
        </p>
        <Button onClick={save} disabled={pending} size="sm">
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Verify imports (`Checkbox` exists at `@/components/ui/checkbox`)**

```bash
ls apps/web/src/components/ui/checkbox.tsx
```

If it doesn't exist, the project uses a different checkbox — search and adapt.

- [ ] **Step 3: Verify build + commit**

```bash
cd apps/web && pnpm typecheck && pnpm lint
```

```bash
git add apps/web/src/components/team/category-access-card.tsx
git commit -m "feat(team): CategoryAccessCard — checkbox grid for viewer grants"
git push
```

---

## Task 6: Mount CategoryAccessCard in team-manager

**Files:** Modify `apps/web/src/components/team/team-manager.tsx`

The team-manager.tsx file is large (736 lines) — locate the user-edit dialog and mount the card inside it conditionally (role === 'viewer').

- [ ] **Step 1: Read team-manager.tsx to find the user-edit dialog**

```bash
grep -n "DialogContent\|Edit\|selectedUser\|editingUser" apps/web/src/components/team/team-manager.tsx
```

- [ ] **Step 2: Identify the props the team-manager already has**

Look at the props interface — does it already get categories? If not, the parent page (`/dashboard/team/page.tsx`) needs to load them and pass through.

- [ ] **Step 3: Extend the team-page server component to load categories**

In `apps/web/src/app/(dashboard)/dashboard/team/page.tsx`, add:

```typescript
const { data: cats } = await ctx.supabase
  .from('categories')
  .select('id, name')
  .eq('organization_id', ctx.organizationId)
  .is('archived_at', null)
  .order('name', { ascending: true });
const categories = ((cats ?? []) as Array<{ id: string; name: string }>);
```

Plus load each viewer's current grants:

```typescript
const { data: grantRows } = await ctx.supabase
  .from('user_category_assignments')
  .select('user_id, category_id')
  .eq('organization_id', ctx.organizationId);
const grantsByUser = new Map<string, string[]>();
for (const r of (grantRows ?? []) as Array<{ user_id: string; category_id: string }>) {
  const list = grantsByUser.get(r.user_id) ?? [];
  list.push(r.category_id);
  grantsByUser.set(r.user_id, list);
}
```

Pass `categories` + `grantsByUser` to the team-manager component.

- [ ] **Step 4: Add the mount inside team-manager's user-edit dialog**

Wherever the dialog renders user details, conditionally render:

```tsx
{selectedUser.role === 'viewer' && (
  <CategoryAccessCard
    targetUserId={selectedUser.user_id}
    targetUserName={selectedUser.full_name ?? selectedUser.email}
    allCategories={allCategories}
    initiallyGranted={grantsByUser.get(selectedUser.user_id) ?? []}
  />
)}
```

For non-viewer roles, show a small note: "Category access doesn't apply to {role}s — they see everything."

- [ ] **Step 5: Verify + commit**

```bash
cd apps/web && pnpm typecheck && pnpm lint && pnpm test
```

```bash
git add apps/web/src/components/team/team-manager.tsx \
        "apps/web/src/app/(dashboard)/dashboard/team/page.tsx"
git commit -m "feat(team): mount CategoryAccessCard in user-edit dialog

Renders only for viewer rows; shows a note for other roles. Server
component loads all org categories + each user's existing grants so
the card hydrates with the current state. Saving invalidates the
orders-new-v2-catalog cache tag (in the action) so the target
viewer's next page load reflects the change."
git push
```

---

## Task 7: Cache-key fix on the orders/new picker (CRITICAL)

**Files:** Modify `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx`

This is the single highest-risk task. The orders/new picker uses `unstable_cache` keyed by `(orgId, warehouseId)`. If a manager warms the cache and a restricted viewer hits the same key, the viewer reads the manager's payload, bypassing the new RLS.

**Fix:** Include the user's accessible-categories hash in the cache key AND filter the payload server-side.

- [ ] **Step 1: Add an accessible-categories helper**

Above `loadCatalogItemsCached`, add:

```typescript
async function loadAccessibleCategoryHash(
  organizationId: string,
  userId: string,
): Promise<string> {
  // Returns a stable hash string that uniquely identifies the user's
  // category-access pattern. Used as a cache-key component so a
  // restricted viewer's payload doesn't get served to other users
  // (or vice versa).
  //   • unrestricted user → "ALL"
  //   • viewer with grants → "v:" + sorted ids joined
  const admin = createAdminClient();
  const { data: member } = await admin
    .from('organization_members')
    .select('role')
    .eq('user_id', userId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  const role = (member as { role?: string } | null)?.role;
  if (!role || role !== 'viewer') return 'ALL';
  const { data: rows } = await admin
    .from('user_category_assignments')
    .select('category_id')
    .eq('user_id', userId);
  const ids = ((rows ?? []) as Array<{ category_id: string }>)
    .map((r) => r.category_id)
    .sort();
  if (ids.length === 0) return 'ALL';
  return 'v:' + ids.join(',');
}
```

- [ ] **Step 2: Add an explicit allow-list to the cached function**

Change the cached function signature to take the hash + allow-list:

```typescript
const loadCatalogItemsCached = unstable_cache(
  async (
    organizationId: string,
    warehouseId: string,
    accessibleCategoryIdsKey: string,  // 'ALL' or 'v:c1,c2,c3'
  ): Promise<CatalogItem[]> => {
    return loadCatalogItemsUncached(organizationId, warehouseId, accessibleCategoryIdsKey);
  },
  ['orders-new-v2-catalog-v2'],  // bump version because key shape changed
  { revalidate: 30, tags: ['orders-new-v2-catalog'] },
);
```

- [ ] **Step 3: Filter the payload in the uncached fn**

In `loadCatalogItemsUncached`, after fetching items, apply the filter:

```typescript
if (accessibleCategoryIdsKey !== 'ALL') {
  const allowedIds = new Set(accessibleCategoryIdsKey.replace(/^v:/, '').split(','));
  itemsData = (itemsData ?? []).filter((it) =>
    it.category_id !== null && allowedIds.has(it.category_id)
  );
  // Items now also need to reflect this in itemIds for subsequent
  // reservation / lqip queries — make sure those use the filtered set.
}
```

- [ ] **Step 4: Thread the userId into the page**

The page already calls `requireOrgContext()` which returns `ctx.userId`. Pass it through:

```typescript
const accessibleHash = await loadAccessibleCategoryHash(ctx.organizationId, ctx.userId);
const items = await loadCatalogItems(ctx.organizationId, warehouseId, accessibleHash);
```

`loadCatalogItems` is the public wrapper around `loadCatalogItemsCached` — update its signature too.

- [ ] **Step 5: Bump cache version**

Change the cache prefix from `'orders-new-v2-catalog-v1'` to `'orders-new-v2-catalog-v2'` (already done in Step 2). This forces a cold cache — old entries (keyed by `(orgId, warehouseId)` only) are unreachable.

- [ ] **Step 6: Verify + commit**

```bash
cd apps/web && pnpm typecheck && pnpm lint && pnpm test
```

```bash
git add "apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx"
git commit -m "fix(orders): cache key respects viewer category visibility

The unstable_cache around loadCatalogItems was keyed by
(orgId, warehouseId) — meaning a manager's full-catalog payload
could be served to a restricted viewer hitting the same warehouse.
Adds an accessibleCategoryIdsKey to the cache key + server-side
filter so each visibility class gets its own cached payload.
Bumped to v2 prefix to force a cold cache.

Critical for the new viewer category visibility feature; without
this fix RLS could be defeated by a stale cache lookup."
git push
```

---

## Task 8: Service-layer defense (InventoryService.list)

**Files:** Modify `apps/web/src/server/services/inventory.ts`

- [ ] **Step 1: Inject the user's accessible categories into list()**

In `InventoryService.list()`, after the existing warehouse-access check, add:

```typescript
// Defense in depth: even though RLS filters by category visibility,
// applying the filter here too means a future RLS bug can't leak.
const userCategoriesSvc = new UserCategoriesService(this.ctx);
const accessible = await userCategoriesSvc.getAccessibleCategoryIds(this.ctx.userId);
if (accessible !== null) {
  if (accessible.size === 0) {
    return { items: [], total: 0 };
  }
  query = query.in('category_id', [...accessible]);
}
```

Add `import { UserCategoriesService } from './user-categories'` at the top.

- [ ] **Step 2: Verify + commit**

```bash
cd apps/web && pnpm typecheck && pnpm lint && pnpm test
```

```bash
git add apps/web/src/server/services/inventory.ts
git commit -m "fix(inventory): service-layer category filter for restricted viewers

Defense in depth — RLS is the floor, but applying the same filter
at the service layer means a future RLS misconfiguration can't
silently leak rows from forbidden categories. Returns empty for
a viewer with no grants but with restrictions enabled (shouldn't
happen given our truth table but cheap to handle)."
git push
```

---

## Task 9: RLS integration test (DB-level)

**Files:** Create `apps/web/src/server/services/inventory.category-rls.test.ts`

This test goes against the real Postgres (Supabase test instance) and confirms the RLS policy denies a restricted viewer.

- [ ] **Step 1: Skim existing RLS tests**

```bash
ls apps/web/src/server/services/*rls*.test.ts 2>/dev/null
grep -rn "auth.uid\|RLS\|test('viewer" apps/web/src/server/services/*.test.ts | head -10
```

If no RLS test infrastructure exists, this task becomes "document manual SQL test steps in a comment block at the top of a stub test file" instead. The test must use a real Postgres connection (admin client with set role) to be meaningful.

- [ ] **Step 2: Write the test (or document the manual SQL)**

If RLS test infra exists, write tests for the truth table:
- viewer with no grants → sees all items in their warehouse
- viewer with grants for [A] → sees only items in A
- viewer with grants for [A] → does NOT see null-category items
- manager → sees everything (current behavior preserved)

If not, write a markdown stub at `docs/superpowers/specs/2026-05-19-viewer-category-visibility-rls-test.md` with the exact psql commands to run manually as part of the E2E in Task 10.

- [ ] **Step 3: Commit + push**

---

## Task 10: Manual E2E

**No files modified.** Verifies all surfaces honor the new policy.

- [ ] **Step 1: Wait for prior Vercel deploys to be green**

Confirm GitHub Actions / Vercel preview shows latest commits passing.

- [ ] **Step 2: As admin: create a test viewer + grant 1-2 categories**

1. `/dashboard/team` → invite a test email as viewer
2. Open the user's edit dialog → CategoryAccessCard appears
3. Check 1-2 categories → Save
4. Toast confirms: "X can now see N categor(y/ies)"

- [ ] **Step 3: As that viewer: verify every surface**

- `/dashboard/inventory` → only items in granted categories appear, no null-category items
- `/dashboard/books` → same filter
- `/dashboard/orders/new` → aisle pills only show granted categories, card grid filtered, Quick-add filtered
- `/dashboard/reports/inventory-valuation` → only granted-category items roll up; total is partial
- AI search ("show me electronics") → returns only granted-category electronics; no leakage of denied categories

- [ ] **Step 4: As admin: create a NEW category, then re-grant**

- Add new category "Test New Cat"
- Reopen the viewer's user edit → "Test New Cat" appears unchecked in the grid
- Check it → Save
- As the viewer (refresh) → items in Test New Cat now visible

- [ ] **Step 5: As admin: remove all grants**

- Clear all checkboxes → Save → toast: "X can now see all categories."
- As the viewer (refresh) → all items visible again (back to unrestricted)

- [ ] **Step 6: Edge case — null-category item**

- Create an item with no category as admin
- Restrict the viewer to one category
- As viewer → null-category item should NOT appear
- As admin → null-category item should appear

---

## Self-review notes

**Spec coverage:**
- Table + RPC + RLS → Task 1
- Permission constant → Task 2
- Service + tests → Task 3
- Server action → Task 4
- Admin UI → Task 5 + 6
- Cache key fix → Task 7 (critical)
- Service-layer defense → Task 8
- RLS test → Task 9
- E2E verification → Task 10

**Risk surfaces (from spec):**
- Admin client uses: orders/new catalog cache → Task 7; other admin client paths (catalog-thumbnails, signed-URL services) don't return category data and are safe.
- security definer RPCs: confirm_order_signature, duplicate_inventory_item, order_request_top_skus_for_warehouse — none of these return category data; verified.
- Storage policy on item-images: photos signed via storage_path lookup; the lookup itself joins to item_images which RLS-filters via parent item_id. Verify in Task 10 by checking signed URLs of a denied item return 404.

**Hard-fail conditions (any of these = STOP and re-plan):**
- A restricted viewer can see ANY item in a denied category through ANY surface (inventory list, orders picker, reports, search, AI tools, PDFs, public API).
- A manager loses ANY visibility (this feature should be transparent to non-viewer roles).
- Cache returns a manager's payload to a viewer or vice versa.

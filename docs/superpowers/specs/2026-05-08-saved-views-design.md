# Saved Views on the Inventory + Books Tables

**Date:** 2026-05-08
**Status:** Approved (proceeding to implementation)
**Owner:** Branden Vincent-Walker

## Goal

Replace the `+ Saved view` placeholder chip on the inventory + books toolbars with a real per-user feature. Users save the current filter / sort / search / warehouse combination as a named view, click a chip to re-apply it instantly, delete views they no longer need. Same component drives both pages.

## Scope

- **In:** save / apply / delete saved views, scoped to the inventory and books tables, per-user, per-org, private
- **Out:** org-wide sharing, view editing/renaming (delete + recreate instead), default-view-per-page, drag-to-reorder, view-aware AI tool, deep-link `/views/<id>` URLs, applying views from outside the inventory pages

## User-visible behavior

The placeholder `+ Saved view` chip on the inventory and books toolbars (right of the existing All items / Low + critical / Out of stock chips) becomes interactive:

1. **Save** — click `+ Save current as view`. A small popover opens:
   - Text input for the view name
   - Read-only preview of what's being saved ("Filters: Out of stock · Books · Sorted by name A→Z")
   - **Save** button → row is inserted via server action, popover closes, new chip appears inline
2. **Apply** — click a saved view chip. URL params + warehouse selector update to match the saved state. The chip becomes "active" styled (matches the existing active-view chip styling).
3. **Auto-highlight** — when the current toolbar state exactly matches a saved view, that view's chip is rendered in the active style. No need to remember if you're "on" a view.
4. **Delete** — small `×` button appears on hover over a saved chip. Click → confirm via `window.confirm` → row deleted, chip removed.

If a saved view references a warehouse / category / location that has since been deleted, the apply silently drops the missing piece and applies what's still valid.

## Architecture

### Migration `supabase/migrations/0035_saved_views.sql`

```sql
create table public.saved_views (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.user_profiles(id) on delete cascade,
  name            text not null,
  scope           text not null check (scope in ('inventory', 'books')),
  state           jsonb not null,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, organization_id, scope, name)
);
create index saved_views_user_org_scope_idx
  on public.saved_views(user_id, organization_id, scope, sort_order, created_at);

alter table public.saved_views enable row level security;

create policy "saved_views_owner_select" on public.saved_views
  for select using (user_id = auth.uid());
create policy "saved_views_owner_insert" on public.saved_views
  for insert with check (user_id = auth.uid());
create policy "saved_views_owner_update" on public.saved_views
  for update using (user_id = auth.uid());
create policy "saved_views_owner_delete" on public.saved_views
  for delete using (user_id = auth.uid());

create trigger saved_views_set_updated_at
  before update on public.saved_views
  for each row execute function public.tg_set_updated_at();
```

### `state` jsonb shape

```ts
interface SavedViewState {
  q?: string;
  status?: 'active' | 'archived' | 'discontinued' | 'all';
  stock?: 'low' | 'out';
  type?: 'product' | 'book' | 'asset' | 'consumable' | 'all';
  sort?: ItemListSort; // same union from inventory.ts
  cat?: string[];      // category UUIDs
  loc?: string[];      // location UUIDs
  warehouseId?: string | null;
}
```

`page` is deliberately omitted — applying a view always lands on page 1.

### Service `apps/web/src/server/services/saved-views.ts`

```ts
export class SavedViewsService {
  static async forCurrentUser(): Promise<SavedViewsService>;
  async list(scope: 'inventory' | 'books'): Promise<SavedView[]>;
  async create(input: { scope; name; state }): Promise<SavedView>;
  async remove(id: string): Promise<void>;
}
```

All methods scoped to `ctx.userId` + `ctx.organizationId`. RLS policy is the safety net even if a service mistake leaks an id.

### Server actions `apps/web/src/server/actions/saved-views.ts`

```ts
export async function createSavedViewAction({ scope, name, state })
export async function deleteSavedViewAction(id: string)
```

Both wrapped in standard action result types (`{ ok, data | error }`).

### UI changes in `inventory-table.tsx`

Add a `views` prop (`Array<SavedView>`) populated by the page component. The existing chip row above the toolbar gains:

- One `<SavedViewChip>` per view, with apply-on-click + on-hover delete `×`
- A `<SaveCurrentViewButton>` (the existing `+ Saved view` placeholder, now functional) that opens a Popover with a name input

The active-styling logic compares the current `URLSearchParams + warehouseId` to each view's `state` and highlights the matching chip if any.

### Page changes (inventory + books)

Each page already fetches a bunch of data via `Promise.all`. Add one more call: `SavedViewsService.forCurrentUser().then(s => s.list('inventory'))` (or `'books'`). Pass into `<InventoryTable views={...} />`.

Server-side warehouse filter (`getActiveWarehouseFilter`) reads from a cookie. To **apply** a view, the chip click must:
1. Set the URL search params to match the view's filter state (use `router.replace`)
2. Set the warehouse cookie to match `view.state.warehouseId` (or clear it if null)

Setting a cookie from the client requires a server action — add `setActiveWarehouseAction(warehouseId | null)` that writes the cookie and `revalidatePath('/dashboard/inventory')` + `'/dashboard/books'`. Existing warehouse picker must already do something like this; check at impl time and reuse if so.

## Edge cases

- **View name collision**: DB unique constraint surfaces a 23505 error → action returns `{ ok: false, error: { code: 'name_taken' } }` → toast "A view with that name already exists"
- **View references a deleted warehouse / category / location**: apply silently drops the missing piece (sets it to no-filter) so the user gets a usable result instead of an error
- **No views yet**: chip row shows just the built-ins + the save button. No empty-state needed.
- **Applying a view while on page 5**: page resets to 1 (saved views always do, same as filter changes)
- **User logs out / switches orgs**: `auth.uid()` changes, RLS scope changes, their views from the other org are invisible (even if the cookie is still warm)

## Testing

Manual:
- Save a view with filters → reload → chip persists → apply → URL updates correctly
- Save second view with conflicting name → error toast
- Delete a saved view → chip disappears
- Apply view with stale category id (manually delete the category) → other filters still apply, missing one silently dropped
- Verify books-tab views don't appear on inventory tab and vice versa

Automated: keep using existing test infrastructure; not adding new unit tests for view rendering this round.

## Out-of-scope follow-ups

- Org-wide sharing
- Rename / edit views
- Drag-to-reorder via the existing `sort_order` column (already in the schema for forward-compat)
- Default view per page
- AI tool that lets Gemini apply a saved view by name
- Saved views for other tables (POs, movements, cycle counts) — same pattern, separate features

## Decision log

| Decision | Why |
| --- | --- |
| Per-user, private | User chose this; smallest correct scope; no permission UX |
| Capture warehouse alongside filters | User chose this; lets a view encode both "what" and "where" |
| `state` as jsonb | Schema flexibility — adding new filter fields later doesn't need a migration |
| Delete + re-save instead of rename | Halves the UI surface for the same essential capability |
| No deep-link URL per view | Apply just sets the URL params; users can already share those URLs by copying |
| `sort_order` column despite no drag-to-reorder yet | Cheap forward-compat; default-zero ordering means it's a no-op until a UI wires it |
| Auto-highlight matching chip | Lets users see "I'm on this view" without a separate breadcrumb |

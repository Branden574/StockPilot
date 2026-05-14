# Search State Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve list-page URL state (search query, filters, sort, page) across the row-click → detail/edit → back round-trip on `/dashboard/inventory` and `/dashboard/books`.

**Architecture:** Encode the current list URL into a `return` query param on every row Link. Detail and edit pages validate and propagate it through. `<ItemForm>` honors it on successful save. Stateless; no sessionStorage.

**Tech Stack:** Next.js 16 App Router · React 19 (`useSearchParams`, `usePathname`) · Vitest · TypeScript strict.

**Source spec:** [docs/superpowers/specs/2026-05-14-search-state-persistence-design.md](../specs/2026-05-14-search-state-persistence-design.md)

---

## File Structure

**Created:**

- `apps/web/src/lib/safe-return-path.ts` — validates a `?return=` value; returns the path or `null`.
- `apps/web/src/lib/safe-return-path.test.ts` — Vitest unit tests.

**Modified:**

- `apps/web/src/components/inventory/inventory-table.tsx` — row Link href appends `?return=<current-list-url>`.
- `apps/web/src/components/inventory/item-detail.tsx` — propagates `returnParam` into the "Edit" link.
- `apps/web/src/components/inventory/item-form.tsx` — accepts `returnHref` prop; uses it on save / cancel.
- `apps/web/src/app/(dashboard)/dashboard/inventory/[id]/page.tsx` — reads + validates `return`, passes to `<ItemDetail>`.
- `apps/web/src/app/(dashboard)/dashboard/books/[id]/page.tsx` — same.
- `apps/web/src/app/(dashboard)/dashboard/inventory/[id]/edit/page.tsx` — reads + validates `return`, passes to `<ItemForm>` and Cancel button.
- `apps/web/src/app/(dashboard)/dashboard/books/[id]/edit/page.tsx` — same.

**Untouched:**

- All services (`InventoryService` etc.) — this is purely a routing/UI concern.

---

## PR 1 — `safeReturnPath` helper

### Task 1.1: Write the failing test

**Files:**

- Create: `apps/web/src/lib/safe-return-path.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// apps/web/src/lib/safe-return-path.test.ts
import { describe, expect, it } from 'vitest';

import { safeReturnPath } from './safe-return-path';

describe('safeReturnPath', () => {
  it('returns the path verbatim for a same-origin dashboard URL', () => {
    expect(safeReturnPath('/dashboard/inventory?q=foo')).toBe(
      '/dashboard/inventory?q=foo',
    );
  });

  it('returns the path for a URL with multiple params', () => {
    expect(
      safeReturnPath('/dashboard/inventory?q=lanyards&sort=name_asc&cat=swag'),
    ).toBe('/dashboard/inventory?q=lanyards&sort=name_asc&cat=swag');
  });

  it('accepts /dashboard/books too', () => {
    expect(safeReturnPath('/dashboard/books?q=harry')).toBe(
      '/dashboard/books?q=harry',
    );
  });

  it('returns null for null / undefined / empty', () => {
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath('')).toBeNull();
    expect(safeReturnPath('   ')).toBeNull();
  });

  it('rejects cross-origin URLs', () => {
    expect(safeReturnPath('https://evil.com')).toBeNull();
    expect(safeReturnPath('http://evil.com/dashboard/inventory')).toBeNull();
  });

  it('rejects protocol-relative URLs', () => {
    expect(safeReturnPath('//evil.com')).toBeNull();
    expect(safeReturnPath('//evil.com/dashboard/inventory')).toBeNull();
  });

  it('rejects javascript: / data: / file: schemes', () => {
    expect(safeReturnPath('javascript:alert(1)')).toBeNull();
    expect(safeReturnPath('JAVASCRIPT:alert(1)')).toBeNull();
    expect(safeReturnPath('data:text/html,<script>x</script>')).toBeNull();
    expect(safeReturnPath('file:///etc/passwd')).toBeNull();
  });

  it('rejects paths outside /dashboard/', () => {
    expect(safeReturnPath('/admin/secrets')).toBeNull();
    expect(safeReturnPath('/api/auth/logout')).toBeNull();
    expect(safeReturnPath('/')).toBeNull();
  });

  it('rejects URL-encoded protocol-relative escapes', () => {
    // After decode, "//evil.com" should still be rejected.
    expect(safeReturnPath('%2F%2Fevil.com')).toBeNull();
  });

  it('rejects overlong values', () => {
    const long = '/dashboard/inventory?q=' + 'x'.repeat(2100);
    expect(safeReturnPath(long)).toBeNull();
  });

  it('trims surrounding whitespace before validating', () => {
    expect(safeReturnPath('  /dashboard/inventory?q=foo  ')).toBe(
      '/dashboard/inventory?q=foo',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @stockpilot/web exec vitest run src/lib/safe-return-path.test.ts`
Expected: FAIL — `Cannot find module './safe-return-path'`.

### Task 1.2: Implement `safeReturnPath`

**Files:**

- Create: `apps/web/src/lib/safe-return-path.ts`

- [ ] **Step 1: Write the implementation**

```ts
// apps/web/src/lib/safe-return-path.ts

/**
 * Validates a user-controlled `?return=` value before using it as the
 * back-link target on detail / edit pages. Rejects anything that isn't a
 * same-origin dashboard path so the param can't be turned into an
 * open-redirect vector by a hostile link.
 *
 * Accepts: paths that, after decoding + trimming, begin with
 * `/dashboard/`. Anything else returns `null` — callers fall back to a
 * hardcoded default (`/dashboard/inventory` or `/dashboard/books`).
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > 2000) return null;

  // Decode once so percent-encoded escapes can't sneak past the
  // string-prefix check. A double-encoded payload (`%252F%252Fevil`)
  // decodes to `%2F%2Fevil`, which still doesn't start with
  // `/dashboard/` — so a single decode is enough.
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return null;
  }

  const lower = decoded.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('file:') ||
    lower.startsWith('vbscript:')
  ) {
    return null;
  }

  if (decoded.includes('//')) {
    // Catches `//evil.com`, `http://evil.com/dashboard/...`, and
    // `/dashboard//evil.com`. Real list URLs never contain `//`.
    return null;
  }

  if (!decoded.startsWith('/dashboard/')) {
    return null;
  }

  return decoded;
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm --filter @stockpilot/web exec vitest run src/lib/safe-return-path.test.ts`
Expected: PASS — all 11 tests green.

- [ ] **Step 3: Run the full test suite to confirm no regressions**

Run: `pnpm --filter @stockpilot/web exec vitest run`
Expected: 44 files, 348 tests (337 previous + 11 new) all green.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit and push**

```bash
git add apps/web/src/lib/safe-return-path.ts \
        apps/web/src/lib/safe-return-path.test.ts
git commit -m "$(cat <<'EOF'
feat(lib): safeReturnPath helper for validated back-link targets

Validates a `?return=` URL param before using it as a navigation
target. Accepts only same-origin paths beginning with /dashboard/;
rejects cross-origin URLs, protocol-relative escapes, scheme
escapes (javascript:, data:, file:, vbscript:), encoded //
escapes, and overlong (>2000 char) values.

Caller pattern:
  const back = safeReturnPath(searchParams.return) ?? DEFAULT;

Used by the upcoming search-state-persistence work on the inventory
+ books detail/edit pages — closes the open-redirect vector that a
naive `?return=` implementation would introduce.

11 unit tests cover happy path + every rejection branch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push
```

---

## PR 2 — Inventory list row Links carry `?return=`

### Task 2.1: Build `currentListUrl` inside `InventoryTable`

**Files:**

- Modify: `apps/web/src/components/inventory/inventory-table.tsx`

The component already has `useSearchParams()` (line 262) and accepts `basePath` (line 226 default `/dashboard/inventory`). We compute the current URL once per render and reuse it for every row Link.

- [ ] **Step 1: Add a `currentListUrl` memo near the other URL helpers**

Find the existing `buildHref` helper around line 312-320:

```ts
function buildHref(nextPage: number) {
  const next = new URLSearchParams(params.toString());
  if (nextPage <= 1) next.delete('page');
  else next.set('page', String(nextPage));
  const qs = next.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}
```

Immediately AFTER that function, add:

```ts
// Encoded full current list URL — used to round-trip search/filter
// state when the user clicks into a row, views, and comes back.
// Recomputed on every render so live keystrokes flow through.
const currentListUrl = React.useMemo(() => {
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}, [params, basePath]);
```

- [ ] **Step 2: Update the row Link to append the `return` param**

Find the row Link around line 709-714:

```tsx
<Link
  href={`${rowLinkPrefix}/${item.id}`}
  className="font-medium hover:underline"
>
  {item.name}
</Link>
```

Replace the `href` line with:

```tsx
<Link
  href={`${rowLinkPrefix}/${item.id}?return=${encodeURIComponent(currentListUrl)}`}
  className="font-medium hover:underline"
>
  {item.name}
</Link>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @stockpilot/web exec vitest run`
Expected: 44 files, 348 tests green. (No new tests; the table's behavior is unchanged for users who don't have the `return` param consumed yet.)

- [ ] **Step 5: Commit and push**

```bash
git add apps/web/src/components/inventory/inventory-table.tsx
git commit -m "$(cat <<'EOF'
feat(inventory): row Link carries ?return= for round-trip back-nav

Every row Link in the inventory + books table now appends the full
current list URL (with search query, filters, sort, page) as a
URL-encoded `?return=` param. The detail page wires this through
to its back link in the next commit so 'click row → back' restores
the user's search instead of dropping them on an empty list.

Carrier-only commit: the param has no consumer yet, so behavior is
identical to before for both pages.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push
```

---

## PR 3 — Inventory detail page consumes `?return=`

### Task 3.1: Update `inventory/[id]/page.tsx` to read + validate `return`

**Files:**

- Modify: `apps/web/src/app/(dashboard)/dashboard/inventory/[id]/page.tsx`

- [ ] **Step 1: Read the current file**

Run: `cat 'apps/web/src/app/(dashboard)/dashboard/inventory/[id]/page.tsx'`
Expected: the existing 22-line shell that hands props to `<ItemDetail>`.

- [ ] **Step 2: Replace the file's contents**

Write to `apps/web/src/app/(dashboard)/dashboard/inventory/[id]/page.tsx`:

```tsx
import { ItemDetail } from '@/components/inventory/item-detail';
import { safeReturnPath } from '@/lib/safe-return-path';

const DEFAULT_BACK = '/dashboard/inventory';

export default async function ItemDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; return?: string }>;
}) {
  const { id } = await params;
  const { tab, return: returnParam } = await searchParams;
  // Validate the back-link target — `return` is user-controlled so we
  // never trust it without going through safeReturnPath. Cross-origin
  // and protocol-relative values are rejected; we then fall back to the
  // hardcoded inventory list root.
  const backHref = safeReturnPath(returnParam) ?? DEFAULT_BACK;
  return (
    <ItemDetail
      id={id}
      backHref={backHref}
      backLabel="Back to inventory"
      tab={tab}
      returnParam={safeReturnPath(returnParam) ?? undefined}
    />
  );
}
```

- [ ] **Step 3: Typecheck (expected to fail)**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: FAIL — `ItemDetail` doesn't accept `returnParam` yet.

### Task 3.2: Add `returnParam` to `ItemDetail` so Edit link carries it forward

**Files:**

- Modify: `apps/web/src/components/inventory/item-detail.tsx`

- [ ] **Step 1: Find the `ItemDetailProps` interface**

Run: `grep -n 'interface ItemDetailProps\|backHref\|editHref\|tab\?:' apps/web/src/components/inventory/item-detail.tsx | head -8`
Expected: prop interface around lines 30-45.

- [ ] **Step 2: Add `returnParam` to the interface**

In `apps/web/src/components/inventory/item-detail.tsx`, find:

```ts
  backHref: string;
  backLabel: string;
```

and the line below it. Add after `editHref?: string;` (or wherever the last prop is declared in the interface):

```ts
  /**
   * Encoded list URL the user came from. Threaded into the "Edit"
   * link so the edit page can offer the same round-trip back. Comes
   * pre-validated by the page (safeReturnPath).
   */
  returnParam?: string;
```

- [ ] **Step 3: Destructure `returnParam` in the component signature**

Find:

```ts
export async function ItemDetail({ id, backHref, backLabel, editHref, tab }: ItemDetailProps) {
```

Replace with:

```ts
export async function ItemDetail({ id, backHref, backLabel, editHref, tab, returnParam }: ItemDetailProps) {
```

- [ ] **Step 4: Append `?return=` to the Edit link href**

Around line 170, find:

```tsx
<Link href={editHref ?? `/dashboard/inventory/${id}/edit`}>Edit</Link>
```

Replace with:

```tsx
<Link
  href={
    (() => {
      const base = editHref ?? `/dashboard/inventory/${id}/edit`;
      // Append the return param so editing → save still bounces
      // back to the same list URL the user came from.
      return returnParam
        ? `${base}?return=${encodeURIComponent(returnParam)}`
        : base;
    })()
  }
>
  Edit
</Link>
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @stockpilot/web exec vitest run`
Expected: 44 files, 348 tests green.

- [ ] **Step 7: Commit and push**

```bash
git add 'apps/web/src/app/(dashboard)/dashboard/inventory/[id]/page.tsx' \
        apps/web/src/components/inventory/item-detail.tsx
git commit -m "$(cat <<'EOF'
feat(inventory): detail page honors validated ?return= back-link

The detail page now reads `searchParams.return`, runs it through
safeReturnPath, and uses the result as the "Back to inventory"
href. Falls back to /dashboard/inventory if missing / invalid —
zero regression vs today's hardcoded behavior.

ItemDetail also gets a `returnParam` prop so the "Edit" link can
propagate the same value forward — keeps the round-trip intact
through the detail-page click as well.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push
```

---

## PR 4 — Inventory edit page + `ItemForm` honor `?return=`

### Task 4.1: Inventory edit page reads + validates `return`

**Files:**

- Modify: `apps/web/src/app/(dashboard)/dashboard/inventory/[id]/edit/page.tsx`

- [ ] **Step 1: Find the page signature**

Run: `grep -n 'export default async function\|searchParams\|params: Promise' 'apps/web/src/app/(dashboard)/dashboard/inventory/[id]/edit/page.tsx' | head -5`
Expected: the signature on line 21 currently takes only `params: Promise<{ id: string }>`.

- [ ] **Step 2: Add `searchParams` to the page signature**

In `apps/web/src/app/(dashboard)/dashboard/inventory/[id]/edit/page.tsx`, find:

```ts
export default async function EditItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
```

Replace with:

```ts
export default async function EditItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ return?: string }>;
}) {
  const { id } = await params;
  const { return: returnParam } = await searchParams;
```

- [ ] **Step 3: Add the import at the top**

Find the imports block. Add (in alphabetical order with other `@/lib/*` imports):

```ts
import { safeReturnPath } from '@/lib/safe-return-path';
```

- [ ] **Step 4: Resolve the back href just before the JSX return**

Locate the `return` keyword that starts the JSX block (usually `return (` near the end of the function). Just BEFORE that line, add:

```ts
  const backHref = safeReturnPath(returnParam) ?? `/dashboard/inventory/${id}`;
```

- [ ] **Step 5: Update any "Cancel" / breadcrumb back-link in the JSX**

Search the JSX for `Link` elements pointing to `/dashboard/inventory/${id}` or `/dashboard/inventory`. There may be a breadcrumb or a Cancel button.

Run: `grep -n 'href="/dashboard/inventory\|href={`/dashboard/inventory' 'apps/web/src/app/(dashboard)/dashboard/inventory/[id]/edit/page.tsx'`

For each matching `<Link>` that's logically the "back" action (breadcrumb or Cancel), change the href to `{backHref}`.

If the only back-link is implicit (i.e. ItemForm's own Cancel button), skip this step — Task 4.2 handles it via the new `returnHref` prop.

- [ ] **Step 6: Pass `returnHref` to `<ItemForm>`**

Find the `<ItemForm ... />` JSX call. Add a new prop just before the closing `/>`:

```tsx
        returnHref={backHref}
```

- [ ] **Step 7: Typecheck (expected to fail)**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: FAIL — `ItemForm` doesn't accept `returnHref` yet.

### Task 4.2: `ItemForm` accepts `returnHref` and uses it on save

**Files:**

- Modify: `apps/web/src/components/inventory/item-form.tsx`

- [ ] **Step 1: Add `returnHref` to the props interface**

Find the props interface around lines 73-77 (search for `onDone?: () => void;`):

```ts
  /** Item type — drives small form variations: … */
  itemType?: 'product' | 'book' | 'asset' | 'consumable';
  onDone?: () => void;
}
```

Add a new prop above `onDone`:

```ts
  /**
   * Optional same-origin path the form returns to after a successful
   * save (or when the user clicks Cancel). Used by the edit-page flow
   * to honor the `?return=` round-trip back to the list URL.
   * When omitted, the form keeps its current behavior:
   *   - on create: router.push to the new item's detail page
   *   - on edit:   router.refresh in place
   *   - on cancel: onDone() callback
   */
  returnHref?: string;
```

- [ ] **Step 2: Destructure the new prop**

Find the function signature around line 79-93:

```ts
export function ItemForm({
  defaults,
  …
  itemType = 'product',
  onDone,
}: ItemFormProps) {
```

Add `returnHref,` just before `onDone,`:

```ts
  returnHref,
  onDone,
}: ItemFormProps) {
```

- [ ] **Step 3: Use `returnHref` in the post-save navigation**

Find the navigation block around lines 548-553 (right after the toast):

```ts
    onDone?.();
    if (!isEdit) {
      router.push(`/dashboard/inventory/${res.data.id}`);
    } else {
      router.refresh();
    }
  });
```

Replace with:

```ts
    onDone?.();
    if (returnHref) {
      // Edit page passes a `returnHref` so saving bounces the user
      // back to the list URL they came from — preserves the search /
      // filter / sort / page they had typed. Both create + edit
      // honor the param when it's present.
      router.push(returnHref);
    } else if (!isEdit) {
      router.push(`/dashboard/inventory/${res.data.id}`);
    } else {
      router.refresh();
    }
  });
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @stockpilot/web exec vitest run`
Expected: 44 files, 348 tests green.

- [ ] **Step 6: Commit and push**

```bash
git add 'apps/web/src/app/(dashboard)/dashboard/inventory/[id]/edit/page.tsx' \
        apps/web/src/components/inventory/item-form.tsx
git commit -m "$(cat <<'EOF'
feat(inventory): edit page + ItemForm honor ?return= on save

The edit page now reads `searchParams.return`, validates it via
safeReturnPath, and threads the value into `<ItemForm>` via a new
optional `returnHref` prop. On successful save (create OR edit),
ItemForm routes to that URL instead of the detail page or the
in-place refresh — the user lands back on the exact list view
they came from.

Falls back to the detail page (edit) / new-item detail (create) /
in-place refresh when no return param is provided. No regression
for direct deep-link entries into the edit page.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push
```

---

## PR 5 — Books detail + edit pages (mirror)

### Task 5.1: Books detail page consumes `?return=`

**Files:**

- Modify: `apps/web/src/app/(dashboard)/dashboard/books/[id]/page.tsx`

- [ ] **Step 1: Read the current file**

Run: `cat 'apps/web/src/app/(dashboard)/dashboard/books/[id]/page.tsx'`
Expected: a thin shell similar to the inventory detail page, defaulting to `/dashboard/books`.

- [ ] **Step 2: Replace the file's contents**

Write to `apps/web/src/app/(dashboard)/dashboard/books/[id]/page.tsx`:

```tsx
import { ItemDetail } from '@/components/inventory/item-detail';
import { safeReturnPath } from '@/lib/safe-return-path';

const DEFAULT_BACK = '/dashboard/books';

export default async function BookDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; return?: string }>;
}) {
  const { id } = await params;
  const { tab, return: returnParam } = await searchParams;
  // Same flow as the inventory detail page — validate the back-link
  // target, fall back to the books list root if absent/invalid.
  const validated = safeReturnPath(returnParam);
  const backHref = validated ?? DEFAULT_BACK;
  return (
    <ItemDetail
      id={id}
      backHref={backHref}
      backLabel="Back to books"
      editHref={`/dashboard/books/${id}/edit`}
      tab={tab}
      returnParam={validated ?? undefined}
    />
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: exit 0.

### Task 5.2: Books edit page consumes `?return=`

**Files:**

- Modify: `apps/web/src/app/(dashboard)/dashboard/books/[id]/edit/page.tsx`

Mirror the changes from Task 4.1 but with books-flavored defaults.

- [ ] **Step 1: Find the page signature**

Run: `grep -n 'export default async function\|searchParams\|params: Promise' 'apps/web/src/app/(dashboard)/dashboard/books/[id]/edit/page.tsx' | head -5`

- [ ] **Step 2: Add `searchParams` to the page signature**

Find:

```ts
export default async function EditBookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
```

(If the function name is slightly different — `EditBookPage` vs `EditItemPage` — keep whatever the existing file has.)

Replace with:

```ts
export default async function EditBookPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ return?: string }>;
}) {
  const { id } = await params;
  const { return: returnParam } = await searchParams;
```

- [ ] **Step 3: Add the import**

In the imports block, add:

```ts
import { safeReturnPath } from '@/lib/safe-return-path';
```

- [ ] **Step 4: Resolve the back href before the JSX return**

Just before the JSX return, add:

```ts
  const backHref = safeReturnPath(returnParam) ?? `/dashboard/books/${id}`;
```

- [ ] **Step 5: Update any breadcrumb / Cancel Link, and pass `returnHref` to `<ItemForm>`**

Same as Task 4.1 step 5-6: change matching `<Link>` hrefs and add `returnHref={backHref}` to the `<ItemForm ... />` JSX call.

Run: `grep -n 'href="/dashboard/books\|href={`/dashboard/books' 'apps/web/src/app/(dashboard)/dashboard/books/[id]/edit/page.tsx'`

For each "back" link, swap the href to `{backHref}`.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @stockpilot/web exec vitest run`
Expected: 44 files, 348 tests green.

- [ ] **Step 8: Commit and push**

```bash
git add 'apps/web/src/app/(dashboard)/dashboard/books/[id]/page.tsx' \
        'apps/web/src/app/(dashboard)/dashboard/books/[id]/edit/page.tsx'
git commit -m "$(cat <<'EOF'
feat(books): detail + edit pages honor ?return= back-link

Mirror of the inventory-side wiring (commits 90f310a, plus the
detail + edit page commits in this branch). Books page defaults
fall back to /dashboard/books when no return param is present;
edit page passes returnHref into ItemForm so saving a book also
honors the round-trip.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push
```

---

## PR 6 — Smoke + final verification

### Task 6.1: Production build + manual smoke

**Files:** none — verification only.

- [ ] **Step 1: Run a production build to catch any TS / lint surprise**

Run: `pnpm --filter @stockpilot/web exec next build`
Expected: build completes cleanly; the inventory + books routes appear in the manifest.

- [ ] **Step 2: Full test suite one last time**

Run: `pnpm --filter @stockpilot/web exec vitest run`
Expected: 44 files, 348 tests green.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Confirm `origin/main` is up to date**

Run: `cd /Users/brandenvincent-walker/Desktop/Inventory\ System\ App && git fetch origin && git log --oneline origin/main..HEAD`
Expected: empty output (no unpushed commits).

- [ ] **Step 5: Hand off to the user for manual smoke**

Post the following to the user:

> Search state persistence shipped. Smoke checklist (each ~10s):
>
> 1. `/dashboard/inventory` → search "lanyards" → click a row → click "Back to inventory" → search query is still in the box.
> 2. Same flow but click "Edit" instead → Save → land back on the list with "lanyards" still applied.
> 3. Same flow with multi-filter: search + a category + sort = restored on round-trip.
> 4. `/dashboard/books` → repeat 1-3.
> 5. Open a deep link to `/dashboard/inventory/<id>` directly → "Back to inventory" goes to the bare list (no regression).

---

## Self-Review

**Spec coverage:**

| Spec section | Implementing task |
| --- | --- |
| `safeReturnPath` helper + tests | Task 1.1 + 1.2 |
| Row Link appends `?return=` (list URL) | Task 2.1 |
| Inventory detail page reads + validates `return` | Task 3.1 |
| ItemDetail propagates `returnParam` into Edit link | Task 3.2 |
| Inventory edit page reads `return`, passes to ItemForm | Task 4.1 |
| ItemForm honors `returnHref` on save (create + edit) | Task 4.2 |
| Books detail page mirror | Task 5.1 |
| Books edit page mirror | Task 5.2 |
| Safety: open-redirect prevention | Task 1.2 (via `safeReturnPath`) — used by every consumer |
| Default-fallback when `return` is absent / invalid | every consumer task |
| Smoke checklist from spec §Testing | Task 6.1 |

**Placeholder scan:** every code block is complete. No "TODO" / "TBD" / "similar to X" without the actual diff. The two grep-based locator steps (4.1.5, 5.2.5) tell the engineer exactly what to look for and what to change.

**Type consistency:**

- `returnParam` (camelCase) is consistently the prop on `ItemDetail`; `return` (the URL param) is consistently the `searchParams` key.
- `returnHref` is the `ItemForm` prop everywhere; never typo'd as `returnUrl` / `returnPath`.
- `safeReturnPath` always returns `string | null`; consumers always coalesce with `??`.
- Both `searchParams: Promise<{ tab?: string; return?: string }>` shapes match between inventory + books detail pages.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-search-state-persistence.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

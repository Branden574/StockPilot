# Pagination Jump-to-Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `Page X of Y` indicator on `/dashboard/inventory` and `/dashboard/books` clickable; clicking it opens a popover of all page numbers for instant jump-to-page navigation.

**Architecture:** Wrap the existing static `<span>Page X of Y</span>` inside the local `Pagination` component in `inventory-table.tsx` with a Radix `Popover`. Trigger is a button styled like today's text; content is a scrollable grid of Next.js `<Link>`s pointing at `buildHref(n)` — the same helper Prev / Next already use.

**Tech Stack:** Next.js 16 App Router · React 19 · Radix Popover (`@/components/ui/popover`) · Vitest + Testing Library.

**Source spec:** [docs/superpowers/specs/2026-05-14-pagination-jump-to-page-design.md](../specs/2026-05-14-pagination-jump-to-page-design.md) (commit 79cda17)

---

## File Structure

**Modified:**

- `apps/web/src/components/inventory/inventory-table.tsx` — local `Pagination` component (declared line 894) gets the popover treatment. Export it so the test file can import it directly without rendering the whole table. Adds `Popover`, `PopoverContent`, `PopoverTrigger` imports.

**Created:**

- `apps/web/src/components/inventory/inventory-table.pagination.test.tsx` — Vitest + Testing Library tests covering trigger, popover content, and link targets.

**Untouched:**

- All callers (`/dashboard/inventory/page.tsx`, `/dashboard/books/page.tsx`). They use `<InventoryTable>` which renders the local `Pagination` internally — the change is invisible to them.

---

## PR 1 — Add the popover + tests

### Task 1.1: Write the failing test

**Files:**

- Create: `apps/web/src/components/inventory/inventory-table.pagination.test.tsx`

- [ ] **Step 1: Write the test file**

```tsx
// apps/web/src/components/inventory/inventory-table.pagination.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Pagination } from './inventory-table';

// Next.js Link does navigation gymnastics — stub to a plain anchor
// so we can assert href values directly.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

describe('Pagination jump-to-page popover', () => {
  it('renders a Jump to page trigger with current state', () => {
    render(
      <Pagination
        page={2}
        pageSize={50}
        total={210}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
      />,
    );
    const trigger = screen.getByRole('button', { name: /jump to page/i });
    expect(trigger).toHaveTextContent('Page 2 of 5');
  });

  it('opens a popover with one link per page when the trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Pagination
        page={1}
        pageSize={50}
        total={150}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
      />,
    );
    await user.click(screen.getByRole('button', { name: /jump to page/i }));
    // 3 pages total → 3 links inside the popover.
    const pageLinks = await screen.findAllByRole('link', {
      name: /^[0-9]+$/,
    });
    expect(pageLinks).toHaveLength(3);
    expect(pageLinks[0]).toHaveAttribute(
      'href',
      '/dashboard/inventory?page=1',
    );
    expect(pageLinks[1]).toHaveAttribute(
      'href',
      '/dashboard/inventory?page=2',
    );
    expect(pageLinks[2]).toHaveAttribute(
      'href',
      '/dashboard/inventory?page=3',
    );
  });

  it('marks the current page link with aria-current="page"', async () => {
    const user = userEvent.setup();
    render(
      <Pagination
        page={2}
        pageSize={50}
        total={150}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
      />,
    );
    await user.click(screen.getByRole('button', { name: /jump to page/i }));
    const activeLink = await screen.findByRole('link', { current: 'page' });
    expect(activeLink).toHaveTextContent('2');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @stockpilot/web exec vitest run src/components/inventory/inventory-table.pagination.test.tsx`
Expected: FAIL — `Pagination` is not exported from `./inventory-table` (`SyntaxError: The requested module './inventory-table' does not provide an export named 'Pagination'`).

### Task 1.2: Export Pagination + wrap indicator in a Popover

**Files:**

- Modify: `apps/web/src/components/inventory/inventory-table.tsx`

- [ ] **Step 1: Add the Popover imports**

Find the existing import block (the file starts with `'use client';` then imports). Locate the existing `Popover, PopoverContent, PopoverTrigger` import — if it's not present, add it alongside the other `@/components/ui/*` imports:

Run: `grep -n "from '@/components/ui/popover'" apps/web/src/components/inventory/inventory-table.tsx`

If the grep returns nothing, add this import line in the imports block (alphabetically among the `@/components/ui/*` group):

```ts
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
```

If it's already there, skip this step.

- [ ] **Step 2: Export the local Pagination component**

Find line 894 (start of the `function Pagination({` declaration):

```ts
function Pagination({
```

Change to:

```ts
export function Pagination({
```

- [ ] **Step 3: Replace the static page indicator with the popover trigger + content**

In the same `Pagination` component, find this block (currently around lines 930-932):

```tsx
        <span className="text-muted-foreground px-2 text-[11.5px]">
          Page {safePage} of {totalPages}
        </span>
```

Replace with:

```tsx
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Jump to page"
              className="hover:text-foreground hover:bg-muted/40 cursor-pointer rounded px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors"
            >
              Page {safePage} of {totalPages}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="center"
            side="top"
            className="max-h-[360px] w-auto min-w-[260px] overflow-y-auto p-2"
          >
            <div className="grid grid-cols-5 gap-1 sm:grid-cols-8">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                <Button
                  key={n}
                  asChild
                  variant={n === safePage ? 'default' : 'ghost'}
                  size="sm"
                  className="h-7 w-full px-2 text-[12px]"
                >
                  <Link
                    href={buildHref(n)}
                    prefetch={false}
                    aria-current={n === safePage ? 'page' : undefined}
                  >
                    {n}
                  </Link>
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @stockpilot/web exec vitest run src/components/inventory/inventory-table.pagination.test.tsx`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `pnpm --filter @stockpilot/web exec vitest run`
Expected: 46 files, 353 tests (350 previous + 3 new). All passing.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit and push**

```bash
git add apps/web/src/components/inventory/inventory-table.tsx \
        apps/web/src/components/inventory/inventory-table.pagination.test.tsx
git commit -m "$(cat <<'EOF'
feat(inventory): clickable page indicator opens jump-to-page popover

The 'Page X of Y' text between Prev and Next is now a button that
opens a Radix popover listing every available page as a Next.js
Link to buildHref(n). Active page gets aria-current="page" and a
filled variant so it stands out. Popover scrolls (max-h 360px)
for orgs with many pages.

Both /dashboard/inventory and /dashboard/books inherit since they
share InventoryTable. No new endpoints, no migrations, no API
surface change. Pagination is exported so the new test file can
import it directly without mounting the whole table.

Three Vitest cases cover: trigger label + state, popover renders
N page links per page count, current page gets aria-current.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push
```

---

## PR 2 — Smoke verification

### Task 2.1: Production build + final test pass

**Files:** none — verification only.

- [ ] **Step 1: Production build to catch any TS / lint surprise**

Run: `pnpm --filter @stockpilot/web exec next build`
Expected: build completes cleanly, no errors in the routes manifest.

- [ ] **Step 2: Full vitest one last time**

Run: `pnpm --filter @stockpilot/web exec vitest run`
Expected: 46 files, 353 tests green.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Confirm origin/main is up to date**

Run: `git fetch origin && git log --oneline origin/main..HEAD`
Expected: empty output.

- [ ] **Step 5: Hand off to user for manual smoke**

Post to the user:

> Pagination jump-to-page shipped. Smoke checklist:
>
> 1. `/dashboard/inventory` → scroll to bottom → click `Page 1 of N` → popover opens.
> 2. Click any page → list updates, popover closes, URL reflects new page.
> 3. Same flow on `/dashboard/books`.
> 4. Mobile: tap indicator → popover sized for narrow viewport → tap a page → navigates.
> 5. Keyboard: Tab to indicator → Enter to open → Tab through pages → Enter to navigate.

---

## Self-Review

**Spec coverage:**

| Spec section | Implementing task |
| --- | --- |
| Wrap `Page X of Y` in Radix Popover | Task 1.2 step 3 |
| Trigger is a button with `aria-label="Jump to page"` | Task 1.2 step 3 |
| Popover content is a scrollable grid of page-number Links | Task 1.2 step 3 |
| Active page button has `aria-current="page"` and visual treatment | Task 1.2 step 3 |
| `Array.from({ length: totalPages }, ...)` generates the list | Task 1.2 step 3 |
| `max-h-[360px] overflow-y-auto` for large lists | Task 1.2 step 3 |
| `grid grid-cols-5 sm:grid-cols-8 gap-1` responsive layout | Task 1.2 step 3 |
| Unit tests: trigger label, link count, aria-current | Task 1.1 |
| Inherits to both inventory + books | Implicit — both pages use the same `InventoryTable` |

**Placeholder scan:** every code block is complete. The conditional grep step (Task 1.2 step 1) gives the engineer a concrete decision rule + exact import line if the import isn't already present.

**Type consistency:**

- `Pagination` is the exported name in Task 1.2 and imported under the same name in Task 1.1 — match.
- Existing prop interface (`{ page, pageSize, total, buildHref }`) is unchanged. Tests construct it inline with matching shapes.
- `buildHref(n)` returns `string` in both the test stub and production helper.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-pagination-jump-to-page.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

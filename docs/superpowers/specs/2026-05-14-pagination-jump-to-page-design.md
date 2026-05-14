# Pagination Jump-to-Page Design

**Date:** 2026-05-14
**Status:** Approved (proceeding to implementation plan)
**Owner:** Branden Vincent-Walker

## Problem

The Inventory + Books list pages today render a static `Page X of Y` between Prev / Next buttons. To get from page 1 to page 4, the user must click "Next →" three times. Reported as annoying when the user knows exactly which page they want.

## Goal

Make the `Page X of Y` indicator clickable. Clicking it opens a popover listing every available page; clicking a number jumps directly to that page. Inventory + Books both inherit the change since they share `InventoryTable`.

## Scope

- **In:** the `Pagination` sub-component inside `apps/web/src/components/inventory/inventory-table.tsx`. Both `/dashboard/inventory` and `/dashboard/books` get the feature for free.
- **Out:** other paginated lists in the app (movements, audit log, etc.). They can adopt the same pattern in follow-ups but aren't part of this change.

## Approach

Wrap the existing `<span>Page X of Y</span>` in a Radix `Popover` (`@/components/ui/popover`). The trigger is a button styled identically to today's static text plus a subtle hover state. The popover content is a scrollable grid of page-number buttons, each a Next.js `<Link>` pointing at `buildHref(n)` — the same helper Prev / Next use today.

### Why a popover and not inline page numbers

- Inline `1 2 3 ... 99 100` strips look busy at the bottom of a dense table.
- Popover keeps the toolbar minimal until the user signals intent.
- Radix handles outside-click + Escape + focus management automatically.
- The trigger discoverability comes from the obvious "this text changed style on hover" cue.

### Component shape

```tsx
<Popover>
  <PopoverTrigger asChild>
    <button
      type="button"
      aria-label="Jump to page"
      className="hover:text-foreground cursor-pointer rounded px-2 text-[11.5px] text-muted-foreground"
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

### Edge cases

- **`totalPages === 1`** — trigger stays rendered but the popover only has one button (the current page). Cheap; no special-case branch.
- **Very large page counts** — the popover scrolls. A 1000-page org renders 1000 small buttons inside the scrollable container. Each button is a `Link`, so the actual cost is layout + the link prefetch (which we disable via `prefetch={false}`). Acceptable today; revisit if any org genuinely hits 500+ pages.
- **Pagination hidden during search** — the existing `{!q.trim() && <Pagination ... />}` gate stays. No interaction with the search flow.
- **Mobile** — Radix Popover handles touch + outside-click correctly. Grid drops from 8 cols to 5 cols on narrow screens.

### Accessibility

- Trigger: `aria-label="Jump to page"` (the visible text changes per state, so a stable aria-label helps screen readers).
- Active page button: `aria-current="page"`.
- Keyboard: Radix gives Tab navigation through page buttons + Enter / Space to activate. Escape closes.
- Focus ring: inherits from `Button` component variants.

## Testing

**Unit:**
- New Vitest in `apps/web/src/components/inventory/inventory-table.pagination.test.tsx` (or co-located):
  - Renders trigger with `aria-label="Jump to page"` and shows `Page 2 of 5`.
  - Click trigger → popover opens → 5 page buttons visible.
  - Active page button has `aria-current="page"`.
  - Each page-number link points at `buildHref(n)`.

**Manual smoke (after deploy):**
1. `/dashboard/inventory` → scroll to bottom → click `Page 1 of N` → popover opens with all page numbers.
2. Click any page → navigates → list updates → popover closes.
3. Same flow on `/dashboard/books`.
4. Mobile: tap indicator → popover sized for narrow viewport → tap a number → navigates.

## File structure

**Modified:**

- `apps/web/src/components/inventory/inventory-table.tsx` — replaces the inline `<span>Page X of Y</span>` block inside the local `Pagination` component with the Popover-wrapped version above. Imports `Popover`, `PopoverContent`, `PopoverTrigger` from `@/components/ui/popover`.

**Created:**

- `apps/web/src/components/inventory/inventory-table.pagination.test.tsx` — Vitest + Testing Library tests for the new interaction.

## Non-goals

- Number-input "go to page" shortcut. Defer until someone has 100+ pages and complains.
- Compact view (`1 ... 4 5 6 ... 99 100`). The scrollable popover handles large lists adequately at the volumes we see.
- Persisting the popover open state across navigations. Each navigation reloads the table; popover state resets — that's the expected behavior.

## Open questions

None at design time.

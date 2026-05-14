# Search State Persistence on Inventory + Books Round-Trip

**Date:** 2026-05-14
**Status:** Approved (proceeding to implementation plan)
**Owner:** Branden Vincent-Walker

## Problem

A user searches for `lanyards` on `/dashboard/inventory`. They click into one of the matching items, view or edit it, then come back to the list. The search query, filters, sort order, and page number are all gone — they have to retype `lanyards` and re-apply every filter. Same issue on `/dashboard/books`. Multiple users have complained.

Root cause in the current code:

- `apps/web/src/components/inventory/inventory-table.tsx:709-710` — the row Link uses `href={\`${rowLinkPrefix}/${item.id}\`}`. No query state carried.
- `apps/web/src/app/(dashboard)/dashboard/inventory/[id]/page.tsx:19-20` — `backHref="/dashboard/inventory"` hardcoded.
- `apps/web/src/app/(dashboard)/dashboard/books/[id]/page.tsx` — same `backHref="/dashboard/books"` pattern.
- Edit pages and `<ItemForm>` post-save redirect both go to hardcoded paths.

## Goal

Preserve the entire URL state (search query, filters, sort, page) on the **drill-down round-trip**: click row → view / edit → back. Do NOT persist beyond a single round-trip (no sessionStorage, no per-user prefs). If the user navigates to Dashboard or Books, then back to Inventory, the search resets — that's intentional. Today's user complaint is specifically about the round-trip flow.

## Scope

- **In:** Inventory list (`/dashboard/inventory`), Books list (`/dashboard/books`), item detail page, edit page. Both the "Back to list" link AND the post-save redirect.
- **Out:** Other list pages (orders, shipments, suppliers, etc.) keep their current behavior. Per-user persistent prefs. Cross-tab state sync.

## Approach: URL `return` param

Encode the current list URL into a `return` query param when the user clicks into an item. The detail page reads it (validated for safety), uses it for the "Back to inventory" link, and propagates it through to the edit page. After Save / Delete on the edit page, redirect to `return` if present, else fall back to the current behavior.

Same pattern used by next-auth `?callbackUrl=` and most modern frameworks for post-login redirects. Stateless, survives reloads, transparent to share, easy to test.

### Data flow

```text
List page                  Detail page                 Edit page
/dashboard/inventory       /dashboard/inventory/[id]   /dashboard/inventory/[id]/edit
   ?q=lanyards                ?return=<encoded>           ?return=<encoded>
   ?sort=name_asc                ↓                           ↓
       │                      "Back to inventory"         "Cancel" / "Save"
       │ row click ─────┐     uses ?return                 use ?return
       │ encodes URL    │        ↓                           ↓
       └────────────────┘     "Edit" link adds ?return → "Save" returns to list URL
```

### Validation

`return` is user-controlled. Without validation it becomes an open-redirect vector. New helper `lib/safe-return-path.ts`:

```ts
/**
 * Validates a `?return=` URL param. Only accepts same-origin paths
 * starting with `/dashboard/`. Returns the validated path or null
 * (caller falls back to a hardcoded default).
 *
 * Rejects:
 *   - non-strings, empty strings
 *   - anything that doesn't start with `/dashboard/`
 *   - protocol-relative escapes (`//evil.com`)
 *   - encoded scheme escapes (`%2F%2Fevil.com`, `javascript:`)
 */
export function safeReturnPath(raw: string | null | undefined): string | null;
```

Decoding rules:

- Strip whitespace at edges.
- Reject if length > 2000 chars (URL guideline).
- Reject if doesn't start with `/dashboard/` after `decodeURIComponent`.
- Reject if contains `//` anywhere (after decode).
- Reject if matches `^javascript:`, `^data:`, `^file:` (after decode + lowercase).

## Files touched

| File | Change |
| --- | --- |
| `apps/web/src/lib/safe-return-path.ts` | **NEW** — validation helper + Vitest tests. |
| `apps/web/src/lib/safe-return-path.test.ts` | **NEW** — covers happy path + 5 attack vectors. |
| `apps/web/src/components/inventory/inventory-table.tsx` | Row Link: append `?return=<URL.searchParams.toString()>` to href. Use `useSearchParams()` + `usePathname()` to build the current URL at render time. |
| `apps/web/src/app/(dashboard)/dashboard/inventory/[id]/page.tsx` | Add `searchParams: { return?: string }`. Validate via `safeReturnPath`. Pass to `ItemDetail` as `backHref`. |
| `apps/web/src/app/(dashboard)/dashboard/books/[id]/page.tsx` | Same as above but default `/dashboard/books`. |
| `apps/web/src/components/inventory/item-detail.tsx` | "Edit item" link gets the same `?return=...` carried through. |
| `apps/web/src/app/(dashboard)/dashboard/inventory/[id]/edit/page.tsx` | Read + validate `return`. Pass to "Cancel" back link AND as a `returnHref` prop on `<ItemForm>`. |
| `apps/web/src/app/(dashboard)/dashboard/books/[id]/edit/page.tsx` | Same. |
| `apps/web/src/components/inventory/item-form.tsx` | New optional `returnHref?: string` prop. On successful save, redirect there if present; else current behavior. Same for the "Cancel" link. (Delete flow, if it lives elsewhere, is out of scope for this pass.) |

## User-visible behavior

1. User on `/dashboard/inventory?q=lanyards&sort=name_asc&cat=swag`.
2. Clicks "L4L Royal Blue Lanyard" → URL becomes `/dashboard/inventory/abc-123?return=%2Fdashboard%2Finventory%3Fq%3Dlanyards%26sort%3Dname_asc%26cat%3Dswag`.
3. Detail page shows "← Back to inventory" linking back to the encoded URL.
4. Clicks "Edit" → URL becomes `/dashboard/inventory/abc-123/edit?return=<same>`.
5. Edits the price, clicks Save. Toast: "Item updated." Redirects to the original list URL — search and filter preserved.
6. Clicks "Cancel" instead → same: returns to original list URL.
7. Clicks browser Back from edit page → goes to detail page (Next.js history). Clicks Back again → returns to the list with search preserved.

## Edge cases

- **Deep-link entry** (no `return`, e.g. notification): back link uses default `/dashboard/inventory` or `/dashboard/books`. No regression vs today.
- **Malformed `return`**: same as deep-link — default fallback.
- **Cross-origin `return`** (open-redirect attempt): rejected by `safeReturnPath`. Falls back to default.
- **List URL has multiple `?cat=` params** (multi-select filter): the encoded URL preserves them verbatim since `URLSearchParams.toString()` handles duplicates.
- **Inventory item viewed from Books page accidentally** (route mismatch): the `return` URL carries `/dashboard/books`, so back link goes to Books. Correct.
- **Books vs Inventory tab consistency**: each page sets its own default fallback. Item type detection isn't needed.

## Non-goals

- Persisting state across separate sessions or tabs.
- Restoring state after the user explicitly navigates away (e.g., to Dashboard → Inventory).
- Server-side caching of last-list-URL per user.
- Optimistic UI for the post-save redirect (current navigation is fast enough).

## Testing

**Unit:**

- `safe-return-path.test.ts` covers:
  - Happy path: `/dashboard/inventory?q=foo` → returns it
  - Empty / null → null
  - Cross-origin: `https://evil.com` → null
  - Protocol-relative: `//evil.com` → null
  - Scheme: `javascript:alert(1)` → null
  - Wrong prefix: `/admin/secrets` → null
  - Overlong: 3000-char string → null

**Manual smoke (after deploy):**

1. Search "lanyards" on Inventory → click row → click back → search still there.
2. Same flow but click Edit → Save → confirm landed on list with search preserved.
3. Same flow but Cancel from edit → list with search preserved.
4. Click an item via a deep link (e.g. notification or pasted URL) → back link uses default.

## Implementation order

1. Write + commit `safe-return-path.ts` + tests (in isolation, easy to verify).
2. Update inventory list page row Links (test by clicking through manually).
3. Update inventory detail + edit pages.
4. Update books detail + edit pages (mirror change).
5. Update `<ItemForm>` post-save redirect logic.

Each step independently shippable. Each step keeps the app functional (the lack of `return` param just falls back to today's behavior).

## Open questions

None at design time. All decisions explicit above.

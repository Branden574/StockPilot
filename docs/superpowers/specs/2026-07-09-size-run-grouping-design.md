# Size-Run Grouping (Apparel) — Design

**Status:** Approved (owner green-lit 2026-07-09)
**Goal:** Collapse a size run — items that share a base name with a trailing size token (`L4L – Pink Shirt – L / – XL / – 2XL`) — into ONE expandable "L4L – Pink Shirt" row in the inventory list, so a wall of per-size lines reads as one product. Display-only, on top of the existing SKU ("Model B") grouping; each size keeps its own SKU, count, and rack.

---

## 1. Why (root cause)

Grouping in the Items list is by **full SKU** (`group-by-sku.ts`, key `sku:${sku}`). A size run has a **distinct SKU per size**, so the sizes never collapse — and they *can't* be made to share a SKU, because the `(org, sku, charter, bin)` uniqueness index (mig 0234) correctly forbids two different items sharing a SKU at the same charter+rack (a picker scanning that SKU there couldn't tell L from XL). So the only lever for grouping (SKU) is the one a size run isn't allowed to pull. This feature adds a **second, display-only grouping layer** keyed on the derived product base, which needs no SKU change and no schema change.

## 2. Owner decisions

- Group **exactly like the laptop SKU grouping** — one collapsed row with a roll-up total, expand to the members.
- **Leave SKUs as-is** — no data change; grouping is a view.
- Members keep their own **SKU, count, and rack**; the group total is the **sum of member on-hand** (e.g. 6 + 6 + 6 = 18).
- **Automatic**, name-driven (their items are already named `<product> - <size>`).

## 3. Grouping key — derived, name-based

Derive a **style base** by stripping a trailing size token from the item **name**:

- Reuse and **extend** the existing parser in `apps/web/src/components/inventory/add-sized-variants-button.tsx:24-55` (`SIZE_NAME_REGEX`, `stripSizeSuffix`). **Extend the token set to include `2XL / 3XL / 4XL / 5XL`** (today it only knows `XS S M L XL XXL XXXL XXXXL XXXXXL` — the owner's `2XL` shirt would otherwise not group).
- **Move the parser to a shared, unit-tested location** (`packages/core/src/inventory/size-run.ts`) so the "Add more sizes" button and the new grouping share ONE implementation (DRY). The button keeps behaving identically.
- Style base = `stripSizeSuffix(name)`. An item **only participates** in a size-run group when its name matches a size token AND **≥2 items share the same style base** (within the rendered set). Everything else renders exactly as today.
- SKU-based stripping is NOT used for the key (the owner's SKUs are random, e.g. `SP-KEOQ5-KZH`, not `…-2XL`).

## 4. Rendering — a style layer on top of Model B

The list already renders a `RenderEntry[]` (`{kind:'row', item} | {kind:'header', group, items}`) with `SkuGroupHeaderRow` + an `expandedSkuGroups: Set<string>` (`inventory-table.tsx`). Clone that pattern one level up:

- New `packages/core/src/inventory/group-by-style.ts` — mirror of `group-by-sku.ts`. `groupBySizeRun(entries)` groups the already-built render entries (rows and/or SKU-headers) by style base; a base with ≥2 members becomes a `StyleGroup { styleKey, baseName, total, members, sizeCount }`, `total = Σ member on-hand`; a base with a single member stays ungrouped.
- New `StyleGroupHeaderRow` component in `inventory-table.tsx` (clone `SkuGroupHeaderRow`, ~line 2118): base name, roll-up total, a **"N sizes"** chip, category/rack from the first member, a chevron. Non-selectable. Collapsed by default.
- New `expandedStyleGroups: Set<string>` state + `toggleStyleGroup`. Expanding a style header reveals its member entries (each of which may itself be a plain row or — in the general case — a SKU header with its own children).
- Order: collect same-style members to the position of the first member (a size run reads as one contiguous block).

## 5. Search + filters

Searching/filtering runs BEFORE grouping (over `displayed`), matching `name/sku/barcode/model_number` (both instant + server modes, `instant-mode.ts:232` / `inventory.ts:359`) — so a search for `XL` already surfaces the XL member. New behavior: when a **search term is active**, style groups that contain a matched member **auto-expand** (so the match is visible, not hidden inside a collapsed header). No change to the match columns.

## 6. Scope & phasing

- **P1 — Web Items list** (`inventory-table.tsx`): the sized products live here. Delivers the owner's exact scenario. Includes the shared parser, `group-by-style.ts`, the header row, expand state, and search auto-expand.
- **P2 — Mobile Items list** (`apps/mobile/app/(drawer)/(tabs)/inventory.tsx`): today a flat `FlatList` with **no grouping** — a from-scratch client-side group-by-style over the fetched rows + a collapsible section header. OTA after.
- **Books:** unchanged. Books aren't sized (`showBookFields` already disables SKU grouping); size-run grouping does not apply.

## 7. Out of scope (YAGNI)

- No persisted style/group id, no explicit "style code" field, no size-as-first-class-column (grouping is derived at read time).
- No change to SKU uniqueness (mig 0234 stays), no picking/scanning change, no data migration.
- Numeric/waist sizes (30/32/…) — only the XS–5XL apparel token family for now.
- A global on/off toggle — sized runs always group (safe, reversible per-group via expand); a toggle can come later if requested.

## 8. Global constraints

- **Web + mobile parity** (phased P1 web, P2 mobile).
- **TDD** — the size parser + `group-by-style` are pure, fully unit-tested (incl. the `2XL/3XL` cases and the "don't merge unrelated products" guard); table integration gets a component test for collapse/expand + roll-up total.
- **No Claude/Anthropic co-author trailer** on commits.
- **Live demo-org + real-org verification** — the owner's L4L Pink Shirt run (L/XL/2XL at 22-A) must collapse into one row totaling 18, expand to the three sizes with distinct SKUs.

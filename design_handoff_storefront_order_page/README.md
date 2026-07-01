# Handoff: StockPilot Storefront — "Place an Order" Redesign

## Overview
A storefront-style redesign of the StockPilot `/dashboard/orders/new` page. It replaces the form-heavy order page with an internal-ecommerce experience: a checkout-preferences setup bar, a catalog toolbar (search / category pills / availability / sort / view toggle), a "Frequently ordered" carousel, a product grid grouped by category, and a sticky Order Cart with a review → submit flow.

## About the Design Files
The files in `design/` are **design references built in HTML + React (Babel-in-browser)** — a working prototype showing the intended look and behavior. They are NOT production code to copy in directly. **Recreate this design inside the existing StockPilot Next.js + Tailwind codebase**, using its established component patterns, data fetching, and routing. Keep all existing functionality of the current order page (same endpoints, same order-submission contract) — this is a frontend reskin/reorganization.

The prototype is the source of truth for anything this README doesn't cover:
- `design/storefront.css` — every component style, exact values
- `design/styles.css` — design tokens (CSS variables) + app shell styles
- `design/storefront-components.jsx` — card / cart / modal / carousel markup structure
- `design/storefront-page.jsx` — page assembly, state, filtering logic
- Open `design/StockPilot Storefront - Place an Order.html` in a browser to see it running.

## Fidelity
**High-fidelity.** Recreate pixel-perfectly: exact colors, radii, sizes, typography, hover states, and shadows below. Where the codebase already has an equivalent primitive (e.g. a Popover), use it but restyle to match these specs exactly.

## Design Tokens (dark theme — the default)

Colors (put in `globals.css` as CSS vars, or Tailwind theme colors):
```
--bg:          #0c0d0a   page background (near-black, warm)
--bg-elev:     #131410   cards, toolbar fields (dark charcoal)
--bg-sunk:     #08090a   recessed fills (segmented track, icon chips)
--ink:         #f0efe8   primary text
--ink-2:       #d8d6cc   secondary text
--ink-3:       #9a9b91   tertiary text
--ink-4:       #6a6b62   muted/labels
--ink-5:       #44453e   faint (glyph placeholders)
--line:        #1f201b   default borders (hairline)
--line-2:      #1a1b16   subtle inner borders / dividers
--line-strong: #2a2b25   hover borders
--accent:      oklch(0.82 0.13 165)   StockPilot green (mint)
--on-accent:   oklch(0.20 0.05 165)   text on accent fills
--warn:        oklch(0.78 0.13 75)    amber dot; amber TEXT on dark = oklch(0.85 0.13 75)
--crit:        oklch(0.62 0.16 25)    red dot;   red TEXT on dark = oklch(0.72 0.14 25)
```
Light theme exists in `styles.css` (`:root`) — optional to port.

Typography:
- Display (H1, section titles, card names): **Inter Tight**, weight 500, negative tracking (-0.006em to -0.025em)
- Body/UI: **Inter**, 12–13.5px, weight 400–600
- Mono (SKUs, counts, quantities, flow labels): **JetBrains Mono**, 10–12px
- Serif glyph placeholders (photo-less items): **Instrument Serif**
- Body base: 13.5px / 1.5, antialiased, `font-feature-settings: "ss01","cv11","tnum"`

Radii: product cards **12px** · cart panel **14px** · modal **16px** · buttons/steppers **9px** · submit **11px** · search & tool buttons **10px** · segmented inner **7px** · pills/steppers-mini/badges **999px** · popovers **12px**

Shadows:
```
card hover:  0 4px 12px -4px rgba(0,0,0,0.5)
popover:     0 24px 48px -16px rgba(0,0,0,0.7), 0 8px 16px -8px rgba(0,0,0,0.08)
submit glow: 0 1px 0 rgba(255,255,255,0.12) inset, 0 6px 16px -8px accent@60%
```

Spacing: page padding `26px 32px 90px`, max-width 1560px centered; shell grid `minmax(0,1fr) 372px`, gap 24px; card grid gap 14px; topbar 52px; sidebar 232px.

## Layout (top to bottom)
1. **Existing app shell** — sidebar + topbar unchanged (breadcrumb `Inventory / Orders / New`).
2. **Page head** — left: "← Back to orders" link (12px, muted → ink on hover), H1 **"Place an Order"** (30px Inter Tight 500, -0.025em), subtitle "Browse available inventory, add items to your cart, and submit for approval." (13.5px, --ink-3). Right: **flow indicator**.
3. **Order setup bar** (full width card).
4. **Two-column shell**: catalog (fluid) + cart rail (372px, sticky). Single column below 1280px.

## Components — exact specs

### Flow indicator (Browse → Cart → Review → Submit)
- 4 steps: 18px circle + label (JetBrains Mono 10px uppercase, letter-spacing 0.09em, --ink-4), separated by 26×1px lines (--line-strong, 8px margins).
- Active: circle filled --accent + ring `0 0 0 4px accent@18%`; label --ink.
- Done: circle accent@12% fill, accent border, accent check icon (10px). Todo: hollow, --line-strong border.
- Stage derives from state: empty cart = Browse; ≥1 item = Cart; review modal open = Review; submitted = Submit.

### Order setup bar
- One horizontal card: `--bg-elev`, 1px `--line`, radius 12, cells divided by 1px `--line-2`.
- Cell: padding 13×18, flex, gap 11. Contents: 32×32 icon chip (radius 8, --bg-sunk fill, --line-2 border, --ink-3 icon 15px) + stacked label/value. Label: 10.5px uppercase 0.07em --ink-4. Value: 13.5px weight 500 --ink + 11px chevron. Optional hint line: 11px --ink-4.
- Cells: **Warehouse** (popover list), **Requesting for** (popover with search input + people list; shows "Myself" + own name hint, or person name + "On behalf · role"), **Fulfillment** (segmented control), **Pick up at / Deliver to** (static text when Pickup: "DC4 will-call desk / Ready within 1 business day of approval"; site popover when Delivery).
- Hover on interactive cells: background `--bg-sunk` at ~55% opacity.
- **Segmented control** (make selection obvious): track --bg-sunk, 1px --line-2, radius 10, 3px padding; buttons 7×14px padding, radius 7, 12.5px 500 --ink-3; **active = --accent fill, --on-accent text, weight 600, shadow 0 1px 3px rgba(0,0,0,0.35)**. Icons: pkg (Pickup) / truck (Delivery), 13px.
- **Popover**: min-width 264, --bg-elev, 1px --line-strong, radius 12, 6px padding, pop shadow, entrance 160ms cubic-bezier(.2,.8,.2,1) translateY(-5px)+scale(0.99)→none. Option rows: padding 8×10, radius 8, hover --bg-sunk; name 13px 500 + sub 11px --ink-4; accent check on selected.

### Catalog toolbar (sticky)
- Sticky under topbar; background = page bg at 88% + `backdrop-filter: blur(12px)`.
- **Search**: flex-1, height 40, radius 10, --bg-elev, 1px --line; icon left (15px, --ink-4); placeholder "Search products, SKU, category…"; clear ×-button appears when non-empty. Focus: border accent@55%, ring `0 0 0 3px accent@14%`.
- **Availability button**: height 40, radius 10, --bg-elev, filter icon + label + chevron; when filters active: border accent@60% + count badge (16px accent circle, mono 10px 600, --on-accent). Popover: checkboxes In stock / Low stock / Out of stock with counts.
- **Sort button**: same shape; label = current sort (Featured / Most ordered by you / Name A–Z / Name Z–A / Most available / Least available).
- **View toggle**: segmented 2 icon buttons (grid / list), 34×32, radius 7, active = --bg-sunk + inset 1px --line ring.
- **Category pills row** below (horizontally scrollable, hidden scrollbar): height 34, padding 0×15, radius 999, --bg-elev + 1px --line, 12.5px 500 --ink-3, with 13px category icon + mono count at 70% opacity. Hover: --line-strong border, --ink. **Active: --ink background, --bg text** (inverted). "All" pill first. Clicking active pill returns to All.
- **Active filter chips** (when search/availability set): 26px pill chips, accent@12% fill + accent@35% border, ×-remove buttons, plus "Clear all" text link.

### Frequently Ordered carousel (only on unfiltered "All" view)
- Header: sparkles icon + "Frequently ordered" (17px Inter Tight 500) + "Based on your last 30 days" (12px --ink-4) + right chevron arrow buttons (28px, radius 8).
- Track: flex, gap 12, `overflow-x: auto`, `scroll-snap-type: x mandatory`, hidden scrollbar, edge fade via `mask-image: linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 24px), transparent)`. Arrows scroll by 70% of visible width, smooth.
- Card: fixed 186px, radius 12, --bg-elev + 1px --line; photo 112px; **rank chip** top-left (`#1 · 12×/mo`, mono 9.5px 600, blurred pill: bg page@72% + blur 6px + hairline border); body: name 12px 500 2-line clamp (min-height 31px), footer row = availability (5px dot + mono 10px) + **28px round add button** (hairline border, hover inverts to --ink fill/--bg icon) which becomes a mini stepper once qty > 0.
- Hover: translateY(-2px), --line-strong border, card shadow. In-cart: accent@70% border.

### Product card (grid view)
- Radius 12, --bg-elev, 1px --line, overflow hidden.
- **Hover: translateY(-2px), border --line-strong, shadow, photo scales 1.045** (transform 400ms cubic-bezier(.2,.8,.2,1)).
- **Photo**: aspect 4:3, `object-fit: cover`, bottom hairline --line-2; subtle inner vignette `inset 0 -18px 24px -18px rgba(0,0,0,0.35)`. Items without a photo: diagonal-stripe placeholder (repeating 135° hairlines of --line over --bg-sunk) + 2-letter initials in Instrument Serif 44px --ink-5.
- **Availability pill** (bottom-left of photo, 8px inset): glassy pill — bg page@74% + blur 8px + hairline border; mono 10.5px; 6px glowing dot. Variants: in stock = accent dot + "107 avail"; low = amber dot/text + "Low · 8 left"; out = red dot/text + "Out of stock".
- **Quick view button** (top-right of photo): 30×30, radius 9, same glass treatment, eye icon; hidden (opacity 0, translateY(-3px)) until card hover, 160ms.
- Body: padding 12/13/13, gap 7. Name: Inter Tight 13.5px 500, line-height 1.32, 2-line clamp, min-height 35px. Meta: mono 10.5px --ink-4, `SKU · Category` (dot separator --ink-5).
- **Add button**: full-width, height 33, radius 9, transparent with 1px --line-strong border, 12.5px 550 --ink, plus icon; **hover inverts: --ink fill, --bg text**; active scale(0.985).
- **In-cart stepper** (replaces Add): full-width grid `33px / 1fr / 33px`, height 33, radius 9, fill accent@14%, border accent@55%; center = mono 12px 600 qty + tiny "IN CART" label (9px, --ink-3, ls 0.08em); −/+ buttons hover accent@22%; + disabled at stock cap. Card also gets accent@65% border.
- **Out of stock**: photo `grayscale(0.85) brightness(0.72)`; button disabled, dashed border, --ink-4 text "Out of stock".

### Compact (list) view
- One card container (radius 12) of rows: grid `46px / 1fr / 150px / 118px / 128px`, gap 14, padding 9×14, divider --line-2. Thumb 46px radius 9 (click = quick view); name 13px 500 single-line ellipsis + SKU mono 10.5px; category 11.5px --ink-3 (hidden <1100px); availability dot+text; same Add/stepper at 128px.
- Row hover: --bg-sunk@55%. Out-of-stock row at 62% opacity.

### Category sections (default "All" browsing)
- Section head: collapse chevron (rotates -90° when closed), icon + name (17px Inter Tight 500), mono count, bottom hairline, "View all N →" link. New Hire section has an **"Add full kit"** pill button (accent@10% fill, accent@45% border, height 28) adding 1 of each in-stock item.
- Each section shows one grid row (= column count) of items; "View all" switches to that category pill.
- When a category/search/filter is active: flat grid with a result line ("All products / 24 items").

### Order Cart (sticky right rail, 372px)
- Sticky `top: topbar + 20px`, `max-height: calc(100vh - topbar - 40px)`; panel radius 14, --bg-elev, 1px --line; column flex — list scrolls internally.
- **Header**: cart icon + "Order Cart" (14.5px Inter Tight 550) + **unit-count badge** (20px accent pill, mono 10.5 600 --on-accent; gray bordered pill when 0; scale-pulse 1→1.25→1 over 300ms whenever count changes) + "Clear all" (11.5px, hover red).
- **Context strip**: sub-bar (bg-sunk@45%, hairline below) of small chips: warehouse id (`DC4`), method (`Pickup · will-call` or site name), requester (`For you`). 11px, radius 999, --bg-elev + --line border.
- **Empty state**: centered 72px dashed-border ring with radial accent tint + cart icon; "Your cart is empty" (14px Inter Tight 500); helper copy 12px --ink-4; "START WITH YOUR USUALS" micro-label + 3 one-tap suggestion rows (top frequent items; full-width bordered rows, radius 9, name + right plus icon).
- **Line item**: grid `44px / 1fr / auto`, padding 11×16, --line-2 dividers; entrance animation fade + translateX(6px→0) 220ms. Thumb 44px radius 9. Name 12.5px 500 2-line clamp + SKU mono 10px. Right column: trash icon (20px, opacity 0 until row hover, hover = red + red-wash bg) above **mini stepper** (height 26, radius 999, same accent scheme as card stepper).
- **Stock warning** (spans under name when qty caps out): amber box — 11px amber text, amber@10% fill, amber@30% border, radius 7, warn triangle icon, e.g. "All 22 available are in your cart" / "Only 5 in stock — reduce quantity".
- **Manager notes**: collapsible section above footer (hairline top). Header row: pencil icon + "Manager notes" + "Optional" (10.5px --ink-4) + chevron (rotates 180° open); green 6px dot shown when collapsed with content. Open: textarea min-height 68, radius 9, --bg fill, focus border accent@55%; placeholder "Anything the approving manager should know — deadlines, event, room number…".
- **Footer** (bg-sunk@40%, hairline top): rows "Line items / N" and "Total units / N" (12.5px --ink-3 labels, mono values); **Submit button**: full-width, height 42, radius 11, --accent fill, --on-accent 13.5px 650, trailing chevron, inset top highlight + accent glow shadow; hover brightness(1.06) + translateY(-1px). **Disabled when cart empty**: --bg-sunk fill, --ink-4 text, 1px --line border, no shadow. Fine print below: "A manager will review and approve before stock is reserved." (11px, centered).

### Quick view drawer
- Right-side drawer, 430px, existing drawer pattern (slide-in 220ms). Header: category eyebrow + item name; body: 4:3 photo (radius 12), **2×2 spec grid** (1px --line-2 gaps; cells: 10px uppercase key + mono 12.5px value — SKU, Bin location, Available, Status), description paragraph 13px --ink-3; footer: same Add/stepper control full-width.

### Review modal
- Backdrop `rgba(4,5,4,0.6)` + blur(4px). Card: 720px max, radius 16, 1px --line-strong, pop shadow, scale/translate entrance 200ms.
- Header: clipboard icon, "Review order request" (17px) + "Check the details — your manager sees exactly this." (12px --ink-4), × button.
- Body: **4-cell summary grid** (Warehouse / Method / Deliver to / Requested for; 1px gap grid on --line-2, cells --bg, 10px uppercase keys + 12.5px 500 values); item lines (36px thumb, name+SKU, mono `× qty`); notes echoed in a dashed-border box if present.
- Footer (bg-sunk@40%): "N line items · N units" left; "Keep browsing" ghost button (height 36, radius 9, --line-strong border); **"✓ Confirm & submit"** accent button (height 36, radius 9).
- **Success state** (replaces modal content): 68px circle (accent@15% fill, accent@50% border, accent check 30px) with springy scale-in 400ms cubic-bezier(.2,.9,.3,1.4); "Order request submitted" (20px Inter Tight); mono reference "SO-2661 · DC4 · 7 units"; explainer paragraph; "View order" ghost + "Done" accent (Done clears cart + notes, closes).

### Loading state
- Skeleton cards matching grid: photo block + 2 text bars + button bar; shimmer = translating linear-gradient highlight, 1.5s loop. Show while catalog data fetches.

## Interactions & Behavior
- Add/increment **capped at available stock** (+ disabled at cap, warning shown in cart).
- Quantity steppers everywhere operate on the same cart state (card, carousel, cart, quick view stay in sync).
- Cart, notes, and setup selections **persist** (prototype uses localStorage; production should use draft-order persistence or equivalent).
- Category pill click toggles; search + availability filters compose; "Clear all" resets.
- Sticky toolbar + sticky cart rail; below 1280px the layout stacks and a **floating cart FAB** (46px accent pill, bottom-right, "Cart · N") appears when cart non-empty and scrolls to the cart.
- All transitions 120–200ms except photo zoom (400ms) and entrance animations noted above. Easing: `cubic-bezier(.2,.8,.2,1)`.

## State Management
```ts
cart: Record<sku, qty>                     // capped at item.stock
notes: string
setup: { warehouseId; personId; method: 'pickup'|'delivery'; siteId }
catalog: { category; search; availability: Set<'ok'|'low'|'out'>; sort; view: 'grid'|'compact' }
reviewStage: null | 'review' | 'done'
flowStage (derived): submitted ? 'submit' : reviewOpen ? 'review' : cartCount ? 'cart' : 'browse'
status (derived per item): stock === 0 ? 'out' : stock <= lowThreshold ? 'low' : 'ok'
```

## Responsive
- ≥1280px: two columns (fluid + 372px sticky rail).
- <1280px: single column; cart below catalog; cart FAB appears.
- <1100px: compact view hides category column.
- Grid columns: 4 default (user-selectable 3/4/5 in prototype; production can auto-fit `minmax(220px, 1fr)`).
- Category pills + carousel scroll horizontally at any width.

## Tailwind mapping notes
- Register the token colors + the three fonts in `tailwind.config`; keep values as CSS variables so dark/light theming works.
- Frequent utilities you'll need arbitrary values for: `rounded-[9px]/[11px]/[12px]/[14px]`, `h-[33px]/[40px]/[42px]`, `tracking-[-0.025em]`, `backdrop-blur-[12px]`, mask-image (use a small CSS utility class), `aspect-[4/3]`.
- Color-mix effects (accent@14% etc.) → `color-mix(in oklab, var(--accent) 14%, transparent)` via CSS vars or Tailwind alpha syntax with an rgb fallback of the accent.

## Assets
- `design/products/*.png` — real product photos cropped from the production app screenshot (planner, mousepad, backpack, mug, polo-m, polo-w, bottle, towel, fan, sanitizer). Production should use the real item image URLs; these are for parity testing.
- Icons: 24×24 hairline strokes (stroke-width 1.5, round caps/joins), lucide-style. All paths are in `design/storefront-shell.jsx` — or use `lucide-react` equivalents (search, filter, arrow-up-down, eye, layout-grid, list, plus, minus, trash-2, shopping-cart, sparkles, package, truck, map, users, pencil-line, check, chevrons, alert-triangle).
- Serif placeholder font: Instrument Serif (Google Fonts).

## Files
- `design/StockPilot Storefront - Place an Order.html` — entry point (open in browser)
- `design/storefront.css` — all component styles (authoritative for exact values)
- `design/styles.css` — tokens + app shell
- `design/storefront-page.jsx` — page assembly, state, filtering
- `design/storefront-components.jsx` — cards, carousel, cart, modal, drawer, skeletons
- `design/storefront-shell.jsx` — sidebar/topbar/icons
- `design/storefront-data.js` — sample catalog shape (`{sku, name, cat, stock, low, img, loc, freq, desc}`)
- `design/tweaks-panel.jsx` — prototype-only design-review controls; **do not implement**

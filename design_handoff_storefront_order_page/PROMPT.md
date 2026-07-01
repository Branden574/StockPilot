# Paste this into Claude Code (or Copilot Chat) from your stock-pilot-web repo

---

Implement the redesigned "Place an Order" page from the design handoff folder at `design_handoff_storefront_order_page/`.

Start by reading `design_handoff_storefront_order_page/README.md` in full — it is the spec. Then open the reference implementation in `design_handoff_storefront_order_page/design/` (`storefront.css` and `storefront-components.jsx` contain the exact values and markup structure) and use it as the source of truth for every visual detail: button shapes, radii, heights, colors, hover states, shadows, spacing, and typography.

Requirements:
1. Replace the UI of `/dashboard/orders/new` with this design. Keep the existing app shell (sidebar, topbar, breadcrumbs) untouched, and keep all existing functionality and API contracts — same order submission, same data. This is a frontend reorganization, not a backend change.
2. Match the design EXACTLY (it is high-fidelity): the setup bar with the Pickup/Delivery segmented control, the flow indicator (Browse → Cart → Review → Submit), the sticky catalog toolbar with search/availability/sort/view toggle and category pills, the "Frequently ordered" carousel with rank chips, the product cards (4:3 photo, glassy availability pill, hover lift + photo zoom, quick-view eye button, full-width Add button that becomes an accent quantity stepper), the compact list view, the sticky Order Cart (empty state with suggestions, line items with steppers + stock warnings, collapsible Manager notes, disabled-when-empty Submit Order Request button), the review modal, and the submit success state.
3. Wire it to our real catalog, stock levels, warehouses, sites, and people — the `storefront-data.js` file only shows the expected data shape. Enforce the stock cap on quantity steppers and show the amber warning when a line hits available stock.
4. Use our existing stack conventions (Next.js app router, Tailwind, our component library). Register the design tokens from the README as CSS variables / Tailwind theme values rather than hard-coding hex values inline.
5. Implement all states: loading skeletons, empty search results, empty cart, low stock, out of stock, in-cart, disabled submit, review, and success.
6. Responsive: two columns ≥1280px with the sticky cart rail; stacked below 1280px with the floating "Cart · N" pill; compact view drops the category column <1100px.
7. Do NOT implement `design/tweaks-panel.jsx` — it's a prototype-review tool. Ship with: grid view default, 4 columns, grouped-by-category browsing, green accent, dark theme.

Work through it screen-region by screen-region, and after each region compare against the running prototype (`design/StockPilot Storefront - Place an Order.html` opened in a browser) to confirm pixel parity before moving on.

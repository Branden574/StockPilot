# Interactive dashboard value chart — real Compare + location filter + basis toggle

Owner report: the overview "Inventory value · 30 days" card's `+ Compare` (and the `All locations` / `Cost basis` chips) are non-functional decorative `<span>`s (widgets/shared.tsx CardHead). BigChart is single-series SVG. Owner wants ALL of it real: Compare with options (previous period / locations / cost vs retail), plus a working location filter and cost/retail basis toggle.

## Design
Convert `ValueChartWidget` (currently a static server component) into an interactive client card. Default view unchanged (cost, 30d, all locations) and still SSR'd from the page's existing `valueSeries` — NO extra work on initial dashboard load (dashboard perf is a do-not-regress: reference_dashboard_load_perf). Comparison/filter series fetch ON DEMAND via a lightweight endpoint when the user interacts.

## Global constraints
- Migration to prod via `supabase db push --linked` after merge (assistant). pgTAP for the RPC change; local `supabase db reset` after new migs.
- Do NOT regress initial dashboard load: only the default series loads eagerly; everything else is on-demand + client-cached per session.
- Manager+ RLS on org-wide series unchanged (dashboard_history_series stays SECURITY INVOKER, user client). Warehouse-filtered = reconstructed path (existing behavior).
- Web-only (dashboard overview is web). NO Claude/Anthropic co-author trailer. Verify live in Demo Co.
- Retail history is APPROXIMATE (retail_price held constant across past days — same method cost uses on fallback days); label the retail line/tooltip so it's not mistaken for observed.

### Unit A — Data layer + migration + on-demand endpoint
- Migration `supabase/migrations/0275_dashboard_value_series_retail.sql`: extend the value-history RPC to also return a retail series. Either add `inventory_retail_value` to `dashboard_history_series` output, OR add a sibling `dashboard_value_series(p_org, p_warehouse, p_days, p_basis text)` that returns `day_index, value` computed via the RECONSTRUCTED math (retail_price × qty for basis='retail', unit_cost × qty for 'cost') — pick the smaller-diff option; do NOT touch org_daily_stats snapshots (retail via reconstructed path only, acceptable per the approximation note). Keep SECURITY INVOKER + caller RLS. pgTAP: retail series returns non-null for a seeded item with retail_price; cost path unchanged; org-scoped.
- Loader `getDashboardValueComparison({ ctx, warehouseId, days, basis, mode })` in movements.ts returning the series the card needs: `previous` (fetch days*2 window, split older/newer), `byLocation` (one series per warehouse — list warehouses then N RPC calls, capped), `retailVsCost` (both bases same window). Reuse getDashboardHistory + the new retail path.
- On-demand endpoint `GET /api/dashboard/value-series?mode=&basis=&days=&warehouseId=` (withContext/session auth, manager+ gate matching the dashboard, org-scoped) returning JSON series. checkRateLimit. Tests: auth, org-scope, each mode shape.

### Unit B — BigChart multi-series + legend
- Extend `apps/web/src/components/dashboard/big-chart.tsx` to accept `series: Array<{ label, color, data }>` (keep the existing single `data` prop as back-compat / a one-series convenience). Render N paths with distinct accent colors, a small legend, and shared x/y scaling across series (comparison lines must share the y-axis). Keep the no-external-lib SVG approach. Unit tests for scaling with 2+ series + empty/short-series guards.

### Unit C — Interactive ValueChart card
- `apps/web/src/components/dashboard/widgets/value-chart.tsx` → client island (or a client child with the SSR default series as initial state). Controls:
  - **Location filter**: "All locations" → dropdown of warehouses (reuse an existing warehouse-list source) → refetch on change.
  - **Basis toggle**: Cost / Retail → refetch.
  - **Compare menu** (the `+ Compare` chip → a real menu/popover): options Previous period / Locations / Cost vs Retail → fetches via the endpoint and overlays via BigChart multi-series; a legend + a way to clear the comparison. Retail lines labeled "(approx.)".
  - Loading + error states; client-cache fetched series for the session so re-toggling is instant.
  - CardHead `chips` become interactive controls (or move to an `action` slot) — the static chips array goes away for this card.
- Tests: control interactions (mock the endpoint), the compare menu overlays a second series, basis/location refetch, graceful error.

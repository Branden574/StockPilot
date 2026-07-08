# PO Import — Separate Staged Instances & Charter-Per-Instance (Design Spec)

**Status:** DRAFT for owner review. No migration until approved.
**Date:** 2026-07-08
**Author:** Claude (from a 5-thread root-cause investigation)
**Decision on file:** Owner chose "design doc first" over a rushed migration.

> This spec covers ONLY the architectural piece (bugs #2/#3/#4 — charter, merge,
> separate staging). The three contained fixes (requester on slips, PO-import
> export with taxes, Items-list co-select) ship independently and are not in
> scope here.

---

## 1. What the owner wants (the target behavior)

From the field report, restated as requirements:

- **R1 — Identity by context.** Two rows with the same serial/SKU/name are *different
  inventory records* when they differ in rack, charter, warehouse, staging batch, or
  PO import. Identity is an internal record ID, never the serial/SKU/name.
- **R2 — Charter is honored per import.** If the import's item charter is KVA, the
  resulting record is KVA. An existing same-SKU item under CVW must **not** capture
  it, and must **not** be overwritten either.
- **R3 — No automatic merge.** Importing (and even receiving) a matched line must not
  silently add to an existing item's count. Matching is *informational only*.
- **R4 — Staged first.** Imported units live in an import/staging holding, separate from
  active inventory, until the user *explicitly* moves them into the Items List.
- **R5 — Recordkeeping export keeps taxes/fees** (delivered separately, Tier-1).

## 2. What the system does today (verified by investigation)

| Concern | Current reality | File evidence |
|---|---|---|
| Approve touches stock? | **No.** Creates a PO at `expected_inbound`, `purchase_order_items.quantity_received = 0`. Docstring: "Inventory stock is NOT touched." | `server/services/po-imports.ts:538-691` |
| The "500→600" preview | **Pure client projection**, writes nothing; labeled "when this PO is received". | `components/po-imports/stock-impact-preview.tsx:59-164` |
| When on-hand rises | Only at the **separate receive step** (`post_receipt_v2` → `adjust_stock`), into the matched item. | `migrations/0190`,`0189`; `server/services/receiving.ts:160` |
| "Staging" today | A **location holding on the same item** (`item_stock_levels[item, Staging]`), counted in on-hand. NOT a separate record. | `migrations/0189:41-47` |
| `quantity_on_hand` | A **stored scalar** on `inventory_items`, mutated directly by `adjust_stock`. NOT derived from holdings. | `migrations/0189:35-38` |
| Charter on matched line | Ignored — only newly-*created* items get the picked charter; linked/matched lines keep the existing item's charter. | `server/actions/po-imports.ts:440` (create) vs `:455-467` (link, no charter write) |
| Separate staged-records table | **Does not exist.** Import goes straight to creating/linking `inventory_items`. | (grep: none) |

**The core obstacle:** `quantity_on_hand` is a stored number, not a sum over locations.
Every feature R2–R4 needs is blocked by that one fact, because "staged but not counted"
requires on-hand to *exclude* a bucket — which is impossible while on-hand is a scalar
that `adjust_stock` bumps directly.

## 3. The central design decision: how on-hand is computed

Three ways to give "staged stock that doesn't count until converted." Pick ONE; the rest
of the design follows from it.

### Option A — Add a `staged` holding kind, keep scalar on-hand, DON'T count staged
- Receiving a matched/import line writes an `item_stock_levels` row with `kind='import_staged'`
  and **does not** bump `quantity_on_hand`. A "convert" action moves the staged quantity
  into on-hand (one `adjust_stock(+qty)` at convert time).
- **Pro:** smallest blast radius — on-hand stays a scalar, existing reads unchanged. Staged
  stock is visible (it's a real holding) but excluded from counts because we simply don't
  add it to the scalar until convert.
- **Con:** breaks the current invariant "on-hand == Σ item_stock_levels" during the staged
  window (staged holdings exist but aren't in on-hand). `reverse_receipt` and the staging
  worklist assume that invariant — both need auditing. Two notions of "staging" now exist
  (today's placement-staging vs new import-staging) — must be named distinctly.

### Option B — Separate `po_import_staged_stock` table (fully isolated)
- Import/receive writes staged rows to a NEW table keyed by `(po_import_batch_id,
  po_import_line_id, item_ref, charter_id, warehouse_id, qty)`. `inventory_items` is
  untouched until convert. Convert creates/updates the real item + holding.
- **Pro:** cleanest separation; `inventory_items` accounting is completely unaffected until
  the explicit convert; naturally supports R1 (each staged row is its own instance with its
  own charter) and R2/R3 (no existing item is read or written during import).
- **Con:** most new surface — a table, a convert flow, a staged-stock UI, and staged stock
  is invisible to every existing inventory view unless we add it there. "Receiving" semantics
  fork (receive-into-staged vs receive-into-stock).

### Option C — Per-instance item rows (fold into the parked consolidation)
- Make same-SKU-different-(charter|rack|warehouse) genuinely separate `inventory_items`
  rows; on-hand becomes **derived** = Σ holdings. Import always creates a new instance row
  (matching only *suggests*). Staging is a holding-kind excluded from a derived on-hand.
- **Pro:** satisfies R1–R4 uniformly and resolves the parked per-rack consolidation in the
  same stroke; identity becomes "the row," exactly as the owner asks.
- **Con:** largest change. On-hand becomes derived → **every** `quantity_on_hand` read across
  web + mobile (dashboards, valuation, reorder, forecasting, order-promising, snapshots
  0224-0230, mobile item screen) must move to the derived value. This is the multi-week path.

### Recommendation
**Option A for staging isolation, plus a scoped slice of Option C for identity.** Concretely:
1. **Identity (R1/R2/R3):** change the import match/link decision so that when the chosen
   charter (or rack/warehouse) differs from a matched item, the import **creates a new
   instance** rather than linking — matching stays *informational* ("same SKU exists in
   CVW"). This delivers charter-per-instance without touching on-hand math. It does
   create more item rows (tension with the dedup work) — acceptable because they are
   *legitimately different* records (different charter), which is exactly the owner's rule.
2. **Staging isolation (R4):** Option A — an `import_staged` holding kind that is excluded
   from on-hand until an explicit "Add to Items List / Convert" action. Ships as a second
   phase after identity, because it carries the invariant-audit risk.

This ordering lets us fix the charter/merge complaint (the loudest one) with medium risk
first, and take on the on-hand-isolation change deliberately second.

## 4. Identity & charter (Phase 1 — medium risk)

- The import review "Charter for items" is the source of truth for the imported record's charter.
- Match logic becomes **advisory**: show "Possible existing match — SKU X exists in <charter>
  / <rack>" but never auto-link, auto-select, auto-merge, or inherit charter/rack.
- When the user confirms a line, the decision is one of: **create new instance** (default,
  carrying the chosen charter/warehouse), or **explicitly use an existing item** (opt-in,
  and only then does it link). No silent barcode/ISBN auto-link into an existing item under
  a different charter.
- Plumb the chosen item-charter into BOTH the create-items action AND the approve path so
  parse-time-matched lines are covered (today they bypass the charter picker entirely).
- Selection everywhere keyed on unique IDs (`po_import_lines.id` — already true; item list
  fixed in Tier-1).

## 5. Staging isolation (Phase 2 — higher risk)

- New holding kind `import_staged` (name TBD — must not collide with today's placement
  `staging`). Import/receive routes accepted qty into `import_staged`, **without** bumping
  `quantity_on_hand`.
- **Convert action** ("Add to Items List"): moves qty from `import_staged` → the item's
  active on-hand (an `adjust_stock(+qty)` + place into the chosen rack). Only this step
  changes active counts.
- Audit `reverse_receipt`, `stagedWorklist`, cycle-count-at-staging, valuation, reorder for
  the temporary on-hand ≠ Σholdings window. Decide: does staged stock show as its own line
  on the item ("N awaiting conversion")? (Consistent with the amber "awaiting put-away" work.)
- Mobile: item screen must show staged/import holdings distinctly and not fold them into
  on-hand.

## 6. Migration & rollout plan

- **Phase 0 (done tonight):** Tier-1 contained fixes (requester, export, co-select).
- **Phase 1:** identity/charter (advisory matching + create-new-instance-on-charter-diff +
  charter plumbed to approve). Additive; no on-hand change. pgTAP + the owner's test cases
  1,2,5,6.
- **Phase 2:** staging isolation (`import_staged` kind + convert action + on-hand exclusion),
  gated behind an entitlement/flag so it can roll to one org first. Covers test cases 3,4,7,8.
- Each phase: subagent-driven implementation, adversarial review, live demo-org verification,
  mobile parity, before the next phase starts.

## 7. Test cases (owner-provided, mapped)

| # | Scenario | Expected | Phase |
|---|---|---|---|
| 1 | Two rows, same serial, different racks; select one | Only that row selected | 0 (shipped) |
| 2 | Import for KVA; existing same-serial under CVW | Imported record is KVA; existing untouched | 1 |
| 3 | Import Chromebook when Chromebooks exist | Existing count does NOT rise at import | 0 (already true) + 2 (stays true through receive→staged) |
| 4 | PO with item + tax lines | Tax skipped for creation, included in export | 0 (shipped) |
| 5 | Same SKU, different charters | Each stays separate under its charter | 1 |
| 6 | Select one imported line, act | Only that line changes | 0 (already true) |
| 7 | Complete import into staging | Staged stays separate from active until manual add | 2 |
| 8 | Add staged to items list | Only selected staged added, correct charter/rack | 2 |

## 8. Decisions (owner, 2026-07-08) — ALL per recommendation

1. **On-hand approach → Option A.** Add an `import_staged` holding kind that is excluded
   from the (still-scalar) on-hand until an explicit convert, plus the scoped identity slice
   (create-new-instance when charter differs). NOT the full derived-on-hand rebuild (Option C)
   — revisit only if per-rack independent actioning ever becomes a hard requirement.
2. **Staged stock counts toward VALUE, not availability.** Received-but-unconverted units are
   owned → included in `inventory_value_on_hand`, but excluded from active/available-to-use
   until converted. Phase 2 must value staged stock but keep it out of pickable/on-hand-usable.
3. **Barcode auto-match → KEEP, demoted to a suggestion.** Show "Possible match: SKU exists
   under <charter>"; the user taps to accept. Never auto-link/auto-merge.
4. **Naming → keep "staging"; label the two apart.** Existing = "Staging (put-away)"; new
   import bucket = "Import — awaiting conversion".

**Next step:** turn this spec into a phased, task-by-task build plan (Phase 1 identity/charter,
then Phase 2 staged-isolation) for owner approval BEFORE any migration. No code until that plan
is approved.

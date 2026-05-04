# Purchase Order Ingestion + Receiving System — 5-Phase Overview

> **For agentic workers:** Each phase has its own plan file. Execute phases in order. Phase 1 has full TDD-step detail; Phases 2–5 have architecture-level detail and will be expanded to full TDD when their phase begins.

**Goal:** Replace manual-entry-only POs with an enterprise-grade upload → parse → stage → receive → ledger pipeline that satisfies the Staples-style PDF use case while keeping inventory accuracy invariants.

**Top business invariant:** A PO upload must NEVER increase usable inventory. Stock changes only when a physical receipt is posted through the receiving workflow. Tax/freight/service lines must NEVER touch inventory.

---

## Phase dependency graph

```
                      ┌───────────────┐
                      │ Phase 1       │
                      │ Ingestion     │  ← upload, parse, stage, exception queue
                      └───────┬───────┘
                              │
                              ▼
                      ┌───────────────┐
                      │ Phase 2       │
                      │ Hardened      │  ← receipts table, idempotency, reversal
                      │ Receiving     │
                      └──┬─────────┬──┘
                         │         │
              ┌──────────┘         └──────────┐
              ▼                               ▼
      ┌───────────────┐              ┌───────────────┐
      │ Phase 3       │              │ Phase 4       │
      │ UoM + Lot/    │              │ Reconcile +   │
      │ Serial        │              │ Outbox        │
      └───────┬───────┘              └───────┬───────┘
              │                              │
              └──────────────┬───────────────┘
                             ▼
                     ┌───────────────┐
                     │ Phase 5       │
                     │ Bins + Putaway│
                     └───────────────┘
```

Phases 3 and 4 can run in parallel after Phase 2 ships. Phase 5 needs both.

---

## Per-phase summary

| # | Plan file | Days | New tables | Key user-visible change |
|---|---|---|---|---|
| 1 | `2026-05-04-po-phase-1-ingestion.md` | 4–5 | `po_imports`, `po_import_lines`, `vendor_item_mappings` | Upload Staples PDF → parsed preview → approve → expected inbound PO |
| 2 | `2026-05-04-po-phase-2-hardened-receiving.md` | 3–4 | `receipts`, `receipt_lines`, `idempotency_keys` | Multi-receipt history per PO; reversal flow; cannot double-post |
| 3 | `2026-05-04-po-phase-3-uom-and-tracking.md` | 3–4 | `uom_conversions`, `receipt_line_lots`, `serial_registry` | 1 PK = 24 EA conversion; lot/serial capture at receive time |
| 4 | `2026-05-04-po-phase-4-reconciliation-outbox.md` | 2–3 | `outbox_events`, reconciliation views | Ordered vs received vs invoiced report; over-receipt approvals |
| 5 | `2026-05-04-po-phase-5-bins-putaway.md` | 2–3 | `bins`, `putaway_moves` | Receive-into-bin; QA hold; structured putaway |

---

## Existing infrastructure being reused (DO NOT rebuild)

- `purchase_orders` + `purchase_order_items` tables (extended, not replaced)
- `stock_movements` table (acts as inventory ledger; future-proofed)
- `audit_logs` table + `audit()` service writer
- `inventory_items.warehouse_id` + `inventory_items.charter_id` (M:N enforcement via composite FK to `warehouse_charters`)
- `user_warehouse_assignments` + `user_can_access_inventory(uid, wh, ch, op)` RPC
- Supabase Storage presigned-URL pattern (mirrored from `item-images.ts`)
- Service pattern: `'server-only'` import, zod schemas, `withContext()`, `assertPermission()`, `audit()`, permission tokens from `@stockpilot/core`
- Permission tokens: `purchase_orders:manage`, `stock:adjust`, `stock:transfer`, `items:create`

## Existing infrastructure being deprecated (replaced cleanly)

- `receive_purchase_order(p_po_id, p_lines, p_notes)` RPC — kept available for backward compat through Phase 1; replaced by `ReceivingService.postReceipt()` + idempotency in Phase 2; deleted at end of Phase 2.

---

## Migration numbering

Phases append migrations starting at `0010`:

| Phase | Migration files |
|---|---|
| 1 | `0010_po_imports.sql`, `0011_vendor_item_mappings.sql` |
| 2 | `0012_receipts.sql`, `0013_idempotency.sql` |
| 3 | `0014_uom_conversions.sql`, `0015_lot_serial_tracking.sql` |
| 4 | `0016_outbox.sql`, `0017_reconciliation_views.sql` |
| 5 | `0018_bins.sql`, `0019_putaway.sql` |

After each phase ships:
1. Apply migrations to hosted Supabase
2. Push code
3. Verify `pnpm typecheck && pnpm test && pnpm build`

---

## Cross-phase invariants (apply to every plan)

1. **No raw stock writes.** Every change to `inventory_items.quantity_on_hand` must go through a service method that also writes a `stock_movements` row in the same transaction.
2. **Warehouse scope is server-side.** Never trust `warehouse_id` from request body for staff/viewer roles — always derive from `forcedWarehouseId()` or `assertWarehouseAccess()`.
3. **Audit every state transition.** Add new `AuditEvent` enum members in `apps/web/src/server/services/audit.ts` for every new event before using them.
4. **Charter pairing enforced.** Any new `inventory_items` insert/update goes through the existing composite FK `(warehouse_id, charter_id) → warehouse_charters` (added in migration 0008).
5. **TDD, no exceptions.** Each new logic file gets a corresponding `*.test.ts` file with at least one test case before implementation. Run `pnpm --filter @stockpilot/web test` after each task.
6. **One concept per migration.** Don't bundle unrelated schema changes. The first task of each phase is "write migration, run on local, verify".
7. **Frequent commits.** One commit per task. Conventional commits: `feat`, `fix`, `chore`, `test`, `docs`. Push after each green test run.

---

## "Done" criteria for the whole 5-phase project

- [ ] Uploading PO-CVSII-001824.pdf produces a parsed preview with 12+ inventory lines and 1 TAX line correctly classified
- [ ] Approving the preview creates an `expected_inbound` PO; inventory unchanged
- [ ] Receiving 6 of 10 ordered batteries increases stock by 6, leaves PO `partially_received` with 4 open
- [ ] Posting the same receipt twice (same idempotency key) returns the original receipt; stock unchanged second time
- [ ] Reversing a posted receipt creates a negative ledger entry; stock returns to pre-receipt state
- [ ] Receiving 1 PK of batteries with conversion `1 PK = 24 EA` increases stock by 24 EA
- [ ] Lot-tracked item rejects receipt without a lot number; serial-tracked item rejects duplicate serials
- [ ] Reconciliation report shows ordered/received/open by warehouse, charter, and vendor
- [ ] Warehouse user cannot post a receipt to an unassigned warehouse (returns 403, audited)
- [ ] All 8 audit events new in this project log to `audit_logs` and appear on `/dashboard/admin/audit`

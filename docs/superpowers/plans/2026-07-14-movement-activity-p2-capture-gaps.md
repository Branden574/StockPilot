# Movement/Activity P2 — Fill Capture Gaps

> Execute via superpowers:subagent-driven-development. Base: main @ f57818e8. Branch: feat/movement-activity-p2.

**Goal:** Every inventory mutation writes a rich, attributable record, so the P1 before/after diff drawer + the global audit trail actually have data. No fabrication.

**Architecture:** All fixes are pure TypeScript — **NO migration**. `audit()` (apps/web/src/server/services/audit.ts:280) already accepts first-class `before`/`after` and writes them into `audit_logs.metadata.before/after`, which is exactly what `MetadataDiff.diffMetadataFields` consumes. The capture gaps are missing/empty `audit()` calls at the mutation sites. Emits live in the **service** methods (InventoryService) so they capture web AND mobile-Bearer callers alike; pass `this.ctx` explicitly (Bearer/API callers need it or `withContext()` throws NEXT_REDIRECT and the row silently drops). All emits are best-effort `void audit(...)` (the writer swallows its own errors) so a logging failure can never break a stock mutation.

**Display-duplication rule (load-bearing):** the item **Activity** tab renders the merged movement+audit feed (`ActivityService.forItem`); the **Movements** tab renders `kind==='movement'` only. Adjust/transfer already emit a movement row. So their new `stock.*` audit rows must be **suppressed from the item feed** (`forItem`) — otherwise each adjust/transfer double-shows, regressing P1's crowd-out/double-render fixes. The rows still surface on the **global** audit page (`/dashboard/admin/audit`, `/dashboard/settings/audit`), which query `audit_logs` directly (not `forItem`), giving full attribution there. Item edits have NO movement row, so their audit rows are NOT suppressed — they drive the drawer on the item feed.

## Global Constraints
- NO migration. NO schema change. `audit_logs.metadata->>entity_id` index (0135) already exists.
- Every `audit()` for an item mutation MUST set `entityId = <item id>` or it won't surface in `forItem`/the item drawer.
- `before`/`after` MUST be restricted to the CHANGED columns — never dump heavy/derived columns (embedding, search_vector, tsvector) into jsonb (size/PII).
- Web-only phase (mobile Activity tab is P4). No OTA. But service-level emits DO capture mobile-origin mutations for later.
- NO Claude/Anthropic co-author trailer. Live-verify in Demo Co (org 71b27a4a-7948-4638-bc3f-535974713bd2).

---

### Task 1: Capture emits (write sites)

**Files:** Modify `apps/web/src/server/services/inventory.ts`, `apps/web/src/server/services/serials.ts`, `apps/web/src/server/services/tags.ts`, `apps/web/src/server/actions/item-images.ts` (+ ItemImagesService). Tests alongside.

**1a. `InventoryService.update` (l.~1984)** — keep `extra.changed_keys`; ALSO pass `before`/`after` built from `changedKeys` against the two rows already in scope: `current` (before, l.1811) and `data` (after, l.1896). `before = Object.fromEntries(changedKeys.map(k => [k, current[k]]))`, `after` likewise from `data`. Base ONLY on the target row — do NOT include the Model-B sibling fan-out (l.~1960). Continue excluding `updated_by`.

**1b. `InventoryService.bulkUpdate` (l.~2074/2253) + set_rack branch (l.~2160)** — currently `extra.bulk_op` only. Before the `.update(update)` (l.~2236), batch-read old values: `select('id', <changed cols>).in('id', allowedIds)`. In the per-item audit loop (l.~2256), pass `before={old row cols}`, `after={new update cols}`, `extra:{ bulk_op, changed_keys: Object.keys(update).filter(k=>k!=='updated_by') }`. Same for set_rack (before/after of rack label + `changed_keys`).

**1c. `InventoryService.adjustStock` (l.~2368)** — currently emits NO audit. After the RPC, add `void audit({ event: <mapMovementTypeToEvent(input.movementType)>, entityType:'inventory_item', entityId: input.itemId, warehouseId: wh, before:{ quantity_on_hand: prev }, after:{ quantity_on_hand: next }, reason: input.reason ?? null, extra:{ quantity_change: input.quantityChange, movement_type: input.movementType, location_id } }, this.ctx)`. `prev`/`next` already derived (l.~2428-2429) — derive from the RPC-returned `data` row (correct under concurrency). Map movementType → existing AuditEvent (`stock.adjusted`/`stock.received`/`stock.removed`, all in the union audit.ts:33-36); default `stock.adjusted`.

**1d. `InventoryService.transferStock` (l.~2446)** — emit `void audit({ event:'stock.transferred', entityType:'inventory_item', entityId: input.itemId, before:{ location_id: input.fromLocationId }, after:{ location_id: input.toLocationId }, extra:{ quantity: input.quantity, from_location_id, to_location_id } }, this.ctx)`. (Location NAMES on the global page are nice-to-have; ids acceptable — do not add a query just for names in the service.)

**1e. Visibility fixes (cheap, high-value):**
- `serials.ts` updateSerial (l.~346) + remove (l.~417): these already write good before/after but `entityId = serial_registry id` → invisible in `forItem`. Set `entityId = itemId` (keep serial id in `extra`). add (l.~251): add `before/after` is n/a (creation) — leave, but ensure `entityId=itemId` (already is).
- `tags.ts` bulk apply/remove (l.~316/376): currently one audit row with NO `entityId` (only item_count) → invisible per-item. Emit one audit row per affected item with `entityId=itemId` (or add entity ids). Single-item path (l.~245) already correct.
- `item-images.ts` recordImageAction (l.~56) + removeImageAction (l.~78): currently ZERO capture. Add `void audit({ event:'inventory.item.updated' or a new image event already in the union, entityType:'inventory_item', entityId:itemId, extra:{ image_added|image_removed: true } }, ctx)`. If no image AuditEvent exists in the union, reuse `inventory.item.updated` with `extra.changed_keys:['images']` (no schema change).

**Tests:** unit-test that update/bulkUpdate/adjust/transfer each call `audit()` with `entityId=itemId` and the expected `before`/`after` shape (mock the audit writer); serial/tag/image emits carry `entityId=itemId`.

### Task 2: Suppress movement-shadowing audits on the item feed

**Files:** Modify `apps/web/src/server/services/activity.ts` (`forItem`). Test alongside.

In `forItem`, after fetching audit rows, drop the movement-shadowing `stock.*` events (`stock.adjusted`, `stock.transferred`, `stock.received`, `stock.removed`) from the ITEM feed — the movement row already represents them (P1 renders `prev → after` and `from → to` inline). Keep ALL other audit events (edits, archive, serial, tag, image). Do NOT change the global audit page queries (they read `audit_logs` directly and must still show these). Verify the separate per-kind caps (movementLimit / auditLimit) still hold.

**Tests:** `forItem` returns the movement row (not a duplicate audit) for an adjust/transfer; returns the audit row for an edit; a stock.* audit alone (no movement) is still suppressed on the item feed (acceptable — global page covers it).

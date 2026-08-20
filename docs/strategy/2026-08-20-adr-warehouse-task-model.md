# ADR: Warehouse task model

- **Date:** 2026-08-20
- **Status:** Proposed — no migration written
- **Context:** Warehouse OS expansion, Release A. Follows the gap report audit of
  2026-08-20 (121 tables, 336 migrations, 80 services).
- **Supersedes nothing.** No task/work-queue concept exists today: the audit found
  zero code hits for `warehouse_task`, `WorkQueue`, `taskQueue`.

## Why this exists

Every other capability in the six-feature scope hangs off it. The exception
center is a filtered view of blocked and overdue work; universal scan resolves a
barcode to *the next action*, which is a task; quality hold produces inspection
work; receiving exceptions produce resolution work. Building any of those first
means building a private queue inside each, and then reconciling four of them.

The operational goal is narrow and worth stating plainly: a worker opens
StockPilot and sees what to do next, instead of choosing which page to open.

## Decision 1 — one table, not one per workflow

`warehouse_tasks`, extended by `task_type` plus a polymorphic
`source_type`/`source_id` pointer and a `metadata` jsonb.

The alternative — `putaway_tasks`, `replenishment_tasks`, `count_tasks` — was
rejected because the manager surface the brief describes (unassigned / assigned /
in progress / blocked / completed, filtered by worker and warehouse) is a single
query over a single table, and becomes a five-way UNION the moment the tables
diverge. The audit already found the cost of parallel models: `bins` /
`inventory_stock` / `putaway_moves` are a complete second inventory system with
zero rows.

`source_type`/`source_id` is deliberately NOT a foreign key. A task points at a
receipt, an order, a cycle count, a location or a return, and no single FK can
express that. The trade is a nullable, unenforced pointer; the mitigation is that
every generator sets it from a row it has just read, and the UI degrades to a
plain task when the target is gone.

## Decision 2 — the dedupe key is the whole idempotency story

The brief requires automatic generation without duplicates. The mechanism:

```
dedupe_key            text  not null
```

with a **partial unique index**:

```sql
create unique index warehouse_tasks_open_dedupe_uniq
  on warehouse_tasks (organization_id, dedupe_key)
  where status in ('unassigned','assigned','in_progress','blocked');
```

Only one OPEN task per key. A completed or cancelled task does not block a new
one — "replenish rack 14-B" must be creatable again next week, and must not be
creatable twice while the first is still open. Generation is then an
`insert … on conflict do nothing`, which is safe to call from anywhere, any
number of times.

This mirrors `po_imports_org_sha_uniq` (migrations 0286/0287), the pattern this
codebase already uses for exactly-once ingestion. Note the lesson from that
work: the predecessor must be stamped closed BEFORE the successor inserts, or
the insert 23505s. Generators here close by status transition, not by delete.

Key shape is generator-owned and stable, e.g.
`putaway:receipt:<receipt_id>`, `replenish:<location_id>:<item_id>`.

## Decision 3 — explicit service-layer generation, no event bus

`outbox_events` exists and is live (36 rows) but it is the INTEGRATION dispatch
path — external endpoint delivery. Routing internal task creation through it
would couple warehouse work to an outbound-webhook lifecycle and make failures
silent.

Generation is instead an explicit call at the point the operational fact becomes
true — `ReceivingService.post()` creates the put-away task in the same
transaction as the receipt. The brief permits this explicitly ("simple explicit
service-layer hooks may be safer"), and the dedupe key means a retry, a double
submit or a replay cannot double-create.

## Decision 4 — claiming reuses the cycle-count lock, verbatim

Two workers claiming the same task is the defining race. This was already solved
once in this codebase and hardened after a confirmed takeover exploit: migration
`0282_cycle_count_assignment_lock`.

That shape is adopted unchanged:

```
select … into v from warehouse_tasks where id = p_id for update;   -- row lock
  not found            → P0002
  no permission        → 42501
  wrong status         → P0001 invalid_status_transition
  already someone's    → 42501
update …
```

Three RPCs, matching `assign_cycle_count` / `release_cycle_count` /
`force_reassign_cycle_count`:

- `claim_warehouse_task(task_id)` — unassigned → assigned, to the caller
- `release_warehouse_task(task_id, reason)` — reason REQUIRED, as with counts
- `force_reassign_warehouse_task(task_id, user_id)` — manager override, audited

`for update` is what makes the race safe: the second claimant serialises behind
the first and then fails the status guard. Application-level checks alone do not
survive two phones scanning the same rack label.

## Decision 5 — status machine, guarded in the database

```
unassigned ──claim──▶ assigned ──start──▶ in_progress ──complete──▶ completed
     │                    │                    │
     │                    ├──release──▶ unassigned
     │                    │                    │
     └──cancel───────────┴──block──▶ blocked ──unblock──▶ in_progress
                                          └──cancel──▶ cancelled
```

Terminal: `completed`, `cancelled`. Neither reopens — a re-done task is a new
task, so history stays honest and the dedupe index stays correct.

`blocked` requires `blocked_reason`, enforced by CHECK, not by the form. The
2026-07-23 write-off is the standing lesson on reasons that are optional in the
database and mandatory only in one UI.

## Proposed schema

| Column | Type | Why |
|---|---|---|
| `id` | uuid pk | |
| `organization_id` | uuid not null | Tenancy. RLS anchor. |
| `warehouse_id` | uuid not null | Work is physical. Drives operator scoping. |
| `task_type` | text not null, CHECK | receiving, putaway, replenishment, pick, pack, count, transfer, return_inspection, quality_inspection, exception |
| `status` | text not null default `unassigned`, CHECK | See machine above |
| `priority` | text not null default `normal`, CHECK | critical, high, normal, low |
| `source_type` | text null | receipt, order_request, cycle_count, location, return |
| `source_id` | uuid null | Deliberately not an FK — see Decision 1 |
| `assigned_user_id` | uuid null | Null iff status = unassigned |
| `dedupe_key` | text not null | Decision 2 |
| `due_at` | timestamptz null | Feeds SLA later; `order_requests.needed_by` already exists |
| `blocked_reason` | text null | CHECK: non-null iff status = blocked |
| `created_at` / `started_at` / `completed_at` | timestamptz | Cycle-time analytics without a second table |
| `created_by` / `completed_by` | uuid null | |
| `metadata` | jsonb not null default `{}` | Per-type payload. NOT a place for business rules. |

### Indexes

| Index | Purpose |
|---|---|
| `(organization_id, dedupe_key) WHERE status in (open states)` UNIQUE | Idempotent generation |
| `(organization_id, warehouse_id, status, priority, created_at)` | The worker queue and the manager board — the only two hot reads |
| `(assigned_user_id) WHERE status in ('assigned','in_progress')` partial | "My work", the most frequent query on mobile |
| `(organization_id, source_type, source_id)` | "What work exists for this PO/order" |

No index on `task_type` alone: it is low-cardinality and always paired with
status in practice.

### RLS

Org-scoped like every other table, plus warehouse access. Operators see only
warehouses in their assignment (`user_warehouse_assignments`); managers with
multi-warehouse access get the aggregate. The audit's standing warning applies —
`getWarehouseAccess` needs `ctx.supabase` on the Bearer path, or the mobile
route silently sees nothing.

### Permissions

Following `resource:verb`:

- `tasks:read` — see the queue. Auditor-grantable.
- `tasks:work` — claim, start, block, complete **your own**.
- `tasks:assign` — assign to others, force-reassign, cancel. Manager+.

**Landmine:** adding permissions requires bumping the pgTAP count in migration
`0207`, or the DB test suite fails on an unrelated assertion.

### Audit

Assignment, force-reassignment, block, cancel and manager override are audited.
Claim/start/complete by the assignee are NOT — they are the normal loop, and
auditing them turns the audit log into a telemetry stream. Cycle time is already
captured by the three timestamps.

## Scope of v1

Ships: the table, the state machine, the three claim RPCs, `tasks:*`
permissions, the web manager board, the mobile "My work" list, and **one
generator** — put-away on receipt post.

Does not ship: replenishment generation (not in the six-feature scope; needs
pick-face roles on `locations`), SLA-driven priority (needs the SLA slice), and
automatic priority escalation. Priority is set by the generator and editable by a
manager.

## Risks

1. **A task table that fills with noise nobody clears.** Mitigation: exactly one
   generator in v1, and a completed-today count on the board so dormancy is
   visible immediately rather than in a year. If the queue is ignored for two
   weeks, that is data, and the next generator should not ship.
2. **Tasks disagreeing with the thing they point at** — a put-away task open for
   a receipt already put away. Mitigation: generators close by status transition
   at the same service call that changes the source.
3. **Over-modelling.** `metadata` is a display payload. Any business rule that
   reads it is a signal the type deserves a column.

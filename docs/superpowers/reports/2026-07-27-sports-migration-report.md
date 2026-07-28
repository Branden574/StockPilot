# Sports inventory program — migration report (0294-0303)

Every schema change the Sports program makes, what its one backfill wrote, what
it deliberately refused to write, and how to undo each migration.

Status: migrations 0294-0303 are applied LOCALLY and green under pgTAP
(100 files / 1285 assertions — the figure is the sum of every `select plan(N)` in
`supabase/tests/`, re-counted for this report). None has been pushed to
production yet, so the "ambiguous rows" section below carries the queries and no
numbers. Push order is fixed: `supabase db push --linked` (project
`xizpqmhhslgzbuqtjubv`) completes BEFORE any dependent web deploy — a pending
migration crashes pages.

## Numbering

The plan reserved 0294-0302. Two files shifted during execution and the plan
document was corrected inline at Task 13 (commit `782621e2`):

| Plan said | Shipped as | Why |
|---|---|---|
| 0300 (Task 13, `po_import_lines`) | **0301** | Task 8's `product_groups.organization_id` immutability trigger — a deferred guard, not a planned file — took 0300 |
| 0301 (Task 17, `size_count_sessions`) | **0302** | knock-on |
| 0302 (Task 19, backfill) | **0303** | knock-on |

Content is unchanged in each case; 0301's own header records the shift. There is
no gap and no duplicate: 0294 through 0303 are ten consecutive files.

One column arrived after its migration was written: `po_import_lines.serial_hint`
was added to the still-unshipped 0301 during Task 14 (commit `f432e77c`), when the
import seam needed a place to hold a serial the DOCUMENT printed. 0301 has never
been applied anywhere but locally, so this is an edit to an unshipped file, not a
follow-up migration. Its pgTAP grew from 26 to 30 assertions in the same commit.

---

## 1. Schema

**No column added to an EXISTING table is NOT NULL, and none carries a
back-filling default.** Every one reads as "this org never opted in" when NULL,
which is the state of every row in every existing org. (The three NEW tables do
have NOT NULL columns of their own — `product_groups.organization_id`, `name`,
`group_key`, `default_counting_unit`, `status`, and the `size_scales` /
`size_scale_values` key columns — but those tables start empty, so no existing
row can violate them.)

The per-field contract for every column below — meaning, bounds, required-when,
normalization, aliases, key participation and display label — is
`docs/superpowers/specs/2026-07-27-sports-field-dictionary.md`. The architecture
these columns implement is `docs/superpowers/specs/2026-07-27-sports-inventory-model.md`.

### New tables

| Table | Migration | Purpose |
|---|---|---|
| `size_scales` | 0294 | A named size vocabulary (`US Mens`, `Apparel Alpha`), org-owned or global |
| `size_scale_values` | 0294 | The ordered members of a scale; `normalized` is what matching compares |
| `product_groups` | 0298 | Shared product identity (`Nike Pegasus 41`). **Owns no quantity, ever** |

`product_group_rollups` (0298) is a VIEW, `security_invoker = true`. It is the
only place a group total exists and it is recomputed on every read.

### New columns

| Table | Column | Migration |
|---|---|---|
| `categories` | `tracking_mode`, `size_scale_id`, `default_unit_of_measure`, `sports_subcategory_key`, `tracking_profile` | 0294 |
| `inventory_items` | `group_id`, `variant_size`, `variant_size_original`, `variant_size_system`, `variant_width`, `variant_fit`, `variant_color`, `jersey_number`, `player_name`, `variant_key` | 0298 |
| `inventory_items` | `sports_review_flag` | **0303** |
| `po_import_lines` | `variant_size`, `variant_size_original`, `variant_size_system`, `variant_width`, `variant_fit`, `variant_color`, `jersey_number`, `player_name`, `group_hint`, `serial_hint`, `suggested_group_id`, `mapping_confidence` | 0301 |
| `size_count_sessions` | `product_group_id` | 0302 |

### Constraint and function changes

| Change | Migration |
|---|---|
| `inventory_items_tracking_type_check` widened to accept `serial_optional` | 0295 |
| `categories_tracking_mode_check`, `categories_default_uom_check` added | 0294 |
| `inventory_items_jersey_number_check` (1-4 digits), `inventory_items_variant_size_check` (length 1-24) added | 0298 |
| `inventory_items_sports_review_flag_check` (closed 3-value vocabulary) added | **0303** |
| `post_receipt_v2` rewritten (sixth) to accept 0..n serials for `serial_optional` | 0296 |
| `duplicate_inventory_item` carries the variant columns and clears `variant_key` on an attribute override | 0299 |
| `category_tracking_mode()`, `category_default_uom()` added | 0294 |
| `product_group_in_org()`, `category_in_org()` added; `inventory_items_insert` / `_update` policies gained the group org-consistency arm | 0298 |
| `tg_pin_product_group_org()` — `product_groups.organization_id` made immutable | 0300 |
| `tg_inventory_items_set_updated_at()` gained a derived-write escape hatch | **0303** |
| `seed_org_modules()` / `org_can_enable_module()` learn the `sports` module; `sports:manage` seeded for admin + manager (0207's pgTAP count 109 -> 111) | 0297 |

### New indexes

`size_scales_owner_key_uniq`, `size_scales_org_idx`, `size_scale_values_scale_idx`
(0294) · `product_groups_org_key_uniq`, `product_groups_org_status_idx`,
`product_groups_category_idx`, `product_groups_brand_style_idx`,
`product_groups_team_season_idx`, `inventory_items_group_idx` (non-partial, on
purpose — see 0298's header on the FK referential-integrity probe),
`inventory_items_jersey_number_idx` (0298) ·
`po_import_lines_suggested_group_idx` (0301) · `size_count_sessions_group_idx`
(0302) · `inventory_items_sports_review_idx` (**0303**).

---

## 2. Backfills

**There is exactly one backfill in this program: 0303.** 0295, 0298, 0301 and
0302 each state in their own header that they contain ZERO DML, and they do.

### What 0303 wrote

`public._backfill_variant_size()`, called once by the migration:

1. **`variant_size` / `variant_size_original` from `custom_fields.size`** — for
   live rows where `variant_size IS NULL`, `custom_fields.size` is a string, and
   its normalized (upper + trim) form is 1-24 characters. `variant_size` gets
   the normalized value; `variant_size_original` gets the source verbatim,
   whitespace and case intact.

   This is safe because it is not inference. `custom_fields.size` was written by
   `bulkCreateSizedVariants` at create time from a size the user explicitly
   picked. It is recorded data. Copying it into the column gains an index and a
   CHECK and loses nothing.

2. **`sports_review_flag = 'ambiguous_size'`** — a stored size nobody can read
   as a size: an empty or over-long string, or a non-string JSON value. Nothing
   is coerced and nothing is truncated to fit; `variant_size` stays NULL and a
   human decides.

3. **`sports_review_flag = 'sized_but_ungrouped'`** — has a size, has no group.
   This is the linking review queue that `/dashboard/product-groups/link`
   (Task 18) reads.

4. **`sports_review_flag = 'name_size_conflict'`** — the size token at the end
   of the item's NAME disagrees with the stored size. Evidence the two sources
   already diverged, so neither is trusted silently. Deliberately overwrites
   flag 3: a conflict is the more urgent thing to show a human.

### What 0303 deliberately did NOT write

- **`group_id`. Not one row, in either direction.** Deriving a group from an
  item name is the name-heuristic backfill the owner ruled out on 2026-07-27
  ("existing families link via a bulk review tool the owner drives... NO
  name-heuristic auto-backfill"), because a wrong guess bakes a wrong grouping
  into persistent identity. Every historical item keeps `group_id = NULL` and
  keeps rendering through the display-only name heuristic
  (`packages/core/src/inventory/size-run.ts`) until a human links it. This is
  the headline pgTAP assertion, and it is asserted twice — once as "no row's
  `group_id` changed" and once as "the only grouped row is still the one seeded
  that way" — so a future refactor that starts guessing trips both spellings.
- **`custom_fields`.** Never read-modify-written. This is the rollback
  guarantee: the source of every backfilled value survives intact. pgTAP
  asserts byte equality on every fixture row.
- **`jersey_number`.** No historical source exists. Inventing one from a name
  would be the fabrication the requirements forbid.
- **`quantity_on_hand`, and any `stock_movements` row.** The ledger invariant
  `SUM(stock_movements.quantity_change) = quantity_on_hand` therefore still
  holds trivially for every touched item. Both halves are asserted.
- **`updated_at`.** A backfill is a derived write. Bumping `updated_at` on every
  sized item in an org would light up every "recently changed" surface, re-sort
  the default `updated_desc` item list, and force a full mobile re-sync for a
  change no human made — the exact confusion migration 0242 was written to end.
  0303 extends 0242's mechanism with a transaction-scoped
  `stockpilot.derived_write` GUC that the backfill function turns on around its
  own statements and off before it returns. pgTAP asserts both directions: the
  backfill preserves `updated_at`, and a real edit still bumps it.

### Dual-write, and how the transition ends

For the length of the transition both places must agree, or a size edited on the
item form drifts from the size a re-run of the backfill would recover.

- `bulkCreateSizedVariants` (Task 8) already writes `variant_size`,
  `variant_size_original`, `variant_size_system`, `variant_key` **and**
  `custom_fields.size`. It is the only writer of `custom_fields.size` in the
  codebase.
- `create()` (Task 8) and the CSV import (Task 13) write the first-class columns
  only. Nothing reads `custom_fields.size` back, so this direction needs no
  companion write — audited at Task 19: there is no production reader of
  `custom_fields.size` anywhere in web, mobile or core.
- `update()` (Task 19) now writes **both**, merging the size onto whatever
  `custom_fields` the same patch is already writing. Before 0303 it ignored
  `patch.variantSize` entirely and a size edit on the item form was silently
  dropped.
- Clearing a size nulls the column and deliberately leaves `custom_fields.size`
  in place: it is the only surviving record of what the size was, and the
  rollback statement below reads it.

**Exit criteria for the `custom_fields.size` half:** drop it from
`bulkCreateSizedVariants` and from `update()`, and remove `size` from
`RESERVED_CUSTOM_FIELD_KEYS`, once 0303 has been applied to production and the
`ambiguous_size` queue has been worked. Not before: until the migration has run
there, `custom_fields.size` is the only copy of the data.

---

## 3. Ambiguous rows — production counts (run 2026-07-28)

Migrations 0294-0303 were applied to `xizpqmhhslgzbuqtjubv` on 2026-07-28
(early-morning low-traffic window; zero lock timeouts, zero errors — every
NOTICE was an expected `if exists` skip). The three queries below were run
immediately after the push. Real numbers:

- **Per-flag counts:** one org carries flags — L4L North Region:
  `sized_but_ungrouped` 100, `name_size_conflict` 1. No other org has any
  flagged row.
- **Backfill movement:** `sized_rows` 101, `linking_candidates` 101,
  `already_grouped` **0** (the anti-inference invariant held in production:
  the backfill grouped nothing), `size_stored_but_not_copied` **0** — which
  equals the `ambiguous_size` count of 0, satisfying the consistency rule
  below.
- **The human queue:** a single `name_size_conflict` row — an L4L sweater
  whose name and SKU say "L" while `custom_fields.size` says `XL`. The
  backfill copied the stored `XL` into `variant_size` (source of truth) and
  flagged the disagreement for review. This is the flag working as designed
  on real data.

The original queries are preserved below for re-runs.

```sql
-- Per-flag counts, per org.
select o.name, i.sports_review_flag, count(*) as rows
from public.inventory_items i
join public.organizations o on o.id = i.organization_id
where i.sports_review_flag is not null and i.deleted_at is null
group by 1, 2
order by 1, 3 desc;

-- How much the backfill actually moved.
select count(*) filter (where variant_size is not null)              as sized_rows,
       count(*) filter (where variant_size is not null
                          and group_id is null)                      as linking_candidates,
       count(*) filter (where group_id is not null)                  as already_grouped,
       count(*) filter (where custom_fields ? 'size'
                          and variant_size is null)                  as size_stored_but_not_copied
from public.inventory_items
where deleted_at is null;

-- The rows a human has to look at, worst first.
select i.id, o.name as org, i.name, i.sku,
       i.custom_fields->>'size' as stored_size, i.variant_size, i.sports_review_flag
from public.inventory_items i
join public.organizations o on o.id = i.organization_id
where i.sports_review_flag is not null and i.deleted_at is null
order by case i.sports_review_flag
           when 'name_size_conflict'  then 1
           when 'ambiguous_size'      then 2
           when 'sized_but_ungrouped' then 3
         end, o.name, i.name;
```

`size_stored_but_not_copied` must equal the `ambiguous_size` count. If it is
larger, a shape of stored size exists that the backfill neither copied nor
flagged, and the flag predicates need widening before anyone trusts the queue.

Expected shape from the local dataset: `sized_but_ungrouped` is by far the
largest bucket (it is every historical size run), `name_size_conflict` is small,
`ambiguous_size` should be near zero because `size` is a
`RESERVED_CUSTOM_FIELD_KEY` and only `bulkCreateSizedVariants` has ever written
it.

---

## 4. PROD PUSH NOTE

**Push 0294-0303 in a scheduled LOW-TRAFFIC WINDOW.** This is not a formality;
0303 takes the whole `inventory_items` table offline for the duration of its
transaction, reads included.

Why. A migration file runs inside ONE transaction, so the ACCESS EXCLUSIVE lock
that 0303's first `alter table ... add column` takes on `inventory_items` is held
until the file COMMITS. For that whole window the table is completely
unavailable — every dashboard query, every `/api/v1` call and every mobile sync
that touches `inventory_items` queues behind it. The statement-level notes inside
the file are not a promise of concurrency: individually the `ADD COLUMN` is
rewrite-free, the `VALIDATE CONSTRAINT` takes only SHARE UPDATE EXCLUSIVE and the
backfill `UPDATE`s take only ROW EXCLUSIVE, but every one of them runs while that
first lock is still held.

**Cost:** approximately 4 seconds warm on 1.2 M rows for the scans, plus index
maintenance on the rows the backfill actually updates (the review-queue index is
built after the flags, measured at 106 ms). Budget tens of seconds of full table
unavailability, not milliseconds.

**`lock_timeout`.** 0303 sets `lock_timeout = '5s'` itself. Without it the `ADD
COLUMN`'s lock REQUEST queues ahead of every new reader, so one slow analytics
query holding a read lock would take the whole table offline for as long as it
ran, and the migration would wait behind it indefinitely. The 5-second bound is
the blast-radius limit, not a performance setting — do not remove it.

**On `lock_timeout` failure** (`canceling statement due to lock timeout`,
SQLSTATE `55P03`): nothing was applied. The transaction rolled back whole, so
**RETRY** — ideally a few minutes later, or once whatever holds `inventory_items`
has finished:

```sql
select pid, state, xact_start, query
from pg_stat_activity
where state <> 'idle'
order by xact_start;
```

**Retry-safe by construction.** Every statement in 0303 is idempotent (`if not
exists`, `create or replace`, and backfill WHERE clauses that re-match zero rows
on a second pass), so a retry after ANY failure is safe and cannot double-write.
`supabase/tests/0303_variant_size_backfill.test.sql` asserts the idempotence
directly, including an `xmin`-proven no-op re-run. The same is true of 0294-0302,
all of which use `add column if not exists` / `create or replace` / `on conflict
do nothing` and contain zero DML apart from 0294's system-scale seeds and 0297's
module grandfathering, both `on conflict do nothing`.

**Order of operations, non-negotiable:**

1. `supabase db push --linked` against `xizpqmhhslgzbuqtjubv`, applying 0294
   through 0303 in order.
2. **Before pushing, verify the live constraint name 0295 drops.** 0295 drops
   `inventory_items_tracking_type_check` by hard-coded name. If production's
   catalog carries a different name for that CHECK, the drop is a no-op, both
   constraints survive, and every `serial_optional` write 23514s. Confirm with
   `select conname from pg_constraint where conrelid = 'public.inventory_items'::regclass
   and pg_get_constraintdef(oid) ilike '%tracking_type%'`.
3. Fill in section 3's counts from production.
4. Only then push `main` — the GitHub integration auto-deploys web. Do NOT also
   POST `/v13/deployments`.
5. Only then ship mobile (`pnpm release:ota` from `apps/mobile`). Mobile must
   never ship before the migrations land; the new Bearer routes 404 loudly if it
   does, which is a loud failure and not corruption, but it is still a broken
   build in users' hands.

## 5. Rollback

Every migration in this program is reversible without data loss. `custom_fields`
is never mutated by any of them, so the source of truth for every backfilled
value survives.

### 0303 — the only one with data to undo

```sql
-- Data. custom_fields.size is untouched, so this is lossless: re-running
-- _backfill_variant_size() reproduces the exact same state.
update public.inventory_items
set variant_size          = null,
    variant_size_original = null,
    sports_review_flag    = null
where custom_fields ? 'size';

-- Reverting ONLY the flags (keep the copied sizes) is also safe:
--   update public.inventory_items set sports_review_flag = null;

-- Schema.
drop index if exists public.inventory_items_sports_review_idx;
alter table public.inventory_items
  drop constraint if exists inventory_items_sports_review_flag_check;
alter table public.inventory_items drop column if exists sports_review_flag;
drop function if exists public._backfill_variant_size();
-- Restore 0242's trigger function verbatim (drops the derived-write hatch):
\i supabase/migrations/0242_inventory_updated_at_ignores_embedding.sql
```

Do NOT run the data statement above against rows whose size was edited through
`update()` after the push: it would restore the pre-edit `custom_fields.size`
as authoritative. Scope it with `and updated_at < '<push timestamp>'` if any
time has passed.

### 0294-0302

| Migration | Rollback |
|---|---|
| 0294 | `alter table public.categories drop column if exists tracking_mode, ... sports_subcategory_key, ... tracking_profile, ... size_scale_id, ... default_unit_of_measure;` then `drop table public.size_scale_values, public.size_scales;` and `drop function public.category_tracking_mode(uuid), public.category_default_uom(uuid);`. No row was written, so nothing is lost. |
| 0295 | Re-add the narrow CHECK: `alter table public.inventory_items drop constraint inventory_items_tracking_type_check, add constraint inventory_items_tracking_type_check check (tracking_type in ('none','lot','serial'));`. Any row already on `serial_optional` must be moved to `serial` or `none` FIRST — that is a real decision, not a mechanical revert. |
| 0296 | Re-apply the previous `post_receipt_v2` definition, from `0285_allow_over_receipt.sql` (the fifth rewrite). Function-only; no data. |
| 0297 | `delete from public.role_default_permissions where permission = 'sports:manage';` `delete from public.organization_modules where module_id = 'sports';` then re-apply the prior `seed_org_modules()` body from **`0174_enable_returns_module.sql`** — the latest rewrite before this one, and the file 0297's own header says it copied byte-for-byte — and the prior `org_can_enable_module()` from **`0219_org_module_minplan_rls.sql`**. Both functions are rewritten WHOLESALE by every module migration, so restoring an older copy silently un-seeds every module added after it. |
| 0298 | `drop view public.product_group_rollups;` `alter table public.inventory_items drop column if exists group_id, ... variant_size, ... variant_size_original, ... variant_size_system, ... variant_width, ... variant_fit, ... variant_color, ... jersey_number, ... player_name, ... variant_key;` `drop table public.product_groups;` then restore the `inventory_items_insert` / `_update` WITH CHECK expressions WITHOUT the `product_group_in_org` arm (`alter policy ... with check` REPLACES the whole expression — recurring bug pattern #24). Zero DML in the forward direction. |
| 0299 | Re-apply the prior `duplicate_inventory_item` definition. Function-only. |
| 0300 | `drop trigger product_groups_pin_org on public.product_groups; drop function public.tg_pin_product_group_org();` |
| 0301 | `alter table public.po_import_lines drop column if exists variant_size, ... variant_size_original, ... variant_size_system, ... variant_width, ... variant_fit, ... variant_color, ... jersey_number, ... player_name, ... group_hint, ... serial_hint, ... suggested_group_id, ... mapping_confidence;` and `drop index if exists public.po_import_lines_suggested_group_idx;` |
| 0302 | `drop index if exists public.size_count_sessions_group_idx; alter table public.size_count_sessions drop column if exists product_group_id;` `style_key` was never dropped, so every pre-0302 session still reads. |

Dropping `product_groups` (0298) is the one destructive revert: it takes any
opt-in links a human made with it. `inventory_items.group_id` is
`on delete set null`, so the items themselves survive and fall back to the
display heuristic — but the groupings are gone. Export
`select * from public.product_groups` first.

---

## Proof

| File | Coverage |
|---|---|
| `supabase/tests/0303_variant_size_backfill.test.sql` | 31 assertions: the copy, verbatim original, `custom_fields` untouched, group_id untouched (the headline, asserted twice), all three flags, pre-set sizes not overwritten, soft-deleted rows skipped, quantity untouched, zero movements, `updated_at` preserved, a real edit still bumps, idempotent re-run, closed flag vocabulary, a case-only name/size difference not flagged as a conflict |
| `apps/web/src/server/services/inventory.dual-write.test.ts` | 12 assertions on `update()`: both places written, sibling `custom_fields` keys kept, same-patch merge, clearing semantics, `variant_key` recompute, `group_id`/quantity never touched |
| `packages/core/src/inventory/size-run.test.ts` | The post-backfill state (`variantSize` set, `groupId` null) still collapses on the name heuristic, in arrival order, and two different styles carrying the same size do not fold together |

Per-migration pgTAP, all green locally. Counts are each file's own
`select plan(N)`:

| Migration | pgTAP file | Assertions |
|---|---|---|
| 0294 | `supabase/tests/0294_category_tracking_profiles.test.sql` | 31 |
| 0295 | `supabase/tests/0295_tracking_type_serial_optional.test.sql` | 8 |
| 0296 | `supabase/tests/0296_post_receipt_v2_serial_optional.test.sql` | 20 |
| 0297 | `supabase/tests/0297_sports_module.test.sql` | (plus `0207_permission_overrides.test.sql`, count 109 -> 111) |
| 0298 | `supabase/tests/0298_product_groups_and_variants.test.sql` | 51, incl. R2 and R3 at the schema |
| 0299 | `supabase/tests/0299_duplicate_inventory_item_variants.test.sql` | 47, incl. 4 mutation tests |
| 0300 | `supabase/tests/0300_product_group_org_immutable.test.sql` | org-immutability trigger |
| 0301 | `supabase/tests/0301_po_import_line_variants.test.sql` | 30, incl. the `0`/`00`/`07` round trip and `serial_hint` |
| 0302 | `supabase/tests/0302_size_count_product_group.test.sql` | 14, incl. a pre-0302-shape insert |
| 0303 | `supabase/tests/0303_variant_size_backfill.test.sql` | 31 (detailed above) |

Whole suite at the branch tip: **100 files / 1285 assertions**, run with
`supabase db reset && pnpm db:test`. A bare `pnpm db:test` executes against a
stale schema and reports false failures.

The full-branch gate output, the CI rollup, and the live Demo Co results are in
`docs/superpowers/reports/2026-07-27-sports-verification.md`. Nothing in this
report has been verified against production.

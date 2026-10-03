#!/usr/bin/env bash
#
# `pnpm security:test` — the named security gate.
#
# WHY A SEPARATE GATE AT ALL
# --------------------------
# `pnpm test` already runs every suite in the monorepo, so on a green build this
# script proves nothing new. It exists for the two situations that are not a
# green build:
#
#   1. A failure here says "a security property broke", not "a test broke". That
#      distinction decides whether a red build can be merged around, and it is
#      lost when the assertion is one of several thousand.
#   2. It is runnable on its own, in seconds, without the full suite — which is
#      what makes it usable while writing a migration or a policy.
#
# The overlap with `pnpm test` is therefore deliberate. Do not "optimise" it away
# by removing these files from the main suite.
#
# EXPLICIT MANIFESTS, NOT GLOBS
# -----------------------------
# The suites are listed by path rather than selected by a naming pattern. This
# repo has at least six partial conventions for marking a security test
# (`*.security.test.ts`, `*.gates.test.ts`, `*-guard.test.ts`, `*-scope.test.ts`,
# `*-traversal.test.ts`, and a large number with no marker at all), so any glob
# either misses real coverage or drags in unrelated files. An explicit list is
# auditable: the security surface is readable in one place, and adding to it is a
# visible diff.
#
# THE MANIFEST POLICES ITSELF
# ---------------------------
# Every entry is checked to EXIST before anything runs, and a missing entry is a
# hard failure. This is not defensive padding. vitest positional arguments are
# substring filters: a filter matching zero files is not an error, so a renamed
# or deleted test file would silently shrink this gate while it kept reporting
# success. A security gate that can quietly stop checking things is worse than no
# gate, so the pre-check turns that into a red build.
#
# A second pre-check covers the other direction — a security suite that was
# written but never LISTED. See "PRE-CHECK 2" below for why it is apps/web only.
#
# ENVIRONMENT
# -----------
#   SECURITY_TEST_SKIP_DB=1   Skip the pgTAP section. Prints a loud SKIPPED line.
#                             For a machine with no Docker. CI must never set it.
#
# The pgTAP section needs the local Supabase stack running (`supabase start`),
# because `supabase test db` runs pg_prove against it. It does NOT apply
# migrations — start the stack first, and if you have added a migration since,
# reset the local database before trusting a pass.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

RED=''
GREEN=''
YELLOW=''
BOLD=''
RESET=''
if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
fi

say()  { printf '%s\n' "$*"; }
head2() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
fail() { printf '%sFAIL%s %s\n' "$RED" "$RESET" "$*" >&2; }
pass() { printf '%sok%s   %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%sSKIPPED%s %s\n' "$YELLOW" "$RESET" "$*"; }

# ═══════════════════════════════════════════════════════════════════════════
# MANIFEST 1 — pgTAP database invariants (supabase/tests/)
#
# security_invariants.test.sql is the allowlist-based sweep over whole classes
# of object (see docs/security/SECURITY-INVARIANTS.md). Everything else proves a
# specific security fix and is here because a regression in it is a security
# regression, not a feature bug.
# ═══════════════════════════════════════════════════════════════════════════
PGTAP_TESTS=(
  # The class-wide invariant sweep — anon/PUBLIC execute posture, RLS coverage,
  # view security_invoker, predicate tautologies, storage-path floor, buckets.
  supabase/tests/security_invariants.test.sql

  # Tenant isolation and cross-tenant write holes.
  supabase/tests/0201_location_org_guard_test.sql
  supabase/tests/0202_item_stock_levels_org_check_test.sql
  supabase/tests/0203_fk_org_consistency_test.sql
  supabase/tests/0204_charter_fk_org_consistency_test.sql
  supabase/tests/0205_supplier_fk_org_consistency_test.sql
  supabase/tests/0206_recurring_po_templates_write_test.sql
  supabase/tests/0217_crownjewel_critical_rls_fixes.test.sql
  supabase/tests/0229_inventory_select_rls_hashed_sets.test.sql
  supabase/tests/0300_product_group_org_immutable.test.sql
  supabase/tests/0321_movement_read_scope_and_attribution.test.sql
  supabase/tests/0322_quantity_guards_avatar_scope_override_clears.test.sql
  # AR-2 — the warehouse-scope RLS floor, and the org-level location scope that
  # decides which locations a scoped counter may even see.
  supabase/tests/0331_ar2_warehouse_scope.test.sql
  supabase/tests/0343_cycle_count_org_level_location_scope.test.sql

  # Authorization, permissions, privilege escalation.
  supabase/tests/0207_permission_overrides.test.sql
  supabase/tests/0208_po_write_has_permission.test.sql
  supabase/tests/0209_realtime_permission_overrides.test.sql
  supabase/tests/0212_has_permission_write_rollout.test.sql
  supabase/tests/0215_permission_override_no_escalation.test.sql
  supabase/tests/0218_lock_org_billing_columns.test.sql
  supabase/tests/0219_org_module_minplan_rls.test.sql
  supabase/tests/0220_org_members_insert_owner_guard.test.sql
  supabase/tests/0236_picking_rpcs_warehouse_scoped.test.sql
  supabase/tests/0279_auditor_read_permissions.test.sql
  supabase/tests/0282_cycle_count_assignment_lock.test.sql

  # Function privilege posture (the P0 class).
  supabase/tests/0318_secdef_grants.test.sql
  supabase/tests/0329_function_grants_and_search_path.test.sql
  # 0341 also carries the behaviour change, but the SECURITY DEFINER
  # self-authorization inside publish_outbox is the security property: before it,
  # every non-admin's outbox event was silently dropped by RLS inside a
  # best-effort try/catch, so connectors only ever heard admins.
  supabase/tests/0341_manual_writeoff_any_mode_and_outbox_secdef.test.sql
  # Stock writers: post_shipment_shipped (no caller since Shipments was
  # removed) and putaway_transfer (never had a caller) closed to every user
  # role, and anon off five INVOKER stock RPCs.
  supabase/tests/0356_stock_rpc_execute_narrowing.test.sql
  # The PO draft save: RLS and the PO guards still decide for a signed-in
  # caller (SECURITY INVOKER), and po_line_items_not_orderable, the SECURITY
  # DEFINER read past RLS behind its kit/deleted-line refusal, answers only a
  # PO writer (a manager, or purchase_orders:manage) or the service role
  # (tests 57, 73-76). The line guard refuses the same lines on a direct
  # insert without changing what a non-writer is told (78-83).
  supabase/tests/0366_save_purchase_order_draft.test.sql

  # Account disable / session revocation.
  supabase/tests/0308_account_disable.test.sql
  supabase/tests/0309_pin_user_profile_disable_flags.test.sql
  supabase/tests/0310_rls_blocks_disabled_accounts.test.sql
  supabase/tests/0311_restrict_disable_reason_visibility.test.sql
  supabase/tests/0311_user_can_access_inventory_disable_guard.test.sql
  supabase/tests/0312_close_disable_residual_gaps.test.sql
  supabase/tests/0313_stop_notifying_disabled_accounts.test.sql

  # Account identity: verified self-service email change (projection pin + sync).
  supabase/tests/0345_verified_email_change.test.sql

  # Platform console "Last active": a gate-less SECURITY DEFINER reader of the
  # auth schema whose service_role-only EXECUTE grant is its entire control. An
  # authenticated grant would be a cross-tenant login-activity oracle.
  supabase/tests/0351_platform_member_activity.test.sql

  # The "last seen" beacon: the one function in this feature that a signed-in
  # user may call and that WRITES. Its in-body gate (self only, real members
  # only, never an impersonation grant, never a disabled account) is the control.
  supabase/tests/0352_member_last_seen.test.sql

  # Per-person release state. Own-row RLS is the control, and its writer is
  # SECURITY INVOKER precisely so it has no power beyond those policies.
  supabase/tests/0353_user_release_state.test.sql
  supabase/tests/0354_module_enabled_honours_comp.test.sql

  # Direct-write lockdown (Phase 0 S1/S2, 2026-09-24): the ledger flag and the
  # guard triggers that refuse direct PostgREST writes to stock, receipts, POs,
  # rentals, maintenance requests, approvals and order lines.
  supabase/tests/0359_ledger_flag_carriers.test.sql
  supabase/tests/0360_purchase_order_guards.test.sql
  supabase/tests/0361_rental_rpcs.test.sql
  supabase/tests/0362_maintenance_request_guard.test.sql
  supabase/tests/0363_order_lines_and_approvals.test.sql
  supabase/tests/0364_ledger_lockdown_enforce.test.sql
  supabase/tests/0365_s2_fulfilment_fixes.test.sql
  # Count lines, AI-scan evidence and count status (S5, 0368): the columns the
  # post trusts are not client-writable, and a closed count cannot be reopened.
  supabase/tests/0368_count_line_column_grants.test.sql
  # Count correctness (S5-C, 0369): stock_movements.via_ledger is stamped by a
  # trigger, never by the writer, so a movement a signed-in user inserts
  # directly (claiming via_ledger, a cycle-count reference, a future date)
  # moves neither an offline count's baseline nor the post's superseded guard;
  # baseline_at is not client-writable; the guard's read is a SECURITY DEFINER
  # probe that answers only inside a ledger transaction.
  supabase/tests/0369_count_correctness.test.sql
  # Exception occurrences (F1-1, 0370): signed-in users hold SELECT only on
  # occurrences, events and sync state, filtered by the one visibility rule
  # (item read scope plus the holdings rule: _exc_occurrence_visible for the
  # RPC re-checks, and the same rule as hashed sets in the SELECT policy,
  # held equal for every reader and row), so warehouse, charter, category
  # and org scoping carry over; the EX counters
  # are closed to the API roles. Only exceptions_sync opens or resolves, and it
  # is service_role only (asserted from the catalog), drops cross-org ids, never
  # resolves a failed, truncated or held rule, and applies evaluations in order.
  # exception_occurrence_act answers "not found" for a row the caller cannot
  # see, needs stock:adjust and write access to the row's warehouse (manager
  # when it has none), refuses a resolved row, and never resolves.
  # item_stock_levels.positive_since is stamped by a trigger that ignores
  # supplied values and leaves the S1 ledger guard in force.
  supabase/tests/0370_exception_occurrences.test.sql
  # Holdings scope for staff (0371): the FOR ALL write policy that gave staff
  # every warehouse's holdings is split into INSERT + UPDATE policies that
  # grant no SELECT; adjust_stock / transfer_stock write holdings through the
  # gated SECURITY DEFINER ledger.apply_holding_delta, so no stock RPC depends
  # on the caller's row visibility (proved with a SELECT policy that hides
  # every holding); every staff RPC path keeps its error codes; the read
  # helpers item_holdings_elsewhere (aggregates only, readable items only, no
  # rows for managers) and location_stock_census (manager or locations:manage)
  # disclose nothing across orgs.
  supabase/tests/0371_holdings_staff_scope.test.sql
  # Targeted recount (F1-2, 0372): start_targeted_recount is SECURITY INVOKER
  # (the count is created under the caller's own RLS) with the service's
  # floors in its body: manager, cycle_counts:assign and stock:adjust (staff,
  # even one granted cycle_counts:assign, viewers and managers missing either
  # permission get 42501); another org's occurrence or item reads as not found
  # (P0002); at most 200 items; a replayed idempotency key returns the first
  # count and a reused key with another request is refused; per-item advisory
  # locks make two concurrent starts one count
  # (scripts/db-concurrency/0372_recount_overlap.sh). _exc_link_recount is
  # SECURITY DEFINER with its gates in the body (INV-25): visibility first, so
  # an invisible occurrence is P0002 and never a 42501 that confirms it
  # exists; manager with cycle_counts:assign; same-org, in-progress count that
  # holds the item. Neither RPC resolves. _latest_count_lines reads every
  # count of an org past RLS, so EXECUTE is service_role only (catalog).
  supabase/tests/0372_exception_recount.test.sql
  # 0372 review fixes: a recount links only to an open count whose line can
  # still re-check the item (cycle_count_line_rechecks, SECURITY INVOKER,
  # authenticated but not anon); a stale live pointer is replaced; a replay
  # returns the stored first answer; the evaluator reads counts as of the
  # evaluation; the sync closes a finished recount before resolving, and an
  # item that can no longer be counted resolves as subject_gone.
  supabase/tests/0372_exception_recount_review.test.sql
  # Draw provenance (0373): which holdings a null-location draw touched is
  # returned by the one draw engine, ledger.apply_level_delta_for (SECURITY
  # DEFINER, gated in its body: staff+ of the item's org, inside a ledger
  # RPC), and written by its caller into stock_movements.draw of the row it
  # inserts next. The stamp trigger refuses a draw outside a ledger
  # transaction (every role) and any later change. The read view
  # stock_movement_holdings is security_invoker (the movement's visibility
  # for every persona) and read-only to every API role. The drawer's scope is
  # cached per transaction by ledger._seal (no API EXECUTE) and cleared by the
  # transaction's own membership, assignment, profile, warehouse and location
  # changes. Every draw still moves holdings exactly as the 0359 body did
  # (differential oracle). security_invariants INV-37..41 keep the engine's
  # callers and the cache's writers honest.
  supabase/tests/0373_draw_provenance.test.sql
  # Verification summaries (F1-3, 0374): item_verification_summaries reads
  # counts and movements past RLS, so it is SECURITY DEFINER with its gates in
  # the body (signed in, member of the org, caller_can_read_item, item in the
  # org): another warehouse's item, another org's item, a non-member and a
  # signed-out caller get no row, and a member of two orgs gets no row for
  # the other org's item. It returns counts only, never movement rows; a
  # member who cannot see the item's movements still gets the true count.
  # At most 500 ids. location_holdings_visible (SECURITY INVOKER) equals
  # item_stock_levels RLS for every persona and location, so a location page
  # never shows hidden holdings as an empty location.
  supabase/tests/0374_verification_summaries.test.sql
  # Photo evidence (F1-4, 0375): the exception-evidence bucket is private,
  # pinned to png/jpeg/webp and 10 MB, with one INSERT policy (the caller's
  # accepted org folder, disabled accounts refused) and no select, update or
  # delete for authenticated. exception_evidence is SELECT-only to signed-in
  # users, visible where the occurrence is. Only exception_evidence_record
  # writes a row, and it is service_role only (catalog, plus an in-body role
  # check that holds after a grant slip); under a lock on the occurrence it
  # judges the UPLOADER with the act gate (not found for another warehouse,
  # another org, a disabled or pending account; refused for viewers and
  # staff without stock:adjust; a manager when there is no warehouse),
  # refuses a resolved occurrence, pins the path to the occurrence's folder,
  # caps live photos at 8, and restores the request claims it borrowed.
  # exception_evidence_remove is a soft remove by the uploader or a manager,
  # through the same gate, only while open; it never deletes. Acknowledge,
  # note, add and remove share ONE gate (_exc_occurrence_can_act, service_role
  # only). Review fixes 2026-09-27: a member may create only the upload name
  # a mint hands out ({uuid}.{ext}), never a thumbnail name; one upload name
  # is one photo (a second record of a recorded upload's uuid, any
  # extension, is 23505 already_recorded BEFORE the gate, open and cap
  # checks) and each thumbnail belongs to one row; the record and remove
  # locks are pinned in the catalog. The concurrent cap is
  # scripts/db-concurrency/0375_evidence_cap.sh.
  supabase/tests/0375_exception_evidence.test.sql
  # Escalate to maintenance (F1-5, 0376): the six escalation columns are
  # written only by exception_escalation_claim / _finish (SECURITY DEFINER,
  # search_path and lock_timeout pinned, authenticated only). Both lock the
  # row after the visibility rule (not found for another org, another
  # warehouse's holding, a disabled account) and call ONE gate
  # (_exc_escalation_refusal: the maintenance module and
  # maintenance_requests:submit; no client role may execute it). A claim
  # under 2 minutes old refuses every other claim and names its holder; a
  # person holds one live claim at a time (a per-caller lock, so parallel
  # calls cannot slip past); a link needs the caller's claim and a request in
  # the same org, for the occurrence's item AND location, made by the caller
  # within 5 minutes, not cancelled, linked nowhere else (a UNIQUE index, so
  # racing finishes cannot link one request twice); linking never
  # acknowledges or resolves. escalation_request_cancelled (a computed
  # field, SECURITY DEFINER) answers one boolean, only for a visible
  # occurrence, reading the link from the table (never the row passed in).
  # The concurrent claim, the racing finishes and one person's parallel
  # claims are scripts/db-concurrency/0376_escalation_claim.sh.
  supabase/tests/0376_exception_escalation.test.sql
  # Order readiness facts (F2-1, 0377): order_readiness_facts reads holds,
  # holdings, other orders and POs past RLS, so it is SECURITY DEFINER with
  # its gates in its body (signed in: 42501; not a member of the order's org,
  # a disabled member, a missing or foreign order: the SAME P0002; the orders
  # module: P0001 module_disabled; more than 200 lines: linesCapped, never a
  # partial answer). Per field: an item the caller cannot read (warehouse,
  # charter, category) is {itemId, visible:false} with no number; Staging
  # sources only where location_holdings_visible; PO numbers, statuses and
  # dates only where purchase_order_visible (held equal to
  # purchase_orders_select for every persona and PO; the FOR ALL write-policy
  # widening pinned in the safe direction), the rest a quantity; other
  # pending demand only for a manager or an orders:approve holder; other
  # warehouses' stock as totals only. It writes nothing and never raises
  # 40001/40P01. The same file proves parity with the frozen fulfilment RPCs
  # (approve, approve_partial, resume, complete_picking) over the shared
  # fixture packages/core/src/orders/readiness-parity-cases.json, and pins
  # the md5 of every function F2 promises not to touch.
  supabase/tests/0377_order_readiness_facts.test.sql
  # Hold available stock (F2-2, 0378): hold_order_stock writes holds
  # (stock_reservations) past RLS, so it is SECURITY DEFINER with its gates
  # in its body: signed in (42501); not a member of the order's org, a
  # disabled member, a missing or foreign order: the SAME P0002; the orders
  # module (P0001 module_disabled); the approve gate, manager or
  # orders:approve (42501, so a viewer or a requester without it never
  # creates a commitment, and staff with an orders:approve override may, as
  # approve lets them); write access to the order's warehouse (42501); a
  # hold status only (P0001 hold_not_applicable). It refuses only with
  # P0001, P0002 or 42501, never 40001/40P01, writes nothing but holds, never
  # more than on hand less every active hold (rentals' included), gives
  # quantities only for items the caller can read (a charter-scoped
  # approver's unreadable item is held the same and only counted), and locks
  # the order and then its items in id order, as approve does. The race for
  # the last units and the lock order against approve and complete_picking,
  # in both start orders, are scripts/db-concurrency/0378_hold_race.sh.
  supabase/tests/0378_order_hold_stock.test.sql
  # Book Order Totals (0379): five SECURITY INVOKER functions (so orders,
  # lines, items and warehouses RLS all apply), each with its gates in its
  # body (signed in: 42501 unauthenticated; a member holding reports:read,
  # else the SAME 42501 forbidden for a non-member, a disabled member or a
  # revoked permission; the orders and books modules: P0001
  # module_disabled), EXECUTE to authenticated only (anon, service_role and
  # PUBLIC revoked). Export mode (every row in one answer) also needs
  # reports:export in the body, so a direct RPC call cannot pull the whole
  # report past the export permission. Every total is limited to the books and warehouses the
  # caller can read: warehouse-, charter- and category-scoped members, and a
  # member of two orgs with a cross-org line planted each way. Filter ids
  # are validated against rows the caller can read. No answer carries
  # requester data; `mine` is a boolean about the caller. Writes nothing and
  # never raises 40001/40P01. The same file holds the brief's acceptance
  # numbers and the reconciliation of totals, pages, drill-downs and exports.
  supabase/tests/0379_book_order_totals.test.sql
  # Book Order Totals by the ORDER's charter (0382): the charter filter is
  # never authorization. Visibility comes first (the four RLS joins, plus
  # E2b: a reader limited to some charters at a warehouse sees there only
  # those charters' orders and orders with no charter), then the chosen
  # charter, which must be one book_order_report_charters lists for the
  # caller (gate 6b, over all statuses and all time). An out-of-scope,
  # another org's or an unknown charter id is ONE refusal (22023
  # invalid_charter, same hint, message and detail) from the page, the
  # export, the drill-down and the lines helper, and the charters block
  # returns no row for it; its own gates are the report's (signed in, the
  # same 42501 forbidden, module_disabled). Charter-, warehouse- and
  # category-limited readers, a two-org manager, "no charter" (never
  # refused), ownership and bill-to charters that must not act as the
  # filter, the by-charter breakdown reconciled to the summary, charter-list
  # parity per persona, the same answers with the leakproof E2b prefilter
  # and the A3 guard removed, Today and This week (Sunday start) in four
  # zones, and the day boundaries.
  supabase/tests/0382_book_order_totals_charter_dates.test.sql
  # Report aggregates answer for the CALLER (0380): the six report_*
  # functions ReportsService used to call through the service role (which
  # handed warehouse- and category-scoped readers other warehouses' SKUs,
  # names, losses and warehouse names) are SECURITY INVOKER plpgsql with
  # their gates in their bodies (signed in: 42501 unauthenticated, the test
  # superuser included; a member holding reports:read, else the SAME 42501
  # forbidden for a non-member, a disabled member or a revoked permission;
  # the bundles module for the bundle pair: P0001 module_disabled), EXECUTE
  # for authenticated (never anon or PUBLIC; service_role kept for the
  # rollout only). The owner, the manager, a two-org manager, an admin with
  # no warehouse assignment and an all-warehouse auditor (each of the last
  # two with and without activity_logs:read) get answers byte-identical to
  # the service role's at 30, 90 and 365 days; staff and a
  # category-scoped viewer get only their readable movements, items and
  # warehouse names; no org B row in an org A answer.
  supabase/tests/0380_report_rpcs_caller_scope.test.sql
  # Change an order's needed-by (F2-4, 0383): revise_order_needed_by writes
  # the order's needed-by and moves its Schedule event past RLS
  # (schedule_events_update is creator-or-manager, and an approver with an
  # orders:approve override is neither), so it is SECURITY DEFINER with its
  # gates in its body: signed in (42501); not a member of the order's org, a
  # disabled member, a missing or foreign order: the SAME P0002; the orders
  # module (P0001 module_disabled); the approve gate, manager or
  # orders:approve (42501; staff WITH the override succeed, a viewer or staff
  # without it never write); write access to the order's warehouse (42501);
  # a closed order (P0001 order_closed); a past or null date and a missing
  # reason (22023); a stale edit (P0001 needed_by_changed with the current
  # value). EXECUTE to authenticated only. It refuses only with 42501, P0001,
  # P0002 or 22023 (never 40001/40P01), writes only the order's needed-by and
  # its scheduled or in-progress event (start, end, description, both
  # reminder stamps cleared), never creates an event, never notifies, and
  # locks the order row FOR UPDATE; an equal value writes nothing. The race
  # of two approvers (exactly one wins) is
  # scripts/db-concurrency/0383_needed_by_race.sh.
  supabase/tests/0383_revise_order_needed_by.test.sql
  # A Schedule event's order link and assignee are the server's (0384):
  # authenticated holds INSERT and UPDATE on every schedule_events column
  # except order_request_id and assigned_user_id, so a viewer, staff, a
  # manager or the owner linking an event to an order (which took the order's
  # one slot in schedule_events_order_request_uniq, so its real event got
  # 23505, and let an approver's revise_order_needed_by move the linker's
  # event), another org's manager linking to this org's order, a creator
  # re-linking, and anyone naming an assignee (the reminder cron emails any
  # assignee) are each 42501 and write nothing; anon writes nothing. The insert
  # and update WITH CHECK also require the linked order to be in the event's
  # org (0362's order_request_in_org), so a two-org member cannot move a
  # linked event to the other org. The order side is fixed too: authenticated
  # may UPDATE every order_requests column but organization_id, so a two-org
  # manager moving an order (and its event's link) to the other org is 42501;
  # a viewer re-keying or backdating an event is 42501. The phone's and the
  # Schedule page's writes, edits of an order's event by its creator or a
  # manager, the web's user-client order writes (notes, deny, pick slip,
  # packing slip, staging, assignDelivery, in transit), the order flows' admin
  # writes and the needed-by revision keep working.
  supabase/tests/0384_schedule_event_order_link.test.sql
  # Draft a PO for an order's shortfall (F2-5, 0385): draft_order_shortfall_pos
  # is SECURITY INVOKER, so purchase_orders_write, purchase_order_items_write,
  # idempotency_keys_write and the 0359/0360/0364 PO guards decide exactly as
  # for a hand-made draft, with the floors also in its body: signed in
  # (42501); not a member, a disabled manager, a missing or foreign order: the
  # SAME P0002; the orders and purchase_orders modules (P0001
  # module_disabled); a manager (staff WITH a purchase_orders:manage override
  # and viewers: 42501 manager_required, since idempotency keys are
  # manager-only), holding purchase_orders:manage (42501), with write access
  # to the order's warehouse. EXECUTE to authenticated only; the three
  # helpers are IMMUTABLE and never anon. No function of 0385 names the
  # holdings table (INV-33): stock comes from order_readiness_facts. It takes
  # the reorder drafts' advisory lock (the 0366 key), recomputes what may be
  # drafted after it and REFUSES anything above it (P0001 shortfall_changed
  # with the current numbers; never clamped), refuses kits, deleted, moved
  # and unreadable items, writes one draft per supplier plus one with none,
  # all or nothing (a PO number taken for the second draft leaves no draft
  # and no key), replays an idempotency key's first answer and refuses the
  # key with another request, never raises 40001/40P01 and notifies nobody.
  # Parity with core's draftable over the shared readiness fixture. The race
  # of two buyers (exactly one wins) and a reorder draft racing a shortfall
  # draft are scripts/db-concurrency/0385_shortfall_race.sh.
  supabase/tests/0385_order_shortfall_po.test.sql
  # Confirm the counted number of a count difference (count differences R2,
  # 0386): exception_confirm_count is SECURITY DEFINER (search_path and
  # lock_timeout pinned), EXECUTE to authenticated only (not anon, not
  # service_role). It answers "not found" for a row the caller cannot see (another
  # warehouse, another org), then the act gate against the ITEM's live
  # warehouse (a manager without stock:adjust and a viewer: 42501
  # not_permitted), then the state (a recount or another count about to
  # settle it, a newer count, an item that cannot be counted, stock on record
  # that moved, a count line already confirmed: never 23505), then the
  # counter or a manager (42501 not_counter), in core countConfirmGate's
  # order (the fixture's reader x state matrix, cell by cell). It takes the
  # org's sync lock before the row, writes no stock, one count_confirmed
  # event (no client event id, no resolved event), and replays from stored
  # state. The six confirmed_* columns are readable and writable by no API
  # role but service_role; the reason and kind CHECKs admit only the new
  # values. exceptions_sync minus its lines tagged 0386 is the 0372 body, and
  # its step 2b holds a confirmed line (never across orgs, never on a
  # malformed id). exception_occurrence_act, the count functions and the
  # visibility and act-gate helpers are frozen (md5). The races (confirm vs
  # sync, both orders; a lock-less confirm and a sync without 2b reproduce the
  # second raise; confirm vs recount; 55P03 at 5 s) are
  # scripts/db-concurrency/0386_confirm_vs_sync.sh.
  supabase/tests/0386_exception_confirm_count.test.sql
  # Only the order actions approve an order or move it along a stock edge
  # (S0, 0387): a SECURITY INVOKER BEFORE UPDATE guard, keyed on current_user
  # being authenticated or anon and on the status EDGE (never the new value
  # alone), refuses a raw PATCH to approved by a manager or a staff approver
  # (also in bulk and through an upsert), every other RPC-owned edge (cancel,
  # picking complete, completed, backordered, resume, reopen, close partial:
  # 24 of the transition trigger's 30 edges, one TAP line each), and any
  # change to approved_by or approved_at, all 42501 with a stable hint
  # (status_through_rpc_only, approval_through_rpc_only), never 40001/40P01.
  # The six edges the web writes through the user client still go through
  # with RETURNING *, and so does a notes save on an approved order.
  # authenticated loses UPDATE on 38 columns (21 only the RPCs or the admin
  # client write, 17 under owner decision O5) and TRUNCATE, REFERENCES,
  # TRIGGER and MAINTAIN; anon loses every privilege on the table. Proven
  # with the column grant put back inside a self-undoing subtransaction, the
  # guard alone still refuses the approval forgery. Every DEFINER edge
  # (approve, approve partial, cancel, complete and reopen picking, resume,
  # close partial, both signatures, the picker claims, the needed-by
  # revision), the admin client and the approved_by FK's SET NULL on account
  # deletion (run as the table owner even when the deleting session is
  # authenticated) still work. The writer census scans every schema: only
  # the two approval bodies assign approval values, no SECURITY INVOKER
  # function updates the table (UPDATE or MERGE), and the 15 DEFINER
  # writers (whoever may execute them; a trigger function needs no EXECUTE)
  # are pinned by name and owner, as is every DEFINER function that inserts,
  # merges or deletes order rows (today only the expired-confirmation
  # cleanup: a DEFINER insert runs as postgres, which the insert guard does
  # not hold). The two-session proofs are
  # scripts/db-concurrency/0387_workflow_guard_race.sh; the migration's lock
  # footprint (no lock that stops an order read while the push runs) is
  # scripts/db-concurrency/0387_migration_lock_footprint.sh.
  supabase/tests/0387_order_workflow_guard.test.sql
  # Explicit order numbers and account deletion (0388): authenticated holds
  # INSERT on order_requests only for the 13 columns create_order_request
  # names, so no member can insert an order with order_number = bigint max
  # (every later order in the organization then failed 22003), and none can
  # set id, updated_at, internal_notes, requester_org_label, created_at or a
  # workflow column on insert; one TAP line per refused column, read from the
  # catalog. service_role, postgres, the public link and the portal still
  # insert. Deleting the account of a requester (internal with no email, or
  # portal) succeeds: a SECURITY INVOKER trigger stamps requester_deleted_at
  # only when a non-API role nulls a requester whose profile is gone, and
  # identity_chk accepts the stamp; a live requester nulled by service_role
  # still fails 23514, an API role never stamps (proven with the column grant
  # put back), and no order gains the person's email, name or phone. Approver,
  # picker, canceller and cycle-count counter deletions null every user
  # column; other rows stay byte-identical. account_deletion_check (DEFINER,
  # service_role only, refuses an authenticated or anon JWT, lock_timeout
  # 900ms) dry-runs the delete and always undoes it; it is the only function
  # in any schema that deletes from auth.users or user_profiles. Nothing in
  # public or auth is DEFERRABLE (the dry run would miss a deferred check),
  # and the only NOT VALID constraint is delivery_target_chk, whose legacy
  # rows refuse a deletion (pinned, and the refusal proven).
  # The two-session proofs (delete against approve, the dry run against a
  # row lock, numbering) are scripts/db-concurrency/0388_requester_delete_race.sh;
  # the lock footprint is scripts/db-concurrency/0388_migration_lock_footprint.sh.
  supabase/tests/0388_order_number_and_requester_deletion.test.sql

  # Storage and attachment exposure.
  supabase/tests/0026_avatar_logo_buckets.test.sql
  supabase/tests/0142_order_attachments_read_floor.test.sql
  supabase/tests/0315_maintenance_photos_bucket.test.sql
  supabase/tests/0323_storage_path_shape_constraints.test.sql
  supabase/tests/0324_validate_storage_path_and_nonneg_constraints.test.sql
  supabase/tests/0326_storage_path_floor_completion.test.sql
  # Item photos follow the item (0381): item_images rows and item-images
  # objects (both path shapes, {org}/items/{item}/{file} and the books import
  # {org}/{item}/{file}) are readable only through an item the caller can
  # read, per persona (owner, admin, manager, all-warehouse auditor, staff,
  # charter-scoped staff, category and warehouse viewers, another org,
  # disabled, pending, anon; the service role still reads all). A duplicated
  # item's shared file (master and thumbnail) reads through the duplicate's
  # row, and the SECURITY DEFINER set behind that answers per caller, from the
  # caller's own orgs only (another org's rows cannot slow it). Rows and
  # objects are writable only for an item the caller can read and change, at a
  # path that names it in its own org's folder (or, for a row, a path a
  # readable row already carries: duplicates, duplicates of duplicates);
  # never a new name in another item's folder, another org's item or folder,
  # an unreadable item's object, a third shape, or a non-uuid folder (a plain
  # refusal, not a cast error). The books cover upsert is pinned, and for
  # every persona every stored file a readable row carries is readable (so
  # copying a carried path into a new row can never reveal one).
  supabase/tests/0381_item_images_item_scope.test.sql

  # Auth material and trusted writers.
  supabase/tests/0025_notification_writers.test.sql
  supabase/tests/0027_mfa_recovery_codes.test.sql
  supabase/tests/0330_share_token_hash_at_rest.test.sql
  # Order secrets, expand (0389): a packing slip's signature token is minted
  # by generate_order_packing_slips (SECURITY DEFINER; gates in its body:
  # signed in, member, orders module, orders:approve, warehouse write; under
  # the order row lock, picking complete or a regenerate, unsigned) as 32
  # random bytes kept only in order_request_secrets, while the order row every
  # member reads (RLS, realtime, the v1 order route) holds its sha256.
  # order_request_secrets has RLS on, no policy, no privilege for anon or
  # authenticated, only the four DML privileges for service_role, is not
  # published, and cascades with its order. confirm_order_signature (frozen)
  # completes with the digest and records nothing with the raw token, so a
  # member who reads the column cannot complete a hand-over through it; a
  # viewer reads only the digest. order_return_token_ensure is service_role
  # only, atomic and never rotates (an issued side token or an emailed column
  # token is kept). The frozen bodies keep their md5. The two-session proofs
  # (two mints, mint against reopen, a no-lock mint) are
  # scripts/db-concurrency/0389_mint_race.sh; the lock footprint is
  # scripts/db-concurrency/0389_migration_lock_footprint.sh.
  supabase/tests/0389_order_secrets_expand.test.sql

  # AI read scoping.
  supabase/tests/0320_semantic_search_org_scope.test.sql
)

# ═══════════════════════════════════════════════════════════════════════════
# MANIFEST 2 — apps/web vitest, paths relative to apps/web/
# ═══════════════════════════════════════════════════════════════════════════
WEB_TESTS=(
  # Storage path traversal (HI-8) and upload content verification.
  src/lib/storage-path.test.ts
  src/server/services/storage-path-traversal.test.ts
  src/lib/image-signature.test.ts
  src/server/actions/profile.test.ts
  src/server/services/item-images.test.ts
  src/server/services/public-items.test.ts

  # Item photos are signed only for items the caller can read (2026-09-28):
  # item_images_select was org-member wide until 0381 (item visibility is
  # scoped); the route and the service still authorize the item themselves.
  # (item-images.test.ts above carries the service half.)
  'src/app/api/items/[id]/image-master/route.test.ts'
  # The New rental catalog reads its items with the caller's own client, so a
  # charter- or category-scoped member sees (and gets photos for) only the
  # rental items they can read (2026-09-28).
  'src/app/(dashboard)/dashboard/rentals/new/page.test.tsx'

  # Declared-type spoofing: the bytes decide the type, never the caller's word.
  # The 2026-08-21 wave (see project_upload_security_hardening) — a sniffer, a
  # PDF/zip threat scanner, and the three write paths that must consult them.
  # A regression here re-opens "upload an HTML/JS payload as image/png".
  src/lib/file-signature.test.ts
  src/lib/document-threat-scan.test.ts
  src/server/services/attachment-byte-guard.test.ts
  src/server/services/capture-byte-guard.test.ts
  src/server/services/po-imports.scan-byte-verification.test.ts
  # Photo evidence (F1-4): the byte check against the declared type, the
  # strict path before any storage call, delete-and-no-row on every refusal
  # (the refusals before the storage steps included), the upload and
  # finalize limiters failing closed, the photo's EXIF (GPS location
  # included) stripped from what is stored, the thumbnail under a fresh
  # uuid, and a recorded photo's files never deleted or rewritten by a later
  # finalize (review fixes 2026-09-27).
  src/server/services/exception-evidence.test.ts
  src/lib/image-reencode.test.ts
  # Escalate to maintenance (F1-5): the module and submit floors before any
  # read, the item and location taken from the occurrence (client ids
  # ignored), one request per escalation (a duplicate answers the linked
  # one), a request that could not be linked cancelled as its requester only
  # on a definite refusal (never while the link may still land), and the web
  # action limited as the phone's route is.
  src/server/services/exception-escalation.test.ts
  src/server/actions/exceptions.escalate.test.ts
  # Confirm this count (0386): the app gate before the RPC (items:read,
  # stock:adjust, write access to the item's LIVE warehouse, not the row's
  # stamp), the RPC's refusals mapped by SQLSTATE and hint (EXECUTE revoked
  # answers unavailable, never a 500; an unknown hint is unknown), one audit
  # row per confirm and none on a replay, the D6 switch refusing before the
  # RPC, the stock on record at the confirm never sent, the route and the web
  # action under one rate limit (the act bucket), and internal errors never
  # carrying database text.
  src/server/services/exception-occurrences.confirm.test.ts
  src/app/api/v1/exceptions/confirm-count-route.test.ts
  src/server/actions/exceptions.confirm.test.ts
  # Maintenance photos (2026-09-27): what finalize stores carries no EXIF,
  # GPS, XMP or ICC (real sharp on GPS-tagged JPEG, PNG and WEBP), the
  # thumbnail is the server's, made from the clean photo at the mint's name,
  # every refusal deletes the upload (still the original) and records nothing,
  # the finalize limiter fails closed, and a recorded photo's files are never
  # rewritten or deleted by a later finalize.
  src/server/services/maintenance-attachments.metadata.test.ts

  # AI boundaries: org-scoped tool reads, prompt-injection containment, SSRF.
  src/lib/ai/tools.security.test.ts
  src/lib/ai/untrusted.test.ts
  src/lib/ai/chat.write-guard.test.ts
  src/app/api/books/extract-isbns-ai/route.gates.test.ts
  src/app/api/v1/items/upc-lookup/route.gates.test.ts
  src/lib/ssrf-guard.test.ts
  # The book-cover rehost is the one place the server fetches a caller-supplied
  # URL and stores the bytes; these pin the host allowlist and redirect posture.
  src/server/services/books-import.ssrf.test.ts

  # Authorization gates on server actions and routes.
  src/app/api/orders/[id]/signature/route.test.ts
  src/server/actions/po-imports.gates.test.ts
  src/server/actions/purchase-orders.gates.test.ts
  src/server/actions/purchase-orders.destination-gate.test.ts
  src/server/services/po-imports.approval-threshold.test.ts
  src/server/services/po-imports.presign.test.ts
  src/server/services/purchase-orders.approval.test.ts

  # Permissions and escalation.
  src/server/actions/permissions.override-clear.test.ts
  src/server/actions/permissions.auditor-preset.test.ts
  'src/app/(dashboard)/dashboard/auditor-read-gates.test.tsx'

  # Identity, MFA, sessions, API keys.
  src/lib/auth/api-context.aal.test.ts
  # HI-6 pinned on BOTH auth paths: an ENROLLED user under an 'optional' org
  # policy still requires AAL2, so a stolen password alone cannot pass the gates.
  # context.mfa.test.ts below is the web twin — keep the pair together.
  src/lib/auth/api-context.mfa.test.ts
  src/lib/auth/platform-admin.test.ts
  src/lib/auth/platform-passphrase.test.ts
  src/lib/auth/api-key.test.ts
  src/lib/auth/access-predicate.test.ts
  src/lib/auth/account-status.test.ts
  src/server/services/context.mfa.test.ts
  src/app/auth/confirm/route.test.ts
  src/server/actions/auth.change-password.test.ts
  src/server/actions/auth.password-reset.test.ts
  src/server/actions/auth.account-disabled.test.ts
  src/server/actions/auth-error-classify.test.ts
  src/server/actions/mfa-recovery.test.ts
  src/server/services/platform/sessions.test.ts
  src/server/services/team.remove-member-sessions.test.ts

  # Output safety and information leakage.
  src/server/services/service-error.test.ts
  src/lib/safe-return-path.test.ts
  src/lib/exports/filename.test.ts
  src/server/security/monitors.test.ts
  src/server/services/maintenance-share-links.test.ts
  'src/app/m/[token]/photo/[n]/route.test.ts'
  # MED-26 / migration 0330 — a /r or /m share token is a bearer credential, so
  # only its hash may exist at rest; the plaintext column is gone and the value
  # is shown once. The DB half is 0330 in MANIFEST 1.
  src/server/services/public-links-token-hash.test.ts
  # Signed storage URLs, tokens and keys must never reach a log line or an
  # error payload.
  src/lib/redact-urls.test.ts
  # MED-24 — attribute-context escaping in the shared email components. These
  # templates interpolate org- and user-supplied text into href/style contexts.
  src/lib/email/es/components.escaping.test.ts
  # MED-27/28 — the emitted header set: no Supabase CSP wildcard, popup-safe
  # COOP, CORP. Asserted as properties, not as the literal strings.
  src/test/security-headers.test.ts
  # S6-A — rental checkout, return and cancel answer an internal failure with
  # a fixed sentence, never the raw PostgREST text (the phone and the web
  # toast both show the message verbatim). The route and action pin the
  # boundary; rentals.hardening pins the service half (an unmapped function
  # error keeps its raw text only in internalDetail, S13). The overdue cron
  # emails people OUTSIDE the organization: a failed module read fails the run
  # with nothing sent, the explicit rentals row (never the comp) decides, and
  # a rental is claimed before its email so overlapping runs cannot send twice.
  # Each file carries the "Security invariant" marker, so PRE-CHECK 2 fails if
  # one is dropped from this list.
  src/app/api/v1/rentals/route.test.ts
  src/server/actions/rentals.test.ts
  src/server/services/rentals.hardening.test.ts
  src/app/api/cron/rental-overdue/route.test.ts

  # Warehouse scoping (defence in depth behind the RLS policies).
  src/lib/warehouse-scope.test.ts
  src/lib/locations/scope.test.ts

  # Book Order Totals (0379): the service gate (reports:read with the MFA
  # step-up, orders and books modules) before any read, the verified
  # organization only, fixed error words, not_found for a hidden book, order
  # links only for orders:approve or the caller's own order, covers only for
  # books the caller's RLS read returned and only from trusted URLs; the read
  # routes (gate before query, warehouse required, never the view cookie);
  # the export route (reports:export before the rate limit, one export-mode
  # statement, refused above its ceiling before any byte or audit row, audit
  # awaited, streamed, no-store); the CSV (formula guard, CR quoting,
  # sanitized one-cell metadata lines, parsed back with exceljs and
  # papaparse); the PDF image prefetch (SSRF: safeFetch with the cover
  # allowlist for any non-storage host, byte cap) and the cover trust filter.
  src/server/services/book-order-totals.test.ts
  src/app/api/v1/reports/book-order-totals/route.test.ts
  src/app/api/v1/reports/book-order-totals/export/route.test.ts
  src/lib/reports/book-order-totals/export-content.test.ts
  src/lib/reports/book-order-totals/trusted-cover-url.test.ts
  src/lib/pdf/image-prefetch.test.ts
  # The page: one awaited answer for every number, no figures on a failure,
  # the MFA state, the concrete warehouse in every derived URL, export
  # controls only for reports:export; the drill-down: order links only where
  # openable, late or mismatched answers dropped. 0382: a charter in the link
  # the caller may not use is dropped on the server (never named, never
  # zeros), and the drawer drops an answer for another charter.
  src/components/reports/book-order-totals/report-body.test.tsx
  src/components/reports/book-order-totals/orders-drawer.test.tsx
  # 0382 (plan D17): the order page's "Back to Book Order Totals" renders a
  # user-controlled ?return= only when it passes safeReturnPath AND is the
  # report's own path; every open-redirect shape falls back.
  src/components/reports/book-order-totals/return-path.test.ts

  # Every other report (2026-09-28, 0380): ReportsService reads with the
  # CALLER'S client (never the service role) and checks reports:read (MFA
  # step-up first) and the report's modules before its first read; an
  # aggregate's own gate maps to its real error; the cost-history report
  # answers only for an item the caller can read. Each report page checks
  # for itself (not only the layout): no reports:read redirects before any
  # read, a module that is off shows its card, the MFA step-up is a state;
  # the hub lists a card only where its modules are on. The lot reports'
  # data path (traceLot, agingReport) needs reports:read too. The CSV, PDF,
  # snapshot PDF and XLSX exports check reports:export (MFA first), the
  # report gate and the request BEFORE the shared export limit, and answer
  # each ServiceError with its real status (401/403/404/400), never 500.
  src/server/services/reports.scope-gate.test.ts
  src/server/services/lots.report-gate.test.ts
  # The lot reports list only lots of items the reader can read: lots,
  # receipts and lot picks are member-wide, so both report reads inner-join
  # the item (row level security decides) and drop a null item; picking's
  # FEFO suggestions are unchanged.
  src/server/services/lots.report-scope.test.ts
  'src/app/(dashboard)/dashboard/reports/report-pages.gate.test.tsx'
  'src/app/(dashboard)/dashboard/reports/page.test.tsx'
  'src/app/api/reports/[slug]/csv/route.test.ts'
  'src/app/api/reports/[slug]/pdf/route.test.ts'
  src/app/api/reports/inventory-snapshot/pdf/route.test.tsx
  src/app/api/reports/item-cost-history/xlsx/route.test.ts

  # Order secrets, expand (0389). Who may complete a hand-over through the
  # sign route: a raw token whose sha256 is the order's column (a printed QR,
  # the panel's link) or a raw column minted before 0389 with no side token
  # hashing to it, with no session; the DIGEST every member reads only for a
  # signed-in member of the order's organization with effective
  # orders:approve or the assigned driver (installed phones' request shape).
  # Every other refusal is one byte-identical 404, an entitled member whose
  # MFA is unsatisfied gets 403, the member path is limited to 60 an hour per
  # member and the per-token limit is keyed by the token's hash; every
  # digital hand-over is audited without the token. The sign page verifies its
  # session locally without refreshing it. The warehouse slip is for the same
  # people and its QR is never the digest. GET /api/v1/orders/[id] returns an
  # allow-listed order (no token, signature or internal note). The image
  # route reads the side table first; return and track tokens are read side
  # first and written only there; the scan lookup hashes before it matches.
  src/server/lib/order-secrets.test.ts
  src/server/lib/sign-page-session.test.ts
  src/app/api/orders/sign/route.member.test.ts
  'src/app/orders/sign/[token]/page.test.tsx'
  'src/app/api/orders/[id]/packing-slip-warehouse.pdf/route.test.ts'
  'src/app/api/orders/[id]/signature/route.test.ts'
  'src/app/api/v1/orders/[id]/route.test.ts'
  src/app/api/v1/orders/signature-lookup/route.test.ts
  'src/app/api/v1/public/order-requests/[id]/route.test.ts'
  src/server/services/order-requests.packing-slips.test.ts

  # Every export route (2026-09-29): the caller's session, permission and
  # request are checked BEFORE the shared export budget, so a refused caller
  # never spends it, never writes a security.export_rate_limited audit row and
  # never trips the abuse alert; the order slips answer a ServiceError with
  # its real status. Self-policing: a route that calls the limiter must be
  # listed there, and the limiter-first idiom fails it.
  src/app/api/export-routes.limit-order.test.ts

  # Account deletion (0388): the web action, the phone route and the
  # platform console ask account_deletion_check before they change anything
  # (blocked, lock or deadlock, check failure and an unknown answer all change
  # nothing and fail closed), write no profile tombstone, write the
  # user.deactivated row only after the delete succeeded (user_id null), are
  # rate limited before the check, and report a failed delete honestly (the
  # phone used to answer 200). Only an integrity refusal (class 23) is
  # "linked to records"; any other error the dry run caught is a reported
  # check failure. A deleteUser error is settled against GoTrue, so an
  # account that is gone is never reported as kept. The platform cleanup
  # counts kept and failed accounts apart instead of claiming them deleted.
  src/server/lib/account-deletion.test.ts
  src/app/api/v1/account/delete/route.test.ts
  src/server/actions/platform-admin.remove-org.test.ts
)

# ═══════════════════════════════════════════════════════════════════════════
# MANIFEST 3 — apps/mobile vitest, paths relative to apps/mobile/
#
# Mobile's security surface is narrower by construction: it holds no RLS policy
# and signs no storage URL. What it does own is the disabled-account eviction
# path, scope filtering over its offline cache, and the offline OUTBOX: whose
# queued work is sent under which account and workspace, and that it is never
# lost to a sign-out or a schema change.
# ═══════════════════════════════════════════════════════════════════════════
MOBILE_TESTS=(
  src/lib/account-disabled-probe.test.ts
  src/lib/account-disabled-state.test.ts
  src/lib/account-disabled-wiring.test.ts
  src/lib/account-eviction.test.ts
  src/lib/remembered-identity.test.ts
  src/lib/cta-gating.test.ts
  src/lib/warehouse-scope.test.ts

  # S4 — the offline outbox. A queued change is sent only under the account
  # that queued it and the workspace it was queued in, checked before EACH send
  # (another account's work is held, never sent as someone else); every pending
  # counter is per account; sign-out honours signOut's result (no wipe, and no
  # biometric/MFA gate lifted, while a session survives) and keeps queued work;
  # the outbox survives every schema version; a cache pulled for another account
  # is reset before use; an unrelated ROLLBACK cannot undo an outbox write.
  src/lib/outbox-scope.test.ts
  src/lib/outbox-owner.sqlite.test.ts
  src/lib/sync.drain.test.ts
  src/lib/cycle-count-sync.drain.test.ts
  src/lib/api.outbox-scope.test.ts
  src/lib/sign-out-flow.test.ts
  src/lib/db.ensure-schema.test.ts
  src/lib/db.get-db.test.ts
  src/lib/db.addColumnIfMissing.test.ts
  src/lib/db.transaction-queue.test.ts
  src/lib/cache-owner.test.ts
  src/lib/sync.snapshot-removals.test.ts
  src/lib/draft-debouncer.test.ts

  # S4 review — WHO holds the session is read from the stored session, never
  # from getSession(), which answers "no session" offline once the access token
  # has expired while auth-js keeps it: a sign-out that failed offline must not
  # lift the biometric/MFA gate, and offline work keeps its owner (never a NULL
  # owner another account would adopt). The storage key is pinned to
  # supabase-js's default. The workspace key has one definition. A count still
  # in retry backoff never lands after its correction.
  src/lib/auth-storage.test.ts
  src/lib/session-scope.test.ts
  src/lib/workspace-keys.wiring.test.ts
  src/lib/cycle-count-sync.backoff.sqlite.test.ts

  # Book Order Totals on the phone: an answer for another workspace, warehouse
  # or account (a sign-out, a switch) is dropped, never shown; remembered
  # answers are keyed by account, workspace, every filter and the page, and
  # offline shows only the exact key with its time. The export download sends
  # the Bearer token and the REPORT's workspace to the API origin only, deletes
  # a refused or late file, and is never shared after the account changed.
  src/lib/book-order-totals-api.test.ts
  src/lib/report-export-download.test.ts

  # Item photo uploads (0381): the database refuses any path that is not
  # {org}/items/{item}/{file} or the books {org}/{item}/{file}, lowercase
  # uuids. The phone's three uploaders (new item, replace photo, scan capture)
  # build it with the one core builder, and the phone's outputs pass the
  # parser read from the migrations. (packages/core carries the builder half.)
  src/lib/item-photo-path.wiring.test.ts

  # Order secrets (0389): the scan tab's departure check asks the server's
  # lookup (which hashes the scanned token) instead of matching the order
  # column, and View signature reads the image through the gated route
  # (approvers and the assigned driver); both never throw.
  src/lib/scan-signature-departure.test.ts
  src/lib/order-signature-image.test.ts
)

# ═══════════════════════════════════════════════════════════════════════════
# MANIFEST 4 — packages/core vitest, paths relative to packages/core/
# ═══════════════════════════════════════════════════════════════════════════
CORE_TESTS=(
  src/constants/permissions.test.ts
  src/auth/account-status.test.ts
  src/schemas/inventory.test.ts
  src/signature/signature.test.ts
  # The one item-images path builder (web presign and thumbnail, phone
  # uploads, books cover) against 0381's database parser, read from the
  # newest migration that defines public.item_image_path_item_id.
  src/inventory/item-photo-path.test.ts
)

# ═══════════════════════════════════════════════════════════════════════════
# PRE-CHECK — every manifest entry must exist.
# ═══════════════════════════════════════════════════════════════════════════
head2 "Manifest pre-check"
MISSING=()
for f in "${PGTAP_TESTS[@]}";  do [ -f "$ROOT/$f" ]                || MISSING+=("$f"); done
for f in "${WEB_TESTS[@]}";    do [ -f "$ROOT/apps/web/$f" ]       || MISSING+=("apps/web/$f"); done
for f in "${MOBILE_TESTS[@]}"; do [ -f "$ROOT/apps/mobile/$f" ]    || MISSING+=("apps/mobile/$f"); done
for f in "${CORE_TESTS[@]}";   do [ -f "$ROOT/packages/core/$f" ]  || MISSING+=("packages/core/$f"); done

if [ ${#MISSING[@]} -gt 0 ]; then
  fail "${#MISSING[@]} manifest entr(y/ies) do not exist on disk:"
  for f in "${MISSING[@]}"; do say "       $f"; done
  say ""
  say "A vitest path filter that matches nothing is NOT an error, so a stale"
  say "manifest would shrink this gate silently. Fix the path or remove the"
  say "entry in scripts/security-test.sh — deliberately, with the reason in the"
  say "commit message."
  exit 1
fi
pass "$(( ${#PGTAP_TESTS[@]} + ${#WEB_TESTS[@]} + ${#MOBILE_TESTS[@]} + ${#CORE_TESTS[@]} )) manifest entries all present"

# ═══════════════════════════════════════════════════════════════════════════
# PRE-CHECK 2 — the apps/web manifest must also be COMPLETE.
#
# WHY THIS EXISTS (2026-09, audit finding SP-029)
# -----------------------------------------------
# The pre-check above only catches manifest entries that DISAPPEAR. It says
# nothing about security suites that were never added, and between #92 and this
# audit nine of them accumulated unlisted — the byte-verification wave
# (file-signature, document-threat-scan, the three byte guards), the /r token
# hash, the api-context MFA inversion, the books-import SSRF properties, and URL
# redaction. Each one still ran under `pnpm test`, so CI went red on a
# regression, but the step named "Security invariants" stayed GREEN — and this
# script's whole reason to exist (see the header) is that the LABEL on a red
# build decides whether it gets merged around. A gate that silently stops
# growing rots exactly as fast as one that silently shrinks.
#
# This is a DISCOVERY check, not a selection glob. The manifests above are still
# explicit paths; nothing is ever run because it matched a pattern. All this
# does is refuse to let a file that announces itself as a security suite sit
# outside the manifest unnoticed.
#
# WEB ONLY, DELIBERATELY. The same idea over supabase/tests/ is useless: the
# words that mark a pgTAP file as security-relevant ('RLS', 'security definer',
# 'grants', 'search_path') appear in the first 40 lines of 81 of the 145 files
# there, because almost every table in this schema has RLS and almost every
# fixture mentions it. That check would demand classifying half the suite and
# would be turned off within a week. pgTAP additions stay a human decision.
#
# It is a FLOOR, not a ceiling. Most of WEB_TESTS matches no pattern at all and
# was added by judgement; five of the nine suites this audit added (the sniffer,
# the threat scanner, two byte guards, the api-context MFA twin) do not match
# this marker either. Passing it does not mean the manifest is complete — it
# means nothing that ANNOUNCED itself was ignored.
#
# If this fails on a file that is NOT a security-property suite, the answer is
# to reword its header comment, not to weaken the pattern. Do not extend the
# marker to the filename conventions listed in the header above: `*-guard`
# alone pulls in rack-shape.inventory-guard.test.ts, which is a warehouse
# labelling regression guard with no security content.
# ═══════════════════════════════════════════════════════════════════════════
WEB_SECURITY_MARKER='Security (wave|MED-|HI-|invariant)|SSRF|token hash at rest|byte guard'

UNLISTED=()
while IFS= read -r abs; do
  rel="${abs#apps/web/}"
  # Exact-element membership: every entry is a bare `src/...` path, so padding
  # both sides with spaces cannot match a prefix of a longer path.
  case " ${WEB_TESTS[*]} " in
    *" $rel "*) continue ;;
  esac
  UNLISTED+=("$rel")
done < <(
  find apps/web/src \( -name '*.test.ts' -o -name '*.test.tsx' \) -print \
    | sort \
    | while IFS= read -r f; do
        head -40 "$f" | grep -qE "$WEB_SECURITY_MARKER" && printf '%s\n' "$f"
      done
)

if [ ${#UNLISTED[@]} -gt 0 ]; then
  fail "${#UNLISTED[@]} apps/web suite(s) announce themselves as security tests but are not in WEB_TESTS:"
  for f in "${UNLISTED[@]}"; do say "       $f"; done
  say ""
  say "Add each to the WEB_TESTS manifest in scripts/security-test.sh, under the"
  say "section that matches the property it pins. If one of these is not really a"
  say "security-property suite, reword its header comment — do not loosen the"
  say "marker pattern, because that turns this check off for everything."
  exit 1
fi
pass "no unlisted apps/web security suites"

FAILED=()

# ═══════════════════════════════════════════════════════════════════════════
# 1. pgTAP database invariants
# ═══════════════════════════════════════════════════════════════════════════
head2 "Database invariants — pgTAP (${#PGTAP_TESTS[@]} files)"
if [ "${SECURITY_TEST_SKIP_DB:-0}" = "1" ]; then
  warn "pgTAP skipped because SECURITY_TEST_SKIP_DB=1. The database half of the"
  warn "security gate did NOT run. Do not read this run as a pass."
else
  if pnpm exec supabase test db "${PGTAP_TESTS[@]}"; then
    pass "pgTAP database invariants"
  else
    fail "pgTAP database invariants"
    say ""
    say "If this failed to CONNECT rather than to assert, the local Supabase"
    say "stack is not running: \`pnpm exec supabase start\`. If you have added a"
    say "migration since the stack came up, \`pnpm db:reset\` first — a pass"
    say "against a stale schema means nothing."
    FAILED+=("pgTAP")
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# 2-4. Application-layer suites
# ═══════════════════════════════════════════════════════════════════════════
run_vitest() {
  local label="$1" pkg="$2"; shift 2
  head2 "$label — vitest ($# files)"
  if pnpm --filter "$pkg" exec vitest run "$@"; then
    pass "$label"
  else
    fail "$label"
    FAILED+=("$label")
  fi
}

run_vitest "Web application"  "@stockpilot/web"    "${WEB_TESTS[@]}"
run_vitest "Mobile client"    "@stockpilot/mobile" "${MOBILE_TESTS[@]}"
run_vitest "Shared core"      "@stockpilot/core"   "${CORE_TESTS[@]}"

# ═══════════════════════════════════════════════════════════════════════════
# Verdict
# ═══════════════════════════════════════════════════════════════════════════
head2 "Security gate"
if [ ${#FAILED[@]} -gt 0 ]; then
  fail "${#FAILED[@]} section(s) failed: ${FAILED[*]}"
  say ""
  say "Treat a failure here as a security regression until proven otherwise."
  say "Do not adjust an assertion to make it pass — the assertions are the"
  say "specification. See docs/security/SECURITY-INVARIANTS.md."
  exit 1
fi
pass "all sections passed"
if [ "${SECURITY_TEST_SKIP_DB:-0}" = "1" ]; then
  warn "reminder: the pgTAP half was skipped, so this is a partial result."
fi

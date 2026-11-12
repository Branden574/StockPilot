/**
 * RECURRENCE GUARD (S39): a database function called with a row id from a
 * request that runs in one organization must not act on another
 * organization's row.
 *
 * Security invariant (S39, listed in scripts/security-test.sh).
 *
 * WHAT WENT WRONG. A person can belong to more than one organization. The
 * organization switcher changes the active organization for every open tab,
 * and a phone screen keeps its row after a workspace switch. So a page left
 * open on organization B's order, count, receipt, rental, kit or movement
 * sends B's id with A's context. The SECURITY DEFINER and ledger functions
 * behind those writes decide on the ROW's own organization, so for a member of
 * both the change ran in B, under A's gates (A's modules, permissions and MFA
 * policy), while the service wrote the audit row, the webhook, the outbox row,
 * the notices and the cache invalidation into A. Twelve write paths did this
 * (plans/S39 section 2.1); each now reads its row in the active organization
 * first (readInActiveOrg, services/lib/in-active-org.ts) and refuses with
 * not_found, before anything runs.
 *
 * WHAT THIS FILE CHECKS. Every `.rpc(` call in apps/web/src (tests left out)
 * is keyed `<path>::<function>` and must be in exactly one class, each checked
 * as far as a scan can:
 *   - takes_org: the call passes the organization (a p_org / p_org_id /
 *     p_organization_id argument, or organization_id inside an object literal
 *     argument), so the function scopes itself to it. Arguments built
 *     elsewhere are allowed only when ORG_IN_BUILT_ARGS says where the
 *     organization rides.
 *   - read_first:<gate>: a call to the gate appears in the same member before
 *     the `.rpc(`. Each gate reads the row in the active organization and
 *     refuses a miss (GATES). `inline` is a read in the member filtered with
 *     `.eq('organization_id', <the context's organizationId>)`.
 *   - read_only: the function writes nothing. Checked against the migrations:
 *     its latest definition is STABLE or IMMUTABLE, which Postgres enforces
 *     (a data-modifying statement in a non-volatile function is an error).
 *   - not_org_data: no active organization's row is changed: the caller's own
 *     sessions, account, MFA codes, push token and What's New state; rate
 *     limits; connector secrets; public token and link paths; and jobs that
 *     run with no active organization. A reason is required.
 *   - callers_pin: the member making the call is in CALLER_PINS, which lists
 *     every one of its callers with the reason each is safe. A new caller
 *     fails here and is reviewed, instead of being trusted silently.
 * A call with no class fails, a function name that is not a literal fails
 * unless DYNAMIC_RPC lists it, and every stale entry fails, so the lists
 * cannot rot.
 *
 * One of the twelve is not a function call: BundlesService.update writes the
 * kit's component rows by bundle_id alone. TABLE_WRITE_SITES pins it (and its
 * private helper) to its gate.
 *
 * TABLE WRITES (S41). The same scan reads every
 * `.from('<table>').update|delete|upsert(` chain in apps/web/src, on any
 * client, and holds each to two rules.
 *   1. It stays in the active organization. A chain passes by itself when it
 *      carries `.eq('organization_id', <the context's organizationId>)`, when
 *      it writes the `organizations` row `.eq('id', <the context's
 *      organizationId>)`, or when it is an upsert whose conflict target names
 *      organization_id. Every other chain is keyed
 *      `<path>#<member>::<table>.<op>` in TABLE_WRITES and classed:
 *        - read_first:<gate>: a gate call precedes the write in the member.
 *        - own_row: the chain is keyed by a user id (`.eq('user_id' | 'id',
 *          <…userId>)`, or an upsert whose conflict target is user_id).
 *        - callers_pin: the member is in CALLER_PINS.
 *        - row_in_hand: the row was read or created by this code in the
 *          organization it names; its id is not a request's. A reason is
 *          required.
 *        - not_org_data: as above (jobs, webhooks, callbacks, public token
 *          paths, the platform console, sign-up and account). A reason is
 *          required.
 *   2. It proves its row. A filtered update or delete that matches no row is
 *      not an error, so one named by a row id (`.eq('id', …)`) asks its rows
 *      back (`.select(` in the chain, or on the variable that holds it), or
 *      follows a gate or a read of the same table filtered to the
 *      organization. ROW_PROOF_EXEMPT lists the few that need neither, with
 *      the reason.
 * Inserts are not scanned: a new row is stamped with the active organization,
 * and a parent of another organization in it is refused by the database's
 * organization-consistency rules. The scan sees that a read precedes a write,
 * not that its miss refuses; the unit tests beside each site cover that.
 *
 * The unit of attribution is the one inventory-list-invalidation.guard.test.ts
 * uses: a class member, a top-level function or const, or a method of a
 * top-level object literal. A call inside a nested closure belongs to the
 * member that contains it.
 *
 * IF THIS FAILS
 *   - "has no class": decide what keeps the call in the active organization.
 *     A write keyed by a row id reads the row first: call readInActiveOrg (or
 *     one of the GATES) before the call, and class it read_first. Do not class
 *     a write read_only or not_org_data to quiet the guard.
 *   - "has no <gate> before": the gate moved after the call or was removed.
 *     Put it back first; never move the call above it.
 *   - "callers changed": read the new caller. It must decide the organization
 *     the way the listed ones do; then add it with that reason.
 *   - "stale": the call, member or caller is gone; remove the entry.
 *   - "has no organization filter and no class" (a table write): filter the
 *     write with `.eq('organization_id', ctx.organizationId)` when the table
 *     has the column; otherwise read the parent row first with
 *     readInActiveOrg and class the write read_first. Never class a write
 *     keyed by a request's id row_in_hand or not_org_data to quiet the guard.
 *   - "asks no row back": add `.select('id').maybeSingle()` to the write and
 *     answer not_found, before any audit row, when no row came back.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../supabase/migrations');

/* ─────────────────────────────── the gates ─────────────────────────────── */

/**
 * The reads that keep a write in the active organization: each reads the row
 * (or the order or occurrence it belongs to) filtered to ctx.organizationId and
 * refuses a miss before the caller goes on.
 */
const GATES = {
  readInActiveOrg:
    'services/lib/in-active-org.ts (S39): the row by organization and id; not_found on a miss',
  requireWarehouseAccess:
    "OrderRequestsService: the order's warehouse read in the organization; 'Order request not found' on a miss",
  loadEditableOrderHeader:
    "OrderRequestsService: the order header read in the organization; 'Order not found' on a miss",
  factsInActiveOrg:
    'RMAService: the RMA read in the organization before every RMA function (desk check F4)',
  assertOrderInActiveOrg:
    'RMAService: the order read in the organization before an RMA is created (desk check F4)',
  assertSessionAccess:
    "CycleCountsService: the count read in the organization; 'Cycle count not found.' on a miss",
  requireActable: 'ExceptionOccurrencesService: the occurrence read in the organization',
  requireOpenActable: 'ExceptionEvidenceService: requireActable, and refuses a resolved occurrence',
  readOccurrence: 'ExceptionEscalationService: the occurrence read in the organization',
  assertLinkInOrg:
    "PublicLinksService: the link read in the organization; 'Public link not found' on a miss",
  fetchOwnedOrAdmin:
    "ProcedureCommentsService: the comment read in the organization; 'Comment not found' on a miss",
  get: "the service's own get(id), read in the organization (only `this.get(` counts)",
  inline:
    "a read in the same member filtered with .eq('organization_id', <the context's organizationId>)",
} as const;

type Gate = keyof typeof GATES;
type Klass = 'takes_org' | `read_first:${Gate}` | 'read_only' | 'not_org_data' | 'callers_pin';
type Classified = readonly [klass: Klass, why: string];
/** The classes of a table write with no organization filter of its own (S41). */
type WriteKlass = `read_first:${Gate}` | 'own_row' | 'callers_pin' | 'row_in_hand' | 'not_org_data';
type ClassifiedWrite = readonly [klass: WriteKlass, why: string];
type Entry = Classified | { readonly byMember: Readonly<Record<string, Classified>> };

/* ─────────────────────────────── the classes ─────────────────────────────── */

const RO = (why = 'Reads only.'): Classified => ['read_only', why];
const S39 = (site: string): Classified => [
  'read_first:readInActiveOrg',
  `S39 site ${site}: the row is read in the active organization before the function, which decides on the row's own organization.`,
];
const RWA: Classified = [
  'read_first:requireWarehouseAccess',
  'The order is read in the organization (and its warehouse checked) before the function.',
];
const RMA: Classified = [
  'read_first:factsInActiveOrg',
  'The RMA is read in the organization before the function (desk check F4).',
];

/**
 * Every `.rpc(` call site, keyed `<path under apps/web/src>::<function>`.
 * `byMember` splits a key whose call sites are safe for different reasons.
 */
const REGISTRY: Record<string, Entry> = {
  'app/api/cron/purge-ai-chat-history/route.ts::purge_ai_chat_history': [
    'not_org_data',
    'Scheduled purge of old AI chat history in every organization; no active organization.',
  ],
  'app/api/orders/sign/route.ts::confirm_order_signature': [
    'not_org_data',
    'Public sign link: the signature token names the order; no active organization.',
  ],
  'app/api/v1/auth/signed-out/route.ts::revoke_my_other_sessions': [
    'not_org_data',
    "The caller's own sessions: the phone's sign-out ends the account's other sessions (0213: auth.uid()'s rows only).",
  ],
  'app/api/v1/me/seen/route.ts::touch_member_last_seen': [
    'takes_org',
    "The caller's own last-seen stamp in the organization it names.",
  ],
  'app/api/v1/movements/[id]/note/route.ts::edit_movement_note': S39('12 (phone movement note)'),
  'app/api/v1/public/catalog-thumbnails/route.ts::public_link_eligible_items': RO(),
  'app/api/v1/public/order-requests/route.ts::cleanup_expired_unconfirmed_order_requests': [
    'not_org_data',
    "The public order form's reaper: removes unconfirmed public requests past their expiry in every organization; no active organization.",
  ],
  'app/api/v1/public/order-requests/route.ts::insert_order_request_with_lines': [
    'takes_org',
    "The header carries the link's organization.",
  ],
  'app/api/v1/public/order-requests/route.ts::public_link_eligible_items': RO(),
  'app/api/v1/public/order-requests/route.ts::publish_outbox': [
    'takes_org',
    "The link's organization.",
  ],
  'app/api/v1/push/register/route.ts::register_push_token': [
    'not_org_data',
    "The caller's own device push token.",
  ],
  'app/r/confirm/submit/route.ts::confirm_public_order_request': [
    'not_org_data',
    'Public confirmation link: the token hash names the request; no active organization.',
  ],
  'lib/ai/tools.ts::match_inventory_items_by_embedding': RO(),
  'lib/auth/api-context.ts::get_request_context': RO('Resolves the request context itself.'),
  'lib/auth/request-context-bundle.ts::get_request_context': RO(
    'Resolves the request context itself.',
  ),
  'lib/rate-limit.ts::increment_rate_limit': [
    'not_org_data',
    'Rate limit counters, keyed by the caller.',
  ],
  'server/actions/auth.ts::revoke_my_other_sessions': [
    'not_org_data',
    "The caller's own sessions: a password change ends the account's other sessions in the database when the Auth server's sign-out of them answers an error.",
  ],
  'server/actions/mfa-recovery.ts::consume_mfa_recovery_code': [
    'not_org_data',
    "The caller's own MFA recovery codes.",
  ],
  'server/actions/mfa-recovery.ts::generate_mfa_recovery_codes': [
    'not_org_data',
    "The caller's own MFA recovery codes.",
  ],
  'server/actions/movements.ts::edit_movement_note': S39('11 (web movement note)'),
  'server/actions/team.ts::auth_user_exists_by_email': RO(),
  'server/actions/team.ts::transfer_org_ownership': [
    'takes_org',
    'The organization being handed over is the active one.',
  ],
  'server/connectors/drainer.ts::connector_drain_candidates': [
    'takes_org',
    "The connection's organization.",
  ],
  'server/connectors/secret-store.ts::connector_secret_delete': [
    'not_org_data',
    'Connector secrets in the vault, by secret id.',
  ],
  'server/connectors/secret-store.ts::connector_secret_get': [
    'not_org_data',
    'Connector secrets in the vault, by secret id.',
  ],
  'server/connectors/secret-store.ts::connector_secret_put': [
    'not_org_data',
    'Connector secrets in the vault, by secret id.',
  ],
  'server/email/return-prompt.ts::order_return_token_ensure': [
    'not_org_data',
    "Service-role helper on the order's own row: mints its return-link token, and everything after it uses the order's organization.",
  ],
  'server/lib/account-deletion.ts::account_deletion_check': [
    'not_org_data',
    "The caller's own account.",
  ],
  'server/lib/order-secrets.ts::order_id_for_return_token': RO('Token lookup.'),
  'server/loaders/inventory-list.ts::inventory_trend_buckets': RO(),
  'server/loaders/inventory-list.ts::inventory_value_on_hand': RO(),
  'server/loaders/orders-frequently-ordered.ts::order_request_top_skus_for_warehouse': RO(),
  'server/loaders/orders-new-catalog.ts::rls_cat_allowed_category_ids': RO(
    "The caller's own scope sets.",
  ),
  'server/loaders/orders-new-catalog.ts::rls_cat_unrestricted_org_ids': RO(
    "The caller's own scope sets.",
  ),
  'server/loaders/orders-new-catalog.ts::rls_inv_read_assigned_warehouse_ids': RO(
    "The caller's own scope sets.",
  ),
  'server/loaders/orders-new-catalog.ts::rls_inv_read_full_warehouse_ids': RO(
    "The caller's own scope sets.",
  ),
  'server/loaders/orders-new-catalog.ts::rls_inv_read_warehouse_charter_ids': RO(
    "The caller's own scope sets.",
  ),
  'server/services/bins.ts::set_default_bin': ['takes_org', 'Passes the active organization.'],
  'server/services/book-order-totals.ts::book_order_totals': RO(),
  'server/services/book-order-totals.ts::book_order_totals_options': RO(),
  'server/services/book-order-totals.ts::book_order_totals_orders': RO(),
  'server/services/bundles.ts::assemble_bundle': S39('9 (kit assemble)'),
  'server/services/bundles.ts::distribute_bundle': S39('10 (kit distribute)'),
  'server/services/cycle-counts.ts::assign_cycle_count': [
    'read_first:inline',
    "The count header is read in the organization; 'Cycle count not found.' on a miss.",
  ],
  'server/services/cycle-counts.ts::cycle_count_lines_page': RO(),
  'server/services/cycle-counts.ts::cycle_count_summary': RO(),
  'server/services/cycle-counts.ts::cycle_counts_page': RO(),
  'server/services/cycle-counts.ts::force_reassign_cycle_count': S39('4 (cycle count reassign)'),
  'server/services/cycle-counts.ts::post_cycle_count': [
    'read_first:assertSessionAccess',
    'The count is read in the organization first.',
  ],
  'server/services/cycle-counts.ts::release_cycle_count': S39('3 (cycle count release)'),
  'server/services/cycle-counts.ts::start_cycle_count': [
    'takes_org',
    'Passes the active organization.',
  ],
  'server/services/email-change.ts::auth_user_exists_by_email': RO(),
  'server/services/email-change.ts::cancel_pending_email_change': [
    'not_org_data',
    "The caller's own pending email change.",
  ],
  'server/services/exception-escalation.ts::exception_escalation_claim': [
    'read_first:readOccurrence',
    'The occurrence is read in the organization first.',
  ],
  'server/services/exception-escalation.ts::exception_escalation_finish': [
    'callers_pin',
    'Finishes or releases the claim escalate() took, after it read the occurrence in the organization.',
  ],
  'server/services/exception-evidence.ts::exception_evidence_record': [
    'read_first:requireOpenActable',
    'The occurrence is read in the organization first.',
  ],
  'server/services/exception-evidence.ts::exception_evidence_remove': [
    'read_first:requireActable',
    'The occurrence is read in the organization first.',
  ],
  'server/services/exception-occurrences.ts::exception_confirm_count': [
    'read_first:requireActable',
    'The occurrence is read in the organization first.',
  ],
  'server/services/exception-occurrences.ts::exception_occurrence_act': [
    'read_first:requireActable',
    'The occurrence is read in the organization first.',
  ],
  'server/services/exception-occurrences.ts::exceptions_sync': [
    'takes_org',
    'Passes the organization being synced.',
  ],
  'server/services/exception-recount.ts::start_targeted_recount': [
    'takes_org',
    'Passes the active organization.',
  ],
  'server/services/exceptions.ts::_latest_count_lines': RO(),
  'server/services/inventory.ts::adjust_stock': [
    'read_first:get',
    'The item is read in the organization (get) first.',
  ],
  'server/services/inventory.ts::duplicate_inventory_item': [
    'read_first:inline',
    "The original is read in the organization; 'Original item no longer exists.' on a miss.",
  ],
  'server/services/inventory.ts::inventory_distinct_racks': RO(),
  'server/services/inventory.ts::inventory_distinct_racks_for_org': RO(),
  'server/services/inventory.ts::inventory_set_bin_location': [
    'callers_pin',
    'The rack label after a placement whose stock moved to a destination in the organization.',
  ],
  'server/services/inventory.ts::inventory_set_book_placement': [
    'callers_pin',
    "A book's crate summary, rewritten from its live holdings after a write in the organization.",
  ],
  'server/services/inventory.ts::inventory_set_rack': {
    byMember: {
      'InventoryService.bulkUpdate': [
        'read_first:inline',
        'Bulk Set rack: the ids are filtered through a read in the organization first.',
      ],
      'InventoryService.stampPlacementBin': [
        'callers_pin',
        'The rack label after a placement whose stock moved to a destination in the organization.',
      ],
    },
  },
  'server/services/inventory.ts::item_holdings_elsewhere': RO(),
  'server/services/inventory.ts::transfer_stock': [
    'callers_pin',
    "transfer_stock refuses a location outside the item's organization (0201); every caller resolves the destination in the active organization.",
  ],
  'server/services/item-grouping.ts::apply_item_grouping': [
    'takes_org',
    'The request body carries the organization.',
  ],
  'server/services/item-grouping.ts::item_grouping_preview': RO(),
  'server/services/item-grouping.ts::split_item_sku': [
    'takes_org',
    'The request body carries the organization.',
  ],
  'server/services/locations.ts::location_stock_census': RO(),
  'server/services/locations.ts::mint_placement_location': [
    'takes_org',
    'Passes the active organization.',
  ],
  'server/services/movements.ts::dashboard_history_series': RO(),
  'server/services/movements.ts::dashboard_movement_metrics': RO(),
  'server/services/movements.ts::dashboard_value_series': RO(),
  'server/services/movements.ts::get_dashboard_summary': RO(),
  'server/services/movements.ts::low_stock_items': RO(),
  'server/services/opening-stock-compensation.ts::compensate_opening_stock': [
    'takes_org',
    'Passes the active organization.',
  ],
  'server/services/order-catalog-visibility.ts::set_order_catalog_visibility': [
    'takes_org',
    'Passes the active organization.',
  ],
  'server/services/order-readiness.ts::draft_order_shortfall_pos': [
    'read_first:inline',
    'The order is read in the organization first; not found on a miss.',
  ],
  'server/services/order-readiness.ts::order_readiness_facts': RO(),
  'server/services/order-requests.ts::add_order_request_lines': [
    'read_first:loadEditableOrderHeader',
    'The order header is read in the organization first.',
  ],
  'server/services/order-requests.ts::approve_order_request': RWA,
  'server/services/order-requests.ts::approve_partial': RWA,
  'server/services/order-requests.ts::assign_order_delivery': RWA,
  'server/services/order-requests.ts::assign_picking': RWA,
  'server/services/order-requests.ts::cancel_order_request': S39('1 (order cancel)'),
  'server/services/order-requests.ts::claim_picking': RWA,
  'server/services/order-requests.ts::close_partial': RWA,
  'server/services/order-requests.ts::complete_picking': RWA,
  'server/services/order-requests.ts::confirm_physical_signature': S39('2 (paper signature)'),
  'server/services/order-requests.ts::generate_order_packing_slips': RWA,
  'server/services/order-requests.ts::hold_order_stock': RWA,
  'server/services/order-requests.ts::mark_order_in_transit': RWA,
  'server/services/order-requests.ts::order_submission_status': RO(),
  'server/services/order-requests.ts::partial_pick_line': RWA,
  'server/services/order-requests.ts::place_order_request': [
    'takes_org',
    'The request carries the active organization.',
  ],
  'server/services/order-requests.ts::publish_outbox': [
    'takes_org',
    'Passes the active organization.',
  ],
  'server/services/order-requests.ts::release_picking': RWA,
  'server/services/order-requests.ts::reopen_picking': RWA,
  'server/services/order-requests.ts::resume_fulfillment': RWA,
  'server/services/order-requests.ts::revise_order_needed_by': [
    'read_first:inline',
    'The order is read in the organization first; not found on a miss.',
  ],
  'server/services/order-requests.ts::withdraw_order_submission': [
    'takes_org',
    'Passes the active organization.',
  ],
  'server/services/order-storefront.ts::order_recent_requesters': RO(),
  'server/services/platform/orgs.ts::platform_member_activity': RO(),
  'server/services/platform/permission-exceptions.ts::platform_set_permission_exception': [
    'takes_org',
    'The platform console names the organization.',
  ],
  'server/services/platform/sessions.ts::admin_revoke_user_sessions': [
    'not_org_data',
    "The platform console signs a person out of every session; an account's sessions, not an organization's row.",
  ],
  'server/services/po-imports.ts::approve_po_import_commit': [
    'read_first:get',
    'The PO import is read in the organization (get) first.',
  ],
  'server/services/po-imports.ts::next_po_number': ['takes_org', 'Passes the active organization.'],
  'server/services/portal.ts::insert_order_request_with_lines': [
    'takes_org',
    "The header carries the portal customer's organization.",
  ],
  'server/services/public-catalog.ts::public_link_eligible_items': RO(),
  'server/services/public-links.ts::public_link_eligible_items': RO(),
  'server/services/purchase-orders.ts::next_po_number': [
    'takes_org',
    'Passes the active organization.',
  ],
  'server/services/purchase-orders.ts::publish_outbox': [
    'takes_org',
    'Passes the active organization.',
  ],
  'server/services/purchase-orders.ts::purchase_orders_page': RO(),
  'server/services/purchase-orders.ts::purchase_orders_stats': RO(),
  'server/services/purchase-orders.ts::save_purchase_order_draft': [
    'takes_org',
    'Passes the active organization.',
  ],
  'server/services/receiving.ts::post_receipt_v2': S39('5 (receipt post)'),
  'server/services/receiving.ts::publish_outbox': ['takes_org', 'Passes the active organization.'],
  'server/services/receiving.ts::reverse_receipt': S39('6 (receipt reverse)'),
  'server/services/recurring-pos.ts::po_line_items_not_orderable': RO(),
  'server/services/releases.ts::record_release_state': [
    'not_org_data',
    "The person's own What's New read state.",
  ],
  'server/services/rentals.ts::cancel_rental': [
    'read_first:inline',
    "The rental is read in the organization first; 'Rental not found.' on a miss.",
  ],
  'server/services/rentals.ts::create_rental': S39('7 (rental create)'),
  'server/services/rentals.ts::return_rental': [
    'read_first:inline',
    "The rental is read in the organization first; 'Rental not found.' on a miss.",
  ],
  'server/services/reports.ts::report_bundle_activity': RO(),
  'server/services/reports.ts::report_bundle_component_value': RO(),
  'server/services/reports.ts::report_item_out_movements': RO(),
  'server/services/reports.ts::report_movement_type_summary': RO(),
  'server/services/reports.ts::report_shrinkage_totals': RO(),
  'server/services/reports.ts::report_top_movers': RO(),
  'server/services/returns-requester.ts::return_exchange_options': RO(),
  'server/services/returns-workbench.ts::return_restock_options': RO(),
  'server/services/returns.ts::approve_return': RMA,
  'server/services/returns.ts::cancel_return': RMA,
  'server/services/returns.ts::cancel_return_replacement': RMA,
  'server/services/returns.ts::change_return_replacement': RMA,
  'server/services/returns.ts::close_return': RMA,
  'server/services/returns.ts::close_return_replacement_rest': RMA,
  'server/services/returns.ts::create_requester_return_request': [
    'callers_pin',
    "The requester's order is resolved first; everything after the function uses the organization it answers with.",
  ],
  'server/services/returns.ts::create_return_request': [
    'read_first:assertOrderInActiveOrg',
    'The order is read in the organization first (desk check F4).',
  ],
  'server/services/returns.ts::decline_return_replacement': RMA,
  'server/services/returns.ts::deny_return': RMA,
  'server/services/returns.ts::plan_return_dispositions': RMA,
  'server/services/returns.ts::publish_outbox': ['takes_org', "Passes the RMA's organization."],
  'server/services/returns.ts::receive_return': RMA,
  'server/services/returns.ts::release_return_replacement_early': RMA,
  'server/services/returns.ts::return_exchange_candidates': RO(),
  'server/services/returns.ts::return_restock_options': RO(),
  'server/services/schedule.ts::distribute_bundle': [
    'read_first:inline',
    "The event is read in the organization first; 'Event not found' on a miss.",
  ],
  'server/services/sessions.ts::list_my_sessions': RO("The caller's own sessions."),
  'server/services/sessions.ts::revoke_my_other_sessions': [
    'not_org_data',
    "The caller's own sessions.",
  ],
  'server/services/sessions.ts::revoke_my_session': ['not_org_data', "The caller's own sessions."],
  'server/services/sessions.ts::set_my_session_name': [
    'not_org_data',
    "The caller's own sessions.",
  ],
  'server/services/user-categories.ts::set_user_category_access': [
    'takes_org',
    'Passes the active organization.',
  ],
  'server/services/verification.ts::item_verification_summaries': RO(),
  'server/services/verification.ts::location_holdings_visible': RO(),
};

/**
 * takes_org call sites whose arguments are built before the call, so the
 * scan cannot see the organization in them: key → where it rides.
 */
const ORG_IN_BUILT_ARGS: Record<string, string> = {
  'server/services/item-grouping.ts::apply_item_grouping':
    'toGroupingRpcRequest(body): body.organizationId, refused just above unless it is the active organization (workspace_changed); the database refuses it too.',
  'server/services/item-grouping.ts::split_item_sku':
    'toSplitSkuRpcRequest(body): body.organizationId, refused just above unless it is the active organization (workspace_changed); the database refuses it too.',
};

/** `.rpc(` calls whose function name is not a literal: `<path>#<member>` → why. None today. */
const DYNAMIC_RPC: Record<string, string> = {};

/**
 * Members a callers_pin call sits in (and helpers they reach), with every
 * call of them: `<path>#<member>` per call, one entry per call. A private
 * class member is called through `this.` in its class; a module-local
 * function in its file; anything else from anywhere in apps/web/src.
 */
const CALLER_PINS: Record<string, { callers: readonly string[]; why: string }> = {
  'server/services/inventory.ts#InventoryService.transferStock': {
    callers: [
      'app/api/v1/items/[id]/transfer/route.ts#POST',
      'server/actions/inventory.ts#bulkPlaceStockAction',
      'server/actions/inventory.ts#placeStockAction',
      'server/actions/inventory.ts#transferStockAction',
      'server/services/inventory.ts#InventoryService.moveSeededStockToUnplaced',
      'server/services/inventory.ts#InventoryService.placeItemsOntoRackByName',
      'server/services/inventory.ts#InventoryService.placeItemsOntoRackByName',
      'server/services/inventory.ts#InventoryService.placeManualCreateOnRack',
    ],
    why: "Each caller resolves the destination in the active organization (plans/S39 2.3), and transfer_stock refuses a source or a destination outside the item's own organization (0201_assert_location_in_org.sql), so an item of another organization cannot move.",
  },
  'server/services/inventory.ts#InventoryService.stampPlacementBin': {
    callers: [
      'app/api/v1/items/[id]/transfer/route.ts#POST',
      'server/actions/inventory.ts#bulkPlaceStockAction',
      'server/actions/inventory.ts#placeStockAction',
      'server/actions/inventory.ts#transferStockAction',
    ],
    why: 'Each runs it after transferStock (pinned above) moved the same items to a destination in the active organization.',
  },
  'server/services/inventory.ts#InventoryService.syncBookCratePlacement': {
    callers: [
      'app/api/v1/items/[id]/transfer/route.ts#POST',
      'server/actions/inventory.ts#bulkPlaceStockAction',
      'server/actions/inventory.ts#placeStockAction',
      'server/actions/inventory.ts#transferStockAction',
      'server/services/inventory.ts#InventoryService.bulkUpdate',
      'server/services/inventory.ts#InventoryService.removeStockFromLocation',
    ],
    why: 'After transferStock (pinned above) on the same items; bulkUpdate passes only the ids its read filtered to the active organization; removeStockFromLocation runs after adjustStock, which reads the item in the organization (get).',
  },
  'server/services/inventory.ts#InventoryService.syncBookCratePlacementInner': {
    callers: ['server/services/inventory.ts#InventoryService.syncBookCratePlacement'],
    why: 'Its only caller, pinned above.',
  },
  'server/services/returns.ts#createRequesterRpc': {
    callers: [
      'server/services/returns.ts#createMemberReturn',
      'server/services/returns.ts#createPortalReturn',
      'server/services/returns.ts#createRequesterReturn',
    ],
    why: "Each resolves the order first: by its return token, by the portal customer's own organization and customer, or by the member's active organization and own requester id (resolveMemberOrder). The audit row, the outbox row and the webhook use the organization the function answers with.",
  },
  'server/services/exception-escalation.ts#ExceptionEscalationService.finish': {
    callers: ['server/services/exception-escalation.ts#ExceptionEscalationService.escalate'],
    why: 'escalate reads the occurrence in the organization (readOccurrence) and claims it before it sends finish.',
  },
  'server/services/exception-escalation.ts#ExceptionEscalationService.release': {
    callers: [
      'server/services/exception-escalation.ts#ExceptionEscalationService.escalate',
      'server/services/exception-escalation.ts#ExceptionEscalationService.escalate',
      'server/services/exception-escalation.ts#ExceptionEscalationService.escalate',
    ],
    why: 'escalate reads the occurrence in the organization (readOccurrence) and claims it before it releases the claim.',
  },
  'server/services/bundles.ts#BundlesService.rewriteComponentsIfDropped': {
    callers: ['server/services/bundles.ts#BundlesService.update'],
    why: "Its only caller, after update's read in the organization (TABLE_WRITE_SITES).",
  },
  'server/services/tags.ts#TagsService.bulkAddToItems': {
    callers: ['server/services/inventory.ts#InventoryService.bulkUpdate'],
    why: 'bulkUpdate passes only the item ids its own read filtered to the active organization.',
  },
  'server/services/order-requests.ts#OrderRequestsService.seedGeneralLinkEntries': {
    callers: ['server/services/order-requests.ts#OrderRequestsService.rotatePublicToken'],
    why: 'rotatePublicToken passes the link it just inserted in the active organization.',
  },
};

/**
 * Members whose table writes must all follow a read of the row they hang off
 * (the kit's component rows, S39; the warehouse edit and its charter links,
 * S41): `<path>#<member>` → the gate that must precede the member's first
 * write to any table (or callers_pin: the member is in CALLER_PINS).
 */
const TABLE_WRITE_SITES: Record<string, readonly [Gate | 'callers_pin', string]> = {
  'server/services/bundles.ts#BundlesService.update': [
    'readInActiveOrg',
    "S39 site 8 (kit save): the kit row's update is filtered to the organization, but the component rows are upserted and deleted by bundle_id alone, which the component policy admits for a manager of the kit's own organization.",
  ],
  'server/services/bundles.ts#BundlesService.rewriteComponentsIfDropped': [
    'callers_pin',
    'Upserts the component rows by bundle_id alone; reached only from update, after its read.',
  ],
  'server/services/warehouses.ts#WarehousesService.update': [
    'readInActiveOrg',
    "S41: the warehouse is read in the organization before its charter list is checked or written and before the row's own update, so every step and the audit row name a warehouse of the organization.",
  ],
  'server/services/warehouse-charters.ts#WarehouseChartersService.prepareSetForWarehouse': [
    'readInActiveOrg',
    'S41: the charter links are read, inserted and deleted by warehouse id; the warehouse is read in the organization first.',
  ],
};

/* ───────────────────────── table writes (S41) ───────────────────────── */

/**
 * Every update, delete and upsert whose chain does not scope itself to the
 * active organization, keyed `<path>#<member>::<table>.<op>` (one entry covers
 * every such chain of that member, table and operation).
 */
const TABLE_WRITES: Record<string, ClassifiedWrite> = {
  'app/api/admin/backfill-item-thumbs/route.ts#pointRowAt::item_images.update': [
    'not_org_data',
    'Maintenance job behind its own secret: the image rows it listed itself, in every organization.',
  ],
  'app/api/cron/drain-outbox/route.ts#runMonthlyValuation::org_connections.update': [
    'not_org_data',
    'Scheduled job: the connection row it just read; no active organization.',
  ],
  'app/api/cron/maintenance-draft-reminders/route.ts#GET::maintenance_requests.update': [
    'not_org_data',
    'Scheduled job: claims the reminder on the request row it just read; no active organization.',
  ],
  'app/api/cron/rental-overdue/route.ts#GET::rentals.update': [
    'not_org_data',
    'Scheduled job: claims and releases the reminder on the rental row it just read; no active organization.',
  ],
  'app/api/cron/schedule-reminders/route.ts#GET::schedule_events.update': [
    'not_org_data',
    'Scheduled job: claims the reminder on the event row it just read; no active organization.',
  ],
  'app/api/integrations/quickbooks/callback/route.ts#GET::org_connections.update': [
    'not_org_data',
    'OAuth callback: the connection row found by the one-time state value; no active organization.',
  ],
  'app/api/integrations/sage_intacct/callback/route.ts#GET::org_connections.update': [
    'not_org_data',
    'OAuth callback: the connection row found by the one-time state value; no active organization.',
  ],
  'app/api/orders/sign/route.ts#POST::delivery_locations.delete': [
    'not_org_data',
    'Public sign link: the signature token names the order; no active organization.',
  ],
  'app/api/v1/me/announcements/route.ts#POST::user_onboarding.upsert': [
    'own_row',
    "The caller's own onboarding row.",
  ],
  'app/api/v1/push/register/route.ts#DELETE::push_tokens.delete': [
    'own_row',
    "The caller's own push token.",
  ],
  'app/api/webhooks/easypost/route.ts#POST::carrier_shipments.update': [
    'not_org_data',
    "Carrier webhook: the shipment row matched by the carrier's own ids; no active organization.",
  ],
  'app/api/webhooks/stripe/route.ts#POST::billing_events.update': [
    'not_org_data',
    "Billing webhook: the event ledger, keyed by the provider's event id; no organization's row.",
  ],
  'app/api/webhooks/stripe/route.ts#POST::billing_events.upsert': [
    'not_org_data',
    "Billing webhook: the event ledger, keyed by the provider's event id; no organization's row.",
  ],
  'app/unsubscribe/route.ts#POST::public_email_unsubscribes.upsert': [
    'not_org_data',
    'Public unsubscribe link: keyed by the signed email address; no active organization.',
  ],
  'lib/auth/api-key.ts#withApiKey::api_keys.update': [
    'not_org_data',
    'Stamps last-used on the key row the request authenticated with.',
  ],
  'lib/auth/login-device.ts#noteLoginDevice::user_login_devices.update': [
    'not_org_data',
    "The signing-in person's own device row, read just above.",
  ],
  'lib/books/lookup.ts#writeBookCache::book_metadata_cache.upsert': [
    'not_org_data',
    "Shared book metadata cache keyed by ISBN; no organization's row.",
  ],
  'lib/onboarding/actions.ts#recordTourOutcomeAction::user_onboarding.upsert': [
    'own_row',
    "The caller's own onboarding row.",
  ],
  'lib/rate-limit.ts#__resetRateLimitsForTests::rate_limit_buckets.delete': [
    'not_org_data',
    "Test helper for the rate limit buckets; no organization's row.",
  ],
  'server/actions/appearance.ts#setMyAppearanceAction::user_appearance.upsert': [
    'own_row',
    "The caller's own appearance row.",
  ],
  'server/actions/onboarding.ts#dismissOnboardingAction::user_profiles.update': [
    'own_row',
    "The caller's own profile.",
  ],
  'server/actions/org-switcher.ts#switchOrganizationAction::user_profiles.update': [
    'own_row',
    "The caller's own profile: the default organization, after the membership check.",
  ],
  'server/actions/organization.ts#createOrganizationAction::organizations.delete': [
    'not_org_data',
    'Sign-up: removes the organization this same action just created when a later step failed.',
  ],
  'server/actions/organization.ts#createOrganizationAction::user_profiles.update': [
    'own_row',
    "The caller's own profile: the default organization they just created.",
  ],
  'server/actions/platform-admin.ts#createOrgForCustomerAction::organizations.delete': [
    'not_org_data',
    'Platform console: removes the organization this same action just created when a later step failed.',
  ],
  'server/actions/platform-admin.ts#createOrgForCustomerAction::user_profiles.update': [
    'not_org_data',
    'Platform console: the profile of the account this same action just created.',
  ],
  'server/actions/platform-admin.ts#createOrgForCustomerAction::user_profiles.upsert': [
    'not_org_data',
    'Platform console: the profile of the account this same action just created.',
  ],
  'server/actions/platform-admin.ts#removeOrgAction::organizations.delete': [
    'not_org_data',
    'Platform console (platform administrators, passphrase): names the organization to remove.',
  ],
  'server/actions/platform-admin.ts#setOrgDeletionPassphraseAction::platform_settings.upsert': [
    'not_org_data',
    "Platform console: a platform setting; no organization's row.",
  ],
  'server/actions/profile.ts#setAvatarUrlAction::user_profiles.update': [
    'own_row',
    "The caller's own profile.",
  ],
  'server/actions/profile.ts#updateProfileNameAction::user_profiles.update': [
    'own_row',
    "The caller's own profile.",
  ],
  'server/actions/team.ts#acceptInviteWithSignupAction::user_profiles.upsert': [
    'not_org_data',
    'Sign-up from an invite: the profile of the account this same action just created.',
  ],
  'server/connectors/drainer.ts#makeDeps::connection_mappings.upsert': [
    'not_org_data',
    'Outbox worker: mappings of the connection it is draining, whose row carries the organization.',
  ],
  'server/connectors/drainer.ts#runDrain::connection_sync_log.delete': [
    'not_org_data',
    'Outbox worker: the sync log row of the connection and event it is draining.',
  ],
  'server/connectors/drainer.ts#runDrain::connection_sync_log.update': [
    'not_org_data',
    'Outbox worker: the sync log row of the connection and event it is draining.',
  ],
  'server/connectors/drainer.ts#runDrain::connection_sync_log.upsert': [
    'not_org_data',
    'Outbox worker: the sync log row of the connection and event it is draining.',
  ],
  'server/connectors/drainer.ts#runDrain::org_connections.update': [
    'not_org_data',
    'Outbox worker: the connection row it is draining.',
  ],
  'server/connectors/quickbooks/valuation.ts#maybePostMonthlyValuation::org_connections.update': [
    'not_org_data',
    'Scheduled job: the connection row handed to it by the job that read it.',
  ],
  'server/email/maintenance-resolved.ts#maybeSendMaintenanceResolvedEmail::maintenance_requests.update':
    [
      'not_org_data',
      'Claims the one resolution email on the request row the sender read; the row carries its own organization.',
    ],
  'server/email/return-prompt.ts#maybeSendReturnPrompt::order_requests.update': [
    'not_org_data',
    'Claims the one return prompt on the order row the sender read; the row carries its own organization.',
  ],
  'server/services/billing.ts#syncSubscriptionFromStripe::organizations.update': [
    'not_org_data',
    'Billing webhook: the organization found by its billing customer id; no active organization.',
  ],
  'server/services/bundles.ts#BundlesService.rewriteComponentsIfDropped::bundle_components.upsert':
    ['callers_pin', 'Reached only from update, after its read.'],
  'server/services/bundles.ts#BundlesService.update::bundle_components.delete': [
    'read_first:readInActiveOrg',
    'S39 site 8: component rows are written by bundle_id alone, after the kit is read in the organization (TABLE_WRITE_SITES).',
  ],
  'server/services/bundles.ts#BundlesService.update::bundle_components.upsert': [
    'read_first:readInActiveOrg',
    'S39 site 8: component rows are written by bundle_id alone, after the kit is read in the organization (TABLE_WRITE_SITES).',
  ],
  'server/services/customers.ts#CustomersService.addCatalogItem::customer_catalog.upsert': [
    'read_first:inline',
    'The customer and the item are read in the organization first; the child table has no organization column.',
  ],
  'server/services/customers.ts#CustomersService.inviteUser::customer_users.upsert': [
    'read_first:inline',
    'The customer is read in the organization first; the child table has no organization column.',
  ],
  'server/services/customers.ts#CustomersService.removeCatalogItem::customer_catalog.delete': [
    'read_first:readInActiveOrg',
    'S41: the customer is read in the organization first; the child table has no organization column.',
  ],
  'server/services/customers.ts#CustomersService.removePrice::price_list_items.delete': [
    'read_first:readInActiveOrg',
    'S41: the price list is read in the organization first; the child table has no organization column.',
  ],
  'server/services/customers.ts#CustomersService.removeUser::customer_users.delete': [
    'read_first:readInActiveOrg',
    'S41: the customer is read in the organization first; the child table has no organization column.',
  ],
  'server/services/customers.ts#CustomersService.setPrice::price_list_items.upsert': [
    'read_first:inline',
    'The price list and the item are read in the organization first; the child table has no organization column.',
  ],
  'server/services/cycle-counts.ts#CycleCountsService.clearCount::cycle_count_lines.update': [
    'read_first:assertSessionAccess',
    'The count is read in the organization first; the line is named by count and line id.',
  ],
  'server/services/cycle-counts.ts#CycleCountsService.recordCount::cycle_count_lines.update': [
    'read_first:assertSessionAccess',
    'The count is read in the organization first; the line is named by count and line id.',
  ],
  'server/services/delivery-tracking.ts#DeliveryTrackingService.shareLocation::delivery_locations.upsert':
    [
      'read_first:inline',
      'The order is read in the organization first; the row is stamped with it.',
    ],
  'server/services/delivery-tracking.ts#getPublicDriverLocation::charters.update': [
    'not_org_data',
    "Public tracking link: caches the geocode on the charter the token's order delivers to.",
  ],
  'server/services/email-change.ts#reconcileProfileEmail::user_profiles.update': [
    'own_row',
    'The profile of the account whose verified email changed.',
  ],
  'server/services/intacct-import.ts#importItemsFromIntacct::org_connections.update': [
    'row_in_hand',
    'The connection row read in the organization just above.',
  ],
  'server/services/integration-events.ts#claimDelivery::integration_deliveries.update': [
    'not_org_data',
    'Delivery worker: the delivery row it read, claimed by id, status and attempt count.',
  ],
  'server/services/integration-events.ts#dispatchEventNow::integration_deliveries.upsert': [
    'not_org_data',
    'Delivery rows for the endpoints read in the organization the caller names; keyed by endpoint and event.',
  ],
  'server/services/integration-events.ts#drainIntegrationDeliveries::integration_deliveries.update':
    ['not_org_data', 'Delivery worker: the delivery rows it just read; no active organization.'],
  'server/services/integration-events.ts#finalize::integration_deliveries.update': [
    'not_org_data',
    'Delivery worker: the delivery row it claimed.',
  ],
  'server/services/integration-events.ts#finalize::integration_endpoints.update': [
    'not_org_data',
    'Delivery worker: the endpoint row of the delivery it claimed.',
  ],
  'server/services/notification-preferences.ts#writeDigestPrefs::user_profiles.update': [
    'own_row',
    "The caller's own profile.",
  ],
  'server/services/notification-preferences.ts#writeNotificationPrefs::notification_preferences.upsert':
    ['own_row', "The caller's own notification preferences."],
  'server/services/notifications.ts#NotificationsService.markRead::notifications.update': [
    'own_row',
    "The caller's own notification.",
  ],
  'server/services/order-requests.ts#OrderRequestsService.assignDelivery::schedule_events.update': [
    'read_first:requireWarehouseAccess',
    'The order is read in the organization first; its schedule entry is named by the order id.',
  ],
  'server/services/order-requests.ts#OrderRequestsService.bringOrderEventInStep::schedule_events.update':
    [
      'row_in_hand',
      'The schedule entry this method just read for an order of the organization, by id and start time.',
    ],
  'server/services/order-requests.ts#OrderRequestsService.cancel::delivery_locations.delete': [
    'read_first:readInActiveOrg',
    'S39 site 1: after the order is read in the organization.',
  ],
  'server/services/order-requests.ts#OrderRequestsService.removeLine::order_request_lines.delete': [
    'read_first:loadEditableOrderHeader',
    'The order is read in the organization first; the line is named by line and order id.',
  ],
  'server/services/order-requests.ts#OrderRequestsService.seedGeneralLinkEntries::public_link_catalog_entries.upsert':
    [
      'callers_pin',
      'The link is the one its only caller just created in the organization; the items are read in it.',
    ],
  'server/services/order-requests.ts#OrderRequestsService.updateLineQuantity::order_request_lines.update':
    [
      'read_first:loadEditableOrderHeader',
      'The order is read in the organization first; the line is named by line and order id.',
    ],
  'server/services/order-requests.ts#syncOrderScheduleEvent::schedule_events.update': [
    'row_in_hand',
    "Closes the schedule entry of an order by the order's id; every caller names an order it read in the organization or one the function just changed (plans/S39 1.3).",
  ],
  'server/services/platform/account-status.ts#disableUserAccount::user_profiles.update': [
    'not_org_data',
    "Platform console: an account, not an organization's row.",
  ],
  'server/services/platform/account-status.ts#reenableUserAccount::user_profiles.update': [
    'not_org_data',
    "Platform console: an account, not an organization's row.",
  ],
  'server/services/platform/billing.ts#setBilling::organizations.update': [
    'not_org_data',
    'Platform console: names the organization whose billing it sets.',
  ],
  'server/services/platform/billing.ts#startTrial::organizations.update': [
    'not_org_data',
    'Platform console: names the organization whose trial it starts.',
  ],
  'server/services/platform/impersonation.ts#startActingAs::user_profiles.update': [
    'not_org_data',
    "Platform console: the platform administrator's own profile.",
  ],
  'server/services/platform/impersonation.ts#stopActingAs::organization_members.delete': [
    'not_org_data',
    "Platform console: the administrator's own temporary membership, by the session's organization.",
  ],
  'server/services/platform/impersonation.ts#stopActingAs::platform_impersonation_sessions.update':
    ['not_org_data', "Platform console: the administrator's own session row."],
  'server/services/platform/impersonation.ts#stopActingAs::user_profiles.update': [
    'not_org_data',
    "Platform console: the platform administrator's own profile.",
  ],
  'server/services/platform/impersonation.ts#sweepExpiredImpersonations::organization_members.delete':
    ['not_org_data', 'Scheduled sweep of expired platform sessions; no active organization.'],
  'server/services/platform/impersonation.ts#sweepExpiredImpersonations::platform_impersonation_sessions.update':
    ['not_org_data', 'Scheduled sweep of expired platform sessions; no active organization.'],
  'server/services/platform/impersonation.ts#sweepExpiredImpersonations::user_profiles.update': [
    'not_org_data',
    'Scheduled sweep of expired platform sessions; no active organization.',
  ],
  'server/services/po-imports-lines.ts#createItemsFromPoLines::po_import_lines.update': [
    'row_in_hand',
    "The import is read in the organization its caller passes (the context's), and the lines are read by that import id.",
  ],
  'server/services/po-imports.ts#PoImportsService.approve::po_import_lines.update': [
    'read_first:get',
    'The import and its lines are read in the organization first (get).',
  ],
  'server/services/po-imports.ts#PoImportsService.confirmLineMappings::po_import_lines.update': [
    'read_first:get',
    'The import and its lines are read in the organization first (get); a line outside it is refused.',
  ],
  'server/services/po-imports.ts#PoImportsService.parseImport::po_import_lines.delete': [
    'read_first:inline',
    'The import is read in the organization first; its lines are named by the import id.',
  ],
  'server/services/po-imports.ts#PoImportsService.parseImport::po_imports.update': [
    'read_first:inline',
    'The import is read in the organization first.',
  ],
  'server/services/portal.ts#resolvePortalContext::customer_users.update': [
    'not_org_data',
    "Portal sign-in: stamps acceptance on the signed-in customer's own row.",
  ],
  'server/services/price-tracking.ts#recordBookObservation::inventory_items.update': [
    'row_in_hand',
    'The item row handed in by a caller that read it in the organization the write is filtered to.',
  ],
  'server/services/public-links.ts#PublicLinksService.addEntries::public_link_catalog_entries.upsert':
    [
      'read_first:assertLinkInOrg',
      'The link is read in the organization first; the child table has no organization column.',
    ],
  'server/services/public-links.ts#PublicLinksService.removeEntries::public_link_catalog_entries.delete':
    [
      'read_first:assertLinkInOrg',
      'The link is read in the organization first; the child table has no organization column.',
    ],
  'server/services/push.ts#notifyUser::push_tokens.delete': [
    'not_org_data',
    "Removes a push token the push service reported dead; a device row, no organization's.",
  ],
  'server/services/restore-points.ts#pruneSnapshots::restore_points.delete': [
    'not_org_data',
    'Prunes the snapshot rows it just read for the organization the job names.',
  ],
  'server/services/returns.ts#RMAService.cancelReplacement::delivery_locations.delete': [
    'read_first:factsInActiveOrg',
    'The RMA is read in the organization first; the order id is the one the function answered with.',
  ],
  'server/services/shipping.ts#ShippingService.reapStuckShipment::carrier_shipments.update': [
    'not_org_data',
    "Scheduled reaper: the stuck shipment row it read, filtered to that row's own organization.",
  ],
  'server/services/size-counts.ts#SizeCountsService.appendEvents::size_count_events.upsert': [
    'read_first:inline',
    'The session is read in the organization first; the rows are stamped with it.',
  ],
  'server/services/support-tickets.ts#updateSupportTicket::support_tickets.update': [
    'not_org_data',
    'Platform console: support tickets across organizations.',
  ],
  'server/services/tags.ts#TagsService.bulkAddToItems::item_tags.upsert': [
    'callers_pin',
    "The tags are read in the organization here; the item ids are its caller's, pinned.",
  ],
  'server/services/tags.ts#TagsService.bulkRemoveFromItems::item_tags.delete': [
    'read_first:inline',
    'The tags and the items are read in the organization first, and every id must be found.',
  ],
  'server/services/tags.ts#TagsService.setForItem::item_tags.delete': [
    'read_first:inline',
    'The tags and the item are read in the organization first; the link table has no organization column.',
  ],
  'server/services/team.ts#TeamService.removeMember::user_profiles.update': [
    'read_first:inline',
    "The member is read in the organization first; clears that organization as the removed person's default.",
  ],
  'server/services/team.ts#TeamService.removeMember::user_warehouse_assignments.delete': [
    'read_first:inline',
    "The member is read in the organization first; the warehouses are the organization's own.",
  ],
  'server/services/team.ts#acceptInviteWithToken::organization_invites.update': [
    'not_org_data',
    'Invite acceptance: the invite row found by its token; the person is not a member yet.',
  ],
  'server/services/team.ts#acceptInviteWithToken::user_profiles.update': [
    'own_row',
    "The accepting person's own profile.",
  ],
  'server/services/uom-conversions.ts#UomConversionsService.upsert::uom_conversions.update': [
    'read_first:inline',
    "The row's id comes from a read in the organization just above.",
  ],
  'server/services/vendor-item-mappings.ts#VendorItemMappingsService.upsert::vendor_item_mappings.update':
    ['read_first:inline', "The row's id comes from a read in the organization just above."],
};

/**
 * Writes filtered to the active organization and named by a row id that
 * neither ask their row back nor follow a read of it, with the reason none is
 * needed: `<path>#<member>::<table>.<op>` → why.
 */
const ROW_PROOF_EXEMPT: Record<string, string> = {
  'app/api/public/v1/hooks/[id]/route.ts#DELETE::integration_endpoints.delete':
    'Public API unsubscribe: answers 200 whether or not a row went, by contract, and records nothing.',
  'server/services/item-imports.ts#ItemImportBatchesService.recordOutcome::item_import_batches.update':
    'The batch row this same import claimed moments earlier; nothing is recorded.',
  'server/services/item-imports.ts#ItemImportBatchesService.release::item_import_batches.update':
    'The batch row this same import claimed moments earlier; nothing is recorded.',
  'server/services/order-requests.ts#OrderRequestsService.announceLineChange::order_requests.update':
    'Best-effort touch of the order header after a line change; its callers read the order in the organization.',
  'server/services/shipping.ts#ShippingService.buyReturnLabel::carrier_shipments.update':
    'The draft shipment row this same call just inserted.',
  'server/services/shipping.ts#ShippingService.discardReturnDraft::carrier_shipments.update':
    'Best-effort cleanup of the draft row its caller just inserted.',
  'server/services/shipping.ts#ShippingService.getRates::carrier_shipments.update':
    'The draft shipment row this same call just inserted.',
  'server/services/shipping.ts#ShippingService.rollbackClaim::carrier_shipments.update':
    'Best-effort release of the claim this same call took on the row.',
};

/** The twelve write paths of plans/S39 2.1, for the mutation proof below. */
const S39_SITES: ReadonlyArray<{ file: string; member: string; names: string }> = [
  {
    file: 'server/services/order-requests.ts',
    member: 'OrderRequestsService.cancel',
    names: 'cancel_order_request',
  },
  {
    file: 'server/services/order-requests.ts',
    member: 'OrderRequestsService.confirmPhysicalSignature',
    names: 'confirm_physical_signature',
  },
  {
    file: 'server/services/cycle-counts.ts',
    member: 'CycleCountsService.release',
    names: 'release_cycle_count',
  },
  {
    file: 'server/services/cycle-counts.ts',
    member: 'CycleCountsService.forceReassign',
    names: 'force_reassign_cycle_count',
  },
  {
    file: 'server/services/receiving.ts',
    member: 'ReceivingService.postReceipt',
    names: 'post_receipt_v2',
  },
  {
    file: 'server/services/receiving.ts',
    member: 'ReceivingService.reverseReceipt',
    names: 'reverse_receipt',
  },
  { file: 'server/services/rentals.ts', member: 'RentalsService.create', names: 'create_rental' },
  {
    file: 'server/services/bundles.ts',
    member: 'BundlesService.update',
    names: 'BundlesService.update',
  },
  {
    file: 'server/services/bundles.ts',
    member: 'BundlesService.assemble',
    names: 'assemble_bundle',
  },
  {
    file: 'server/services/bundles.ts',
    member: 'BundlesService.distribute',
    names: 'distribute_bundle',
  },
  {
    file: 'server/actions/movements.ts',
    member: 'editMovementNoteAction',
    names: 'edit_movement_note',
  },
  { file: 'app/api/v1/movements/[id]/note/route.ts', member: 'PATCH', names: 'edit_movement_note' },
];

/**
 * The table writes S41 changed, for the mutation proof below: what is taken
 * out of the member (`rows`: the `.select('id')` that asks the row back;
 * `read`: the readInActiveOrg call; `filter`: the organization filter) and
 * the words the guard must then say about `write`.
 *
 * ScheduleService.delete is not here: a read of the event precedes its
 * delete, which this scan accepts as the row's proof without seeing that a
 * miss refuses. row-writes.other-organization.test.ts covers it.
 */
const S41_SITES: ReadonlyArray<{
  file: string;
  member: string;
  write: string;
  remove: 'rows' | 'read' | 'filter';
}> = [
  ...(['archive', 'restore', 'setActive'] as const).map((m) => ({
    file: 'server/services/bundles.ts',
    member: `BundlesService.${m}`,
    write: 'bundles.update',
    remove: 'rows' as const,
  })),
  {
    file: 'server/services/tags.ts',
    member: 'TagsService.delete',
    write: 'tags.delete',
    remove: 'rows',
  },
  {
    file: 'server/services/uom-conversions.ts',
    member: 'UomConversionsService.delete',
    write: 'uom_conversions.delete',
    remove: 'rows',
  },
  {
    file: 'server/services/charters.ts',
    member: 'ChartersService.update',
    write: 'charters.update',
    remove: 'rows',
  },
  {
    file: 'server/services/vendor-item-mappings.ts',
    member: 'VendorItemMappingsService.delete',
    write: 'vendor_item_mappings.delete',
    remove: 'rows',
  },
  {
    file: 'server/services/order-requests.ts',
    member: 'OrderRequestsService.setWarehousePublicOrderable',
    write: 'warehouses.update',
    remove: 'rows',
  },
  {
    file: 'server/services/team.ts',
    member: 'TeamService.revokeInvite',
    write: 'organization_invites.delete',
    remove: 'rows',
  },
  {
    file: 'server/services/warehouses.ts',
    member: 'WarehousesService.update',
    write: 'WarehousesService.update',
    remove: 'read',
  },
  {
    file: 'server/services/warehouse-charters.ts',
    member: 'WarehouseChartersService.prepareSetForWarehouse',
    write: 'WarehouseChartersService.prepareSetForWarehouse',
    remove: 'read',
  },
  {
    file: 'server/services/customers.ts',
    member: 'CustomersService.removePrice',
    write: 'price_list_items.delete',
    remove: 'read',
  },
  {
    file: 'server/services/customers.ts',
    member: 'CustomersService.removeCatalogItem',
    write: 'customer_catalog.delete',
    remove: 'read',
  },
  {
    file: 'server/services/customers.ts',
    member: 'CustomersService.removeUser',
    write: 'customer_users.delete',
    remove: 'read',
  },
  {
    file: 'server/services/cycle-counts.ts',
    member: 'CycleCountsService.markAiScanConfirmed',
    write: 'cycle_count_ai_scans.update',
    remove: 'filter',
  },
  {
    file: 'server/services/delivery-tracking.ts',
    member: 'DeliveryTrackingService.purgeForOrder',
    write: 'delivery_locations.delete',
    remove: 'filter',
  },
];

/* ───────────────────────────── source scan ───────────────────────────── */

interface Tree {
  files: readonly string[];
  read(file: string): string;
}

interface Member {
  file: string;
  key: string;
  node: ts.Node;
  /** The enclosing class, for a class member. */
  className: string | null;
  /** Who may call it: `class` (private member), `file` (module-local), `global`. */
  scope: 'class' | 'file' | 'global';
  simpleName: string;
}

interface RpcSite {
  file: string;
  member: string;
  fn: string | null;
  line: number;
  pos: number;
  args: ts.Expression | undefined;
}

interface MemberScan {
  member: Member;
  rpcs: RpcSite[];
  /**
   * Gate calls in the member, by gate, at their start positions. An inline
   * gate also carries the table its chain reads (`readOf`), when the chain is
   * a `.from('<table>').select(` read.
   */
  gates: Array<{ gate: Gate; pos: number; readOf?: string }>;
  /** Calls made in the member: callee name, through `this.` or not. */
  calls: Array<{ name: string; viaThis: boolean; pos: number }>;
  /** `.from('<table>').<insert|update|upsert|delete>` in the member. */
  tableWrites: TableWrite[];
}

type WriteOp = 'insert' | 'update' | 'upsert' | 'delete';

interface TableWrite {
  table: string;
  op: WriteOp;
  pos: number;
  line: number;
  /** `.eq('organization_id', <the context's organizationId>)` in the chain. */
  contextOrg: boolean;
  /** The `organizations` row itself: `.eq('id', <the context's organizationId>)`. */
  orgRow: boolean;
  /** `.eq('id', …)` in the chain: the write is named by a row id. */
  byId: boolean;
  /** `.eq('user_id' | 'id', <…userId>)`, or an upsert on conflict user_id. */
  ownRow: boolean;
  /** `.select(` in the chain, or later on the variable that holds the chain. */
  asksRows: boolean;
  /** An upsert's `onConflict` columns, when the option is a literal. */
  onConflict: readonly string[];
}

function unwrap(node: ts.Node): ts.Node {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isSatisfiesExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  const u = unwrap(node);
  return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : null;
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function isPrivateMember(node: ts.ClassElement): boolean {
  if (node.name && ts.isPrivateIdentifier(node.name)) return true;
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)
  );
}

function members(file: string, sf: ts.SourceFile): Member[] {
  const out: Member[] = [];
  const nameOf = (n: ts.PropertyName | undefined) => (n ? n.getText(sf) : 'constructor');
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st)) {
      const cls = st.name?.text ?? '<anonymous class>';
      for (const m of st.members) {
        const simpleName = nameOf(m.name);
        out.push({
          file,
          key: `${cls}.${simpleName}`,
          node: m,
          className: cls,
          scope: isPrivateMember(m) ? 'class' : 'global',
          simpleName,
        });
      }
    } else if (ts.isFunctionDeclaration(st)) {
      const name = st.name?.text ?? '<default>';
      out.push({
        file,
        key: name,
        node: st,
        className: null,
        scope: isExported(st) ? 'global' : 'file',
        simpleName: name,
      });
    } else if (ts.isVariableStatement(st)) {
      const exported = isExported(st);
      for (const d of st.declarationList.declarations) {
        const base = d.name.getText(sf);
        const init = d.initializer ? unwrap(d.initializer) : undefined;
        if (init && ts.isObjectLiteralExpression(init)) {
          for (const p of init.properties) {
            const simpleName = nameOf(p.name);
            out.push({
              file,
              key: `${base}.${simpleName}`,
              node: p,
              className: null,
              scope: 'global',
              simpleName,
            });
          }
        } else {
          out.push({
            file,
            key: base,
            node: d,
            className: null,
            scope: exported ? 'global' : 'file',
            simpleName: base,
          });
        }
      }
    } else {
      out.push({
        file,
        key: '<top-level>',
        node: st,
        className: null,
        scope: 'file',
        simpleName: '<top-level>',
      });
    }
  }
  return out;
}

const GATE_NAMES = new Set(Object.keys(GATES).filter((g) => g !== 'inline' && g !== 'get'));

/** `ctx.organizationId` or `<x>.ctx.organizationId`: the context's organization. */
function isContextOrganization(node: ts.Node, aliases: ReadonlySet<string>): boolean {
  const u = unwrap(node);
  if (ts.isIdentifier(u)) return aliases.has(u.text);
  if (!ts.isPropertyAccessExpression(u) || u.name.text !== 'organizationId') return false;
  const owner = unwrap(u.expression);
  return (
    (ts.isIdentifier(owner) && owner.text === 'ctx') ||
    (ts.isPropertyAccessExpression(owner) && owner.name.text === 'ctx')
  );
}

/** Parents of `node`, skipping the wrappers `unwrap` removes on the way down. */
function parentOf(node: ts.Node): ts.Node {
  let p = node.parent;
  while (
    p &&
    (ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isAwaitExpression(p))
  ) {
    p = p.parent;
  }
  return p;
}

/** The `.from(<x>)` call a query chain starts from, walking down its receivers. */
function fromCallOf(node: ts.Node): ts.CallExpression | null {
  let e = unwrap(node);
  while (ts.isCallExpression(e)) {
    const callee = unwrap(e.expression);
    if (!ts.isPropertyAccessExpression(callee)) return null;
    if (callee.name.text === 'from') return e;
    e = unwrap(callee.expression);
  }
  return null;
}

/** The identifier a call chain hangs off (`q` in `q.eq(…).select(…)`), if any. */
function rootIdentifier(node: ts.Node): string | null {
  let e = unwrap(node);
  for (;;) {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e)) e = unwrap(e.expression);
    else return null;
  }
}

const WRITE_OPS: readonly string[] = ['insert', 'update', 'upsert', 'delete'];

function scanMember(member: Member, sf: ts.SourceFile): MemberScan {
  const scan: MemberScan = { member, rpcs: [], gates: [], calls: [], tableWrites: [] };
  /** Table writes held in a variable (`let q = ….update(…)`), by its name. */
  const held = new Map<TableWrite, string>();
  /** Identifiers some chain calls `.select(` on. */
  const selectRoots = new Set<string>();
  // `const orgId = this.ctx.organizationId` anywhere in the member.
  const aliases = new Set<string>();
  const collect = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      isContextOrganization(n.initializer, new Set())
    ) {
      aliases.add(n.name.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(member.node);

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      const pos = n.getStart(sf);
      if (ts.isIdentifier(callee)) {
        scan.calls.push({ name: callee.text, viaThis: false, pos });
        if (GATE_NAMES.has(callee.text)) scan.gates.push({ gate: callee.text as Gate, pos });
      } else if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text;
        const receiver = unwrap(callee.expression);
        const viaThis = receiver.kind === ts.SyntaxKind.ThisKeyword;
        scan.calls.push({ name, viaThis, pos });
        if (GATE_NAMES.has(name)) scan.gates.push({ gate: name as Gate, pos });
        if (name === 'get' && viaThis) scan.gates.push({ gate: 'get', pos });
        if (
          name === 'eq' &&
          literalText(n.arguments[0]) === 'organization_id' &&
          n.arguments[1] &&
          isContextOrganization(n.arguments[1], aliases)
        ) {
          const from = fromCallOf(callee.expression);
          const first = from ? parentOf(from) : null;
          const readOf =
            from && first && ts.isPropertyAccessExpression(first) && first.name.text === 'select'
              ? (literalText(from.arguments[0]) ?? undefined)
              : undefined;
          scan.gates.push({ gate: 'inline', pos, ...(readOf ? { readOf } : {}) });
        }
        if (name === 'select') {
          const root = rootIdentifier(callee.expression);
          if (root) selectRoots.add(root);
        }
        if (name === 'rpc') {
          scan.rpcs.push({
            file: member.file,
            member: member.key,
            fn: literalText(n.arguments[0]),
            line: sf.getLineAndCharacterOfPosition(pos).line + 1,
            pos,
            args: n.arguments[1],
          });
        }
        // `.from('<table>').<write>(…)` on a database client (a storage
        // bucket's `.from(` hangs off `.storage`).
        const onStorage =
          ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'storage';
        if (name === 'from' && !onStorage) {
          const table = literalText(n.arguments[0]);
          const parent = parentOf(n);
          if (
            table &&
            ts.isPropertyAccessExpression(parent) &&
            WRITE_OPS.includes(parent.name.text) &&
            ts.isCallExpression(parent.parent)
          ) {
            const op = parent.name.text as WriteOp;
            const write: TableWrite = {
              table,
              op,
              pos,
              line: sf.getLineAndCharacterOfPosition(pos).line + 1,
              contextOrg: false,
              orgRow: false,
              byId: false,
              ownRow: false,
              asksRows: false,
              onConflict: [],
            };
            if (op === 'upsert') {
              const options = parent.parent.arguments[1];
              const o = options ? unwrap(options) : undefined;
              if (o && ts.isObjectLiteralExpression(o)) {
                for (const prop of o.properties) {
                  if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'onConflict') {
                    write.onConflict = (literalText(prop.initializer) ?? '')
                      .split(',')
                      .map((c) => c.trim())
                      .filter(Boolean);
                  }
                }
              }
              if (write.onConflict.length === 1 && write.onConflict[0] === 'user_id') {
                write.ownRow = true;
              }
            }
            // The rest of the chain: every `.method(…)` called on the write.
            let top: ts.Node = parent.parent;
            for (;;) {
              const access = parentOf(top);
              if (
                !access ||
                !ts.isPropertyAccessExpression(access) ||
                !ts.isCallExpression(access.parent) ||
                access.parent.expression !== access
              ) {
                break;
              }
              const link = access.parent;
              const method = access.name.text;
              if (method === 'select') write.asksRows = true;
              if (method === 'eq' && link.arguments[1]) {
                const column = literalText(link.arguments[0]);
                const value = link.arguments[1];
                const isOrg = isContextOrganization(value, aliases);
                if (column === 'organization_id' && isOrg) write.contextOrg = true;
                if (column === 'id') {
                  write.byId = true;
                  if (table === 'organizations' && isOrg) write.orgRow = true;
                }
                if (
                  (column === 'user_id' || column === 'id') &&
                  /(^|\.)[A-Za-z]*[uU]serId$/.test(unwrap(value).getText(sf))
                ) {
                  write.ownRow = true;
                }
              }
              top = link;
            }
            const holder = parentOf(top);
            if (holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
              held.set(write, holder.name.text);
            }
            scan.tableWrites.push(write);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(member.node);
  for (const [write, name] of held) {
    if (selectRoots.has(name)) write.asksRows = true;
  }
  return scan;
}

const parsed = new Map<string, { source: string; scans: MemberScan[] }>();

/** Every member of a file, scanned; memoized on the file's text. */
function scanFile(tree: Tree, file: string): MemberScan[] {
  const source = tree.read(file);
  const hit = parsed.get(file);
  if (hit && hit.source === source) return hit.scans;
  const sf = parse(file, source);
  const scans = members(file, sf).map((m) => scanMember(m, sf));
  parsed.set(file, { source, scans });
  return scans;
}

function sourceFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...sourceFiles(path.join(dir, e.name), relPath));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name))
      out.push(relPath);
  }
  return out.sort();
}

let diskTree: Tree | null = null;
function realTree(): Tree {
  if (!diskTree) {
    const cache = new Map<string, string>();
    diskTree = {
      files: sourceFiles(SRC_DIR),
      read(file) {
        let s = cache.get(file);
        if (s === undefined) {
          s = readFileSync(path.join(SRC_DIR, file), 'utf8');
          cache.set(file, s);
        }
        return s;
      },
    };
  }
  return diskTree;
}

/** The same tree with one file's text replaced. */
function withFile(tree: Tree, file: string, source: string): Tree {
  return { files: tree.files, read: (f) => (f === file ? source : tree.read(f)) };
}

/* ─────────────────────── migration volatility ─────────────────────── */

/**
 * public function name → volatility of its LATEST definition across the
 * ordered migrations (`create function` headers and trailers, `alter function
 * ... stable|volatile|immutable`, and `alter function ... set schema` moving a
 * body out of public).
 */
function migrationVolatility(): Map<string, 'immutable' | 'stable' | 'volatile'> {
  const out = new Map<string, 'immutable' | 'stable' | 'volatile'>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const header =
    /create\s+(?:or\s+replace\s+)?function\s+(?:(public|ledger)\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  const alterVol =
    /alter\s+function\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\([^)]*\)\s*(immutable|stable|volatile)\b/gi;
  const alterSchema =
    /alter\s+function\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\([^)]*\)\s*set\s+schema\s+([a-z_]+)/gi;
  const volatilityIn = (text: string) => {
    const t = text.replace(/--[^\n]*/g, '').toLowerCase();
    if (/\bimmutable\b/.test(t)) return 'immutable' as const;
    if (/\bstable\b/.test(t)) return 'stable' as const;
    return 'volatile' as const;
  };
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const events: Array<{ at: number; apply: () => void }> = [];
    let m: RegExpExecArray | null;
    header.lastIndex = 0;
    while ((m = header.exec(sql))) {
      if ((m[1] ?? 'public').toLowerCase() !== 'public') continue;
      const name = m[2]!.toLowerCase();
      const tagRe = /\$([a-z_]*)\$/gi;
      tagRe.lastIndex = m.index;
      const open = tagRe.exec(sql);
      if (!open) continue;
      const close = sql.indexOf(open[0], open.index + open[0].length);
      if (close < 0) continue;
      const end = sql.indexOf(';', close + open[0].length);
      const attrs =
        sql.slice(m.index, open.index) +
        ' ' +
        sql.slice(close + open[0].length, end < 0 ? undefined : end);
      const volatility = volatilityIn(attrs);
      events.push({ at: m.index, apply: () => out.set(name, volatility) });
    }
    alterVol.lastIndex = 0;
    while ((m = alterVol.exec(sql))) {
      const name = m[1]!.toLowerCase();
      const v = m[2]!.toLowerCase() as 'immutable' | 'stable' | 'volatile';
      events.push({ at: m.index, apply: () => out.set(name, v) });
    }
    alterSchema.lastIndex = 0;
    while ((m = alterSchema.exec(sql))) {
      const name = m[1]!.toLowerCase();
      if (m[2]!.toLowerCase() === 'public') continue;
      events.push({ at: m.index, apply: () => out.delete(name) });
    }
    events.sort((a, b) => a.at - b.at).forEach((e) => e.apply());
  }
  return out;
}

let volatilityMemo: Map<string, 'immutable' | 'stable' | 'volatile'> | null = null;
function volatility(): Map<string, 'immutable' | 'stable' | 'volatile'> {
  volatilityMemo ??= migrationVolatility();
  return volatilityMemo;
}

/* ─────────────────────────────── the verdict ─────────────────────────────── */

interface Lists {
  registry: Record<string, Entry>;
  orgInBuiltArgs: Record<string, string>;
  dynamicRpc: Record<string, string>;
  callerPins: Record<string, { callers: readonly string[]; why: string }>;
  tableWriteSites: Record<string, readonly [Gate | 'callers_pin', string]>;
  tableWrites: Record<string, ClassifiedWrite>;
  rowProofExempt: Record<string, string>;
}

const LISTS: Lists = {
  registry: REGISTRY,
  orgInBuiltArgs: ORG_IN_BUILT_ARGS,
  dynamicRpc: DYNAMIC_RPC,
  callerPins: CALLER_PINS,
  tableWriteSites: TABLE_WRITE_SITES,
  tableWrites: TABLE_WRITES,
  rowProofExempt: ROW_PROOF_EXEMPT,
};

const ORG_ARG = /^p_org(anization)?(_id)?$/;

/** The call passes an organization the scan can see. */
function passesOrganization(args: ts.Expression | undefined): boolean {
  if (!args) return false;
  const a = unwrap(args);
  if (!ts.isObjectLiteralExpression(a)) return false;
  return a.properties.some((p) => {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return false;
    const name = p.name.getText();
    if (ORG_ARG.test(name)) return true;
    if (!ts.isPropertyAssignment(p)) return false;
    const value = unwrap(p.initializer);
    return (
      ts.isObjectLiteralExpression(value) &&
      value.properties.some(
        (q) =>
          q.name !== undefined && /^organization_?id$|^organizationId$/i.test(q.name.getText()),
      )
    );
  });
}

function classOf(entry: Entry, member: string): Classified | undefined {
  return 'byMember' in entry ? entry.byMember[member] : entry;
}

/** Every failure of the tree against the lists, as one line each. */
function verdict(tree: Tree, lists: Lists = LISTS): string[] {
  const failures: string[] = [];
  const rpcFiles = tree.files.filter((f) => tree.read(f).includes('rpc('));
  const scans = new Map<string, MemberScan[]>();
  for (const f of rpcFiles) scans.set(f, scanFile(tree, f));

  const seenKeys = new Set<string>();
  const seenMembers = new Set<string>();
  const seenDynamic = new Set<string>();
  const usedPins = new Set<string>();

  for (const [file, fileScans] of scans) {
    for (const scan of fileScans) {
      for (const site of scan.rpcs) {
        const where = `${file}:${site.line} (${site.member})`;
        if (site.fn === null) {
          const dyn = `${file}#${site.member}`;
          seenDynamic.add(dyn);
          if (!(dyn in lists.dynamicRpc))
            failures.push(`${where}: calls .rpc( with a name that is not a literal`);
          continue;
        }
        const key = `${file}::${site.fn}`;
        seenKeys.add(key);
        const entry = lists.registry[key];
        if (!entry) {
          failures.push(`${key} at ${where} has no class`);
          continue;
        }
        const classified = classOf(entry, site.member);
        if ('byMember' in entry) seenMembers.add(`${key}@${site.member}`);
        if (!classified) {
          failures.push(`${key} at ${where}: no class for member ${site.member}`);
          continue;
        }
        const [klass, why] = classified;
        if (!why.trim()) failures.push(`${key}: the class needs a reason`);
        if (klass === 'takes_org') {
          if (!passesOrganization(site.args) && !(key in lists.orgInBuiltArgs)) {
            failures.push(
              `${key} at ${where} is takes_org but passes no organization (p_org, p_org_id, p_organization_id, or organization_id in a literal argument)`,
            );
          }
        } else if (klass.startsWith('read_first:')) {
          const gate = klass.slice('read_first:'.length) as Gate;
          if (!scan.gates.some((g) => g.gate === gate && g.pos < site.pos)) {
            failures.push(`${key} at ${where} has no ${gate} before the .rpc( call`);
          }
        } else if (klass === 'read_only') {
          const v = volatility().get(site.fn.toLowerCase());
          if (!v)
            failures.push(
              `${key}: read_only, but public.${site.fn} is not defined in the migrations`,
            );
          else if (v === 'volatile')
            failures.push(
              `${key}: read_only, but public.${site.fn} is VOLATILE in its latest migration`,
            );
        } else if (klass === 'callers_pin') {
          const pin = `${file}#${site.member}`;
          usedPins.add(pin);
          if (!(pin in lists.callerPins))
            failures.push(`${key} at ${where} is callers_pin but ${pin} is not in CALLER_PINS`);
        }
      }
    }
  }

  for (const key of Object.keys(lists.registry)) {
    if (!seenKeys.has(key)) {
      failures.push(`stale: ${key} is classified but no such .rpc( call exists`);
      continue;
    }
    const entry = lists.registry[key]!;
    if ('byMember' in entry) {
      for (const member of Object.keys(entry.byMember)) {
        if (!seenMembers.has(`${key}@${member}`))
          failures.push(`stale: ${key} has no call in ${member}`);
      }
    }
  }
  for (const key of Object.keys(lists.orgInBuiltArgs)) {
    const entry = lists.registry[key];
    if (!entry || 'byMember' in entry || entry[0] !== 'takes_org')
      failures.push(`stale: ORG_IN_BUILT_ARGS ${key} is not a takes_org key`);
  }
  for (const dyn of Object.keys(lists.dynamicRpc)) {
    if (!seenDynamic.has(dyn)) failures.push(`stale: DYNAMIC_RPC ${dyn} makes no such call`);
  }

  // Table writes S39 fixed: the gate before the member's first write.
  for (const [memberKey, [gate]] of Object.entries(lists.tableWriteSites)) {
    const [file, member] = memberKey.split('#') as [string, string];
    const scan = tree.files.includes(file)
      ? scanFile(tree, file).find((s) => s.member.key === member)
      : undefined;
    if (!scan) {
      failures.push(`stale: TABLE_WRITE_SITES ${memberKey} does not exist`);
      continue;
    }
    if (scan.tableWrites.length === 0) {
      failures.push(`stale: TABLE_WRITE_SITES ${memberKey} writes no table`);
      continue;
    }
    if (gate === 'callers_pin') {
      usedPins.add(memberKey);
      if (!(memberKey in lists.callerPins))
        failures.push(`${memberKey} is callers_pin but not in CALLER_PINS`);
      continue;
    }
    const firstWrite = Math.min(...scan.tableWrites.map((w) => w.pos));
    if (!scan.gates.some((g) => g.gate === gate && g.pos < firstWrite)) {
      failures.push(`${memberKey} has no ${gate} before its first table write`);
    }
  }

  // Table writes (S41): every update, delete and upsert stays in the active
  // organization (rule 1) and, named by a row id, proves its row (rule 2).
  const seenWrites = new Set<string>();
  const selfScoped = new Set<string>();
  const seenExempt = new Set<string>();
  for (const file of tree.files.filter((f) => tree.read(f).includes('.from('))) {
    for (const scan of scanFile(tree, file)) {
      for (const w of scan.tableWrites) {
        if (w.op === 'insert') continue;
        const key = `${file}#${scan.member.key}::${w.table}.${w.op}`;
        const where = `${file}:${w.line}`;
        const scopedByItself =
          w.contextOrg ||
          w.orgRow ||
          (w.op === 'upsert' && w.onConflict.includes('organization_id'));
        if (scopedByItself) {
          selfScoped.add(key);
          if (!w.contextOrg || !w.byId || w.op === 'upsert' || w.asksRows) continue;
          const proven = scan.gates.some(
            (g) => g.pos < w.pos && (g.gate !== 'inline' || g.readOf === w.table),
          );
          if (proven) continue;
          seenExempt.add(key);
          if (!(key in lists.rowProofExempt)) {
            failures.push(
              `${key} at ${where} is named by a row id but asks no row back and follows no read of it: a write that matched no row would be answered as done`,
            );
          }
          continue;
        }
        seenWrites.add(key);
        const entry = lists.tableWrites[key];
        if (!entry) {
          failures.push(`${key} at ${where} has no organization filter and no class`);
          continue;
        }
        const [klass, why] = entry;
        if (!why.trim()) failures.push(`${key}: the class needs a reason`);
        if (klass.startsWith('read_first:')) {
          const gate = klass.slice('read_first:'.length) as Gate;
          if (!scan.gates.some((g) => g.gate === gate && g.pos < w.pos)) {
            failures.push(`${key} at ${where} has no ${gate} before the write`);
          }
        } else if (klass === 'own_row') {
          if (!w.ownRow)
            failures.push(`${key} at ${where} is own_row but is not keyed by a user id`);
        } else if (klass === 'callers_pin') {
          const pin = `${file}#${scan.member.key}`;
          usedPins.add(pin);
          if (!(pin in lists.callerPins))
            failures.push(`${key} at ${where} is callers_pin but ${pin} is not in CALLER_PINS`);
        }
      }
    }
  }
  for (const key of Object.keys(lists.tableWrites)) {
    if (seenWrites.has(key)) continue;
    failures.push(
      selfScoped.has(key)
        ? `stale: TABLE_WRITES ${key} is filtered to the active organization by itself`
        : `stale: TABLE_WRITES ${key} is classified but no such write exists`,
    );
  }
  for (const key of Object.keys(lists.rowProofExempt)) {
    if (!lists.rowProofExempt[key]!.trim()) failures.push(`${key}: the exemption needs a reason`);
    if (!seenExempt.has(key))
      failures.push(`stale: ROW_PROOF_EXEMPT ${key} proves its row or does not exist`);
  }

  // Caller pins: the calls of each pinned member, as listed.
  for (const pin of Object.keys(lists.callerPins)) {
    for (const caller of lists.callerPins[pin]!.callers) usedPins.add(caller);
  }
  for (const [pin, { callers }] of Object.entries(lists.callerPins)) {
    if (!usedPins.has(pin)) {
      failures.push(`stale: CALLER_PINS ${pin} is not used by any class, site or pin`);
      continue;
    }
    const [file, memberKey] = pin.split('#') as [string, string];
    const target = tree.files.includes(file)
      ? scanFile(tree, file).find((s) => s.member.key === memberKey)
      : undefined;
    if (!target) {
      failures.push(`stale: CALLER_PINS ${pin} does not exist`);
      continue;
    }
    const { scope, simpleName, className } = target.member;
    const searchFiles =
      scope === 'global' ? tree.files.filter((f) => tree.read(f).includes(simpleName)) : [file];
    const actual: string[] = [];
    for (const f of searchFiles) {
      for (const s of scanFile(tree, f)) {
        if (scope === 'class' && s.member.className !== className) continue;
        for (const c of s.calls) {
          if (c.name !== simpleName) continue;
          if (scope === 'class' && !c.viaThis) continue;
          actual.push(`${f}#${s.member.key}`);
        }
      }
    }
    const got = [...actual].sort();
    const want = [...callers].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(
        `callers changed for ${pin}: expected ${JSON.stringify(want)}, found ${JSON.stringify(got)}`,
      );
    }
  }

  return failures;
}

/**
 * The tree with every call of `gate` inside one member renamed (`gate(` and
 * `gate<T>(` alike), so the gate is gone and nothing else changes.
 */
function withoutGate(tree: Tree, file: string, member: string, gate: string): Tree {
  return withMemberChanged(tree, file, member, `a call of ${gate}`, (body) =>
    body.replace(new RegExp(`\\b${gate}(?=\\s*[(<])`, 'g'), 'withoutTheGate'),
  );
}

/** The tree with one member's text changed; throws when `change` changes nothing. */
function withMemberChanged(
  tree: Tree,
  file: string,
  member: string,
  what: string,
  change: (body: string) => string,
): Tree {
  const source = tree.read(file);
  const scan = scanFile(tree, file).find((s) => s.member.key === member);
  if (!scan) throw new Error(`no member ${member} in ${file}`);
  const start = scan.member.node.getStart();
  const end = scan.member.node.getEnd();
  const body = source.slice(start, end);
  const changed = change(body);
  if (changed === body) throw new Error(`${member} in ${file} has no ${what} to remove`);
  return withFile(tree, file, source.slice(0, start) + changed + source.slice(end));
}

/* ─────────────────────────── the machinery ─────────────────────────── */

describe('the scan machinery itself', () => {
  const tree = (files: Record<string, string>): Tree => ({
    files: Object.keys(files),
    read: (f) => files[f] ?? '',
  });
  const scansOf = (src: string) => {
    parsed.clear();
    return Object.fromEntries(
      scanFile(tree({ 'x.ts': src }), 'x.ts').map((s) => [s.member.key, s]),
    );
  };

  it('attributes calls to class members, functions and object-literal methods, nested closures included', () => {
    const s = scansOf(`
      class S {
        async a() { const run = async () => { await this.ctx.supabase.rpc('one', {}); }; await run(); }
        private async b() { await this.ctx.supabase.rpc('two', {}); }
      }
      export async function top(ctx) { await ctx.supabase.rpc('three', {}); }
      export const api = { async four(sb) { await sb.rpc('four', {}); } };
    `);
    expect(s['S.a']?.rpcs.map((r) => r.fn)).toEqual(['one']);
    expect(s['S.b']?.member.scope).toBe('class');
    expect(s['top']?.member.scope).toBe('global');
    expect(s['api.four']?.rpcs.map((r) => r.fn)).toEqual(['four']);
  });

  it('sees a gate before the call, an inline read through an alias, and only this.get as get', () => {
    const s = scansOf(`
      class S {
        async a(id) { await readInActiveOrg(this.ctx, 'bundles', id, 'x'); await this.ctx.supabase.rpc('f', {}); }
        async b(id) {
          const orgId = this.ctx.organizationId;
          await this.ctx.supabase.from('t').select('id').eq('organization_id', orgId).eq('id', id);
        }
        async c(m) { m.get('k'); }
        async d(id) { await this.get(id); }
        async e(id) { await this.ctx.supabase.from('t').select('id').eq('organization_id', input.orgId); }
      }
    `);
    expect(s['S.a']?.gates.map((g) => g.gate)).toEqual(['readInActiveOrg']);
    expect(s['S.b']?.gates.map((g) => g.gate)).toEqual(['inline']);
    expect(s['S.c']?.gates).toEqual([]);
    expect(s['S.d']?.gates.map((g) => g.gate)).toEqual(['get']);
    // An organization the caller sent is not the context's.
    expect(s['S.e']?.gates).toEqual([]);
  });

  it('tells a call that passes the organization from one that does not', () => {
    const args = (src: string) =>
      scansOf(`async function f(sb) { await sb.rpc('f', ${src}); }`)['f']!.rpcs[0]!.args;
    expect(passesOrganization(args('{ p_org_id: o, p_x: 1 }'))).toBe(true);
    expect(passesOrganization(args('{ p_organization_id: o }'))).toBe(true);
    expect(passesOrganization(args('{ p_request: { organization_id: o } }'))).toBe(true);
    expect(passesOrganization(args('{ p_id: id }'))).toBe(false);
    expect(passesOrganization(args('built'))).toBe(false);
  });

  it('fails an unclassified call, a missing gate, a non-literal name and a stale entry', () => {
    parsed.clear();
    const t = tree({
      'a.ts': `class S {
        async x(id) { await this.ctx.supabase.rpc('write_it', { p_id: id }); }
        async y(n) { await this.ctx.supabase.rpc(n, {}); }
        async z(id) { await this.ctx.supabase.rpc('gated', { p_id: id }); }
      }`,
    });
    const lists: Lists = {
      registry: {
        'a.ts::gated': ['read_first:readInActiveOrg', 'test'],
        'a.ts::gone': ['not_org_data', 'test'],
      },
      orgInBuiltArgs: {},
      dynamicRpc: {},
      callerPins: {},
      tableWriteSites: {},
      tableWrites: {},
      rowProofExempt: {},
    };
    const v = verdict(t, lists);
    expect(v.some((l) => l.startsWith('a.ts::write_it') && l.includes('has no class'))).toBe(true);
    expect(v.some((l) => l.includes('not a literal'))).toBe(true);
    expect(v.some((l) => l.startsWith('a.ts::gated') && l.includes('has no readInActiveOrg'))).toBe(
      true,
    );
    expect(v.some((l) => l.startsWith('stale: a.ts::gone'))).toBe(true);
  });

  it("reads a table write's chain: its filters, whether it asks rows back, and its conflict target", () => {
    const s = scansOf(`
      class S {
        async a(id) {
          await this.ctx.supabase.from('t').update({ x: 1 }).eq('organization_id', this.ctx.organizationId).eq('id', id);
        }
        async b(id) {
          const orgId = this.ctx.organizationId;
          await this.ctx.supabase.from('t').delete().eq('id', id).eq('organization_id', orgId).select('id').maybeSingle();
        }
        async c(id) {
          let q = this.ctx.supabase.from('t').update({ x: 1 }).eq('organization_id', this.ctx.organizationId).eq('id', id);
          q = q.eq('y', 2);
          await q.select('id');
        }
        async d() { await this.ctx.supabase.from('organizations').update({ x: 1 }).eq('id', this.ctx.organizationId); }
        async e(rows) { await admin.from('t').upsert(rows, { onConflict: 'organization_id,key' }); }
        async f(id) { await this.ctx.supabase.from('t').update({ x: 1 }).eq('organization_id', input.orgId).eq('id', id); }
        async g() { await this.ctx.supabase.from('p').update({ x: 1 }).eq('id', this.ctx.userId); }
        async h(rows) { await this.ctx.supabase.from('p').upsert(rows, { onConflict: 'user_id' }); }
        async i() { await this.ctx.supabase.storage.from('bucket').update('path', body); }
      }
    `);
    const only = (k: string) => s[k]!.tableWrites[0]!;
    expect(only('S.a')).toMatchObject({ table: 't', op: 'update', contextOrg: true, byId: true });
    expect(only('S.a').asksRows).toBe(false);
    expect(only('S.b')).toMatchObject({
      op: 'delete',
      contextOrg: true,
      byId: true,
      asksRows: true,
    });
    // Rows asked for later, on the variable that holds the chain.
    expect(only('S.c')).toMatchObject({ contextOrg: true, asksRows: true });
    expect(only('S.d')).toMatchObject({ orgRow: true, contextOrg: false });
    expect(only('S.e').onConflict).toEqual(['organization_id', 'key']);
    // An organization the caller sent is not the context's.
    expect(only('S.f').contextOrg).toBe(false);
    expect(only('S.g').ownRow).toBe(true);
    expect(only('S.h').ownRow).toBe(true);
    // A storage bucket is not a table.
    expect(s['S.i']!.tableWrites).toEqual([]);
  });

  it('holds a table write to both rules: it stays in the organization, and by id it proves its row', () => {
    parsed.clear();
    const org = `.eq('organization_id', this.ctx.organizationId)`;
    const t = tree({
      'a.ts': `class S {
        async bare(id) { await this.ctx.supabase.from('child').delete().eq('parent_id', id); }
        async gated(id) {
          await readInActiveOrg(this.ctx, 'bundles', id, 'x');
          await this.ctx.supabase.from('child').delete().eq('parent_id', id);
        }
        async ungated(id) { await this.ctx.supabase.from('child').update({ x: 1 }).eq('parent_id', id); }
        async notOwn(id) { await this.ctx.supabase.from('p').update({ x: 1 }).eq('id', id); }
        async conflict(rows) { await this.ctx.supabase.from('m').upsert(rows, { onConflict: 'organization_id,module_id' }); }
        async silent(id) { await this.ctx.supabase.from('t').update({ x: 1 })${org}.eq('id', id); }
        async asked(id) { await this.ctx.supabase.from('t').update({ x: 1 })${org}.eq('id', id).select('id').maybeSingle(); }
        async readSame(id) {
          await this.ctx.supabase.from('t').select('id')${org}.eq('id', id).maybeSingle();
          await this.ctx.supabase.from('t').delete()${org}.eq('id', id);
        }
        async readOther(id) {
          await this.ctx.supabase.from('u').select('id')${org}.eq('id', id).maybeSingle();
          await this.ctx.supabase.from('t').delete()${org}.eq('id', id);
        }
        async listed(id) { await this.ctx.supabase.from('v').update({ x: 1 })${org}.eq('id', id); }
        async byKey(k) { await this.ctx.supabase.from('t').update({ x: 1 })${org}.eq('module_id', k); }
      }`,
    });
    const lists: Lists = {
      registry: {},
      orgInBuiltArgs: {},
      dynamicRpc: {},
      callerPins: {},
      tableWriteSites: {},
      tableWrites: {
        'a.ts#S.gated::child.delete': ['read_first:readInActiveOrg', 'test'],
        'a.ts#S.ungated::child.update': ['read_first:readInActiveOrg', 'test'],
        'a.ts#S.notOwn::p.update': ['own_row', 'test'],
        'a.ts#S.asked::t.update': ['row_in_hand', 'test'],
        'a.ts#S.gone::t.update': ['not_org_data', 'test'],
      },
      rowProofExempt: {
        'a.ts#S.listed::v.update': 'test',
        'a.ts#S.asked::t.update': 'test',
      },
    };
    expect(verdict(t, lists).sort()).toEqual(
      [
        'a.ts#S.bare::child.delete at a.ts:2 has no organization filter and no class',
        'a.ts#S.ungated::child.update at a.ts:7 has no readInActiveOrg before the write',
        'a.ts#S.notOwn::p.update at a.ts:8 is own_row but is not keyed by a user id',
        'a.ts#S.silent::t.update at a.ts:10 is named by a row id but asks no row back and follows no read of it: a write that matched no row would be answered as done',
        'a.ts#S.readOther::t.delete at a.ts:18 is named by a row id but asks no row back and follows no read of it: a write that matched no row would be answered as done',
        'stale: TABLE_WRITES a.ts#S.asked::t.update is filtered to the active organization by itself',
        'stale: TABLE_WRITES a.ts#S.gone::t.update is classified but no such write exists',
        'stale: ROW_PROOF_EXEMPT a.ts#S.asked::t.update proves its row or does not exist',
      ].sort(),
    );
  });

  it('counts the callers of a private member through this. in its class only', () => {
    parsed.clear();
    const t = tree({
      'a.ts': `class S {
        private async helper(id) { await this.ctx.supabase.rpc('h', { p_id: id }); }
        async one(id) { await readInActiveOrg(this.ctx, 'bundles', id, 'x'); await this.helper(id); }
        async two(other) { other.helper(1); }
      }`,
    });
    const lists: Lists = {
      registry: { 'a.ts::h': ['callers_pin', 'test'] },
      orgInBuiltArgs: {},
      dynamicRpc: {},
      callerPins: { 'a.ts#S.helper': { callers: ['a.ts#S.one'], why: 'test' } },
      tableWriteSites: {},
      tableWrites: {},
      rowProofExempt: {},
    };
    expect(verdict(t, lists)).toEqual([]);
    const added = withFile(t, 'a.ts', t.read('a.ts').replace('other.helper(1)', 'this.helper(1)'));
    expect(
      verdict(added, lists).some((l) => l.startsWith('callers changed for a.ts#S.helper')),
    ).toBe(true);
  });
});

/* ─────────────────────────────── the real tree ─────────────────────────────── */

describe('every .rpc( call in apps/web/src keeps to the active organization (S39)', () => {
  it('every call site is classified, every class holds, and no entry is stale', () => {
    expect(verdict(realTree())).toEqual([]);
  });

  it('every read_only function is STABLE or IMMUTABLE in its latest migration', () => {
    const readOnly = Object.entries(REGISTRY).flatMap(([key, entry]) =>
      ('byMember' in entry ? Object.values(entry.byMember) : [entry]).some(
        ([k]) => k === 'read_only',
      )
        ? [key.split('::')[1]!]
        : [],
    );
    expect(readOnly.length).toBeGreaterThan(40);
    const notStable = readOnly.filter(
      (fn) => !['stable', 'immutable'].includes(volatility().get(fn) ?? ''),
    );
    expect(notStable).toEqual([]);
  });

  it('a write classed read_only fails: a VOLATILE function is refused', () => {
    expect(volatility().get('cancel_order_request')).toBe('volatile');
    const lists: Lists = {
      ...LISTS,
      registry: { ...REGISTRY, 'server/services/order-requests.ts::cancel_order_request': RO() },
    };
    expect(verdict(realTree(), lists)).toContain(
      'server/services/order-requests.ts::cancel_order_request: read_only, but public.cancel_order_request is VOLATILE in its latest migration',
    );
  });
});

describe('every table write in apps/web/src stays in the active organization and proves its row (S41)', () => {
  const writes = () =>
    realTree()
      .files.filter((f) => realTree().read(f).includes('.from('))
      .flatMap((f) => scanFile(realTree(), f).flatMap((s) => s.tableWrites))
      .filter((w) => w.op !== 'insert');

  it('the scan reads the writes: hundreds of chains, most filtered to the organization by themselves', () => {
    const all = writes();
    expect(all.length).toBeGreaterThan(280);
    expect(all.filter((w) => w.contextOrg).length).toBeGreaterThan(150);
    expect(all.filter((w) => w.asksRows).length).toBeGreaterThan(100);
  });

  it('every class has a reason, and the classes that only state one stay few', () => {
    const stated = Object.values(TABLE_WRITES).filter(
      ([k]) => k === 'row_in_hand' || k === 'not_org_data',
    );
    for (const [, why] of Object.values(TABLE_WRITES)) expect(why.trim()).not.toBe('');
    // 5 rows in hand and 55 jobs, webhooks, callbacks, public token paths,
    // platform console and sign-up writes today. A new one is added here on
    // purpose, with its reason, never to quiet a failure.
    expect(stated.filter(([k]) => k === 'row_in_hand')).toHaveLength(5);
    expect(stated.filter(([k]) => k === 'not_org_data')).toHaveLength(55);
    expect(Object.keys(ROW_PROOF_EXEMPT)).toHaveLength(8);
  });

  it.each(S41_SITES)(
    'mutation proof: $member without its $remove',
    ({ file, member, write, remove }) => {
      const tree = realTree();
      const mutated =
        remove === 'read'
          ? withoutGate(tree, file, member, 'readInActiveOrg')
          : withMemberChanged(tree, file, member, remove, (body) =>
              remove === 'rows'
                ? body.replace(".select('id')", '')
                : body.replace(/\.eq\('organization_id', this\.ctx\.organizationId\)/, ''),
            );
      const says =
        remove === 'rows'
          ? 'asks no row back'
          : remove === 'filter'
            ? 'has no organization filter and no class'
            : write === member
              ? 'has no readInActiveOrg before its first table write'
              : 'has no readInActiveOrg before the write';
      const failures = verdict(mutated);
      expect(
        failures.filter((l) => l.includes(member) && l.includes(write) && l.includes(says)),
      ).toHaveLength(1);
    },
  );

  it('a new write keyed by an id alone fails until it is filtered or classed', () => {
    const file = 'server/services/tags.ts';
    const tree = realTree();
    const added = withFile(
      tree,
      file,
      `${tree.read(file)}\nexport async function renameAnyTag(ctx: ServiceContext, id: string) {\n  await ctx.supabase.from('tags').update({ name: 'x' }).eq('id', id);\n}\n`,
    );
    expect(verdict(added)).toEqual([
      expect.stringMatching(
        /^server\/services\/tags\.ts#renameAnyTag::tags\.update at .* has no organization filter and no class$/,
      ),
    ]);
  });
});

describe('mutation proof: the guard names each of the twelve S39 sites when its read is removed', () => {
  it.each(S39_SITES)('$member ($file)', ({ file, member, names }) => {
    const mutated = withoutGate(realTree(), file, member, 'readInActiveOrg');
    const failures = verdict(mutated);
    expect(failures.length).toBeGreaterThan(0);
    expect(
      failures.some(
        (l) =>
          l.includes(names) &&
          l.includes(
            member === 'BundlesService.update'
              ? 'before its first table write'
              : 'has no readInActiveOrg',
          ),
      ),
    ).toBe(true);
  });

  it('removing the class of an existing call fails it', () => {
    const registry = { ...REGISTRY };
    delete registry['server/services/order-requests.ts::cancel_order_request'];
    expect(verdict(realTree(), { ...LISTS, registry })).toEqual([
      expect.stringMatching(
        /^server\/services\/order-requests\.ts::cancel_order_request at .* has no class$/,
      ),
    ]);
  });

  it('an entry for a call that does not exist fails as stale', () => {
    const registry: Record<string, Entry> = {
      ...REGISTRY,
      'server/services/order-requests.ts::no_such_function': ['not_org_data', 'test'],
    };
    expect(verdict(realTree(), { ...LISTS, registry })).toEqual([
      'stale: server/services/order-requests.ts::no_such_function is classified but no such .rpc( call exists',
    ]);
  });

  it('a new caller of transferStock fails until it is reviewed and pinned', () => {
    const file = 'server/actions/inventory.ts';
    const tree = realTree();
    const added = withFile(
      tree,
      file,
      `${tree.read(file)}\nexport async function newMoveAction(svc: { transferStock(x: unknown): Promise<void> }) {\n  await svc.transferStock({});\n}\n`,
    );
    expect(
      verdict(added).some((l) =>
        l.startsWith(
          'callers changed for server/services/inventory.ts#InventoryService.transferStock',
        ),
      ),
    ).toBe(true);
  });
});

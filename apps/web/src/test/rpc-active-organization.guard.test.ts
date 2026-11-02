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
 * private helper) to its gate. The general class, table writes keyed by an id
 * with no organization filter, is a separate sweep (S41); this scan sees
 * `.rpc(` calls and the sites listed there, nothing else.
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
  get: "the service's own get(id), read in the organization (only `this.get(` counts)",
  inline:
    "a read in the same member filtered with .eq('organization_id', <the context's organizationId>)",
} as const;

type Gate = keyof typeof GATES;
type Klass = 'takes_org' | `read_first:${Gate}` | 'read_only' | 'not_org_data' | 'callers_pin';
type Classified = readonly [klass: Klass, why: string];
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
  'app/api/orders/freq/route.ts::order_request_top_skus_for_warehouse': RO(),
  'app/api/orders/sign/route.ts::confirm_order_signature': [
    'not_org_data',
    'Public sign link: the signature token names the order; no active organization.',
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
};

/**
 * Table writes keyed by a row id with no organization filter that S39 fixed:
 * `<path>#<member>` → the gate that must precede the member's first write to
 * any table (or callers_pin: the member is in CALLER_PINS).
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
  /** Gate calls in the member, by gate, at their start positions. */
  gates: Array<{ gate: Gate; pos: number }>;
  /** Calls made in the member: callee name, through `this.` or not. */
  calls: Array<{ name: string; viaThis: boolean; pos: number }>;
  /** `.from('<table>').<insert|update|upsert|delete>` in the member. */
  tableWrites: Array<{ table: string; pos: number }>;
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

function scanMember(member: Member, sf: ts.SourceFile): MemberScan {
  const scan: MemberScan = { member, rpcs: [], gates: [], calls: [], tableWrites: [] };
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
          scan.gates.push({ gate: 'inline', pos });
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
        if (name === 'from') {
          const table = literalText(n.arguments[0]);
          let parent: ts.Node = n.parent;
          while (
            ts.isParenthesizedExpression(parent) ||
            ts.isAsExpression(parent) ||
            ts.isNonNullExpression(parent)
          ) {
            parent = parent.parent;
          }
          if (
            table &&
            ts.isPropertyAccessExpression(parent) &&
            ['insert', 'update', 'upsert', 'delete'].includes(parent.name.text)
          ) {
            scan.tableWrites.push({ table, pos });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(member.node);
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
}

const LISTS: Lists = {
  registry: REGISTRY,
  orgInBuiltArgs: ORG_IN_BUILT_ARGS,
  dynamicRpc: DYNAMIC_RPC,
  callerPins: CALLER_PINS,
  tableWriteSites: TABLE_WRITE_SITES,
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
  const source = tree.read(file);
  const scan = scanFile(tree, file).find((s) => s.member.key === member);
  if (!scan) throw new Error(`no member ${member} in ${file}`);
  const start = scan.member.node.getStart();
  const end = scan.member.node.getEnd();
  const body = source.slice(start, end);
  const removed = body.replace(new RegExp(`\\b${gate}(?=\\s*[(<])`, 'g'), 'withoutTheGate');
  if (removed === body) throw new Error(`${member} in ${file} has no call of ${gate} to remove`);
  return withFile(tree, file, source.slice(0, start) + removed + source.slice(end));
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
    };
    const v = verdict(t, lists);
    expect(v.some((l) => l.startsWith('a.ts::write_it') && l.includes('has no class'))).toBe(true);
    expect(v.some((l) => l.includes('not a literal'))).toBe(true);
    expect(v.some((l) => l.startsWith('a.ts::gated') && l.includes('has no readInActiveOrg'))).toBe(
      true,
    );
    expect(v.some((l) => l.startsWith('stale: a.ts::gone'))).toBe(true);
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

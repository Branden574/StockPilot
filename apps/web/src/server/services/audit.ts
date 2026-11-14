import 'server-only';

import { randomUUID } from 'node:crypto';

import { createAdminClient } from '@/lib/supabase/admin';
import { headers } from 'next/headers';

import { clientIpForRecord, ipForRecord } from '@/lib/client-ip';
import { isNextControlFlowError, reportError } from '@/lib/error-reporter';
import { mapWithConcurrency } from '@/lib/supabase/in-filter';

import { withContext, type ServiceContext } from './context';
import { keepAlive } from './lib/defer';
import { isPermanentRefusal } from './lib/postgrest-error';

export type AuditEvent =
  | 'user.invited'
  | 'user.invite.accepted'
  | 'user.invite.revoked'
  | 'user.role.changed'
  | 'user.driver.marked'
  | 'user.driver.unmarked'
  | 'user.warehouse.changed'
  | 'user.category_access.updated'
  | 'permissions.role_override'
  | 'permissions.user_override'
  | 'permissions.auditor_preset'
  /**
   * StockPilot support changed a member's platform-managed permission
   * exception (orders:manage_catalog_visibility, migration 0413). Written by
   * platform_set_permission_exception in the same transaction as the change;
   * user_id is the platform actor; metadata {entity_type 'user', entity_id,
   * permission, before, after, target_role, platform_admin_email}. Kept apart
   * from permissions.user_override so the two powers audit separately.
   */
  | 'permissions.platform_exception_changed'
  | 'rental.created'
  | 'rental.returned'
  | 'rental.cancelled'
  | 'user.deactivated'
  | 'user.reactivated'
  | 'user.password.changed'
  | 'security.session_revoked'
  /**
   * The shared export budget refused a caller (lib/export-rate-limit.ts):
   * one row per refusal, no entity, read by the hourly audit-anomaly cron
   * (security/monitors.ts) to spot a sustained export-abuse pattern.
   */
  | 'security.export_rate_limited'
  | 'inventory.item.created'
  | 'inventory.item.updated'
  | 'inventory.item.duplicated'
  | 'inventory.item.archived'
  | 'inventory.item.restored'
  | 'inventory.item.deleted'
  /**
   * Ungroup (0399): a record that shared its SKU got a fresh SKU of its own.
   * Written by split_item_sku itself, in the same transaction as the change,
   * one row per changed record: before/after SKU, left_sku, anchor_item_id
   * (the record that kept the SKU, or null), barcode_kept, request_key,
   * request_hash, surface. No ip or user agent (a SQL-written row).
   */
  | 'inventory.item.ungrouped'
  /**
   * Ordering visibility (0413): a record was hidden from or shown in Place an
   * Order. Written by set_order_catalog_visibility itself, in the same
   * transaction, one row per CHANGED record (none for a retry or an
   * unchanged id): entity inventory_item, warehouse_id, before/after
   * {order_catalog_visible}, operation_id, operation_size, surface,
   * acting_as_platform. Activity label "Ordering visibility changed"
   * (core ORDER_VISIBILITY_AUDIT_LABEL).
   */
  | 'item.order_visibility_changed'
  /**
   * Group selected (0400): explicit display groups. Written by
   * apply_item_grouping itself, in the same transaction as the change; no ip
   * or user agent (SQL-written rows). A display group is display only: it
   * never changes a record's SKU, charter, stock or product family.
   *   created          the group (entity item_display_group): name, item type,
   *                    the records it started with.
   *   members_added    one per record that joined or moved (entity the
   *                    record): before/after group id and name, the group it
   *                    left (previous_group_id) and whether that closed.
   *   members_removed  one per record that left (entity the record): the
   *                    group it left and whether that closed.
   *   renamed          the group: before/after name.
   * Each carries request_key, request_hash and surface.
   */
  | 'inventory.group.created'
  | 'inventory.group.members_added'
  | 'inventory.group.members_removed'
  | 'inventory.group.renamed'
  // Sports product-group identity + variant provenance. 'matched' is recorded
  // as well as 'created' because "this import joined an existing group" is the
  // event a reviewer needs when a grouping later looks wrong.
  | 'sports.group.created'
  | 'sports.group.matched'
  /**
   * A group was archived or restored — a SOFT, reversible status change, never a
   * delete (product_groups has no hard-delete path at all). `extra` on the
   * archive carries `acknowledged_active_variants`, because "retired a line
   * whose sizes are still linked" and "tidied away an empty shell group" are
   * different acts. No migration: audit_logs.event is un-CHECKed text.
   */
  | 'sports.group.archived'
  | 'sports.group.restored'
  | 'sports.variant.created'
  | 'sports.variant.imported'
  | 'sports.import.mapping_confirmed'
  | 'sports.import.match_overridden'
  // The opt-in group-linking review tool (Task 18). One event PER ITEM, with
  // the actor, the before/after group + variant fields and the reviewer's
  // reason — because the whole point of refusing a name-heuristic backfill is
  // that every link is attributable to a person who looked at it.
  | 'sports.item.group_matched'
  | 'sports.item.group_unlinked'
  | 'stock.adjusted'
  | 'stock.received'
  | 'stock.transferred'
  | 'stock.removed'
  // Movement note edited (mig 0274). The append-only ledger's ONLY mutable
  // column is notes; this records old→new note, who, and when so a
  // note correction is fully traceable on the item Activity feed + audit log.
  | 'stock_movement.note_edited'
  | 'warehouse.created'
  | 'warehouse.updated'
  | 'warehouse.archived'
  | 'warehouse.restored'
  | 'warehouse_charters.updated'
  | 'charter.created'
  | 'charter.updated'
  | 'charter.archived'
  | 'charter.restored'
  | 'supplier.archived'
  | 'supplier.restored'
  | 'category.archived'
  | 'category.created'
  | 'category.restored'
  | 'category.updated'
  | 'location.archived'
  | 'location.restored'
  | 'recovery.restored'
  | 'report.exported'
  | 'po_import.uploaded'
  | 'po_import.parsed'
  | 'po_import.failed'
  | 'po_import.approved'
  | 'po_import.canceled'
  /**
   * The import's human name (display_name, mig 0333) was set or changed.
   *
   * A NEW literal rather than a reused one, for the same reason
   * 'stock_movement.note_edited' is its own event: the four po_import events
   * above are all LIFECYCLE transitions, and folding a label edit into one of
   * them would corrupt every read that treats them as a state machine. The
   * closest reuse candidate would have been a generic 'po_import.updated' —
   * which is exactly what PurchaseOrdersService.renamePoNumber reuses
   * ('purchase_order.updated' with `renamed: true`) — but the po_import family
   * has no such generic event to reuse, and inventing one just to qualify it
   * with a flag is strictly less legible than naming the act. Carries
   * before/after displayName. No migration: audit_logs.event is un-CHECKed text.
   */
  | 'po_import.renamed'
  | 'vendor_item_mapping.upserted'
  | 'stock.receipt.posted'
  | 'stock.receipt.reversed'
  | 'purchase_order.created'
  | 'purchase_order.updated'
  | 'purchase_order.status_changed'
  | 'idempotency.replay'
  | 'idempotency.conflict'
  | 'uom_conversion.upserted'
  | 'uom_conversion.deleted'
  | 'item.tracking_type.changed'
  | 'lot.received'
  | 'serial.received'
  | 'serial.duplicate_rejected'
  // Manual serial-number management (item detail → Serials panel). Distinct
  // from the receiving-time 'serial.received' so PO-captured vs hand-entered
  // registry rows stay separable in the audit trail.
  | 'item.serials.added'
  | 'item.serial.updated'
  | 'item.serial.deleted'
  | 'cycle_count.started'
  | 'cycle_count.canceled'
  | 'cycle_count.posted'
  | 'cycle_count.assigned'
  | 'cycle_count.released'
  | 'cycle_count.force_reassigned'
  /**
   * A manager started a targeted recount from the Exception Center (F1-2).
   * ONE row per recount (pattern #30), carrying the id arrays: the
   * occurrences and items asked for, the new count (if any), the occurrences
   * linked to it or to counts already in progress, and what was skipped and
   * why. No migration: audit_logs.event is un-CHECKed text.
   */
  | 'exception.recount_started'
  /**
   * Photo evidence on an exception occurrence (F1-4, 0375): a photo recorded
   * (after the server checked and re-encoded it) and a photo soft-removed.
   * entityId is the occurrence; `after` carries the evidence id. The
   * occurrence timeline records the same two moments for readers.
   */
  | 'exception.evidence_added'
  | 'exception.evidence_removed'
  /**
   * A person confirmed the counted number of a count difference and it closed
   * without a second count (0386). ONE row per confirm that is not a replay;
   * entityId is the occurrence; `after` carries { cycleCountId,
   * countedQuantity, confirmedAs, note }. A second record: the row's
   * confirmed_* columns and its count_confirmed event are the record (written
   * inside exception_confirm_count, so they also hold for a direct call).
   */
  | 'exception.count_confirmed'
  | 'size_count.started'
  | 'size_count.completed'
  | 'bundle.created'
  | 'bundle.updated'
  | 'bundle.archived'
  | 'bundle.restored'
  | 'bundle.assembled'
  | 'bundle.distributed'
  | 'order_request.created'
  | 'order_request.lines_added'
  // Line-level corrections are their OWN events: "we added the wrong thing" and
  // "we asked for the wrong amount" are different stories from "we added more",
  // and folding them into lines_added would make an order's history unreadable.
  | 'order_request.line_quantity_changed'
  | 'order_request.line_removed'
  | 'order_request.approved'
  | 'order_request.denied'
  | 'order_request.status_changed'
  | 'order_request.cancelled'
  | 'order_request.delivered'
  | 'order_request.public_link_rotated'
  // F2-4 (0383): an approver changed an open order's needed-by, with a reason
  // (revise_order_needed_by). metadata: from, to (ISO instants; from is null
  // when the order had none), reason, schedule (what happened to its Schedule
  // entry: moved, created, none_yet, left_closed, not_added, not_moved), event_id; plus
  // before/after { needed_by }. Nothing is emailed or notified.
  | 'order_request.needed_by_revised'
  // F2-5 (0385): a buyer drafted purchase orders for part or all of an
  // order's shortfall (draft_order_shortfall_pos). metadata: purchase_order_ids,
  // po_numbers, lines [{item_id, quantity, purchase_order_id}] (never a cost),
  // plus one purchase_order.created entry per draft. Drafts are not sent.
  | 'order_request.shortfall_po_drafted'
  // Public request links + per-link catalog curation (mig 0261). Every
  // visibility-affecting change is audited with link_id / item_id / before /
  // after in metadata so "who exposed what, when" is always answerable.
  | 'public_link.created'
  | 'public_link.updated'
  | 'public_link.disabled'
  | 'public_catalog.entry_added'
  | 'public_catalog.entry_removed'
  | 'public_catalog.bulk_change'
  | 'item.public_visibility_changed'
  | 'item.public_display_changed'
  // New 'order.*' events for the refactored pick → pack → stage → sign
  // workflow (phases 3–5). Coexist with legacy 'order_request.*' events
  // above so historical audit-log queries stay valid; new emissions use
  // this prefix.
  | 'order.pick_slip_generated'
  | 'order.picking_claimed'
  | 'order.picker_assigned'
  | 'order.picking_released'
  | 'order.picking_complete'
  | 'order.packing_slip_generated'
  | 'order.staged_for_pickup'
  | 'order.staged_for_delivery'
  | 'order.delivery_assigned'
  | 'order.in_transit'
  | 'order.fulfillment_resumed'
  // F2-2 (0378): hold_order_stock held stock for an order (the manual "Hold
  // available stock", or the top-up after an approver added or raised a
  // line). after: { trigger, held: [{itemId, added}], stillShort,
  // hiddenHeldItems, hiddenShortItems } (numbers only for items the holder
  // can read; others counted). Holds are commitments, not stock: nothing moved.
  | 'order.stock_held'
  // Manager override: a picked/packed (pre-signature) order was rewound to
  // picking_in_progress to fix a miscount (0289 reopen_picking RPC).
  | 'order.picking_reopened'
  | 'order.closed_partial'
  | 'order.signature_collected'
  | 'order.completed'
  /**
   * An employee opened a prefilled delivery-request DRAFT in their mail client
   * from the order-success screen. It records that a draft was OPENED and
   * nothing more: StockPilot cannot observe whether the employee pressed Send,
   * cannot confirm the message arrived, and cannot know whether a Zendesk
   * ticket was created — DC4's intake is email-based and entirely outside this
   * application. Never widen this event's meaning.
   *
   * No migration: audit_logs.event is plain text with no CHECK and no enum
   * (prod-verified), so this union member is the whole change. It renders in
   * OrderTimeline on the order detail page for free.
   */
  | 'order.delivery_request_drafted'
  /**
   * A member opened a prefilled return-request DRAFT in their mail client
   * (F14), from their own request on the order or from the return page. Same
   * meaning and the same limits as the event above: a draft was OPENED;
   * StockPilot cannot see Send, delivery or a ticket. Keyed to the order
   * (entityId) so the order timeline shows it; extra carries the return
   * number, is_condensed and the surface, nothing else
   * (services/return-request-draft.ts). No migration, for the reason above.
   */
  | 'order.return_request_drafted'
  | 'pdf.exported'
  | 'tag.created'
  | 'tag.updated'
  | 'tag.deleted'
  | 'tag.applied'
  | 'tag.removed'
  | 'procedure.created'
  | 'procedure.updated'
  | 'procedure.archived'
  | 'procedure.restored'
  | 'procedure.video.added'
  | 'procedure.video.removed'
  | 'procedure.commented'
  | 'procedure.comment.updated'
  | 'procedure.comment.deleted'
  | 'schedule.created'
  | 'schedule.updated'
  | 'schedule.deleted'
  | 'schedule.completed'
  | 'schedule.canceled'
  | 'vendor_mapping.created'
  | 'vendor_mapping.updated'
  | 'vendor_mapping.deleted'
  | 'bin.created'
  | 'bin.updated'
  | 'bin.archived'
  | 'notification_preference.updated'
  // Auth lifecycle (pre-staged for the user-role bug-hunt fix sweep so
  // parallel fixer agents don't race on this file when adding emits).
  | 'user.signed_in'
  | 'user.sign_in_failed'
  | 'user.signed_out'
  | 'user.password.reset_requested'
  | 'user.password.reset_completed'
  // An org admin/owner emailed a member a password-reset link from the
  // Team page (distinct from the self-serve 'user.password.reset_requested'
  // so operator-initiated sends stay attributable in the org audit trail).
  | 'member.password_reset_sent'
  | 'user.profile.updated'
  | 'user.session.invalidated'
  // Verified self-service email change (mig 0345). 'changed' is written by
  // the auth.users trigger (or the idempotent app reconcile), never by the
  // request flow, so it exists exactly once per real change.
  | 'user.email.change_requested'
  | 'user.email.change_resent'
  | 'user.email.change_cancelled'
  | 'user.email.changed'
  // Org-level admin actions (replacing prior misuse of warehouse.updated
  // for org logo / MFA policy changes).
  | 'organization.updated'
  | 'module.enabled'
  | 'module.disabled'
  | 'organization.mfa_policy.changed'
  | 'organization.public_request_token.rotated'
  // Per-org dashboard customization (Phase 2). An admin saved or reset the
  // sidebar nav overrides (hide/rename/reorder/custom links) for the org.
  | 'nav_overrides.updated'
  // Per-org dashboard customization (Phase 2). An admin saved or reset the
  // landing dashboard widget layout (show/hide + reorder) for the org.
  | 'dashboard_layout.updated'
  // Per-org platform customization (Phase 3 T1). An admin created, edited, or
  // archived a custom field DEFINITION for items (the typed extra-field
  // registry stored in custom_field_definitions).
  | 'custom_field_definition.created'
  | 'custom_field_definition.updated'
  | 'custom_field_definition.archived'
  // Per-org platform customization (Phase 3 T2). An admin saved or reset the
  // order status presentation config (label/color/sortOrder per status) — a
  // SOFT override that never touches the status CHECK or the state machine.
  | 'order_status_config.updated'
  // Per-org platform customization (Phase 3 T3). An admin applied a one-click
  // industry template: NON-DESTRUCTIVELY enabled the pack's module set, set
  // organizations.domain_pack, and merged preset terminology defaults (only
  // where the org had not already customized them).
  | 'industry_pack.applied'
  // Per-org demand-planning parameters (Phase 4). An admin changed the
  // planning module's lead time / safety multiplier / velocity window, stored
  // in organization_modules.settings for 'planning'.
  | 'planning_params.updated'
  // PO approval threshold — an admin changed the spend-governance amount
  // stored in organization_modules.settings for 'purchase_orders'.
  | 'po_approval_threshold.updated'
  // Automatic-reordering settings — an admin toggled auto-reorder / mode / cap,
  // stored in organization_modules.settings for 'purchase_orders'.
  | 'auto_reorder_settings.updated'
  // B2B portal pricing mode — an admin switched whether the customer portal
  // shows prices and order totals at all ('no_charge' | 'priced'), stored in
  // organization_modules.settings for 'b2b_portal'.
  | 'portal_pricing_mode.updated'
  // Archived-item auto-cleanup settings — an admin toggled auto-delete /
  // retention days, stored in organization_modules.settings for 'inventory'.
  | 'archive_cleanup_settings.updated'
  // Per-org compose-email routing — an admin set or cleared where the
  // delivery-request / maintenance email actions address their mail
  // (organizations.email_routing, migration 0337). Forensic-relevant: this
  // row is what makes a silent warehouse-mail reroute reconstructable.
  | 'email_routing.updated'
  // Auto-archive-on-zero-stock settings — an admin toggled auto-archive /
  // dwell days, stored in organization_modules.settings for 'inventory'.
  | 'auto_archive_settings.updated'
  // Org-shared Export Builder presets (export_presets, migration 0338).
  // Saved carries the full stored config (name, fields, format) so a preset
  // that later looks wrong is attributable to the exact save that wrote it;
  // deleted carries what was removed, since delete is the only way a shared
  // preset ever changes (rows are immutable — save is insert-only).
  | 'export_preset.saved'
  | 'export_preset.deleted'
  // Inventory restore points (snapshots + safe-reconcile restore).
  | 'restore_point.created'
  | 'restore_point.restored'
  // MFA discrete events (replacing prior misuse of user.role.changed
  // and warehouse.updated for these forensic-relevant flows).
  | 'mfa.enrolled'
  | 'mfa.unenrolled'
  | 'mfa.policy.changed'
  // An authenticator code GoTrue judged wrong, on the web's sign-in code, the
  // step-up or the reset's code step (lib/auth/mfa-code-attempts.ts). No
  // organization: not shown to the organization's admins, and never counted
  // as the person's own last action. metadata: path ('challenge' or
  // 'password_reset'), session_aal on the challenge path, gotrue_code. Never
  // the code, GoTrue's message or the factor id.
  | 'mfa.code_refused'
  // Recovery codes (server/actions/mfa-recovery.ts), never the codes:
  // generated (metadata.count; default organization), consumed (a used code
  // removed the authenticators, metadata.unenrolled; default organization),
  // failed (a refused code; no organization, like mfa.code_refused).
  | 'mfa.recovery.generated'
  | 'mfa.recovery.consumed'
  | 'mfa.recovery.failed'
  // Ownership transfer — the action doesn't exist yet but the event
  // type lets the fixer agent emit it when the missing flow lands.
  | 'organization.ownership.transferred'
  // Platform-admin provisioned a brand-new tenant org: for a customer
  // (Platform > Provision, createOrgForCustomerAction), or their own
  // (/onboarding, createOrganizationAction, metadata.via 'onboarding').
  // Cross-org event: organization_id is the NEW org's id; user_id is the
  // platform admin who acted.
  | 'organization.provisioned_by_platform_admin'
  // Integrations module (Phase 3a connector framework). Connect lands when
  // the OAuth callback writes the token to Vault (status active); disconnect
  // tears the connection down and destroys the Vault secret.
  | 'integration.connected'
  | 'integration.disconnected'
  // An operator re-queued a dead-lettered/errored connector export from the
  // Integrations settings dead-letter view (reset to status='pending').
  | 'integration.sync_replayed'
  | 'shipping.rates_fetched'
  | 'shipping.label_purchased'
  // Returns / RMA (Phase B): a reverse (RMA) label was bought for a return.
  | 'shipping.return_label_purchased'
  // Returns / RMA (Phase A). Each lifecycle transition is audited so the
  // restock/scrap disposition that moves inventory is fully traceable.
  | 'return.created'
  | 'return.approved'
  | 'return.denied'
  | 'return.received'
  | 'return.closed'
  | 'return.cancelled'
  // Returns RX-1 (0394): a destination plan appended (approval, the planner or
  // the close), and a close refused because a planned rack failed its
  // revalidation (nothing moved; written after the failure).
  | 'return.disposition_planned'
  | 'return.restock_location_unavailable'
  // Returns RX-2 (0396): an exchange approved (its linked replacement order
  // created and held), a replacement changed or issued again, cancelled, or
  // released for picking before the returned item arrived.
  | 'return.exchange_approved'
  | 'return.replacement_changed'
  | 'return.replacement_issued'
  | 'return.replacement_cancelled'
  | 'return.replacement_released'
  // ... and closed as a return only after a replacement cancel (desk check F9).
  | 'return.replacement_declined'
  // ... and the rest of a replacement handed over in part closed from its RMA
  // ("Close the rest", returns RX-4, 0397).
  | 'return.replacement_closed'
  // ... and on the replacement order's own trail (its timeline): released
  // before the return, and the returned item received (the gate opened).
  | 'order_request.released_early'
  | 'order_request.return_received'
  // Recurring PO templates — time-based standing orders (Task 3).
  | 'recurring_po_template.created'
  | 'recurring_po_template.updated'
  | 'recurring_po_template.toggled'
  | 'recurring_po_template.deleted'
  // The daily run created no purchase order for the template: its save was
  // refused (a destination deleted after the template was saved, one linked
  // to no warehouse, ...) or failed. `reason` is what the run told the
  // owners and admins; extra is { name, refusal }. No migration:
  // audit_logs.event is un-CHECKed text.
  | 'recurring_po_template.run_skipped'
  /**
   * Maintenance requests (maintenance_requests module). draft_opened records
   * that a prefilled email DRAFT was OPENED and nothing more — StockPilot
   * cannot observe Send, delivery, or Zendesk ticket creation. Never widen
   * these events' meanings. No migration: audit_logs.event is un-CHECKed text.
   */
  | 'maintenance_request.created'
  | 'maintenance_request.updated'
  | 'maintenance_request.draft_opened'
  | 'maintenance_request.archived'
  | 'maintenance_request.cancelled'
  // Maintenance Resolved (spec docs/superpowers/specs/2026-08-06-
  // maintenance-resolved-design.md). extra is { has_note, proof_photo_count }
  // — NEVER the note text itself (GC 16/27 posture).
  | 'maintenance_request.resolved'
  | 'maintenance_request.owner_assigned'
  | 'maintenance_request.note_added'
  | 'maintenance_request.attachment_added'
  | 'maintenance_request.attachment_removed'
  | 'maintenance_request.share_link_created'
  | 'maintenance_request.share_link_revoked'
  | 'maintenance_request.settings_updated'
  /**
   * Every AI-chat invocation of a WRITE tool, emitted at the tool-call
   * boundary in lib/ai/chat.ts (both provider loops). `extra` is
   * { tool, args, ok } — the argument object is recorded deliberately: without
   * it the row proves only that "the assistant wrote something", which is not a
   * paper trail. ok=false rows are the interesting ones (a refused or failed
   * write attempt). No migration: audit_logs.event is un-CHECKed text.
   */
  | 'ai.write_tool_invoked';

export interface AuditPayload {
  event: AuditEvent;
  entityType?: string;
  entityId?: string | null;
  warehouseId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string;
  extra?: Record<string, unknown>;
}

/**
 * Rows per audit_logs INSERT in `auditMany`. The rows travel in the POST body,
 * so no URL limit applies; 100 keeps one body small even with before/after
 * diffs, and a failed request leaves at most 100 rows to send again.
 */
export const AUDIT_INSERT_BATCH_ROWS = 100;

/**
 * INSERT requests `auditMany` keeps in flight at once. One `void audit()` per
 * selected item put 443 POSTs on the wire at the same moment on the lab org:
 * the gateway answered 190 of them 502, and the bulk Set rack read that
 * started right after them failed too. Two in flight writes 500 rows in three
 * round trips and leaves room for the request that is doing the real work.
 * A write's later tries keep the same limit.
 */
export const AUDIT_INSERT_CONCURRENCY = 2;

/**
 * How long one try of an audit_logs write may take before it is abandoned.
 * Bulk actions await their audit write, and the admin client's fetch has no
 * timeout of its own: a gateway that accepts the connection and never answers
 * (the 2026-09-22 Supabase-entry stalls) held a finished action open until
 * undici gave up, about 300 s. A normal 100-row INSERT takes well under a
 * second. An abandoned try may still commit; the row's id is chosen before
 * the first try, so the try sent after it skips the row instead of writing it
 * twice.
 */
export const AUDIT_INSERT_TIMEOUT_MS = 5_000;

/**
 * Reports are sent at most once per organization per window. reportError
 * posts to the alerts webhook on every call, with no dedupe, and during a
 * gateway incident every failed write reports: the placement pass of a bulk
 * Set rack alone makes one audit write per transfer (409 on the lab org). The
 * first report after a quiet period is sent at once, so an incident is never
 * silent; the rest are counted and sent as one report when the window closes,
 * and a window keeps rolling while reports keep coming.
 */
export const AUDIT_LOSS_REPORT_WINDOW_MS = 5_000;

/**
 * Tries per audit write. The first is the INSERT the caller waits for (at
 * most AUDIT_INSERT_TIMEOUT_MS); a try that was not written, unless the
 * database refused the row itself, is sent again after the response, at most
 * twice. The 2026-09 entry stalls lasted up to about 9 s, so a single later
 * try a second after the first can meet the same stall.
 */
export const AUDIT_WRITE_TRIES = 3;

/**
 * The wait before each later try, times a random 0.5 to 1.5 so the writes of
 * one incident do not come back together (the dispatcher's delays,
 * integration-events.ts DISPATCH_RETRY_DELAYS_MS).
 *
 * How long a write's tries last: each try of a write sends its INSERTs two at
 * a time, each with its own AUDIT_INSERT_TIMEOUT_MS deadline, so one try of a
 * write of N chunks takes at most ceil(N / 2) x 5 s, the first try included
 * (as it always did). For a write of one or two INSERTs (every audit() and
 * insertAuditRowReported() call, and auditMany() up to 200 rows) the last try
 * ends at most about 21 s after the event. A larger batch is held to
 * AUDIT_WRITE_BUDGET_MS.
 */
export const AUDIT_RETRY_DELAYS_MS = [1_000, 3_000] as const;

/**
 * A later try is sent only when its wait and its own worst case (ceil(pending
 * chunks / 2) x 5 s) end within this long of the event; otherwise the rows it
 * would have sent are reported as never written, at once. So the tries of any
 * write whose first try ended within the budget are over by 40 s after the
 * event, and its last report (plus at most one window of
 * AUDIT_LOSS_REPORT_WINDOW_MS and the webhook's 2 s) is sent inside a 60 s
 * function. The first try itself is not shortened: a batch of N chunks still
 * waits up to ceil(N / 2) x 5 s for it, as before. One or two chunks never meet
 * the budget (their last try ends by about 21 s).
 */
export const AUDIT_WRITE_BUDGET_MS = 40_000;

/**
 * Writes one instance holds in their later tries at once. A write that is
 * not written on its first try while this many are already waiting for theirs
 * is reported at once as never written, and not sent again. A slot is a
 * write (one audit(), insertAuditRowReported() or auditMany() call, whatever
 * its rows), taken at its first try and freed when its last try ends, written
 * or not. It bounds the memory and the extra requests of an incident: the
 * `void audit()` loops send one write per item.
 */
export const AUDIT_RETRY_SLOTS = 20;

type RequestMeta = { ip: string | null; userAgent: string | null };

/** IP and user agent of the current request, read once per call. */
async function readRequestMeta(): Promise<RequestMeta> {
  const h = await headers();
  return {
    // The one rule (lib/client-ip.ts), null unless an IP literal (inet).
    ip: clientIpForRecord(h),
    userAgent: h.get('user-agent') || null,
  };
}

/**
 * The one place an audit_logs row is shaped, so `audit` and `auditMany`
 * write exactly the same columns and metadata for the same payload.
 *
 * `is_system` is decided by the context and nothing else. A scheduled job's
 * context (`ctx.isSystem`) borrows an owner's or admin's user id, so its rows
 * are stamped `is_system: true`, after `extra`, where a payload cannot unset
 * it. Any other context's rows never carry the key, even when `extra` names
 * it, so a person's row can never pass for a job's (the readers that skip
 * job rows would then skip that person's own actions). A person's row keeps
 * exactly the shape it always had.
 */
function auditRow(payload: AuditPayload, c: ServiceContext, meta: RequestMeta) {
  const { is_system: _ignored, ...extra } = payload.extra ?? {};
  return {
    organization_id: c.organizationId,
    user_id: c.userId,
    event: payload.event,
    ip: meta.ip,
    user_agent: meta.userAgent,
    metadata: {
      entity_type: payload.entityType ?? null,
      entity_id: payload.entityId ?? null,
      warehouse_id: payload.warehouseId ?? null,
      before: payload.before ?? null,
      after: payload.after ?? null,
      reason: payload.reason ?? null,
      ...extra,
      ...(c.isSystem === true ? { is_system: true } : {}),
    },
  };
}

/** An audit_logs row as a caller shapes it. organization_id and user_id are
 *  nullable in the table (auth events before a membership exists); ip and
 *  user_agent are optional for rows written outside a request's own context.
 *  No id: the writer chooses it (rowForSending). */
type AuditRowInsert = {
  organization_id: string | null;
  user_id: string | null;
  event: AuditEvent;
  ip?: string | null;
  user_agent?: string | null;
  metadata: Record<string, unknown>;
  /** 0393: only the account-deletion row sets it ({user_id: when}), so the log
   *  reads "Deleted user" for the person who deleted their account. The
   *  database keeps a non-API insert's stamp only for a null column. */
  deleted_users?: Record<string, string> | null;
};

/** An audit_logs row as it is sent: with the id the writer chose for it. */
type SentRow = AuditRowInsert & { id: string };

/**
 * A caller's row as it is sent, shaped here for every writer:
 *  - its id, always chosen here (randomUUID), never the caller's: a later try
 *    skips a row whose id is already in the table, so the id is one only this
 *    write knows. AuditRowInsert has no id field, and one that arrives anyway
 *    is dropped;
 *  - its address in the form the inet column takes (lib/client-ip.ts
 *    ipForRecord), the last step before the insert whoever shaped the row: a
 *    value that is not an IP literal is stored as none, where it would
 *    otherwise have the row refused (22P02).
 */
function rowForSending(row: AuditRowInsert): SentRow {
  const { id: _callerId, ...rest } = row as AuditRowInsert & { id?: unknown };
  return {
    ...rest,
    ...('ip' in rest ? { ip: ipForRecord(rest.ip) } : {}),
    id: randomUUID(),
  };
}

/** The distinct events of a batch, for a report line. */
function eventsLabel(payloads: readonly AuditPayload[]): string {
  return [...new Set(payloads.map((p) => p.event))].join(',');
}

/**
 * What a failed try said about itself: HTTP status and PostgREST/Postgres
 * code, or the name of what was thrown, and whether it hit the deadline.
 * Never the message or details: a Postgres rejection quotes the failing row
 * ("Failing row contains (...)"), and audit metadata carries item names and
 * before/after values.
 */
type InsertFailure = {
  status?: number | null;
  statusText?: string | null;
  code?: string | null;
  thrown?: string;
  timedOut: boolean;
  /**
   * Set when the deadline aborted the request: how long it had been waiting,
   * by the wall clock. AUDIT_INSERT_TIMEOUT_MS when the deadline fired on
   * time; far more when the instance was suspended and the deadline fired only
   * once a later request resumed it. The 2026-09 reports would have read about
   * 584,000 here instead of looking like a slow database.
   */
  elapsedMs?: number;
};

/** Thrown into the race when a try passes its deadline. */
class AuditInsertTimeout extends Error {
  constructor() {
    super('Audit INSERT timed out');
    this.name = 'AuditInsertTimeout';
  }
}

/**
 * Whether a try that was not written is worth another: always, unless the
 * database or PostgREST refused the row itself for a reason the same row
 * meets again (isPermanentRefusal: SQLSTATE class 22 or 23, PGRST1xx). The
 * same one rule as the dispatcher (integration-events.ts). A timeout, a throw,
 * a 5xx, a 401 or 403 while a credential changes, a 404 while a migration is
 * pushed: all sent again.
 */
function worthAnotherTry(failure: InsertFailure): boolean {
  return !isPermanentRefusal({ code: failure.code ?? null });
}

/**
 * One try of one chunk of a write, with a deadline. Resolves to null when the
 * rows were written, or to what went wrong; never throws.
 *
 * The first try is the INSERT the writer always sent, now with the ids; the
 * database sets created_at. A later try sends the same rows with the time of
 * the event on EVERY row (postgrest-js sends the union of a batch's keys and
 * null for a key a row lacks, and created_at is not null), as an upsert that
 * SKIPS a row whose id is already there: `insert ... on conflict (id) do
 * nothing`. An abandoned first try may have committed after all; then the
 * later try writes nothing. Never the merging upsert, postgrest-js's default,
 * which would overwrite a stored row (audit-writes.guard.test.ts pins the
 * options).
 *
 * The request carries an abort signal, so the socket is released at the
 * deadline, and the result is raced against that same deadline, so the caller
 * is released even if a fetch implementation ignored the signal.
 */
async function sendAuditRows(
  admin: ReturnType<typeof createAdminClient>,
  rows: SentRow | SentRow[],
  attempt: 'first' | 'later',
  occurredAt: string,
): Promise<InsertFailure | null> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new AuditInsertTimeout()), {
      once: true,
    });
  });
  const timer = setTimeout(() => controller.abort(), AUDIT_INSERT_TIMEOUT_MS);
  /** timedOut, and for a request the deadline aborted, how long it waited. */
  const timing = () =>
    controller.signal.aborted
      ? { timedOut: true, elapsedMs: Date.now() - startedAt }
      : { timedOut: false };
  try {
    const request =
      attempt === 'first'
        ? admin.from('audit_logs').insert(rows).abortSignal(controller.signal)
        : admin
            .from('audit_logs')
            .upsert(withEventTime(rows, occurredAt), { onConflict: 'id', ignoreDuplicates: true })
            .abortSignal(controller.signal);
    const res = await Promise.race([request, deadline]);
    if (!res.error) return null;
    return {
      status: typeof res.status === 'number' ? res.status : null,
      statusText: res.statusText || null,
      code: res.error.code || null,
      ...timing(),
    };
  } catch (e) {
    return {
      thrown: e instanceof Error ? e.name : typeof e,
      ...timing(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The rows of a later try: each with the time of the event. */
function withEventTime(rows: SentRow | SentRow[], occurredAt: string) {
  return Array.isArray(rows)
    ? rows.map((r) => ({ ...r, created_at: occurredAt }))
    : { ...rows, created_at: occurredAt };
}

// ── The tries of one write ──────────────────────────────────────────────────

/** Who a write's reports name: event names and ids only, never the row. */
type WriteSubject = {
  organizationId: string | null;
  /** The account the row is about or by, when it has one. */
  userId: string | null;
  /** One event, or a comma-separated list for a batch. */
  event: string;
  entityType?: string | null;
};

/** One INSERT's worth of a write: one row (audit, insertAuditRowReported) or up to 100 (auditMany). */
type Chunk = { rows: SentRow | SentRow[]; ids: string[] };

type FirstTryCounts = { written: number; lost: number };

type AuditWrite = {
  /** The rows written and not written by the first try: what the caller waits for. */
  firstTry: Promise<FirstTryCounts>;
  /** The first try, the later tries and every report of the write. Never rejects. */
  done: Promise<void>;
};

let writesBeingSentAgain = 0;
/** Moves on at each test reset, so a write from before it frees no slot after it. */
let slotGeneration = 0;
/** The waits before a later try, so the test reset can end them. */
const waitingForATry = new Set<() => void>();

function takeRetrySlot(): number | null {
  if (writesBeingSentAgain >= AUDIT_RETRY_SLOTS) return null;
  writesBeingSentAgain += 1;
  return slotGeneration;
}

function releaseRetrySlot(generation: number): void {
  if (generation === slotGeneration) writesBeingSentAgain = Math.max(0, writesBeingSentAgain - 1);
}

/** A wait of about `nominalMs`: times a random 0.5 to 1.5. */
const jittered = (nominalMs: number) => Math.round(nominalMs * (0.5 + Math.random()));

/** Waits `ms`. False when the wait was ended by the test reset. */
function waitBeforeATry(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const end = () => {
      clearTimeout(timer);
      waitingForATry.delete(end);
      resolve(false);
    };
    const timer = setTimeout(() => {
      waitingForATry.delete(end);
      resolve(true);
    }, ms);
    waitingForATry.add(end);
  });
}

const rowsOf = (chunk: Chunk) => chunk.ids.length;

/**
 * Starts one write: its rows are shaped (ids, address) and its first try is
 * sent now, inside the request, so a row keeps its place among the action's
 * other rows. `firstTry` settles when every chunk's first try has answered or
 * passed its deadline; `done` when the later tries have ended and every
 * report they caused has been sent. The writer hands `done` to keepAlive.
 */
function startAuditWrite(
  admin: ReturnType<typeof createAdminClient>,
  shaped: Array<AuditRowInsert | AuditRowInsert[]>,
  subject: WriteSubject,
): AuditWrite {
  // The time of the event: later tries carry it as created_at.
  const startedAt = Date.now();
  const chunks: Chunk[] = shaped.map((c) => {
    if (Array.isArray(c)) {
      const rows = c.map(rowForSending);
      return { rows, ids: rows.map((r) => r.id) };
    }
    const row = rowForSending(c);
    return { rows: row, ids: [row.id] };
  });
  let settleFirst!: (counts: FirstTryCounts) => void;
  const firstTry = new Promise<FirstTryCounts>((resolve) => {
    settleFirst = resolve;
  });
  const total = chunks.reduce((n, c) => n + rowsOf(c), 0);
  const done = runAuditWrite(admin, chunks, startedAt, subject, settleFirst).finally(() =>
    settleFirst({ written: 0, lost: total }),
  );
  return { firstTry, done };
}

async function runAuditWrite(
  admin: ReturnType<typeof createAdminClient>,
  chunks: Chunk[],
  startedAt: number,
  subject: WriteSubject,
  settleFirst: (counts: FirstTryCounts) => void,
): Promise<void> {
  const occurredAt = new Date(startedAt).toISOString();
  const total = chunks.reduce((n, c) => n + rowsOf(c), 0);
  const failed: Failed[] = [];
  // `run` never throws (sendAuditRows returns its failure), so
  // mapWithConcurrency's stop-on-first-error never applies: every chunk is
  // attempted, each with its own deadline.
  await mapWithConcurrency(chunks, AUDIT_INSERT_CONCURRENCY, async (chunk) => {
    const failure = await sendAuditRows(admin, chunk.rows, 'first', occurredAt);
    if (failure) failed.push({ chunk, failure });
  });
  const notWritten = failed.reduce((n, f) => n + rowsOf(f.chunk), 0);
  settleFirst({ written: total - notWritten, lost: notWritten });
  if (failed.length === 0) return;

  const reports: Array<Promise<void>> = [];
  const refused = failed.filter((f) => !worthAnotherTry(f.failure));
  const unanswered = failed.filter((f) => worthAnotherTry(f.failure));
  if (refused.length > 0) {
    reports.push(reportAuditWrite(notWrittenReport(subject, refused, total, 1, 'refused')));
  }
  if (unanswered.length === 0) {
    await Promise.all(reports);
    return;
  }
  const slot = takeRetrySlot();
  if (slot === null) {
    reports.push(reportAuditWrite(notWrittenReport(subject, unanswered, total, 1, 'busy')));
    await Promise.all(reports);
    return;
  }
  try {
    const rows = unanswered.reduce((n, f) => n + rowsOf(f.chunk), 0);
    reports.push(
      reportAuditWrite({
        subject,
        outcome: 'sending_again',
        rows,
        total,
        lost: rows,
        writtenLate: 0,
        tries: 1,
        rowIds: unanswered.flatMap((f) => f.chunk.ids),
        failure: unanswered[0]!.failure,
      }),
    );
    const outcome = await laterTries(admin, unanswered, startedAt);
    if (outcome) reports.push(reportAuditWrite(outcomeReport(subject, outcome, total)));
  } finally {
    releaseRetrySlot(slot);
  }
  await Promise.all(reports);
}

type Failed = { chunk: Chunk; failure: InsertFailure };

type LaterOutcome = {
  writtenLate: string[];
  lost: string[];
  /** The last try made. */
  tries: number;
  /** What the last try of a row that was never written said. */
  failure: InsertFailure | null;
};

/**
 * The later tries of a write's unwritten chunks, each sent only when it can
 * end within AUDIT_WRITE_BUDGET_MS of the event. Null when the test reset
 * ended them.
 */
async function laterTries(
  admin: ReturnType<typeof createAdminClient>,
  unanswered: Failed[],
  startedAt: number,
): Promise<LaterOutcome | null> {
  const occurredAt = new Date(startedAt).toISOString();
  let pending = unanswered;
  const writtenLate: string[] = [];
  const lost: string[] = [];
  let failure: InsertFailure | null = null;
  let tries = 1;
  for (const delay of AUDIT_RETRY_DELAYS_MS) {
    if (pending.length === 0) break;
    const wait = jittered(delay);
    const worstTry = Math.ceil(pending.length / AUDIT_INSERT_CONCURRENCY) * AUDIT_INSERT_TIMEOUT_MS;
    if (Date.now() + wait + worstTry - startedAt > AUDIT_WRITE_BUDGET_MS) break;
    if (!(await waitBeforeATry(wait))) return null;
    tries += 1;
    const next: Failed[] = [];
    await mapWithConcurrency(pending, AUDIT_INSERT_CONCURRENCY, async (p) => {
      const f = await sendAuditRows(admin, p.chunk.rows, 'later', occurredAt);
      if (!f) {
        writtenLate.push(...p.chunk.ids);
      } else if (!worthAnotherTry(f)) {
        lost.push(...p.chunk.ids);
        failure = f;
      } else {
        next.push({ chunk: p.chunk, failure: f });
      }
    });
    pending = next;
  }
  for (const p of pending) {
    lost.push(...p.chunk.ids);
    failure = p.failure;
  }
  return { writtenLate, lost, tries, failure };
}

// ── Reports, coalesced per organization ─────────────────────────────────────

/**
 * - sending_again: the first try was not written and the rows are being sent
 *   again (said at once, so an instance cut during the later tries still left
 *   an alert with the row ids, and no outcome);
 * - written_late: every row was written on a later try;
 * - not_written: rows no try wrote, or that were not sent again (refused by
 *   the database, or the instance already had AUDIT_RETRY_SLOTS writes being
 *   sent again), or a write that failed before any row was shaped.
 */
type Outcome = 'sending_again' | 'written_late' | 'not_written';

type WriteReport = {
  subject: WriteSubject;
  outcome: Outcome;
  /** Rows this report is about. */
  rows: number;
  /** Rows of the whole write. */
  total: number;
  /** Rows not in the table as this report is sent. */
  lost: number;
  /** Rows written on a later try. */
  writtenLate: number;
  /** Tries made so far (0: the write failed before a row was shaped). */
  tries: number;
  /** The rows this report is about (the message names up to ten). */
  rowIds: string[];
  failure: InsertFailure | null;
  /** Why rows were not sent again. */
  why?: 'refused' | 'busy';
  /** What was thrown, when something was; its report carries it. */
  cause?: unknown;
};

function notWrittenReport(
  subject: WriteSubject,
  failed: Failed[],
  total: number,
  tries: number,
  why: 'refused' | 'busy',
): WriteReport {
  const rowIds = failed.flatMap((f) => f.chunk.ids);
  return {
    subject,
    outcome: 'not_written',
    rows: rowIds.length,
    total,
    lost: rowIds.length,
    writtenLate: 0,
    tries,
    rowIds,
    failure: failed[0]!.failure,
    why,
  };
}

function outcomeReport(subject: WriteSubject, o: LaterOutcome, total: number): WriteReport {
  const rows = o.writtenLate.length + o.lost.length;
  return {
    subject,
    outcome: o.lost.length === 0 ? 'written_late' : 'not_written',
    rows,
    total,
    lost: o.lost.length,
    writtenLate: o.writtenLate.length,
    tries: o.tries,
    // The rows never written first: they are the ones to look up.
    rowIds: [...o.lost, ...o.writtenLate],
    failure: o.lost.length === 0 ? null : o.failure,
  };
}

/** At most this many row ids in one message. */
const REPORT_ROW_IDS = 10;

const SAFE_TOKEN = /^[A-Za-z0-9_]{1,32}$/;

/** What a failed try said, in fixed words: never a database message. */
function failureText(f: InsertFailure | null): string {
  if (!f) return 'no answer';
  if (f.timedOut) return `not answered in ${f.elapsedMs ?? AUDIT_INSERT_TIMEOUT_MS} ms`;
  if (f.thrown) return `the request failed (${SAFE_TOKEN.test(f.thrown) ? f.thrown : 'error'})`;
  const parts = [
    typeof f.status === 'number' ? `status ${f.status}` : null,
    f.code && SAFE_TOKEN.test(f.code) ? `code ${f.code}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'no answer';
}

function idsText(rowIds: string[]): string {
  if (rowIds.length === 0) return 'none';
  const shown = rowIds.slice(0, REPORT_ROW_IDS).join(', ');
  return rowIds.length > REPORT_ROW_IDS
    ? `${shown} (first ${REPORT_ROW_IDS} of ${rowIds.length})`
    : shown;
}

/**
 * The report's MESSAGE: what a Slack or Teams channel shows (the webhook body
 * is the tag, this message, the digest and the stack; `extra` reaches only a
 * custom endpoint and the server log). Event names, ids, counts and fixed
 * words only: no email, no address, no metadata, no database text.
 */
function reportText(r: WriteReport): string {
  const s = r.subject;
  const who =
    `event ${s.event}; ${r.rowIds.length === 1 ? 'row' : 'rows'} ${idsText(r.rowIds)}; ` +
    `account ${s.userId ?? 'none'}; organization ${s.organizationId ?? 'none'}`;
  const one = r.total === 1;
  const of = one ? 'Audit row' : `Audit rows: ${r.rows} of ${r.total}`;
  const why = failureText(r.failure);
  switch (r.outcome) {
    case 'sending_again':
      return `${of} not written on try 1 of ${AUDIT_WRITE_TRIES} (${why}), sending ${one ? 'it' : 'them'} again. ${who}`;
    case 'written_late':
      return `${of} written on a later try (try ${r.tries} of ${AUDIT_WRITE_TRIES}). ${who}`;
    case 'not_written':
      if (r.tries === 0) return `${of} not written: no row was shaped. ${who}`;
      if (r.why === 'refused') return `${of} refused (${why}), not sent again. ${who}`;
      if (r.why === 'busy') {
        return `${of} not written on try 1 (${why}), not sent again: ${AUDIT_RETRY_SLOTS} writes are already being sent again on this instance. ${who}`;
      }
      return (
        `${of} never written after ${r.tries} tries (${why})` +
        (r.writtenLate > 0 ? `; ${r.writtenLate} written on a later try` : '') +
        `. ${who}`
      );
  }
}

function reportExtra(r: WriteReport): Record<string, string | number | boolean | null | undefined> {
  return {
    event: r.subject.event,
    entityType: r.subject.entityType ?? null,
    outcome: r.outcome,
    lost: r.lost,
    total: r.total,
    tries: r.tries,
    userId: r.subject.userId,
    rowIds: r.rowIds.slice(0, REPORT_ROW_IDS).join(','),
    ...(r.writtenLate > 0 ? { writtenLate: r.writtenLate } : {}),
    ...(r.failure ?? {}),
  };
}

/**
 * Send one report. Its webhook POST is held like the write it reports
 * (keepAlive): on a suspended instance the alert was cut off too, and failed
 * with a TimeoutError when a later request resumed it. The returned promise
 * settles when the POST has, so a write can hold itself until its reports
 * are out.
 */
function sendLossReport(
  err: unknown,
  organizationId: string | null,
  extra: Record<string, string | number | boolean | null | undefined>,
): Promise<void> {
  const post = reportError(err, {
    tag: 'audit.write_failed',
    level: 'warning',
    organizationId,
    extra,
  });
  keepAlive(post);
  return Promise.resolve(post).then(
    () => undefined,
    () => undefined,
  );
}

type LossWindow = {
  organizationId: string | null;
  /** Reports folded in: the window sends a report only when there is one. */
  reports: number;
  /** Rows never written, or not sent again. */
  lost: number;
  /** Rows of the first-try reports folded in. */
  total: number;
  sentAgain: number;
  writtenLate: number;
  events: Set<string>;
  rowIds: string[];
  failure: InsertFailure | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Settles once this window's report has been sent, or it closed with none. */
  sent: Promise<void>;
  markSent: () => void;
};

/** Open windows by organization id ('' when the organization is unknown). */
const lossWindows = new Map<string, LossWindow>();

function openLossWindow(key: string, organizationId: string | null): void {
  let markSent!: () => void;
  const sent = new Promise<void>((resolve) => {
    markSent = resolve;
  });
  const w: LossWindow = {
    organizationId,
    reports: 0,
    lost: 0,
    total: 0,
    sentAgain: 0,
    writtenLate: 0,
    events: new Set(),
    rowIds: [],
    failure: null,
    timer: undefined,
    sent,
    markSent,
  };
  w.timer = setTimeout(() => closeLossWindow(key, w), AUDIT_LOSS_REPORT_WINDOW_MS);
  // Never keep a process (a script, a test run) alive just to send a count.
  // A write counted into the window holds its own invocation until the window
  // is sent (reportAuditWrite returns `sent`).
  w.timer.unref?.();
  lossWindows.set(key, w);
}

function windowText(w: LossWindow): string {
  return (
    `Audit writes for organization ${w.organizationId ?? 'none'} in the last ` +
    `${AUDIT_LOSS_REPORT_WINDOW_MS / 1000} s: ${w.sentAgain} rows sent again, ` +
    `${w.writtenLate} written on a later try, ${w.lost} never written. ` +
    `events ${[...w.events].join(',')}; rows ${idsText(w.rowIds)}`
  );
}

function closeLossWindow(key: string, w: LossWindow): void {
  if (lossWindows.get(key) !== w) return;
  lossWindows.delete(key);
  if (w.reports === 0) {
    w.markSent();
    return;
  }
  // Held like every report; the writes counted into the window wait for `sent`.
  keepAlive(
    sendLossReport(new Error(windowText(w)), w.organizationId, {
      event: [...w.events].join(','),
      lost: w.lost,
      total: w.total,
      sentAgain: w.sentAgain,
      writtenLate: w.writtenLate,
      windowMs: AUDIT_LOSS_REPORT_WINDOW_MS,
      rowIds: w.rowIds.join(','),
      ...(w.failure ?? {}),
    }).then(w.markSent),
  );
  // Reports are still coming in: keep counting instead of sending each one.
  openLossWindow(key, w.organizationId);
}

function foldIntoWindow(w: LossWindow, r: WriteReport): void {
  w.reports += 1;
  if (r.outcome === 'sending_again') {
    w.sentAgain += r.rows;
    w.total += r.rows;
  } else {
    w.lost += r.lost;
    w.writtenLate += r.writtenLate;
    // A first-try report adds its rows; an outcome's rows were counted when
    // they were sent again.
    if (r.tries <= 1) w.total += r.rows;
  }
  for (const e of r.subject.event.split(',')) if (e) w.events.add(e);
  for (const id of r.rowIds) {
    if (w.rowIds.length >= REPORT_ROW_IDS) break;
    w.rowIds.push(id);
  }
  w.failure ??= r.failure;
}

/**
 * Report a write: at once when no report went out for this organization in
 * the current window, otherwise counted into the report that goes out when
 * the window closes, with a line in the server log so every row id is still
 * there. Resolves once the report that carries it has been sent: the writer
 * awaits it inside the promise it handed to keepAlive, so neither report is
 * cut off with the instance.
 */
function reportAuditWrite(r: WriteReport): Promise<void> {
  const key = r.subject.organizationId ?? '';
  const open = lossWindows.get(key);
  if (open) {
    foldIntoWindow(open, r);
    console.warn(`[audit] ${reportText(r)}`);
    return open.sent;
  }
  const sent = sendLossReport(
    r.cause ?? new Error(reportText(r)),
    r.subject.organizationId,
    reportExtra(r),
  );
  openLossWindow(key, r.subject.organizationId);
  return sent;
}

/** A write that failed before any row was shaped: no row id exists. */
function reportUnshapedWrite(subject: WriteSubject, rows: number, cause: unknown): Promise<void> {
  return reportAuditWrite({
    subject,
    outcome: 'not_written',
    rows,
    total: rows,
    lost: rows,
    writtenLate: 0,
    tries: 0,
    rowIds: [],
    failure: { thrown: cause instanceof Error ? cause.name : typeof cause, timedOut: false },
    cause,
  });
}

/** Test hook: forget every open window and its timer, and end every write waiting for a later try. */
export function resetAuditLossReportsForTests(): void {
  for (const w of lossWindows.values()) {
    clearTimeout(w.timer);
    w.markSent();
  }
  lossWindows.clear();
  for (const end of [...waitingForATry]) end();
  writesBeingSentAgain = 0;
  slotGeneration += 1;
}

/**
 * Writes an audit log entry using the admin client (so logging never fails
 * because of RLS). Captures user from the supplied `ctx` (or cached
 * `withContext()` as a fallback for legacy callers), plus IP + UA from
 * request headers when available.
 *
 * When called from an API route (no cookies, no `x-pathname` header), the
 * `withContext()` fallback throws `NEXT_REDIRECT` and the outer try/catch
 * would silently drop the event. Bearer/API callers MUST pass their
 * `ServiceContext` so the audit row is written.
 *
 * Best-effort for the action: never throws to the caller. A row whose first
 * try is not written is sent again after the response (AUDIT_WRITE_TRIES),
 * with the id it was given before the first try, so a try that landed late is
 * skipped, never written twice. Nothing is silent: a try that was not written,
 * and the outcome of the later tries, are reported with the event, the row id
 * and the account (coalesced per organization, see
 * AUDIT_LOSS_REPORT_WINDOW_MS). supabase-js returns a failed request as
 * `{ error }` instead of throwing, so the result is read; the catch only sees
 * what throws (no context, no request headers).
 *
 * KEPT ALIVE PAST THE RESPONSE. Many callers do not wait (`void audit(...)`
 * at 68 call sites in 22 files on 2026-10-12). The write starts here, as it
 * always did, and is handed to after() (lib/defer.ts keepAlive), so the
 * platform keeps the invocation running until the write is done: its first
 * try, its later tries, and the reports they send. Without it, Vercel
 * suspended the instance once the response was sent, with the INSERT in
 * flight, and the next request resumed it with the 5 s deadline long past: 35
 * reports from 2026-09-24 to 10-12, 33 of them rows that had committed but
 * whose reply was never read (17 from the nightly restore-points cron), and 2
 * item-create rows that were never sent. The promise the caller
 * gets settles after the first try, so a caller that awaits waits no longer
 * than it did. auditMany and insertAuditRowReported do the same.
 *
 * For one row per item over a selection or a list, use `auditMany`.
 */
export function audit(payload: AuditPayload, ctx?: ServiceContext): Promise<void> {
  let firstTried!: () => void;
  const firstTry = new Promise<void>((resolve) => {
    firstTried = resolve;
  });
  const done = writeAudit(payload, ctx, () => firstTried()).finally(() => firstTried());
  keepAlive(done);
  return firstTry;
}

/** The body of `audit()`. Never rejects: a row not written is reported instead. */
async function writeAudit(
  payload: AuditPayload,
  ctx: ServiceContext | undefined,
  firstTried: () => void,
): Promise<void> {
  let c: ServiceContext | undefined = ctx;
  try {
    c ??= await withContext();
    const meta = await readRequestMeta();
    const admin = createAdminClient();
    const write = startAuditWrite(admin, [auditRow(payload, c, meta)], {
      organizationId: c.organizationId,
      userId: c.userId ?? null,
      event: payload.event,
      entityType: payload.entityType ?? null,
    });
    void write.firstTry.then(firstTried);
    await write.done;
  } catch (e) {
    firstTried();
    // A Next.js redirect or notFound is control flow, not a write failure:
    // reportError drops it quietly, and it is not counted as a lost row.
    if (isNextControlFlowError(e)) {
      void reportError(e, { tag: 'audit.write_failed', level: 'warning' });
      return;
    }
    await reportUnshapedWrite(
      {
        organizationId: c?.organizationId ?? null,
        userId: c?.userId ?? null,
        event: payload.event,
        entityType: payload.entityType ?? null,
      },
      1,
      e,
    );
  }
}

/**
 * Writes one audit row that its caller shaped itself, for the few places that
 * cannot go through `audit()`: auth events with no organization context yet,
 * a platform admin's cross-organization event, invite acceptance and email
 * change. The same tries and the same reports as `audit()`: supabase-js
 * returns a failed INSERT as `{ error }` instead of throwing, so a
 * `try { await insert } catch` around it never saw a lost row. The row's id
 * is chosen by the writer, never by the caller.
 *
 * Never throws. Resolves to whether the FIRST try wrote the row (a row
 * written on a later try still resolved false). Kept alive past the response
 * like `audit()`, later tries included.
 */
export function insertAuditRowReported(row: AuditRowInsert): Promise<boolean> {
  let answer!: (written: boolean) => void;
  const firstTry = new Promise<boolean>((resolve) => {
    answer = resolve;
  });
  const done = writeAuditRowReported(row, answer).finally(() => answer(false));
  keepAlive(done);
  return firstTry;
}

/** The body of `insertAuditRowReported()`. Never rejects. */
async function writeAuditRowReported(
  row: AuditRowInsert,
  answer: (written: boolean) => void,
): Promise<void> {
  const subject: WriteSubject = {
    organizationId: row.organization_id,
    userId: row.user_id,
    event: row.event,
    entityType: typeof row.metadata.entity_type === 'string' ? row.metadata.entity_type : null,
  };
  try {
    const write = startAuditWrite(createAdminClient(), [row], subject);
    void write.firstTry.then((counts) => answer(counts.written === 1));
    await write.done;
  } catch (e) {
    answer(false);
    await reportUnshapedWrite(subject, 1, e);
  }
}

/**
 * Writes one audit row per payload, for the loops that audit every item of a
 * selection or a list (bulk actions, crons, cancellations).
 *
 * The rows are exactly the rows `audit()` writes for the same payloads (same
 * user, IP, user agent, event and metadata; the headers are read once), each
 * with its own id. They go out AUDIT_INSERT_BATCH_ROWS per INSERT with at
 * most AUDIT_INSERT_CONCURRENCY INSERTs in flight, instead of one request per
 * row all at once.
 *
 * Best-effort for the action like `audit()`: never throws, and the caller
 * never waits longer than AUDIT_INSERT_TIMEOUT_MS for one INSERT. A chunk
 * whose first try was not written is sent again after the response, with the
 * same ids, like `audit()`'s row; the reports name the events, the counts and
 * up to ten row ids, never the rows' contents (folded into the organization's
 * open report window when there is one). Returns the counts after the FIRST
 * try, so a caller or a test can see them; callers are free to ignore them.
 * Kept alive past the response like `audit()`, every chunk and every later
 * try included.
 */
export function auditMany(
  payloads: readonly AuditPayload[],
  ctx?: ServiceContext,
): Promise<{ written: number; lost: number }> {
  let answer!: (counts: FirstTryCounts) => void;
  const firstTry = new Promise<FirstTryCounts>((resolve) => {
    answer = resolve;
  });
  const done = writeAuditMany(payloads, ctx, answer).finally(() =>
    answer({ written: 0, lost: payloads.length }),
  );
  keepAlive(done);
  return firstTry;
}

/** The body of `auditMany()`. Never rejects. */
async function writeAuditMany(
  payloads: readonly AuditPayload[],
  ctx: ServiceContext | undefined,
  answer: (counts: FirstTryCounts) => void,
): Promise<void> {
  const total = payloads.length;
  if (total === 0) {
    answer({ written: 0, lost: 0 });
    return;
  }
  const events = eventsLabel(payloads);
  let c: ServiceContext;
  let rows: Array<ReturnType<typeof auditRow>>;
  let admin: ReturnType<typeof createAdminClient>;
  try {
    c = ctx ?? (await withContext());
    const meta = await readRequestMeta();
    rows = payloads.map((p) => auditRow(p, c, meta));
    admin = createAdminClient();
  } catch (e) {
    answer({ written: 0, lost: total });
    if (isNextControlFlowError(e)) {
      void reportError(e, { tag: 'audit.write_failed', level: 'warning' });
      return;
    }
    await reportUnshapedWrite(
      { organizationId: ctx?.organizationId ?? null, userId: ctx?.userId ?? null, event: events },
      total,
      e,
    );
    return;
  }

  const chunks: Array<typeof rows> = [];
  for (let i = 0; i < rows.length; i += AUDIT_INSERT_BATCH_ROWS) {
    chunks.push(rows.slice(i, i + AUDIT_INSERT_BATCH_ROWS));
  }
  const write = startAuditWrite(admin, chunks, {
    organizationId: c.organizationId,
    userId: c.userId ?? null,
    event: events,
  });
  void write.firstTry.then(answer);
  await write.done;
}

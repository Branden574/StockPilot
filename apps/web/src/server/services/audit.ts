import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { headers } from 'next/headers';

import { reportError } from '@/lib/error-reporter';
import { withContext, type ServiceContext } from './context';

export type AuditEvent =
  | 'user.invited'
  | 'user.invite.accepted'
  | 'user.invite.revoked'
  | 'user.role.changed'
  | 'user.warehouse.changed'
  | 'user.category_access.updated'
  | 'rental.created'
  | 'rental.returned'
  | 'rental.cancelled'
  | 'user.deactivated'
  | 'user.reactivated'
  | 'user.password.changed'
  | 'inventory.item.created'
  | 'inventory.item.updated'
  | 'inventory.item.duplicated'
  | 'inventory.item.archived'
  | 'inventory.item.restored'
  | 'inventory.item.deleted'
  | 'stock.adjusted'
  | 'stock.received'
  | 'stock.transferred'
  | 'stock.removed'
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
  | 'vendor_item_mapping.upserted'
  | 'stock.receipt.posted'
  | 'stock.receipt.reversed'
  | 'purchase_order.created'
  | 'purchase_order.status_changed'
  | 'idempotency.replay'
  | 'idempotency.conflict'
  | 'uom_conversion.upserted'
  | 'uom_conversion.deleted'
  | 'item.tracking_type.changed'
  | 'lot.received'
  | 'serial.received'
  | 'serial.duplicate_rejected'
  | 'cycle_count.started'
  | 'cycle_count.canceled'
  | 'cycle_count.posted'
  | 'cycle_count.assigned'
  | 'bundle.created'
  | 'bundle.updated'
  | 'bundle.archived'
  | 'bundle.restored'
  | 'bundle.assembled'
  | 'bundle.distributed'
  | 'order_request.created'
  | 'order_request.approved'
  | 'order_request.denied'
  | 'order_request.status_changed'
  | 'order_request.cancelled'
  | 'order_request.delivered'
  | 'order_request.public_link_rotated'
  // New 'order.*' events for the refactored pick → pack → stage → sign
  // workflow (phases 3–5). Coexist with legacy 'order_request.*' events
  // above so historical audit-log queries stay valid; new emissions use
  // this prefix.
  | 'order.pick_slip_generated'
  | 'order.picking_complete'
  | 'order.packing_slip_generated'
  | 'order.staged_for_pickup'
  | 'order.staged_for_delivery'
  | 'order.delivery_assigned'
  | 'order.in_transit'
  | 'order.signature_collected'
  | 'order.completed'
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
  | 'user.profile.updated'
  | 'user.session.invalidated'
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
  // Inventory restore points (snapshots + safe-reconcile restore).
  | 'restore_point.created'
  | 'restore_point.restored'
  // MFA discrete events (replacing prior misuse of user.role.changed
  // and warehouse.updated for these forensic-relevant flows).
  | 'mfa.enrolled'
  | 'mfa.unenrolled'
  | 'mfa.policy.changed'
  | 'mfa.recovery.generated'
  | 'mfa.recovery.consumed'
  | 'mfa.recovery.failed'
  // Ownership transfer — the action doesn't exist yet but the event
  // type lets the fixer agent emit it when the missing flow lands.
  | 'organization.ownership.transferred'
  // Platform-admin provisioned a brand-new tenant org for a customer
  // via /dashboard/admin/orgs/new. Cross-org event: organization_id
  // is the NEW org's id; user_id is the platform admin who acted.
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
  // Recurring PO templates — time-based standing orders (Task 3).
  | 'recurring_po_template.created'
  | 'recurring_po_template.updated'
  | 'recurring_po_template.toggled'
  | 'recurring_po_template.deleted';

interface AuditPayload {
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
 * Best-effort — never throws to the caller. Audit failures are logged to
 * stderr only; we never want a logging error to break a user action.
 */
export async function audit(
  payload: AuditPayload,
  ctx?: ServiceContext,
): Promise<void> {
  try {
    const c = ctx ?? (await withContext());
    const h = await headers();
    const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || null;
    const userAgent = h.get('user-agent') || null;

    const admin = createAdminClient();
    await admin.from('audit_logs').insert({
      organization_id: c.organizationId,
      user_id: c.userId,
      event: payload.event,
      ip,
      user_agent: userAgent,
      metadata: {
        entity_type: payload.entityType ?? null,
        entity_id: payload.entityId ?? null,
        warehouse_id: payload.warehouseId ?? null,
        before: payload.before ?? null,
        after: payload.after ?? null,
        reason: payload.reason ?? null,
        ...(payload.extra ?? {}),
      },
    });
  } catch (e) {
    void reportError(e, {
      tag: 'audit.write_failed',
      level: 'warning',
      extra: { event: payload.event, entityType: payload.entityType ?? null },
    });
  }
}

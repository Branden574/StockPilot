import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { headers } from 'next/headers';

import { reportError } from '@/lib/error-reporter';
import { withContext } from './context';

export type AuditEvent =
  | 'user.invited'
  | 'user.invite.accepted'
  | 'user.invite.revoked'
  | 'user.role.changed'
  | 'user.warehouse.changed'
  | 'user.deactivated'
  | 'user.reactivated'
  | 'user.password.changed'
  | 'inventory.item.created'
  | 'inventory.item.updated'
  | 'inventory.item.archived'
  | 'inventory.item.deleted'
  | 'stock.adjusted'
  | 'stock.received'
  | 'stock.transferred'
  | 'stock.removed'
  | 'warehouse.created'
  | 'warehouse.updated'
  | 'warehouse.archived'
  | 'warehouse_charters.updated'
  | 'charter.created'
  | 'charter.updated'
  | 'charter.archived'
  | 'report.exported'
  | 'po_import.uploaded'
  | 'po_import.parsed'
  | 'po_import.failed'
  | 'po_import.approved'
  | 'po_import.canceled'
  | 'vendor_item_mapping.upserted'
  | 'stock.receipt.posted'
  | 'stock.receipt.reversed'
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
  | 'bundle.assembled'
  | 'bundle.distributed'
  | 'order_request.created'
  | 'order_request.approved'
  | 'order_request.denied'
  | 'order_request.status_changed'
  | 'order_request.cancelled'
  | 'order_request.delivered'
  | 'order_request.public_link_rotated';

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
 * because of RLS). Captures user from the cached withContext(), plus IP +
 * UA from request headers when available.
 *
 * Best-effort — never throws to the caller. Audit failures are logged to
 * stderr only; we never want a logging error to break a user action.
 */
export async function audit(payload: AuditPayload): Promise<void> {
  try {
    const ctx = await withContext();
    const h = await headers();
    const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || null;
    const userAgent = h.get('user-agent') || null;

    const admin = createAdminClient();
    await admin.from('audit_logs').insert({
      organization_id: ctx.organizationId,
      user_id: ctx.userId,
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

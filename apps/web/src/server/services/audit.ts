import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { headers } from 'next/headers';

import { reportError } from '@/lib/error-reporter';
import { mapWithConcurrency } from '@/lib/supabase/in-filter';

import { withContext, type ServiceContext } from './context';

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
  | 'rental.created'
  | 'rental.returned'
  | 'rental.cancelled'
  | 'user.deactivated'
  | 'user.reactivated'
  | 'user.password.changed'
  | 'security.session_revoked'
  | 'inventory.item.created'
  | 'inventory.item.updated'
  | 'inventory.item.duplicated'
  | 'inventory.item.archived'
  | 'inventory.item.restored'
  | 'inventory.item.deleted'
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
  | 'recurring_po_template.deleted'
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
 * diffs, and a failed request loses at most 100 rows.
 */
export const AUDIT_INSERT_BATCH_ROWS = 100;

/**
 * INSERT requests `auditMany` keeps in flight at once. One `void audit()` per
 * selected item put 443 POSTs on the wire at the same moment on the lab org:
 * the gateway answered 190 of them 502, and the bulk Set rack read that
 * started right after them failed too. Two in flight writes 500 rows in three
 * round trips and leaves room for the request that is doing the real work.
 */
export const AUDIT_INSERT_CONCURRENCY = 2;

type RequestMeta = { ip: string | null; userAgent: string | null };

/** IP and user agent of the current request, read once per call. */
async function readRequestMeta(): Promise<RequestMeta> {
  const h = await headers();
  return {
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || null,
    userAgent: h.get('user-agent') || null,
  };
}

/** The one place an audit_logs row is shaped, so `audit` and `auditMany`
 *  write exactly the same columns and metadata for the same payload. */
function auditRow(payload: AuditPayload, c: ServiceContext, meta: RequestMeta) {
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
      ...(payload.extra ?? {}),
    },
  };
}

/** The distinct events of a batch, for a report line. */
function eventsLabel(payloads: readonly AuditPayload[]): string {
  return [...new Set(payloads.map((p) => p.event))].join(',');
}

/**
 * What a rejected INSERT said about itself: HTTP status and PostgREST/Postgres
 * code only. Never the message or details: a Postgres rejection quotes the
 * failing row ("Failing row contains (...)"), and audit metadata carries item
 * names and before/after values.
 */
function insertFailure(res: {
  status?: number;
  statusText?: string;
  error: { code?: string } | null;
}) {
  return {
    status: typeof res.status === 'number' ? res.status : null,
    statusText: res.statusText || null,
    code: res.error?.code || null,
  };
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
 * Best-effort for the action — never throws to the caller — but a lost row is
 * never silent: a refused or failed INSERT is reported. supabase-js returns a
 * failed request as `{ error }` instead of throwing, so the result is read;
 * the catch only sees what throws (no context, no request headers).
 *
 * For one row per item over a selection or a list, use `auditMany`.
 */
export async function audit(payload: AuditPayload, ctx?: ServiceContext): Promise<void> {
  try {
    const c = ctx ?? (await withContext());
    const meta = await readRequestMeta();
    const admin = createAdminClient();
    const res = await admin.from('audit_logs').insert(auditRow(payload, c, meta));
    if (res.error) {
      void reportError(new Error('Audit rows were not written'), {
        tag: 'audit.write_failed',
        level: 'warning',
        organizationId: c.organizationId,
        extra: {
          event: payload.event,
          entityType: payload.entityType ?? null,
          lost: 1,
          ...insertFailure(res),
        },
      });
    }
  } catch (e) {
    void reportError(e, {
      tag: 'audit.write_failed',
      level: 'warning',
      extra: { event: payload.event, entityType: payload.entityType ?? null, lost: 1 },
    });
  }
}

/**
 * Writes one audit row per payload, for the loops that audit every item of a
 * selection or a list (bulk actions, crons, cancellations).
 *
 * The rows are exactly the rows `audit()` writes for the same payloads (same
 * user, IP, user agent, event and metadata; the headers are read once). They
 * go out AUDIT_INSERT_BATCH_ROWS per INSERT with at most
 * AUDIT_INSERT_CONCURRENCY INSERTs in flight, instead of one request per row
 * all at once.
 *
 * Best-effort for the action like `audit()`: never throws. A chunk that fails
 * is counted, and when any row is lost ONE report says which events and how
 * many rows, never their contents. Returns the counts so a caller or a test
 * can see them; callers are free to ignore them.
 */
export async function auditMany(
  payloads: readonly AuditPayload[],
  ctx?: ServiceContext,
): Promise<{ written: number; lost: number }> {
  const total = payloads.length;
  if (total === 0) return { written: 0, lost: 0 };
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
    void reportError(e, {
      tag: 'audit.write_failed',
      level: 'warning',
      organizationId: ctx?.organizationId ?? null,
      extra: { event: events, lost: total, total },
    });
    return { written: 0, lost: total };
  }

  const chunks: Array<typeof rows> = [];
  for (let i = 0; i < rows.length; i += AUDIT_INSERT_BATCH_ROWS) {
    chunks.push(rows.slice(i, i + AUDIT_INSERT_BATCH_ROWS));
  }
  let lost = 0;
  let firstFailure: ReturnType<typeof insertFailure> | { thrown: string } | null = null;
  // `run` never throws, so mapWithConcurrency's stop-on-first-error never
  // applies: every chunk is attempted.
  await mapWithConcurrency(chunks, AUDIT_INSERT_CONCURRENCY, async (chunk) => {
    try {
      const res = await admin.from('audit_logs').insert(chunk);
      if (res.error) {
        lost += chunk.length;
        firstFailure ??= insertFailure(res);
      }
    } catch (e) {
      lost += chunk.length;
      firstFailure ??= { thrown: e instanceof Error ? e.name : typeof e };
    }
  });

  if (lost > 0) {
    void reportError(new Error('Audit rows were not written'), {
      tag: 'audit.write_failed',
      level: 'warning',
      organizationId: c.organizationId,
      extra: { event: events, lost, total, ...(firstFailure ?? {}) },
    });
  }
  return { written: total - lost, lost };
}

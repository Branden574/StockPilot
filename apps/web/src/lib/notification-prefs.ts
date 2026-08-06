/**
 * Notification-preference key list + types. Lives in a regular module
 * (NOT a `'use server'` action file) so it can be imported by both the
 * server action and the client form. A `'use server'` file is only
 * allowed to export async functions — exporting a runtime constant
 * from there errors the production build with "A use server file can
 * only export async functions, found object" during page collection.
 */

// email_low_stock / email_po_status / email_team_invites removed 2026-07-20
// (owner decision): dead toggles — no send path ever read them. Their DB
// columns (0002) stay in place, just unread/unwritten; no migration needed.
export const NOTIFICATION_PREF_KEYS = [
  'push_low_stock',
  'push_po_status',
  'push_stock_transfer',
  // Phase-6 order events:
  'email_order_received',
  'email_order_status_changed',
  'email_order_in_transit',
  'email_order_completed',
  'push_order_assigned_to_me',
  // Manager "new order request" ping opt-out (0265):
  'push_order_request_created',
  // Schedule reminders (0258):
  'email_schedule_reminders',
  'push_schedule_reminders',
  // Auto-archive-on-zero-stock cron notice opt-out (0267):
  'push_item_auto_archived',
  // Maintenance requests (Task 21) — authorized-viewer broadcast opt-outs
  // plus the requester's own draft-reminder ping. photo_rejected has no
  // column: it is never mutable (maintenance-notify.ts's own doc comment).
  'push_maintenance_new_request',
  'push_maintenance_urgent_request',
  'push_maintenance_assigned',
  'push_maintenance_draft_reminder',
  // Requester-facing close-out ping (Maintenance Resolved spec §7) — fires
  // once when a manage-holder marks the requester's own request resolved.
  'push_maintenance_resolved',
] as const;

export type NotificationPrefKey = (typeof NOTIFICATION_PREF_KEYS)[number];

export type NotificationPreferences = Record<NotificationPrefKey, boolean>;

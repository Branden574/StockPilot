/**
 * Notification-preference key list + types. Lives in a regular module
 * (NOT a `'use server'` action file) so it can be imported by both the
 * server action and the client form. A `'use server'` file is only
 * allowed to export async functions — exporting a runtime constant
 * from there errors the production build with "A use server file can
 * only export async functions, found object" during page collection.
 */

export const NOTIFICATION_PREF_KEYS = [
  'email_low_stock',
  'email_po_status',
  'email_team_invites',
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
] as const;

export type NotificationPrefKey = (typeof NOTIFICATION_PREF_KEYS)[number];

export type NotificationPreferences = Record<NotificationPrefKey, boolean>;

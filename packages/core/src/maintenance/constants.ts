/**
 * Maintenance-request constants. The recipients are COMPILE-TIME LITERALS on
 * purpose (the delivery-request security posture, lib/site.ts:33-46): never
 * read from URL params, localStorage, form fields, request descriptions,
 * related-item data, or client API values. The email builder takes NO
 * recipient argument — it reads this object — so there is no parameter for a
 * caller to poison. Frozen so a stray assignment throws in strict mode.
 *
 * These are REAL addresses: dc4@learn4life.org feeds a live Zendesk email
 * intake and arosas@cvwest.org is a real person. No test, tool, or
 * verification step may ever open a compose window or navigate a mailto
 * against them — string assertions only (plan Global Constraint 2).
 */
export const L4L_MAINTENANCE_EMAIL = Object.freeze({
  to: 'dc4@learn4life.org',
  cc: 'arosas@cvwest.org',
} as const);

/** Cosmetic OWA chip names — same values the delivery assistant verified on
 *  the live tenant. Must stay free of RFC 5322 specials (< > , " @ ;). */
export const L4L_MAINTENANCE_EMAIL_NAMES = Object.freeze({
  to: 'Fresno Warehouse DC4',
  cc: 'Andrew Rosas',
} as const);

/** Accuracy, not optimism: no "assigned", no "ticket created", no "notified". */
export const MAINTENANCE_CC_NOTICE =
  'The DC4 address creates the maintenance ticket in the email system. A copy will also be sent to arosas@cvwest.org.';

export const MAINTENANCE_CATEGORIES = [
  'Facilities',
  'Electrical',
  'Plumbing',
  'Heating or air conditioning',
  'Technology',
  'Furniture',
  'Vehicle',
  'Security',
  'Safety',
  'Cleaning',
  'Inventory or equipment',
  'Other',
] as const;

export const MAINTENANCE_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type MaintenancePriority = (typeof MAINTENANCE_PRIORITIES)[number];

export type MaintenanceStatus = 'saved' | 'draft_opened' | 'archived' | 'cancelled';

/** The ONLY status vocabulary (brief section 20). Never 'sent', never
 *  'ticket created' — StockPilot cannot observe either. */
export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  saved: 'Saved',
  draft_opened: 'Email draft opened',
  archived: 'Archived',
  cancelled: 'Cancelled',
};

export const MAINTENANCE_MAX_PHOTOS = 8;
export const MAINTENANCE_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAINTENANCE_SHARE_LINK_TTL_DAYS = 180;

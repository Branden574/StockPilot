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

/**
 * Accuracy, not optimism: no "assigned", no "ticket created", no "notified".
 *
 * The address is INTERPOLATED, not retyped. It was hand-typed here until
 * 2026-08-13 — the same defect, in the same shape, as the delivery twin in
 * `../orders/delivery-request-recipients.ts`, and fixed in the same commit
 * because fixing one copy of a duplicated behaviour is not a fix (recurring
 * pattern #26). A hand-typed copy makes this sentence a second, silent
 * definition of the CC: change `L4L_MAINTENANCE_EMAIL.cc` and every screen
 * showing this notice keeps naming the old mailbox while the mail goes to the
 * new one, telling the requester in writing that a copy went somewhere it did
 * not.
 */
export const MAINTENANCE_CC_NOTICE =
  `The DC4 address creates the maintenance ticket in the email system. A copy will also be sent to ${L4L_MAINTENANCE_EMAIL.cc}.`;

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

export type MaintenanceStatus = 'saved' | 'draft_opened' | 'resolved' | 'archived' | 'cancelled';

/** The ONLY status vocabulary (brief section 20; 'resolved' added by the
 *  Maintenance Resolved program, spec §1.1/§11). Never 'sent', never
 *  'ticket created' — StockPilot cannot observe either. 'resolved' is
 *  legitimate because it describes a StockPilot-local record a human made,
 *  not an observation of Zendesk. Insertion order between draft_opened and
 *  archived is load-bearing: the web pill order and the REST route's
 *  STATUS_VALUES both derive from this record's key order (spec §1.1). */
export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  saved: 'Saved',
  draft_opened: 'Email draft opened',
  resolved: 'Resolved',
  archived: 'Archived',
  cancelled: 'Cancelled',
};

export const MAINTENANCE_MAX_PHOTOS = 8;
export const MAINTENANCE_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAINTENANCE_SHARE_LINK_TTL_DAYS = 180;

/** Attachment kinds (migration 0317): 'requester' is the shipped default for
 *  photos attached at request-creation time; 'resolution' labels proof
 *  photos a manage-holder attaches when closing out via resolve(). Literal
 *  values — NEVER derived from the migration file (spec §2.2/§3.1). */
export const MAINTENANCE_ATTACHMENT_KINDS = ['requester', 'resolution'] as const;
export type MaintenanceAttachmentKind = (typeof MAINTENANCE_ATTACHMENT_KINDS)[number];

/** Resolution note cap (spec §3.1); mirrors migration 0317's
 *  `resolution_note` CHECK (length between 1 and 2000) — the zod schema is
 *  the operative bound, the CHECK is the safety margin. */
export const MAINTENANCE_RESOLUTION_NOTE_MAX = 2000;

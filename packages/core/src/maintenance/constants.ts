import { ccNotice } from '../email/cc-notice';
import type { OrgEmailRoutingReadState } from '../email/org-email-routing';
import { maintenanceEmailRecipients, type MaintenanceEmailRecipients } from './recipients';

/**
 * Maintenance-request constants.
 *
 * THE RECIPIENTS BELOW ARE L4L'S MAILBOXES, and since 2026-08-16 (per-org
 * email routing, migration 0337) they are NOT what the surfaces read. The
 * email builder now takes recipients as INPUT (`MaintenanceEmailInput.
 * recipients`, constructed only by `maintenanceEmailRecipients` in
 * `./recipients.ts`), and surfaces resolve them from
 * `organizations.email_routing`. These constants keep exactly two roles:
 *
 *  1. THE CODE-BEFORE-MIGRATION FALLBACK. Deploy-order safety is FAIL OPEN
 *     to pre-feature behavior: a reader that finds no `email_routing` column
 *     (Postgres 42703) degrades to these values — the only path that ever
 *     returns them; once the column exists it is never taken. See
 *     `maintenanceRecipientsForRouting` below.
 *  2. THE SEED'S SOURCE OF TRUTH: migration 0337 seeds L4L's org row with
 *     these exact values, so nothing changes for that tenant.
 *
 * An unconfigured org gets NEITHER — its email action hides — and an invalid
 * stored value fails CLOSED the same way, never back to these constants.
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
 * THE COMPILED VALUE, built through the only constructor there is — the
 * maintenance twin of `DELIVERY_REQUEST_RECIPIENTS`. The fallback mapping
 * below and the tests share this one already-validated instance; no surface
 * imports it as "the recipients" any more.
 */
export const L4L_MAINTENANCE_RECIPIENTS: MaintenanceEmailRecipients = maintenanceEmailRecipients({
  to: L4L_MAINTENANCE_EMAIL.to,
  cc: L4L_MAINTENANCE_EMAIL.cc,
  toName: L4L_MAINTENANCE_EMAIL_NAMES.to,
  ccName: L4L_MAINTENANCE_EMAIL_NAMES.cc,
});

/**
 * The recipients notice as a PURE FUNCTION of the recipients — required now
 * that recipients are per-org data. Accuracy, not optimism, unchanged: the
 * sentence claims only where the mail is addressed — no "assigned", no
 * "ticket created", no "notified". The previous fixed notice's "The DC4
 * address creates the maintenance ticket in the email system" sentence was
 * L4L-Zendesk-specific knowledge the platform cannot truthfully claim for an
 * arbitrary org's configured mailbox, so it is gone everywhere, L4L's
 * screens included (deliberate copy change, per-org routing design).
 */
export function maintenanceCcNotice(recipients: { to: string; cc: string }): string {
  return ccNotice(recipients);
}

/**
 * The notice for the COMPILED pair — kept under its shipped name for the
 * fallback path and the tests, redefined as the function applied to the
 * compiled values so it can never drift from the addresses the way a
 * hand-typed sentence once could (recurring pattern #26; the delivery twin
 * is redefined identically).
 */
export const MAINTENANCE_CC_NOTICE = maintenanceCcNotice(L4L_MAINTENANCE_EMAIL);

/**
 * Map a routing READ to the recipients a maintenance surface may compose
 * with — the same matrix as the delivery twin (`deliveryRecipientsForRouting`),
 * against the maintenance brand:
 *
 *   'fallback' -> the COMPILED constants. DEPLOY-ORDER SAFETY: only the
 *                 missing-column window (42703) produces this state, so
 *                 code-before-migration is byte-identical to pre-feature
 *                 behavior; once the column exists this arm is never taken.
 *   'valid'    -> the stored recipients, re-branded through the factory
 *                 (cannot throw for parser-produced values; belt-and-braces
 *                 catch fails CLOSED).
 *   'unset'    -> null: the email action is HIDDEN for this org.
 *   'invalid'  -> null: FAIL CLOSED. Never the constants — that would
 *                 silently mail another tenant's warehouse.
 */
export function maintenanceRecipientsForRouting(
  read: OrgEmailRoutingReadState,
): MaintenanceEmailRecipients | null {
  switch (read.state) {
    case 'fallback':
      return L4L_MAINTENANCE_RECIPIENTS;
    case 'valid':
      try {
        return maintenanceEmailRecipients(read.recipients);
      } catch {
        return null;
      }
    default:
      return null;
  }
}

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

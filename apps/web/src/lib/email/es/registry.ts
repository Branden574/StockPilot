/**
 * StockPilot email system — the email registry.
 *
 * Typed port of `ES.EMAILS` from `docs/design/email-system/es-tokens.js`.
 * Every subject / preheader / badge label / CTA string is byte-identical
 * to the registry; the sample-world merge values (WO-04292026, L4L North
 * Region, ...) become builder parameters. Do NOT reword any string here —
 * the registry is normative. Where the design lists a `rec:` refined
 * subject it is kept as a comment for product sign-off, not implemented.
 *
 * FLAG (count): the design package consistently says "28 templates"
 * (IMPLEMENTATION_PROMPT.md "ALL 24 live emails, 2 latent templates, and
 * 2 proposed concepts"), but ES.EMAILS in es-tokens.js contains 29 rows
 * (25 live + 2 latent + 2 concept), and the prompt's own family list also
 * sums to 29. The operative instruction is "implement every row of
 * ES.EMAILS", so all 29 rows are here; the 28-vs-29 miscount is surfaced
 * for the owner rather than silently resolved.
 *
 * COUNT (2026-08-06, Maintenance Resolved program): a 30th row,
 * `maintenance-resolved`, is added outside the original 29-row design
 * package — the resolution email for the maintenance-requests module
 * (docs/superpowers/plans/2026-08-06-maintenance-resolved.md, spec §6.1).
 * 29 -> 30 total; 25 -> 26 live; the `maintenance` family is new.
 */

import type { EsStatusVariant } from './tokens';

export type EsEmailFamily =
  | 'security'
  | 'invites'
  | 'orders'
  | 'fulfillment'
  | 'rentals'
  | 'schedule'
  | 'digest'
  | 'support'
  | 'maintenance';

export type EsEmailStatus = 'live' | 'latent' | 'concept';

/**
 * cat: ess = essential transactional · pref = preference-controlled ·
 * ext = external recipient · int = internal.
 */
export type EsEmailCategory = 'ess' | 'pref' | 'ext' | 'int';

/** Footer variant — mirrors the registry's `foot` field (equals `cat` on every row). */
export type EsFooterKind = EsEmailCategory;

/**
 * Production motion asset ids (MOTION registry + the clock-arc overdue
 * variant E2 renders + `tick`, produced 2026-07-20 for the received email's
 * "L2 · Timeline tick" — an 11px inline timeline dot, not a hero).
 */
export type EsMotionAssetId =
  | 'lock'
  | 'pulse'
  | 'tiles'
  | 'route'
  | 'reverse'
  | 'scanner'
  | 'settle'
  | 'check'
  | 'pin'
  | 'tag'
  | 'clock'
  | 'clock-arc'
  | 'calendar'
  | 'bars'
  | 'tick';

export interface EsEmailDefinition {
  id: string;
  family: EsEmailFamily;
  name: string;
  status: EsEmailStatus;
  category: EsEmailCategory;
  /** Header mono tag (top-right of the brand strip). */
  tag: string;
  /** When this email fires (registry `trig`, documentation only). */
  trigger: string;
  /** Who receives it (registry `to`, documentation only). */
  to: string;
  /** RFC-5322 sender, verbatim from the registry. */
  from: string;
  /** Reply-to INTENT, verbatim from the registry (routing is a family/dispatch concern). */
  replyTo: string;
  /** Subject builder. Static text byte-identical to the registry. */
   
  subject: (params: any) => string;
  /** Preheader builder. Static text byte-identical to the registry. */
   
  preheader: (params: any) => string;
  badge: {
    variant: EsStatusVariant;
    /** Label builder — static labels ignore the params. */
     
    label: (params: any) => string;
  };
  /** Primary CTA label, verbatim. */
  cta: string;
  /** Secondary CTA label, verbatim (absent on some emails). */
  cta2?: string;
  /** Registry motion note, verbatim (e.g. "L1 · Lock + ring", "None"). */
  motionNote: string;
  /** Production asset id this email embeds, or null for static emails. */
  motionAsset: EsMotionAssetId | null;
  footer: EsFooterKind;
}

// Sample-world values (ES.W) used by the registry strings — exported so
// tests can assert byte-identical reproduction of the registry copy.
export const ES_SAMPLE = {
  org: 'L4L North Region',
  wo: 'WO-04292026',
  po: '#7741-2205',
  warehouse: 'DCIV — Fresno',
  destination: 'CVW — Manchester',
} as const;

const d = <T extends EsEmailDefinition>(def: T): T => def;

export const ES_EMAILS: readonly EsEmailDefinition[] = [
  // ── Security ──────────────────────────────────────────────────────
  d({
    id: 'pw-reset',
    family: 'security',
    name: 'Password Reset',
    status: 'live',
    category: 'ess',
    tag: 'Security',
    trigger: 'User requests a password reset',
    to: 'Account holder',
    from: 'StockPilot Security <security@stockpilotusa.com>',
    replyTo: 'Not monitored — support link inside',
    subject: () => 'Reset your StockPilot password',
    preheader: (p: { linkExpiry: string }) =>
      `This link works for ${p.linkExpiry}. If you didn’t ask for it, you can safely ignore this email.`,
    badge: { variant: 'sec', label: () => 'Security' },
    cta: 'Reset password',
    cta2: 'Contact support',
    motionNote: 'L1 · Lock + ring',
    motionAsset: 'lock',
    footer: 'ess',
  }),
  d({
    id: 'signin',
    family: 'security',
    name: 'New Sign-In Alert',
    status: 'live',
    category: 'ess',
    tag: 'Security',
    trigger: 'Successful sign-in from an unrecognized device or location',
    to: 'Account holder',
    from: 'StockPilot Security <security@stockpilotusa.com>',
    replyTo: 'Not monitored — support link inside',
    // FLAG (registry `flag`): current production copy claims sign-in
    // alerts can be managed in preferences — no such preference exists.
    // The claim is removed in this design; adding a real control is a
    // product/security decision. Do not reintroduce the old copy.
    subject: () => 'New sign-in to your StockPilot account',
    preheader: (p: { summary: string; time: string }) =>
      `${p.summary} · ${p.time}. Wasn’t you? Secure your account now.`,
    badge: { variant: 'sec', label: () => 'New sign-in' },
    cta: 'Secure my account',
    cta2: 'Reset password',
    motionNote: 'L1 · Device pulse',
    motionAsset: 'pulse',
    footer: 'ess',
  }),

  // ── Invitations ───────────────────────────────────────────────────
  d({
    id: 'team-invite',
    family: 'invites',
    name: 'Team Invite',
    status: 'live',
    category: 'ess',
    tag: 'Workspace Invite',
    trigger: 'Admin invites a member to a workspace',
    to: 'Invitee (may be new to StockPilot)',
    from: 'StockPilot <hello@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { org: string }) =>
      `You’re invited to join ${p.org} on StockPilot`,
    // `roleWithArticle` carries its article ("an Operator") so the static
    // registry text stays byte-identical without baking in "an".
    preheader: (p: { inviterFirst: string; roleWithArticle: string; window: string }) =>
      `${p.inviterFirst} added you as ${p.roleWithArticle}. Accept within ${p.window} to keep the seat.`,
    badge: {
      variant: 'warn',
      label: (p: { window: string }) => `Pending · expires in ${p.window}`,
    },
    cta: 'Accept invitation',
    cta2: 'What is StockPilot?',
    motionNote: 'None · static workspace card',
    motionAsset: null,
    footer: 'ess',
  }),
  d({
    id: 'invite-reminder',
    family: 'invites',
    name: 'Invite Reminder',
    status: 'live',
    category: 'ess',
    tag: 'Workspace Invite',
    trigger: 'Invite unaccepted after 4 days',
    to: 'Invitee',
    from: 'StockPilot <hello@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { org: string }) =>
      `Reminder: you’re invited to join ${p.org} on StockPilot`,
    preheader: (p: { expiresOn: string }) =>
      `Your original invitation is still open — it now expires ${p.expiresOn}.`,
    badge: { variant: 'warn', label: () => 'Reminder · still pending' },
    cta: 'Accept invitation',
    motionNote: 'None',
    motionAsset: null,
    footer: 'ess',
  }),
  d({
    id: 'ws-ready',
    family: 'invites',
    name: 'Workspace Ready',
    status: 'live',
    category: 'ess',
    tag: 'Workspace',
    trigger: 'Workspace provisioning completes',
    to: 'Workspace owner',
    from: 'StockPilot <hello@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { org: string }) =>
      `Your ${p.org} workspace on StockPilot is ready`,
    preheader: () =>
      'Inventory, orders, and scheduling are live. Two quick steps finish setup.',
    badge: { variant: 'ok', label: () => 'Ready' },
    cta: 'Open workspace',
    cta2: 'Invite your team',
    motionNote: 'L3 · Tiles settle + check',
    motionAsset: 'tiles',
    footer: 'ess',
  }),
  d({
    id: 'portal-invite',
    family: 'invites',
    name: 'Portal Invite (Magic Link)',
    status: 'live',
    category: 'ext',
    tag: 'Supplier Portal',
    trigger: 'Supplier invites a B2B customer to their portal',
    to: 'External customer contact — may not know StockPilot',
    from: 'L4L North Region via StockPilot <portal@stockpilotusa.com>',
    replyTo: 'Replies go to the supplier',
    subject: (p: { org: string }) =>
      `You’re invited to order from ${p.org}’s supplier portal`,
    preheader: () =>
      'Browse the catalog and place orders. This secure link signs you in — no password needed.',
    badge: { variant: 'purple', label: () => 'Portal access' },
    cta: 'Open the portal',
    // FLAG: registry motion "L2 · Catalog tiles" has NO corresponding row
    // in the MOTION asset registry (es-tokens.js MOTION covers 13 assets;
    // 'tiles' is assigned to Workspace Ready only). Until the motion board
    // gains a catalog-tiles asset, this email has no producible asset.
    motionNote: 'L2 · Catalog tiles',
    motionAsset: null,
    footer: 'ext',
  }),

  // ── Orders ────────────────────────────────────────────────────────
  d({
    id: 'confirm',
    family: 'orders',
    name: 'Confirm Request',
    status: 'live',
    category: 'ess',
    tag: 'Order Update',
    trigger: 'Order request created — double opt-in required',
    to: 'Requester',
    from: 'StockPilot <orders@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { orderId: string }) =>
      `Confirm ${p.orderId} to send it to the warehouse`,
    preheader: (p: { warehouse: string; window: string }) =>
      `One tap sends this request to ${p.warehouse}. Unconfirmed requests expire in ${p.window}.`,
    badge: { variant: 'warn', label: () => 'Awaiting confirmation' },
    cta: 'Confirm request',
    cta2: 'Didn’t create this?',
    motionNote: 'None · static hold state',
    motionAsset: null,
    footer: 'ess',
  }),
  d({
    id: 'received',
    family: 'orders',
    name: 'Request Received',
    status: 'live',
    category: 'pref',
    tag: 'Order Update',
    trigger: 'Confirmed request lands at the warehouse',
    to: 'Requester',
    from: 'StockPilot <orders@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { orderId: string }) => `${p.orderId} received — we’re on it`,
    preheader: (p: { submittedAt: string; warehouse: string }) =>
      `Submitted ${p.submittedAt} to ${p.warehouse}. Approval is the next step.`,
    badge: { variant: 'info', label: () => 'Received' },
    cta: 'View request',
    // The MOTION board has no timeline-tick row, so this asset was produced
    // in-house (2026-07-20): `tick` — an 11px animated dot that replaces
    // the active timeline glyph (orderTimeline currentDotImgSrc), not a
    // hero-slot asset.
    motionNote: 'L2 · Timeline tick',
    motionAsset: 'tick',
    footer: 'pref',
  }),
  d({
    id: 'approved',
    family: 'orders',
    name: 'Order Approved',
    status: 'live',
    category: 'pref',
    tag: 'Order Update',
    trigger: 'Approver approves the request',
    to: 'Requester',
    from: 'StockPilot <orders@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { orderId: string }) =>
      `${p.orderId} is approved — packing has started`,
    preheader: (p: { units: number; lines: number; shipDate: string; warehouse: string }) =>
      `Reserved ${p.units} units across ${p.lines} lines. Ships ${p.shipDate} from ${p.warehouse}.`,
    badge: { variant: 'ok', label: () => 'Approved' },
    cta: 'Track this order',
    motionNote: 'L3 · Boxes settle',
    motionAsset: 'settle',
    footer: 'pref',
  }),
  d({
    id: 'denied',
    family: 'orders',
    name: 'Order Denied',
    status: 'live',
    category: 'pref',
    tag: 'Order Update',
    trigger: 'Approver denies the request',
    to: 'Requester',
    from: 'StockPilot <orders@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { orderId: string }) => `${p.orderId} wasn’t approved`,
    preheader: (p: { reasonSummary: string }) =>
      `Reason: ${p.reasonSummary}. You can revise and resubmit.`,
    badge: { variant: 'err', label: () => 'Not approved' },
    cta: 'View request',
    cta2: 'Contact approver',
    motionNote: 'None — intentionally static',
    motionAsset: null,
    footer: 'pref',
  }),
  d({
    id: 'transit',
    family: 'orders',
    name: 'Order In Transit',
    status: 'live',
    category: 'pref',
    tag: 'Order Update',
    trigger: 'Shipment dispatched from warehouse',
    to: 'Requester',
    from: 'StockPilot <orders@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { orderId: string }) => `${p.orderId} is on the way`,
    preheader: (p: { warehouse: string; departedAt: string; eta: string; destination: string }) =>
      `Left ${p.warehouse} ${p.departedAt} · estimated ${p.eta} at ${p.destination}.`,
    badge: { variant: 'info', label: () => 'In transit' },
    cta: 'Track shipment',
    motionNote: 'L2 · Route progress',
    motionAsset: 'route',
    footer: 'pref',
  }),
  d({
    id: 'delivered',
    family: 'orders',
    name: 'Order Delivered',
    status: 'live',
    category: 'pref',
    tag: 'Order Update',
    trigger: 'Delivery confirmed / signed',
    to: 'Requester',
    from: 'StockPilot <orders@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { orderId: string }) => `${p.orderId} was delivered — thanks`,
    preheader: (p: { signer: string; destination: string; signedAt: string }) =>
      `Signed by ${p.signer} at ${p.destination}, ${p.signedAt}. Receipt inside.`,
    badge: { variant: 'ok', label: () => 'Delivered' },
    cta: 'View receipt',
    motionNote: 'L3 · Check draw',
    motionAsset: 'check',
    footer: 'pref',
  }),
  d({
    id: 'cancelled',
    family: 'orders',
    name: 'Order Cancelled',
    status: 'live',
    category: 'pref',
    tag: 'Order Update',
    trigger: 'Request cancelled by requester or ops',
    to: 'Requester',
    from: 'StockPilot <orders@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { orderId: string }) => `${p.orderId} was cancelled`,
    // `by` carries "the requester" in the sample world (may be ops).
    preheader: (p: { cancelledOn: string; by: string }) =>
      `Cancelled ${p.cancelledOn} by ${p.by}. Reserved units returned to stock.`,
    badge: { variant: 'neutral', label: () => 'Cancelled' },
    cta: 'View request',
    cta2: 'Start a new request',
    motionNote: 'None — neutral treatment',
    motionAsset: null,
    footer: 'pref',
  }),
  d({
    // LATENT: dispatch decision pending (see policy audit). Template
    // exists in code but nothing dispatches it; wiring a trigger is an
    // engineering decision — designed and ready either way.
    id: 'packing',
    family: 'orders',
    name: 'Packing Slip Generated',
    status: 'latent',
    category: 'pref',
    tag: 'Order Update',
    trigger: 'Packing slip generated (no dispatch path today)',
    to: 'Requester',
    from: 'StockPilot <orders@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { orderId: string }) => `${p.orderId} is being packaged`,
    preheader: (p: { lines: number; warehouse: string }) =>
      `${p.lines} lines are being picked and packed at ${p.warehouse}. Next: staged for delivery.`,
    badge: { variant: 'info', label: () => 'Packing' },
    cta: 'View request',
    motionNote: 'L2 · Scanner sweep',
    motionAsset: 'scanner',
    footer: 'pref',
  }),
  d({
    // LATENT: dispatch decision pending (see policy audit). Template
    // exists in code but nothing dispatches it; wiring a trigger is an
    // engineering decision — designed and ready either way.
    id: 'staged',
    family: 'orders',
    name: 'Staged for Delivery',
    status: 'latent',
    category: 'pref',
    tag: 'Order Update',
    trigger: 'Order staged / ready for pickup (no dispatch path today)',
    to: 'Requester',
    from: 'StockPilot <orders@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { orderId: string }) => `${p.orderId} is ready`,
    preheader: (p: { location: string; window: string }) =>
      `Staged at ${p.location}. Pickup window: ${p.window}.`,
    badge: { variant: 'ok', label: () => 'Ready' },
    cta: 'View pickup details',
    motionNote: 'L2 · Pin pulse',
    motionAsset: 'pin',
    footer: 'pref',
  }),

  // ── Fulfillment & returns ─────────────────────────────────────────
  d({
    id: 'partial',
    family: 'fulfillment',
    name: 'Partially Fulfilled',
    status: 'live',
    category: 'pref',
    tag: 'Order Update',
    trigger: 'Delivery signed with backordered lines outstanding',
    to: 'Requester',
    from: 'StockPilot <orders@stockpilotusa.com>',
    replyTo: 'Not monitored',
    // FLAG (registry `flag`): public order emails carry different
    // suppression behavior than account emails — unify or document
    // before launch. Surfacing for product; not solved in HTML.
    subject: (p: { orderNumber: string }) =>
      `Order ${p.orderNumber}: partially fulfilled`,
    preheader: (p: { delivered: number; total: number; back: number; eta: string }) =>
      `${p.delivered} of ${p.total} units delivered. ${p.back} backordered — expected ${p.eta}.`,
    badge: { variant: 'warn', label: () => 'Partially fulfilled' },
    cta: 'View order',
    // FLAG: registry motion "L2 · Split progress" has NO corresponding
    // row in the MOTION asset registry — no producible asset today.
    motionNote: 'L2 · Split progress',
    motionAsset: null,
    footer: 'pref',
  }),
  d({
    id: 'back-shipped',
    family: 'fulfillment',
    name: 'Backordered Items Shipped',
    status: 'live',
    category: 'pref',
    tag: 'Order Update',
    trigger: 'Backordered lines dispatched',
    to: 'Requester',
    from: 'StockPilot <orders@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { orderNumber: string }) =>
      `Order ${p.orderNumber}: backordered items shipped`,
    preheader: (p: { units: number; warehouse: string; shipDate: string; method: string }) =>
      `The remaining ${p.units} units left ${p.warehouse} ${p.shipDate} via ${p.method}.`,
    badge: { variant: 'info', label: () => 'Backorder shipped' },
    cta: 'Track shipment',
    motionNote: 'L2 · Route progress',
    motionAsset: 'route',
    footer: 'pref',
  }),
  d({
    id: 'partial-receipt',
    family: 'fulfillment',
    name: 'Partial Delivery Receipt',
    status: 'live',
    category: 'ext',
    tag: 'Delivery Receipt',
    trigger: 'Signature captured on a partial delivery',
    to: 'Signer — may not be the requester or a StockPilot user',
    from: 'L4L North Region via StockPilot <orders@stockpilotusa.com>',
    replyTo: 'Replies go to the supplier',
    subject: (p: { orderNumber: string }) =>
      `Order ${p.orderNumber}: partial delivery receipt`,
    preheader: (p: { units: number; destination: string; date: string }) =>
      `Receipt for ${p.units} units received and signed at ${p.destination}, ${p.date}.`,
    badge: { variant: 'neutral', label: () => 'Receipt' },
    cta: 'View receipt',
    motionNote: 'None — receipt is static',
    motionAsset: null,
    footer: 'ext',
  }),
  d({
    id: 'return-prompt',
    family: 'fulfillment',
    name: 'Return Prompt',
    status: 'live',
    category: 'pref',
    tag: 'Order Update',
    trigger: '3 days after delivery, if return window open',
    to: 'Requester',
    from: 'StockPilot <orders@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: () => 'Need to return anything from your order?',
    // rec: 'Order #7741-2205 — returns open through May 27'
    // (refined subject awaiting product sign-off — do not implement yet)
    preheader: (p: { orderNumber: string; returnBy: string }) =>
      `Order ${p.orderNumber} · unused items accepted through ${p.returnBy}. Takes about a minute.`,
    badge: {
      variant: 'neutral',
      label: (p: { deliveredOn: string }) => `Delivered ${p.deliveredOn}`,
    },
    cta: 'Start a return',
    cta2: 'Return policy',
    motionNote: 'L2 · Reverse route',
    motionAsset: 'reverse',
    footer: 'pref',
  }),

  // ── Rentals ───────────────────────────────────────────────────────
  d({
    id: 'rental-out',
    family: 'rentals',
    name: 'Rental Checked Out',
    status: 'live',
    category: 'pref',
    tag: 'Rental',
    trigger: 'Equipment checked out to a borrower',
    to: 'Borrower',
    from: 'StockPilot <rentals@stockpilotusa.com>',
    replyTo: 'Not monitored',
    // FLAG (registry `flag`): rental emails currently ship with no
    // unsubscribe or preference mechanism. Product must classify each
    // as essential vs. preference-controlled before this footer goes
    // live ("rental classification decision" — see policy flags).
    subject: () => 'Your rental is checked out',
    // rec: 'Scanner Z-220 checked out — due back Jun 9'
    // (refined subject awaiting product sign-off — do not implement yet)
    preheader: (p: { item: string; qty: number; due: string; location: string }) =>
      `${p.item} ×${p.qty} · due ${p.due} at ${p.location}.`,
    badge: { variant: 'info', label: () => 'Checked out' },
    cta: 'View rental',
    motionNote: 'L2 · Tag swing',
    motionAsset: 'tag',
    footer: 'pref',
  }),
  d({
    id: 'rental-returned',
    family: 'rentals',
    name: 'Rental Returned',
    status: 'live',
    category: 'pref',
    tag: 'Rental',
    trigger: 'Equipment checked back in',
    to: 'Borrower',
    from: 'StockPilot <rentals@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: () => 'Thanks — your rental has been returned',
    preheader: (p: { item: string; qty: number; at: string }) =>
      `${p.item} ×${p.qty} checked in ${p.at}. All set.`,
    badge: { variant: 'ok', label: () => 'Returned' },
    cta: 'View record',
    motionNote: 'L3 · Check draw',
    motionAsset: 'check',
    footer: 'pref',
  }),
  d({
    id: 'rental-overdue',
    family: 'rentals',
    name: 'Rental Overdue',
    status: 'live',
    category: 'pref',
    tag: 'Rental',
    trigger: 'Daily check finds rental past due',
    to: 'Borrower',
    from: 'StockPilot <rentals@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: () => 'Reminder: your rental is overdue',
    // rec: 'Scanner Z-220 was due Jun 9 — please return it'
    // (refined subject awaiting product sign-off — do not implement yet)
    preheader: (p: { due: string; overdueFor: string }) =>
      `Due ${p.due} — ${p.overdueFor} ago. Others are waiting on this equipment.`,
    badge: {
      variant: 'err',
      // Owner-approved amendment 2026-07-20: the design's verbatim builder
      // said "· N days" flat, but 1 day is the COMMON case (the cron nudges
      // on the first overdue day) and "Overdue · 1 days" led the email.
      label: (p: { overdueDays: number }) =>
        `Overdue · ${p.overdueDays} ${p.overdueDays === 1 ? 'day' : 'days'}`,
    },
    cta: 'Review rental',
    cta2: 'Contact equipment desk',
    motionNote: 'L1 · Clock arc (restrained)',
    motionAsset: 'clock-arc',
    footer: 'pref',
  }),

  // ── Schedule ──────────────────────────────────────────────────────
  d({
    id: 'sched-tmrw',
    family: 'schedule',
    name: 'Schedule Reminder — Tomorrow',
    status: 'live',
    category: 'pref',
    tag: 'Schedule',
    trigger: '24h before an assigned event',
    to: 'Assignee',
    from: 'StockPilot <schedule@stockpilotusa.com>',
    replyTo: 'Not monitored',
    // `when` is the day word the SENDER computed ("today" / "tomorrow" / a
    // weekday). It defaults to 'tomorrow' so the catalog preview and every
    // existing content pin render unchanged, but the cron always passes the
    // real one — this template covers any event inside the day-ahead window,
    // and a good share of those are later the same day.
    subject: (p: { event: string; when?: string }) =>
      `Reminder: ${p.event} — ${p.when ?? 'tomorrow'}`,
    preheader: (p: { when: string; where: string }) =>
      `${p.when} · ${p.where}. Assigned to you.`,
    badge: { variant: 'info', label: (p: { day?: string } = {}) => p.day ?? 'Tomorrow' },
    cta: 'Open schedule',
    motionNote: 'L2 · Calendar tile',
    motionAsset: 'calendar',
    footer: 'pref',
  }),
  d({
    id: 'sched-hour',
    family: 'schedule',
    name: 'Schedule Reminder — 1 Hour',
    status: 'live',
    category: 'pref',
    tag: 'Schedule',
    trigger: '60 min before an assigned event',
    to: 'Assignee',
    from: 'StockPilot <schedule@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { event: string }) => `Reminder: ${p.event} — in 1 hour`,
    // `note` carries its own trailing period ("Scanners staged at the equipment cage.").
    preheader: (p: { start: string; where: string; note: string }) =>
      `Starts ${p.start} · ${p.where}. ${p.note}`,
    badge: { variant: 'warn', label: () => 'Starts in 1 hour' },
    cta: 'Open schedule',
    motionNote: 'L2 · Clock hand',
    motionAsset: 'clock',
    footer: 'pref',
  }),

  // ── Digest ────────────────────────────────────────────────────────
  d({
    id: 'digest',
    family: 'digest',
    name: 'Weekly Digest',
    status: 'live',
    category: 'pref',
    tag: 'Weekly Digest',
    trigger: 'Scheduled — Monday 7:00 AM workspace time',
    to: 'Subscribed workspace members',
    from: 'StockPilot <digest@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { date: string }) => `StockPilot weekly digest — ${p.date}`,
    preheader: (p: { actions: number; orders: number; overdue: number }) =>
      `${p.actions} things need action · ${p.orders} orders received · ${p.overdue} overdue rental. Two-minute read.`,
    badge: { variant: 'info', label: (p: { range: string }) => p.range },
    cta: 'Open dashboard',
    motionNote: 'L2 · Bars rise',
    motionAsset: 'bars',
    footer: 'pref',
  }),
  d({
    id: 'digest-preview',
    family: 'digest',
    name: 'Digest Preview',
    status: 'live',
    category: 'pref',
    tag: 'Weekly Digest',
    trigger: 'User clicks “Send me a preview” in settings',
    to: 'Requesting user only',
    from: 'StockPilot <digest@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { date: string }) =>
      `[Preview] StockPilot weekly digest — ${p.date}`,
    preheader: () => 'Test render sent only to you — not the scheduled digest.',
    badge: { variant: 'purple', label: () => 'Preview' },
    cta: 'Open dashboard',
    motionNote: 'None in preview banner',
    motionAsset: null,
    footer: 'pref',
  }),

  // ── Support ───────────────────────────────────────────────────────
  d({
    id: 'support-ticket',
    family: 'support',
    name: 'Support Ticket Notification',
    status: 'live',
    category: 'int',
    tag: 'Internal',
    trigger: 'Customer submits a support request',
    to: 'StockPilot support staff',
    from: 'StockPilot Support <tickets@stockpilotusa.com>',
    replyTo: 'Reply-to set to the customer',
    // FLAG (registry `flag`): submitters get no acknowledgment and no
    // resolution email today. Two recommended concepts are designed
    // alongside (support-received / support-resolved) — not currently live.
    subject: (p: { subject: string }) => `[StockPilot support] ${p.subject}`,
    preheader: (p: { priority: string; category: string; org: string; source: string }) =>
      `${p.priority} · ${p.category} · ${p.org} · ${p.source}. Full message inside.`,
    badge: {
      variant: 'err',
      label: (p: { priority: string }) => `${p.priority} priority`,
    },
    cta: 'Open ticket',
    cta2: 'Reply to customer',
    motionNote: 'None — triage speed',
    motionAsset: null,
    footer: 'int',
  }),
  d({
    // CONCEPT: not a live production email until product signs off.
    // Build behind a disabled flag; do NOT dispatch.
    id: 'support-received',
    family: 'support',
    name: 'Support Request Received',
    status: 'concept',
    category: 'ess',
    tag: 'Support',
    trigger: 'PROPOSED — on ticket submission',
    to: 'Submitter',
    from: 'StockPilot Support <support@stockpilotusa.com>',
    replyTo: 'Replies append to the ticket',
    subject: (p: { summary: string }) => `We got your request — ${p.summary}`,
    preheader: (p: { ticketId: string; sla: string }) =>
      `Ticket ${p.ticketId} is in the queue. Typical first response: within ${p.sla}.`,
    badge: { variant: 'info', label: () => 'In the queue' },
    cta: 'View ticket',
    motionNote: 'None',
    motionAsset: null,
    footer: 'ess',
  }),
  d({
    // CONCEPT: not a live production email until product signs off.
    // Build behind a disabled flag; do NOT dispatch.
    id: 'support-resolved',
    family: 'support',
    name: 'Support Request Resolved',
    status: 'concept',
    category: 'ess',
    tag: 'Support',
    trigger: 'PROPOSED — on ticket resolution',
    to: 'Submitter',
    from: 'StockPilot Support <support@stockpilotusa.com>',
    replyTo: 'Replies reopen the ticket',
    subject: (p: { subject: string }) => `Resolved: ${p.subject}`,
    preheader: (p: { ticketId: string; closedOn: string; window: string }) =>
      `${p.ticketId} closed ${p.closedOn}. Reply within ${p.window} to reopen it.`,
    badge: { variant: 'ok', label: () => 'Resolved' },
    cta: 'View resolution',
    motionNote: 'None',
    motionAsset: null,
    footer: 'ess',
  }),

  // ── Maintenance (2026-08-06, Maintenance Resolved program) ─────────
  d({
    id: 'maintenance-resolved',
    family: 'maintenance',
    name: 'Maintenance Request Resolved',
    status: 'live',
    category: 'ess',
    tag: 'Maintenance',
    trigger: 'A manage-holder marks a maintenance request resolved',
    to: 'Requester',
    from: 'StockPilot <maintenance@stockpilotusa.com>',
    replyTo: 'Not monitored',
    subject: (p: { handle: string }) =>
      `Maintenance request ${p.handle} marked resolved`,
    preheader: (p: { resolverName: string }) =>
      `Recorded by ${p.resolverName} in StockPilot. The resolution note and any proof photos are inside.`,
    badge: { variant: 'ok', label: () => 'Marked resolved' },
    cta: 'View request',
    motionNote: 'L3 · Check draw',
    motionAsset: 'check',
    footer: 'ess',
  }),
];

export type EsEmailId = (typeof ES_EMAILS)[number]['id'];

const BY_ID = new Map(ES_EMAILS.map((e) => [e.id, e]));

/** Look up a registry entry; throws on unknown ids (a template bug, not a runtime state). */
export function esEmailById(id: string): EsEmailDefinition {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`[es] unknown email id: ${id}`);
  return def;
}

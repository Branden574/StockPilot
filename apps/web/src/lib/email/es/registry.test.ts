import { describe, expect, it } from 'vitest';

import { ES_EMAILS, esEmailById } from './registry';

/**
 * Registry fidelity — subjects, preheaders, badges, senders, and
 * category/footer mapping reproduce docs/design/email-system/es-tokens.js
 * byte-for-byte when fed the sample-world values.
 *
 * NOTE ON COUNT: the design prose says "28 templates" everywhere, but
 * ES.EMAILS in es-tokens.js contains 29 rows (25 live + 2 latent +
 * 2 concept) and the implementation prompt's own family list also sums
 * to 29. The registry array is the operative source of truth
 * ("implement every row of ES.EMAILS"), so 29 it is — the 28-vs-29
 * miscount is flagged to the owner in registry.ts.
 */

interface Expected {
  id: string;
  subject: string;
  subjectParams?: Record<string, unknown>;
  preheader: string;
  preheaderParams?: Record<string, unknown>;
  badge?: string;
  badgeParams?: Record<string, unknown>;
}

// Byte-identical strings from the EMAILS registry (note the typographic
// apostrophes, em dashes, middle dots, en dashes, and multiplication signs).
const EXPECTED: Expected[] = [
  {
    id: 'pw-reset',
    subject: 'Reset your StockPilot password',
    preheader:
      'This link works for 60 minutes. If you didn’t ask for it, you can safely ignore this email.',
    preheaderParams: { linkExpiry: '60 minutes' },
    badge: 'Security',
  },
  {
    id: 'signin',
    subject: 'New sign-in to your StockPilot account',
    preheader:
      'Chrome on macOS near Fresno, CA · Jun 12, 2:41 PM PT. Wasn’t you? Secure your account now.',
    preheaderParams: {
      summary: 'Chrome on macOS near Fresno, CA',
      time: 'Jun 12, 2:41 PM PT',
    },
    badge: 'New sign-in',
  },
  {
    id: 'team-invite',
    subject: 'You’re invited to join L4L North Region on StockPilot',
    subjectParams: { org: 'L4L North Region' },
    preheader: 'Branden added you as an Operator. Accept within 7 days to keep the seat.',
    preheaderParams: {
      inviterFirst: 'Branden',
      roleWithArticle: 'an Operator',
      window: '7 days',
    },
    badge: 'Pending · expires in 7 days',
    badgeParams: { window: '7 days' },
  },
  {
    id: 'invite-reminder',
    subject: 'Reminder: you’re invited to join L4L North Region on StockPilot',
    subjectParams: { org: 'L4L North Region' },
    preheader: 'Your original invitation is still open — it now expires Wed, Jun 3.',
    preheaderParams: { expiresOn: 'Wed, Jun 3' },
    badge: 'Reminder · still pending',
  },
  {
    id: 'ws-ready',
    subject: 'Your L4L North Region workspace on StockPilot is ready',
    subjectParams: { org: 'L4L North Region' },
    preheader: 'Inventory, orders, and scheduling are live. Two quick steps finish setup.',
    badge: 'Ready',
  },
  {
    id: 'portal-invite',
    subject: 'You’re invited to order from L4L North Region’s supplier portal',
    subjectParams: { org: 'L4L North Region' },
    preheader:
      'Browse the catalog and place orders. This secure link signs you in — no password needed.',
    badge: 'Portal access',
  },
  {
    id: 'confirm',
    subject: 'Confirm WO-04292026 to send it to the warehouse',
    subjectParams: { orderId: 'WO-04292026' },
    preheader:
      'One tap sends this request to DCIV — Fresno. Unconfirmed requests expire in 48 hours.',
    preheaderParams: { warehouse: 'DCIV — Fresno', window: '48 hours' },
    badge: 'Awaiting confirmation',
  },
  {
    id: 'received',
    subject: 'WO-04292026 received — we’re on it',
    subjectParams: { orderId: 'WO-04292026' },
    preheader: 'Submitted Apr 24, 11:32 AM to DCIV — Fresno. Approval is the next step.',
    preheaderParams: { submittedAt: 'Apr 24, 11:32 AM', warehouse: 'DCIV — Fresno' },
    badge: 'Received',
  },
  {
    id: 'approved',
    subject: 'WO-04292026 is approved — packing has started',
    subjectParams: { orderId: 'WO-04292026' },
    preheader: 'Reserved 46 units across 5 lines. Ships Apr 29 from DCIV — Fresno.',
    preheaderParams: { units: 46, lines: 5, shipDate: 'Apr 29', warehouse: 'DCIV — Fresno' },
    badge: 'Approved',
  },
  {
    id: 'denied',
    subject: 'WO-04292026 wasn’t approved',
    subjectParams: { orderId: 'WO-04292026' },
    preheader:
      'Reason: quarterly budget cap for CVW — Manchester. You can revise and resubmit.',
    preheaderParams: { reasonSummary: 'quarterly budget cap for CVW — Manchester' },
    badge: 'Not approved',
  },
  {
    id: 'transit',
    subject: 'WO-04292026 is on the way',
    subjectParams: { orderId: 'WO-04292026' },
    preheader:
      'Left DCIV — Fresno Apr 28, 7:15 AM · estimated Apr 29 by 5 PM at CVW — Manchester.',
    preheaderParams: {
      warehouse: 'DCIV — Fresno',
      departedAt: 'Apr 28, 7:15 AM',
      eta: 'Apr 29 by 5 PM',
      destination: 'CVW — Manchester',
    },
    badge: 'In transit',
  },
  {
    id: 'delivered',
    subject: 'WO-04292026 was delivered — thanks',
    subjectParams: { orderId: 'WO-04292026' },
    preheader: 'Signed by M. Okafor at CVW — Manchester, Apr 29, 2:12 PM. Receipt inside.',
    preheaderParams: {
      signer: 'M. Okafor',
      destination: 'CVW — Manchester',
      signedAt: 'Apr 29, 2:12 PM',
    },
    badge: 'Delivered',
  },
  {
    id: 'cancelled',
    subject: 'WO-04292026 was cancelled',
    subjectParams: { orderId: 'WO-04292026' },
    preheader: 'Cancelled Apr 26 by the requester. Reserved units returned to stock.',
    preheaderParams: { cancelledOn: 'Apr 26', by: 'the requester' },
    badge: 'Cancelled',
  },
  {
    id: 'packing',
    subject: 'WO-04292026 is being packaged',
    subjectParams: { orderId: 'WO-04292026' },
    preheader:
      '5 lines are being picked and packed at DCIV — Fresno. Next: staged for delivery.',
    preheaderParams: { lines: 5, warehouse: 'DCIV — Fresno' },
    badge: 'Packing',
  },
  {
    id: 'staged',
    subject: 'WO-04292026 is ready',
    subjectParams: { orderId: 'WO-04292026' },
    preheader: 'Staged at DCIV — Fresno, Dock 3. Pickup window: Apr 28, 6–9 AM.',
    preheaderParams: { location: 'DCIV — Fresno, Dock 3', window: 'Apr 28, 6–9 AM' },
    badge: 'Ready',
  },
  {
    id: 'partial',
    subject: 'Order #7741-2205: partially fulfilled',
    subjectParams: { orderNumber: '#7741-2205' },
    preheader: '38 of 46 units delivered. 8 backordered — expected within 2 weeks.',
    preheaderParams: { delivered: 38, total: 46, back: 8, eta: 'within 2 weeks' },
    badge: 'Partially fulfilled',
  },
  {
    id: 'back-shipped',
    subject: 'Order #7741-2205: backordered items shipped',
    subjectParams: { orderNumber: '#7741-2205' },
    preheader: 'The remaining 8 units left DCIV — Fresno May 8 via ground.',
    preheaderParams: {
      units: 8,
      warehouse: 'DCIV — Fresno',
      shipDate: 'May 8',
      method: 'ground',
    },
    badge: 'Backorder shipped',
  },
  {
    id: 'partial-receipt',
    subject: 'Order #7741-2205: partial delivery receipt',
    subjectParams: { orderNumber: '#7741-2205' },
    preheader: 'Receipt for 38 units received and signed at CVW — Manchester, Apr 29.',
    preheaderParams: { units: 38, destination: 'CVW — Manchester', date: 'Apr 29' },
    badge: 'Receipt',
  },
  {
    id: 'return-prompt',
    subject: 'Need to return anything from your order?',
    preheader: 'Order #7741-2205 · unused items accepted through May 27. Takes about a minute.',
    preheaderParams: { orderNumber: '#7741-2205', returnBy: 'May 27' },
    badge: 'Delivered Apr 29',
    badgeParams: { deliveredOn: 'Apr 29' },
  },
  {
    id: 'rental-out',
    subject: 'Your rental is checked out',
    preheader: 'Handheld Scanner Z-220 ×2 · due Jun 9 at DCIV — Fresno equipment cage.',
    preheaderParams: {
      item: 'Handheld Scanner Z-220',
      qty: 2,
      due: 'Jun 9',
      location: 'DCIV — Fresno equipment cage',
    },
    badge: 'Checked out',
  },
  {
    id: 'rental-returned',
    subject: 'Thanks — your rental has been returned',
    preheader: 'Scanner Z-220 ×2 checked in Jun 8, 4:05 PM. All set.',
    preheaderParams: { item: 'Scanner Z-220', qty: 2, at: 'Jun 8, 4:05 PM' },
    badge: 'Returned',
  },
  {
    id: 'rental-overdue',
    subject: 'Reminder: your rental is overdue',
    preheader: 'Due Jun 9 — 4 days ago. Others are waiting on this equipment.',
    preheaderParams: { due: 'Jun 9', overdueFor: '4 days' },
    badge: 'Overdue · 4 days',
    badgeParams: { overdueDays: 4 },
  },
  {
    id: 'sched-tmrw',
    subject: 'Reminder: Cycle count — Aisle 4 — tomorrow',
    subjectParams: { event: 'Cycle count — Aisle 4' },
    preheader: 'Thu, Jun 11 · 9:00–11:00 AM PT · DCIV — Fresno. Assigned to you.',
    preheaderParams: { when: 'Thu, Jun 11 · 9:00–11:00 AM PT', where: 'DCIV — Fresno' },
    badge: 'Tomorrow',
  },
  {
    id: 'sched-hour',
    subject: 'Reminder: Cycle count — Aisle 4 — in 1 hour',
    subjectParams: { event: 'Cycle count — Aisle 4' },
    preheader: 'Starts 9:00 AM PT · DCIV — Fresno. Scanners staged at the equipment cage.',
    preheaderParams: {
      start: '9:00 AM PT',
      where: 'DCIV — Fresno',
      note: 'Scanners staged at the equipment cage.',
    },
    badge: 'Starts in 1 hour',
  },
  {
    id: 'digest',
    subject: 'StockPilot weekly digest — Jun 15, 2026',
    subjectParams: { date: 'Jun 15, 2026' },
    preheader: '3 things need action · 14 orders received · 1 overdue rental. Two-minute read.',
    preheaderParams: { actions: 3, orders: 14, overdue: 1 },
    badge: 'Jun 8 – 14',
    badgeParams: { range: 'Jun 8 – 14' },
  },
  {
    id: 'digest-preview',
    subject: '[Preview] StockPilot weekly digest — Jun 15, 2026',
    subjectParams: { date: 'Jun 15, 2026' },
    preheader: 'Test render sent only to you — not the scheduled digest.',
    badge: 'Preview',
  },
  {
    id: 'support-ticket',
    subject: '[StockPilot support] Barcode labels misprinting from bulk export',
    subjectParams: { subject: 'Barcode labels misprinting from bulk export' },
    preheader: 'High · Bug report · Meridian Supply Co · in-app. Full message inside.',
    preheaderParams: {
      priority: 'High',
      category: 'Bug report',
      org: 'Meridian Supply Co',
      source: 'in-app',
    },
    badge: 'High priority',
    badgeParams: { priority: 'High' },
  },
  {
    id: 'support-received',
    subject: 'We got your request — barcode labels misprinting',
    subjectParams: { summary: 'barcode labels misprinting' },
    preheader:
      'Ticket SUP-1187 is in the queue. Typical first response: within 4 business hours.',
    preheaderParams: { ticketId: 'SUP-1187', sla: '4 business hours' },
    badge: 'In the queue',
  },
  {
    id: 'support-resolved',
    subject: 'Resolved: barcode labels misprinting from bulk export',
    subjectParams: { subject: 'barcode labels misprinting from bulk export' },
    preheader: 'SUP-1187 closed Jun 13. Reply within 7 days to reopen it.',
    preheaderParams: { ticketId: 'SUP-1187', closedOn: 'Jun 13', window: '7 days' },
    badge: 'Resolved',
  },
];

describe('es registry — shape', () => {
  it('carries every row of ES.EMAILS (29 — see the 28-vs-29 flag)', () => {
    expect(ES_EMAILS).toHaveLength(29);
    expect(EXPECTED).toHaveLength(29);
    expect(new Set(ES_EMAILS.map((e) => e.id)).size).toBe(29);
  });

  it('splits into 25 live + 2 latent + 2 concept', () => {
    const by = (st: string) => ES_EMAILS.filter((e) => e.status === st).length;
    expect(by('live')).toBe(25);
    expect(by('latent')).toBe(2);
    expect(by('concept')).toBe(2);
  });

  it('matches the family counts from the design package', () => {
    const by = (fam: string) => ES_EMAILS.filter((e) => e.family === fam).length;
    expect(by('security')).toBe(2);
    expect(by('invites')).toBe(4);
    expect(by('orders')).toBe(9);
    expect(by('fulfillment')).toBe(4);
    expect(by('rentals')).toBe(3);
    expect(by('schedule')).toBe(2);
    expect(by('digest')).toBe(2);
    expect(by('support')).toBe(3);
  });

  it('maps footer type to category exactly (registry foot === cat on every row)', () => {
    for (const e of ES_EMAILS) {
      expect(e.footer, e.id).toBe(e.category);
    }
    // Spot-check the category semantics the families rely on.
    expect(esEmailById('confirm').category).toBe('ess'); // double opt-in is essential
    expect(esEmailById('received').category).toBe('pref');
    expect(esEmailById('portal-invite').category).toBe('ext');
    expect(esEmailById('partial-receipt').category).toBe('ext');
    expect(esEmailById('support-ticket').category).toBe('int');
  });

  it('keeps the registry senders verbatim', () => {
    expect(esEmailById('pw-reset').from).toBe(
      'StockPilot Security <security@stockpilotusa.com>',
    );
    expect(esEmailById('approved').from).toBe('StockPilot <orders@stockpilotusa.com>');
    expect(esEmailById('rental-out').from).toBe('StockPilot <rentals@stockpilotusa.com>');
    expect(esEmailById('sched-tmrw').from).toBe('StockPilot <schedule@stockpilotusa.com>');
    expect(esEmailById('digest').from).toBe('StockPilot <digest@stockpilotusa.com>');
    expect(esEmailById('portal-invite').from).toBe(
      'L4L North Region via StockPilot <portal@stockpilotusa.com>',
    );
    expect(esEmailById('support-ticket').from).toBe(
      'StockPilot Support <tickets@stockpilotusa.com>',
    );
    expect(esEmailById('support-ticket').replyTo).toBe('Reply-to set to the customer');
  });

  it('assigns motion assets only where the MOTION registry has one', () => {
    const asset = (id: string) => esEmailById(id).motionAsset;
    expect(asset('pw-reset')).toBe('lock');
    expect(asset('signin')).toBe('pulse');
    expect(asset('ws-ready')).toBe('tiles');
    expect(asset('approved')).toBe('settle');
    expect(asset('transit')).toBe('route');
    expect(asset('back-shipped')).toBe('route');
    expect(asset('return-prompt')).toBe('reverse');
    expect(asset('packing')).toBe('scanner');
    expect(asset('staged')).toBe('pin');
    expect(asset('delivered')).toBe('check');
    expect(asset('rental-returned')).toBe('check');
    expect(asset('rental-out')).toBe('tag');
    expect(asset('rental-overdue')).toBe('clock-arc');
    expect(asset('sched-hour')).toBe('clock');
    expect(asset('sched-tmrw')).toBe('calendar');
    expect(asset('digest')).toBe('bars');
    // received "Timeline tick": produced in-house (11px inline dot).
    expect(asset('received')).toBe('tick');
    // No motion on denied / cancelled / receipts / support ticket
    // (prompt rule), and none where the MOTION board has no asset
    // (portal-invite "Catalog tiles", partial "Split progress" —
    // flagged in registry.ts).
    for (const id of [
      'team-invite',
      'invite-reminder',
      'portal-invite',
      'confirm',
      'denied',
      'cancelled',
      'partial',
      'partial-receipt',
      'digest-preview',
      'support-ticket',
      'support-received',
      'support-resolved',
    ]) {
      expect(asset(id), id).toBeNull();
    }
  });
});

describe('es registry — subjects, preheaders, badges (byte-identical)', () => {
  for (const exp of EXPECTED) {
    it(exp.id, () => {
      const def = esEmailById(exp.id);
      expect(def.subject(exp.subjectParams ?? {})).toBe(exp.subject);
      expect(def.preheader(exp.preheaderParams ?? {})).toBe(exp.preheader);
      if (exp.badge) {
        expect(def.badge.label(exp.badgeParams ?? {})).toBe(exp.badge);
      }
    });
  }
});

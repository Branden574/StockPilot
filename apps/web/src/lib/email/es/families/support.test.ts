import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import { ES_MAX_HTML_BYTES } from '../tokens';
import { esEmailById } from '../registry';
import {
  ES_CONCEPT_EMAILS_ENABLED,
  SUPPORT_CONCEPT_FROM,
  SUPPORT_TICKET_FROM,
  assertConceptEmailsEnabled,
  renderSupportReceivedEmailHtml,
  renderSupportResolvedEmailHtml,
  renderSupportTicketEmailHtml,
  supportReceivedSubject,
  supportResolvedSubject,
  supportTicketSubject,
} from './support';

/**
 * Support family (E7) — internal ticket notification + the two concept
 * emails. Pins: registry-byte-equal subjects/senders, the internal strip
 * + compact int footer, escaped verbatim customer input, the customer
 * Reply-To at the sendEmail wire level, no motion, the concept flag
 * (disabled, guard throws, NO production call site), and the Gmail
 * 102KB budget with a maximal 8000-char message.
 */

const NOW = new Date('2026-06-12T21:41:00Z'); // 2:41 PM PT

const TICKET = {
  name: 'Dana Whitfield',
  email: 'dana@meridiansupply.example',
  category: 'bug' as const,
  priority: 'high' as const,
  subject: 'Barcode labels misprinting from bulk export',
  message:
    'When we export more than ~200 labels, every label after the first page prints shifted.\nSingle-item labels print fine. <urgent>',
  pageUrl: 'https://stockpilotusa.com/dashboard/support',
  triageUrl: 'https://stockpilotusa.com/dashboard/admin/support',
  now: NOW,
};

describe('support-ticket subjects and sender (registry byte-equality)', () => {
  it('keeps the production subject byte-identical across the redesign', () => {
    expect(supportTicketSubject(TICKET.subject)).toBe(
      '[StockPilot support] Barcode labels misprinting from bulk export',
    );
    expect(supportTicketSubject(TICKET.subject)).toBe(
      esEmailById('support-ticket').subject({ subject: TICKET.subject }),
    );
  });

  it('sends from the registry tickets sender', () => {
    expect(SUPPORT_TICKET_FROM).toBe(
      'StockPilot Support <tickets@stockpilotusa.com>',
    );
    expect(SUPPORT_TICKET_FROM).toBe(esEmailById('support-ticket').from);
  });
});

describe('support-ticket render (internal triage)', () => {
  const html = renderSupportTicketEmailHtml(TICKET);

  it('carries the internal strip and the compact int footer', () => {
    expect(html).toContain(
      'Internal support notification — not customer-facing',
    );
    // Int footer: badge + console links, and NEVER an unsubscribe.
    expect(html).toContain('Internal support notification</div>');
    expect(html).toContain('>Open support console</a>');
    expect(html).toContain('>Routing rules</a>');
    expect(html).not.toContain('>Unsubscribe</a>');
    expect(html).not.toContain('>Manage email preferences</a>');
  });

  it('renders priority/category pills and the submitter card', () => {
    expect(html).toContain('High priority');
    expect(html).toContain('Bug report');
    expect(html).toContain('Dana Whitfield');
    expect(html).toContain('dana@meridiansupply.example');
    expect(html).toContain('Jun 12, 2026 &middot; 2:41 PM PT');
    expect(html).toContain('Reported from');
  });

  it('shows the message verbatim — escaped, on the raise panel, dark-safe', () => {
    expect(html).toContain('Message &mdash; verbatim');
    expect(html).toContain('&lt;urgent&gt;');
    expect(html).not.toContain('<urgent>');
    expect(html).toContain('prints shifted.<br>Single-item labels');
    expect(html).toContain('background:#fbfaf7');
    expect(html).toContain('.raise{background:#1b1b1d!important}');
    expect(html).toContain('[data-ogsc] .raise{background:#1b1b1d!important}');
  });

  it('has no motion asset (triage speed) and no broken merge values', () => {
    expect(html).not.toContain('.gif');
    expect(html).not.toMatch(/\bundefined\b/);
    expect(html).not.toContain('{{');
  });

  it('offers the customer-reply affordances', () => {
    expect(html).toContain('mailto:dana%40meridiansupply.example');
    expect(html).toContain('Reply to customer');
    expect(html).toContain('Reply-to on this email is set to the customer');
  });

  it('falls back gracefully when name and pageUrl are missing', () => {
    const minimal = renderSupportTicketEmailHtml({
      ...TICKET,
      name: null,
      pageUrl: null,
    });
    expect(minimal).not.toContain('Reported from');
    expect(minimal).not.toMatch(/\bundefined\b/);
    expect(minimal).not.toMatch(/\bnull\b/);
  });

  it('stays under the Gmail clip budget with a maximal message', () => {
    const maximal = renderSupportTicketEmailHtml({
      ...TICKET,
      subject: 'S'.repeat(200),
      message: 'Line of a very long customer message. '.repeat(210).slice(0, 8000),
    });
    const bytes = Buffer.byteLength(maximal, 'utf8');
    console.info(`[support-ticket weight] maximal message renders at ${bytes} bytes`);
    expect(bytes).toBeLessThan(ES_MAX_HTML_BYTES);
  });
});

// ── Wire-level: createSupportTicket → sendEmail args ────────────────

interface SendEmailArgs {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string | string[];
  headers?: Record<string, string>;
}
const sendEmailMock = vi.fn(async (_args: SendEmailArgs) => ({ ok: true }));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (args: SendEmailArgs) => sendEmailMock(args),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminHolder.client),
}));

import { createSupportTicket } from '@/server/services/support-tickets';

describe('createSupportTicket wire-level send', () => {
  beforeEach(() => {
    sendEmailMock.mockClear();
  });

  it('sends from tickets@ with the CUSTOMER as Reply-To (extended sendEmail params)', async () => {
    const stub = makeSupabaseStub({
      'support_tickets.insert': {
        data: { id: 'a1b2c3d4-0000-4000-8000-000000000000' },
        error: null,
      },
    });
    adminHolder.client = stub.client;

    await createSupportTicket({
      name: TICKET.name,
      email: TICKET.email,
      category: TICKET.category,
      priority: TICKET.priority,
      subject: TICKET.subject,
      message: TICKET.message,
      pageUrl: TICKET.pageUrl,
    });

    // Both sends are fire-and-forget: the internal triage notification AND
    // (owner decision 2026-07-20) the submitter acknowledgment.
    await vi.waitFor(() => expect(sendEmailMock).toHaveBeenCalledTimes(2));
    type SendArgs = {
      to: string; from?: string; replyTo?: string; subject: string;
      html: string; text?: string;
    };
    const calls = sendEmailMock.mock.calls.map((c) => c[0] as SendArgs);
    const triage = calls.find((c) => c.to === 'hello@stockpilotusa.com');
    expect(triage).toBeDefined();
    expect(triage!.from).toBe('StockPilot Support <tickets@stockpilotusa.com>');
    expect(triage!.replyTo).toBe('dana@meridiansupply.example');
    expect(triage!.subject).toBe(
      '[StockPilot support] Barcode labels misprinting from bulk export',
    );
    expect(triage!.html).toContain(
      'Internal support notification — not customer-facing',
    );
    // The classic text part rides along unchanged.
    expect(triage!.text).toContain('New support ticket — high priority · bug');

    // Submitter acknowledgment: support@ sender, human ticket ref, replies
    // routed to the MONITORED inbox.
    const ack = calls.find((c) => c.to === 'dana@meridiansupply.example');
    expect(ack).toBeDefined();
    expect(ack!.from).toBe('StockPilot Support <support@stockpilotusa.com>');
    expect(ack!.replyTo).toBe('hello@stockpilotusa.com');
    expect(ack!.subject).toBe(
      'We got your request — Barcode labels misprinting from bulk export',
    );
    expect(ack!.html).toContain('SUP-A1B2C3D4');
    expect(ack!.html).not.toContain('a1b2c3d4-0000');
  });
});

// ── Concepts — LIVE since the 2026-07-20 owner decision ─────────────

describe('concept emails (support-received / support-resolved)', () => {
  it('are enabled (owner decision 2026-07-20) and the guard passes', () => {
    expect(ES_CONCEPT_EMAILS_ENABLED).toBe(true);
    expect(() => assertConceptEmailsEnabled()).not.toThrow();
    expect(esEmailById('support-received').status).toBe('concept');
    expect(esEmailById('support-resolved').status).toBe('concept');
    expect(SUPPORT_CONCEPT_FROM).toBe(
      'StockPilot Support <support@stockpilotusa.com>',
    );
  });

  it('support-received renders the designed acknowledgment', () => {
    const html = renderSupportReceivedEmailHtml({
      firstName: 'Dana',
      email: TICKET.email,
      subject: TICKET.subject,
      ticketRef: 'SUP-1187',
      priority: 'high',
      submittedAt: 'Jun 12, 2026 · 2:41 PM PT',
      sla: '4 business hours',
      ticketUrl: 'https://stockpilotusa.com/dashboard/support',
    });
    expect(supportReceivedSubject(TICKET.subject)).toBe(
      `We got your request — ${TICKET.subject}`,
    );
    expect(html).toContain('We got your request.');
    expect(html).toContain('A human will read it.');
    expect(html).toContain('In the queue');
    expect(html).toContain('SUP-1187');
    expect(html).toContain('high-priority reports: within 4 business hours');
    expect(html).toContain('replies append to the ticket');
    // Essential footer — no unsubscribe on a one-time acknowledgment.
    expect(html).not.toContain('>Unsubscribe</a>');
    expect(html).not.toMatch(/\bundefined\b/);
  });

  it('support-resolved renders the designed resolution note', () => {
    const html = renderSupportResolvedEmailHtml({
      firstName: 'Dana',
      email: TICKET.email,
      subject: TICKET.subject,
      summary: 'label printing',
      ticketRef: 'SUP-1187',
      closedOn: 'Jun 13',
      resolvedLine: 'Jun 13, 2026 · build 2026.6.13',
      reopenWindow: '7 days',
      resolutionNote:
        'the misalignment on bulk exports past 200 labels is fixed in today’s build.',
      resolutionUrl: 'https://stockpilotusa.com/dashboard/support',
    });
    expect(supportResolvedSubject(TICKET.subject)).toBe(
      `Resolved: ${TICKET.subject}`,
    );
    expect(html).toContain('Fixed: label printing.');
    expect(html).toContain('Closed Jun 13.');
    expect(html).toContain('Reply within 7 days');
    expect(html).toContain('the ticket reopens with full history');
    expect(html).not.toContain('>Unsubscribe</a>');
    expect(html).not.toMatch(/\bundefined\b/);
  });

  it('is dispatched ONLY from the support-tickets service (owner decision 2026-07-20)', () => {
    const SRC_ROOT = path.resolve(__dirname, '../../../..');
    const FAMILY_FILE = path.resolve(__dirname, 'support.ts');
    const DISPATCH_FILE = path.resolve(
      __dirname,
      '../../../../server/services/support-tickets.ts',
    );
    const NEEDLES = [
      'renderSupportReceivedEmailHtml',
      'renderSupportResolvedEmailHtml',
      'SUPPORT_CONCEPT_FROM',
      'assertConceptEmailsEnabled',
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) continue;
        if (full === FAMILY_FILE) continue;
        const content = readFileSync(full, 'utf8');
        if (NEEDLES.some((n) => content.includes(n))) offenders.push(full);
      }
    };
    walk(SRC_ROOT);
    // The single sanctioned dispatch site; its sends call the guard.
    expect(offenders).toEqual([DISPATCH_FILE]);
    const dispatch = readFileSync(DISPATCH_FILE, 'utf8');
    expect(dispatch).toContain('assertConceptEmailsEnabled()');
  });
});

import 'server-only';

import {
  SUPPORT_CONCEPT_FROM,
  SUPPORT_TICKET_FROM,
  assertConceptEmailsEnabled,
  renderSupportReceivedEmailHtml,
  renderSupportResolvedEmailHtml,
  renderSupportTicketEmailHtml,
  supportReceivedSubject,
  supportResolvedSubject,
  supportTicketSubject,
} from '@/lib/email/es/families/support';
import { sendEmail } from '@/lib/email/resend';
import { reportError } from '@/lib/error-reporter';
import { SITE_URL, SUPPORT_EMAIL } from '@/lib/site';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Support tickets — public "report a problem" submissions + platform-admin
 * triage. The table (migration 0173) has RLS on with NO policies, so every
 * access here goes through the SERVICE-ROLE admin client; authorization is
 * enforced by the callers (public create is rate-limited in the action; triage
 * is isPlatformAdmin-gated). The DB is the source of truth — the notification
 * email is best-effort, so a bounced email never loses a ticket.
 */

export const TICKET_CATEGORIES = ['bug', 'billing', 'account', 'feature', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export interface SupportTicketRow {
  id: string;
  organizationId: string | null;
  submittedBy: string | null;
  name: string | null;
  email: string;
  category: TicketCategory;
  priority: TicketPriority;
  subject: string;
  message: string;
  status: TicketStatus;
  pageUrl: string | null;
  adminNotes: string | null;
  /** Storage key in the private support-attachments bucket (mig 0260). */
  attachmentPath: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface CreateSupportTicketInput {
  name?: string | null;
  email: string;
  category: TicketCategory;
  priority?: TicketPriority;
  subject: string;
  message: string;
  pageUrl?: string | null;
  userAgent?: string | null;
  organizationId?: string | null;
  submittedBy?: string | null;
  /**
   * Storage key of an optional screenshot in the private support-attachments
   * bucket. Callers MUST have verified the `{submittedBy}/` prefix already
   * (the dashboard action does) — this layer just persists it.
   */
  attachmentPath?: string | null;
}

function mapRow(r: Record<string, unknown>): SupportTicketRow {
  return {
    id: r.id as string,
    organizationId: (r.organization_id as string | null) ?? null,
    submittedBy: (r.submitted_by as string | null) ?? null,
    name: (r.name as string | null) ?? null,
    email: r.email as string,
    category: r.category as TicketCategory,
    priority: r.priority as TicketPriority,
    subject: r.subject as string,
    message: r.message as string,
    status: r.status as TicketStatus,
    pageUrl: (r.page_url as string | null) ?? null,
    adminNotes: (r.admin_notes as string | null) ?? null,
    attachmentPath: (r.attachment_path as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    resolvedAt: (r.resolved_at as string | null) ?? null,
  };
}

export async function createSupportTicket(input: CreateSupportTicketInput): Promise<{ id: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('support_tickets')
    .insert({
      organization_id: input.organizationId ?? null,
      submitted_by: input.submittedBy ?? null,
      name: input.name?.trim() || null,
      email: input.email.trim().toLowerCase(),
      category: input.category,
      priority: input.priority ?? 'normal',
      subject: input.subject.trim().slice(0, 200),
      message: input.message.trim().slice(0, 8000),
      page_url: input.pageUrl?.slice(0, 500) ?? null,
      user_agent: input.userAgent?.slice(0, 500) ?? null,
      attachment_path: input.attachmentPath ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`support_tickets insert: ${error.message}`);
  const id = (data as { id: string }).id;

  // Notify support — best-effort; the ticket row is already durable.
  void notifySupport({ ...input, id }).catch((e) =>
    reportError(e, { tag: 'support-tickets.notify', extra: { id } }),
  );
  // Owner decision 2026-07-20: the support-received concept is LIVE — a
  // one-time acknowledgment to the submitter. Best-effort like the triage
  // notification.
  void sendSubmitterAck({ ...input, id }).catch((e) =>
    reportError(e, { tag: 'support-tickets.ack', extra: { id } }),
  );
  return { id };
}

/** Human ticket reference for submitter-facing emails (never a raw UUID). */
function ticketRef(id: string): string {
  return `SUP-${id.slice(0, 8).toUpperCase()}`;
}

function firstNameOf(name: string | null | undefined): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

/** First-response expectation shown in the acknowledgment, per priority. */
const ACK_SLA: Record<TicketPriority, string> = {
  urgent: '4 business hours',
  high: '4 business hours',
  normal: '1 business day',
  low: '2 business days',
};

async function sendSubmitterAck(t: CreateSupportTicketInput & { id: string }): Promise<void> {
  assertConceptEmailsEnabled();
  const ref = ticketRef(t.id);
  const priority = t.priority ?? 'normal';
  const sla = ACK_SLA[priority];
  const submittedAt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
  }).format(new Date());
  const subject = t.subject.trim().slice(0, 200);
  const html = renderSupportReceivedEmailHtml({
    firstName: firstNameOf(t.name),
    email: t.email,
    subject,
    ticketRef: ref,
    priority,
    submittedAt,
    sla,
    ticketUrl: `${SITE_URL}/dashboard/support`,
    supportUrl: `${SITE_URL}/dashboard/support`,
  });
  const text = [
    `We got your request — it's logged as ${ref}.`,
    '',
    `Subject: ${subject}`,
    `Priority: ${priority}`,
    `Typical first response: within ${sla}.`,
    '',
    `Track it: ${SITE_URL}/dashboard/support`,
    'Add screenshots or details any time by replying to this email.',
  ].join('\n');
  await sendEmail({
    to: t.email,
    subject: supportReceivedSubject(subject),
    html,
    text,
    from: SUPPORT_CONCEPT_FROM,
    // Replies must reach the MONITORED inbox — the registry's "replies
    // append to the ticket" routing, not the unmonitored sender address.
    replyTo: SUPPORT_EMAIL,
  });
}

async function notifySupport(t: CreateSupportTicketInput & { id: string }): Promise<void> {
  // Text part unchanged from the classic notification; the HTML moved to
  // the redesigned email system (lib/email/es/families/support.ts).
  const text = [
    `New support ticket — ${t.priority ?? 'normal'} priority · ${t.category}`,
    '',
    `From: ${t.name ?? '(no name)'} <${t.email}>`,
    `Subject: ${t.subject}`,
    t.pageUrl ? `Reported from: ${t.pageUrl}` : '',
    '',
    t.message,
    '',
    `Triage → ${SITE_URL}/dashboard/admin/support`,
  ]
    .filter(Boolean)
    .join('\n');
  const html = renderSupportTicketEmailHtml({
    name: t.name ?? null,
    email: t.email,
    category: t.category,
    priority: t.priority ?? 'normal',
    subject: t.subject,
    message: t.message,
    pageUrl: t.pageUrl ?? null,
    triageUrl: `${SITE_URL}/dashboard/admin/support`,
  });
  // Registry routing: sender is tickets@stockpilotusa.com and the
  // Reply-To is the CUSTOMER — a direct reply from the support inbox
  // starts the thread with the submitter.
  await sendEmail({
    to: SUPPORT_EMAIL,
    subject: supportTicketSubject(t.subject),
    text,
    html,
    from: SUPPORT_TICKET_FROM,
    replyTo: t.email,
  });
}

export async function listSupportTickets(opts?: {
  status?: TicketStatus;
}): Promise<SupportTicketRow[]> {
  const admin = createAdminClient();
  let q = admin
    .from('support_tickets')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500);
  if (opts?.status) q = q.eq('status', opts.status);
  const { data, error } = await q;
  if (error) throw new Error(`support_tickets list: ${error.message}`);
  return (data ?? []).map((r) => mapRow(r as Record<string, unknown>));
}

/**
 * The tickets ONE user submitted from ONE workspace — powers the
 * "My submissions" list on /dashboard/support. Service-role read (RLS has no
 * policies), so BOTH filters are mandatory and must come from the server
 * session, never the client.
 */
export async function listMyTickets(opts: {
  userId: string;
  organizationId: string;
}): Promise<SupportTicketRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('support_tickets')
    .select('*')
    .eq('submitted_by', opts.userId)
    .eq('organization_id', opts.organizationId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(`support_tickets listMyTickets: ${error.message}`);
  return (data ?? []).map((r) => mapRow(r as Record<string, unknown>));
}

/**
 * Short-lived (1 h) signed URLs for ticket screenshots in the private
 * support-attachments bucket, batched in ONE storage call. Service-role —
 * callers must already be behind a platform-admin gate. Best-effort: missing
 * objects are simply absent from the result, never thrown.
 */
export async function createAttachmentSignedUrls(
  paths: string[],
): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from('support-attachments')
    .createSignedUrls(paths, 60 * 60);
  if (error) {
    void reportError(error, { tag: 'support-tickets.signed-urls' });
    return {};
  }
  const byPath: Record<string, string> = {};
  for (const row of data ?? []) {
    if (row.path && row.signedUrl && !row.error) byPath[row.path] = row.signedUrl;
  }
  return byPath;
}

export async function updateSupportTicket(
  id: string,
  patch: { status?: TicketStatus; priority?: TicketPriority; adminNotes?: string | null },
): Promise<void> {
  const admin = createAdminClient();
  // Prior state decides whether this update CROSSES into resolved — the
  // submitter gets the resolution notice at most once per crossing (a
  // re-save while already resolved must not resend it).
  const { data: before, error: readErr } = await admin
    .from('support_tickets')
    .select('status, email, name, subject')
    .eq('id', id)
    .maybeSingle();
  if (readErr) throw new Error(`support_tickets read: ${readErr.message}`);
  if (!before) throw new Error('support_tickets update: ticket not found');

  const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status) {
    upd.status = patch.status;
    upd.resolved_at =
      patch.status === 'resolved' || patch.status === 'closed' ? new Date().toISOString() : null;
  }
  if (patch.priority) upd.priority = patch.priority;
  if (patch.adminNotes !== undefined) upd.admin_notes = patch.adminNotes?.trim() || null;

  const { error } = await admin.from('support_tickets').update(upd).eq('id', id);
  if (error) throw new Error(`support_tickets update: ${error.message}`);

  // Owner decision 2026-07-20: the support-resolved concept is LIVE.
  // Fires only on the open/in_progress -> resolved crossing; best-effort.
  const b = before as { status: TicketStatus; email: string; name: string | null; subject: string };
  if (patch.status === 'resolved' && b.status !== 'resolved' && b.status !== 'closed') {
    void sendResolvedNotice(id, b).catch((e) =>
      reportError(e, { tag: 'support-tickets.resolved', extra: { id } }),
    );
  }
}

async function sendResolvedNotice(
  id: string,
  t: { email: string; name: string | null; subject: string },
): Promise<void> {
  assertConceptEmailsEnabled();
  const ref = ticketRef(id);
  const now = new Date();
  const closedOn = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Los_Angeles',
  }).format(now);
  const resolvedLine = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Los_Angeles',
  }).format(now);
  const subject = t.subject.trim();
  // Headline summary stays short; the full subject rides the detail row.
  const summary = subject.length > 48 ? `${subject.slice(0, 45).trimEnd()}…` : subject;
  const reopenWindow = '7 days';
  const html = renderSupportResolvedEmailHtml({
    firstName: firstNameOf(t.name),
    email: t.email,
    subject,
    summary,
    ticketRef: ref,
    closedOn,
    resolvedLine,
    reopenWindow,
    // adminNotes is an INTERNAL field — never forwarded to the submitter.
    resolutionNote: 'the team has resolved this ticket — thanks for the report.',
    resolutionUrl: `${SITE_URL}/dashboard/support`,
    supportUrl: `${SITE_URL}/dashboard/support`,
  });
  const text = [
    `${ref} is resolved — thanks for the report.`,
    '',
    `Subject: ${subject}`,
    `Resolved: ${resolvedLine}`,
    '',
    `Still seeing it? Reply within ${reopenWindow} and the ticket reopens with full history.`,
    `Ticket history: ${SITE_URL}/dashboard/support`,
  ].join('\n');
  await sendEmail({
    to: t.email,
    subject: supportResolvedSubject(subject),
    html,
    text,
    from: SUPPORT_CONCEPT_FROM,
    replyTo: SUPPORT_EMAIL,
  });
}

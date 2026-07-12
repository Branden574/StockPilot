import 'server-only';

import { sendEmail } from '@/lib/email/resend';
import { reportError } from '@/lib/error-reporter';
import { COMPANY_NAME, SITE_URL, SUPPORT_EMAIL } from '@/lib/site';
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
  return { id };
}

async function notifySupport(t: CreateSupportTicketInput & { id: string }): Promise<void> {
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
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.6;color:#0e0f0d">
    <p style="margin:0 0 12px"><strong>New support ticket</strong> — ${esc(t.priority ?? 'normal')} priority · ${esc(t.category)}</p>
    <p style="margin:0 0 4px"><strong>From:</strong> ${esc(t.name ?? '(no name)')} &lt;${esc(t.email)}&gt;</p>
    <p style="margin:0 0 4px"><strong>Subject:</strong> ${esc(t.subject)}</p>
    ${t.pageUrl ? `<p style="margin:0 0 12px"><strong>Reported from:</strong> ${esc(t.pageUrl)}</p>` : ''}
    <pre style="white-space:pre-wrap;background:#f6f6f4;border-radius:8px;padding:12px;margin:12px 0">${esc(t.message)}</pre>
    <p style="margin:12px 0 0"><a href="${SITE_URL}/dashboard/admin/support">Open triage →</a></p>
  </div>`;
  await sendEmail({ to: SUPPORT_EMAIL, subject: `[${COMPANY_NAME} support] ${t.subject}`, text, html });
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
  const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status) {
    upd.status = patch.status;
    upd.resolved_at =
      patch.status === 'resolved' || patch.status === 'closed' ? new Date().toISOString() : null;
  }
  if (patch.priority) upd.priority = patch.priority;
  if (patch.adminNotes !== undefined) upd.admin_notes = patch.adminNotes?.trim() || null;

  const admin = createAdminClient();
  const { error } = await admin.from('support_tickets').update(upd).eq('id', id);
  if (error) throw new Error(`support_tickets update: ${error.message}`);
}

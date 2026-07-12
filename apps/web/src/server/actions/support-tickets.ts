'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';

import { currentUserIsPlatformAdmin } from '@/lib/auth/platform-admin';
import { requireOrgContext, requireSession } from '@/lib/auth/session';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  createSupportTicket,
  updateSupportTicket,
} from '@/server/services/support-tickets';

import { err, ok, type ActionResult } from '@stockpilot/core';

// ── Public: submit a support ticket ─────────────────────────────────────────
const createSchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().toLowerCase().email().max(254),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  subject: z.string().trim().min(3, 'Add a short subject').max(200),
  message: z.string().trim().min(10, 'Tell us a little more').max(8000),
  pageUrl: z.string().trim().max(500).optional(),
  /** Honeypot — hidden from humans, bots fill it. Any value = silent drop. */
  company: z.string().optional(),
});

export async function createSupportTicketAction(
  input: z.input<typeof createSchema>,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Please check the form.');
  }
  const data = parsed.data;

  // Honeypot trip → pretend success so bots can't tell they were caught.
  if (data.company && data.company.trim().length > 0) return ok({ id: 'received' });

  const h = await headers();
  // Only trust x-forwarded-for on Vercel (it strips client-supplied XFF there).
  const onVercel = process.env.VERCEL === '1';
  const xff = onVercel ? h.get('x-forwarded-for') : null;
  const ip = xff?.split(',')[0]?.trim() || h.get('x-real-ip') || 'unknown';
  const userAgent = h.get('user-agent') ?? null;

  // Fail-CLOSED: this is an unauthenticated surface, so a limiter outage must
  // 429 rather than open the floodgates. Two buckets: per-IP and per-email.
  const byIp = await checkRateLimit(`support:ip:${ip}`, 5, 60 * 60 * 1000, 'closed');
  if (!byIp.allowed) {
    return err('rate_limited', 'Too many submissions from your network. Please try again later.');
  }
  const byEmail = await checkRateLimit(`support:email:${data.email}`, 10, 24 * 60 * 60 * 1000, 'closed');
  if (!byEmail.allowed) {
    return err('rate_limited', 'Too many tickets for this email today. Please email us directly.');
  }

  try {
    const res = await createSupportTicket({
      name: data.name ?? null,
      email: data.email,
      category: data.category,
      priority: data.priority,
      subject: data.subject,
      message: data.message,
      pageUrl: data.pageUrl ?? null,
      userAgent,
    });
    return ok(res);
  } catch (e) {
    void reportError(e, { tag: 'support-tickets.create' });
    return err('internal_error', 'Could not submit your ticket. Please email support directly.');
  }
}

// ── Dashboard: signed-in members submit from /dashboard/support ─────────────
const dashboardSchema = z.object({
  category: z.enum(['bug', 'feature', 'billing', 'other']),
  subject: z.string().trim().min(3, 'Add a short subject').max(140),
  message: z.string().trim().min(10, 'Tell us a little more').max(4000),
  /** Storage key of an already-uploaded screenshot (support-attachments). */
  attachmentPath: z.string().trim().min(1).max(300).optional(),
});

export type DashboardTicketResult = { ok: true } | { ok: false; error: string };

/**
 * In-app "Support & feedback" submission. Unlike the public marketing action
 * above, the caller is authenticated: identity (org + user + email) comes from
 * the server session — NEVER from the client. Plain `{ ok, error }` result;
 * never throws to the client.
 */
export async function submitDashboardTicketAction(
  input: z.input<typeof dashboardSchema>,
): Promise<DashboardTicketResult> {
  const ctx = await requireOrgContext();

  const parsed = dashboardSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Please check the form.' };
  }
  const data = parsed.data;

  // The storage policy (mig 0260) only lets a user upload under their own
  // auth-uid folder; re-assert the same invariant here so a forged path can
  // never attach someone else's upload to this ticket.
  if (data.attachmentPath && !data.attachmentPath.startsWith(`${ctx.userId}/`)) {
    return { ok: false, error: 'Invalid attachment. Please re-upload your screenshot.' };
  }

  // Authenticated surface, so a generous per-user cap; fail-closed to match
  // the public form (a limiter outage must not open the floodgates).
  const limit = await checkRateLimit(`support:user:${ctx.userId}`, 10, 60 * 60 * 1000, 'closed');
  if (!limit.allowed) {
    return { ok: false, error: 'Too many tickets in the last hour. Please try again later.' };
  }

  try {
    await createSupportTicket({
      name: ctx.fullName,
      email: ctx.email,
      category: data.category,
      subject: data.subject,
      message: data.message,
      pageUrl: '/dashboard/support',
      organizationId: ctx.organizationId,
      submittedBy: ctx.userId,
      attachmentPath: data.attachmentPath ?? null,
    });
    revalidatePath('/dashboard/support');
    return { ok: true };
  } catch (e) {
    void reportError(e, { tag: 'support-tickets.dashboard-create' });
    return { ok: false, error: 'Could not submit your request. Please try again.' };
  }
}

// ── Platform admin: triage a ticket ─────────────────────────────────────────
const updateSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  adminNotes: z.string().max(4000).optional(),
});

export async function updateSupportTicketAction(
  input: z.input<typeof updateSchema>,
): Promise<ActionResult<null>> {
  await requireSession();
  if (!(await currentUserIsPlatformAdmin())) {
    return err('forbidden', 'Not authorized.');
  }
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const { id, ...patch } = parsed.data;
    await updateSupportTicket(id, patch);
    revalidatePath('/dashboard/admin/support');
    return ok(null);
  } catch (e) {
    void reportError(e, { tag: 'support-tickets.update' });
    return err('internal_error', 'Could not update the ticket.');
  }
}

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { reportError } from '@/lib/error-reporter';

/**
 * TODO(T6): stub seam. This module exists NOW (Task 4) purely so
 * `MaintenanceRequestsService.resolve()` has a stable, real import to call
 * fire-and-forget — the import graph and resolve()'s own tests must not
 * change shape once Task 6 lands the real sender. Until then this body does
 * nothing but report-and-decline: no row read, no email composed, no
 * `resolution_email_sent_at` claim attempted.
 *
 * The full result-type union below is the CONTRACT Task 6 implements against
 * (spec §6.3, the `return-prompt.ts` twin, module-for-module): row exists →
 * `status === 'resolved'` → `requester_email_snapshot` non-null →
 * `requester_user_id !== resolved_by` (self-resolve sends nothing) → the
 * at-most-once guarded claim on `resolution_email_sent_at` → send via the
 * ONE `sendEmail` seam (`@/lib/email/resend`), never the Supabase built-in
 * mailer and never a direct fetch to Resend.
 */
export type MaintenanceResolvedEmailResult =
  | { sent: true }
  | {
      sent: false;
      reason:
        | 'request_not_found'
        | 'not_resolved'
        | 'no_requester_email'
        | 'self_resolve'
        | 'already_sent'
        | 'lost_race'
        | 'send_failed'
        | 'error';
    };

export async function maybeSendMaintenanceResolvedEmail(
  _admin: SupabaseClient,
  requestId: string,
  _opts: { appUrl: string },
): Promise<MaintenanceResolvedEmailResult> {
  // Inert until Task 6: no row read, no email composed, no
  // `resolution_email_sent_at` claim attempted. `reportError` here is a
  // no-op from the caller's perspective (info-level, never pages anyone) —
  // it only marks that resolve() reached this seam before the real sender
  // exists, so the transitional window between this task and Task 6 is
  // observable rather than silent.
  void reportError(new Error('maintenance_resolved_email_not_yet_implemented'), {
    tag: 'maintenance_resolved.email.stub',
    level: 'info',
    extra: { requestId },
  });
  return { sent: false, reason: 'error' };
}

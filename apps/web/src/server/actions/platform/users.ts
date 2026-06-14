'use server';

import { z } from 'zod';

import { checkPlatformAdmin } from '@/lib/auth/platform-admin';
import { sendPasswordResetForUser } from '@/server/services/platform/users';

import { err, ok, type ActionResult } from '@stockpilot/core';

const schema = z.object({ targetUserId: z.string().uuid() });

/**
 * Platform-admin action: email a password-reset link to any user. Gated by
 * the platform-admin allowlist (the action re-checks server-side; the UI is
 * already behind the (platform) layout gate). No step-up required — sending a
 * recovery email is non-destructive (the user still must click it).
 */
export async function sendUserPasswordResetAction(
  input: z.infer<typeof schema>,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid user id');

  const gate = await checkPlatformAdmin();
  if (!gate.ok) return err('forbidden', 'Not authorized.');

  const res = await sendPasswordResetForUser({
    targetUserId: parsed.data.targetUserId,
    actorUserId: gate.session.userId,
    actorEmail: gate.session.email,
  });

  if (!res.ok) {
    if (res.reason === 'not_found') return err('not_found', 'User not found.');
    if (res.reason === 'no_email') return err('validation_error', 'That user has no email on file.');
    return err('internal_error', 'Could not send the reset email. Try again.');
  }
  return ok({ ok: true });
}

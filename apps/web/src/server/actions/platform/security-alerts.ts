'use server';

import { z } from 'zod';

import { checkPlatformConsoleRead } from '@/lib/auth/platform-admin';
import { readPlatformSecurityAlerts } from '@/server/services/platform/security-alerts';

import {
  SECURITY_ALERTS_FAILED,
  SECURITY_ALERTS_REFUSED,
  type SecurityAlertsResult,
} from '@stockpilot/core';

/**
 * THE SECURITY ALERTS' "CHECK AGAIN". The open console page asks this for
 * the alerts once more, when the viewer asks.
 *
 * The order of every call:
 *   1. checkPlatformConsoleRead(), FIRST, before the input is even looked at:
 *      exactly the console page's rule (a session, the verified email on the
 *      allowlist, aal2 outright, no passkey bridge). Every failure answers the
 *      one fixed refusal; nothing is read.
 *   2. The input: an empty object, nothing else. Anything else is a failed
 *      read, not a refusal.
 *   3. The one read (server/services/platform/security-alerts.ts).
 *
 * It reads only: it changes no switch, threshold or planned check (release
 * 4a has no control that does), writes nothing, sets no cookie of its own
 * and revalidates nothing. It never throws and never redirects.
 */

const input = z.object({}).strict();

export async function readPlatformSecurityAlertsAction(
  raw: unknown,
): Promise<SecurityAlertsResult> {
  const gate = await checkPlatformConsoleRead();
  if (!gate.ok) return SECURITY_ALERTS_REFUSED;

  if (!input.safeParse(raw).success) return SECURITY_ALERTS_FAILED;
  return readPlatformSecurityAlerts();
}

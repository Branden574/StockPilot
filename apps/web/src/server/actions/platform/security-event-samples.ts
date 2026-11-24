'use server';

import { z } from 'zod';

import { checkPlatformConsoleRead } from '@/lib/auth/platform-admin';
import { readPlatformSecurityEventSamples } from '@/server/services/platform/security-event-samples';

import {
  isSecurityEventSamplesCountry,
  isSecurityEventSamplesHour,
  SECURITY_EVENT_SAMPLES_FAILED,
  SECURITY_EVENT_SAMPLES_REFUSED,
  SECURITY_PROBE_KINDS,
  type SecurityEventSamplesResult,
} from '@stockpilot/core';

/**
 * "WHAT WAS ASKED FOR" IN THE HOW-TO-RESPOND PANEL. The panel of an
 * exploit-attempt entry asks this once, when it opens (never with the page,
 * never on a timer), for what scanners asked for in the entry's hour and kind,
 * or in the last 24 hours for a card opened from the map's legend.
 *
 * The order of every call, as the attack map's poll:
 *   1. checkPlatformConsoleRead(), FIRST, before the input is even looked at:
 *      exactly the console page's rule (a session, the verified email on the
 *      allowlist, aal2 outright, no passkey bridge). Every failure answers the
 *      one fixed refusal; nothing is read. It is not checkPlatformAdmin(),
 *      which serves an allowlisted account with no authenticator on its
 *      password alone.
 *   2. The input: a kind of the six or none, a whole UTC hour within 7 days
 *      or none, two capitals or no country, and no other key. Anything else
 *      is "could not check", not a refusal.
 *   3. The one read (server/services/platform/security-event-samples.ts),
 *      which hands back only what the panel shows.
 *
 * It writes nothing, sets no cookie of its own and revalidates nothing. It
 * never throws and never redirects: the panel must not move the page.
 */

const input = z
  .object({
    reason: z.enum(SECURITY_PROBE_KINDS).nullable(),
    hour: z.string().max(40).nullable(),
    country: z.string().max(2).nullable(),
  })
  .strict();

export async function readSecurityEventSamplesAction(
  raw: unknown,
): Promise<SecurityEventSamplesResult> {
  const gate = await checkPlatformConsoleRead();
  if (!gate.ok) return SECURITY_EVENT_SAMPLES_REFUSED;

  const parsed = input.safeParse(raw);
  if (!parsed.success) return SECURITY_EVENT_SAMPLES_FAILED;
  const { reason, hour, country } = parsed.data;
  const now = Date.now();
  if (hour !== null && !isSecurityEventSamplesHour(hour, now)) return SECURITY_EVENT_SAMPLES_FAILED;
  if (country !== null && !isSecurityEventSamplesCountry(country)) {
    return SECURITY_EVENT_SAMPLES_FAILED;
  }
  return readPlatformSecurityEventSamples({ reason, hour, country }, now);
}

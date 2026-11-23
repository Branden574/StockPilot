'use server';

import { z } from 'zod';

import { checkPlatformConsoleRead } from '@/lib/auth/platform-admin';
import { readPlatformSecurityMap } from '@/server/services/platform/security-map';

import {
  SECURITY_MAP_POLL_FAILED,
  SECURITY_MAP_POLL_REFUSED,
  type SecurityMapPollResult,
} from '@stockpilot/core';

/**
 * THE ATTACK MAP'S POLL. The open console page asks this for the map's data:
 * the last ten minutes every 30 seconds and the whole window every 5 minutes.
 *
 * The order of every call:
 *   1. checkPlatformConsoleRead(), FIRST, before the input is even looked at:
 *      exactly the console page's rule (a session, the verified email on the
 *      allowlist, aal2 outright, no passkey bridge). Every failure answers the
 *      one fixed refusal; nothing is read. It is not checkPlatformAdmin(),
 *      which serves an allowlisted account with no authenticator on its
 *      password alone.
 *   2. The input: which read, and for the whole window the instant the
 *      viewer's day began (only the browser knows its midnight). Anything
 *      else is a failed read, not a refusal.
 *   3. The one read (server/services/platform/security-map.ts), which hands
 *      back only what the page draws.
 *
 * It writes nothing, sets no cookie of its own and revalidates nothing, so
 * its answer carries no new render of the page. It never throws and never
 * redirects: a poll must not move the page it runs on.
 */

const input = z
  .object({
    scope: z.enum(['whole', 'recent']),
    dayStart: z.string().max(40).nullable(),
  })
  .strict();

export async function pollPlatformSecurityMapAction(raw: unknown): Promise<SecurityMapPollResult> {
  const gate = await checkPlatformConsoleRead();
  if (!gate.ok) return SECURITY_MAP_POLL_REFUSED;

  const parsed = input.safeParse(raw);
  if (!parsed.success) return SECURITY_MAP_POLL_FAILED;
  let dayStart: string | null = null;
  if (parsed.data.scope === 'whole' && parsed.data.dayStart !== null) {
    const at = Date.parse(parsed.data.dayStart);
    if (!Number.isFinite(at)) return SECURITY_MAP_POLL_FAILED;
    dayStart = new Date(at).toISOString();
  }
  return readPlatformSecurityMap({ scope: parsed.data.scope, dayStart });
}

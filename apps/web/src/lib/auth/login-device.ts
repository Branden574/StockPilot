import 'server-only';

import { createHash } from 'node:crypto';

import { sendNewDeviceLoginEmail } from '@/lib/email/login-alert';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';

/** Collapse version numbers out of a UA so a routine browser auto-update
 *  ("Chrome/120" → "Chrome/121") doesn't read as a brand-new device. Keeps the
 *  browser/OS family that actually distinguishes one device from another. */
function normalizeUserAgent(ua: string): string {
  return ua
    .replace(/[0-9]+(\.[0-9]+)*/g, '#')
    .slice(0, 400);
}

function deviceHash(userId: string, ua: string): string {
  return createHash('sha256')
    .update(`${userId}::${normalizeUserAgent(ua)}`)
    .digest('hex')
    .slice(0, 40);
}

/**
 * Record the device a user just signed in from, and email a "new device" alert
 * when it's a device we haven't seen on an ALREADY-established account.
 *
 * Self-contained + best-effort: never throws. Sign-in hooks fire this via
 * Next's `after()` so it runs AFTER the response and adds zero login latency.
 * The first device a user is ever seen on is recorded silently (baseline) — we
 * only alert on a genuinely new device once the account has a known one.
 */
export async function noteLoginDevice(args: {
  userId: string;
  email: string | null;
  userAgent: string | null;
  ip: string | null;
}): Promise<void> {
  try {
    const ua = (args.userAgent ?? '').trim() || 'Unknown device';
    const hash = deviceHash(args.userId, ua);
    const admin = createAdminClient();

    // Known device? → bump last-seen, no alert.
    const { data: existing } = await admin
      .from('user_login_devices')
      .select('id')
      .eq('user_id', args.userId)
      .eq('device_hash', hash)
      .maybeSingle();
    if (existing) {
      await admin
        .from('user_login_devices')
        .update({
          last_seen_at: new Date().toISOString(),
          last_ip: args.ip,
          user_agent: ua.slice(0, 400),
        })
        .eq('id', (existing as { id: string }).id);
      return;
    }

    // New device. Did the account already have known devices? If this is the
    // user's FIRST-ever device, record it silently — alerting on a brand-new
    // account's first login (or on everyone's existing device at rollout) is
    // pure noise.
    const { count } = await admin
      .from('user_login_devices')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', args.userId);
    const hadKnownDevices = (count ?? 0) > 0;

    await admin.from('user_login_devices').insert({
      user_id: args.userId,
      device_hash: hash,
      user_agent: ua.slice(0, 400),
      last_ip: args.ip,
    });

    if (hadKnownDevices && args.email) {
      await sendNewDeviceLoginEmail({ to: args.email, userAgent: ua, ip: args.ip });
    }
  } catch (e) {
    // Never let an alert failure affect sign-in.
    void reportError(e, { tag: 'auth.login_device_note_failed', level: 'warning' });
  }
}

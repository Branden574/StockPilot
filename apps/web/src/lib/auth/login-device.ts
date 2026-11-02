import 'server-only';

import { createHash } from 'node:crypto';

import { sendNewDeviceLoginEmail } from '@/lib/email/login-alert';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { dispatchEvent } from '@/server/services/integration-events';

/** Collapse version numbers out of a UA so a routine browser auto-update
 *  ("Chrome/120" → "Chrome/121") doesn't read as a brand-new device. Keeps the
 *  browser/OS family that actually distinguishes one device from another. */
function normalizeUserAgent(ua: string): string {
  return ua
    .replace(/[0-9]+(\.[0-9]+)*/g, '#')
    .slice(0, 400);
}

/**
 * The device's identity for this account. A phone that sends its install id
 * (S5: the app's per-install id, apps/mobile/src/lib/install-id.ts) is that
 * install: every copy of the app on an iPhone sends the same agent once the
 * version numbers are taken out, so by the agent a person's second phone was
 * never a new device, while an OS or app update on the same install is the
 * same one. Without a key (the web, or a phone whose Keychain refused) the
 * agent decides, as before.
 */
function deviceHash(userId: string, ua: string, deviceKey: string | null): string {
  const identity = deviceKey ? `app::${deviceKey}` : normalizeUserAgent(ua);
  return createHash('sha256').update(`${userId}::${identity}`).digest('hex').slice(0, 40);
}

/**
 * Record the device a user just signed in from, and email a "new device" alert
 * when it's a device we haven't seen on an ALREADY-established account.
 *
 * Self-contained + best-effort: never throws. Sign-in hooks fire this via
 * Next's `after()` so it runs AFTER the response and adds zero login latency.
 * The first device a user is ever seen on is recorded silently (baseline) — we
 * only alert on a genuinely new device once the account has a known one.
 *
 * The email and the webhook event go out only for a device THIS call recorded
 * (S5). The insert's answer used to be ignored: two sign-ins racing on one new
 * device each emailed (the second insert is refused by 0168's unique
 * (user_id, device_hash)), and a refused insert emailed about a device that was
 * never recorded. A 23505 means another sign-in recorded it first, and that
 * call alerts; any other refusal is reported, and nothing is sent.
 */
export async function noteLoginDevice(args: {
  userId: string;
  email: string | null;
  userAgent: string | null;
  ip: string | null;
  /** The phone's install id, checked by the caller (POST /api/v1/auth/signed-in). */
  deviceKey?: string | null;
  /** The phone's own name for itself ("StockPilot app on iPhone 15 Pro (iOS 18.1)"),
   *  built by the caller from allowlisted fields: shown in place of the agent
   *  in the person's own device list and email. */
  deviceLabel?: string | null;
  /** What the organization's activity (the webhook event) calls the device
   *  when the caller gives it: the phone's family only ("StockPilot app on
   *  iPhone"), from fixed words (S5, integrator decision 2026-11-02). */
  deviceFamily?: string | null;
}): Promise<void> {
  try {
    const ua = (args.userAgent ?? '').trim() || 'Unknown device';
    const label = args.deviceLabel?.trim() || null;
    // What the device is called in the person's own device list and email.
    const shown = label ?? ua;
    // What the webhook event calls it: the family when the caller gave one.
    const forOrganization = args.deviceFamily?.trim() || shown;
    const hash = deviceHash(args.userId, ua, args.deviceKey?.trim() || null);
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
          user_agent: shown.slice(0, 400),
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

    const { error: insertError } = await admin.from('user_login_devices').insert({
      user_id: args.userId,
      device_hash: hash,
      user_agent: shown.slice(0, 400),
      last_ip: args.ip,
    });
    if (insertError) {
      // Another sign-in on this device recorded it first; that one alerts.
      if (insertError.code === '23505') return;
      throw new Error(`user_login_devices insert refused (${insertError.code ?? 'no code'})`);
    }

    if (hadKnownDevices && args.email) {
      await sendNewDeviceLoginEmail({
        to: args.email,
        userAgent: ua,
        ip: args.ip,
        deviceLabel: label,
      });
      // Security feed: also surface the new device in each of the user's orgs'
      // subscribed channels (the email above only reaches the user — a hijacked
      // account's owner may never see it; the org's #security channel will).
      // Best-effort like everything here; capped so a many-org account can't
      // fan out unboundedly.
      //
      // Only the organizations the person really belongs to (S5, open question
      // 19): an accepted membership, never an invitation not yet accepted or a
      // support "act as" seat (impersonation_expires_at set).
      const { data: memberships } = await admin
        .from('organization_members')
        .select('organization_id')
        .eq('user_id', args.userId)
        .not('accepted_at', 'is', null)
        .is('impersonation_expires_at', null)
        .limit(5);
      for (const m of (memberships ?? []) as { organization_id: string }[]) {
        // The delivery body lands in customer-controlled Slack/Teams/webhook
        // infra, so it must carry NO PII. Send a non-PII user id + the device
        // string only — NOT the email or IP (those go only to the user's own
        // email alert above + the internal audit_logs in Supabase).
        void dispatchEvent(m.organization_id, 'security.new_device_login', {
          userId: args.userId,
          device: forOrganization.slice(0, 120),
        });
      }
    }
  } catch (e) {
    // Never let an alert failure affect sign-in.
    void reportError(e, { tag: 'auth.login_device_note_failed', level: 'warning' });
  }
}

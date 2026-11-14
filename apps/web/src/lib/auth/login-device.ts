import 'server-only';

import { createHash } from 'node:crypto';

import { browserDeviceName } from '@/lib/auth/user-agent';
import { sendNewDeviceLoginEmail } from '@/lib/email/login-alert';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
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
 * New-device alerts (the email and the organizations' events together) per
 * account in a window. Past it the device is still recorded (the sign-in
 * monitor, app/api/cron/auth-anomalies, counts it) and the sign-in still
 * appears among the account's active sessions; no email and no event are
 * sent. The email that reaches the count says so.
 */
export const NEW_DEVICE_ALERTS_PER_ACCOUNT = 5;
export const NEW_DEVICE_ALERT_WINDOW_MS = 24 * 60 * 60_000;
/** security.new_device_login events per organization in a window. */
export const NEW_DEVICE_EVENTS_PER_ORGANIZATION = 30;
export const NEW_DEVICE_EVENT_WINDOW_MS = 60 * 60_000;

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
 *
 * Alerts are counted (S79), both buckets closed: nothing is sent without a
 * count.
 *   - per account: NEW_DEVICE_ALERTS_PER_ACCOUNT a day. The email that
 *     reaches the count says that no more will come for 24 hours. Past it the
 *     device is recorded with no email and no event; the first device held in
 *     a window is reported once (auth.new_device_alerts_held) with the first
 *     16 hex characters of the SHA-256 of the account id, which the operator
 *     matches by hashing account ids. When the limiter cannot answer, the
 *     device row this call inserted is removed, so the device is still new
 *     at its next sign-in, and nothing is sent.
 *   - per organization: NEW_DEVICE_EVENTS_PER_ORGANIZATION
 *     security.new_device_login events an hour, so the organization's
 *     channels are not flooded; the person's own email is not held by it.
 *     The first event held for an organization in a window is reported once
 *     (auth.new_device_events_held), with the organization id only.
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
   *  iPhone"), from fixed words (S5, integrator decision 2026-11-02). Without
   *  it (a web sign-in) the event names the browser and system, also from
   *  fixed words ("Chrome on macOS", S56). */
  deviceFamily?: string | null;
}): Promise<void> {
  try {
    const ua = (args.userAgent ?? '').trim() || 'Unknown device';
    const label = args.deviceLabel?.trim() || null;
    // What the device is called in the person's own device list and email.
    const shown = label ?? ua;
    // What the webhook event calls it, always fixed words: the family when
    // the caller gave one, else the browser and system the agent names. The
    // agent's own text and the label stay in the person's own list and email.
    const forOrganization = args.deviceFamily?.trim() || browserDeviceName(ua);
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
      const alert = await checkRateLimit(
        `new-device-alert:user:${args.userId}`,
        NEW_DEVICE_ALERTS_PER_ACCOUNT,
        NEW_DEVICE_ALERT_WINDOW_MS,
        'closed',
      );
      if (alert.failed) {
        // Could not count: nothing is sent, and the device is not left
        // recorded as seen, so its next sign-in is still a new device.
        const { error: deleteError } = await admin
          .from('user_login_devices')
          .delete()
          .eq('user_id', args.userId)
          .eq('device_hash', hash);
        if (deleteError) {
          throw new Error(
            `user_login_devices delete after an uncounted alert refused (${deleteError.code ?? 'no code'})`,
          );
        }
        return;
      }
      if (!alert.allowed) {
        await reportAlertsHeld(args.userId);
        return;
      }
      await sendNewDeviceLoginEmail({
        to: args.email,
        userAgent: ua,
        ip: args.ip,
        deviceLabel: label,
        lastForADay: alert.count === NEW_DEVICE_ALERTS_PER_ACCOUNT,
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
        const perOrganization = await checkRateLimit(
          `new-device-event:org:${m.organization_id}`,
          NEW_DEVICE_EVENTS_PER_ORGANIZATION,
          NEW_DEVICE_EVENT_WINDOW_MS,
          'closed',
        );
        if (!perOrganization.allowed) {
          if (!perOrganization.failed) await reportEventsHeld(m.organization_id);
          continue;
        }
        // The delivery body lands in customer-controlled Slack/Teams/webhook
        // infra, so it must carry NO PII. Send a non-PII user id + the device's
        // name in fixed words only — NOT the email or IP (those go only to the
        // user's own email alert above + the internal audit_logs in Supabase).
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

/**
 * One report per account per window when its new-device alerts are held: a
 * hash of the account id only, never the email, the address or the device.
 * Its own bucket, closed, so a limiter that cannot answer reports nothing
 * here (lib/rate-limit logs the failure).
 */
async function reportAlertsHeld(userId: string): Promise<void> {
  const first = await checkRateLimit(
    `new-device-alert-held:user:${userId}`,
    1,
    NEW_DEVICE_ALERT_WINDOW_MS,
    'closed',
  );
  if (!first.allowed) return;
  void reportError(new Error('New-device alerts held for an account past its daily count'), {
    tag: 'auth.new_device_alerts_held',
    level: 'warning',
    userIdHash: createHash('sha256').update(userId).digest('hex').slice(0, 16),
    extra: { limit: NEW_DEVICE_ALERTS_PER_ACCOUNT, window_hours: 24 },
  });
}

/**
 * One report per organization per window when its security.new_device_login
 * events are held: the organization id only, never an account, an email, an
 * address or a device. Its own bucket, closed.
 */
async function reportEventsHeld(organizationId: string): Promise<void> {
  const first = await checkRateLimit(
    `new-device-event-held:org:${organizationId}`,
    1,
    NEW_DEVICE_EVENT_WINDOW_MS,
    'closed',
  );
  if (!first.allowed) return;
  void reportError(
    new Error('New-device events held for an organization past its hourly count'),
    {
      tag: 'auth.new_device_events_held',
      level: 'warning',
      organizationId,
      extra: { limit: NEW_DEVICE_EVENTS_PER_ORGANIZATION, window_hours: 1 },
    },
  );
}

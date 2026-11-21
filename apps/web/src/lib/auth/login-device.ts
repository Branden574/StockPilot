import 'server-only';

import { createHash } from 'node:crypto';

import { signInAlertLinkUrl } from '@/lib/auth/sign-in-alert-url';
import { browserDeviceName } from '@/lib/auth/user-agent';
import { sendNewDeviceLoginEmail } from '@/lib/email/login-alert';
import { reportError } from '@/lib/error-reporter';
import { cityForRecord } from '@/lib/place-name';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { recordSignInAlertEvent } from '@/server/security/sign-in-alert-events';
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
 * Sign-in alert EMAILS (a new device, a new country or both) per account in a
 * window. Past it only the email is held: the device and the country are
 * still recorded (the sign-in monitor, app/api/cron/auth-anomalies, counts
 * devices), and the alert's row is still written, so the sign-in shows with
 * its alert in Active sessions and in the organization's list and the member
 * can still answer it there (review 1, finding 6). The email that reaches the
 * count says no more will come.
 */
export const NEW_DEVICE_ALERTS_PER_ACCOUNT = 5;
export const NEW_DEVICE_ALERT_WINDOW_MS = 24 * 60 * 60_000;
/**
 * Sign-in alert ROWS per account in the same window: a hard ceiling, so the
 * rows one account can write in a day have an end. Past it nothing is
 * learned and nothing is written: the device row and the country row this
 * sign-in added are taken back (they are still new at the next sign-in), and
 * the first sign-in turned away in a window is reported once.
 */
export const SIGN_IN_ALERT_ROWS_PER_ACCOUNT = 50;
/** security.new_device_login events per organization in a window. */
export const NEW_DEVICE_EVENTS_PER_ORGANIZATION = 30;
export const NEW_DEVICE_EVENT_WINDOW_MS = 60 * 60_000;

/** The admin client's type, for the helpers below. */
type AdminClient = ReturnType<typeof createAdminClient>;

/** What sign_in_alerts.device_label and device_family accept (migration sign_in_alerts). */
const DEVICE_WORDS_RE = /^[A-Za-z0-9 ()+.-]{1,120}$/;
/** The words a device gets when its own would not fit the table's rule. */
const UNKNOWN_DEVICE = 'Unknown device';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Device words a sign_in_alerts row can hold: the words, else the fallback, else "Unknown device". */
function deviceWordsForRecord(words: string | null | undefined, fallback: string): string {
  const text = words?.trim() ?? '';
  if (DEVICE_WORDS_RE.test(text)) return text;
  return DEVICE_WORDS_RE.test(fallback) ? fallback : UNKNOWN_DEVICE;
}

/** The error code of a refused write, for a report: never its message. */
function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/** The device this sign-in used: refreshed when known, recorded when new. */
interface DeviceNote {
  /** This call inserted the device row (so it may take it back). */
  insertedNow: boolean;
  /** The device is new on an account that already had one: owed an alert. */
  alerts: boolean;
}

async function noteDevice(
  admin: AdminClient,
  args: { userId: string; hash: string; shown: string; ip: string | null },
): Promise<DeviceNote> {
  // Known device? → bump last-seen, no alert.
  const { data: existing } = await admin
    .from('user_login_devices')
    .select('id')
    .eq('user_id', args.userId)
    .eq('device_hash', args.hash)
    .maybeSingle();
  if (existing) {
    await admin
      .from('user_login_devices')
      .update({
        last_seen_at: new Date().toISOString(),
        last_ip: args.ip,
        user_agent: args.shown.slice(0, 400),
      })
      .eq('id', (existing as { id: string }).id);
    return { insertedNow: false, alerts: false };
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
    device_hash: args.hash,
    user_agent: args.shown.slice(0, 400),
    last_ip: args.ip,
  });
  if (insertError) {
    // Another sign-in on this device recorded it first; that one alerts for
    // the device. This one still notes its country.
    if (insertError.code === '23505') return { insertedNow: false, alerts: false };
    throw new Error(`user_login_devices insert refused (${insertError.code ?? 'no code'})`);
  }
  return { insertedNow: true, alerts: hadKnownDevices };
}

/** The country this sign-in came from. */
interface CountryNote {
  /** This call inserted the country row (so it may take it back). */
  insertedNow: boolean;
  /** The country is new on an account that already had one: owed an alert. */
  alerts: boolean;
}

const NO_COUNTRY: CountryNote = { insertedNow: false, alerts: false };

/**
 * THE COUNTRY RULE (part 3): a plain INSERT of (account, country). A 23505 is
 * the answer "known country": its row's last_seen_at is moved on, no alert.
 * Nothing reads this country before the insert, so two sign-ins racing from
 * one new country cannot both see it as new: one insert wins, one gets 23505.
 *
 * A row this call inserted is new. It alerts only when the account now has
 * more than one country: the first country ever seen for an account is
 * recorded silently, as the first device is (so nobody is alerted at rollout).
 * The count is read AFTER the insert, so two first sign-ins racing from two
 * countries both alert rather than both staying silent. A count that cannot
 * be read is reported and takes the row back (the country is still new at
 * the next sign-in), and nothing alerts for it. Any other refusal is reported
 * with its code, and the sign-in is judged by its device alone.
 */
async function noteCountry(
  admin: AdminClient,
  userId: string,
  country: string,
): Promise<CountryNote> {
  // NEVER THROWS (review 1, finding 5): the device row is already recorded
  // when this runs, and the alert it is owed must not be lost to anything
  // that happens here. Whatever fails, the answer is "no country" and the
  // sign-in is judged by its device alone.
  let inserted = false;
  try {
    const { error } = await admin
      .from('user_sign_in_countries')
      .insert({ user_id: userId, country });
    if (error) {
      if (error.code === '23505') {
        await admin
          .from('user_sign_in_countries')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('country', country);
        return NO_COUNTRY;
      }
      void reportError(new Error('A sign-in country could not be noted'), {
        tag: 'auth.sign_in_country_note_failed',
        level: 'warning',
        extra: { code: codeOf(error) },
      });
      return NO_COUNTRY;
    }
    inserted = true;
    const { count, error: countError } = await admin
      .from('user_sign_in_countries')
      .select('country', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (countError || typeof count !== 'number') {
      void reportError(new Error('A sign-in country could not be noted'), {
        tag: 'auth.sign_in_country_note_failed',
        level: 'warning',
        extra: { code: codeOf(countError), step: 'count' },
      });
      // A take-back that fails is reported there, and still answers "no country".
      await takeBack('country', () => forgetCountry(admin, userId, country));
      return NO_COUNTRY;
    }
    return { insertedNow: true, alerts: count > 1 };
  } catch {
    // Something threw (the network, not a refusal). Reported with no text of
    // the failure; a row this call inserted is taken back, so the country is
    // not learned without its alert.
    void reportError(new Error('A sign-in country could not be noted'), {
      tag: 'auth.sign_in_country_note_failed',
      level: 'warning',
      extra: { code: null, step: inserted ? 'count' : 'insert' },
    });
    if (inserted) await takeBack('country', () => forgetCountry(admin, userId, country));
    return NO_COUNTRY;
  }
}

/** Removes a device row this call inserted. The refusal's code, or null when it worked. */
async function forgetDevice(admin: AdminClient, userId: string, hash: string): Promise<string | null> {
  const { error } = await admin
    .from('user_login_devices')
    .delete()
    .eq('user_id', userId)
    .eq('device_hash', hash);
  return error ? (codeOf(error) ?? 'no code') : null;
}

/** Removes a country row this call inserted. The refusal's code, or null when it worked. */
async function forgetCountry(admin: AdminClient, userId: string, country: string): Promise<string | null> {
  const { error } = await admin
    .from('user_sign_in_countries')
    .delete()
    .eq('user_id', userId)
    .eq('country', country);
  return error ? (codeOf(error) ?? 'no code') : null;
}

/**
 * ONE take-back, on its own (review 1, finding 5): whether it is refused or
 * throws, it is reported once (which row, and the refusal's code only) and
 * nothing is thrown, so the other take-back and everything after it still
 * run. A row that could not be taken back stays recorded as seen.
 */
async function takeBack(
  row: 'device' | 'country',
  forget: () => Promise<string | null>,
): Promise<void> {
  let code: string | null = null;
  try {
    code = await forget();
    if (code === null) return;
  } catch {
    // Reported below with no code: the failure's own text is never carried.
  }
  void reportError(new Error('A row a sign-in added could not be taken back'), {
    tag: 'auth.sign_in_note_undo_failed',
    level: 'warning',
    extra: { row, code },
  });
}

/**
 * The sign_in_alerts row, written BEFORE the email so the email's link can
 * name it. Its id, or null when it could not be written (reported with the
 * code only): the email then goes without the link, so an alert is never lost
 * for its record.
 */
async function insertAlertRow(
  admin: AdminClient,
  row: {
    user_id: string;
    session_id: string | null;
    new_device: boolean;
    new_country: boolean;
    client: 'web' | 'phone';
    device_label: string;
    device_family: string;
    device_hash: string;
    country: string | null;
    city: string | null;
  },
): Promise<string | null> {
  try {
    const { data, error } = await admin.from('sign_in_alerts').insert(row).select('id').single();
    const id = (data as { id?: unknown } | null)?.id;
    if (error || typeof id !== 'string') {
      void reportError(new Error('A sign-in alert could not be recorded'), {
        tag: 'auth.sign_in_alert_insert_failed',
        level: 'warning',
        extra: { code: codeOf(error) },
      });
      return null;
    }
    return id;
  } catch (e) {
    void reportError(new Error('A sign-in alert could not be recorded'), {
      tag: 'auth.sign_in_alert_insert_failed',
      level: 'warning',
      extra: { code: e instanceof Error ? e.name : null },
    });
    return null;
  }
}

/**
 * Record the device a user just signed in from, and the country, and alert
 * the member when either is new on an ALREADY-established account.
 *
 * Self-contained + best-effort: never throws. Sign-in hooks fire this via
 * Next's `after()` so it runs AFTER the response and adds zero login latency.
 * The first device a user is ever seen on is recorded silently (baseline) — we
 * only alert on a genuinely new device once the account has a known one. The
 * first country is recorded silently the same way (noteCountry).
 *
 * ONE ALERT PER SIGN-IN (part 3), owed when the device is new OR the country
 * is new, with both flags. The alert is a row in sign_in_alerts first (so the
 * member can answer it, from the email's "This was not me" link or from
 * Active sessions, and the organization's owners and admins can list it),
 * then the email, then the organizations' webhook event (new device only, as
 * its name says) and, for a new country, a security event
 * (server/security/sign-in-alert-events.ts). A row that cannot be written is
 * reported and the email still goes, without the link.
 *
 * The email and the webhook event go out only for a device THIS call recorded
 * (S5). The insert's answer used to be ignored: two sign-ins racing on one new
 * device each emailed (the second insert is refused by 0168's unique
 * (user_id, device_hash)), and a refused insert emailed about a device that was
 * never recorded. A 23505 means another sign-in recorded it first, and that
 * call alerts; any other refusal is reported, and nothing is sent.
 *
 * Alerts are counted (S79), every bucket closed: nothing is written or sent
 * without a count.
 *   - per account, the alert's ROW: SIGN_IN_ALERT_ROWS_PER_ACCOUNT a day, a
 *     hard ceiling asked first. Past it nothing is learned and nothing is
 *     written or sent: the device row and the country row this call inserted
 *     are removed, so both are still new at the next sign-in, and the first
 *     sign-in turned away in a window is reported once
 *     (auth.sign_in_alert_rows_ceiling).
 *   - per account, the alert's EMAIL: NEW_DEVICE_ALERTS_PER_ACCOUNT a day (a
 *     new country counts as a new device does). The email that reaches the
 *     count says that no more will come for 24 hours. Past it ONLY THE EMAIL
 *     IS HELD (review 1, finding 6): the alert's row is still written, so
 *     the sign-in shows with its alert in Active sessions and in the
 *     organization's list, the device and the country are learned as before
 *     (the row stands for them, and a "This was not me" on it forgets them),
 *     and the organizations' events below still go, paced by their own
 *     count. The first email held in a window is reported once
 *     (auth.new_device_alerts_held) with the first 16 hex characters of the
 *     SHA-256 of the account id, which the operator matches by hashing
 *     account ids. A held email whose row could not be written either
 *     would leave no trace, so its notes are taken back instead.
 *   - when either bucket cannot answer, the device row AND the country row
 *     this call inserted are removed, each on its own (takeBack), so both
 *     are still new at the next sign-in, and nothing is written or sent.
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
  /** Where the sign-in came from (lib/client-ip.ts clientPlaceFromHeaders:
   *  Vercel's headers, only on Vercel). No place, no country rule. */
  place?: { country: string | null; city: string | null } | null;
  /** The Auth session the sign-in made, from verified claims. */
  sessionId?: string | null;
  /** Which app signed in. */
  client?: 'web' | 'phone';
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
    const client = args.client === 'phone' ? 'phone' : 'web';
    // The place as the rows hold it: two capital letters, and a city the
    // tables accept (lib/place-name.ts empties one they would refuse).
    const country =
      typeof args.place?.country === 'string' && /^[A-Z]{2}$/.test(args.place.country)
        ? args.place.country
        : null;
    const place = { country, city: country ? cityForRecord(args.place?.city) : null };
    const admin = createAdminClient();

    const device = await noteDevice(admin, { userId: args.userId, hash, shown, ip: args.ip });
    const countryNote = country ? await noteCountry(admin, args.userId, country) : NO_COUNTRY;
    const newDevice = device.alerts;
    const newCountry = countryNote.alerts;
    if (!(newDevice || newCountry) || !args.email) return;

    // Neither row this sign-in added is left recorded as seen, so its next
    // sign-in is still new. Each take-back runs whatever the other one did.
    const undoNotes = async () => {
      if (device.insertedNow) await takeBack('device', () => forgetDevice(admin, args.userId, hash));
      if (countryNote.insertedNow && country) {
        await takeBack('country', () => forgetCountry(admin, args.userId, country));
      }
    };

    // The ceiling on alert rows first: past it, or without a count, nothing
    // is learned and nothing is written.
    const rows = await checkRateLimit(
      `sign-in-alert-rows:user:${args.userId}`,
      SIGN_IN_ALERT_ROWS_PER_ACCOUNT,
      NEW_DEVICE_ALERT_WINDOW_MS,
      'closed',
    );
    if (!rows.allowed) {
      await undoNotes();
      if (!rows.failed) await reportRowsCeiling(args.userId);
      return;
    }

    // Then the count of alert emails. Could not count: nothing is written or
    // sent. Over the count: only the email is held.
    const alert = await checkRateLimit(
      `new-device-alert:user:${args.userId}`,
      NEW_DEVICE_ALERTS_PER_ACCOUNT,
      NEW_DEVICE_ALERT_WINDOW_MS,
      'closed',
    );
    if (alert.failed) {
      await undoNotes();
      return;
    }
    const emailHeld = !alert.allowed;
    if (emailHeld) await reportAlertsHeld(args.userId);

    const alertId = await insertAlertRow(admin, {
      user_id: args.userId,
      session_id:
        typeof args.sessionId === 'string' && UUID_RE.test(args.sessionId) ? args.sessionId : null,
      new_device: newDevice,
      new_country: newCountry,
      client,
      // The member's words: the phone's label, or the browser and system.
      device_label: deviceWordsForRecord(label ?? forOrganization, forOrganization),
      // The organization's words: the family, or the browser and system.
      device_family: deviceWordsForRecord(forOrganization, UNKNOWN_DEVICE),
      device_hash: hash,
      country: place.country,
      city: place.city,
    });

    if (emailHeld && alertId === null) {
      // No email and no row: this sign-in would leave no trace of its alert.
      // Nothing is learned from it, so its next sign-in is still new.
      await undoNotes();
      return;
    }

    if (!emailHeld) {
      await sendNewDeviceLoginEmail({
        to: args.email,
        userAgent: ua,
        ip: args.ip,
        deviceLabel: label,
        lastForADay: alert.count === NEW_DEVICE_ALERTS_PER_ACCOUNT,
        place,
        newDevice,
        newCountry,
        notMeUrl: alertId ? signInAlertLinkUrl({ alertId, userId: args.userId }) : null,
      });
    }

    if (newDevice) {
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
        // Part 3 adds the country, two letters or null, and never the city.
        void dispatchEvent(m.organization_id, 'security.new_device_login', {
          userId: args.userId,
          device: forOrganization.slice(0, 120),
          country: place.country,
        });
      }
    }

    if (newCountry) {
      // The organizations' Blocked activity and the platform console count it.
      await recordSignInAlertEvent({
        reason: 'sign_in_new_country',
        userId: args.userId,
        source: client,
        place,
      });
    }
  } catch (e) {
    // Never let an alert failure affect sign-in.
    void reportError(e, { tag: 'auth.login_device_note_failed', level: 'warning' });
  }
}

/**
 * One report per account per window when its sign-in alerts meet the ceiling
 * on rows: a hash of the account id only, never the email, the address, the
 * device or the place. Its own bucket, closed, so a limiter that cannot
 * answer reports nothing here (lib/rate-limit logs the failure).
 */
async function reportRowsCeiling(userId: string): Promise<void> {
  const first = await checkRateLimit(
    `sign-in-alert-rows-held:user:${userId}`,
    1,
    NEW_DEVICE_ALERT_WINDOW_MS,
    'closed',
  );
  if (!first.allowed) return;
  void reportError(new Error('Sign-in alerts for an account met the daily ceiling on alert rows'), {
    tag: 'auth.sign_in_alert_rows_ceiling',
    level: 'warning',
    userIdHash: createHash('sha256').update(userId).digest('hex').slice(0, 16),
    extra: { limit: SIGN_IN_ALERT_ROWS_PER_ACCOUNT, window_hours: 24 },
  });
}

/**
 * One report per account per window when its alert emails are held: a
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

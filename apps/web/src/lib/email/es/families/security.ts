/**
 * StockPilot email system — SECURITY family (pw-reset, signin, and the two
 * emails that follow a sign-in alert's "This was not me").
 *
 * Composed exclusively from the shared es component layer; markup follows
 * `docs/design/email-system/templates/archetype-security.html` (the
 * family's normative archetype) with the es-security.jsx mockups as the
 * visual reference for the sign-in alert. Subjects / preheaders come from
 * the registry builders VERBATIM — never reworded here.
 *
 * Senders: both templates send from the registry's
 * `StockPilot Security <security@stockpilotusa.com>`; reply-to intent is
 * "not monitored — support link inside", so no explicit replyTo is set
 * (the transport defaults the Reply-To header to the from address).
 *
 * IMPORTANT (signin, registry flag): the old production copy claimed
 * sign-in alerts can be managed in notification preferences — no such
 * preference exists. That claim is REMOVED in this design and must not
 * be reintroduced; the footer states the truth (a core account-safety
 * notice that always sends).
 */

import {
  MOBILE_GRID_RULES,
  assertEmailWeight,
  banner,
  bodyText,
  brandStrip,
  card,
  ctaRow,
  detailGrid,
  emailShell,
  escapeAttr,
  escapeHtml,
  footer,
  headline,
  heroSlot,
  infoCard,
  linkFallback,
  section,
  statusPill,
} from '../components';
import { esEmailById } from '../registry';
import { DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY } from '@/components/settings/delete-account-copy';
import { NOT_ME_WORDS, reportedMemberName } from '@/lib/auth/sign-in-alert-words';
import { ES_LIGHT, ES_MONO_INLINE, esAssetUrl } from '../tokens';

const L = ES_LIGHT;

/** Base for footer/support links; prod app origin. */
const DEFAULT_APP_URL = 'https://stockpilotusa.com';

export interface RenderedEsEmail {
  /** Registry email id. */
  id: string;
  /** Byte-identical to the registry subject builder. */
  subject: string;
  /** Byte-identical to the registry preheader builder (raw text form). */
  preheader: string;
  html: string;
  text: string;
  /** RFC-5322 sender, verbatim from the registry. */
  from: string;
  /** Explicit Reply-To where the registry routes replies somewhere real. */
  replyTo?: string;
}

/** "Hi Carsten —" / "Hi —" (the archetype's missing-first-name fallback). */
function greeting(firstName: string | null | undefined): string {
  const name = firstName?.trim();
  return name ? `Hi ${escapeHtml(name)} ` : 'Hi ';
}

/** greeting() for a plain-text part: the same words, not escaped. */
function greetingText(firstName: string | null | undefined): string {
  const name = firstName?.trim();
  return name ? `Hi ${name} ` : 'Hi ';
}

function marketingUrls(appUrl: string) {
  const base = appUrl.replace(/\/$/, '');
  return {
    support: `${base}/support`,
    privacy: `${base}/privacy`,
    terms: `${base}/terms`,
  };
}

// ── pw-reset ────────────────────────────────────────────────────────

export interface PasswordResetEmailParams {
  /** Recipient address (shown in body + footer reason). */
  email: string;
  resetUrl: string;
  /** Optional; falls back to the archetype's "Hi —". */
  firstName?: string | null;
  /** Preformatted request time, e.g. "Jun 12, 2026, 2:41 PM UTC". */
  requestedAt?: string | null;
  /** Human device label, e.g. "Chrome on macOS". */
  device?: string | null;
  /** Link validity, human phrase. Supabase recovery links last one hour. */
  linkExpiry?: string;
  appUrl?: string;
}

export function renderPasswordResetEmail(params: PasswordResetEmailParams): RenderedEsEmail {
  const def = esEmailById('pw-reset');
  const linkExpiry = params.linkExpiry ?? '60 minutes';
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const email = escapeHtml(params.email);
  const resetUrl = escapeHtml(params.resetUrl);

  const subject = def.subject({});
  const preheader = def.preheader({ linkExpiry });

  // Optional trailing provenance on the CTA note — drop the pieces we
  // don't truthfully know rather than rendering placeholders.
  const requested = params.requestedAt?.trim()
    ? params.device?.trim()
      ? ` Requested ${escapeHtml(params.requestedAt)}, from ${escapeHtml(params.device)}.`
      : ` Requested ${escapeHtml(params.requestedAt)}.`
    : '';

  const styles = { darkPills: ['sec' as const], darkCards: '.card' };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader: def.preheader({ linkExpiry: escapeHtml(linkExpiry) }),
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: 'sec', label: 'Security &middot; Password reset' }),
          headline({ lead: 'Reset your password.', turn: 'Takes about a minute.' }),
          bodyText(
            `${greeting(params.firstName)}— we received a request to reset the password for <strong class="ink" style="font-weight:600;color:${L.ink}">${email}</strong>. If that was you, set a new one below.`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 24px',
        heroSlot({
          src: esAssetUrl('motion/lock@2x.gif'),
          alt: 'A lock closes with a soft verification ring — password-reset link secured',
          note: 'motion asset: lock.gif · L1 restrained · plays once, no infinite loop on security',
        }),
      ),
      section(
        '0 36px 26px',
        [
          ctaRow({
            primary: { label: def.cta, href: resetUrl },
            noteHtml: `This link works for <strong class="ink2" style="font-weight:600;color:${L.ink2}">${escapeHtml(linkExpiry)}</strong> and can be used once.${requested}`,
          }),
          linkFallback(resetUrl, { marginTop: 12 }),
        ].join('\n      '),
      ),
      section(
        '0 36px 30px',
        infoCard({
          titleHtml: 'Didn&rsquo;t request this?',
          bodyHtml: `Your password hasn&rsquo;t changed and no one has accessed your account. You can safely ignore this email — or <a class="ink2" href="${escapeAttr(urls.support)}" style="color:${L.ink2}">tell support</a> if resets keep arriving that you didn&rsquo;t ask for.`,
        }),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${email}</span> because a password reset was requested for this StockPilot account.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    'Reset your StockPilot password.',
    '',
    `Set a new password: ${params.resetUrl}`,
    '',
    `This link works for ${linkExpiry} and can be used once.${
      params.requestedAt?.trim()
        ? params.device?.trim()
          ? ` Requested ${params.requestedAt}, from ${params.device}.`
          : ` Requested ${params.requestedAt}.`
        : ''
    }`,
    '',
    `Didn’t request this? Your password hasn’t changed and no one has accessed your account — you can safely ignore this email, or tell support if resets keep arriving: ${urls.support}`,
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

// ── signin ──────────────────────────────────────────────────────────

export interface SigninAlertEmailParams {
  /** Recipient address (shown in body, detail grid + footer reason). */
  email: string;
  /** Human device label, e.g. "Chrome on macOS". */
  device: string;
  /** Sign-in IP as observed, or null/"unknown". */
  ip?: string | null;
  /** Preformatted sign-in time, e.g. "Jun 12, 2026, 2:41 PM UTC". */
  when: string;
  /** Security-settings deep link ("Secure my account"). */
  securityUrl: string;
  /** Password-reset request page ("Reset password"). */
  resetUrl: string;
  firstName?: string | null;
  appUrl?: string;
  /**
   * This is the last new-device email the account gets until its 24-hour
   * count starts again (lib/auth/login-device.ts
   * NEW_DEVICE_ALERTS_PER_ACCOUNT): one more sentence says so, in both parts.
   */
  lastForADay?: boolean;
  /**
   * Where the sign-in came from, in words ("Tijuana, Mexico", or the country
   * alone; lib/auth/sign-in-alert-words.ts). A Location row, said to be
   * approximate; left out when unknown. Part 3.
   */
  location?: string | null;
  /** What was new: the device (the default), the country, or both. Part 3. */
  kind?: { newDevice: boolean; newCountry: boolean };
  /**
   * The signed "This was not me" link (lib/auth/sign-in-alert-url.ts). With
   * it, the email's primary button; without it (the alert's record could not
   * be written), the buttons are as before. Part 3.
   */
  notMeUrl?: string | null;
}

/** The primary button of a sign-in alert email that carries its link (part 3). */
export const SIGNIN_ALERT_NOT_ME_LABEL = 'This was not me';

/** "New device", "New country" or both, for the status pill and the text part. */
function signinKindWords(kind: { newDevice: boolean; newCountry: boolean }): string {
  if (kind.newDevice && kind.newCountry) return 'New device and new country';
  if (kind.newCountry) return 'New country';
  return 'New device';
}

/** How the body says what was new (plain text; the HTML escapes its apostrophe). */
function signinKindSentence(kind: { newDevice: boolean; newCountry: boolean }): string {
  if (kind.newDevice && kind.newCountry) {
    return 'from a device and a country we haven’t seen on this account before';
  }
  if (kind.newCountry) return 'from a country we haven’t seen on this account before';
  return 'from a device we haven’t seen before';
}

/** The sentence on the email that reaches the 24-hour count (text part), for a new device. */
export const SIGNIN_ALERT_LAST_FOR_A_DAY_TEXT =
  'Further new-device sign-ins won’t send more emails for up to 24 hours, so if these sign-ins weren’t you, change your password and review your devices under Active sessions in your security settings now.';

/**
 * The same sentence as the email prints it. The count is of sign-in alerts of
 * either kind, so an alert that is for a new country (alone, or with a new
 * device) says "sign-in alerts": "new-device sign-ins" would be untrue of it
 * (review 2, finding 5). A new device alone keeps the sentence it had.
 */
function lastForADaySentence(kind: { newDevice: boolean; newCountry: boolean }): string {
  return kind.newCountry
    ? SIGNIN_ALERT_LAST_FOR_A_DAY_TEXT.replace('Further new-device sign-ins', 'Further sign-in alerts')
    : SIGNIN_ALERT_LAST_FOR_A_DAY_TEXT;
}

export function renderSigninAlertEmail(params: SigninAlertEmailParams): RenderedEsEmail {
  const def = esEmailById('signin');
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const email = escapeHtml(params.email);
  const device = escapeHtml(params.device);
  const when = escapeHtml(params.when);
  const ip = params.ip && params.ip !== 'unknown' ? escapeHtml(params.ip) : 'Unknown';
  const kind = params.kind ?? { newDevice: true, newCountry: false };
  const kindWords = signinKindWords(kind);
  const sentence = signinKindSentence(kind);
  const location = params.location?.trim() || null;
  const notMeUrl = params.notMeUrl?.trim() || null;
  // The registry's own sample summary names the place next to the device.
  const summary = location ? `${params.device} near ${location}` : params.device;

  const subject = def.subject({});
  const preheader = def.preheader({ summary, time: params.when });

  const styles = { darkPills: ['sec' as const], mobileExtras: MOBILE_GRID_RULES };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader: def.preheader({ summary: escapeHtml(summary), time: when }),
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({
            variant: 'sec',
            label: params.kind ? `Security &middot; ${kindWords}` : 'Security &middot; New sign-in',
          }),
          headline({ lead: 'New sign-in to your account.', turn: 'Was this you?' }),
          bodyText(
            `${greeting(params.firstName)}— <strong class="ink" style="font-weight:600;color:${L.ink}">${email}</strong> was just signed in ${sentence.replace(/’/g, '&rsquo;')}. If this was you, there&rsquo;s nothing to do.`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 24px',
        heroSlot({
          src: esAssetUrl('motion/pulse@2x.gif'),
          alt: 'A verification pulse beside a device silhouette — a new device signed in to your account',
          note: 'motion asset: pulse.gif · L1 · loops ×3 then holds',
        }),
      ),
      section(
        '0 36px 24px',
        detailGrid({
          rows: [
            [
              { label: 'Device', valueHtml: device, strong: true },
              { label: 'Date &amp; time', valueHtml: when, strong: true },
            ],
            [
              {
                label: 'IP address',
                valueHtml: ip,
                subHtml: 'Approximate location signal, based on network',
              },
              { label: 'Account', valueHtml: email },
            ],
          ],
          ...(location
            ? { span: { label: 'Location', valueHtml: `${escapeHtml(location)} (approximate)` } }
            : {}),
        }),
      ),
      section(
        '0 36px 20px',
        banner({
          tone: 'err',
          titleHtml: 'Don&rsquo;t recognize this?',
          bodyHtml: notMeUrl
            ? `Press &ldquo;This was not me&rdquo; below. ${NOT_ME_WORDS.whatItDoes} ${NOT_ME_WORDS.thenReset}`
            : 'Secure your account right away — you can sign out all devices and reset your password from your security settings.',
        }),
      ),
      ...(params.lastForADay
        ? [section('0 36px 20px', bodyText(lastForADaySentence(kind).replace(/’/g, '&rsquo;')))]
        : []),
      section(
        '0 36px 30px',
        notMeUrl
          ? ctaRow({
              primary: { label: SIGNIN_ALERT_NOT_ME_LABEL, href: escapeHtml(notMeUrl) },
              secondary: { label: def.cta, href: escapeHtml(params.securityUrl) },
              noteHtml:
                'This button works for 7 days. It opens a page where you can end every session of your account.',
            })
          : ctaRow({
              primary: { label: def.cta, href: escapeHtml(params.securityUrl) },
              secondary: { label: def.cta2!, href: escapeHtml(params.resetUrl) },
            }),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${email}</span> ${
          kind.newCountry && !kind.newDevice
            ? 'when your account signs in from a new country'
            : kind.newCountry
              ? 'when a new device signs in from a new country'
              : 'when a new device signs in'
        } — a core account-safety notice.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    'New sign-in to your StockPilot account.',
    '',
    `${params.email} was just signed in ${sentence}. If this was you, there’s nothing to do.`,
    '',
    `Device:      ${params.device}`,
    ...(location ? [`Location:    ${location} (approximate)`] : []),
    `IP address:  ${params.ip && params.ip !== 'unknown' ? params.ip : 'Unknown'}`,
    `Date & time: ${params.when}`,
    ...(params.kind ? [`Why:         ${kindWords}`] : []),
    '',
    ...(notMeUrl
      ? [
          `Don’t recognize this? This was not me (ends every session of your account): ${notMeUrl}`,
          NOT_ME_WORDS.thenReset,
          'This link works for 7 days.',
          `Secure my account: ${params.securityUrl}`,
        ]
      : [
          `Don’t recognize this? Secure your account right away — sign out all devices and reset your password: ${params.securityUrl}`,
          `Reset password: ${params.resetUrl}`,
        ]),
    ...(params.lastForADay ? ['', lastForADaySentence(kind)] : []),
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

// ── signin-signed-out (part 3) ──────────────────────────────────────

export interface SigninSignedOutEmailParams {
  /** Recipient: the account's own address. */
  email: string;
  firstName?: string | null;
  /** The member's own words for the device of the sign-in they reported. */
  device: string;
  /** Where that sign-in came from, in words, or null when unknown. */
  location?: string | null;
  /** When that sign-in happened, preformatted ("Nov 20, 2026, 3:30 PM UTC"). */
  when: string;
  /** The password-reset request page (/reset). */
  resetUrl: string;
  appUrl?: string;
  /**
   * At least one owner or admin of the member's organization was told. The
   * email says so only then: a sole owner, an account in no organization and
   * a failed read are all false (review 1, finding 8).
   */
  adminsTold?: boolean;
}

/**
 * After the member's "This was not me" (server/services/sign-in-alert-report.ts):
 * every session of the account has been ended. One button, to reset the
 * password, because a password someone else knows still signs in. Sent once
 * per alert.
 *
 * THE WORDS PROMISE WHAT HAPPENS AND NO MORE (review 1, finding 1;
 * NOT_ME_WORDS in lib/auth/sign-in-alert-words.ts): the sessions are ended, a
 * device that is already open can keep working until its current pass
 * expires, and the reset is what closes the door. Never "signed out
 * everywhere" or "right away".
 */
export function renderSigninSignedOutEmail(params: SigninSignedOutEmailParams): RenderedEsEmail {
  const def = esEmailById('signin-signed-out');
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const email = escapeHtml(params.email);
  const device = escapeHtml(params.device);
  const when = escapeHtml(params.when);
  const location = params.location?.trim() || null;
  const resetUrl = escapeHtml(params.resetUrl);
  // Plain words with nothing to escape; the same in both parts.
  const closing = params.adminsTold === true
    ? `${NOT_ME_WORDS.resetNow} ${NOT_ME_WORDS.adminsTold}`
    : NOT_ME_WORDS.resetNow;

  const subject = def.subject({});
  const preheader = def.preheader({});

  const styles = { darkPills: ['sec' as const], darkCards: '.card', mobileExtras: MOBILE_GRID_RULES };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader: escapeHtml(preheader),
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: 'sec', label: 'Security &middot; Sessions ended' }),
          headline({ lead: NOT_ME_WORDS.sessionsEnded, turn: 'Reset your password now.' }),
          bodyText(
            `${greeting(params.firstName)}— you told us a sign-in to <strong class="ink" style="font-weight:600;color:${L.ink}">${email}</strong> was not you. ${NOT_ME_WORDS.sessionsEnded} That covers the web and the phone app. ${NOT_ME_WORDS.openDevice}`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 24px',
        detailGrid({
          rows: [
            [
              { label: 'Device', valueHtml: device, strong: true },
              { label: 'Date &amp; time', valueHtml: when, strong: true },
            ],
          ],
          ...(location
            ? { span: { label: 'Location', valueHtml: `${escapeHtml(location)} (approximate)` } }
            : {}),
        }),
      ),
      section(
        '0 36px 20px',
        banner({
          tone: 'err',
          titleHtml: 'Your password still works',
          bodyHtml: closing,
        }),
      ),
      section(
        '0 36px 30px',
        [
          ctaRow({ primary: { label: def.cta, href: resetUrl } }),
          linkFallback(resetUrl, { marginTop: 12 }),
        ].join('\n      '),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${email}</span> because you said a sign-in to this StockPilot account was not you — a core account-safety notice.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    'Every session of your StockPilot account has been ended.',
    '',
    `${greetingText(params.firstName)}— you told us a sign-in to ${params.email} was not you. ${NOT_ME_WORDS.sessionsEnded} That covers the web and the phone app. ${NOT_ME_WORDS.openDevice}`,
    '',
    `Device:      ${params.device}`,
    ...(location ? [`Location:    ${location} (approximate)`] : []),
    `Date & time: ${params.when}`,
    '',
    closing,
    `${def.cta}: ${params.resetUrl}`,
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

// ── signin-reported (part 3) ────────────────────────────────────────

export interface SigninReportedEmailParams {
  /** Recipient: an owner or admin of the organization. */
  adminEmail: string;
  adminFirstName?: string | null;
  /**
   * The member's own profile name, or null when they have none. The member
   * chooses it, so it is in the BODY only, cut and cleaned (reportedMemberName),
   * next to memberEmail; it is never in the subject (review 1, finding 7).
   */
  memberName: string | null;
  /** The member's sign-in address, which the member cannot edit. */
  memberEmail: string;
  organizationName: string;
  /** The device FAMILY ("Chrome on macOS", "StockPilot app on iPhone"), never the member's label. */
  deviceFamily: string;
  location?: string | null;
  /** When the reported sign-in happened, preformatted. */
  when: string;
  /** The organization's list of sign-in alerts. */
  listUrl: string;
  appUrl?: string;
}

/**
 * To each owner and admin of an organization the member belongs to, after the
 * member's "This was not me": who, which kind of device (the family only, as
 * the organization's activity names a device), where and when, and a link to
 * the organization's list of sign-in alerts. Managers and staff are never
 * sent it (server/services/sign-in-alert-report.ts decides who is).
 */
export function renderSigninReportedEmail(params: SigninReportedEmailParams): RenderedEsEmail {
  const def = esEmailById('signin-reported');
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  // Who reported it, for the body: the name next to the sign-in address, or
  // the address alone, or fixed words when neither is known.
  const name = reportedMemberName(params.memberName);
  const address = params.memberEmail.trim();
  const whoText = name && address ? `${name} (${address})` : name || address || 'A member';
  const strong = (inner: string) =>
    `<strong class="ink" style="font-weight:600;color:${L.ink}">${escapeHtml(inner)}</strong>`;
  const whoHtml = name && address ? `${strong(name)} (${escapeHtml(address)})` : strong(name || address || 'A member');
  // Whom to talk to: the name when there is one, else "them".
  const talkTo = name ?? 'them';
  const memberEmail = escapeHtml(address);
  const adminEmail = escapeHtml(params.adminEmail);
  const organization = escapeHtml(params.organizationName);
  const deviceFamily = escapeHtml(params.deviceFamily);
  const when = escapeHtml(params.when);
  const location = params.location?.trim() || null;
  const listUrl = escapeHtml(params.listUrl);

  const subject = def.subject({});
  const preheader = def.preheader({});

  const styles = { darkPills: ['sec' as const], mobileExtras: MOBILE_GRID_RULES };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader: escapeHtml(preheader),
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: 'sec', label: 'Security &middot; Reported sign-in' }),
          headline({ lead: 'A member reported a sign-in.', turn: 'Their sessions were ended.' }),
          bodyText(
            `${greeting(params.adminFirstName)}— ${whoHtml} told StockPilot that a sign-in to their account was not them. ${NOT_ME_WORDS.theirSessionsEnded} ${NOT_ME_WORDS.openDevice}`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 24px',
        detailGrid({
          rows: [
            [
              { label: 'Device', valueHtml: deviceFamily, strong: true },
              { label: 'Date &amp; time', valueHtml: when, strong: true },
            ],
            [
              { label: 'Member', valueHtml: memberEmail },
              { label: 'Organization', valueHtml: organization },
            ],
          ],
          ...(location
            ? { span: { label: 'Location', valueHtml: `${escapeHtml(location)} (approximate)` } }
            : {}),
        }),
      ),
      section(
        '0 36px 20px',
        banner({
          tone: 'err',
          titleHtml: 'What you can do',
          bodyHtml: `Talk to ${escapeHtml(talkTo)} and make sure they reset their password now. That is what closes the door. Look at the sign-in alerts of your organization for other sign-ins nobody expects.`,
        }),
      ),
      section(
        '0 36px 30px',
        ctaRow({ primary: { label: def.cta, href: listUrl } }),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${adminEmail}</span> because you are an owner or admin of ${organization} — a core account-safety notice.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    `${subject}.`,
    '',
    `${greetingText(params.adminFirstName)}— ${whoText} told StockPilot that a sign-in to their account was not them. ${NOT_ME_WORDS.theirSessionsEnded} ${NOT_ME_WORDS.openDevice}`,
    '',
    `Device:       ${params.deviceFamily}`,
    ...(location ? [`Location:     ${location} (approximate)`] : []),
    `Date & time:  ${params.when}`,
    `Organization: ${params.organizationName}`,
    '',
    `What you can do: talk to ${talkTo} and make sure they reset their password now. That is what closes the door. Look at the sign-in alerts of your organization for other sign-ins nobody expects.`,
    `${def.cta}: ${params.listUrl}`,
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

// ── email-change-new ───────────────────────────────────────────────
//
// The three email-change templates below were added 2026-08-25 with the
// verified self-service email change (mig 0345). They follow the family's
// archetype exactly like pw-reset; the copy is deliberate:
//   * the NEW address is told nothing changes until BOTH sides confirm, so a
//     stranger who receives it by mistake has nothing to do;
//   * the CURRENT address gets the one message that lets the real owner stop
//     a change they did not make, with the "do not approve" warning up front;
//   * the OLD address is told after the fact — GoTrue's own changed-email
//     notice is disabled in production, so this is the only record it gets.

export interface EmailChangeNewParams {
  /** Recipient: the address being added. */
  newEmail: string;
  /** The address that stays canonical until both confirmations complete. */
  currentEmail: string;
  confirmUrl: string;
  firstName?: string | null;
  linkExpiry?: string;
  appUrl?: string;
}

export function renderEmailChangeNewEmail(params: EmailChangeNewParams): RenderedEsEmail {
  const def = esEmailById('email-change-new');
  const linkExpiry = params.linkExpiry ?? '60 minutes';
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const newEmail = escapeHtml(params.newEmail);
  const currentEmail = escapeHtml(params.currentEmail);
  const confirmUrl = escapeHtml(params.confirmUrl);

  const subject = def.subject({});
  const preheader = def.preheader({ linkExpiry });

  const styles = { darkPills: ['sec' as const], darkCards: '.card' };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader: def.preheader({ linkExpiry: escapeHtml(linkExpiry) }),
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: 'sec', label: 'Security &middot; Confirm email' }),
          headline({ lead: 'Confirm your new email.', turn: 'One of two confirmations.' }),
          bodyText(
            `${greeting(params.firstName)}— you asked to change the sign-in email for your StockPilot account from <strong class="ink" style="font-weight:600;color:${L.ink}">${currentEmail}</strong> to <strong class="ink" style="font-weight:600;color:${L.ink}">${newEmail}</strong>. Confirm that this address is yours.`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 24px',
        heroSlot({
          src: esAssetUrl('motion/lock@2x.gif'),
          alt: 'A lock closes with a soft verification ring — new email confirmation link secured',
          note: 'motion asset: lock.gif · L1 restrained · plays once, no infinite loop on security',
        }),
      ),
      section(
        '0 36px 26px',
        [
          ctaRow({
            primary: { label: def.cta, href: confirmUrl },
            noteHtml: `This link works for <strong class="ink2" style="font-weight:600;color:${L.ink2}">${escapeHtml(linkExpiry)}</strong> and can be used once. Your account keeps using ${currentEmail} until both addresses have confirmed.`,
          }),
          linkFallback(confirmUrl, { marginTop: 12 }),
        ].join('\n      '),
      ),
      section(
        '0 36px 30px',
        infoCard({
          titleHtml: 'Didn&rsquo;t request this?',
          bodyHtml: `Nothing changes unless both addresses confirm. You can safely ignore this email — or <a class="ink2" href="${escapeAttr(urls.support)}" style="color:${L.ink2}">tell support</a> if these keep arriving.`,
        }),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${newEmail}</span> because someone asked to make it the sign-in email for a StockPilot account.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    'Confirm your new StockPilot email.',
    '',
    `You asked to change the sign-in email for your StockPilot account from ${params.currentEmail} to ${params.newEmail}. Confirm that this address is yours:`,
    params.confirmUrl,
    '',
    `This link works for ${linkExpiry} and can be used once. Your account keeps using ${params.currentEmail} until both addresses have confirmed.`,
    '',
    `Didn’t request this? Nothing changes unless both addresses confirm — you can safely ignore this email, or tell support: ${urls.support}`,
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

// ── email-change-current ───────────────────────────────────────────

export interface EmailChangeCurrentParams {
  /** Recipient: the address that must approve. */
  currentEmail: string;
  newEmail: string;
  approveUrl: string;
  firstName?: string | null;
  /** Preformatted request time, e.g. "Jun 12, 2026, 2:41 PM UTC". */
  requestedAt?: string | null;
  linkExpiry?: string;
  appUrl?: string;
}

export function renderEmailChangeCurrentEmail(params: EmailChangeCurrentParams): RenderedEsEmail {
  const def = esEmailById('email-change-current');
  const linkExpiry = params.linkExpiry ?? '60 minutes';
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const currentEmail = escapeHtml(params.currentEmail);
  const newEmail = escapeHtml(params.newEmail);
  const approveUrl = escapeHtml(params.approveUrl);
  const resetUrl = `${appUrl.replace(/\/$/, '')}/reset`;

  const subject = def.subject({ newEmail: params.newEmail });
  const preheader = def.preheader({ linkExpiry });

  const requested = params.requestedAt?.trim() ? ` Requested ${escapeHtml(params.requestedAt)}.` : '';

  const styles = { darkPills: ['sec' as const], darkCards: '.card' };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader: def.preheader({ linkExpiry: escapeHtml(linkExpiry) }),
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: 'sec', label: 'Security &middot; Approve change' }),
          headline({ lead: 'Approve your email change.', turn: 'Was this you?' }),
          bodyText(
            `${greeting(params.firstName)}— a request was made to change the sign-in email for <strong class="ink" style="font-weight:600;color:${L.ink}">${currentEmail}</strong> to <strong class="ink" style="font-weight:600;color:${L.ink}">${newEmail}</strong>. If that was you, approve it below.`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 20px',
        banner({
          tone: 'err',
          titleHtml: 'Didn&rsquo;t request this?',
          bodyHtml:
            'Do not approve it. Someone may have access to your account — change your password now and tell your administrator. Nothing changes unless you approve.',
        }),
      ),
      section(
        '0 36px 24px',
        heroSlot({
          src: esAssetUrl('motion/lock@2x.gif'),
          alt: 'A lock closes with a soft verification ring — approval link secured',
          note: 'motion asset: lock.gif · L1 restrained · plays once, no infinite loop on security',
        }),
      ),
      section(
        '0 36px 26px',
        [
          ctaRow({
            primary: { label: def.cta, href: approveUrl },
            secondary: { label: def.cta2!, href: escapeHtml(resetUrl) },
            noteHtml: `This link works for <strong class="ink2" style="font-weight:600;color:${L.ink2}">${escapeHtml(linkExpiry)}</strong> and can be used once. The new address must confirm too before anything changes.${requested}`,
          }),
          linkFallback(approveUrl, { marginTop: 12 }),
        ].join('\n      '),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${currentEmail}</span> because an email change was requested for this StockPilot account — a core account-safety notice.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    'Approve changing your StockPilot email.',
    '',
    `A request was made to change the sign-in email for ${params.currentEmail} to ${params.newEmail}. If that was you, approve it here:`,
    params.approveUrl,
    '',
    `This link works for ${linkExpiry} and can be used once. The new address must confirm too before anything changes.${params.requestedAt?.trim() ? ` Requested ${params.requestedAt}.` : ''}`,
    '',
    `Didn’t request this? Do not approve it. Someone may have access to your account — change your password now and tell your administrator: ${resetUrl}`,
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

// ── email-changed ──────────────────────────────────────────────────

export interface EmailChangedNoticeParams {
  /** Recipient: the address that was just replaced. */
  oldEmail: string;
  newEmail: string;
  /** Preformatted change time, e.g. "Jun 12, 2026, 2:41 PM UTC". */
  changedAt: string;
  firstName?: string | null;
  appUrl?: string;
}

export function renderEmailChangedNoticeEmail(params: EmailChangedNoticeParams): RenderedEsEmail {
  const def = esEmailById('email-changed');
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const oldEmail = escapeHtml(params.oldEmail);
  const newEmail = escapeHtml(params.newEmail);
  const changedAt = escapeHtml(params.changedAt);

  const subject = def.subject({});
  const preheader = def.preheader({ newEmail: params.newEmail });

  const styles = { darkPills: ['sec' as const], mobileExtras: MOBILE_GRID_RULES };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader: def.preheader({ newEmail }),
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: 'sec', label: 'Security &middot; Email changed' }),
          headline({ lead: 'Your sign-in email was changed.', turn: 'This is the record of it.' }),
          bodyText(
            `${greeting(params.firstName)}— the sign-in email for your StockPilot account changed from <strong class="ink" style="font-weight:600;color:${L.ink}">${oldEmail}</strong> to <strong class="ink" style="font-weight:600;color:${L.ink}">${newEmail}</strong>. Account emails now go to the new address.`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 24px',
        detailGrid({
          rows: [
            [
              { label: 'Previous', valueHtml: oldEmail, strong: true },
              { label: 'New', valueHtml: newEmail, strong: true },
            ],
            [
              { label: 'Changed', valueHtml: changedAt },
              { label: 'Now signs in as', valueHtml: newEmail },
            ],
          ],
        }),
      ),
      section(
        '0 36px 20px',
        banner({
          tone: 'err',
          titleHtml: 'Didn&rsquo;t do this?',
          bodyHtml:
            'Contact your administrator immediately. They can disable the account and revoke every session from the Team page.',
        }),
      ),
      section(
        '0 36px 30px',
        ctaRow({
          primary: { label: def.cta, href: escapeHtml(urls.support) },
        }),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${oldEmail}</span> because it was the sign-in email for this StockPilot account until just now — a core account-safety notice.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    'Your StockPilot sign-in email was changed.',
    '',
    `The sign-in email for your StockPilot account changed from ${params.oldEmail} to ${params.newEmail} on ${params.changedAt}. Account emails now go to the new address.`,
    '',
    `Didn’t do this? Contact your administrator immediately — they can disable the account and revoke every session. Support: ${urls.support}`,
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

// ── account-delete-code ─────────────────────────────────────────────

export interface AccountDeleteCodeEmailParams {
  /** Recipient: the account's current sign-in address. */
  email: string;
  /** Six digits. In the body only: never in the subject or the preheader. */
  code: string;
  /** How long the code works, human phrase. */
  codeExpiry?: string;
  firstName?: string | null;
  appUrl?: string;
}

/**
 * The code that confirms deleting an account with no authenticator
 * (server/lib/account-deletion-credential.ts). Says what the code is for, how
 * long it works, and that nothing happens unless it is used.
 */
export function renderAccountDeleteCodeEmail(params: AccountDeleteCodeEmailParams): RenderedEsEmail {
  const def = esEmailById('account-delete-code');
  const codeExpiry = params.codeExpiry ?? '10 minutes';
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const email = escapeHtml(params.email);
  const code = escapeHtml(params.code);

  const subject = def.subject({});
  const preheader = def.preheader({ codeExpiry });

  const styles = { darkPills: ['sec' as const], darkCards: '.card' };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader: def.preheader({ codeExpiry: escapeHtml(codeExpiry) }),
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: 'sec', label: 'Security &middot; Delete account' }),
          headline({ lead: 'Your code to delete your account.', turn: 'Enter it in StockPilot.' }),
          bodyText(
            `${greeting(params.firstName)}— someone asked to delete the StockPilot account for <strong class="ink" style="font-weight:600;color:${L.ink}">${email}</strong>. If that was you, enter this code where you asked for it to confirm.`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 24px',
        card(
          `<div class="ink" style="font-family:${ES_MONO_INLINE};font-size:30px;font-weight:600;letter-spacing:0.3em;color:${L.ink};text-align:center">${code}</div>
        <div class="ink3" style="font-size:12px;color:${L.ink3};text-align:center;margin-top:8px">This code works for <strong class="ink2" style="font-weight:600;color:${L.ink2}">${escapeHtml(codeExpiry)}</strong>. ${escapeHtml(DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY)} Deleting an account cannot be undone.</div>`,
          { pad: '20px 20px' },
        ),
      ),
      section(
        '0 36px 30px',
        infoCard({
          titleHtml: 'Didn&rsquo;t ask for this?',
          bodyHtml: `Nothing happens unless the code is used. Do not share it with anyone. If someone else may be signed in to your account, change your password and <a class="ink2" href="${escapeAttr(urls.support)}" style="color:${L.ink2}">tell support</a>.`,
        }),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${email}</span> because a code to delete this StockPilot account was requested.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    'Your code to delete your StockPilot account.',
    '',
    `${greetingText(params.firstName)}— someone asked to delete the StockPilot account for ${params.email}. If that was you, enter this code where you asked for it to confirm:`,
    '',
    params.code,
    '',
    `This code works for ${codeExpiry}. ${DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY} Deleting an account cannot be undone.`,
    '',
    `Didn’t ask for this? Nothing happens unless the code is used. Do not share it with anyone. If someone else may be signed in to your account, change your password and tell support: ${urls.support}`,
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

// ── passkey-added / passkey-removed ─────────────────────────────────

export interface PasskeyAddedEmailParams {
  /** Recipient: the account's current sign-in address. */
  email: string;
  /** Preformatted time, e.g. "Nov 21, 2026, 9:41 AM UTC". */
  addedAt: string;
  /** The kind of device our server read ("Chrome on macOS"), never the passkey's name. */
  device: string;
  firstName?: string | null;
  appUrl?: string;
}

/**
 * A passkey was added (plan 2.8, section 4). Never the member's name for the
 * passkey (review 1 F5): "a passkey" and the kind of device. No link that
 * signs in: the one button is support.
 */
export function renderPasskeyAddedEmail(params: PasskeyAddedEmailParams): RenderedEsEmail {
  const def = esEmailById('passkey-added');
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const email = escapeHtml(params.email);
  const addedAt = escapeHtml(params.addedAt);
  const device = escapeHtml(params.device);

  const subject = def.subject({});
  const preheader = def.preheader({ device: params.device });

  const styles = { darkPills: ['sec' as const], mobileExtras: MOBILE_GRID_RULES };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader: def.preheader({ device }),
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: 'sec', label: 'Security &middot; Passkey added' }),
          headline({ lead: 'A passkey was added.', turn: 'This is the record of it.' }),
          bodyText(
            `${greeting(params.firstName)}— a passkey was added to your StockPilot account on ${addedAt} from ${device}. You now confirm it&rsquo;s you with it after your password.`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 24px',
        detailGrid({
          rows: [
            [
              { label: 'Added', valueHtml: addedAt },
              { label: 'From', valueHtml: device },
            ],
          ],
        }),
      ),
      section(
        '0 36px 20px',
        banner({
          tone: 'err',
          titleHtml: 'Was this not you?',
          bodyHtml:
            'Sign in, remove it in Settings, Security, and change your password. If you can&rsquo;t sign in, use a recovery code, then contact your administrator.',
        }),
      ),
      section(
        '0 36px 30px',
        ctaRow({
          primary: { label: def.cta, href: escapeHtml(urls.support) },
        }),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${email}</span> because a passkey was added to this StockPilot account — a core account-safety notice.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    'A passkey was added to your StockPilot account.',
    '',
    `${greetingText(params.firstName)}— a passkey was added to your StockPilot account on ${params.addedAt} from ${params.device}. You now confirm it’s you with it after your password.`,
    '',
    `Was this not you? Sign in, remove it in Settings, Security, and change your password. If you can’t sign in, use a recovery code, then contact your administrator. Support: ${urls.support}`,
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

export interface PasskeyRemovedEmailParams {
  /** Recipient: the account's current sign-in address. */
  email: string;
  /** Preformatted time, e.g. "Nov 21, 2026, 9:41 AM UTC". */
  removedAt: string;
  firstName?: string | null;
  appUrl?: string;
}

/** A passkey was removed and the other devices signed out (plan 2.8, section 4). */
export function renderPasskeyRemovedEmail(params: PasskeyRemovedEmailParams): RenderedEsEmail {
  const def = esEmailById('passkey-removed');
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const email = escapeHtml(params.email);
  const removedAt = escapeHtml(params.removedAt);

  const subject = def.subject({});
  const preheader = def.preheader({});

  const styles = { darkPills: ['sec' as const], mobileExtras: MOBILE_GRID_RULES };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader,
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: 'sec', label: 'Security &middot; Passkey removed' }),
          headline({ lead: 'A passkey was removed.', turn: 'This is the record of it.' }),
          bodyText(
            `${greeting(params.firstName)}— a passkey was removed from your StockPilot account on ${removedAt}. You were signed out on your other devices.`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 20px',
        banner({
          tone: 'err',
          titleHtml: 'Was this not you?',
          bodyHtml: 'Change your password now and check Settings, Security.',
        }),
      ),
      section(
        '0 36px 30px',
        ctaRow({
          primary: { label: def.cta, href: escapeHtml(urls.support) },
        }),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${email}</span> because a passkey was removed from this StockPilot account — a core account-safety notice.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    'A passkey was removed from your StockPilot account.',
    '',
    `${greetingText(params.firstName)}— a passkey was removed from your StockPilot account on ${params.removedAt}. You were signed out on your other devices.`,
    '',
    `Was this not you? Change your password now and check Settings, Security. Support: ${urls.support}`,
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

// ── passkey-sign-in-ended ───────────────────────────────────────────

export interface PasskeySignInEndedEmailParams {
  /** Recipient: the account's current sign-in address. */
  email: string;
  /** Preformatted time the sign-in was ended, e.g. "Nov 21, 2026, 9:41 AM UTC". */
  endedAt: string;
  firstName?: string | null;
  appUrl?: string;
}

/**
 * A sign-in was ended by the hourly passkey check (integrator decision C): its
 * second step did not come from the member's passkey through our server. Says
 * what happened and to reset the password; no device, no place, no name.
 */
export function renderPasskeySignInEndedEmail(params: PasskeySignInEndedEmailParams): RenderedEsEmail {
  const def = esEmailById('passkey-sign-in-ended');
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const email = escapeHtml(params.email);
  const endedAt = escapeHtml(params.endedAt);
  const resetUrl = `${appUrl.replace(/\/$/, '')}/reset`;

  const subject = def.subject({});
  const preheader = def.preheader({});

  const styles = { darkPills: ['sec' as const] };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader,
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: 'sec', label: 'Security &middot; Sign-in ended' }),
          headline({ lead: 'We ended a sign-in.', turn: 'Reset your password now.' }),
          bodyText(
            `${greeting(params.firstName)}— on ${endedAt} we ended a sign-in to your StockPilot account. Its second step did not come from your passkey, so we could not confirm it was you. Someone may know your password.`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 20px',
        banner({
          tone: 'err',
          titleHtml: 'What to do now',
          bodyHtml:
            'Reset your password. Then check your passkeys and authenticator apps in Settings, Security, and tell your administrator.',
        }),
      ),
      section(
        '0 36px 30px',
        [
          ctaRow({
            primary: { label: def.cta, href: escapeHtml(resetUrl) },
          }),
          linkFallback(escapeHtml(resetUrl), { marginTop: 12 }),
        ].join('\n      '),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${email}</span> because a sign-in to this StockPilot account was ended — a core account-safety notice.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    'We ended a sign-in to your StockPilot account.',
    '',
    `${greetingText(params.firstName)}— on ${params.endedAt} we ended a sign-in to your StockPilot account. Its second step did not come from your passkey, so we could not confirm it was you. Someone may know your password.`,
    '',
    `Reset your password now: ${resetUrl}`,
    '',
    'Then check your passkeys and authenticator apps in Settings, Security, and tell your administrator.',
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

// ── recovery-code-used ──────────────────────────────────────────────

export interface RecoveryCodeUsedEmailParams {
  /** Recipient: the account's current sign-in address. */
  email: string;
  /** Preformatted time the code was used, e.g. "Nov 21, 2026, 9:41 AM UTC". */
  usedAt: string;
  /** The account had a passkey (one was removed, or its bridge factor was). */
  passkeys: boolean;
  /**
   * The passkeys are known removed while `methodsLeft` is 'unchecked' (they
   * went with the code; no other removal was tried).
   */
  passkeysRemoved?: boolean;
  /** Every other session of the account was ended. */
  othersSignedOut: boolean;
  /**
   * What the code left, by kind, never which one (the review of stage 5,
   * finding 1; lib/auth/recovery-code-words.ts RecoveryMethodsLeft): an app
   * that could not be removed, a passkey whose records are not known to be
   * removed, passkeys removed while the account still asks for a second
   * step, or a list of methods that could not be read (no removal tried).
   */
  methodsLeft?: 'app' | 'passkey' | 'app_and_passkey' | 'second_step' | 'unchecked';
  firstName?: string | null;
  appUrl?: string;
}

/**
 * The sentence for what was left. It never says a method was removed unless
 * that is known, and never that a check was made when no removal was tried
 * (the review of the last deltas, findings 3 and 8).
 */
const RECOVERY_METHODS_LEFT = {
  app: 'An authenticator app could not be removed, so it is still on your account.',
  passkey: 'A passkey may still be on your account.',
  app_and_passkey:
    'An authenticator app could not be removed, so it is still on your account. A passkey may still be on it too.',
  second_step: 'Your passkeys were removed, but your account still asks for a second step.',
  unchecked: 'Your sign-in methods could not be removed.',
} as const;
/** No removal was tried, but the passkeys went with the code. */
const RECOVERY_UNCHECKED_AFTER_PASSKEYS =
  'Your passkeys were removed. Your other sign-in methods could not be removed.';

/**
 * A recovery code was used (answers Q6 and Q7 of the passkey plan): every
 * authenticator app, and every passkey when the account had one, was removed,
 * and the other devices were signed out when that could be done. Only true
 * sentences: an account with no passkey never reads the word, devices that
 * could not be signed out are said not to be, and when a method could not be
 * removed (or the list of them could not be read) the email says so and never
 * that they were removed: its subject, pill and first line then say only that
 * a code was used (the review of stage 5, finding 1). The subject takes only
 * that flag: nothing a member typed reaches it. The one action is the password
 * reset page; no link signs in.
 */
export function renderRecoveryCodeUsedEmail(params: RecoveryCodeUsedEmailParams): RenderedEsEmail {
  const def = esEmailById('recovery-code-used');
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const email = escapeHtml(params.email);
  const usedAt = escapeHtml(params.usedAt);
  const resetUrl = `${appUrl.replace(/\/$/, '')}/reset`;

  const methodsLeft = params.methodsLeft !== undefined;
  const removed = params.passkeys
    ? 'Every authenticator app and passkey was removed'
    : 'Every authenticator app was removed';
  const others = params.othersSignedOut
    ? 'Your other devices were signed out.'
    : 'We could not sign out your other devices.';
  const left =
    params.methodsLeft === 'unchecked' && params.passkeysRemoved === true
      ? RECOVERY_UNCHECKED_AFTER_PASSKEYS
      : params.methodsLeft
        ? RECOVERY_METHODS_LEFT[params.methodsLeft]
        : '';
  const outcome = params.methodsLeft
    ? `${left} ${others}`
    : params.othersSignedOut
      ? `${removed}, and your other devices were signed out.`
      : `${removed}. ${others}`;
  const used = `a recovery code was used on your StockPilot account on ${params.usedAt}.`;

  const subject = def.subject({ methodsLeft });
  const preheader = def.preheader({});

  const styles = { darkPills: ['sec' as const] };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader,
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({
            variant: 'sec',
            label: methodsLeft
              ? 'Security &middot; Recovery code used'
              : 'Security &middot; Sign-in methods removed',
          }),
          headline({ lead: 'A recovery code was used.', turn: 'This is the record of it.' }),
          bodyText(
            `${greeting(params.firstName)}— a recovery code was used on your StockPilot account on ${usedAt}. ${outcome}`,
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 20px',
        banner({
          tone: 'err',
          titleHtml: 'Was this not you?',
          bodyHtml:
            'If this was not you, reset your password now. Then set up your sign-in methods again in Settings, Security, and tell your administrator.',
        }),
      ),
      section(
        '0 36px 30px',
        [
          ctaRow({
            primary: { label: def.cta, href: escapeHtml(resetUrl) },
          }),
          linkFallback(escapeHtml(resetUrl), { marginTop: 12 }),
        ].join('\n      '),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${email}</span> because a recovery code was used on this StockPilot account — a core account-safety notice.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    `${subject}.`,
    '',
    `${greetingText(params.firstName)}— ${used} ${outcome}`,
    '',
    `If this was not you, reset your password now: ${resetUrl}`,
    '',
    'Then set up your sign-in methods again in Settings, Security, and tell your administrator.',
  ].join('\n');

  return { id: def.id, subject, preheader, html, text, from: def.from };
}

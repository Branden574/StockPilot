/**
 * StockPilot email system — SECURITY family (pw-reset, signin).
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
import { ES_LIGHT, esAssetUrl } from '../tokens';

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

/** "Hi Branden —" / "Hi —" (the archetype's missing-first-name fallback). */
function greeting(firstName: string | null | undefined): string {
  const name = firstName?.trim();
  return name ? `Hi ${escapeHtml(name)} ` : 'Hi ';
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
}

export function renderSigninAlertEmail(params: SigninAlertEmailParams): RenderedEsEmail {
  const def = esEmailById('signin');
  const appUrl = params.appUrl ?? DEFAULT_APP_URL;
  const urls = marketingUrls(appUrl);
  const email = escapeHtml(params.email);
  const device = escapeHtml(params.device);
  const when = escapeHtml(params.when);
  const ip = params.ip && params.ip !== 'unknown' ? escapeHtml(params.ip) : 'Unknown';

  const subject = def.subject({});
  const preheader = def.preheader({ summary: params.device, time: params.when });

  const styles = { darkPills: ['sec' as const], mobileExtras: MOBILE_GRID_RULES };
  const html = emailShell({
    title: escapeHtml(subject),
    preheader: def.preheader({ summary: device, time: when }),
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: def.tag }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: 'sec', label: 'Security &middot; New sign-in' }),
          headline({ lead: 'New sign-in to your account.', turn: 'Was this you?' }),
          bodyText(
            `${greeting(params.firstName)}— <strong class="ink" style="font-weight:600;color:${L.ink}">${email}</strong> was just signed in from a device we haven&rsquo;t seen before. If this was you, there&rsquo;s nothing to do.`,
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
        }),
      ),
      section(
        '0 36px 20px',
        banner({
          tone: 'err',
          titleHtml: 'Don&rsquo;t recognize this?',
          bodyHtml:
            'Secure your account right away — you can sign out all devices and reset your password from your security settings.',
        }),
      ),
      section(
        '0 36px 30px',
        ctaRow({
          primary: { label: def.cta, href: escapeHtml(params.securityUrl) },
          secondary: { label: def.cta2!, href: escapeHtml(params.resetUrl) },
        }),
      ),
      footer({
        kind: 'ess',
        reasonHtml: `Sent to <span class="ink2" style="color:${L.ink2};text-decoration:underline">${email}</span> whenever a new device signs in — a core account-safety notice.`,
        urls,
      }),
    ].join('\n    '),
  });
  assertEmailWeight(html);

  const text = [
    'New sign-in to your StockPilot account.',
    '',
    `${params.email} was just signed in from a device we haven’t seen before. If this was you, there’s nothing to do.`,
    '',
    `Device:      ${params.device}`,
    `IP address:  ${params.ip && params.ip !== 'unknown' ? params.ip : 'Unknown'}`,
    `Date & time: ${params.when}`,
    '',
    `Don’t recognize this? Secure your account right away — sign out all devices and reset your password: ${params.securityUrl}`,
    `Reset password: ${params.resetUrl}`,
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

import 'server-only';

import {
  securityBotReason,
  type SecurityBotFamily,
  type SecurityEventSource,
} from '@stockpilot/core';

import { recordSecurityEvent } from './events';

/**
 * WHICH LIMITER REFUSALS ARE SECURITY EVENTS: the one map.
 *
 * checkRateLimit (lib/rate-limit.ts) calls recordLimiterRefusal when a limiter
 * REFUSES a request (`allowed` false, and not `failed`: a limiter that could
 * not count is not an attack). The key's prefix (its literal part, before the
 * first value filled in) decides:
 *   - an ANONYMOUS public endpoint family (LIMITER_BOT_PREFIXES): recorded as
 *     bots / blocked / `<family>_paused`, with the source the endpoint serves;
 *   - everything else (LIMITER_NOT_SECURITY_EVENTS), with why: a signed-in
 *     member's own limit (a fast worker is not an attack), an alert's own
 *     pacing, or a check whose call site records the event itself (sign-in,
 *     authenticator and recovery codes), so nothing is counted twice.
 * The longest listed prefix the key starts with answers. A key whose prefix
 * is in neither list is not recorded, and limiter-events.guard.test.ts fails
 * on every checkRateLimit call site in src whose prefix is in neither, so a
 * new limiter is decided here when it is added.
 *
 * Bots events carry no organization: these endpoints answer before anyone is
 * known.
 */

interface BotPrefix {
  family: SecurityBotFamily;
  source: SecurityEventSource;
}

/** Anonymous public endpoints, by key prefix. */
export const LIMITER_BOT_PREFIXES: Readonly<Record<string, BotPrefix>> = {
  // The public order request form and its read-back by link (/r/...).
  'public-order-request:': { family: 'public_order', source: 'web' },
  'public-order-request:email:': { family: 'public_order', source: 'web' },
  'public-order-request:token:': { family: 'public_order', source: 'web' },
  'public-order-request:fanout:': { family: 'public_order', source: 'web' },
  'public-order-request:fanout-distinct:': { family: 'public_order', source: 'web' },
  'public-order-read:ip:': { family: 'public_order', source: 'web' },
  'public-order-read:token:': { family: 'public_order', source: 'web' },
  'public-order-location:ip:': { family: 'public_order', source: 'web' },
  // The public return request form and its page.
  'public-return-request:': { family: 'public_return', source: 'web' },
  'public-return-request:token:': { family: 'public_return', source: 'web' },
  'public-return-page:': { family: 'public_return', source: 'web' },
  'public-return-options:ip:': { family: 'public_return', source: 'web' },
  'public-return-options:token:': { family: 'public_return', source: 'web' },
  // The public catalog's photos.
  'public-catalog-thumbnails:ip:': { family: 'public_catalog', source: 'web' },
  // Links that open one record with no account: maintenance share, order signature.
  'maintenance:share:token:': { family: 'share_link', source: 'web' },
  'maintenance:share:ip:': { family: 'share_link', source: 'web' },
  'order-sign:': { family: 'share_link', source: 'web' },
  // Unsubscribe links from email.
  'unsubscribe:link:': { family: 'unsubscribe', source: 'web' },
  'unsubscribe:ip:': { family: 'unsubscribe', source: 'web' },
  // The "This was not me" link in a sign-in alert email (part 3): opening its
  // page by address, pressing its button by address and, once its signature
  // checks out, by alert.
  'sign-in-alert:view:': { family: 'sign_in_alert', source: 'web' },
  'sign-in-alert:ip:': { family: 'sign_in_alert', source: 'web' },
  'sign-in-alert:alert:': { family: 'sign_in_alert', source: 'web' },
  // The public support form.
  'support:ip:': { family: 'support', source: 'web' },
  'support:email:': { family: 'support', source: 'web' },
  // Password reset: the web form and its link, and the mobile app's request.
  // pwreset-req is shared with an admin's reset for a member (actions/team.ts);
  // a refusal there is counted here too.
  'pwreset-req:': { family: 'password_reset', source: 'web' },
  'pwreset-complete:': { family: 'password_reset', source: 'web' },
  'pwreset-ip:': { family: 'password_reset', source: 'phone' },
  // The public API by address, before a key is looked up.
  'public-api-ip:': { family: 'public_api', source: 'api' },
  // A shipping provider's webhook, by address, before its signature is checked.
  'easypost-webhook:': { family: 'webhook', source: 'api' },
  // The public ISBN lookup, by address.
  'books-lookup:': { family: 'isbn_lookup', source: 'web' },
};

const RECORDED_AT_CALL_SITE =
  'Recorded at its call site (server/security/account-events.ts), so it is not counted twice.';
const RECOVERY_RECORDED_AT_CALL_SITE =
  "A signed-in account's recovery-code buckets: the call site records a refused press itself (recovery_code_checks_paused), and a refused code (wrong_recovery_code).";
const SIGNED_IN = "A signed-in member's own limit: a fast worker is not an attack.";
const ORGANIZATION_CAP = "An organization's own daily cap, reached by its signed-in members.";
const ALERT_PACING = 'Paces an alert this server sends, not a request anyone made.';
const PLATFORM_ADMIN = "A platform admin's own limit.";
const API_KEY = "A working API key's own per-key limit: the organization's own integration.";

/** Every other key prefix, with why its refusals are not security events. */
export const LIMITER_NOT_SECURITY_EVENTS: Readonly<Record<string, string>> = {
  // Their call sites record the event themselves.
  'signin:': RECORDED_AT_CALL_SITE,
  'signin-ip:': RECORDED_AT_CALL_SITE,
  'mfa-code:': RECORDED_AT_CALL_SITE,
  'mfa-code-account:': RECORDED_AT_CALL_SITE,
  'mfa-recovery:': RECOVERY_RECORDED_AT_CALL_SITE,
  'mfa-recovery-password:': RECOVERY_RECORDED_AT_CALL_SITE,
  'mfa-recovery-code:': RECOVERY_RECORDED_AT_CALL_SITE,
  // The passkey actions (server/security/passkeys.ts) record a refusal of
  // their own limits as passkey_checks_paused at the call site.
  'passkey-start:': RECORDED_AT_CALL_SITE,
  'passkey-start-account:': RECORDED_AT_CALL_SITE,
  'passkey-finish:': RECORDED_AT_CALL_SITE,
  'passkey-register:': RECORDED_AT_CALL_SITE,
  'passkey-remove:': RECORDED_AT_CALL_SITE,
  // A signed-in account's own security actions.
  'mfa-recovery-gen:': SIGNED_IN,
  'mfa-enroll-verify:': SIGNED_IN,
  'mfa-factor-refused-report:': SIGNED_IN,
  // The step-up modal's list of the account's authenticator apps (passkey
  // bridge left out): the account at one address, then the account.
  'mfa-step-up-methods:': SIGNED_IN,
  'mfa-step-up-methods-account:': SIGNED_IN,
  'pwchange:': SIGNED_IN,
  'emailchange:': SIGNED_IN,
  'emailchange-target:': SIGNED_IN,
  'emailchange-resend:': SIGNED_IN,
  'owner-transfer:': SIGNED_IN,
  'account-delete:': SIGNED_IN,
  'account-delete-password:': SIGNED_IN,
  'account-delete-code-send:': SIGNED_IN,
  'account-delete-code-check:': SIGNED_IN,
  'auth-note:in:': SIGNED_IN,
  'auth-note:out:': SIGNED_IN,
  'auth-note:user:': SIGNED_IN,
  'sign-in-alert-report:user:': SIGNED_IN,
  // Alerts this server sends.
  'new-device-alert:user:': ALERT_PACING,
  'new-device-alert-held:user:': ALERT_PACING,
  'sign-in-alert-rows:user:': ALERT_PACING,
  'sign-in-alert-rows-held:user:': ALERT_PACING,
  'new-device-event:user:': ALERT_PACING,
  'new-device-event:org:': ALERT_PACING,
  'new-device-event-held:org:': ALERT_PACING,
  'export-alert:': ALERT_PACING,
  // The hourly passkey check's email of a sign-in it ended (one a day per
  // account; server/security/passkey-detector.ts).
  'passkey-detector-email:': ALERT_PACING,
  // The same check's word that the platform settings row is missing (read as
  // off): once a day for everyone (`...:all`).
  'passkey-detector-settings-report:': ALERT_PACING,
  // Reports about the passkey records (lib/auth/passkey-bridge.ts): a
  // reserved-name factor that is not the account's bridge, and the records
  // missing while such a factor is listed: the missing table once an hour
  // for everyone (`...:table`), the missing function once an hour per account.
  'passkeys-not-ours-report:': ALERT_PACING,
  // A fail-closed state or a secret the keys do not open, met by the
  // second-step page or a start (server/security/passkeys.ts): once an hour
  // per account and fault. The key-fault roll-up (a missing key, a secret
  // that does not open) once an hour for everyone, per fault.
  'passkeys-step-report:': ALERT_PACING,
  'passkeys-key-report:': ALERT_PACING,
  'passkeys-records-missing-report:': ALERT_PACING,
  'passkeys-records-missing-report:function:': ALERT_PACING,
  // The platform console.
  'org-delete:': PLATFORM_ADMIN,
  'org-passphrase-rotate:': PLATFORM_ADMIN,
  // A working API key.
  'api-key:': API_KEY,
  // Organization-wide caps.
  'ai-chat-org:': ORGANIZATION_CAP,
  'size-count-scan-org:': ORGANIZATION_CAP,
  'exceptions-check-now:org:': ORGANIZATION_CAP,
  // Signed-in members' own work.
  'ai-chat:': SIGNED_IN,
  'ai-identify-photo:': SIGNED_IN,
  'ai-isbn-extract:': SIGNED_IN,
  'ai-lookup-isbn:': SIGNED_IN,
  'ai-po-scan:': SIGNED_IN,
  'ai-shelf-scan:': SIGNED_IN,
  'ai-vision:': SIGNED_IN,
  'catalog-thumbnails:user:': SIGNED_IN,
  'client-error:': SIGNED_IN,
  'customer-status:': SIGNED_IN,
  'cycle-count-post:': SIGNED_IN,
  'cycle-count-reassign:': SIGNED_IN,
  'cycle-count-record:': SIGNED_IN,
  'cycle-count-release:': SIGNED_IN,
  'dashboard-value-series:': SIGNED_IN,
  'exceptions-act:': SIGNED_IN,
  'exceptions-check-now:': SIGNED_IN,
  'exceptions-escalate:': SIGNED_IN,
  'exceptions-recount:': SIGNED_IN,
  'exceptions:evidence:finalize:': SIGNED_IN,
  'exceptions:evidence:upload:': SIGNED_IN,
  'export-preview:': SIGNED_IN,
  'export:': SIGNED_IN,
  'inventory-staging:': SIGNED_IN,
  'isbn-lookup:user:': SIGNED_IN,
  'item-grouping-preview:': SIGNED_IN,
  'item-grouping:': SIGNED_IN,
  'item-history:': SIGNED_IN,
  'item-serials-add:': SIGNED_IN,
  'items-create:': SIGNED_IN,
  'items-restore:': SIGNED_IN,
  'items-sized-create:': SIGNED_IN,
  'maintenance:create:': SIGNED_IN,
  'maintenance:finalize-upload:': SIGNED_IN,
  'maintenance:finalize:': SIGNED_IN,
  'maintenance:upload:': SIGNED_IN,
  'member-category-access:': SIGNED_IN,
  'member-role:': SIGNED_IN,
  'mobile-snapshot:user:': SIGNED_IN,
  'movement-note:': SIGNED_IN,
  'order-add-lines:': SIGNED_IN,
  'order-catalog-manage:': SIGNED_IN,
  'order-catalog-visibility:': SIGNED_IN,
  'order-create:': SIGNED_IN,
  'order-edit-lines:': SIGNED_IN,
  'order-needed-by:': SIGNED_IN,
  'order-photos:': SIGNED_IN,
  'order-pick-line:': SIGNED_IN,
  'order-shortfall-po:': SIGNED_IN,
  'order-sign:member:': SIGNED_IN,
  'order-storefront:': SIGNED_IN,
  'order-submission:': SIGNED_IN,
  'order-transition:': SIGNED_IN,
  'orders:returns:': SIGNED_IN,
  'po-imports:write:': SIGNED_IN,
  'portal-return-read:user:': SIGNED_IN,
  'portal-return:user:': SIGNED_IN,
  'return-request-': SIGNED_IN,
  'return-request-drafted:': SIGNED_IN,
  'returns-': SIGNED_IN,
  'schedule-create:': SIGNED_IN,
  'search:': SIGNED_IN,
  'serial-change:': SIGNED_IN,
  'shipping-rates:user:': SIGNED_IN,
  'size-count-complete:': SIGNED_IN,
  'size-count-create:': SIGNED_IN,
  'size-count-events:': SIGNED_IN,
  'size-count-scan:': SIGNED_IN,
  'size-count-training:': SIGNED_IN,
  'stock-adjust:': SIGNED_IN,
  'stock-remove:': SIGNED_IN,
  'stock-transfer:': SIGNED_IN,
  'support:user:': SIGNED_IN,
  'upc-lookup:user:': SIGNED_IN,
  'v1-bundles-list:': SIGNED_IN,
  'v1-group-linking-suggest:': SIGNED_IN,
  'v1-group-linking-write:': SIGNED_IN,
  'v1-product-groups-list:': SIGNED_IN,
  'v1-product-groups-variants:': SIGNED_IN,
};

/** Every listed prefix, longest first, so the most specific one answers. */
const PREFIXES_LONGEST_FIRST = [
  ...Object.keys(LIMITER_BOT_PREFIXES),
  ...Object.keys(LIMITER_NOT_SECURITY_EVENTS),
].sort((a, b) => b.length - a.length);

/**
 * The security event a refusal of `key` stands for, or null when it is not
 * one (a prefix on the "not" list, or on neither).
 */
export function limiterSecurityEvent(
  key: string,
): { category: 'bots'; reason: string; source: SecurityEventSource } | null {
  if (typeof key !== 'string') return null;
  const prefix = PREFIXES_LONGEST_FIRST.find((p) => key.startsWith(p));
  if (prefix === undefined) return null;
  const bot = Object.prototype.hasOwnProperty.call(LIMITER_BOT_PREFIXES, prefix)
    ? LIMITER_BOT_PREFIXES[prefix]
    : undefined;
  if (!bot) return null;
  return { category: 'bots', reason: securityBotReason(bot.family), source: bot.source };
}

/**
 * Records a limiter's refusal of `key` when it is a security event. Never
 * throws and never waits on the database (recordSecurityEvent). The place and
 * the hash come from the request being refused (`next/headers`).
 */
export async function recordLimiterRefusal(key: string): Promise<void> {
  const event = limiterSecurityEvent(key);
  if (!event) return;
  await recordSecurityEvent({ ...event, outcome: 'blocked' });
}

import 'server-only';

import { env } from '@/lib/env';

import {
  checkSignInAlertLink,
  issuedDayOf,
  signSignInAlertLink,
  type SignInAlertLinkVerdict,
} from './sign-in-alert-link';

/**
 * The deployment's own "This was not me" link (lib/auth/sign-in-alert-link.ts
 * holds the format and the checks). The key is derived from
 * SUPABASE_SERVICE_ROLE_KEY (env.ts trims it), which every alert writer
 * already has. With no key no link is written, and the alert email goes
 * without its button: the alert itself is never held back for it.
 */

/** The page the link opens: outside the login wall (proxy.ts does not match it). */
export const SIGN_IN_ALERT_PATH = '/sign-in-alert';

/** The link for one alert of one account, or null when it cannot be signed. */
export function signInAlertLinkUrl(args: {
  alertId: string;
  userId: string;
  now?: Date;
}): string | null {
  const issuedDay = issuedDayOf(args.now ?? new Date());
  const tag = signSignInAlertLink(env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    alertId: args.alertId,
    userId: args.userId,
    issuedDay,
  });
  if (!tag) return null;
  const base = (env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
  const alertId = args.alertId.toLowerCase();
  return `${base}${SIGN_IN_ALERT_PATH}?a=${alertId}&i=${issuedDay}&t=${tag}`;
}

/** Checks a link with this deployment's key, against the alert's own account. Never throws. */
export function verifySignInAlertLink(args: {
  alertId: string;
  userId: string;
  issuedDay: string;
  tag: string;
  now?: Date;
}): SignInAlertLinkVerdict {
  return checkSignInAlertLink(env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    alertId: args.alertId,
    userId: args.userId,
    issuedDay: args.issuedDay,
    tag: args.tag,
    now: args.now ?? new Date(),
  });
}

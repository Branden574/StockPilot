import 'server-only';

import { headers } from 'next/headers';

import { parseUserAgent } from '@/lib/auth/user-agent';
import {
  renderPasskeyAddedEmail,
  renderPasskeyRemovedEmail,
  renderPasskeySignInEndedEmail,
} from '@/lib/email/es/families/security';
import { sendEmail } from '@/lib/email/resend';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { defer } from '@/server/services/lib/defer';

/**
 * The passkey emails of stage 4 (plan 2.8; the third, a sign-in ended by the
 * hourly check, from integrator decision C): sent after the response,
 * never blocking it, and never printing the member's name for the passkey
 * (review 1 F5). The device is the kind our server read from the request
 * (lib/auth/user-agent: a fixed set of words, never the agent's own text).
 * A send that fails is reported with its id only.
 */

const whenNow = () =>
  `${new Date().toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC`;

async function deviceOfThisRequest(): Promise<string> {
  try {
    return parseUserAgent((await headers()).get('user-agent')).label;
  } catch {
    return 'Unknown device';
  }
}

function send(message: { subject: string; html: string; text: string; from: string }, to: string, id: string) {
  defer(async () => {
    const sent = await sendEmail({ to, subject: message.subject, html: message.html, text: message.text, from: message.from });
    if (!sent.ok) {
      await reportError(new Error('Passkey email not sent'), { tag: 'passkeys.email_failed', level: 'warning', extra: { id } });
    }
  });
}

/** "A passkey was added to your StockPilot account", after the response. */
export async function sendPasskeyAddedEmail(to: string): Promise<void> {
  const addedAt = whenNow();
  const device = await deviceOfThisRequest();
  const message = renderPasskeyAddedEmail({ email: to, addedAt, device, appUrl: env.NEXT_PUBLIC_APP_URL });
  send(message, to, 'passkey-added');
}

/** "A passkey was removed from your StockPilot account", after the response. */
export function sendPasskeyRemovedEmail(to: string): void {
  const message = renderPasskeyRemovedEmail({ email: to, removedAt: whenNow(), appUrl: env.NEXT_PUBLIC_APP_URL });
  send(message, to, 'passkey-removed');
}

/** "We ended a sign-in to your StockPilot account" (the hourly check; at most one a day per account, paced by its caller). */
export function sendPasskeySignInEndedEmail(to: string): void {
  const message = renderPasskeySignInEndedEmail({ email: to, endedAt: whenNow(), appUrl: env.NEXT_PUBLIC_APP_URL });
  send(message, to, 'passkey-sign-in-ended');
}

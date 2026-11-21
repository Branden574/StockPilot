import 'server-only';

import { accountIdHash } from '@/lib/auth/passkey-bridge';
import { renderRecoveryCodeUsedEmail } from '@/lib/email/es/families/security';
import { sendEmail } from '@/lib/email/resend';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { defer } from '@/server/services/lib/defer';

/**
 * "Your StockPilot sign-in methods were removed" (answers Q6 and Q7 of the
 * passkey plan): the security email of a used recovery code, sent to the
 * account's address after the response, never blocking it. The words are the
 * true ones for this account (lib/email/es/families/security.ts
 * renderRecoveryCodeUsedEmail). A send that fails is reported with a hash of
 * the account id, never the address.
 */

const whenNow = () =>
  `${new Date().toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC`;

export function sendRecoveryCodeUsedEmail(
  to: string,
  userId: string,
  facts: { passkeys: boolean; othersSignedOut: boolean },
): void {
  const message = renderRecoveryCodeUsedEmail({
    email: to,
    usedAt: whenNow(),
    passkeys: facts.passkeys,
    othersSignedOut: facts.othersSignedOut,
    appUrl: env.NEXT_PUBLIC_APP_URL,
  });
  defer(async () => {
    const sent = await sendEmail({
      to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      from: message.from,
    });
    if (!sent.ok) {
      await reportError(new Error('Recovery code email not sent'), {
        tag: 'actions.mfa_recovery.email_failed',
        level: 'warning',
        userIdHash: accountIdHash(userId),
      });
    }
  });
}

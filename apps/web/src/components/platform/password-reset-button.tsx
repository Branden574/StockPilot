'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { sendUserPasswordResetAction } from '@/server/actions/platform/users';

/**
 * Per-user "Send password reset" button (Users tab). Confirms first, then
 * triggers a recovery email to that user. The admin never sees a password.
 */
export function PasswordResetButton({
  userId,
  email,
}: {
  userId: string;
  email: string | null;
}) {
  const [pending, start] = React.useTransition();

  function onClick() {
    if (!window.confirm(`Email a password-reset link to ${email ?? 'this user'}?`)) return;
    start(async () => {
      const res = await sendUserPasswordResetAction({ targetUserId: userId });
      if (res.ok) toast.success(`Reset email sent to ${email ?? 'the user'}.`);
      else toast.error(res.error.message);
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="rounded-md border border-border px-2 py-1 text-[11.5px] font-medium hover:border-[var(--ed-line-strong)] disabled:opacity-50"
    >
      {pending ? 'Sending…' : 'Send password reset'}
    </button>
  );
}

import type { AuthNoticeCopy } from '@/lib/auth/auth-page-notices';
import { cn } from '@/lib/utils';

const TONE = {
  info: 'bg-sunk text-ink-2',
  danger: 'bg-destructive-wash text-destructive',
} as const satisfies Record<AuthNoticeCopy['tone'], string>;

/**
 * The line at the top of an auth card that says why the person is on this
 * page (lib/auth/auth-page-notices.ts holds the words). The auth card's
 * notice recipe from the redesign (P5.1): a 13 px line on a tinted wash,
 * radius 6, no border, no icon. `info` is a polite status (the session-ended
 * note); `danger`, something that did not work, is an alert, in the wash the
 * app uses for a failed state.
 *
 * No directive: the /reset page renders it on the server and the sign-in form
 * in the browser.
 */
export function AuthNotice({ notice }: { notice: AuthNoticeCopy }) {
  return (
    <p
      data-slot="auth-notice"
      data-tone={notice.tone}
      role={notice.tone === 'danger' ? 'alert' : 'status'}
      className={cn('rounded-md px-3 py-2 text-[13px] leading-[19.5px]', TONE[notice.tone])}
    >
      {notice.text}
    </p>
  );
}

import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';

/**
 * Persistent banner shown above every dashboard page when the org's MFA
 * policy requires the current user to enroll a factor and they haven't
 * yet. We use a banner instead of a hard redirect because the redirect
 * approach was triggering Chrome's "Throttling navigation to prevent the
 * browser from hanging" warning (rendered as a black/blank screen) on
 * sections that prefetch + then navigate.
 *
 * A caution strip in the redesign's language: the warning wash with a hairline,
 * the icon in the warning tone beside the words (never colour alone), and the
 * one action as a small ink button (44px tall wherever a finger is the pointer).
 */
export function MfaRequiredBanner() {
  return (
    <div
      role="status"
      className="border-warning/30 bg-warning-wash text-foreground flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5 text-[13.5px] sm:px-8"
    >
      <ShieldAlert className="text-warning size-4 shrink-0" strokeWidth={1.8} aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium">Two-factor authentication is required.</span>{' '}
        <span className="text-[var(--ed-ink-2)]">
          Set up your authenticator to fully secure your account.
        </span>
      </p>
      <Link
        href="/dashboard/settings/security?enroll=1"
        className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-[12.5px] font-medium transition-colors sm:min-h-7 sm:px-2.5 [@media(pointer:coarse)]:min-h-11"
      >
        Enroll now
      </Link>
    </div>
  );
}

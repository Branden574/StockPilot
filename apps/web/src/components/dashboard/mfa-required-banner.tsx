import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';

/**
 * Persistent banner shown above every dashboard page when the org's MFA
 * policy requires the current user to enroll a factor and they haven't
 * yet. We use a banner instead of a hard redirect because the redirect
 * approach was triggering Chrome's "Throttling navigation to prevent the
 * browser from hanging" warning (rendered as a black/blank screen) on
 * sections that prefetch + then navigate.
 */
export function MfaRequiredBanner() {
  return (
    <div
      role="status"
      className="border-warning/40 bg-warning/10 text-foreground flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm sm:px-6"
    >
      <ShieldAlert className="text-warning h-4 w-4 shrink-0" />
      <p className="flex-1">
        <span className="font-medium">Two-factor authentication is required.</span>{' '}
        <span className="text-muted-foreground">
          Set up your authenticator to fully secure your account.
        </span>
      </p>
      <Link
        href="/dashboard/settings/security?enroll=1"
        className="bg-foreground text-background hover:bg-foreground/90 inline-flex items-center rounded-md px-3 py-1 text-xs font-medium"
      >
        Enroll now
      </Link>
    </div>
  );
}

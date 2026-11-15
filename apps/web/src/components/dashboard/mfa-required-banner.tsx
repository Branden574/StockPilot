'use client';

import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';

import { AUTHENTICATOR_SET_UP_URL } from '@/lib/auth/authenticator-set-up';
import { useWarmRoute } from '@/lib/hooks/use-warm-route';

/** Where the banner sends someone to enroll: where requireOrgContext() sends them too. */
const ENROLL_PAGE = AUTHENTICATOR_SET_UP_URL;

/**
 * The banner above the page when the org's MFA policy requires the current
 * user to set up an authenticator and they have none verified. Such a member
 * is sent to the security settings page from every other dashboard page
 * (requireOrgContext() and the dashboard layout), so this shows on the pages
 * open to them before set-up: the security page and the profile page
 * (lib/auth/authenticator-set-up).
 *
 * A caution strip in the redesign's language: the warning wash with a hairline,
 * the icon in the warning tone beside the words (never colour alone), and the
 * one action as a small ink button (44px tall wherever a finger is the pointer).
 *
 * The button never prefetches its page on sight (PLAN 0.6): the banner is on
 * each of those page views until the person enrolls, and a default <Link> fetched the
 * security page on each one (two requests, a full dynamic render). It warms
 * that page when the person comes to it, as the top bar's links do.
 */
export function MfaRequiredBanner() {
  const warmRoute = useWarmRoute();
  const warm = () => warmRoute(ENROLL_PAGE);
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
        href={ENROLL_PAGE}
        prefetch={false}
        onFocus={warm}
        onPointerEnter={warm}
        onPointerDown={warm}
        className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-[12.5px] font-medium transition-colors sm:min-h-7 sm:px-2.5 [@media(pointer:coarse)]:min-h-11"
      >
        Enroll now
      </Link>
    </div>
  );
}

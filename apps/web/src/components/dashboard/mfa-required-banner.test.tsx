import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ prefetch: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/inventory',
  useRouter: () => ({ prefetch: nav.prefetch }),
}));
// A plain anchor that records the prefetch it was given (data-prefetch).
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    prefetch?: boolean | null;
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

import { MfaRequiredBanner } from './mfa-required-banner';

const ENROLL = '/dashboard/settings/security?enroll=1';

/** A spy's calls with every non-string reduced to its type, safe to print. */
const callsOf = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((args) => args.map((a) => (typeof a === 'string' ? a : `<${typeof a}>`)));

beforeEach(() => nav.prefetch.mockReset());

/**
 * The MFA banner sits above every dashboard page until the person enrolls
 * (W-SH-06a). Its words and its one action are unchanged.
 */
describe('MfaRequiredBanner', () => {
  it('says MFA is required, and offers enrolment', () => {
    render(<MfaRequiredBanner />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Two-factor authentication is required. Set up your authenticator to fully secure your account.',
    );
    expect(screen.getByRole('link', { name: 'Enroll now' })).toHaveAttribute('href', ENROLL);
  });

  // PLAN 0.6, no eager prefetch: a default <Link> prefetched the security page
  // on every page view while the banner showed. Mutation caught: prefetch
  // dropped back to the default.
  it('never prefetches the security page on sight', () => {
    render(<MfaRequiredBanner />);
    expect(screen.getByRole('link', { name: 'Enroll now' })).toHaveAttribute(
      'data-prefetch',
      'false',
    );
    expect(callsOf(nav.prefetch)).toEqual([]);
  });

  // Mutation caught: the link left with no warm-up (the click then waits for
  // the whole page), or a handler that hands the warm-up the event.
  it.each([
    ['hover', (el: Element) => fireEvent.pointerEnter(el)],
    ['keyboard focus', (el: Element) => fireEvent.focus(el)],
    ['pointer-down', (el: Element) => fireEvent.pointerDown(el)],
  ])('%s on Enroll now warms the security page', (_label, approach) => {
    render(<MfaRequiredBanner />);
    approach(screen.getByRole('link', { name: 'Enroll now' }));
    expect(callsOf(nav.prefetch)).toEqual([[ENROLL]]);
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: nav.refresh }) }));

import { knownErrorState, ACCESS_UNCHECKED_DIGEST } from '@/lib/known-error-states';

import { AccessUncheckedBanner } from './access-unchecked-banner';

beforeEach(() => nav.refresh.mockReset());
afterEach(() => vi.restoreAllMocks());

/**
 * The strip the dashboard layout shows when the organization's authenticator
 * policy could not be read and the member has no verified authenticator: it
 * says their access could not be checked, in the words of the pages' own
 * card, and never tells them to set up an authenticator. Its one action loads
 * the whole page again.
 */
describe('AccessUncheckedBanner', () => {
  it("says the access could not be checked, in the card's words, and never asks for set-up", () => {
    render(<AccessUncheckedBanner />);
    const strip = screen.getByRole('status');
    const card = knownErrorState({ digest: ACCESS_UNCHECKED_DIGEST })!;
    expect(card.body).toBe("We couldn't check your access just now. This is usually temporary.");
    expect(strip.textContent).toContain("We couldn't check your access just now.");
    expect(strip.textContent).toContain('This is usually temporary.');
    expect(strip.textContent).toContain('Some pages may be unavailable.');
    expect(strip.textContent).not.toMatch(
      /authenticator|two-factor|MFA|enroll|set up|requires|required/i,
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('Try again loads the whole page again', () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    render(<AccessUncheckedBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});

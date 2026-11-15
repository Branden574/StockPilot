import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { AUTHENTICATOR_SET_UP_URL } from '@/lib/auth/authenticator-set-up';

import { AuthenticatorSetUpPanel } from './authenticator-set-up-panel';

/**
 * The set-up panel's button loads the security page as a new document: a plain
 * anchor with the set-up address and no client-side handler, so the dashboard
 * layout is rendered again for the security page instead of keeping the panel.
 */

type El = ReactElement<Record<string, unknown>>;

describe('AuthenticatorSetUpPanel', () => {
  it('its button is a plain anchor to the set-up address, with no client-side handler', () => {
    const frame = AuthenticatorSetUpPanel() as El;
    const panel = frame.props.children as El;
    const action = panel.props.action as El;
    expect(action.type).toBe('a');
    expect(action.props.href).toBe(AUTHENTICATOR_SET_UP_URL);
    expect(Object.keys(action.props).filter((k) => /^on[A-Z]/.test(k))).toEqual([]);
    expect(action.props).not.toHaveProperty('prefetch');
  });

  it('renders that anchor as the page link to Security settings', () => {
    render(<AuthenticatorSetUpPanel />);
    const link = screen.getByRole('link', { name: 'Go to Security settings' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', AUTHENTICATOR_SET_UP_URL);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Set up an authenticator to continue',
    );
  });
});

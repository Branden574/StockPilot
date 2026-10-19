import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * /portal for a visitor who is not a portal customer (P5.1): the prompt on
 * the shared external frame, with its own words and its one way in. The
 * signed-in catalog is drawn by PortalShop (P5.1 step B).
 */

vi.mock('@/server/services/portal', () => ({
  resolvePortalContext: async () => null,
  portalCatalog: vi.fn(),
  portalOrders: vi.fn(),
  portalReturnsEnabled: vi.fn(),
}));
vi.mock('@/lib/returns/exchange-switch', () => ({ exchangeCreateEnabled: () => true }));
vi.mock('@/components/portal/portal-shop', () => ({ PortalShop: () => null }));

import PortalPage from './page';

describe('/portal, not a portal customer', () => {
  it('says how to get in, with Sign in coming back to the portal', async () => {
    render(await PortalPage());
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Supplier ordering portal' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Sign in with the email address your supplier invited, and this page becomes your catalog. If you believe you should have access, contact your supplier for an invite.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/signin?redirect=%2Fportal',
    );
  });
});

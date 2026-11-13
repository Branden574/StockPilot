import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /portal for a visitor who is not a portal customer (P5.1): the prompt on
 * the shared external frame, with its own words and its one way in. The
 * signed-in catalog is drawn by PortalShop (P5.1 step B) on the same frame,
 * under the supplier's brand.
 */

const portal = vi.hoisted(() => ({
  ctx: null as Record<string, unknown> | null,
  catalog: [] as unknown[],
  orders: [] as unknown[],
  returnsEnabled: false,
}));
vi.mock('@/server/services/portal', () => ({
  resolvePortalContext: async () => portal.ctx,
  portalCatalog: vi.fn(async () => portal.catalog),
  portalOrders: vi.fn(async () => portal.orders),
  portalReturnsEnabled: vi.fn(async () => portal.returnsEnabled),
}));
vi.mock('@/lib/returns/exchange-switch', () => ({ exchangeCreateEnabled: () => true }));
const shopProps = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
vi.mock('@/components/portal/portal-shop', () => ({
  PortalShop: (props: Record<string, unknown>) => {
    shopProps.value = props;
    return null;
  },
}));

const accountSync = vi.hoisted(() => ({ userIds: [] as string[] }));
vi.mock('@/components/theme/appearance-provider', () => ({
  AppearanceAccountSync: ({ userId }: { userId: string }) => {
    accountSync.userIds.push(userId);
    return null;
  },
}));

import PortalPage from './page';

beforeEach(() => {
  portal.ctx = null;
  portal.catalog = [];
  portal.orders = [];
  portal.returnsEnabled = false;
  shopProps.value = null;
  accountSync.userIds = [];
});

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
    expect(shopProps.value).toBeNull();
  });
});

describe('/portal, a portal customer (P5.1 step B)', () => {
  it("shows the supplier's brand and the customer on the external frame, and hands the shop what it read", async () => {
    portal.ctx = {
      orgName: 'Redesign Lab Co',
      orgLogoUrl: 'https://lab.supabase.test/storage/v1/object/public/org-logos/o/logo.png',
      customerName: 'Westfield Academy',
      pricingMode: 'priced',
    };
    portal.catalog = [{ itemId: 'i-1' }];
    portal.orders = [{ id: 'o-1' }];
    portal.returnsEnabled = true;
    const { container } = render(await PortalPage());

    // One main landmark (the frame's column), one page heading.
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Redesign Lab Co' })).toBeInTheDocument();
    expect(screen.getByText('Ordering portal · Westfield Academy')).toBeInTheDocument();
    // The logo is decoration beside the name it repeats.
    const logo = container.querySelector('img');
    expect(logo).toHaveAttribute('alt', '');
    expect(logo).toHaveAttribute(
      'src',
      'https://lab.supabase.test/storage/v1/object/public/org-logos/o/logo.png',
    );
    // No app navigation was ever on this page (CONFLICTS E1).
    expect(screen.queryByRole('navigation')).toBeNull();

    expect(shopProps.value).toEqual({
      catalog: [{ itemId: 'i-1' }],
      orders: [{ id: 'o-1' }],
      returnsEnabled: true,
      exchangesEnabled: true,
      pricingMode: 'priced',
    });
  });

  it('draws no image when the supplier has no logo', async () => {
    portal.ctx = {
      orgName: 'Redesign Lab Co',
      orgLogoUrl: null,
      customerName: 'Westfield Academy',
      pricingMode: 'no_charge',
    };
    const { container } = render(await PortalPage());
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Redesign Lab Co' })).toBeInTheDocument();
  });
});

describe('/portal and the appearance (plans/REVISION-DEFAULT.md R13, item 23)', () => {
  it('names the signed-in customer to the appearance layer from the context it already read', async () => {
    portal.ctx = {
      userId: '22222222-2222-4222-8222-222222222222',
      orgName: 'Redesign Lab Co',
      orgLogoUrl: null,
      customerName: 'Westfield Academy',
      pricingMode: 'priced',
    };
    render(await PortalPage());
    expect(accountSync.userIds).toEqual(['22222222-2222-4222-8222-222222222222']);
  });

  it('names nobody to it on the sign-in prompt: the choice stays on the device', async () => {
    render(await PortalPage());
    expect(accountSync.userIds).toEqual([]);
  });
});

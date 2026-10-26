import { render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /r/<token>, the public order page (redesign P5.1 step B): what the server
 * page draws around the storefront, in its own words, and what it hands the
 * storefront. A closed link is the external pages' status card under the
 * brand row; an open link hands the storefront the eligible warehouses as
 * {id, name}, the active delivery sites as {id, name, code} and the
 * service's compact catalog, and nothing else.
 *
 * B32 (integrator decision 3): the catalog is read from the data cache by
 * the link id and the warehouse id only, and the warehouse is one the page
 * read as the link organization's publicly orderable warehouses, so no query
 * parameter can make a new cache entry. Past the public ceiling the catalog
 * is cut, and the page says so.
 */

const SUPABASE = 'https://lab.supabase.test';

const svc = vi.hoisted(() => ({
  resolvePublicRequestToken: vi.fn(),
  isLinkOpen: vi.fn(),
  getPublicCatalogForLink: vi.fn(),
}));
vi.mock('@/server/services/public-catalog', () => svc);

vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: 'https://lab.supabase.test' } }));

/** The admin client's two reads: eligible warehouses and their delivery sites. */
const db = vi.hoisted(() => ({
  warehouses: [] as Array<Record<string, unknown>>,
  charterPairs: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      db.calls.push(table);
      const rows = table === 'warehouses' ? db.warehouses : db.charterPairs;
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        then: (resolve: (v: { data: unknown }) => unknown) => resolve({ data: rows }),
      };
      return chain;
    },
  }),
}));

class NotFound extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFound('NEXT_NOT_FOUND');
  },
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element -- a test double for next/image
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

const captured = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('@/components/orders/public-v2/public-catalog-storefront', () => ({
  PublicCatalogStorefront: (props: Record<string, unknown>) => {
    captured.props = props;
    return <div data-testid="storefront" />;
  },
}));

import PublicOrderRequestPage from './page';

const TOKEN = 'tok_'.padEnd(32, 'x');

const ORG = {
  id: 'org-1',
  name: 'Lincoln Unified',
  logo_url: null as string | null,
  public_request_blurb: 'Order what your class needs.',
};
const LINK = {
  id: 'link-1',
  organizationId: 'org-1',
  name: 'General request link',
  instructions: 'Pickups are Tuesday afternoons.\nBring your badge.',
  active: true,
  expiresAt: null,
  availableFrom: null,
  availableUntil: null,
  availabilityDisplay: 'exact' as const,
  booksEnabled: true,
  itemsEnabled: true,
  includePublicPool: false,
  defaultMaxQty: null,
};

/** The compact catalog the service answers (catalog-index.ts). */
const CATALOG = {
  mode: 'exact' as const,
  categories: [['c-1', 'Art']],
  rows: [
    ['i-1', 'Colored Pencils', 0, 12, 40, null],
    ['i-2', 'Safety Scissors', -1, 0, null, null],
  ],
  cut: false,
};

async function renderPage(params: { token?: string; w?: string } = {}) {
  const ui = await PublicOrderRequestPage({
    params: Promise.resolve({ token: params.token ?? TOKEN }),
    searchParams: Promise.resolve(params.w ? { w: params.w } : {}),
  });
  return render(ui);
}

beforeEach(() => {
  captured.props = null;
  db.calls = [];
  db.warehouses = [
    // A row may carry more than the page needs; only id and name go on.
    { id: 'wh-n', name: 'North DC', address: '1 Dock Rd', internal_code: 'NDC' },
    { id: 'wh-s', name: 'South DC', address: '9 Yard Ln', internal_code: 'SDC' },
  ];
  db.charterPairs = [
    { charter: { id: 'ch-1', name: 'Harbor Academy', code: 'HA', status: 'active' } },
    { charter: [{ id: 'ch-2', name: 'Old Campus', code: null, status: 'inactive' }] },
  ];
  svc.resolvePublicRequestToken.mockReset().mockResolvedValue({ org: ORG, link: LINK });
  svc.isLinkOpen.mockReset().mockReturnValue(true);
  svc.getPublicCatalogForLink.mockReset().mockResolvedValue(CATALOG);
});

describe('/r/<token>: links that do not resolve', () => {
  it('a token shorter than 16 characters is not found, before any lookup', async () => {
    await expect(renderPage({ token: 'short' })).rejects.toBeInstanceOf(NotFound);
    expect(svc.resolvePublicRequestToken).not.toHaveBeenCalled();
  });

  it('an unknown token is not found', async () => {
    svc.resolvePublicRequestToken.mockResolvedValue(null);
    await expect(renderPage()).rejects.toBeInstanceOf(NotFound);
  });
});

describe('/r/<token>: a closed link', () => {
  it('is the status card under the brand row, in its own words, with the track link', async () => {
    svc.isLinkOpen.mockReturnValue(false);
    await renderPage();

    // The card is the page's only heading, and still announced.
    const status = screen.getByRole('status');
    expect(
      within(status).getByRole('heading', { level: 1, name: 'Not accepting requests' }),
    ).toBeInTheDocument();
    expect(status).toHaveTextContent(
      "This request link isn't currently open. Please check back later or reach out to the organization directly.",
    );
    expect(screen.getAllByRole('heading')).toHaveLength(1);

    // The brand row and the way to an order already sent.
    expect(screen.getByText('Lincoln Unified')).toBeInTheDocument();
    expect(screen.getByText('Supply Requests')).toBeInTheDocument();
    expect(screen.getByText('Powered by StockPilot')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: "Track an order you've already submitted" }),
    ).toHaveAttribute('href', '/r/track');

    // Nothing is read for a closed link and no catalog is drawn.
    expect(db.calls).toEqual([]);
    expect(svc.getPublicCatalogForLink).not.toHaveBeenCalled();
    expect(captured.props).toBeNull();
  });

  it('says the organization is not taking requests when no warehouse takes them', async () => {
    db.warehouses = [];
    await renderPage();
    expect(screen.getByRole('status')).toHaveTextContent(
      "This organization isn't currently accepting public order requests. Please check back later or reach out to them directly.",
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Not accepting requests' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: "Track an order you've already submitted" }),
    ).toHaveAttribute('href', '/r/track');
    expect(captured.props).toBeNull();
  });
});

describe('/r/<token>: an open link', () => {
  it('draws the head in its own words: the link instructions and the Location, Catalog and Turnaround list', async () => {
    const { container } = await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Place an order' })).toBeInTheDocument();
    // The link's instructions win over the org blurb, line breaks kept.
    expect(container.querySelector('.sf-sub')?.textContent).toBe(
      'Pickups are Tuesday afternoons.\nBring your badge.',
    );
    const meta = container.querySelector('dl.sfp-meta') as HTMLElement;
    expect(within(meta).getByText('Location')).toBeInTheDocument();
    expect(within(meta).getByText('North DC')).toBeInTheDocument();
    expect(within(meta).getByText('Catalog')).toBeInTheDocument();
    expect(within(meta).getByText('2 items available')).toBeInTheDocument();
    expect(within(meta).getByText('Turnaround')).toBeInTheDocument();
    expect(within(meta).getByText('Reviewed within 1 business day')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: "Track an order you've already submitted" }),
    ).toHaveAttribute('href', '/r/track');
  });

  // Mutation caught: expanding the catalog on the server, which puts every
  // item's object (keys and all) in the page instead of the compact rows.
  it('hands the storefront only public fields: warehouses as id and name, active sites as id, name and code, and the service’s compact catalog', async () => {
    await renderPage();
    const props = captured.props!;
    expect(props.token).toBe(TOKEN);
    expect(props.orgName).toBe('Lincoln Unified');
    expect(props.warehouses).toEqual([
      { id: 'wh-n', name: 'North DC' },
      { id: 'wh-s', name: 'South DC' },
    ]);
    expect(props.initialWarehouseId).toBe('wh-n');
    expect(props.chartersForWarehouse).toEqual([
      { id: 'ch-1', name: 'Harbor Academy', code: 'HA' },
    ]);
    expect(props.catalog).toBe(CATALOG);
    expect(Object.keys(props).sort()).toEqual(
      [
        'catalog',
        'chartersForWarehouse',
        'initialWarehouseId',
        'orgName',
        'token',
        'warehouses',
      ].sort(),
    );
  });

  // Mutation caught: the old key (the link object, with its organization and
  // display mode) instead of the link id.
  it('keeps the warehouse a reload asked for (?w=) when it still takes requests, and reads its catalog by link id and warehouse id', async () => {
    await renderPage({ w: 'wh-s' });
    expect(captured.props!.initialWarehouseId).toBe('wh-s');
    expect(svc.getPublicCatalogForLink).toHaveBeenCalledWith('link-1', 'wh-s');
  });

  it('a ?w= that is not one of the warehouses read never reaches the catalog: the first warehouse is used', async () => {
    await renderPage({ w: 'another-orgs-warehouse' });
    expect(svc.getPublicCatalogForLink).toHaveBeenCalledTimes(1);
    expect(svc.getPublicCatalogForLink).toHaveBeenCalledWith('link-1', 'wh-n');
  });

  it('a legacy organization token (no link row) shows an empty catalog without reading one', async () => {
    svc.resolvePublicRequestToken.mockResolvedValue({ org: ORG, link: null });
    await renderPage();
    expect(svc.getPublicCatalogForLink).not.toHaveBeenCalled();
    expect(captured.props!.catalog).toEqual({ mode: 'none', categories: [], rows: [], cut: false });
  });

  it('draws the logo only from the public org-logos bucket, else the initial letter', async () => {
    svc.resolvePublicRequestToken.mockResolvedValue({
      org: { ...ORG, logo_url: 'https://tracker.example/pixel.png' },
      link: LINK,
    });
    const first = await renderPage();
    expect(first.container.querySelector('img')).toBeNull();
    expect(first.container.querySelector('.sfp-logo-fallback')?.textContent).toBe('L');
    first.unmount();

    const allowed = `${SUPABASE}/storage/v1/object/public/org-logos/org-1/logo.png`;
    svc.resolvePublicRequestToken.mockResolvedValue({
      org: { ...ORG, logo_url: allowed },
      link: LINK,
    });
    await renderPage();
    expect(screen.getByRole('img', { name: 'Lincoln Unified logo' })).toHaveAttribute(
      'src',
      allowed,
    );
  });
});

describe('/r/<token>: a catalog cut at the ceiling', () => {
  // Decision 3: past PUBLIC_CATALOG_ROW_CEILING the list is cut, and the page
  // says so. The search runs in the browser over the listed items, so the
  // page says it finds only those rather than sending people to look for the
  // rest with it.
  it('says the page lists 2,000 of the link’s items, that search finds only those, and whom to ask', async () => {
    svc.getPublicCatalogForLink.mockResolvedValue({ ...CATALOG, cut: true });
    await renderPage();
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(
      "This link offers more items than this page can list. It lists 2,000 of them, and the search finds only those. To ask for an item you can't find here, contact Lincoln Unified.",
    );
  });

  it('a catalog that is not cut says nothing about it', async () => {
    await renderPage();
    expect(screen.queryByRole('note')).toBeNull();
  });
});

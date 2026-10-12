import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RETURNS_COPY, type RequesterReturnSheet } from '@stockpilot/core';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers({ 'x-real-ip': '203.0.113.9' })) }));

const limit = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: limit.allowed, count: 1, resetAt: Date.now() + 1000 })) }));

const ADMIN = { tag: 'admin' };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ADMIN }));

const sheetFor = vi.hoisted(() => ({ value: null as RequesterReturnSheet | null }));
const loadSheet = vi.fn(async (..._args: unknown[]) => sheetFor.value);
vi.mock('@/server/services/returns-requester', () => ({
  loadRequesterReturnSheet: (...args: unknown[]) => loadSheet(...args),
}));

const switchOn = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/returns/exchange-switch', () => ({ exchangeCreateEnabled: () => switchOn.value }));

import RequesterReturnPage, { generateMetadata } from './page';

// A placeholder for the return link's token: a valid v4 UUID with low entropy,
// so it never reads as a secret, and no other id in this file shares it.
const LINK_ID = '22222222-2222-4222-8222-222222222222';

function sheet(over: Partial<RequesterReturnSheet> = {}): RequesterReturnSheet {
  return {
    orderNumber: 'SO-000103',
    requesterName: 'Dana Smith',
    exchangesEnabled: true,
    lines: [
      {
        orderRequestLineId: '11111111-1111-4111-8111-111111111111',
        name: 'New Hire Shirt',
        sizeLabel: 'Size M',
        photo: null,
        quantityFulfilled: 1,
        quantityRemaining: 1,
      },
    ],
    tracking: [],
    ...over,
  };
}

async function renderPage() {
  return render(await RequesterReturnPage({ params: Promise.resolve({ token: LINK_ID }) }));
}

beforeEach(() => {
  limit.allowed = true;
  switchOn.value = true;
  sheetFor.value = sheet();
  loadSheet.mockClear();
});

describe('the token page (returns RX-3)', () => {
  it("loads the requester sheet for the page's own token through the service role, and says Return or exchange", async () => {
    await renderPage();
    expect(loadSheet).toHaveBeenCalledWith(ADMIN, LINK_ID);
    expect(screen.getByRole('heading', { level: 1, name: RETURNS_COPY.requesterReturnOrExchange })).toBeInTheDocument();
    expect(screen.getByText(/Order SO-000103/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester })).toBeInTheDocument();
    await expect(generateMetadata()).resolves.toMatchObject({ title: RETURNS_COPY.requesterReturnOrExchange, robots: { index: false } });
  });

  it('says Request a return, with no Exchange, while exchanges are switched off', async () => {
    switchOn.value = false;
    sheetFor.value = sheet({ exchangesEnabled: false });
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Request a return' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: RETURNS_COPY.exchangeRequester })).toBeNull();
    await expect(generateMetadata()).resolves.toMatchObject({ title: 'Request a return' });
  });

  it('answers every closed door (unknown token, not returnable, Returns off) with the one dead-end page', async () => {
    sheetFor.value = null;
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: "This return link isn't active" })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit return request' })).toBeNull();
  });

  it('stops a crawl at the per-address limit before any lookup', async () => {
    limit.allowed = false;
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Too many requests' })).toBeInTheDocument();
    expect(loadSheet).not.toHaveBeenCalled();
  });

  it("shows the requester's own requests under Your requests on this order, beside a form with nothing left to return", async () => {
    sheetFor.value = sheet({
      lines: [],
      tracking: [
        {
          returnNumber: 'RMA-20261011-ABC123',
          createdAt: '2026-10-11T17:00:00.000Z',
          returnStatus: 'requested',
          exchangeStatus: 'requested',
          sentences: ['Exchange requested. The warehouse will review it.'],
          replacementOrderNumber: null,
          lines: [
            {
              returning: { name: 'New Hire Shirt', sizeLabel: 'Size M', quantity: 1 },
              exchange: { state: 'requested', replacement: { name: 'New Hire Shirt', sizeLabel: 'Size L', quantity: 1 }, substituted: false },
            },
          ],
        },
      ],
    });
    const { container } = await renderPage();
    expect(screen.getByText('Nothing left to return')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: RETURNS_COPY.requesterYourRequests })).toBeInTheDocument();
    expect(screen.getByText('Exchange requested. The warehouse will review it.')).toBeInTheDocument();
    expect(screen.getByText('New Hire Shirt, L ×1')).toBeInTheDocument();
    // The requester sees no SKU, rack, Staging or staff words anywhere.
    expect(container.textContent).not.toMatch(/\bsku\b|\brack\b|staging|disposition|restock|scrap/i);
  });
});

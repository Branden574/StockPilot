import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /m/[token] is the most dangerous surface in the maintenance-requests
 * feature: a fully anonymous, unauthenticated page. This suite pins the
 * orchestration around `resolveMaintenanceShareToken` (that function's OWN
 * internals — the allow-list projection, expiry/revocation checks, signed
 * URLs — are covered by maintenance-share-links.test.ts): the double rate
 * limit (per-IP AND per-token, closed-mode) runs BEFORE the token is ever
 * resolved, every miss (rate-limited / malformed / unresolved) renders the
 * SAME generic notFound(), and the rendered DOM carries only the
 * allow-listed fields — never a storage path or an internal UUID.
 */

const { headersRef } = vi.hoisted(() => ({ headersRef: { value: new Headers() } }));
vi.mock('next/headers', () => ({
  headers: async () => headersRef.value,
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));

const resolveMaintenanceShareTokenMock = vi.fn();
vi.mock('@/server/services/maintenance-share-links', () => ({
  resolveMaintenanceShareToken: (...args: unknown[]) => resolveMaintenanceShareTokenMock(...args),
}));

import { notFound } from 'next/navigation';

import MaintenanceSharePage from './page';

const TOKEN = 'e'.repeat(64);
const RESOLVED = {
  requestNumber: 'MR-2026-000042',
  subject: 'AC not working in Room 204',
  description: 'Blowing warm air since yesterday afternoon.\nStarted Monday.',
  siteName: 'Fresno DC4',
  createdAt: '2026-08-01T12:00:00Z',
  photos: [
    { url: 'https://mock/signed-master', thumbUrl: 'https://mock/signed-thumb', filename: 'break-room.jpg' },
  ],
};

async function renderPage(token: string) {
  return render(await MaintenanceSharePage({ params: Promise.resolve({ token }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  headersRef.value = new Headers();
  checkRateLimitMock.mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 1000 });
  resolveMaintenanceShareTokenMock.mockResolvedValue(RESOLVED);
});

describe('GET /m/[token] (page render)', () => {
  it('renders exactly the allow-listed fields: request number, subject, site, description, and photos', async () => {
    const { getByText, getAllByRole } = await renderPage(TOKEN);
    expect(getByText('MR-2026-000042')).toBeTruthy();
    expect(getByText('AC not working in Room 204')).toBeTruthy();
    expect(getByText(/Fresno DC4/)).toBeTruthy();
    expect(getByText(/Blowing warm air/)).toBeTruthy();
    const images = getAllByRole('img');
    expect(images).toHaveLength(1);
    // The thumb is preferred for display; the full-res signed URL is the
    // click-through target (asserted separately below).
    expect(images[0]!.getAttribute('src')).toBe('https://mock/signed-thumb');
  });

  it('links each photo to its full-resolution signed URL, opened in a new tab without leaking a referrer/opener', async () => {
    const { container } = await renderPage(TOKEN);
    const link = container.querySelector('a');
    expect(link!.getAttribute('href')).toBe('https://mock/signed-master');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('rate-limits per IP AND per token, closed-mode, with the documented literal limits/window', async () => {
    headersRef.value = new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' });
    await renderPage(TOKEN);
    expect(checkRateLimitMock).toHaveBeenCalledWith('maintenance:share:ip:203.0.113.9', 60, 3600000, 'closed');
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      `maintenance:share:token:${TOKEN.slice(0, 32)}`,
      120,
      3600000,
      'closed',
    );
  });

  it('falls back to "unknown" for the IP bucket when x-forwarded-for is absent', async () => {
    await renderPage(TOKEN);
    expect(checkRateLimitMock).toHaveBeenCalledWith('maintenance:share:ip:unknown', 60, 3600000, 'closed');
  });

  it('MUTATION GUARD — a rate-limited IP bucket renders the generic notFound() and never even resolves the token', async () => {
    checkRateLimitMock.mockImplementation(async (key: string) => ({
      allowed: !key.startsWith('maintenance:share:ip:'),
      count: 999,
      resetAt: Date.now(),
    }));
    await expect(renderPage(TOKEN)).rejects.toThrow('notFound');
    expect(notFound).toHaveBeenCalled();
    expect(resolveMaintenanceShareTokenMock).not.toHaveBeenCalled();
  });

  it('MUTATION GUARD — a rate-limited TOKEN bucket also 404s via the same generic path', async () => {
    checkRateLimitMock.mockImplementation(async (key: string) => ({
      allowed: !key.startsWith('maintenance:share:token:'),
      count: 999,
      resetAt: Date.now(),
    }));
    await expect(renderPage(TOKEN)).rejects.toThrow('notFound');
    expect(resolveMaintenanceShareTokenMock).not.toHaveBeenCalled();
  });

  it('an unresolved token (unknown/revoked/expired are indistinguishable upstream) renders the same generic notFound()', async () => {
    resolveMaintenanceShareTokenMock.mockResolvedValue(null);
    await expect(renderPage(TOKEN)).rejects.toThrow('notFound');
  });

  it('rejects a too-short token at the route boundary BEFORE spending any rate-limit budget or resolving', async () => {
    await expect(renderPage('short')).rejects.toThrow('notFound');
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(resolveMaintenanceShareTokenMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized token at the route boundary the same way', async () => {
    await expect(renderPage('a'.repeat(200))).rejects.toThrow('notFound');
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it('omits the Photos section entirely when there are no shared photos', async () => {
    resolveMaintenanceShareTokenMock.mockResolvedValue({ ...RESOLVED, photos: [] });
    const { queryByText, queryAllByRole } = await renderPage(TOKEN);
    expect(queryByText(/Photos \(/)).toBeNull();
    expect(queryAllByRole('img')).toHaveLength(0);
  });

  it('omits the Site line when siteName is null', async () => {
    resolveMaintenanceShareTokenMock.mockResolvedValue({ ...RESOLVED, siteName: null });
    const { queryByText } = await renderPage(TOKEN);
    expect(queryByText(/^Site:/)).toBeNull();
  });

  it('never renders a storage path, the bucket name, or an internal UUID anywhere in the DOM', async () => {
    const { container } = await renderPage(TOKEN);
    const html = container.innerHTML;
    expect(html).not.toContain('maintenance-photos');
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});

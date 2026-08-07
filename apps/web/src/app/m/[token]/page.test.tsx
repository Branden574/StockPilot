import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /m/[token] is the most dangerous surface in the maintenance-requests
 * feature: a fully anonymous, unauthenticated page. This suite pins the
 * orchestration around `resolveMaintenanceShareToken` (that function's OWN
 * internals — the allow-list projection, expiry/revocation checks — are
 * covered by maintenance-share-links.test.ts): the double rate limit (per-
 * token, hashed, AND per-IP when resolvable, closed-mode) runs BEFORE the
 * token is ever resolved, every miss (rate-limited / malformed / unresolved)
 * renders the SAME generic notFound(), and the rendered DOM carries only
 * the allow-listed fields plus same-origin PROXY photo paths — never a
 * signed URL, storage path, bucket name, or UUID (fix wave C1; see
 * `/m/[token]/photo/[n]/route.ts` for where the bytes actually come from).
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

const clientIpFromHeadersMock = vi.fn((_headers: unknown) => 'unknown');
vi.mock('@/lib/client-ip', () => ({
  clientIpFromHeaders: (headers: unknown) => clientIpFromHeadersMock(headers),
}));

const resolveMaintenanceShareTokenMock = vi.fn();
// Deterministic stand-in for the real SHA-256 (that function has its own
// direct unit tests in maintenance-share-links.test.ts) — just enough to
// prove the PAGE routes the FULL token through it (fix wave m6) rather than
// slicing it inline the way the old, unfixed code did.
const hashShareTokenMock = vi.fn((token: string) => `sha256:${token}`);
vi.mock('@/server/services/maintenance-share-links', () => ({
  resolveMaintenanceShareToken: (...args: unknown[]) => resolveMaintenanceShareTokenMock(...args),
  hashShareToken: (token: string) => hashShareTokenMock(token),
}));

import { notFound } from 'next/navigation';

import MaintenanceSharePage from './page';

// Brief section 20/GC4's forbidden vocabulary, extended with the resolved-
// specific phrases (spec §11) — this suite now renders resolution copy, so
// it carries the full sweep, not just the pre-resolved subset.
const FORBIDDEN = [
  'Email sent',
  'Ticket created',
  'Request submitted to Zendesk',
  'DC4 notified',
  'Andrew notified',
  'Ticket assigned',
  'Ticket closed',
  'Ticket resolved',
  'Zendesk ticket closed',
  'Zendesk ticket updated',
  'Zendesk ticket resolved',
  'Issue verified fixed',
];

const TOKEN = 'e'.repeat(64);
const RESOLVED = {
  requestNumber: 'MR-2026-000042',
  subject: 'AC not working in Room 204',
  description: 'Blowing warm air since yesterday afternoon.\nStarted Monday.',
  siteName: 'Fresno DC4',
  createdAt: '2026-08-01T12:00:00Z',
  photos: [{ filename: 'break-room.jpg', kind: 'requester' as const }],
  resolution: null as { note: string; resolvedAtDisplay: string } | null,
};

async function renderPage(token: string) {
  return render(await MaintenanceSharePage({ params: Promise.resolve({ token }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  headersRef.value = new Headers();
  checkRateLimitMock.mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 1000 });
  clientIpFromHeadersMock.mockReturnValue('unknown');
  resolveMaintenanceShareTokenMock.mockResolvedValue(RESOLVED);
  hashShareTokenMock.mockImplementation((token: string) => `sha256:${token}`);
});

describe('GET /m/[token] (page render)', () => {
  it('renders exactly the allow-listed fields: request number, subject, site, submitted date, description, and photos', async () => {
    const { getByText, getAllByRole } = await renderPage(TOKEN);
    expect(getByText('MR-2026-000042')).toBeTruthy();
    expect(getByText('AC not working in Room 204')).toBeTruthy();
    expect(getByText(/Fresno DC4/)).toBeTruthy();
    expect(getByText(/Blowing warm air/)).toBeTruthy();
    // Fix wave m8 — createdAt is rendered, not silently carried and dropped.
    expect(getByText(/Submitted:/)).toBeTruthy();
    expect(getByText(/August 1, 2026/)).toBeTruthy();
    const images = getAllByRole('img');
    expect(images).toHaveLength(1);
    // Fix wave C1 — the ONLY photo URL the page ever renders: a same-origin
    // proxy path indexed by position, never a signed storage URL.
    expect(images[0]!.getAttribute('src')).toBe(`/m/${TOKEN}/photo/0`);
  });

  it('renders only proxy paths for photos — no signed URL, storage path, bucket name, or UUID reaches the DOM (fix wave C1)', async () => {
    // The ORIGINAL version of this test (reviewer M19a) used a hardcoded
    // 'https://mock/signed-master' stand-in for the resolved photo URL and
    // passed trivially — a REAL Supabase signed URL looks like
    //   https://xyz.supabase.co/storage/v1/object/sign/maintenance-photos/<org>/<req>/<att>.jpg?token=...
    // which embeds the bucket name and every path UUID verbatim. This
    // version proves the page never even RECEIVES anything URL-shaped for a
    // photo (the resolver's `photos` entries carry only a `filename` — see
    // maintenance-share-links.test.ts) and instead builds every photo URL
    // itself, as a proxy path.
    resolveMaintenanceShareTokenMock.mockResolvedValue({
      ...RESOLVED,
      photos: [
        { filename: 'break-room.jpg', kind: 'requester' as const },
        { filename: 'hallway.jpg', kind: 'requester' as const },
      ],
    });
    const { container, getAllByRole } = await renderPage(TOKEN);

    const images = getAllByRole('img');
    expect(images).toHaveLength(2);
    expect(images[0]!.getAttribute('src')).toBe(`/m/${TOKEN}/photo/0`);
    expect(images[1]!.getAttribute('src')).toBe(`/m/${TOKEN}/photo/1`);

    const links = Array.from(container.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      `/m/${TOKEN}/photo/0`,
      `/m/${TOKEN}/photo/1`,
    ]);
    expect(links.every((a) => a.getAttribute('target') === '_blank')).toBe(true);
    expect(links.every((a) => a.getAttribute('rel') === 'noopener noreferrer')).toBe(true);

    const html = container.innerHTML;
    expect(html).not.toContain('maintenance-photos');
    expect(html).not.toContain('storage/v1');
    expect(html).not.toContain('supabase.co');
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('rate-limits the per-token bucket keyed by the FULL token\'s hash (fix wave m6) — never a raw or sliced token', async () => {
    await renderPage(TOKEN);
    expect(hashShareTokenMock).toHaveBeenCalledWith(TOKEN);
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      `maintenance:share:token:sha256:${TOKEN}`,
      120,
      3600000,
      'closed',
    );
  });

  it('also rate-limits the per-IP bucket, resolved through the shared client-IP helper (fix wave I4), when the IP is known', async () => {
    clientIpFromHeadersMock.mockReturnValue('203.0.113.9');
    await renderPage(TOKEN);
    expect(clientIpFromHeadersMock).toHaveBeenCalledWith(headersRef.value);
    expect(checkRateLimitMock).toHaveBeenCalledWith('maintenance:share:ip:203.0.113.9', 60, 3600000, 'closed');
  });

  it('MUTATION GUARD (I4) — skips the IP bucket entirely when the IP is unresolved ("unknown") — never collapses every such visitor onto one shared, globally-throttleable bucket', async () => {
    clientIpFromHeadersMock.mockReturnValue('unknown');
    await renderPage(TOKEN);
    const ipCalls = checkRateLimitMock.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].startsWith('maintenance:share:ip:'),
    );
    expect(ipCalls).toHaveLength(0);
    // The token bucket is still enforced regardless — that's the real
    // control when the IP can't be resolved.
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      `maintenance:share:token:sha256:${TOKEN}`,
      120,
      3600000,
      'closed',
    );
  });

  it('MUTATION GUARD — a rate-limited IP bucket renders the generic notFound() and never even resolves the token', async () => {
    clientIpFromHeadersMock.mockReturnValue('203.0.113.9');
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

  describe('resolution proof section (Maintenance Resolved, task brief test 11/12)', () => {
    it('renders two labeled sections — Photos (requester) and Resolution proof (resolution) — with each <img> src STILL indexed against the ONE combined list (requester at 0, resolution at 1), never a locally re-numbered index', async () => {
      resolveMaintenanceShareTokenMock.mockResolvedValue({
        ...RESOLVED,
        photos: [
          { filename: 'leak.jpg', kind: 'requester' as const },
          { filename: 'fixed.jpg', kind: 'resolution' as const },
        ],
      });
      const { getByText, getAllByRole } = await renderPage(TOKEN);

      expect(getByText('Photos (1)')).toBeInTheDocument();
      expect(getByText('Resolution proof (1)')).toBeInTheDocument();

      const images = getAllByRole('img');
      expect(images).toHaveLength(2);
      expect(images[0]!.getAttribute('alt')).toBe('leak.jpg');
      expect(images[0]!.getAttribute('src')).toBe(`/m/${TOKEN}/photo/0`);
      // MUTATION GUARD (T3-M3) — the resolution section's own item is at
      // combined-list index 1; a filtered-array-local index would instead
      // read `/photo/0` here (both sections would start counting from 0
      // independently), which this literal pin catches.
      expect(images[1]!.getAttribute('alt')).toBe('fixed.jpg');
      expect(images[1]!.getAttribute('src')).toBe(`/m/${TOKEN}/photo/1`);
    });

    it('omits the Resolution proof section when there are no resolution-kind photos, even though requester photos exist', async () => {
      resolveMaintenanceShareTokenMock.mockResolvedValue({
        ...RESOLVED,
        photos: [{ filename: 'leak.jpg', kind: 'requester' as const }],
      });
      const { queryByText, getAllByRole } = await renderPage(TOKEN);
      expect(queryByText(/Resolution proof/)).toBeNull();
      expect(getAllByRole('img')).toHaveLength(1);
    });

    it('an unresolved request renders no Resolution block at all', async () => {
      const { queryByText } = await renderPage(TOKEN);
      expect(queryByText('Resolution')).toBeNull();
      expect(queryByText(/Marked resolved/)).toBeNull();
    });

    it('a resolved request renders "Marked resolved · {date}" and the note VERBATIM (whitespace-pre-line, no truncation), and the §11 forbidden-phrase sweep stays clean over the whole rendered page', async () => {
      resolveMaintenanceShareTokenMock.mockResolvedValue({
        ...RESOLVED,
        resolution: {
          note: 'The issue for the leaking roof tile has been resolved.\nReplaced the cracked tile.',
          resolvedAtDisplay: 'August 5, 2026',
        },
      });
      const { getByText } = await renderPage(TOKEN);

      expect(getByText('Resolution')).toBeInTheDocument();
      expect(getByText('Marked resolved · August 5, 2026')).toBeInTheDocument();
      const note = getByText((_, node) => node?.textContent === 'The issue for the leaking roof tile has been resolved.\nReplaced the cracked tile.');
      expect(note).toBeInTheDocument();
      expect(note.className).toContain('whitespace-pre-line');

      for (const banned of FORBIDDEN) {
        expect(document.body.textContent).not.toContain(banned);
      }
    });

    it('resolvedAtDisplay is rendered VERBATIM as handed back by the resolver — the page never reformats it itself', async () => {
      resolveMaintenanceShareTokenMock.mockResolvedValue({
        ...RESOLVED,
        resolution: { note: 'Fixed.', resolvedAtDisplay: 'NOT-A-REAL-DATE-STRING' },
      });
      const { getByText } = await renderPage(TOKEN);
      expect(getByText('Marked resolved · NOT-A-REAL-DATE-STRING')).toBeInTheDocument();
    });

    it('fix wave I1 — resolution: null + a kind=\'resolution\' photo (the Resolve dialog was abandoned pre-flip) renders the STAGED caption, never the ADDED one, even though the grid itself stays visible', async () => {
      resolveMaintenanceShareTokenMock.mockResolvedValue({
        ...RESOLVED,
        resolution: null,
        photos: [{ filename: 'fixed.jpg', kind: 'resolution' as const }],
      });
      const { getByText, queryByText, getAllByRole } = await renderPage(TOKEN);

      expect(getByText('Resolution proof (1)')).toBeInTheDocument();
      expect(getAllByRole('img')).toHaveLength(1);
      expect(
        getByText('Staged by the team while preparing to mark this request resolved.'),
      ).toBeInTheDocument();
      expect(
        queryByText('Added by the team when this request was marked resolved.'),
      ).toBeNull();
    });

    it('fix wave I1 — a REAL resolution renders the ADDED caption on the same grid, never the STAGED one', async () => {
      resolveMaintenanceShareTokenMock.mockResolvedValue({
        ...RESOLVED,
        resolution: { note: 'Fixed.', resolvedAtDisplay: 'August 5, 2026' },
        photos: [{ filename: 'fixed.jpg', kind: 'resolution' as const }],
      });
      const { getByText, queryByText } = await renderPage(TOKEN);

      expect(getByText('Resolution proof (1)')).toBeInTheDocument();
      expect(
        getByText('Added by the team when this request was marked resolved.'),
      ).toBeInTheDocument();
      expect(
        queryByText('Staged by the team while preparing to mark this request resolved.'),
      ).toBeNull();
    });
  });
});

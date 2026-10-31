import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

/**
 * Security invariant (2026-09-28): the report PDF dispatcher, like the CSV
 * one, checks reports:export (MFA step-up first), a known report,
 * reports:read and the report's modules, and the request BEFORE the shared
 * export limit, and answers each refusal with its real status. It used to
 * rate-limit first, check reports:export only, and answer module_disabled
 * and validation errors with 500.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({ exportRateLimited: vi.fn(async () => null) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    throw new Error('the PDF path must not use the service-role client for report data');
  },
}));
// The real renderer, recorded, so a test can read the props it was handed.
vi.mock('@react-pdf/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-pdf/renderer')>();
  return { ...actual, renderToStream: vi.fn(actual.renderToStream) };
});
// The header logo: the document must get only what this answers.
vi.mock('@/lib/pdf/image-prefetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pdf/image-prefetch')>()),
  prefetchPdfLogo: vi.fn(async () => null),
}));

import { renderToStream } from '@react-pdf/renderer';
import sharp from 'sharp';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { prefetchPdfLogo } from '@/lib/pdf/image-prefetch';
import { ServiceError } from '@/server/services/context';
import { ReportsService } from '@/server/services/reports';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

type Overrides = Parameters<typeof makeServiceContext>[1] & { mfaEnrolled?: boolean };
function signIn(overrides: Overrides = {}) {
  const s = makeSupabaseStub({
    'organizations.select': { data: { name: 'Acme', logo_url: null }, error: null },
    'inventory_items.select': { data: null, error: null },
  });
  const { mfaEnrolled, ...rest } = overrides;
  const ctx = { ...makeServiceContext(s.client, { role: 'manager', ...rest }), mfaEnrolled };
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return s;
}

async function get(slug: string, qs = '') {
  const { NextRequest } = await import('next/server');
  const res = await GET(new NextRequest(`https://test.local/api/reports/${slug}/pdf${qs}`), {
    params: Promise.resolve({ slug }),
  });
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: res.status, body, cacheControl: res.headers.get('cache-control') };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.mocked(exportRateLimited).mockResolvedValue(null);
});

describe('GET /api/reports/[slug]/pdf: checks before the export budget', () => {
  it('no reports:export: 403, budget untouched', async () => {
    signIn({ role: 'staff' });
    const r = await get('shrinkage', '?days=30');
    expect(r.status).toBe(403);
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it('reports:export without reports:read: 403, budget untouched, nothing read', async () => {
    const s = signIn({ role: 'viewer', permissions: new Set(['reports:export']) });
    const r = await get('shrinkage', '?days=30');
    expect(r.status).toBe(403);
    expect(exportRateLimited).not.toHaveBeenCalled();
    expect(s.fromCalls).toEqual([]);
  });

  it('an enrolled AAL1 session: 403 aal2_required, budget untouched', async () => {
    signIn({ role: 'owner', mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true });
    const r = await get('shrinkage', '?days=30');
    expect(r.status).toBe(403);
    expect((r.body?.details as { reason?: string } | undefined)?.reason).toBe('aal2_required');
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it('purchase orders off: supplier-scorecard is 403 module_disabled (was 500), budget untouched', async () => {
    signIn({
      enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS.filter((m) => m !== 'purchase_orders')),
    });
    const r = await get('supplier-scorecard', '?days=90');
    expect(r.status).toBe(403);
    expect(r.body?.error).toBe('module_disabled');
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it('an unknown report: 404, budget untouched', async () => {
    signIn();
    const r = await get('everything');
    expect(r.status).toBe(404);
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  // Review nit (2026-09-29): the PDF 404 had its own shape (unknown_report)
  // and no no-store; both dispatchers now answer the same, never cached.
  it('an unknown report: the same 404 as the CSV dispatcher, never cached', async () => {
    signIn();
    const r = await get('everything');
    expect(r.body).toEqual({ error: 'not_found', message: 'Unknown report' });
    expect(r.cacheControl).toBe('no-store');
  });

  it('item-cost-history with a malformed id: 400, budget untouched', async () => {
    signIn();
    const r = await get('item-cost-history', '?itemId=abc');
    expect(r.status).toBe(400);
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it('inventory-valuation with a charterId that is not a uuid: 400 (was 500), budget untouched', async () => {
    signIn();
    const r = await get('inventory-valuation', '?charterId=not-a-uuid');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'validation_error', message: 'Choose a charter.' });
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it('item-cost-history for an item the caller cannot read: 404', async () => {
    signIn();
    const r = await get('item-cost-history', '?itemId=11111111-2222-4333-8444-555555555555');
    expect(r.status).toBe(404);
    expect(r.body?.error).toBe('not_found');
  });

  it.each([
    ['validation_error', 400],
    ['module_disabled', 403],
    ['not_found', 404],
  ] as const)('a %s thrown by the service: %i (not 500)', async (code, status) => {
    signIn();
    vi.spyOn(ReportsService.prototype, 'shrinkage').mockRejectedValue(new ServiceError(code, 'no'));
    const r = await get('shrinkage', '?days=30');
    expect(r.status).toBe(status);
    expect(r.body?.error).toBe(code);
  });
});

/**
 * The organization logo in the report's header. logo_url is set by an owner
 * or admin and the database does not hold it to the logo bucket, so the route
 * resolves it through prefetchPdfLogo (a guarded fetch, bytes back) and the
 * document gets only that answer, never the stored value.
 */
describe('GET /api/reports/[slug]/pdf: the header logo', () => {
  const STORED = 'https://proj.supabase.co/storage/v1/object/public/org-logos/org-1/logo-1.png';

  async function pngDataUri(): Promise<string> {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  }

  function signInWithLogo() {
    const s = makeSupabaseStub({
      'organizations.select': { data: { name: 'Acme', logo_url: STORED }, error: null },
    });
    vi.mocked(withApiContext).mockResolvedValue(
      makeServiceContext(s.client, { role: 'manager' }) as never,
    );
    vi.spyOn(ReportsService.prototype, 'supplierScorecard').mockResolvedValue({
      rows: [],
    } as never);
  }

  function renderedProps(): { orgName: string; orgLogoUrl: string | null } {
    const element = vi.mocked(renderToStream).mock.calls.at(-1)?.[0] as unknown as {
      props: { orgName: string; orgLogoUrl: string | null };
    };
    return element.props;
  }

  it('prints the stored logo from the bytes prefetchPdfLogo answers', async () => {
    signInWithLogo();
    const logo = await pngDataUri();
    vi.mocked(prefetchPdfLogo).mockResolvedValueOnce(logo);
    const r = await get('supplier-scorecard', '?days=90');
    expect(r.status).toBe(200);
    expect(prefetchPdfLogo).toHaveBeenCalledTimes(1);
    expect(prefetchPdfLogo).toHaveBeenCalledWith(STORED);
    expect(renderedProps()).toMatchObject({ orgName: 'Acme', orgLogoUrl: logo });
  });

  it('prints no logo when prefetchPdfLogo answers none, whatever is stored', async () => {
    signInWithLogo();
    vi.mocked(prefetchPdfLogo).mockResolvedValueOnce(null);
    const r = await get('supplier-scorecard', '?days=90');
    expect(r.status).toBe(200);
    expect(renderedProps()).toMatchObject({ orgName: 'Acme', orgLogoUrl: null });
  });
});

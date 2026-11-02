import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountStatusUnavailableError } from '@/lib/auth/account-status';
import { withApiContext } from '@/lib/auth/api-context';
import { PermissionsUnavailableError } from '@/lib/auth/effective-permissions';
import { reportError } from '@/lib/error-reporter';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({ exportRateLimited: vi.fn(async () => null) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/server/services/po-attachments', () => ({ PoAttachmentsService: vi.fn() }));
vi.mock('@/server/services/purchase-orders', () => ({ PurchaseOrdersService: vi.fn() }));

// Imported AFTER the mocks above so the route picks them up.
import { GET } from './route';

/**
 * The context read runs inside the route's try. Its fallback throws one of two
 * errors with a fixed sentence when it cannot check the caller's permissions
 * or account status; since S16 the route answered both with "Something went
 * wrong" (S31, LS1). They answer their own sentence again, reported as a
 * warning.
 */
describe('GET /api/purchase-orders/[id]/attachments.zip — a check that could not run', () => {
  const PO_ID = '0a000000-0000-4000-8000-0000000000f1';

  function get() {
    return GET(new NextRequest(`http://localhost/api/purchase-orders/${PO_ID}/attachments.zip`), {
      params: Promise.resolve({ id: PO_ID }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers the permission check's own sentence, reported as a warning", async () => {
    const e = new PermissionsUnavailableError();
    vi.mocked(withApiContext).mockRejectedValueOnce(e);
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: 'Your permissions could not be checked. Please try again.',
    });
    expect(reportError).toHaveBeenCalledWith(e, { tag: 'po.attachments_zip', level: 'warning' });
  });

  it("answers the account status check's own sentence, reported as a warning", async () => {
    const e = new AccountStatusUnavailableError();
    vi.mocked(withApiContext).mockRejectedValueOnce(e);
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: 'Account status could not be verified. Please try again.',
    });
    expect(reportError).toHaveBeenCalledWith(e, { tag: 'po.attachments_zip', level: 'warning' });
  });

  it("answers anything else with the fixed sentence, never the error's text, reported as an error", async () => {
    const e = new Error('connect ECONNREFUSED 10.0.0.1:5432');
    vi.mocked(withApiContext).mockRejectedValueOnce(e);
    const res = await get();
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'internal_error',
      message: 'Something went wrong. Please try again.',
    });
    expect(text).not.toContain('ECONNREFUSED');
    expect(reportError).toHaveBeenCalledWith(e, { tag: 'po.attachments_zip' });
  });
});

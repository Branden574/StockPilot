import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { PoImportsService } from '@/server/services/po-imports';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/po-imports', () => ({ PoImportsService: vi.fn() }));

const ctx = {
  organizationId: 'org-1',
  userId: 'u-1',
  role: 'admin' as const,
  supabase: {} as never,
  mfaRequired: false,
  mfaSatisfied: true,
  enabledModules: new Set<ModuleId>(),
};

function pdf(name: string): File {
  return new File([new Uint8Array(16)], name, { type: 'application/pdf' });
}

function scanRequest(files: File[], mode?: string): Request {
  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  if (mode) fd.append('mode', mode);
  return new Request('https://test.local/api/po-imports/scan', { method: 'POST', body: fd });
}

let createFromScan: ReturnType<typeof vi.fn>;

describe('POST /api/po-imports/scan — separate vs combined', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withApiContext).mockResolvedValue(ctx as never);
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 60_000 });
    createFromScan = vi.fn(async ({ files }: { files: unknown[] }) => ({
      id: `imp-${files.length}-${Math.random().toString(36).slice(2, 6)}`,
      duplicateOf: null,
      lowConfidenceLines: 0,
    }));
    vi.mocked(PoImportsService).mockImplementation(() => ({ createFromScan }) as never);
  });

  it('separate mode: 3 files → 3 imports, one createFromScan call PER file', async () => {
    const res = await POST(scanRequest([pdf('PO-001.pdf'), pdf('PO-002.pdf'), pdf('PO-003.pdf')], 'separate'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe('separate');
    expect(json.imports).toHaveLength(3);
    expect(json.failed).toHaveLength(0);
    // called once per file, each with a single-file array (never merged)
    expect(createFromScan).toHaveBeenCalledTimes(3);
    for (const call of createFromScan.mock.calls) {
      expect(call[0].files).toHaveLength(1);
    }
  });

  it('combined mode: 3 files → ONE merged import (single createFromScan with all files)', async () => {
    const res = await POST(scanRequest([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')], 'combined'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBeUndefined();
    expect(typeof json.id).toBe('string');
    expect(createFromScan).toHaveBeenCalledTimes(1);
    expect(createFromScan.mock.calls[0]![0].files).toHaveLength(3);
  });

  it('a single file is always combined (nothing to separate) even if mode=separate', async () => {
    const res = await POST(scanRequest([pdf('solo.pdf')], 'separate'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBeUndefined();
    expect(createFromScan).toHaveBeenCalledTimes(1);
  });

  it('separate mode: an unreadable file is skipped and reported, the rest still import', async () => {
    createFromScan
      .mockResolvedValueOnce({ id: 'imp-ok', duplicateOf: null, lowConfidenceLines: 0 })
      .mockRejectedValueOnce(new ServiceError('validation_error', "This doesn't look like a purchase order."));
    const res = await POST(scanRequest([pdf('good.pdf'), pdf('not-a-po.pdf')], 'separate'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.imports).toHaveLength(1);
    expect(json.failed).toHaveLength(1);
    expect(json.failed[0].fileName).toBe('not-a-po.pdf');
  });

  it('separate mode: when EVERY file fails, returns 400 (no navigation)', async () => {
    createFromScan.mockRejectedValue(new ServiceError('validation_error', 'Not a PO.'));
    const res = await POST(scanRequest([pdf('x.pdf'), pdf('y.pdf')], 'separate'));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('validation_error');
  });
});

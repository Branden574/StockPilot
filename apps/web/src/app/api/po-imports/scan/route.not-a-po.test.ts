import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

/**
 * A page that is not a purchase order (B80). The extractor's refusal is the
 * one sentence written for the person: the route must answer it as it is,
 * on the single scan and in each separate file's result, and must not report
 * it. These drive the REAL extractor (stubbed model) through a service stand-in
 * that calls it the way createFromScan does (services/po-imports.ts, the
 * extractPoFromMedia call has no try around it), so the test fails if the
 * extractor's throw and the route's catch stop agreeing.
 */

const { mockClaudeJson } = vi.hoisted(() => ({ mockClaudeJson: vi.fn() }));

vi.mock('@/lib/ai/claude', () => ({ claudeGenerateJsonString: mockClaudeJson }));
vi.mock('@/lib/ai/provider', () => ({ resolveAiProvider: () => 'claude' }));
vi.mock('@/lib/env', () => ({
  env: {
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_PO_SCAN_MODEL: 'claude-sonnet-5',
    GEMINI_API_KEY: '',
    GEMINI_MODEL: 'gemini-2.0-flash',
  },
}));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/po-imports', () => ({ PoImportsService: vi.fn() }));

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { extractPoFromMedia } from '@/lib/po-scan/extract';
import { checkRateLimit } from '@/lib/rate-limit';
import { PoImportsService } from '@/server/services/po-imports';

import { POST } from './route';

const NOT_A_PO =
  "This doesn't look like a purchase order — try a clearer photo of the full document.";

const ctx = {
  organizationId: 'org-1',
  userId: 'u-1',
  role: 'admin' as const,
  supabase: {} as never,
  mfaRequired: false,
  mfaSatisfied: true,
  enabledModules: new Set<ModuleId>(),
};

function jpeg(name: string): File {
  return new File([new Uint8Array(16)], name, { type: 'image/jpeg' });
}

function scanRequest(files: File[], mode?: string): Request {
  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  if (mode) fd.append('mode', mode);
  return new Request('https://test.local/api/po-imports/scan', { method: 'POST', body: fd });
}

/** The model's answer for a page with nothing that reads as a purchase order. */
const NOT_A_PO_ANSWER = JSON.stringify({
  poNumber: '',
  vendorName: '',
  vendorAddress: '',
  orderDate: '',
  expectedDate: '',
  subtotal: 0,
  tax: 0,
  freight: 0,
  grandTotal: 0,
  overallConfidence: 0.05,
  lines: [],
});

/** The model's answer for an ordinary one-line purchase order. */
const PO_ANSWER = JSON.stringify({
  poNumber: 'PO-77',
  vendorName: 'Sample Supplies',
  vendorAddress: '',
  orderDate: '2026-07-27',
  expectedDate: '',
  subtotal: 10,
  tax: 0,
  freight: 0,
  grandTotal: 10,
  overallConfidence: 0.95,
  lines: [
    {
      lineNumber: 1,
      description: '3-Ring Binder, 1 inch',
      vendorSku: 'BND-1',
      isbn: '',
      quantity: 1,
      unitCost: 10,
      lineTotal: 10,
      confidence: 0.95,
    },
  ],
});

describe('POST /api/po-imports/scan: a page that is not a purchase order (B80)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withApiContext).mockResolvedValue(ctx as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
    vi.mocked(PoImportsService).mockImplementation(function () {
      return {
        createFromScan: async (input: { files: Array<{ mimeType: string }> }) => {
          await extractPoFromMedia(
            input.files.map((f) => ({ base64: 'AAAA', mimeType: f.mimeType })),
          );
          return { id: 'imp-1', duplicateOf: null, lowConfidenceLines: 0 };
        },
      } as never;
    });
  });

  it('a single scan answers 400 with the sentence, and nothing is reported', async () => {
    mockClaudeJson.mockResolvedValue(NOT_A_PO_ANSWER);
    const res = await POST(scanRequest([jpeg('IMG_0001.jpg')]));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'validation_error', message: NOT_A_PO });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('separate files that are all not purchase orders answer 400 with the sentence, unreported', async () => {
    mockClaudeJson.mockResolvedValue(NOT_A_PO_ANSWER);
    const res = await POST(scanRequest([jpeg('IMG_0001.jpg'), jpeg('IMG_0002.jpg')], 'separate'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'validation_error', message: NOT_A_PO });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('in separate mode the one file that is not a purchase order carries the sentence, the other imports', async () => {
    mockClaudeJson.mockResolvedValueOnce(PO_ANSWER).mockResolvedValueOnce(NOT_A_PO_ANSWER);
    const res = await POST(scanRequest([jpeg('PO-001.jpg'), jpeg('IMG_0002.jpg')], 'separate'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.imports).toHaveLength(1);
    expect(json.failed).toEqual([{ fileName: 'IMG_0002.jpg', message: NOT_A_PO }]);
    expect(reportError).not.toHaveBeenCalled();
  });
});

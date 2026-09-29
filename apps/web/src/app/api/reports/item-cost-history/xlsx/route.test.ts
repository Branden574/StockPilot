import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { escapeForSpreadsheet } from '@/lib/csv';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { ServiceError } from '@/server/services/context';
import { ReportsService } from '@/server/services/reports';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({
  exportRateLimited: vi.fn(async () => null),
}));
vi.mock('@/server/services/reports', () => ({ ReportsService: vi.fn() }));

function buildCtx() {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin' as const,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>([]),
  };
}

function request(itemId = '11111111-2222-4333-8444-555555555555') {
  return new Request(
    `https://test.local/api/reports/item-cost-history/xlsx?itemId=${itemId}`,
    { method: 'GET' },
  );
}

/** Reads the response back as a workbook and returns row 2's cell texts. */
async function firstDataRow(res: Response): Promise<string[]> {
  const buf = await res.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0]!;
  const row = ws.getRow(2);
  const out: string[] = [];
  row.eachCell({ includeEmpty: true }, (cell) => {
    out.push(String(cell.value ?? ''));
  });
  return out;
}

/**
 * Security wave E — spreadsheet-formula-injection parity. `lib/csv.ts`
 * exports ONE guard (`escapeForSpreadsheet`) that every other exporter uses;
 * this route hand-rolled `/^[=+\-@]/`, which misses TAB and CARRIAGE RETURN.
 * The assertions below are on the PROPERTY — "no cell reaches the workbook
 * still able to start a formula" — driven off the shared guard, so they hold
 * whatever the guard's exact neutralization strategy becomes.
 */
const FORMULA_LEAD_INS = ['=', '+', '-', '@', '\t', '\r'] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue(buildCtx() as never);
});

describe('GET /api/reports/item-cost-history/xlsx — formula guard', () => {
  it.each(FORMULA_LEAD_INS)(
    'neutralizes a supplier name starting with %j',
    async (lead) => {
      const hostile = `${lead}HYPERLINK("http://evil.test","click")`;
      vi.mocked(ReportsService).mockImplementation(function () {
        return {
          gate: () => {},
          itemCostHistoryReport: async () => ({
            series: [
              {
                supplierName: hostile,
                points: [{ date: '2026-08-01', source: 'receipt', unitCost: 12 }],
              },
            ],
          }),
        } as never;
      });

      const res = await GET(request());
      expect(res.status).toBe(200);

      const [supplier] = await firstDataRow(res);
      // The written cell must NOT still begin with a formula lead-in...
      expect(FORMULA_LEAD_INS.some((c) => supplier!.startsWith(c))).toBe(false);
      // ...and must match what the shared guard produces, so this exporter
      // can never drift from the others again. Newlines are normalized on
      // both sides: the xlsx XML round-trip rewrites a bare CR as LF, which
      // is a property of the file format, not of the guard.
      const normalize = (s: string) => s.replace(/\r\n?/g, '\n');
      expect(normalize(supplier!)).toBe(normalize(escapeForSpreadsheet(hostile)));
    },
  );

  it('leaves an ordinary supplier name untouched and keeps unit cost numeric', async () => {
    vi.mocked(ReportsService).mockImplementation(function () {
      return {
        gate: () => {},
        itemCostHistoryReport: async () => ({
          series: [
            {
              supplierName: 'Acme Supply',
              points: [{ date: '2026-08-01', source: 'po', unitCost: 12.5 }],
            },
          ],
        }),
      } as never;
    });

    const res = await GET(request());
    const cells = await firstDataRow(res);
    expect(cells[0]).toBe('Acme Supply');
    expect(cells[3]).toBe('12.5');
  });
});

/**
 * Security invariant (2026-09-28): reports:export (MFA step-up first), the
 * report gate (reports:read and the purchase orders module) and the item id
 * are checked BEFORE the shared export limit, and the item must be one the
 * caller can read. Refusals keep their real status (they were all 500).
 */
describe('GET /api/reports/item-cost-history/xlsx — checks before the export budget', () => {
  it('no reports:export: 403, budget untouched, service never built', async () => {
    vi.mocked(withApiContext).mockResolvedValue({ ...buildCtx(), role: 'staff' } as never);
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(exportRateLimited).not.toHaveBeenCalled();
    expect(ReportsService).not.toHaveBeenCalled();
  });

  it('the report gate refuses (no reports:read, or purchase orders off): 403, budget untouched', async () => {
    const itemCostHistoryReport = vi.fn();
    vi.mocked(ReportsService).mockImplementation(function () {
      return {
        gate: () => {
          throw new ServiceError('module_disabled', 'off');
        },
        itemCostHistoryReport,
      } as never;
    });
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(exportRateLimited).not.toHaveBeenCalled();
    expect(itemCostHistoryReport).not.toHaveBeenCalled();
  });

  it('a malformed item id: 400, budget untouched', async () => {
    vi.mocked(ReportsService).mockImplementation(function () {
      return { gate: () => {}, itemCostHistoryReport: vi.fn() } as never;
    });
    const res = await GET(request('item-1'));
    expect(res.status).toBe(400);
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it('an item the caller cannot read: 404 (was 500, and before 0380 a workbook of its costs)', async () => {
    vi.mocked(ReportsService).mockImplementation(function () {
      return {
        gate: () => {},
        itemCostHistoryReport: async () => {
          throw new ServiceError('not_found', 'Item not found.');
        },
      } as never;
    });
    const res = await GET(request());
    expect(res.status).toBe(404);
  });
});

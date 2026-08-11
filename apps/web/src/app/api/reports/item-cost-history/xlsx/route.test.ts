import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { escapeForSpreadsheet } from '@/lib/csv';
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

function request(itemId = 'item-1') {
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
      vi.mocked(ReportsService).mockImplementation(
        () =>
          ({
            itemCostHistory: async () => ({
              series: [
                {
                  supplierName: hostile,
                  points: [{ date: '2026-08-01', source: 'receipt', unitCost: 12 }],
                },
              ],
            }),
          }) as never,
      );

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
    vi.mocked(ReportsService).mockImplementation(
      () =>
        ({
          itemCostHistory: async () => ({
            series: [
              {
                supplierName: 'Acme Supply',
                points: [{ date: '2026-08-01', source: 'po', unitCost: 12.5 }],
              },
            ],
          }),
        }) as never,
    );

    const res = await GET(request());
    const cells = await firstDataRow(res);
    expect(cells[0]).toBe('Acme Supply');
    expect(cells[3]).toBe('12.5');
  });
});

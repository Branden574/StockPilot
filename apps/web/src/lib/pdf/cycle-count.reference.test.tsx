import { describe, expect, it } from 'vitest';

import { CycleCountSheetPdf, type CycleCountPdfHeader } from './cycle-count';

/**
 * The PDF component is a pure function of its props: render it as an element
 * tree and read the title and subtitle it hands to the page header, without
 * building a PDF byte stream.
 */
function headerProps(cycle: CycleCountPdfHeader): { title: string; subtitle: string } {
  const doc = CycleCountSheetPdf({ cycle, lines: [], org: { name: 'Acme', logoUrl: null } }) as unknown as {
    props: { title: string; children: unknown };
  };
  let found: { title: string; subtitle: string } | null = null;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || found) return;
    const n = node as { props?: Record<string, unknown> };
    if (n.props && typeof n.props.title === 'string' && typeof n.props.subtitle === 'string') {
      found = { title: n.props.title, subtitle: n.props.subtitle };
      return;
    }
    const kids = n.props?.children;
    if (Array.isArray(kids)) kids.forEach(walk);
    else walk(kids);
  };
  walk(doc);
  if (!found) throw new Error('page header not found');
  return found;
}

const base: CycleCountPdfHeader = {
  id: 'cc-1',
  warehouseName: null,
  notes: null,
  startedAt: '2026-09-23T03:00:00Z',
  status: 'in_progress',
};

describe('CycleCountSheetPdf title and subtitle', () => {
  it('titles the sheet and the variance report by the reference', () => {
    expect(headerProps({ ...base, countNumber: 42 }).title).toBe('Cycle count CC-000042');
    expect(headerProps({ ...base, countNumber: 1234567, status: 'completed' }).title).toBe(
      'Cycle count variance CC-1234567',
    );
  });

  it('prints no uuid fragment when the number is missing', () => {
    const { title } = headerProps({ ...base, countNumber: null });
    expect(title).toBe('Cycle count sheet');
    expect(title).not.toContain('cc-1');
  });

  it('labels a mixed selection as selected items, an org-wide count as all warehouses', () => {
    expect(headerProps({ ...base, countNumber: 1, warehouseId: null, scope: 'selection' }).subtitle).toMatch(
      /^Selected items · /,
    );
    expect(headerProps({ ...base, countNumber: 1, warehouseId: null, scope: 'warehouse' }).subtitle).toMatch(
      /^All warehouses · /,
    );
  });

  it('prints the start date in the workspace timezone', () => {
    // 03:00 UTC on Sep 23 is still Sep 22 in Los Angeles, and Sep 23 in Tokyo.
    expect(headerProps({ ...base, countNumber: 1, timeZone: 'America/Los_Angeles' }).subtitle).toContain('Sep 22');
    expect(headerProps({ ...base, countNumber: 1, timeZone: 'Asia/Tokyo' }).subtitle).toContain('Sep 23');
  });
});

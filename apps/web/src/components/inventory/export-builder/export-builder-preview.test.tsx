import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ExportPreviewResponse } from '@/lib/download-export';
import type { InventoryExportSourceRow } from '@/lib/exports/source-row';

import { ExportBuilderPreview } from './export-builder-preview';
import { initialExportBuilderState, moveField, setFormat } from './export-builder-state';

function sampleRow(overrides: Partial<InventoryExportSourceRow> = {}): InventoryExportSourceRow {
  return {
    id: 'i-1',
    itemType: 'book',
    name: 'Introduction to Algorithms',
    sku: 'BK-0001',
    barcode: '9780262033848',
    status: 'active',
    quantityOnHand: 4,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitCost: 42,
    retailPrice: 89,
    category: 'Mathematics',
    primaryLocation: 'DC4',
    supplier: '',
    warehouse: 'North',
    charter: 'Generic',
    trackingType: 'none',
    author: 'Cormen',
    isbn: '9780262033848',
    grade: 'College',
    rackNumber: '38',
    rackRow: 'A',
    crateColor: 'blue',
    crateNumber: '12',
    rackLabel: '38-A',
    crateLabel: 'Blue 12',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    image: null,
    // Legacy-only (see source-row.ts) — the field registry never reads this,
    // but the row shape requires it. Same fixture pattern as
    // field-registry.test.ts's sampleRow.
    legacyRawBookFields: {
      grade: 'College',
      rackNumber: '38',
      rackRow: 'A',
      crateColor: 'blue',
      crateNumber: '12',
    },
    ...overrides,
  };
}

const PREVIEW: ExportPreviewResponse = {
  total: 111,
  truncated: false,
  slug: 'books',
  sampleRows: [sampleRow(), sampleRow({ id: 'i-2', name: 'Discrete Mathematics', isbn: '' })],
  readiness: { rows: 111, withIsbn: 97, missingIsbn: 14, withImage: 84, missingImage: 27 },
};

function renderPreview(overrides: Partial<Parameters<typeof ExportBuilderPreview>[0]> = {}) {
  render(
    <ExportBuilderPreview
      state={initialExportBuilderState('book')}
      itemTypeKind="book"
      preview={PREVIEW}
      rowCount={111}
      {...overrides}
    />,
  );
}

describe('ExportBuilderPreview — the sample table', () => {
  it('renders one column per selected field, under the export heading', () => {
    renderPreview();
    const table = screen.getByRole('table', { name: 'Export preview' });
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers[0]).toBe('Cover');
    expect(headers[1]).toBe('Title');
    expect(headers[2]).toBe('ISBN');
  });

  it('follows the chosen order, not the registry order', () => {
    const state = moveField(initialExportBuilderState('book'), 'isbn', 'top');
    renderPreview({ state });
    const table = screen.getByRole('table', { name: 'Export preview' });
    expect(within(table).getAllByRole('columnheader')[0]!.textContent).toBe('ISBN');
  });

  it('shows real sample values, and an em dash where a value is missing', () => {
    renderPreview();
    const table = screen.getByRole('table', { name: 'Export preview' });
    expect(within(table).getByText('Introduction to Algorithms')).toBeTruthy();
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders the image column as a labelled placeholder, never a signed URL', () => {
    renderPreview();
    const table = screen.getByRole('table', { name: 'Export preview' });
    expect(within(table).getAllByText('Image').length).toBeGreaterThan(0);
    expect(table.textContent).not.toContain('https://');
  });

  it('says Image URL in the CSV preview heading', () => {
    renderPreview({ state: setFormat(initialExportBuilderState('book'), 'csv', 'book') });
    const table = screen.getByRole('table', { name: 'Export preview' });
    expect(within(table).getAllByRole('columnheader')[0]!.textContent).toBe('Image URL');
  });

  it('shows a waiting message rather than an empty table before the preview arrives', () => {
    renderPreview({ preview: null });
    expect(screen.getByText('Loading a sample of this export…')).toBeTruthy();
  });
});

describe('ExportBuilderPreview — readiness', () => {
  it('reports ISBN and cover coverage in the brief\'s shape', () => {
    renderPreview();
    const panel = screen.getByRole('group', { name: 'Export readiness' });
    expect(panel.textContent).toContain('97 of 111 books have an ISBN');
    expect(panel.textContent).toContain('84 of 111 have a cover');
    expect(panel.textContent).toContain('14 missing ISBN');
    expect(panel.textContent).toContain('27 missing cover');
  });

  it('never presents readiness as a blocker', () => {
    renderPreview();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('drops the cover line when the export has no image field', () => {
    const state = initialExportBuilderState('other');
    renderPreview({ state, itemTypeKind: 'other' });
    const panel = screen.getByRole('group', { name: 'Export readiness' });
    expect(panel.textContent).not.toContain('cover');
  });

  it('notes when the row cap truncated the set', () => {
    renderPreview({ preview: { ...PREVIEW, truncated: true, total: 41230 } });
    expect(
      screen.getByText('Only the first 10,000 records are included in this export.'),
    ).toBeTruthy();
  });

  // Self-mutation check: hardcoding PREVIEW's own readiness numbers (97/111,
  // 84/111, 14, 27) into the component still passed every test above, because
  // those literals happen to equal the fixture's real values — a tautology
  // that would hide a "computed instead of read from the response" bug. This
  // test uses numbers no plausible literal would coincidentally match, so it
  // only passes if the panel actually reads `preview.readiness`.
  it('renders the readiness numbers from the response, not any fixed value', () => {
    renderPreview({
      preview: {
        ...PREVIEW,
        readiness: { rows: 583, withIsbn: 71, missingIsbn: 512, withImage: 9, missingImage: 574 },
      },
    });
    const panel = screen.getByRole('group', { name: 'Export readiness' });
    expect(panel.textContent).toContain('71 of 583 books have an ISBN');
    expect(panel.textContent).toContain('512 missing ISBN');
    expect(panel.textContent).toContain('9 of 583 have a cover');
    expect(panel.textContent).toContain('574 missing cover');
  });

  // Self-mutation check: the brief's own truncation test only covers the
  // positive case. Without this negative case, a mutant that always renders
  // the "first 10,000" note (dropping the `preview.truncated` guard entirely)
  // still passed the whole suite above.
  it('omits the truncation note when the export was not truncated', () => {
    renderPreview();
    expect(
      screen.queryByText('Only the first 10,000 records are included in this export.'),
    ).toBeNull();
  });
});

describe('ExportBuilderPreview — sample row cap', () => {
  // Self-mutation check: the component slices sample rows to show only the first
  // 5. The original fixture supplied only 2 rows, so this cap was never tested —
  // changing slice(0, 5) to slice(0, 2) or removing it entirely would pass all
  // existing tests. This test provides a fixture with 7 rows and verifies that
  // exactly 5 render, catching mutations to the slice threshold.
  it('renders exactly the first 5 sample rows, not all rows or a different cap', () => {
    const sevenRowPreview: ExportPreviewResponse = {
      total: 111,
      truncated: false,
      slug: 'books',
      sampleRows: [
        sampleRow({ id: 'i-1', name: 'Introduction to Algorithms', isbn: '9780262033848' }),
        sampleRow({ id: 'i-2', name: 'Discrete Mathematics', isbn: '9780201379624' }),
        sampleRow({ id: 'i-3', name: 'The Art of Computer Programming', isbn: '9780201896830' }),
        sampleRow({ id: 'i-4', name: 'Structure and Interpretation', isbn: '9780262011632' }),
        sampleRow({ id: 'i-5', name: 'A Concrete Introduction', isbn: '9780130279996' }),
        sampleRow({ id: 'i-6', name: 'Concrete Mathematics', isbn: '9780201558020' }),
        sampleRow({ id: 'i-7', name: 'The Pragmatic Programmer', isbn: '9780135957059' }),
      ],
      readiness: { rows: 111, withIsbn: 97, missingIsbn: 14, withImage: 84, missingImage: 27 },
    };

    renderPreview({ preview: sevenRowPreview });
    const table = screen.getByRole('table', { name: 'Export preview' });

    // Verify that rows 1–5 are present
    expect(within(table).getByText('Introduction to Algorithms')).toBeTruthy();
    expect(within(table).getByText('Discrete Mathematics')).toBeTruthy();
    expect(within(table).getByText('The Art of Computer Programming')).toBeTruthy();
    expect(within(table).getByText('Structure and Interpretation')).toBeTruthy();
    expect(within(table).getByText('A Concrete Introduction')).toBeTruthy();

    // Verify that row 6 (and row 7) are NOT rendered
    expect(within(table).queryByText('Concrete Mathematics')).toBeNull();
    expect(within(table).queryByText('The Pragmatic Programmer')).toBeNull();
  });
});

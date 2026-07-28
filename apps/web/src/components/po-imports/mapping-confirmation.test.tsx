import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Radix Select needs pointer-capture APIs happy-dom doesn't implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

const { mockConfirm } = vi.hoisted(() => ({
  mockConfirm: vi.fn(async () => ({ ok: true as const, data: { confirmed: 1 } })),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/server/actions/po-imports', () => ({
  confirmPoImportMappingsAction: mockConfirm,
}));

import { MappingConfirmation } from './mapping-confirmation';

import type { PoImportLineRow } from '@/server/services/po-imports';

/**
 * The confirmation step has to be able to NAME everything it decides about.
 *
 * `lineNeedsMappingConfirmation` flags a line on any of the ten mapped sports
 * fields, but this screen used to print `jersey_number` alone — so a
 * low-confidence size, colour or style hint was decided about without ever
 * being shown, and then survived "Ignore" at mapping_confidence 1.
 */

const LINE: PoImportLineRow = {
  id: 'l1',
  po_import_id: 'imp-1',
  line_number: 1,
  line_type: 'inventory',
  qty_ordered_original: 3,
  uom_original: 'EA',
  description: 'Falcons Home Jersey',
  unit_cost: 40,
  line_total: 120,
  vendor_item_number: null,
  vendor_product_number: null,
  auxiliary_number: null,
  coa_code: null,
  item_id: null,
  suggested_item_id: null,
  match_status: 'needs_review',
  match_confidence: null,
  extraction_confidence: 0.95,
  exception_reason: null,
  variant_size: 'M',
  variant_size_original: 'M',
  variant_size_system: null,
  variant_width: null,
  variant_fit: null,
  variant_color: 'Red/Black',
  jersey_number: '12',
  player_name: null,
  group_hint: 'Falcons Home Jersey',
  serial_hint: null,
  suggested_group_id: null,
  mapping_confidence: 0.4,
};

function renderStep(over: Partial<PoImportLineRow> = {}) {
  const line = { ...LINE, ...over };
  return render(
    <MappingConfirmation
      poImportId="11111111-1111-4111-8111-111111111111"
      lines={[line]}
      editable
      onConfirmed={() => {}}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('MappingConfirmation — every flagged value is visible', () => {
  it('shows each flagged field with its label and printed value', () => {
    renderStep();
    // The number the old screen showed…
    expect(screen.getByTestId('flagged-jersey_number')).toHaveTextContent('12');
    // …and the four it hid.
    expect(screen.getByTestId('flagged-variant_size')).toHaveTextContent('Size: M');
    expect(screen.getByTestId('flagged-variant_color')).toHaveTextContent('Red/Black');
    expect(screen.getByTestId('flagged-group_hint')).toHaveTextContent('Falcons Home Jersey');
    expect(screen.getByTestId('flagged-variant_size_original')).toBeInTheDocument();
  });

  it('does not list a field the document left empty', () => {
    renderStep();
    expect(screen.queryByTestId('flagged-variant_width')).not.toBeInTheDocument();
    expect(screen.queryByTestId('flagged-serial_hint')).not.toBeInTheDocument();
  });

  it('offers the column meanings when there IS a number to reinterpret', async () => {
    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toHaveTextContent('Jersey / uniform number');
    expect(listbox).toHaveTextContent('Serial number');
    expect(listbox).toHaveTextContent('Ignore — clear these values');
  });

  it('offers only confirm / ignore for a line flagged without a number column', async () => {
    const user = userEvent.setup();
    renderStep({ jersey_number: null });
    // Still flagged — on the colour — so the row is here and answerable.
    expect(screen.getByTestId('flagged-variant_color')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toHaveTextContent('These values are right as read');
    expect(listbox).toHaveTextContent('Ignore — clear these values');
    expect(listbox).not.toHaveTextContent('Jersey / uniform number');
  });

  it('sends the chosen meaning for the flagged line', async () => {
    const user = userEvent.setup();
    renderStep({ jersey_number: null });
    await user.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    await user.click(
      await screen.findByRole('option', { name: 'Ignore — clear these values' }),
    );
    expect(listbox).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /confirm mappings/i }));
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ decisions: { l1: 'ignore' } }),
    );
  });

  it('renders nothing when no line is flagged', () => {
    const { container } = renderStep({ mapping_confidence: 0.99 });
    expect(container).toBeEmptyDOMElement();
  });
});

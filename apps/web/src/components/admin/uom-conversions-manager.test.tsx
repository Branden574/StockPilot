import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * UoM conversions in the redesign (W-AD-06): every add-form field is named
 * by its label with its defaults, the table keeps its columns, ratio and the
 * stored rounding value, and the delete confirm shows a refusal inside it.
 */

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const actions = vi.hoisted(() => ({ upsert: vi.fn(), remove: vi.fn() }));
vi.mock('@/server/actions/uom-conversions', () => ({
  upsertUomConversionAction: actions.upsert,
  deleteUomConversionAction: actions.remove,
}));

import { UomConversionsManager } from './uom-conversions-manager';

const CONVERSION = {
  id: 'u1',
  item_id: 'i1',
  from_uom: 'CT',
  to_uom: 'EA',
  numerator: 24,
  denominator: 2,
  rounding_rule: 'floor',
} as never;

beforeEach(() => vi.clearAllMocks());

describe('UomConversionsManager', () => {
  it('names every add-form field with its defaults and keeps the table', () => {
    render(
      <UomConversionsManager
        conversions={[CONVERSION]}
        items={[{ id: 'i1', sku: 'AA-24', name: 'AA batteries' }]}
      />,
    );
    expect(screen.getByLabelText('Item')).toBeInTheDocument();
    expect(screen.getByLabelText('Rounding rule')).toBeInTheDocument();
    expect(screen.getByLabelText('From UoM')).toHaveValue('PK');
    expect(screen.getByLabelText('To UoM (base)')).toHaveValue('EA');
    expect(screen.getByLabelText(/Numerator/)).toHaveValue(24);
    expect(screen.getByLabelText('Denominator')).toHaveValue(1);
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Item', 'From', 'To', 'Ratio', 'Rounding', '']);
    expect(within(table).getByText('AA-24 — AA batteries')).toBeInTheDocument();
    expect(within(table).getByText('24 / 2')).toBeInTheDocument();
    expect(within(table).getByText('floor')).toBeInTheDocument();
  });

  it('says "No conversions yet. Add one above." when there are none', () => {
    render(<UomConversionsManager conversions={[]} items={[]} />);
    expect(screen.getByText('No conversions yet. Add one above.')).toBeInTheDocument();
  });

  it('keeps the delete confirm words and shows a refusal inside it', async () => {
    actions.remove.mockResolvedValue({ ok: false, error: { message: 'Not allowed.' } });
    render(<UomConversionsManager conversions={[CONVERSION]} items={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/Future receipts that rely on this conversion will fail/),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(actions.remove).toHaveBeenCalledWith('u1'));
    expect(await within(dialog).findByText('Not allowed.')).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});

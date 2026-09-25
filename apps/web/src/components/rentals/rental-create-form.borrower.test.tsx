import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogItem } from '@/components/orders/v2/types';

// ═══ CHECKING OUT TO SOMEONE WHO IS NOT IN STOCKPILOT ═══
//
// The form with the REAL borrower picker: what the operator types is what the
// rental is created with. A non-member borrower is a name plus an optional,
// format-checked email; a member is their user id plus their account email.

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m), success: vi.fn() } }));

const createRentalAction = vi.fn();
vi.mock('@/server/actions/rentals', () => ({
  createRentalAction: (input: unknown) => createRentalAction(input),
}));

vi.mock('@/lib/use-catalog-thumbnails', () => ({ useCatalogThumbnails: () => ({}) }));
vi.mock('@/components/orders/v2/aisle-bar', () => ({ AisleBar: () => null }));
vi.mock('@/components/orders/v2/toolbar', () => ({ Toolbar: () => null }));
vi.mock('@/components/orders/v2/catalog-grid', () => ({ CatalogGrid: () => null }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
}));

import { RentalCreateForm } from './rental-create-form';

const TENT: CatalogItem = {
  id: 'tent',
  sku: 'RENT-1',
  name: 'Event tent',
  warehouseId: 'wh-1',
  quantityOnHand: 5,
  reservedQuantity: 0,
  itemType: 'product',
  categoryId: null,
  categoryName: null,
  charterId: null,
  charterName: null,
  charterCode: null,
  rackLabel: null,
  imageUrl: null,
  lqip: null,
  price: null,
  reorderPoint: 0,
};

function renderForm() {
  // One tent already in this warehouse's rental cart, so Check out is live.
  localStorage.setItem(
    'rental-draft:wh-1',
    JSON.stringify({
      warehouseId: 'wh-1',
      charterId: null,
      fulfillmentType: 'pickup',
      onBehalfOf: null,
      notes: '',
      neededBy: '',
      lines: [{ itemId: 'tent', quantity: 1 }],
    }),
  );
  return render(
    <RentalCreateForm
      warehouses={[{ id: 'wh-1', name: 'Main' }]}
      warehouseId="wh-1"
      items={[TENT]}
      aisles={[]}
      members={[{ userId: 'u-jane', displayName: 'Jane Doe', email: 'jane@l4l.org' }]}
      viewerRole="admin"
    />,
  );
}

const nameBox = () => screen.getByRole('combobox', { name: 'Borrower' });
const emailBox = () => screen.getByLabelText('Borrower email (optional)');
async function checkOut() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check out' }));
  });
}

describe('RentalCreateForm — the borrower', () => {
  beforeEach(() => {
    localStorage.clear();
    push.mockReset();
    toastError.mockReset();
    createRentalAction.mockReset();
    createRentalAction.mockResolvedValue({ ok: true, data: { id: 'rental-1' } });
  });
  afterEach(() => localStorage.clear());

  it('someone not in StockPilot: their name and email go on the rental', async () => {
    renderForm();
    fireEvent.change(nameBox(), { target: { value: '  Pat Visitor ' } });
    fireEvent.change(emailBox(), { target: { value: ' pat@site.org ' } });
    await checkOut();

    expect(createRentalAction).toHaveBeenCalledTimes(1);
    expect(createRentalAction.mock.calls[0]![0]).toMatchObject({
      borrowerUserId: null,
      borrowerName: 'Pat Visitor',
      borrowerEmail: 'pat@site.org',
    });
  });

  it('no email is fine: the rental is created without one', async () => {
    renderForm();
    fireEvent.change(nameBox(), { target: { value: 'Pat Visitor' } });
    await checkOut();
    expect(createRentalAction.mock.calls[0]![0]).toMatchObject({
      borrowerUserId: null,
      borrowerName: 'Pat Visitor',
      borrowerEmail: null,
    });
  });

  it('a malformed email stops the checkout with the same message as before', async () => {
    renderForm();
    fireEvent.change(nameBox(), { target: { value: 'Pat Visitor' } });
    fireEvent.change(emailBox(), { target: { value: 'pat@site' } });
    await checkOut();
    expect(toastError).toHaveBeenCalledWith('Enter a valid borrower email, or leave it blank.');
    expect(createRentalAction).not.toHaveBeenCalled();
  });

  it('a team member: their id and account email, whatever was typed before', async () => {
    renderForm();
    fireEvent.change(nameBox(), { target: { value: 'Pat Visitor' } });
    fireEvent.change(emailBox(), { target: { value: 'pat@site.org' } });
    fireEvent.change(nameBox(), { target: { value: 'Jan' } });
    fireEvent.click(screen.getByRole('option', { name: /Jane Doe/ }));
    await checkOut();
    expect(createRentalAction.mock.calls[0]![0]).toMatchObject({
      borrowerUserId: 'u-jane',
      borrowerName: 'Jane Doe',
      borrowerEmail: 'jane@l4l.org',
    });
  });

  it('no name: still refused', async () => {
    renderForm();
    await checkOut();
    expect(toastError).toHaveBeenCalledWith('Enter a borrower name.');
    expect(createRentalAction).not.toHaveBeenCalled();
  });
});

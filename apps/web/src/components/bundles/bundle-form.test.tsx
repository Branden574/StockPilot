import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/bundles', () => ({
  createBundleAction: vi.fn(),
  updateBundleAction: vi.fn(),
}));

import { toast } from 'sonner';

import { createBundleAction, updateBundleAction } from '@/server/actions/bundles';

import { COMPONENT_SEARCH_DEBOUNCE_MS } from './bundle-component-picker';
import { BundleForm } from './bundle-form';

const KIT_SKU = /^KIT-[0-9A-Z]{5}-[0-9A-Z]{7}$/;

describe('BundleForm SKU: Auto', () => {
  it('fills the SKU with a generated KIT- code', () => {
    render(<BundleForm />);
    const input = screen.getByLabelText(/SKU/) as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(input.value).toMatch(KIT_SKU);
  });

  it('a second click gives a different code, and it replaces a typed one', () => {
    render(<BundleForm />);
    const input = screen.getByLabelText(/SKU/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'NHB' } });
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    const first = input.value;
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(first).toMatch(KIT_SKU);
    expect(input.value).toMatch(KIT_SKU);
    expect(input.value).not.toBe(first);
  });

  it('is offered when editing too', () => {
    render(
      <BundleForm
        initial={{
          id: 'b-1',
          name: 'Kit',
          sku: 'OLD',
          description: null,
          preassemblyEnabled: false,
          components: [],
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Auto' })).toBeInTheDocument();
  });
});

describe('BundleForm components: the search picker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('Enter adds the best match as a component row, which then shows as Added, and the form is not submitted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: 'i-pencil',
            sku: 'PEN-2',
            name: 'Pencil No. 2',
            barcode: null,
            item_type: 'product',
            quantity_on_hand: 40,
            awaiting_first_receipt: false,
            warehouse_name: 'DC4',
            match: 'prefix',
          },
        ],
        total: 1,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const settle = async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(COMPONENT_SEARCH_DEBOUNCE_MS);
      });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
    };

    render(<BundleForm />);
    const search = screen.getByRole('combobox');
    search.focus();
    fireEvent.change(search, { target: { value: 'pencil' } });
    await settle();
    fireEvent.keyDown(search, { key: 'Enter' });

    const table = screen.getByRole('table');
    expect(within(table).getByText('Pencil No. 2')).toBeInTheDocument();
    expect(within(table).getByText('PEN-2')).toBeInTheDocument();
    expect(createBundleAction).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: 'pencil' } });
    await settle();
    expect(screen.getByRole('option')).toHaveTextContent('Added');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('BundleForm checkboxes and lines (redesign: the shared Checkbox)', () => {
  const initial = {
    id: 'b-1',
    name: 'Kit',
    sku: 'KIT-1',
    description: null,
    preassemblyEnabled: false,
    components: [
      { itemId: 'i-1', itemName: 'Pencil No. 2', itemSku: 'PEN-2', quantity: 1, isOptional: false },
      { itemId: 'i-2', itemName: 'Eraser', itemSku: 'ERS', quantity: 2, isOptional: false },
    ],
  };

  afterEach(() => {
    vi.mocked(updateBundleAction).mockReset();
    vi.mocked(createBundleAction).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it('Enable pre-boxing is one labelled checkbox described by its help, toggled once per click', () => {
    render(<BundleForm />);
    const box = screen.getByRole('checkbox', { name: 'Enable pre-boxing' });
    expect(box).toHaveAttribute('aria-checked', 'false');
    expect(box).toHaveAccessibleDescription(
      'Lets you decrement components ahead of time and hold the kits as phantom inventory until distribution.',
    );
    fireEvent.click(box);
    expect(box).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(box);
    expect(box).toHaveAttribute('aria-checked', 'false');
  });

  it('pre-boxing, Optional, a decimal Qty / kit and a removed line all reach the save', async () => {
    vi.mocked(updateBundleAction).mockResolvedValue({ ok: true, data: { id: 'b-1' } } as never);
    render(
      <BundleForm
        initial={{
          ...initial,
          components: [
            ...initial.components,
            { itemId: 'i-3', itemName: 'Ruler', itemSku: 'RUL', quantity: 1, isOptional: false },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable pre-boxing' }));
    const optional = screen.getAllByRole('checkbox', { name: 'Mark component as optional' });
    expect(optional).toHaveLength(3);
    fireEvent.click(optional[1]!);
    expect(optional[1]).toHaveAttribute('aria-checked', 'true');

    const qty = within(screen.getByRole('table')).getAllByRole('spinbutton')[0]!;
    fireEvent.change(qty, { target: { value: '0.5' } });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ruler' }));
    expect(screen.queryByText('Ruler')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    expect(updateBundleAction).toHaveBeenCalledWith({
      id: 'b-1',
      name: 'Kit',
      sku: 'KIT-1',
      description: null,
      preassemblyEnabled: true,
      components: [
        { itemId: 'i-1', quantity: 0.5, isOptional: false },
        { itemId: 'i-2', quantity: 2, isOptional: true },
      ],
    });
  });

  // 0415: the database builds no kit from a bundle whose components are all
  // optional, so the form says so before anything is sent.
  it('refuses a kit whose components are all optional, and says what to do', async () => {
    render(<BundleForm initial={initial} />);
    for (const box of screen.getAllByRole('checkbox', { name: 'Mark component as optional' })) {
      fireEvent.click(box);
    }
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    expect(toast.error).toHaveBeenLastCalledWith(
      'Mark at least one component as required. A kit made only of optional components could be built from nothing.',
    );
    expect(updateBundleAction).not.toHaveBeenCalled();
  });

  it('keeps its two refusals: a name, then at least one component', async () => {
    render(<BundleForm />);
    const form = screen.getByRole('button', { name: 'Create bundle' }).closest('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(toast.error).toHaveBeenLastCalledWith('Enter a bundle name.');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Kit' } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(toast.error).toHaveBeenLastCalledWith('Add at least one component to the bundle.');
    expect(createBundleAction).not.toHaveBeenCalled();
    expect(screen.getByText(/No components yet\. Search for items above/)).toBeInTheDocument();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/bundles', () => ({
  createBundleAction: vi.fn(),
  updateBundleAction: vi.fn(),
}));

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

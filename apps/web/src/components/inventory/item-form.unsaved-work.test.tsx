import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// "Refresh to update" reloads the page, and this form persists nothing until it
// is submitted, so it has to be able to say "I am holding unsaved work". Its
// only signal used to be a bubbling `change` event. Tags and size chips are
// buttons, and Auto SKU, the scanner and the lookups write through setValue():
// none of those fire `change`, so a form filled by tapping read as untouched
// and was reloaded over without a question.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));
vi.mock('@/server/actions/inventory', () => ({
  createItemAction: vi.fn(),
  updateItemAction: vi.fn(),
  bulkCreateSizedVariantsAction: vi.fn(),
}));
vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: vi.fn(),
  recordImageAction: vi.fn(),
}));
vi.mock('@/server/actions/tags', () => ({ setItemTagsAction: vi.fn() }));

import { getUnsavedSources, resetUnsavedSourcesForTests } from '@/lib/unsaved-work';

import { ItemForm } from './item-form';

function renderForm() {
  return render(
    <ItemForm
      categories={[]}
      locations={[]}
      suppliers={[]}
      warehouses={[]}
      warehouseCharters={[]}
      charters={[]}
      warehouseLabel="Warehouse"
      charterLabel="Charter"
    />,
  );
}

afterEach(() => resetUnsavedSourcesForTests());

describe('ItemForm: unsaved work', () => {
  it('an untouched form holds nothing', () => {
    renderForm();
    expect(getUnsavedSources()).toEqual([]);
  });

  it('typing in a field counts', () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText('Auto-generated if blank'), {
      target: { value: 'SKU-1' },
    });
    expect(getUnsavedSources()).toEqual([{ id: 'item-form', label: 'New item' }]);
  });

  it('a BUTTON that fills the form counts too: it writes through setValue and fires no change event', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(getUnsavedSources()).toEqual([{ id: 'item-form', label: 'New item' }]);
  });

  it('pressing the submit button on a pristine form is not an edit', () => {
    const { container } = renderForm();
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit).not.toBeNull();
    fireEvent.click(submit);
    expect(getUnsavedSources()).toEqual([]);
  });

  it('stops counting once the form is gone', () => {
    const { unmount } = renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    unmount();
    expect(getUnsavedSources()).toEqual([]);
  });
});

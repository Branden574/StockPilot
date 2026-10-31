import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The item form's Tags section on New and Edit item (docket T14). A tag's
// stored colour is plain text a manager can write through the Data API, and
// the New and Edit item pages render this form on the server, where a style
// value is copied into the HTML as given: an unchecked `;` added CSS
// declarations to the page. A colour that is not #rrggbb draws the default
// grey, for a selected chip (its fill) and an unselected one (its dot).

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
  findGroupCandidatesAction: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: vi.fn(),
  recordImageAction: vi.fn(),
}));
vi.mock('@/server/actions/tags', () => ({ setItemTagsAction: vi.fn() }));

import { ItemForm } from './item-form';

const INJECTED = '#000;position:fixed;inset:0;z-index:2147483647;background:#fff';

/** The server HTML of the form, parsed, with the tag chips by name. */
function serverRender() {
  const html = renderToString(
    <ItemForm
      categories={[{ id: 'cat-1', name: 'Apparel' }]}
      locations={[{ id: 'loc-1', name: 'Front room' }]}
      suppliers={[{ id: 'sup-1', name: 'Acme' }]}
      warehouses={[{ id: 'wh-1', name: 'North DC' }]}
      warehouseCharters={[]}
      charters={[]}
      warehouseLabel="Warehouse"
      charterLabel="Charter"
      tags={[
        { id: 't-on', name: 'Picked', color: INJECTED },
        { id: 't-off', name: 'Unpicked', color: INJECTED },
        { id: 't-ok', name: 'Fragile', color: '#f97316' },
      ]}
      initialTagIds={['t-on']}
    />,
  );
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const chip = (name: string) => {
    const found = [...doc.querySelectorAll('button[aria-pressed]')].find(
      (b) => b.textContent === name,
    );
    if (!found) throw new Error(`no tag chip named ${name}`);
    return { button: found, dot: found.querySelector('span')! };
  };
  return { html, chip };
}

describe('ItemForm tag chips: a stored colour that is not #rrggbb (docket T14)', () => {
  it('never reaches the server HTML', () => {
    // (Radix Select's hidden native select carries its own position:absolute.)
    const { html } = serverRender();
    expect(html).not.toContain('position:fixed');
    expect(html).not.toContain('z-index');
    expect(html).not.toContain('#000;');
  });

  it('a selected chip fills with the default grey, an unselected one draws a grey dot', () => {
    const { chip } = serverRender();
    const picked = chip('Picked');
    expect(picked.button.getAttribute('aria-pressed')).toBe('true');
    expect(picked.button.getAttribute('style')).toBe('background-color:#94a3b8');
    expect(picked.dot.getAttribute('style')).toBeNull();
    const unpicked = chip('Unpicked');
    expect(unpicked.button.getAttribute('aria-pressed')).toBe('false');
    expect(unpicked.button.getAttribute('style')).toBeNull();
    expect(unpicked.dot.getAttribute('style')).toBe('background-color:#94a3b8');
  });

  it('a #rrggbb colour is still drawn', () => {
    const { chip } = serverRender();
    expect(chip('Fragile').dot.getAttribute('style')).toBe('background-color:#f97316');
  });
});

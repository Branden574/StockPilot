/**
 * The bundle component picker: search-as-you-type for items to add to a kit.
 *
 * It used to ask the command palette's /api/search, which searched items,
 * purchase orders, suppliers and warehouses and signed thumbnails on every
 * settled keystroke, returned five items in no relevance order, and swallowed
 * every failure, so an error looked like "no results". These tests pin the
 * replacement: one request per settled search to the items-only endpoint,
 * stale answers ignored, error and empty told apart, keyboard use, and items
 * already in the kit marked and not addable.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BundleComponentPicker,
  COMPONENT_SEARCH_DEBOUNCE_MS,
  type ComponentSearchItem,
} from './bundle-component-picker';

function item(
  id: string,
  name: string,
  over: Partial<ComponentSearchItem> = {},
): ComponentSearchItem {
  return {
    id,
    sku: `SKU-${id}`,
    name,
    barcode: null,
    item_type: 'product',
    quantity_on_hand: 3,
    awaiting_first_receipt: false,
    warehouse_name: 'DC4',
    ...over,
  };
}

type Answer =
  { items: ComponentSearchItem[]; total?: number } | { status: number } | { reject: true };

/** Requests made, in order, with the abort signal each was given. */
let requests: Array<{ url: URL; signal: AbortSignal | undefined }>;
/** q → the answer. */
let answers: Map<string, Answer>;
/** q → a gate the answer waits on. */
let gates: Map<string, Promise<void>>;

function installFetch() {
  requests = [];
  answers = new Map();
  gates = new Map();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: { signal?: AbortSignal }) => {
      const url = new URL(input, 'https://example.test');
      requests.push({ url, signal: init?.signal });
      const q = url.searchParams.get('q') ?? '';
      const gate = gates.get(q);
      if (gate) await gate;
      const answer = answers.get(q) ?? { items: [] };
      if ('reject' in answer) throw new TypeError('Failed to fetch');
      if ('status' in answer) {
        return {
          ok: false,
          status: answer.status,
          json: async () => ({ error: 'x' }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: answer.items, total: answer.total ?? answer.items.length }),
      } as unknown as Response;
    }),
  );
}

function hold(q: string): () => Promise<void> {
  let release!: () => void;
  gates.set(q, new Promise<void>((r) => (release = r)));
  return async () => {
    release();
    await flush();
  };
}

/** Lets pending promise callbacks (the fetch, its json, the state update) run. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

/** Waits out the debounce and lets the answer land. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(COMPONENT_SEARCH_DEBOUNCE_MS);
  });
  await flush();
}

function input(): HTMLInputElement {
  return screen.getByRole('combobox') as HTMLInputElement;
}

function type(value: string) {
  fireEvent.change(input(), { target: { value } });
}

function optionNames(): string[] {
  return screen
    .queryAllByRole('option')
    .map((o) => o.querySelector('.font-medium')?.textContent ?? '');
}

function renderPicker(opts: { added?: string[]; onAdd?: (i: ComponentSearchItem) => void } = {}) {
  const onAdd = opts.onAdd ?? vi.fn();
  render(<BundleComponentPicker addedIds={new Set(opts.added ?? [])} onAdd={onAdd} />);
  input().focus();
  return onAdd;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  installFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('requests', () => {
  it('typing a word fast makes ONE request, for the settled search', async () => {
    renderPicker();
    for (const v of ['p', 'pe', 'pen', 'penc', 'penci', 'pencil']) type(v);
    await settle();
    expect(requests.map((r) => r.url.searchParams.get('q'))).toEqual(['pencil']);
  });

  it('each pause long enough to settle makes one request; under two characters makes none', async () => {
    renderPicker();
    type('p');
    await settle();
    expect(requests).toHaveLength(0);
    type('pe');
    await settle();
    type('pen');
    await settle();
    type('pen ');
    await settle();
    // The trailing space is the same search: no third request.
    expect(requests.map((r) => r.url.searchParams.get('q'))).toEqual(['pe', 'pen']);
  });

  it('asks the items-only endpoint, ranked, with the component exclusions as parameters', async () => {
    renderPicker();
    type('pencil');
    await settle();
    const { url } = requests[0]!;
    expect(url.pathname).toBe('/api/items/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'pencil',
      rank: 'relevance',
      type: 'all',
      status: 'active',
      bundles: 'exclude',
      expected: 'any',
      isbn: '1',
      limit: '20',
    });
  });
});

describe('answers', () => {
  it('shows the rows in the order the server ranked them', async () => {
    answers.set('pen', {
      items: [item('a', 'Zebra marker'), item('b', 'Pencil'), item('c', 'Blue Pen')],
    });
    renderPicker();
    type('pen');
    await settle();
    expect(optionNames()).toEqual(['Zebra marker', 'Pencil', 'Blue Pen']);
  });

  it('a slow answer to an older search never replaces the newer one', async () => {
    answers.set('pe', { items: [item('old', 'Pear')] });
    answers.set('pen', { items: [item('new', 'Pencil')] });
    const releaseOld = hold('pe');
    renderPicker();
    type('pe');
    await settle();
    type('pen');
    await settle();
    expect(optionNames()).toEqual(['Pencil']);
    await releaseOld();
    expect(optionNames()).toEqual(['Pencil']);
    // The older request was aborted when the search moved on.
    expect(requests[0]!.signal?.aborted).toBe(true);
    expect(requests[1]!.signal?.aborted).toBe(false);
  });

  it('while the next answer loads, the last rows stay visible but cannot be added', async () => {
    answers.set('pen', { items: [item('a', 'Pen')] });
    answers.set('penc', { items: [item('b', 'Pencil')] });
    const onAdd = renderPicker();
    type('pen');
    await settle();
    type('penc');
    // Not settled yet: the Pen row is from the previous search.
    const stale = screen.getByRole('option');
    expect(stale).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.click(stale);
    expect(onAdd).not.toHaveBeenCalled();
    await settle();
    expect(optionNames()).toEqual(['Pencil']);
  });

  it('an empty answer says nothing matches, and why a known item may be missing', async () => {
    answers.set('zzz', { items: [] });
    renderPicker();
    type('zzz');
    await settle();
    expect(screen.getByText('No items match “zzz”.')).toBeInTheDocument();
    expect(screen.getByText(/Kits, rental equipment and archived items/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a failed request says so with Try again, and is never shown as no results', async () => {
    answers.set('pen', { status: 500 });
    renderPicker();
    type('pen');
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't search items.");
    expect(screen.queryByText(/No items match/)).not.toBeInTheDocument();

    answers.set('pen', { items: [item('a', 'Pencil')] });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(requests).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(optionNames()).toEqual(['Pencil']);
  });

  it('a network failure is an error too', async () => {
    answers.set('pen', { reject: true });
    renderPicker();
    type('pen');
    await settle();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('says how many matches it is not showing', async () => {
    answers.set('pen', {
      items: Array.from({ length: 20 }, (_, i) => item(`i${i}`, `Pen ${i}`)),
      total: 57,
    });
    renderPicker();
    type('pen');
    await settle();
    expect(
      screen.getByText('Showing 20 of 57 matches. Keep typing to narrow the list.'),
    ).toBeInTheDocument();
  });

  it('shows the SKU, the warehouse, the item type and Expected on a row', async () => {
    answers.set('char', {
      items: [
        item('b', "Charlotte's Web", {
          item_type: 'book',
          awaiting_first_receipt: true,
          quantity_on_hand: 0,
        }),
      ],
    });
    renderPicker();
    type('char');
    await settle();
    const row = screen.getByRole('option');
    expect(row).toHaveTextContent('SKU-b');
    expect(row).toHaveTextContent('DC4');
    expect(row).toHaveTextContent('Book');
    expect(row).toHaveTextContent('Expected');
    expect(row).toHaveTextContent('0 on hand');
  });
});

describe('keyboard and ARIA', () => {
  beforeEach(() => {
    answers.set('pen', { items: [item('a', 'Pen'), item('b', 'Pencil'), item('c', 'Pen cup')] });
  });

  it('ArrowDown/ArrowUp move the highlight; Enter adds the highlighted item', async () => {
    const onAdd = renderPicker();
    type('pen');
    await settle();
    const box = input();
    expect(box).toHaveAttribute('aria-expanded', 'true');
    const listbox = screen.getByRole('listbox');
    expect(box).toHaveAttribute('aria-controls', listbox.id);
    // The first row starts highlighted.
    expect(within(listbox).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    const active = within(listbox).getAllByRole('option')[1]!;
    expect(active).toHaveAttribute('aria-selected', 'true');
    expect(box).toHaveAttribute('aria-activedescendant', active.id);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 'b', name: 'Pencil' }));
    // Ready for the next item.
    expect(box.value).toBe('');
    expect(box).toHaveAttribute('aria-expanded', 'false');
  });

  it('Escape closes the list; a second Escape clears the search', async () => {
    renderPicker();
    type('pen');
    await settle();
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(input()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input().value).toBe('pen');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(input().value).toBe('');
  });

  it('ArrowDown reopens a closed list', async () => {
    renderPicker();
    type('pen');
    await settle();
    fireEvent.keyDown(input(), { key: 'Escape' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(input()).toHaveAttribute('aria-expanded', 'true');
  });

  it('Enter in the search box never submits the form around it', async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <BundleComponentPicker addedIds={new Set()} onAdd={vi.fn()} />
      </form>,
    );
    input().focus();
    type('zzz');
    // fireEvent returns false when the handler prevented the default action,
    // which for Enter in a form's text box is submitting the form.
    expect(fireEvent.keyDown(input(), { key: 'Enter' })).toBe(false);
    await settle();
    expect(fireEvent.keyDown(input(), { key: 'Enter' })).toBe(false);
    type('');
    expect(fireEvent.keyDown(input(), { key: 'Enter' })).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('a click adds the item', async () => {
    const onAdd = renderPicker();
    type('pen');
    await settle();
    fireEvent.click(screen.getAllByRole('option')[2]!);
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }));
  });
});

describe('items already in the bundle', () => {
  beforeEach(() => {
    answers.set('pen', { items: [item('a', 'Pen'), item('b', 'Pencil'), item('c', 'Pen cup')] });
  });

  it('are marked Added and cannot be clicked in again', async () => {
    const onAdd = renderPicker({ added: ['a'] });
    type('pen');
    await settle();
    const [first] = screen.getAllByRole('option');
    expect(first).toHaveAttribute('aria-disabled', 'true');
    expect(first).toHaveTextContent('Added');
    expect(first).not.toHaveTextContent('on hand');
    fireEvent.click(first!);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('are skipped by the highlight, so Enter adds the next one', async () => {
    const onAdd = renderPicker({ added: ['a', 'b'] });
    type('pen');
    await settle();
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }));
  });

  it('when every row is already added, Enter adds nothing', async () => {
    const onAdd = renderPicker({ added: ['a', 'b', 'c'] });
    type('pen');
    await settle();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onAdd).not.toHaveBeenCalled();
  });
});

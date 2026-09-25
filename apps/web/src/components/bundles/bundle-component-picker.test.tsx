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
    match: 'prefix',
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

/** The always-present polite live region. */
function liveRegion(): HTMLElement {
  return screen.getByRole('status');
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
    expect(screen.getByText('No items match “zzz”.', { selector: 'p' })).toBeInTheDocument();
    // What the list leaves out, including discontinued items (status=active).
    expect(
      screen.getByText(
        "Kits, rental equipment, and archived or discontinued items aren't listed here.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a failed request says so with Try again, and is never shown as no results', async () => {
    answers.set('pen', { status: 500 });
    renderPicker();
    type('pen');
    await settle();
    // A server error is not blamed on the network.
    expect(screen.getByRole('alert')).toHaveTextContent("Search didn't work. Try again.");
    expect(screen.getByRole('alert')).not.toHaveTextContent('connection');
    expect(screen.queryByText(/No items match/)).not.toBeInTheDocument();

    answers.set('pen', { items: [item('a', 'Pencil')] });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(requests).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(optionNames()).toEqual(['Pencil']);
  });

  it('a network failure is an error too, and says to check the connection', async () => {
    answers.set('pen', { reject: true });
    renderPicker();
    type('pen');
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't reach the server. Check your connection and try again.",
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('an ended session says to sign in again, with no Try again that cannot work', async () => {
    answers.set('pen', { status: 401 });
    renderPicker();
    type('pen');
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your session has ended. Refresh the page to sign in again.',
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
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

  it('a long name gets two lines and its full text on hover, and the details wrap instead of being cut off', async () => {
    const long =
      'Harry Potter and the Sorcerer’s Stone, Grade 5 Classroom Set, Paperback Edition';
    answers.set('harry', {
      items: [
        item('b', long, {
          item_type: 'book',
          awaiting_first_receipt: true,
          warehouse_name: 'Learn4Life Distribution Center 4',
        }),
      ],
    });
    renderPicker();
    type('harry');
    await settle();
    const row = screen.getByRole('option');
    const name = row.querySelector('.font-medium')!;
    expect(name).toHaveAttribute('title', long);
    expect(name).toHaveClass('line-clamp-2');
    expect(name).not.toHaveClass('truncate');
    const details = within(row).getByText('SKU-b').parentElement!;
    expect(details).toHaveClass('flex-wrap');
    expect(details).not.toHaveClass('truncate');
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

  it('the highlighted row carries a visible marker beyond the faint tint', async () => {
    renderPicker();
    type('pen');
    await settle();
    const [first, second] = screen.getAllByRole('option');
    const marker = 'shadow-[inset_3px_0_0_hsl(var(--accent-foreground))]';
    expect(first).toHaveClass(marker);
    expect(second).not.toHaveClass(marker);
  });
});

describe('the pointer and the keyboard', () => {
  const ten = Array.from({ length: 10 }, (_, i) => item(`id-${i}`, `Pen ${i}`));
  const at = { screenX: 400, screenY: 300 };

  function options() {
    return screen.getAllByRole('option');
  }

  function highlighted(): string | undefined {
    return options()
      .find((o) => o.getAttribute('aria-selected') === 'true')
      ?.id.replace(/^.*-option-/, '');
  }

  it('moving the pointer over a row highlights it', async () => {
    answers.set('pen', { items: ten });
    renderPicker();
    type('pen');
    await settle();
    fireEvent.mouseEnter(options()[2]!, { screenX: 400, screenY: 280 });
    fireEvent.mouseMove(options()[2]!, at);
    expect(highlighted()).toBe('id-2');
  });

  it('a list the arrow keys scroll under a still pointer keeps the row the keys reached, and Enter adds it', async () => {
    // Real Chrome, mouse resting on the list: each ArrowDown scrolls the list,
    // and the browser reports the row now under the pointer (mouseenter, and
    // a move at the same spot). That row used to take the highlight, so six
    // presses went id-3 id-4 id-3 id-4 id-5 id-4 and Enter added the wrong item.
    answers.set('pen', { items: ten });
    const onAdd = renderPicker();
    type('pen');
    await settle();
    fireEvent.mouseEnter(options()[1]!, { screenX: 400, screenY: 280 });
    fireEvent.mouseMove(options()[1]!, at);
    expect(highlighted()).toBe('id-1');
    for (let press = 1; press <= 6; press += 1) {
      fireEvent.keyDown(input(), { key: 'ArrowDown' });
      // The scroll slides another row under the still pointer.
      const under = options()[1 + Math.ceil(press / 2)]!;
      fireEvent.mouseEnter(under, at);
      fireEvent.mouseMove(under, at);
    }
    expect(highlighted()).toBe('id-7');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-7' }));
  });

  it('the list scrolls for the keys, never for the pointer', async () => {
    answers.set('pen', { items: ten });
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id.replace(/^.*-option-/, ''));
    };
    try {
      renderPicker();
      type('pen');
      await settle();
      scrolled.length = 0;
      fireEvent.mouseEnter(options()[4]!, { screenX: 400, screenY: 280 });
      fireEvent.mouseMove(options()[4]!, at);
      expect(highlighted()).toBe('id-4');
      expect(scrolled).toEqual([]);
      fireEvent.keyDown(input(), { key: 'ArrowDown' });
      expect(scrolled).toEqual(['id-5']);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe('what a screen reader hears', () => {
  it('one polite live region is always present, before anything is typed', () => {
    renderPicker();
    const region = liveRegion();
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(region).toHaveTextContent('');
    // The only status region: the visible messages do not announce twice.
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('says it is searching, then how many items matched and how to choose', async () => {
    answers.set('pen', {
      items: Array.from({ length: 20 }, (_, i) => item(`i${i}`, `Pen ${i}`)),
      total: 143,
    });
    renderPicker();
    type('pen');
    expect(liveRegion()).toHaveTextContent('Searching…');
    await settle();
    expect(liveRegion()).toHaveTextContent(
      '20 of 143 items. Use the up and down arrows to choose, Enter to add.',
    );
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('says one item, or all of them, when nothing is left out', async () => {
    answers.set('pen', { items: [item('a', 'Pen')] });
    answers.set('penc', { items: [item('a', 'Pen'), item('b', 'Pencil')] });
    renderPicker();
    type('pen');
    await settle();
    expect(liveRegion()).toHaveTextContent(
      '1 item. Use the up and down arrows to choose, Enter to add.',
    );
    type('penc');
    await settle();
    expect(liveRegion()).toHaveTextContent(
      '2 items. Use the up and down arrows to choose, Enter to add.',
    );
  });

  it('says when nothing matches', async () => {
    answers.set('zzq', { items: [] });
    renderPicker();
    type('zzq');
    await settle();
    expect(liveRegion()).toHaveTextContent('No items match “zzq”.');
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('says which item was added, after the list closes', async () => {
    answers.set('pen', { items: [item('a', 'Pen'), item('b', 'Pencil')] });
    renderPicker();
    type('pen');
    await settle();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input()).toHaveAttribute('aria-expanded', 'false');
    expect(liveRegion()).toHaveTextContent('Added Pencil.');
    // The next search replaces it.
    type('p');
    expect(liveRegion()).toHaveTextContent('');
  });

  it('leaves a failure to its alert', async () => {
    answers.set('pen', { status: 500 });
    renderPicker();
    type('pen');
    await settle();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent('');
  });
});

describe('a barcode scanner (the code and Enter, faster than the search)', () => {
  const HP = '9780439708180';

  it('adds the one exact match once the answer arrives, and clears the box for the next scan', async () => {
    answers.set(HP, {
      items: [
        item('hp', "Harry Potter and the Sorcerer's Stone", { barcode: HP, match: 'exact' }),
        item('x', 'Harry Potter box set', { match: 'contains' }),
      ],
    });
    const onAdd = renderPicker();
    type(HP);
    // Enter lands before the search has even been sent.
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onAdd).not.toHaveBeenCalled();
    await settle();
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 'hp' }));
    expect(input().value).toBe('');
    expect(liveRegion()).toHaveTextContent("Added Harry Potter and the Sorcerer's Stone.");
  });

  it('with no exact match, adds nothing and selects the code so the next scan replaces it', async () => {
    answers.set(HP, { items: [item('x', 'Harry Potter box set', { match: 'contains' })] });
    const onAdd = renderPicker();
    type(HP);
    fireEvent.keyDown(input(), { key: 'Enter' });
    await settle();
    expect(onAdd).not.toHaveBeenCalled();
    expect(input().value).toBe(HP);
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(HP.length);
    // Still there to choose from.
    expect(optionNames()).toEqual(['Harry Potter box set']);
  });

  it('two exact matches (one code in two warehouses) are a choice, not a guess', async () => {
    answers.set(HP, {
      items: [
        item('a', 'Harry Potter', { barcode: HP, match: 'exact', warehouse_name: 'DC4' }),
        item('b', 'Harry Potter', { barcode: HP, match: 'exact', warehouse_name: 'CVW' }),
      ],
    });
    const onAdd = renderPicker();
    type(HP);
    fireEvent.keyDown(input(), { key: 'Enter' });
    await settle();
    expect(onAdd).not.toHaveBeenCalled();
    expect(input().selectionEnd).toBe(HP.length);
  });

  it('an exact match already in the bundle is not added twice', async () => {
    answers.set(HP, { items: [item('hp', 'Harry Potter', { barcode: HP, match: 'exact' })] });
    const onAdd = renderPicker({ added: ['hp'] });
    type(HP);
    fireEvent.keyDown(input(), { key: 'Enter' });
    await settle();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('an Enter belongs to the search it was pressed on: typing on drops it', async () => {
    answers.set('SKU-1', { items: [item('one', 'One', { match: 'exact' })] });
    answers.set('SKU-12', { items: [item('twelve', 'Twelve', { match: 'exact' })] });
    const onAdd = renderPicker();
    type('SKU-1');
    fireEvent.keyDown(input(), { key: 'Enter' });
    type('SKU-12');
    await settle();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('Escape drops a waiting Enter', async () => {
    answers.set(HP, { items: [item('hp', 'Harry Potter', { barcode: HP, match: 'exact' })] });
    const onAdd = renderPicker();
    type(HP);
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.keyDown(input(), { key: 'Escape' });
    await settle();
    expect(onAdd).not.toHaveBeenCalled();
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

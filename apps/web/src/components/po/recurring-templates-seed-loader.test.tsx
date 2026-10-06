/**
 * "Make recurring" hands a purchase order's supplier, destination and lines to
 * Recurring purchase orders, which must open the create form filled in.
 *
 * Production 2026-10-05 (PR #326 check, Demo Co): the seed arrived (200, six
 * lines) and the page opened, but the form never did. The loader set the seed
 * in an effect AFTER the panel had mounted, the panel reads it only when it
 * mounts, and the loader had already deleted it from sessionStorage, so the
 * seed was dropped without a word (since e5db28b8, 2026-06-18).
 *
 * The hand-off is now tied to the navigation: the button stores the seed under
 * the PO's id and opens ?from=<that id>; the page takes it once and opens the
 * form only with the seed of the PO it was opened for.
 *
 * A destination the form does not offer (a staging area, a deleted location)
 * showed blank and was saved anyway (the claims review of What's New #333,
 * 2026-10-06): every purchase order the template created would have gone
 * there. The form now opens with no destination and says where the purchase
 * order went, so the buyer picks one.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRecurringTemplateAction } from '@/server/actions/recurring-pos';
import { hydrateAcrossClockShift } from '@/test/hydration';

// Radix Select needs pointer-capture APIs happy-dom doesn't implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

let searchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

vi.mock('@/server/actions/recurring-pos', () => ({
  setRecurringTemplateEnabledAction: vi.fn(),
  createRecurringTemplateAction: vi.fn(),
  updateRecurringTemplateAction: vi.fn(),
  deleteRecurringTemplateAction: vi.fn(),
}));

import { RecurringTemplatesSeedLoader } from './recurring-templates-seed-loader';

const KEY = 'recurring-po-seed';
const PO = '56048d0f-0000-4000-8000-000000000001';
const OTHER_PO = '56048d0f-0000-4000-8000-000000000002';

const SEED = {
  supplierId: 'sup-1',
  destinationLocationId: 'loc-1',
  lineItems: [
    { itemId: 'item-1', quantityOrdered: 50, unitCost: 16 },
    { itemId: 'item-2', quantityOrdered: 7, unitCost: 1.1 },
  ],
};

const PROPS = {
  initial: [],
  items: [
    { id: 'item-1', name: 'Laptop stand', sku: 'LS-1', unit_cost: 16 },
    { id: 'item-2', name: 'USB cable', sku: 'USB-2', unit_cost: 1.1 },
  ],
  suppliers: [
    { id: 'sup-1', name: 'TechSource Distributors' },
    { id: 'sup-2', name: 'Other Supplier' },
  ],
  locations: [
    { id: 'loc-1', name: 'Main Distribution Center' },
    { id: 'loc-2', name: 'North Site' },
  ],
  entitled: true,
};

function store(value: unknown) {
  sessionStorage.setItem(KEY, typeof value === 'string' ? value : JSON.stringify(value));
}

function expectFilledInForm() {
  expect(screen.getByText('New recurring template')).toBeInTheDocument();
  expect(screen.getAllByText('TechSource Distributors').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Main Distribution Center').length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Laptop stand/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/USB cable/).length).toBeGreaterThan(0);
  expect(screen.getByDisplayValue('50')).toBeInTheDocument();
  expect(screen.getByDisplayValue('7')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create template' })).toBeInTheDocument();
}

function expectListView() {
  expect(screen.queryByText('New recurring template')).toBeNull();
  expect(screen.getByText(/No recurring templates yet/)).toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  searchParams = new URLSearchParams();
});

describe('RecurringTemplatesSeedLoader', () => {
  it("Make recurring opens the create form filled in with the purchase order's supplier, destination and lines", () => {
    store({ poId: PO, ...SEED });
    searchParams = new URLSearchParams({ from: PO });

    render(<RecurringTemplatesSeedLoader {...PROPS} />);

    expectFilledInForm();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('takes the seed once: it leaves storage, and a later visit opens the list', () => {
    store({ poId: PO, ...SEED });
    searchParams = new URLSearchParams({ from: PO });

    const first = render(<RecurringTemplatesSeedLoader {...PROPS} />);
    expectFilledInForm();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    first.unmount();

    // A reload of the same address: nothing is left to open, and nothing to report.
    render(<RecurringTemplatesSeedLoader {...PROPS} />);
    expectListView();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('opens the form once under StrictMode (effects run twice), without an error', () => {
    store({ poId: PO, ...SEED });
    searchParams = new URLSearchParams({ from: PO });

    render(
      <React.StrictMode>
        <RecurringTemplatesSeedLoader {...PROPS} />
      </React.StrictMode>,
    );

    expectFilledInForm();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a seed left behind by a Make recurring that never arrived is removed on a plain visit and never opens the form', () => {
    store({ poId: PO, ...SEED });

    render(<RecurringTemplatesSeedLoader {...PROPS} />);

    expectListView();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("another purchase order's seed never opens: the list stays, and the page says so", () => {
    store({ poId: OTHER_PO, ...SEED });
    searchParams = new URLSearchParams({ from: PO });

    render(<RecurringTemplatesSeedLoader {...PROPS} />);

    expectListView();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "The purchase order's details did not reach this page. Open the purchase order and select Make recurring again.",
    );
  });

  it('a seed that cannot be read says so instead of being dropped in silence', () => {
    store('{not json');
    searchParams = new URLSearchParams({ from: PO });

    render(<RecurringTemplatesSeedLoader {...PROPS} />);

    expectListView();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('a seed of the wrong shape (a line without a quantity) is refused, not half-applied', () => {
    store({ poId: PO, ...SEED, lineItems: [{ itemId: 'item-1', unitCost: 16 }] });
    searchParams = new URLSearchParams({ from: PO });

    render(<RecurringTemplatesSeedLoader {...PROPS} />);

    expectListView();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('a full page load (server render, then hydration) still opens the filled-in form, with no hydration error', async () => {
    store({ poId: PO, ...SEED });
    searchParams = new URLSearchParams({ from: PO });
    const t0 = Date.parse('2026-10-05T21:00:00.000Z');

    // The server cannot read the tab's storage: it renders the list, and the
    // browser must hydrate that same list before it takes the seed.
    const run = await hydrateAcrossClockShift(() => <RecurringTemplatesSeedLoader {...PROPS} />, {
      serverNow: t0,
      browserNow: t0 + 60_000,
    });
    try {
      expect(run.html).toContain('No recurring templates yet');
      expect(run.errors).toEqual([]);
      const page = within(run.container);
      expect(page.getByText('New recurring template')).toBeInTheDocument();
      expect(page.getByDisplayValue('50')).toBeInTheDocument();
      expect(sessionStorage.getItem(KEY)).toBeNull();
    } finally {
      run.unmount();
    }
  });

  it('an organization without recurring purchase orders sees the upgrade card; the seed is still taken', () => {
    store({ poId: PO, ...SEED });
    searchParams = new URLSearchParams({ from: PO });

    render(<RecurringTemplatesSeedLoader {...PROPS} entitled={false} />);

    expect(screen.getAllByText(/Pro/).length).toBeGreaterThan(0);
    expect(screen.queryByText('New recurring template')).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});

describe('Make recurring from a purchase order whose destination the form does not offer', () => {
  // The form offers PROPS.locations (sites linked to a warehouse); these are not among them.
  const STAGING = 'loc-staging';
  const GONE = 'loc-gone';

  const destination = () => screen.getByRole('combobox', { name: /Destination location/ });

  /** Names the template, presses Create template, and returns what was sent. */
  async function saveAs(name: string) {
    fireEvent.change(screen.getByPlaceholderText('e.g. Weekly office supplies'), {
      target: { value: name },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(createRecurringTemplateAction).toHaveBeenCalledTimes(1));
    return vi.mocked(createRecurringTemplateAction).mock.calls[0]?.[0];
  }

  function openFrom(seedDestinationId: string) {
    store({ poId: PO, ...SEED, destinationLocationId: seedDestinationId });
    searchParams = new URLSearchParams({ from: PO });
  }

  beforeEach(() => {
    vi.mocked(createRecurringTemplateAction).mockResolvedValue({ ok: true, data: { id: 'tpl-new' } });
  });

  it('a staging area: the form opens with no destination and names where the purchase order went; saving sends none', async () => {
    openFrom(STAGING);

    render(
      <RecurringTemplatesSeedLoader
        {...PROPS}
        seedDestination={{ locationId: STAGING, name: 'Staging', deleted: false }}
      />,
    );

    expect(
      screen.getByText(
        'This purchase order went to "Staging", which is not a site you can pick here, so choose a destination.',
      ),
    ).toBeInTheDocument();
    expect(destination()).toHaveTextContent('None');
    // The rest of the purchase order is still brought over.
    expect(screen.getAllByText('TechSource Distributors').length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue('50')).toBeInTheDocument();

    expect(await saveAs('Monthly restock')).toMatchObject({
      name: 'Monthly restock',
      supplierId: 'sup-1',
      destinationLocationId: null,
    });
  });

  it('a deleted location: the form says it was deleted, opens with no destination, and saving sends none', async () => {
    openFrom(GONE);

    render(
      <RecurringTemplatesSeedLoader
        {...PROPS}
        seedDestination={{ locationId: GONE, name: 'Old Annex', deleted: true }}
      />,
    );

    expect(
      screen.getByText('This purchase order went to a location that was deleted, so choose a destination.'),
    ).toBeInTheDocument();
    expect(destination()).toHaveTextContent('None');
    expect(await saveAs('Monthly restock')).toMatchObject({ destinationLocationId: null });
  });

  it('the page could not read where it went: a destination the form does not offer is still not kept', async () => {
    openFrom(STAGING);

    render(<RecurringTemplatesSeedLoader {...PROPS} seedDestination={null} />);

    expect(
      screen.getByText("This purchase order went to a location you can't pick here, so choose a destination."),
    ).toBeInTheDocument();
    expect(destination()).toHaveTextContent('None');
    expect(await saveAs('Monthly restock')).toMatchObject({ destinationLocationId: null });
  });

  it("the page's read of the purchase order decides, not the seed stored in the browser", async () => {
    // The stored seed names a site the form offers; the purchase order itself
    // goes to a staging area.
    openFrom('loc-1');

    render(
      <RecurringTemplatesSeedLoader
        {...PROPS}
        seedDestination={{ locationId: STAGING, name: 'Staging', deleted: false }}
      />,
    );

    expect(screen.getByText(/^This purchase order went to "Staging"/)).toBeInTheDocument();
    expect(destination()).toHaveTextContent('None');
    expect(await saveAs('Monthly restock')).toMatchObject({ destinationLocationId: null });
  });

  it('picking a destination clears the note, and the save sends the one picked', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    openFrom(STAGING);

    render(
      <RecurringTemplatesSeedLoader
        {...PROPS}
        seedDestination={{ locationId: STAGING, name: 'Staging', deleted: false }}
      />,
    );
    expect(screen.getByText(/^This purchase order went to "Staging"/)).toBeInTheDocument();

    await user.click(destination());
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'North Site' }));

    expect(screen.queryByText(/^This purchase order went to/)).toBeNull();
    expect(destination()).toHaveTextContent('North Site');
    expect(await saveAs('Monthly restock')).toMatchObject({ destinationLocationId: 'loc-2' });
  });

  it('a destination the form offers is kept, with no note', async () => {
    openFrom('loc-1');

    render(
      <RecurringTemplatesSeedLoader
        {...PROPS}
        seedDestination={{ locationId: 'loc-1', name: 'Main Distribution Center', deleted: false }}
      />,
    );

    expect(destination()).toHaveTextContent('Main Distribution Center');
    expect(screen.queryByText(/^This purchase order went to/)).toBeNull();
    expect(await saveAs('Monthly restock')).toMatchObject({ destinationLocationId: 'loc-1' });
  });
});

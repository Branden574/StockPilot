import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ValueChartInteractive } from './value-chart-interactive';

// BigChart is exercised by its own Unit B tests; here we stub it to a probe that
// reflects WHICH props it received — single-series (`data`) vs multi-series
// (`series`), the series labels (order matters), and the primary line's first
// value — so the island's wiring can be asserted without any SVG maths.
vi.mock('@/components/dashboard/big-chart', () => ({
  BigChart: ({
    data,
    series,
  }: {
    data?: Array<{ value: number }>;
    series?: Array<{ label: string; data: Array<{ value: number }> }>;
  }) => (
    <div
      data-testid="big-chart"
      data-variant={series ? 'multi' : 'single'}
      data-count={series ? series.length : data ? 1 : 0}
      data-labels={series ? series.map((s) => s.label).join('|') : ''}
      data-first={String(series ? series[0]?.data?.[0]?.value : data?.[0]?.value)}
    />
  ),
}));

// Radix DropdownMenu leans on Pointer Capture, absent in happy-dom.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
});

const SEED = Array.from({ length: 30 }, (_, i) => ({ value: 100 + i, label: `D-${30 - i}` }));
const WAREHOUSES = [
  { id: 'wh-1', name: 'Main Warehouse' },
  { id: 'wh-2', name: 'Overflow Depot' },
];

function previousPayload(basis: 'cost' | 'retail', current: number, prev: number) {
  return {
    mode: 'previous',
    days: 30,
    basis,
    series: [
      { label: 'Previous period', data: Array.from({ length: 30 }, (_, i) => prev + i) },
      { label: 'Current period', data: Array.from({ length: 30 }, (_, i) => current + i) },
    ],
  };
}

function okJson(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload } as Response;
}

function renderCard(overrides: Partial<React.ComponentProps<typeof ValueChartInteractive>> = {}) {
  return render(
    <ValueChartInteractive
      initialSeries={SEED}
      warehouses={WAREHOUSES}
      initialWarehouseId={null}
      {...overrides}
    />,
  );
}

/** Open the "+ Compare" menu and pick an option by its visible label. */
async function pickCompare(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('button', { name: '+ Compare' }));
  await user.click(await screen.findByText(label));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ValueChartInteractive', () => {
  it('renders the SSR seed as a single line and fetches nothing on mount', () => {
    renderCard();
    const chart = screen.getByTestId('big-chart');
    expect(chart).toHaveAttribute('data-variant', 'single');
    expect(chart).toHaveAttribute('data-first', '100'); // SEED[0].value
    // Default subtitle mirrors the old static card.
    expect(screen.getByText('USD · cost basis · all locations')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('overlays a comparison: Compare → Previous period fetches mode=previous and draws 2 lines (primary first)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(okJson(previousPayload('cost', 2000, 1000)));
    renderCard();

    await pickCompare(user, 'Previous period');

    await waitFor(() =>
      expect(screen.getByTestId('big-chart')).toHaveAttribute('data-variant', 'multi'),
    );
    const chart = screen.getByTestId('big-chart');
    expect(chart).toHaveAttribute('data-count', '2');
    // Current period is the primary line → rendered first (accent).
    expect(chart).toHaveAttribute('data-labels', 'Current period|Previous period');
    expect(chart).toHaveAttribute('data-first', '2000');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/api/dashboard/value-series');
    expect(url).toContain('mode=previous');
    expect(url).toContain('basis=cost');
    expect(url).toContain('days=30');
  });

  it('clears a comparison back to the single seed line without a new fetch', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(okJson(previousPayload('cost', 2000, 1000)));
    renderCard();

    await pickCompare(user, 'Previous period');
    await waitFor(() =>
      expect(screen.getByTestId('big-chart')).toHaveAttribute('data-variant', 'multi'),
    );

    await user.click(screen.getByRole('button', { name: 'Clear comparison' }));

    await waitFor(() =>
      expect(screen.getByTestId('big-chart')).toHaveAttribute('data-variant', 'single'),
    );
    // Back to the SSR seed — the default view never re-fetches.
    expect(screen.getByTestId('big-chart')).toHaveAttribute('data-first', '100');
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the compare fetch
  });

  it('basis toggle → Retail refetches the primary line and flags it approximate', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(previousPayloadResponse('retail', 4000, 3000));
    renderCard();

    await user.click(screen.getByRole('button', { name: 'Retail' }));

    await waitFor(() =>
      expect(screen.getByTestId('big-chart')).toHaveAttribute('data-first', '4000'),
    );
    const chart = screen.getByTestId('big-chart');
    expect(chart).toHaveAttribute('data-variant', 'single'); // still a single line
    // Retail is surfaced as approximate.
    expect(screen.getByText('USD · retail basis (approx.) · all locations')).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('basis=retail');
    expect(url).toContain('mode=previous');
  });

  it('keeps the last-fetched line dimmed while the next selection loads (no snap to seed)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let resolveSecond!: (r: Response) => void;
    fetchMock
      .mockResolvedValueOnce(okJson(previousPayload('retail', 4000, 3000))) // Retail toggle
      .mockImplementationOnce(
        () => new Promise<Response>((res) => (resolveSecond = res)), // location change → left pending
      );
    renderCard();

    // Retail toggle resolves → primary line at 4000.
    await user.click(screen.getByRole('button', { name: 'Retail' }));
    await waitFor(() =>
      expect(screen.getByTestId('big-chart')).toHaveAttribute('data-first', '4000'),
    );

    // Change location → second fetch stays in flight.
    await user.click(screen.getByRole('button', { name: 'All locations' }));
    await user.click(await screen.findByText('Main Warehouse'));

    // While loading: the 4000 line is RETAINED (not the SSR seed's 100) and the
    // chart is marked busy so it reads as updating rather than final.
    const chart = screen.getByTestId('big-chart');
    expect(chart).toHaveAttribute('data-first', '4000');
    expect(chart.closest('[aria-busy="true"]')).not.toBeNull();

    // Resolve → updates to the new selection's line.
    resolveSecond(okJson(previousPayload('retail', 6000, 5500)));
    await waitFor(() =>
      expect(screen.getByTestId('big-chart')).toHaveAttribute('data-first', '6000'),
    );
  });

  it('location filter refetches the primary line scoped to the chosen warehouse', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(okJson(previousPayload('cost', 5000, 4500)));
    renderCard();

    // Open the location dropdown (its trigger shows the current selection).
    await user.click(screen.getByRole('button', { name: 'All locations' }));
    await user.click(await screen.findByText('Main Warehouse'));

    await waitFor(() =>
      expect(screen.getByTestId('big-chart')).toHaveAttribute('data-first', '5000'),
    );
    expect(screen.getByText('USD · cost basis · Main Warehouse')).toBeInTheDocument();

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('warehouseId=wh-1');
  });

  it('shows an inline error (no crash) when the endpoint fails', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    renderCard();

    await pickCompare(user, 'Previous period');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toMatch(/load this view/i);
    // Chart still renders (falls back to the single seed line) — never blanks.
    expect(screen.getByTestId('big-chart')).toBeInTheDocument();
    expect(screen.getByTestId('big-chart')).toHaveAttribute('data-variant', 'single');
  });

  it('serves a re-selected comparison from cache (no second fetch for the same query)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(okJson(previousPayload('cost', 2000, 1000)));
    renderCard();

    await pickCompare(user, 'Previous period');
    await waitFor(() =>
      expect(screen.getByTestId('big-chart')).toHaveAttribute('data-variant', 'multi'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Clear, then re-select the identical comparison.
    await user.click(screen.getByRole('button', { name: 'Clear comparison' }));
    await waitFor(() =>
      expect(screen.getByTestId('big-chart')).toHaveAttribute('data-variant', 'single'),
    );
    await pickCompare(user, 'Previous period');
    await waitFor(() =>
      expect(screen.getByTestId('big-chart')).toHaveAttribute('data-variant', 'multi'),
    );

    // Served from the session cache — still only ONE network call total.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// The reference value card's figure (P3.1): the 30 px value and its delta
// always describe the primary line on screen.
describe('ValueChartInteractive: the figure', () => {
  const figure = () => document.querySelector('[data-slot="value-figure"]');

  it("prints the key stats' own value and delta in the default view, with no fetch", () => {
    renderCard({ initialValue: 156087.72, initialDelta: { label: '+0.4%', direction: 'up' } });
    expect(figure()).toHaveTextContent('$156,087.72');
    expect(figure()).toHaveTextContent('+0.4%');
    expect(figure()).toHaveTextContent('vs. 30 days ago');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the seed line's last point when no value is passed", () => {
    renderCard();
    expect(figure()).toHaveTextContent('$129.00'); // SEED[29].value
  });

  it('follows the fetched line after a basis change: its last point and its own delta', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(okJson(previousPayload('retail', 4000, 3000)));
    renderCard({ initialValue: 156087.72, initialDelta: { label: '+0.4%', direction: 'up' } });
    await user.click(screen.getByRole('button', { name: 'Retail' }));
    await waitFor(() => expect(figure()).toHaveTextContent('$4,029.00'));
    // 4000 -> 4029 over the window.
    expect(figure()).toHaveTextContent('+0.7%');
  });

  it('describes the current period in a Previous period comparison', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(okJson(previousPayload('cost', 2000, 1000)));
    renderCard({ initialValue: 1, initialDelta: { label: '—', direction: 'flat' } });
    await pickCompare(user, 'Previous period');
    await waitFor(() =>
      expect(screen.getByTestId('big-chart')).toHaveAttribute('data-variant', 'multi'),
    );
    expect(figure()).toHaveTextContent('$2,029.00');
  });

  it('shows no figure for By location (no single line) or after a failed view', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValueOnce(
      okJson({
        mode: 'locations',
        days: 30,
        basis: 'cost',
        series: [
          { label: 'Main Warehouse', data: [1, 2] },
          { label: 'Overflow Depot', data: [3, 4] },
        ],
      }),
    );
    renderCard({ initialValue: 5 });
    await pickCompare(user, 'By location');
    await waitFor(() =>
      expect(screen.getByTestId('big-chart')).toHaveAttribute('data-variant', 'multi'),
    );
    expect(figure()).toBeNull();

    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) } as Response);
    await user.click(screen.getByRole('button', { name: 'Retail' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(figure()).toBeNull();
  });

  it("keeps the controls' names and the basis toggle's pressed state", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    fetchMock.mockResolvedValue(okJson(previousPayload('retail', 4000, 3000)));
    renderCard();
    expect(screen.getByRole('group', { name: 'Value basis' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cost' })).toHaveAttribute('aria-pressed', 'true');
    const retail = screen.getByRole('button', { name: 'Retail' });
    expect(retail).toHaveAttribute('aria-pressed', 'false');
    expect(retail).toHaveAttribute(
      'title',
      'Approximate — retail price held constant across past days',
    );
    expect(screen.getByRole('button', { name: 'All locations' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Compare' })).toBeInTheDocument();
    await user.click(retail);
    expect(retail).toHaveAttribute('aria-pressed', 'true');
  });

  // FX7 (DESIGN-SPEC 4 "Range toggle track / chip 28 / 22", 6.17's value card
  // toggle): Cost / Retail is the value card's range-style toggle, so it takes
  // the xs size (a 28 px transparent track, 22 px chips), not List / Grid's.
  it('draws Cost / Retail at the range toggle size', () => {
    renderCard();
    const group = screen.getByRole('group', { name: 'Value basis' });
    expect(group).toHaveClass('bg-transparent');
    expect(group).not.toHaveClass('bg-sunk');
    expect(screen.getByRole('button', { name: 'Cost' })).toHaveClass('h-[22px]', 'bg-muted');
    expect(screen.getByRole('button', { name: 'Retail' })).toHaveClass('h-[22px]', 'font-normal');
  });
});

// Small helper kept below the suite to avoid noise above; returns a Response.
function previousPayloadResponse(basis: 'cost' | 'retail', current: number, prev: number) {
  return okJson(previousPayload(basis, current, prev));
}

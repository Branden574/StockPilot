import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { parseProcedureListParams } from './list-query';
import { ProcedureFilters } from './procedure-filters';

const categories = [
  { id: 'c-safety', name: 'Safety', color: '#dc2626' },
  { id: 'c-recv', name: 'Receiving', color: null },
];
const warehouses = [
  { id: 'wh-north', name: 'North DC' },
  { id: 'wh-south', name: 'South DC' },
];

function renderFilters(params: Record<string, string>) {
  const { container } = render(
    <ProcedureFilters
      state={parseProcedureListParams(params)}
      categories={categories}
      warehouses={warehouses}
    />,
  );
  return container.querySelector('form')!;
}

describe('ProcedureFilters', () => {
  it('is a GET form to the list with the search field, Search and the Warehouse select', () => {
    const form = renderFilters({});
    expect(form.getAttribute('action')).toBe('/dashboard/procedures');
    expect(form.getAttribute('method')).toBe('get');
    expect(screen.getByPlaceholderText('Search procedures…')).toHaveAttribute('name', 'q');
    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute('type', 'submit');
    const select = screen.getByLabelText('Warehouse');
    expect(select).toHaveAttribute('name', 'wh');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All warehouses', 'North DC', 'South DC']);
    // No filter: no Clear.
    expect(screen.queryByRole('link', { name: /Clear/ })).toBeNull();
  });

  it('sends the warehouse once when a warehouse filter is active (CONFLICTS D21)', () => {
    const form = renderFilters({ wh: 'wh-north', cat: 'c-safety', view: 'archived' });
    const data = new FormData(form);
    expect(data.getAll('wh')).toEqual(['wh-north']);
    expect(data.getAll('cat')).toEqual(['c-safety']);
    expect(data.getAll('view')).toEqual(['archived']);
    expect(form.querySelectorAll('[name="wh"]')).toHaveLength(1);
  });

  it('Clear goes back to the plain list, keeping the Archived view', () => {
    renderFilters({ q: 'dock', view: 'archived' });
    expect(screen.getByRole('link', { name: /Clear/ })).toHaveAttribute(
      'href',
      '/dashboard/procedures?view=archived',
    );
  });

  it('category chips keep their words and link to full list URLs; All clears the category', () => {
    renderFilters({ cat: 'c-safety', q: 'pallet' });
    const all = screen.getByRole('link', { name: 'All categories' });
    expect(all).toHaveTextContent('All');
    expect(all).toHaveAttribute('href', '/dashboard/procedures?q=pallet');
    expect(screen.getByRole('link', { name: 'Safety' })).toHaveAttribute(
      'href',
      '/dashboard/procedures?q=pallet&cat=c-safety',
    );
    expect(screen.getByRole('link', { name: 'Receiving' })).toHaveAttribute(
      'href',
      '/dashboard/procedures?q=pallet&cat=c-recv',
    );
  });

  it('All alone with a category links to the plain list', () => {
    renderFilters({ cat: 'c-safety' });
    expect(screen.getByRole('link', { name: 'All categories' })).toHaveAttribute(
      'href',
      '/dashboard/procedures',
    );
  });

  it('draws no chip row when the organisation has no categories', () => {
    render(
      <ProcedureFilters state={parseProcedureListParams({})} categories={[]} warehouses={[]} />,
    );
    expect(screen.queryByRole('link', { name: 'All categories' })).toBeNull();
  });
});

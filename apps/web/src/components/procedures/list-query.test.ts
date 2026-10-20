import { describe, expect, it } from 'vitest';

import {
  firstParam,
  parseProcedureListParams,
  procedureListClearHref,
  procedureListHref,
} from './list-query';

describe('Procedures list URL state', () => {
  it('reads a repeated parameter as its first value instead of throwing (CONFLICTS D21)', () => {
    // The old filter form sent `wh` twice; `.trim()` on the array threw and
    // the page fell to the error boundary (seen on the lab at 36cb9b619).
    expect(firstParam(['wh-1', 'wh-1'])).toBe('wh-1');
    expect(firstParam(undefined)).toBe('');
    expect(firstParam('  q  ')).toBe('q');
    const state = parseProcedureListParams({ wh: ['wh-1', 'wh-1'], q: 'pallet', page: ['2'] });
    expect(state).toEqual({ q: 'pallet', cat: '', wh: 'wh-1', page: 2, archived: false });
  });

  it('keeps the old page and view rules', () => {
    expect(parseProcedureListParams({ page: 'x' }).page).toBe(1);
    expect(parseProcedureListParams({ page: '-3' }).page).toBe(1);
    expect(parseProcedureListParams({ view: 'archived' }).archived).toBe(true);
    expect(parseProcedureListParams({ view: 'active' }).archived).toBe(false);
  });

  it('"All" with only a category chosen links to the plain list, not to the current URL', () => {
    // Before: buildQS returned '' and the chip's href="" reloaded ?cat=<id>,
    // so All never cleared the category.
    const state = parseProcedureListParams({ cat: 'cat-safety' });
    expect(procedureListHref(state, { cat: '', page: 1 })).toBe('/dashboard/procedures');
  });

  it('chips and the pager keep q, wh and view, and a chip goes back to page 1', () => {
    const state = parseProcedureListParams({
      q: 'dock',
      wh: 'wh-1',
      cat: 'c1',
      page: '3',
      view: 'archived',
    });
    expect(procedureListHref(state, { cat: 'c2', page: 1 })).toBe(
      '/dashboard/procedures?q=dock&cat=c2&wh=wh-1&view=archived',
    );
    expect(procedureListHref(state, { page: 4 })).toBe(
      '/dashboard/procedures?q=dock&cat=c1&wh=wh-1&page=4&view=archived',
    );
    expect(procedureListHref(state, { page: 1 })).toBe(
      '/dashboard/procedures?q=dock&cat=c1&wh=wh-1&view=archived',
    );
  });

  it('Clear keeps only the Archived view', () => {
    expect(procedureListClearHref(parseProcedureListParams({ q: 'x', view: 'archived' }))).toBe(
      '/dashboard/procedures?view=archived',
    );
    expect(procedureListClearHref(parseProcedureListParams({ q: 'x' }))).toBe(
      '/dashboard/procedures',
    );
  });
});

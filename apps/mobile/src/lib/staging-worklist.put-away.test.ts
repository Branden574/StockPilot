import {
  STAGING_FILTER_BACK_LABEL,
  STAGING_FILTER_ELSEWHERE_NOTE,
  STAGING_FILTER_EMPTY_COPY,
  STAGING_FILTER_MAX_ITEMS,
  STAGING_FILTER_SHOW_ALL_LABEL,
  STAGING_FILTER_UNPLACED_NOTE,
  stagingFilterInvalidCopy,
  stagingPutAwayParams,
} from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

import {
  parseStagingOrderLink,
  parseStagingWorklist,
  stagingFilterChip,
  stagingFilterEmptyCopy,
  stagingListEmptyState,
  stagingRouteParamValues,
  stagingScreenFilter,
  stagingWorklistPath,
} from './staging-worklist';

/**
 * PUT AWAY FROM AN ORDER (F2-3), the Staging tab's half: the order screen
 * opens it with core's params (a comma list of item ids, and the order); the
 * list is read for those items only; the chip says so in core's words; the
 * params are never rewritten (Show all is the reader's own choice, held by
 * the screen). Each test names the mutation it catches.
 */

const ORDER = '0a000000-0000-0000-0000-00000000f301';
const ITEM_A = '0a000000-0000-0000-0000-0000000000a1';
const ITEM_B = '0a000000-0000-0000-0000-0000000000b2';
const WH = '0a000000-0000-0000-0000-00000000c0c0';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('stagingWorklistPath with an order’s items', () => {
  it('sends the ids as one comma list and the order, never the warehouse (the route ignores it then)', () => {
    // Mutation caught: keeping warehouseId beside itemIds (a switcher on
    // another warehouse would narrow the order's own Staging away).
    expect(
      stagingWorklistPath('all', WH, { itemIds: [ITEM_A, ITEM_B], orderId: ORDER }),
    ).toBe(`/api/v1/inventory/staging?itemIds=${ITEM_A},${ITEM_B}&orderId=${ORDER}`);
  });

  it('keeps the Items / Books tab', () => {
    expect(stagingWorklistPath('book', WH, { itemIds: [ITEM_A], orderId: null })).toBe(
      `/api/v1/inventory/staging?type=book&itemIds=${ITEM_A}`,
    );
  });

  it('without a filter (or an empty one) the path is unchanged', () => {
    expect(stagingWorklistPath('all', WH, null)).toBe(stagingWorklistPath('all', WH));
    expect(stagingWorklistPath('all', WH, { itemIds: [], orderId: ORDER })).toBe(
      `/api/v1/inventory/staging?warehouseId=${WH}`,
    );
  });

  it('what the order screen sends round-trips through the screen into the same request', () => {
    // core stagingPutAwayParams (the order screen) -> route params -> filter
    // -> the request: the ids and the order survive unchanged.
    const params = stagingPutAwayParams({ orderId: ORDER, itemIds: [ITEM_A, ITEM_B] });
    const f = stagingScreenFilter(stagingRouteParamValues(params), null);
    expect(f.active).toEqual({ itemIds: [ITEM_A, ITEM_B], orderId: ORDER });
    expect(stagingWorklistPath('all', WH, f.active)).toBe(
      `/api/v1/inventory/staging?itemIds=${ITEM_A},${ITEM_B}&orderId=${ORDER}`,
    );
  });

  it('200 ids (the cap) all go, in one request', () => {
    const ids = Array.from({ length: STAGING_FILTER_MAX_ITEMS }, (_, i) => uuid(i + 1));
    const f = stagingScreenFilter({ itemIds: ids.join(','), orderId: ORDER }, null);
    const path = stagingWorklistPath('all', null, f.active);
    expect(path.split('itemIds=')[1]!.split('&')[0]!.split(',')).toEqual(ids);
  });
});

describe('stagingRouteParamValues', () => {
  it('joins a repeated param the way the route does, and takes the first order', () => {
    expect(stagingRouteParamValues({ itemIds: [ITEM_A, ITEM_B], orderId: [ORDER, uuid(9)] })).toEqual({
      itemIds: `${ITEM_A},${ITEM_B}`,
      orderId: ORDER,
    });
    expect(stagingRouteParamValues({})).toEqual({ itemIds: undefined, orderId: undefined });
    expect(stagingRouteParamValues({ itemIds: [] })).toEqual({ itemIds: undefined, orderId: undefined });
  });
});

describe('stagingScreenFilter: the params are read, never rewritten', () => {
  it('no params: the whole worklist, as before', () => {
    expect(stagingScreenFilter({}, null)).toEqual({
      parse: { state: 'none' },
      active: null,
      key: null,
      invalidCopy: null,
    });
  });

  it('usable params: the filter, lower-cased and deduped (core parseStagingItemFilter)', () => {
    const f = stagingScreenFilter(
      { itemIds: `${ITEM_A.toUpperCase()},${ITEM_A},${ITEM_B}`, orderId: ORDER.toUpperCase() },
      null,
    );
    expect(f.active).toEqual({ itemIds: [ITEM_A, ITEM_B], orderId: ORDER });
    expect(f.key).toBe(`${ORDER}|${ITEM_A},${ITEM_B}`);
    expect(f.invalidCopy).toBeNull();
  });

  it('Show all hides exactly the filter it was pressed on; other items are filtered again', () => {
    // Mutation caught: a sticky "show all" flag (the next Put away would
    // open unfiltered) or ignoring it (Show all would do nothing).
    const first = stagingScreenFilter({ itemIds: ITEM_A, orderId: ORDER }, null);
    const shown = stagingScreenFilter({ itemIds: ITEM_A, orderId: ORDER }, first.key);
    expect(shown.active).toBeNull();
    // The screen still knows where it came from (Back to the order).
    expect(shown.parse.state === 'ok' && shown.parse.filter.orderId).toBe(ORDER);
    const next = stagingScreenFilter({ itemIds: ITEM_B, orderId: ORDER }, first.key);
    expect(next.active).toEqual({ itemIds: [ITEM_B], orderId: ORDER });
  });

  it('an unusable link shows every item and says why (never a shorter list)', () => {
    const bad = stagingScreenFilter({ itemIds: `${ITEM_A},not-a-uuid`, orderId: ORDER }, null);
    expect(bad.active).toBeNull();
    expect(bad.invalidCopy).toBe(stagingFilterInvalidCopy('bad_id'));
    const ids = Array.from({ length: STAGING_FILTER_MAX_ITEMS + 1 }, (_, i) => uuid(i + 1));
    const many = stagingScreenFilter({ itemIds: ids.join(',') }, null);
    expect(many.active).toBeNull();
    expect(many.invalidCopy).toBe(stagingFilterInvalidCopy('too_many'));
    // So the request is the ordinary one (a 400 would blank the screen).
    expect(stagingWorklistPath('all', WH, many.active)).toBe(
      `/api/v1/inventory/staging?warehouseId=${WH}`,
    );
  });

  it('an order alone is not a filter', () => {
    expect(stagingScreenFilter({ orderId: ORDER }, null).active).toBeNull();
  });
});

describe('parseStagingOrderLink (the answer’s `order`)', () => {
  it('reads the order, its number and whether it is there', () => {
    expect(
      parseStagingOrderLink({
        rows: [],
        canPlace: true,
        order: { id: ORDER, orderNumber: 'SO-000017', found: true, elsewhere: 2 },
      }),
    ).toEqual({ id: ORDER, orderNumber: 'SO-000017', found: true, elsewhere: 2 });
    expect(
      parseStagingOrderLink({ order: { id: ORDER, orderNumber: null, found: false, elsewhere: 0 } }),
    ).toEqual({ id: ORDER, orderNumber: null, found: false, elsewhere: 0 });
  });

  it('an answer without `elsewhere` (a server before the narrowing) or a bad one: 0, never a guess', () => {
    for (const elsewhere of [undefined, null, 'two', -1, Number.NaN, 1.5]) {
      expect(parseStagingOrderLink({ order: { id: ORDER, orderNumber: 'SO-1', found: true, elsewhere } })).toEqual({
        id: ORDER,
        orderNumber: 'SO-1',
        found: true,
        elsewhere: 0,
      });
    }
  });

  it('absent (no orderId sent, an older server) or malformed: null, never a guess', () => {
    for (const raw of [
      null,
      'boom',
      { rows: [] },
      { order: null },
      { order: 'SO-1' },
      { order: { orderNumber: 'SO-1', found: true } },
      { order: { id: ORDER, orderNumber: 'SO-1' } },
      { order: { id: ORDER, found: 'yes' } },
    ]) {
      expect(parseStagingOrderLink(raw)).toBeNull();
    }
  });

  it('the rows parser is untouched by the new key', () => {
    expect(parseStagingWorklist({ rows: [], canPlace: true, order: { id: ORDER, found: true } })).toEqual({
      rows: [],
      canPlace: true,
    });
  });
});

describe('stagingFilterChip (the web page’s chip, core’s words)', () => {
  const active = { itemIds: [ITEM_A, ITEM_B], orderId: ORDER };

  it('names the order once the answer does, with Show all, Back to the order and the note', () => {
    expect(stagingFilterChip(active, { id: ORDER, orderNumber: 'SO-000017', found: true, elsewhere: 0 })).toEqual({
      headline: 'Showing items from SO-000017',
      showAllLabel: STAGING_FILTER_SHOW_ALL_LABEL,
      backLabel: STAGING_FILTER_BACK_LABEL,
      note: STAGING_FILTER_UNPLACED_NOTE,
      elsewhereNote: null,
      backOrderId: ORDER,
    });
  });

  it('says so when the route left out rows at other warehouses (the web page’s note)', () => {
    expect(stagingFilterChip(active, { id: ORDER, orderNumber: 'SO-000017', found: true, elsewhere: 3 })?.elsewhereNote).toBe(
      STAGING_FILTER_ELSEWHERE_NOTE,
    );
    // Another order's answer is not about this list.
    expect(stagingFilterChip(active, { id: uuid(5), orderNumber: 'SO-000099', found: true, elsewhere: 3 })?.elsewhereNote).toBeNull();
  });

  it('before the answer (or after a failed read) the reader can still go back to the order', () => {
    const chip = stagingFilterChip(active, null);
    expect(chip?.headline).toBe('Showing items from an order');
    expect(chip?.backOrderId).toBe(ORDER);
  });

  it('a number that could not be read keeps the link', () => {
    const chip = stagingFilterChip(active, { id: ORDER, orderNumber: null, found: true, elsewhere: 0 });
    expect(chip?.headline).toBe('Showing items from an order');
    expect(chip?.backOrderId).toBe(ORDER);
  });

  it('an order that is not there has nothing to go back to', () => {
    // Mutation caught: offering Back to an order the answer said is gone.
    const chip = stagingFilterChip(active, { id: ORDER, orderNumber: null, found: false, elsewhere: 0 });
    expect(chip?.backLabel).toBeNull();
    expect(chip?.backOrderId).toBeNull();
    expect(chip?.headline).toBe('Showing only 2 items');
  });

  it('an answer about another order is not this order’s number', () => {
    const chip = stagingFilterChip(active, { id: uuid(5), orderNumber: 'SO-000099', found: true, elsewhere: 0 });
    expect(chip?.headline).toBe('Showing items from an order');
    expect(chip?.backOrderId).toBe(ORDER);
  });

  it('items without an order: "Showing only N items", no Back', () => {
    expect(stagingFilterChip({ itemIds: [ITEM_A], orderId: null }, null)).toMatchObject({
      headline: 'Showing only 1 item',
      backLabel: null,
      backOrderId: null,
    });
  });

  it('no filter: no chip', () => {
    expect(stagingFilterChip(null, { id: ORDER, orderNumber: 'SO-000017', found: true, elsewhere: 0 })).toBeNull();
  });
});

describe('stagingFilterEmptyCopy', () => {
  const active = { itemIds: [ITEM_A], orderId: ORDER };
  it('says what is LISTED, only for a filtered list that came back empty', () => {
    expect(stagingFilterEmptyCopy({ active, loading: false, error: null, rowCount: 0 })).toBe(
      STAGING_FILTER_EMPTY_COPY,
    );
    expect(STAGING_FILTER_EMPTY_COPY).toBe('No Staging or Unplaced stock is listed for these items.');
  });
  it('never while loading, after a failed read (the error says so), with rows, or unfiltered', () => {
    expect(stagingFilterEmptyCopy({ active, loading: true, error: null, rowCount: 0 })).toBeNull();
    expect(stagingFilterEmptyCopy({ active, loading: false, error: 'x', rowCount: 0 })).toBeNull();
    expect(stagingFilterEmptyCopy({ active, loading: false, error: null, rowCount: 2 })).toBeNull();
    expect(stagingFilterEmptyCopy({ active: null, loading: false, error: null, rowCount: 0 })).toBeNull();
  });
});

describe('stagingListEmptyState (what the list shows with no rows)', () => {
  it('a filtered list that came back empty: nothing, the chip already says it (one empty message, not two)', () => {
    expect(stagingListEmptyState({ loading: false, error: null, filterEmpty: STAGING_FILTER_EMPTY_COPY })).toBe('none');
  });
  it('otherwise as before: the spinner, the retry line after a failed read, or "Nothing to place."', () => {
    expect(stagingListEmptyState({ loading: true, error: null, filterEmpty: null })).toBe('loading');
    expect(stagingListEmptyState({ loading: false, error: 'x', filterEmpty: null })).toBe('error');
    expect(stagingListEmptyState({ loading: false, error: null, filterEmpty: null })).toBe('nothing_to_place');
  });
});

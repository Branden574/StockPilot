import { describe, expect, it } from 'vitest';

import { fakePostgrest, inValues, rowsServer, uuid } from './__fixtures__/fake-postgrest';
import {
  IN_FILTER_MAX_ENCODED_CHARS,
  IN_FILTER_MAX_VALUES,
  IdBatchReadError,
  MAX_PAGES_PER_BATCH,
  chunkInFilterValues,
  encodedInValueLength,
  fetchAllPages,
  fetchAllRowsByIds,
  idReadTable,
  mapWithConcurrency,
  readErrorMessage,
  settleIdBatchRead,
  type PageBuilder,
  type PageResult,
} from './id-batches';
import { POSTGREST_MAX_ROWS } from './inventory-paging';

/** What the real serializer (URLSearchParams, as postgrest-js uses it) writes
 *  for one value, without the key and `=`. */
function realEncodedLength(raw: string): number {
  return new URLSearchParams([['', raw]]).toString().length - 1;
}

/** The length postgrest-js adds for `.in(col, values)`: dedupe, quote values
 *  holding `,()`, join with `,`, serialize. Values plus separators only. */
function realInParamLength(values: string[]): number {
  const cleaned = Array.from(new Set(values))
    .map((s) => (/[,()]/.test(s) ? `"${s}"` : s))
    .join(',');
  const params = new URLSearchParams();
  params.append('c', `in.(${cleaned})`);
  return params.toString().length - 'c=in.%28'.length - '%29'.length;
}

function batchChars(batch: (string | number)[]): number {
  return batch.reduce<number>((sum, v) => sum + encodedInValueLength(v) + 3, 0);
}

/** A page builder over a fixed list of rows per batch. */
function staticPages<Row>(rows: Row[]): PageBuilder<Row> {
  return (from, to) =>
    Promise.resolve({ data: rows.slice(from, to + 1), error: null, status: 200, statusText: 'OK' });
}

describe('encodedInValueLength', () => {
  it('matches the real URLSearchParams encoder without depending on it', () => {
    for (const raw of [uuid(1), 'a b', "x!'~*", 'é', 'plain-value_1.2', '100%']) {
      expect(encodedInValueLength(raw), raw).toBe(realEncodedLength(raw));
    }
  });

  it('counts the quotes postgrest-js adds around a value holding a reserved character', () => {
    for (const raw of ['a,b', 'SN,1 (a)%', "x!'()~*"]) {
      expect(encodedInValueLength(raw), raw).toBe(realEncodedLength(`"${raw}"`));
      expect(encodedInValueLength(raw), raw).toBe(realInParamLength([raw]));
    }
  });

  it('measures a number as its decimal text', () => {
    expect(encodedInValueLength(12345)).toBe(5);
  });

  it('never throws on a lone surrogate, and never under-counts it', () => {
    const lone = 'a\uD800b';
    expect(encodedInValueLength(lone)).toBeGreaterThanOrEqual(realEncodedLength(lone));
  });

  it('agrees with the real serializer across a whole batch of uuids', () => {
    const values = Array.from({ length: 100 }, (_, i) => uuid(i));
    // One separator is charged per value; the real list has one fewer.
    expect(batchChars(values) - 3).toBe(realInParamLength(values));
    expect(realInParamLength(values)).toBe(3897);
    expect(realInParamLength(values)).toBeLessThanOrEqual(IN_FILTER_MAX_ENCODED_CHARS);
  });

  it('a full batch of 100 uuids stays well under the 8 KB local gateway limit', () => {
    const values = Array.from({ length: 100 }, (_, i) => uuid(i));
    const url = new URL(
      'http://127.0.0.1:54321/rest/v1/item_images?select=item_id%2Cstorage_path%2Cthumb_path%2Cis_primary%2Csort_order&organization_id=eq.' +
        uuid(999),
    );
    url.searchParams.append('item_id', `in.(${values.join(',')})`);
    url.searchParams.append('order', 'is_primary.desc,sort_order.asc,id.asc');
    url.searchParams.append('offset', '0');
    url.searchParams.append('limit', '1000');
    expect(url.href.length).toBeLessThan(8000);
  });
});

describe('chunkInFilterValues', () => {
  it('splits 250 uuids into batches of 100, 100 and 50', () => {
    const batches = chunkInFilterValues(Array.from({ length: 250 }, (_, i) => uuid(i)));
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(IN_FILTER_MAX_VALUES).toBe(100);
  });

  it('dedupes keeping first-seen order and drops null and undefined', () => {
    expect(chunkInFilterValues(['b', 'a', null, 'b', undefined, 'c', 'a'])).toEqual([['b', 'a', 'c']]);
  });

  it('returns no batches for an empty or all-null list', () => {
    expect(chunkInFilterValues([])).toEqual([]);
    expect(chunkInFilterValues([null, undefined])).toEqual([]);
  });

  it('keeps every batch of long, quoted, percent-heavy strings inside the character budget', () => {
    const serials = Array.from({ length: 60 }, (_, i) =>
      `${String(i).padStart(4, '0')},%%(${'x'.repeat(120)})`.slice(0, 128),
    );
    const batches = chunkInFilterValues(serials);
    expect(batches.flat()).toEqual(serials);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      expect(batchChars(b)).toBeLessThanOrEqual(IN_FILTER_MAX_ENCODED_CHARS);
      expect(realInParamLength(b)).toBeLessThanOrEqual(IN_FILTER_MAX_ENCODED_CHARS);
    }
  });

  it('sends a single value longer than the budget alone, never split and never dropped', () => {
    const huge = 'h'.repeat(IN_FILTER_MAX_ENCODED_CHARS + 50);
    expect(chunkInFilterValues(['a', huge, 'b'])).toEqual([['a'], [huge], ['b']]);
  });

  it('honours explicit caps', () => {
    const ten = Array.from({ length: 10 }, (_, i) => uuid(i));
    expect(chunkInFilterValues(ten, { maxValues: 4 }).map((b) => b.length)).toEqual([4, 4, 2]);
    expect(chunkInFilterValues(ten, { maxEncodedChars: 39 * 3 }).map((b) => b.length)).toEqual([
      3, 3, 3, 1,
    ]);
  });
});

describe('mapWithConcurrency', () => {
  it('never has more than the limit in flight and keeps input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 6, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1 + (n % 3)));
      inFlight -= 1;
      return n * 2;
    });
    expect(out).toEqual(items.map((i) => i * 2));
    expect(peak).toBe(6);
  });

  it('returns [] for no items without calling fn', async () => {
    let called = 0;
    expect(
      await mapWithConcurrency([], 6, async () => {
        called += 1;
        return 1;
      }),
    ).toEqual([]);
    expect(called).toBe(0);
  });
});

describe('fetchAllRowsByIds', () => {
  it('makes NO request for an empty or all-null input', async () => {
    let built = 0;
    const buildPage = () => {
      built += 1;
      return staticPages<string>([]);
    };
    expect(await fetchAllRowsByIds([], buildPage)).toEqual([]);
    expect(await fetchAllRowsByIds([null, undefined], buildPage)).toEqual([]);
    expect(built).toBe(0);
  });

  it('batches by count, dedupes, and returns rows in batch order', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => uuid(i));
    const client = fakePostgrest(
      rowsServer((call) => (inValues(call, 'item_id') ?? []).map((id) => ({ item_id: id }))),
    );
    const rows = await fetchAllRowsByIds<{ item_id: string }>(
      [...ids, ...ids.slice(0, 10), null],
      (batch) => (from, to) =>
        idReadTable(client, 't')
          .select('item_id')
          .in('item_id', batch)
          .order('id')
          .range(from, to) as PromiseLike<PageResult<{ item_id: string }>>,
    );
    expect(client.calls.map((c) => inValues(c, 'item_id')?.length)).toEqual([100, 100, 50]);
    expect(rows.map((r) => r.item_id)).toEqual(ids);
  });

  it('pages a batch past the row cap: a full page asks for the next range, a short page stops', async () => {
    const client = fakePostgrest(
      rowsServer(() => Array.from({ length: 2500 }, (_, i) => ({ n: i }))),
    );
    const rows = await fetchAllRowsByIds<{ n: number }>(['one-id'], (batch) => (from, to) =>
      idReadTable(client, 't')
        .select('n')
        .in('item_id', batch)
        .order('id')
        .range(from, to) as PromiseLike<PageResult<{ n: number }>>,
    );
    expect(client.calls.map((c) => [c.from, c.to])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    expect(rows).toHaveLength(2500);
    expect(rows[1000]).toEqual({ n: 1000 });
  });

  it('caps the page size at the server row cap, so a full server page is never read as the end', async () => {
    const client = fakePostgrest(
      // The server clamps every response to max_rows, whatever range is asked.
      (call) => {
        const all = Array.from({ length: 1500 }, (_, i) => ({ n: i }));
        const to = Math.min(call.to, call.from + POSTGREST_MAX_ROWS - 1);
        return { data: all.slice(call.from, to + 1), error: null };
      },
    );
    const rows = await fetchAllRowsByIds<{ n: number }>(
      ['x'],
      (batch) => (from, to) =>
        idReadTable(client, 't')
          .select('n')
          .in('id', batch)
          .order('id')
          .range(from, to) as PromiseLike<PageResult<{ n: number }>>,
      { pageSize: 5000 },
    );
    expect(rows).toHaveLength(1500);
    expect(client.calls[0]!.to - client.calls[0]!.from + 1).toBe(POSTGREST_MAX_ROWS);
  });

  it('fetchAllPages caps a larger page size too: a clamped 1000-row page asks for the next one', async () => {
    const all = Array.from({ length: 1500 }, (_, i) => ({ n: i }));
    const asked: [number, number][] = [];
    const rows = await fetchAllPages<{ n: number }>((from, to) => {
      asked.push([from, to]);
      // The server clamps every response to max_rows, whatever range is asked.
      const end = Math.min(to, from + POSTGREST_MAX_ROWS - 1);
      return Promise.resolve({ data: all.slice(from, end + 1), error: null });
    }, 5000);
    expect(rows).toHaveLength(1500);
    expect(asked).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('a failed batch rejects with IdBatchReadError carrying the message, and returns no rows', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => uuid(i));
    const client = fakePostgrest((call) => {
      const vals = inValues(call, 'item_id') ?? [];
      if (vals.includes(uuid(120))) {
        return { data: null, error: { message: 'URI too long' }, status: 414, statusText: 'URI Too Long' };
      }
      return { data: vals.map((id) => ({ id })), error: null };
    });
    const read = fetchAllRowsByIds(ids, (batch) => (from, to) =>
      idReadTable(client, 't').select('id').in('item_id', batch).order('id').range(from, to),
    );
    await expect(read).rejects.toBeInstanceOf(IdBatchReadError);
    await expect(read).rejects.toMatchObject({ message: 'URI too long', status: 414 });
  });

  it('an error with an empty message says what came back instead', async () => {
    const read = fetchAllRowsByIds(['a'], () => () =>
      Promise.resolve({ data: null, error: { message: '' }, status: 502, statusText: 'Bad Gateway' }),
    );
    await expect(read).rejects.toMatchObject({ message: 'HTTP 502 Bad Gateway', status: 502 });
  });

  it('readErrorMessage is never empty: an empty gateway error body says what came back', () => {
    // postgrest-js turns a non-JSON body into { message: body }, so an empty
    // 502 body is an empty message; a screen that tests it for truthiness
    // would show nothing and pass the failure off as an empty list.
    expect(readErrorMessage({ message: '' }, 502, 'Bad Gateway')).toBe('HTTP 502 Bad Gateway');
    expect(readErrorMessage({ message: '' }, 504)).toBe('HTTP 504');
    expect(readErrorMessage({ message: '' })).toBe('HTTP ?');
    expect(readErrorMessage({ message: 'permission denied' }, 403)).toBe('permission denied');
  });

  it('a rejected request (network failure) rejects with IdBatchReadError', async () => {
    const read = fetchAllRowsByIds(['a'], () => () => Promise.reject(new TypeError('Network request failed')));
    await expect(read).rejects.toBeInstanceOf(IdBatchReadError);
    await expect(read).rejects.toMatchObject({ message: 'Network request failed', status: null });
  });

  it('a builder that throws rejects with IdBatchReadError', async () => {
    const read = fetchAllRowsByIds(['a'], () => {
      throw new Error('bad builder');
    });
    await expect(read).rejects.toBeInstanceOf(IdBatchReadError);
  });

  it('a batch still full after the page cap is REFUSED, never returned short', async () => {
    const read = fetchAllRowsByIds(
      ['a'],
      () => (from, to) =>
        Promise.resolve({
          data: Array.from({ length: to - from + 1 }, (_, i) => from + i),
          error: null,
        }),
      { pageSize: 2 },
    );
    await expect(read).rejects.toMatchObject({ message: 'Too many rows to load on the phone.' });
    expect(MAX_PAGES_PER_BATCH).toBe(20);
  });

  it('runs at most N batches at once and starts no new batch after a failure', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => uuid(i));
    const started: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const read = fetchAllRowsByIds(
      ids,
      (batch) => () => {
        const index = ids.indexOf(batch[0]!) / 100;
        started.push(index);
        // A batch started after the first wave answers at once, so a broken
        // "stop after failure" shows up as extra entries in `started`, not as
        // a hang.
        if (index >= 3) return Promise.resolve({ data: [], error: null });
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise<PageResult<string>>((resolve) => {
          gates[index] = () => {
            inFlight -= 1;
            resolve(
              index === 1
                ? { data: null, error: { message: 'boom' } }
                : { data: [], error: null },
            );
          };
        });
      },
      { concurrency: 3 },
    );
    // Let the first wave start.
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0, 1, 2]);
    gates[1]!(); // batch 1 fails
    await new Promise((r) => setTimeout(r, 0));
    gates[0]!();
    gates[2]!();
    await expect(read).rejects.toMatchObject({ message: 'boom' });
    expect(peak).toBe(3);
    // Nothing started after the failure.
    expect(started).toEqual([0, 1, 2]);
  });
});

describe('settleIdBatchRead', () => {
  it('maps a value to ok and a rejection to a failure, never to an empty value', async () => {
    expect(await settleIdBatchRead(Promise.resolve(new Map([['a', 1]])))).toEqual({
      ok: true,
      value: new Map([['a', 1]]),
    });
    expect(
      await settleIdBatchRead(Promise.reject(new IdBatchReadError('URI too long', 414))),
    ).toEqual({ ok: false, message: 'URI too long' });
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  availableReturnListFilters,
  EXCHANGE_STATUSES,
  EXCHANGE_STATUS_STAFF_LABELS,
  exchangeRequesterSentence,
  exchangeStatusStaffLabel,
  isExchangeStatus,
  parseExchangeStatus,
  parseReturnListFilter,
  RETURN_LIST_FILTERS,
  returnListFilter,
} from './exchange-status';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../../supabase/migrations');

describe('exchange status', () => {
  it('is exactly the fifteen codes of plan 3.10, in precedence order', () => {
    expect([...EXCHANGE_STATUSES]).toEqual([
      'none',
      'handed_over_return_cancelled',
      'cancelled',
      'requested',
      'declined',
      'completed',
      'handed_over_return_open',
      'partly_handed_over',
      'out_for_delivery',
      'ready_for_pickup',
      'in_progress',
      'replacement_cancelled',
      'unavailable',
      'waiting_for_return',
      'ready_to_pick',
    ]);
    // unavailable outranks waiting and ready (a shortage is what someone must act on).
    expect(EXCHANGE_STATUSES.indexOf('unavailable')).toBeLessThan(EXCHANGE_STATUSES.indexOf('waiting_for_return'));
    expect(EXCHANGE_STATUSES.indexOf('unavailable')).toBeLessThan(EXCHANGE_STATUSES.indexOf('ready_to_pick'));
    // handed over with the return open never reads completed (judge A-1).
    expect(EXCHANGE_STATUSES.indexOf('completed')).toBeLessThan(EXCHANGE_STATUSES.indexOf('handed_over_return_open'));
  });

  it('has a staff label for every code and refines three of them', () => {
    for (const s of EXCHANGE_STATUSES) expect(EXCHANGE_STATUS_STAFF_LABELS[s]).toBeTruthy();
    expect(exchangeStatusStaffLabel('cancelled', { returnStatus: 'denied' })).toBe('Exchange declined');
    expect(exchangeStatusStaffLabel('handed_over_return_open', { returnStatus: 'received' })).toBe(
      'Replacement handed over; return not processed',
    );
    expect(exchangeStatusStaffLabel('requested', { replacementShort: true })).toBe('Exchange requested · replacement short');
    expect(exchangeStatusStaffLabel('requested', {})).toBe('Exchange requested');
  });

  it('gives no requester sentence for a plain return, and one for every exchange code', () => {
    expect(exchangeRequesterSentence('none')).toBeNull();
    for (const s of EXCHANGE_STATUSES.filter((x) => x !== 'none')) expect(exchangeRequesterSentence(s)).toBeTruthy();
    expect(exchangeRequesterSentence('cancelled', { denied: true })).toBe('Exchange request declined.');
    expect(exchangeRequesterSentence('waiting_for_return')).toBe('Replacement reserved. Waiting for your return.');
  });

  it('recognises its codes and nothing else', () => {
    expect(isExchangeStatus('ready_to_pick')).toBe(true);
    expect(isExchangeStatus('READY_TO_PICK')).toBe(false);
    expect(isExchangeStatus(null)).toBe(false);
  });

  it('RX-2: the view\'s one CASE (between the exchange-status markers) names exactly these codes, in this precedence order', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f));
    const withMarkers = files.filter((f) => /^[ \t]*-- exchange-status:begin[ \t]*$/m.test(readFileSync(join(MIGRATIONS, f), 'utf8')));
    const rx2 = files.find((f) => f.endsWith('_returns_exchange_staff.sql'));
    expect(rx2).toBeDefined();
    expect(withMarkers.at(-1)).toBe(rx2);
    const sql = readFileSync(join(MIGRATIONS, rx2!), 'utf8');
    // The marker LINES (a comment elsewhere may name the markers).
    const begins = [...sql.matchAll(/^[ \t]*-- exchange-status:begin[ \t]*$/gm)];
    const ends = [...sql.matchAll(/^[ \t]*-- exchange-status:end[ \t]*$/gm)];
    expect(begins).toHaveLength(1);
    expect(ends).toHaveLength(1);
    const begin = begins[0]!.index!;
    const end = ends[0]!.index!;
    expect(end).toBeGreaterThan(begin);
    const block = sql.slice(begin, end);
    const codes = [...block.matchAll(/then\s+'([a-z_]+)'/g)].map((m) => m[1]);
    expect(codes).toEqual([...EXCHANGE_STATUSES]);
    // One code per arm, and no ELSE hiding an unlisted code.
    expect(block).not.toMatch(/\belse\s+'/i);
  });

  it('parses the view value, reading an unknown or missing one as none', () => {
    expect(parseExchangeStatus('unavailable')).toBe('unavailable');
    expect(parseExchangeStatus(null)).toBe('none');
    expect(parseExchangeStatus('newer_code')).toBe('none');
  });
});

describe('the list filters', () => {
  it('RX-1 offers the five filters that need no exchange columns', () => {
    expect(availableReturnListFilters({ exchanges: false }).map((f) => f.id)).toEqual([
      'all',
      'awaiting_approval',
      'waiting_for_return',
      'received_not_processed',
      'closed',
    ]);
    expect(availableReturnListFilters({ exchanges: true })).toHaveLength(RETURN_LIST_FILTERS.length);
  });

  it('maps each to its statuses and sort (waiting: oldest approval first)', () => {
    expect(returnListFilter('awaiting_approval').statuses).toEqual(['requested']);
    expect(returnListFilter('waiting_for_return')).toMatchObject({ statuses: ['approved'], sort: 'approved_asc' });
    expect(returnListFilter('received_not_processed').statuses).toEqual(['received']);
    expect(returnListFilter('closed').statuses).toEqual(['closed', 'denied', 'cancelled']);
    expect(returnListFilter('all').statuses).toBeNull();
  });

  it('RX-2: the exchange filters read the view\'s kind and exchange status (replacement unavailable also takes a requested exchange that is short)', () => {
    expect(returnListFilter('returns')).toMatchObject({ kind: 'return', requiresExchanges: true });
    expect(returnListFilter('exchanges')).toMatchObject({ kind: 'exchange', requiresExchanges: true });
    expect(returnListFilter('replacement_unavailable')).toMatchObject({ exchangeStatuses: ['unavailable'], orRequestedShort: true });
    expect(returnListFilter('replacement_ready').exchangeStatuses).toEqual(['ready_to_pick', 'ready_for_pickup']);
    for (const f of RETURN_LIST_FILTERS) {
      for (const code of f.exchangeStatuses ?? []) expect(isExchangeStatus(code)).toBe(true);
    }
  });

  it('parses a query value, falling back to all for an unknown or unavailable filter', () => {
    expect(parseReturnListFilter('waiting_for_return')).toBe('waiting_for_return');
    expect(parseReturnListFilter(['closed', 'all'])).toBe('closed');
    expect(parseReturnListFilter('exchanges')).toBe('all');
    expect(parseReturnListFilter('exchanges', { exchanges: true })).toBe('exchanges');
    expect(parseReturnListFilter('drop table')).toBe('all');
    expect(parseReturnListFilter(undefined)).toBe('all');
  });
});

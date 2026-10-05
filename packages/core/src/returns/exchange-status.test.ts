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

  it('RX-1: no migration computes an exchange status yet, so no view may carry the column (RX-2 adds the CASE and its parity test)', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f));
    const withMarkers = files.filter((f) => readFileSync(join(MIGRATIONS, f), 'utf8').includes('-- exchange-status:begin'));
    const rx1 = files.find((f) => f.endsWith('_returns_lifecycle_original_rack.sql'));
    expect(rx1).toBeDefined();
    if (withMarkers.length === 0) {
      expect(readFileSync(join(MIGRATIONS, rx1!), 'utf8')).not.toMatch(/exchange_status/);
    } else {
      // RX-2 has landed: its CASE must name exactly these codes.
      const sql = readFileSync(join(MIGRATIONS, withMarkers.at(-1)!), 'utf8');
      const block = sql.slice(sql.indexOf('-- exchange-status:begin'), sql.indexOf('-- exchange-status:end'));
      const codes = [...block.matchAll(/then\s+'([a-z_]+)'/g)].map((m) => m[1]);
      expect(new Set(codes)).toEqual(new Set(EXCHANGE_STATUSES));
    }
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

  it('parses a query value, falling back to all for an unknown or unavailable filter', () => {
    expect(parseReturnListFilter('waiting_for_return')).toBe('waiting_for_return');
    expect(parseReturnListFilter(['closed', 'all'])).toBe('closed');
    expect(parseReturnListFilter('exchanges')).toBe('all');
    expect(parseReturnListFilter('exchanges', { exchanges: true })).toBe('exchanges');
    expect(parseReturnListFilter('drop table')).toBe('all');
    expect(parseReturnListFilter(undefined)).toBe('all');
  });
});

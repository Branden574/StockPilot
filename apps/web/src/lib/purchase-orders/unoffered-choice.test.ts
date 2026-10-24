import { describe, expect, it } from 'vitest';

import { isSiteLocation } from '@stockpilot/core';

import {
  unofferedDestinationFrom,
  unofferedDestinationNote,
  unofferedSupplierNote,
} from './unoffered-choice';

/**
 * The notes under Destination and Supplier when a purchase order or template
 * holds a value the form does not offer (small fixes slice 8), and how a
 * location row's state decides which note. The forms' own tests cover the
 * common cases end to end; this pins every wording branch once.
 */
describe('unofferedDestinationFrom: why a destination is not offered', () => {
  const row = (over: Record<string, unknown>) => ({
    name: 'Somewhere',
    kind: null as string | null,
    type: 'warehouse' as string | null,
    warehouse_id: 'wh-1' as string | null,
    deleted_at: null as string | null,
    ...over,
  });
  const judge = (r: ReturnType<typeof row>) => unofferedDestinationFrom(r, isSiteLocation(r));

  it('deleted wins over everything else', () => {
    expect(judge(row({ kind: 'staging', deleted_at: '2026-10-01T00:00:00Z' }))).toEqual({
      name: 'Somewhere',
      why: 'deleted',
    });
  });

  it('a staging area, Unplaced, a rack or a shelf is not a site', () => {
    expect(judge(row({ kind: 'staging' })).why).toBe('not_a_site');
    expect(judge(row({ kind: 'unplaced' })).why).toBe('not_a_site');
    expect(judge(row({ kind: 'rack' })).why).toBe('not_a_site');
    expect(judge(row({ type: 'shelf' })).why).toBe('not_a_site');
  });

  it('a site linked to no warehouse', () => {
    expect(judge(row({ warehouse_id: null }))).toEqual({ name: 'Somewhere', why: 'no_warehouse' });
  });

  it('no row, or a blank name, is not guessed at', () => {
    expect(unofferedDestinationFrom(null, false)).toEqual({ name: null, why: 'unknown' });
    expect(judge(row({ name: '   ', deleted_at: '2026-10-01T00:00:00Z' }))).toEqual({ name: null, why: 'deleted' });
  });
});

describe('the notes', () => {
  it('a purchase order "goes to" its destination', () => {
    expect(unofferedDestinationNote('purchase_order', { name: 'Old Annex', why: 'deleted' })).toBe(
      'This purchase order goes to "Old Annex", which was deleted, so choose a destination.',
    );
    expect(unofferedDestinationNote('purchase_order', { name: null, why: 'deleted' })).toBe(
      'This purchase order goes to a location that was deleted, so choose a destination.',
    );
    expect(unofferedDestinationNote('purchase_order', { name: 'District Office', why: 'no_warehouse' })).toBe(
      'This purchase order goes to "District Office", which isn\'t linked to a warehouse, so choose a destination.',
    );
    expect(unofferedDestinationNote('purchase_order', { name: 'Staging', why: 'not_a_site' })).toBe(
      'This purchase order goes to "Staging", which is not a site you can pick here, so choose a destination.',
    );
    expect(unofferedDestinationNote('purchase_order', null)).toBe(
      "This purchase order goes to a location you can't pick here, so choose a destination.",
    );
  });

  it('a template "has" one', () => {
    expect(unofferedDestinationNote('template', { name: 'Old Annex', why: 'deleted' })).toBe(
      'This template\'s destination, "Old Annex", was deleted, so choose a destination.',
    );
    expect(unofferedDestinationNote('template', { name: null, why: 'deleted' })).toBe(
      "This template's destination was deleted, so choose a destination.",
    );
    expect(unofferedDestinationNote('template', { name: 'District Office', why: 'no_warehouse' })).toBe(
      'This template\'s destination, "District Office", isn\'t linked to a warehouse, so choose a destination.',
    );
    expect(unofferedDestinationNote('template', { name: 'Staging', why: 'not_a_site' })).toBe(
      'This template\'s destination, "Staging", is not a site you can pick here, so choose a destination.',
    );
    expect(unofferedDestinationNote('template', undefined)).toBe(
      "This template's destination is a location you can't pick here, so choose a destination.",
    );
  });

  it('a supplier', () => {
    expect(unofferedSupplierNote('purchase_order', { name: 'Acme Paper', why: 'archived' })).toBe(
      'This purchase order\'s supplier, "Acme Paper", was archived, so choose a supplier.',
    );
    expect(unofferedSupplierNote('template', { name: null, why: 'archived' })).toBe(
      "This template's supplier was archived, so choose a supplier.",
    );
    expect(unofferedSupplierNote('purchase_order', null)).toBe(
      "This purchase order's supplier is not one you can pick here, so choose a supplier.",
    );
  });
});

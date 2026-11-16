import { describe, expect, it } from 'vitest';

import {
  eventsWithRecordedDetails,
  formatAuditEvent,
  formatEntityType,
  recordedDetailFields,
} from './format';

/**
 * The audit log's event and entity labels. A recurring template's events
 * title-cased to "Recurring Po Template · Run Skipped" (slice 8 review): PO is
 * an initialism, as everywhere else in the product.
 */
describe('audit labels', () => {
  it('names a recurring PO template as the product does', () => {
    expect(formatAuditEvent('recurring_po_template.run_skipped')).toBe(
      'Recurring PO template · Run Skipped',
    );
    expect(formatAuditEvent('recurring_po_template.created')).toBe(
      'Recurring PO template · Created',
    );
    expect(formatEntityType('recurring_po_template')).toBe('Recurring PO template');
  });

  it('keeps the existing labels', () => {
    expect(formatAuditEvent('purchase_order.status_changed')).toBe(
      'Purchase Order · Status Changed',
    );
    expect(formatEntityType('purchase_order')).toBe('Purchase order');
    expect(formatAuditEvent('po_import.created')).toBe('PO import · Created');
  });
});

describe('API key rows', () => {
  it('read API key, as the product names them', () => {
    expect(formatAuditEvent('api_key.created')).toBe('API key · Created');
    expect(formatAuditEvent('api_key.revoked')).toBe('API key · Revoked');
    expect(formatEntityType('api_key')).toBe('API key');
  });
});

describe('recordedDetailFields', () => {
  it('gives the fields named for the event, in order, that the row holds', () => {
    expect(
      recordedDetailFields('api_key.created', {
        scopes: ['items:read'],
        name: 'Warehouse sync',
        entity_id: 'x',
      }),
    ).toEqual([
      { field: 'name', value: 'Warehouse sync' },
      { field: 'scopes', value: ['items:read'] },
    ]);
    expect(recordedDetailFields('api_key.revoked', { name: 'Warehouse sync', scopes: [] })).toEqual(
      [{ field: 'name', value: 'Warehouse sync' }],
    );
  });

  it('gives nothing for an event with none listed, a missing or null field, or no metadata', () => {
    expect(recordedDetailFields('stock.adjusted', { name: 'x' })).toEqual([]);
    expect(recordedDetailFields('constructor', { name: 'x' })).toEqual([]);
    expect(recordedDetailFields('api_key.created', { name: null })).toEqual([]);
    expect(recordedDetailFields('api_key.created', null)).toEqual([]);
    expect(recordedDetailFields(null, { name: 'x' })).toEqual([]);
  });

  it('lists no field named like a key, a secret, a hash or a token', () => {
    const listed = eventsWithRecordedDetails();
    expect(listed.map(([event]) => event)).toEqual(['api_key.created', 'api_key.revoked']);
    for (const [event, fields] of listed) {
      for (const field of fields) {
        expect(field, event).not.toMatch(/key|secret|hash|token|prefix|password/i);
      }
    }
  });
});

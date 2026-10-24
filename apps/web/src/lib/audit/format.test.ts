import { describe, expect, it } from 'vitest';

import { formatAuditEvent, formatEntityType } from './format';

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

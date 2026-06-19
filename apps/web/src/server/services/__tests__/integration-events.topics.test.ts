import { describe, expect, it } from 'vitest';

import { INTEGRATION_EVENT_TYPES, describeEvent } from '../integration-events';

/**
 * TDD: new lifecycle event types wired in feat/integration-topics.
 *
 * Red → Green lifecycle:
 *   1. Run before adding types → these assertions FAIL (registry missing entries,
 *      describeEvent returns the generic fallback).
 *   2. Add types + describeEvent cases → all assertions PASS.
 */

const NEW_TYPES = [
  'order.approved',
  'order.denied',
  'order.in_transit',
  'order.cancelled',
  'order.completed', // may already be in registry — check is the same either way
  'po.cancelled',
  'return.approved',
  'return.closed',
  'return.denied',
] as const;

describe('INTEGRATION_EVENT_TYPES registry', () => {
  for (const type of NEW_TYPES) {
    it(`includes "${type}"`, () => {
      expect(INTEGRATION_EVENT_TYPES as readonly string[]).toContain(type);
    });
  }
});

describe('describeEvent — new lifecycle types', () => {
  it('order.approved', () => {
    const { title, summary } = describeEvent('order.approved', { id: 'abc123', orderNumber: 'ABC123' });
    expect(title.trim()).toBeTruthy();
    expect(summary.trim()).toBeTruthy();
    expect(title).not.toBe('StockPilot event');
    expect(summary).not.toBe('order.approved');
    expect(summary).toContain('ABC123');
  });

  it('order.denied — includes reason when present', () => {
    const withReason = describeEvent('order.denied', {
      id: 'abc123',
      orderNumber: 'ABC123',
      reason: 'Out of stock',
    });
    expect(withReason.title.trim()).toBeTruthy();
    expect(withReason.summary.trim()).toBeTruthy();
    expect(withReason.summary).toContain('ABC123');
    expect(withReason.summary).toContain('Out of stock');

    const noReason = describeEvent('order.denied', { id: 'abc123', orderNumber: 'ABC123' });
    expect(noReason.summary).toContain('ABC123');
  });

  it('order.in_transit', () => {
    const { title, summary } = describeEvent('order.in_transit', { id: 'abc123', orderNumber: 'ABC123' });
    expect(title.trim()).toBeTruthy();
    expect(summary.trim()).toBeTruthy();
    expect(title).not.toBe('StockPilot event');
    expect(summary).toContain('ABC123');
  });

  it('order.cancelled', () => {
    const { title, summary } = describeEvent('order.cancelled', { id: 'abc123', orderNumber: 'ABC123' });
    expect(title.trim()).toBeTruthy();
    expect(summary.trim()).toBeTruthy();
    expect(title).not.toBe('StockPilot event');
    expect(summary).toContain('ABC123');
  });

  it('order.completed — includes signer name', () => {
    const { title, summary } = describeEvent('order.completed', {
      id: 'abc123',
      orderNumber: 'ABC123',
      signerName: 'Jane Doe',
    });
    expect(title.trim()).toBeTruthy();
    expect(summary.trim()).toBeTruthy();
    expect(title).not.toBe('StockPilot event');
    expect(summary).toContain('ABC123');
    expect(summary).toContain('Jane Doe');
  });

  it('po.cancelled', () => {
    const { title, summary } = describeEvent('po.cancelled', { id: 'po-123', poNumber: 'PO-2026-001' });
    expect(title.trim()).toBeTruthy();
    expect(summary.trim()).toBeTruthy();
    expect(title).not.toBe('StockPilot event');
    expect(summary).toContain('PO-2026-001');
  });

  it('return.approved', () => {
    const { title, summary } = describeEvent('return.approved', {
      id: 'ret-1',
      returnNumber: 'RMA-20260618-A1B2C3',
    });
    expect(title.trim()).toBeTruthy();
    expect(summary.trim()).toBeTruthy();
    expect(title).not.toBe('StockPilot event');
    expect(summary).toContain('RMA-20260618-A1B2C3');
  });

  it('return.closed — includes disposition when present', () => {
    const withDisp = describeEvent('return.closed', {
      id: 'ret-1',
      returnNumber: 'RMA-20260618-A1B2C3',
      disposition: 'restock',
    });
    expect(withDisp.title.trim()).toBeTruthy();
    expect(withDisp.summary.trim()).toBeTruthy();
    expect(withDisp.summary).toContain('RMA-20260618-A1B2C3');
    expect(withDisp.summary).toContain('restock');

    const noDisp = describeEvent('return.closed', { id: 'ret-1', returnNumber: 'RMA-20260618-A1B2C3' });
    expect(noDisp.summary).toContain('RMA-20260618-A1B2C3');
  });

  it('return.denied — includes reason when present', () => {
    const withReason = describeEvent('return.denied', {
      id: 'ret-1',
      returnNumber: 'RMA-20260618-A1B2C3',
      reason: 'Non-returnable condition',
    });
    expect(withReason.title.trim()).toBeTruthy();
    expect(withReason.summary.trim()).toBeTruthy();
    expect(withReason.summary).toContain('RMA-20260618-A1B2C3');
    expect(withReason.summary).toContain('Non-returnable condition');

    const noReason = describeEvent('return.denied', { id: 'ret-1', returnNumber: 'RMA-20260618-A1B2C3' });
    expect(noReason.summary).toContain('RMA-20260618-A1B2C3');
  });
});

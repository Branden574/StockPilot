import { describe, expect, it } from 'vitest';

import {
  CYCLE_COUNT_PAGE_SIZE,
  cycleCountScopeLabel,
  parseCycleCountStatusFilter,
} from './cycle-count-list';

describe('CYCLE_COUNT_PAGE_SIZE', () => {
  it('is 25 count sessions per page', () => {
    expect(CYCLE_COUNT_PAGE_SIZE).toBe(25);
  });
});

describe('parseCycleCountStatusFilter', () => {
  it('accepts the three real statuses', () => {
    expect(parseCycleCountStatusFilter('in_progress')).toBe('in_progress');
    expect(parseCycleCountStatusFilter('completed')).toBe('completed');
    expect(parseCycleCountStatusFilter(['canceled'])).toBe('canceled');
  });

  it('treats anything else as all statuses', () => {
    for (const bad of [undefined, null, '', 'all', 'posted', 'COMPLETED', 'draft', 3, {}]) {
      expect(parseCycleCountStatusFilter(bad)).toBeNull();
    }
  });
});

describe('cycleCountScopeLabel', () => {
  it('names the header warehouse', () => {
    expect(cycleCountScopeLabel({ warehouseId: 'w1', warehouseName: 'DC4', scope: 'warehouse' })).toBe('DC4');
    expect(cycleCountScopeLabel({ warehouseId: 'w1', warehouseName: 'DC4', scope: 'selection' })).toBe('DC4');
  });

  it('says All warehouses only for a real org-wide count', () => {
    expect(cycleCountScopeLabel({ warehouseId: null, warehouseName: null, scope: 'warehouse' })).toBe(
      'All warehouses',
    );
  });

  it('never calls a mixed selection All warehouses', () => {
    expect(cycleCountScopeLabel({ warehouseId: null, warehouseName: null, scope: 'selection' })).toBe(
      'Selected items',
    );
  });

  it('does not show a blank when the name cannot be read', () => {
    expect(cycleCountScopeLabel({ warehouseId: 'w1', warehouseName: null, scope: 'warehouse' })).toBe(
      'Warehouse unavailable',
    );
    expect(cycleCountScopeLabel({ warehouseId: 'w1', warehouseName: '  ', scope: 'warehouse' })).toBe(
      'Warehouse unavailable',
    );
  });
});

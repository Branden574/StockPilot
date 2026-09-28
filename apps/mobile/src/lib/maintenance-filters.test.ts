import { describe, expect, it } from 'vitest';

import {
  MAINTENANCE_STATUS_CHIPS,
  maintenanceRelatedRows,
  resolutionProofCaption,
  shouldShowResolutionCard,
  splitPhotosByKind,
  statusPillTone,
  statusQueryParam,
} from './maintenance-filters';

describe('MAINTENANCE_STATUS_CHIPS', () => {
  it('is literal-pinned: All, Active, then the five status labels in MAINTENANCE_STATUS_LABELS order', () => {
    expect(MAINTENANCE_STATUS_CHIPS.map((c) => c.label)).toEqual([
      'All',
      'Active',
      'Saved',
      'Email draft opened',
      'Resolved',
      'Archived',
      'Cancelled',
    ]);
  });

  it('the values behind those labels are literal-pinned too (a label drift fails here even if the text above still matched by accident)', () => {
    expect(MAINTENANCE_STATUS_CHIPS.map((c) => c.value)).toEqual([
      undefined,
      'active',
      'saved',
      'draft_opened',
      'resolved',
      'archived',
      'cancelled',
    ]);
  });
});

describe('statusQueryParam', () => {
  it('maps the tapped chip label to the query value the list route expects', () => {
    expect(statusQueryParam('All')).toBeUndefined();
    expect(statusQueryParam('Active')).toBe('active');
    expect(statusQueryParam('Resolved')).toBe('resolved');
  });

  it('maps every other real-status chip label too', () => {
    expect(statusQueryParam('Saved')).toBe('saved');
    expect(statusQueryParam('Email draft opened')).toBe('draft_opened');
    expect(statusQueryParam('Archived')).toBe('archived');
    expect(statusQueryParam('Cancelled')).toBe('cancelled');
  });

  it('an unrecognized label degrades to undefined (same as All) rather than throwing', () => {
    expect(statusQueryParam('Ticket resolved')).toBeUndefined();
    expect(statusQueryParam('')).toBeUndefined();
  });
});

describe('statusPillTone', () => {
  it('maps every real status to its T2 pill tone', () => {
    expect(statusPillTone('saved')).toBe('default');
    expect(statusPillTone('draft_opened')).toBe('warn');
    expect(statusPillTone('resolved')).toBe('ok');
    expect(statusPillTone('archived')).toBe('default');
    expect(statusPillTone('cancelled')).toBe('default');
  });
});

describe('shouldShowResolutionCard', () => {
  it('true when resolvedAt is set', () => {
    expect(shouldShowResolutionCard({ resolvedAt: '2026-08-05T00:00:00.000Z' })).toBe(true);
  });

  it('false when resolvedAt is null — never shows on an open request', () => {
    expect(shouldShowResolutionCard({ resolvedAt: null })).toBe(false);
  });
});

describe('splitPhotosByKind', () => {
  it("buckets requester and resolution photos, preserving each bucket's original order", () => {
    const photos = [
      { id: 'p1', kind: 'requester' as const },
      { id: 'p2', kind: 'resolution' as const },
      { id: 'p3', kind: 'requester' as const },
      { id: 'p4', kind: 'resolution' as const },
    ];
    expect(splitPhotosByKind(photos)).toEqual({
      requester: [photos[0], photos[2]],
      resolution: [photos[1], photos[3]],
    });
  });

  it('a missing kind defaults to requester (legacy-row fallback, matches web byte-for-byte)', () => {
    const photos = [{ id: 'p1', kind: undefined }];
    expect(splitPhotosByKind(photos)).toEqual({ requester: [{ id: 'p1', kind: undefined }], resolution: [] });
  });

  it('a null kind also defaults to requester', () => {
    const photos = [{ id: 'p1', kind: null }];
    expect(splitPhotosByKind(photos)).toEqual({ requester: [{ id: 'p1', kind: null }], resolution: [] });
  });

  it('never leaks a resolution photo into the requester bucket, and vice versa', () => {
    const photos = [{ id: 'p1', kind: 'resolution' as const }];
    const result = splitPhotosByKind(photos);
    expect(result.requester).toHaveLength(0);
    expect(result.resolution).toHaveLength(1);
  });

  it('an empty list splits into two empty buckets', () => {
    expect(splitPhotosByKind([])).toEqual({ requester: [], resolution: [] });
  });
});

describe('resolutionProofCaption', () => {
  it('returns the "Added by the team..." caption when resolvedAt is set', () => {
    expect(resolutionProofCaption('2026-08-05T00:00:00.000Z')).toBe(
      'Added by the team when this request was marked resolved.',
    );
  });

  it('returns the "Staged by the team..." caption when resolvedAt is null', () => {
    expect(resolutionProofCaption(null)).toBe(
      'Staged by the team while preparing to mark this request resolved.',
    );
  });

  it('the two captions are literal-pinned to match web byte-for-byte', () => {
    // Mutation guard: unconditional "Added by the team..." string will fail this
    const captionWhenResolved = resolutionProofCaption('2026-08-05T00:00:00.000Z');
    const captionWhenStaged = resolutionProofCaption(null);
    expect(captionWhenResolved).not.toBe(captionWhenStaged);
  });
});

describe('maintenanceRelatedRows (F1-5: the request detail shows its item and location)', () => {
  const ITEM = '22222222-2222-4222-8222-222222222222';
  const LOC = '55555555-5555-4555-8555-555555555555';

  // Mutation caught: the location row left out, or worded differently from
  // the email's "Related Location: <name> (<warehouse>)" line.
  it('names the location as the email does, and opens its screen', () => {
    const rows = maintenanceRelatedRows({
      relatedItemId: ITEM,
      relatedLocationId: LOC,
      relatedItem: { name: 'Atlas', sku: 'A1' },
      relatedLocation: { name: 'Staging', warehouseName: 'DC4' },
    });
    expect(rows.location).toEqual({ value: 'Staging (DC4)', href: `/location/${LOC}` });
    expect(rows.item).toEqual({ value: 'Atlas (A1)', href: `/item/${ITEM}` });
  });

  it('no warehouse or SKU: the name alone; no id: plain text', () => {
    const rows = maintenanceRelatedRows({
      relatedItemId: null,
      relatedLocationId: null,
      relatedItem: { name: 'Atlas', sku: null },
      relatedLocation: { name: 'Staging', warehouseName: null },
    });
    expect(rows.item).toEqual({ value: 'Atlas', href: null });
    expect(rows.location).toEqual({ value: 'Staging', href: null });
  });

  // Mutation caught: a row rendered from the id alone (a blank value).
  it('no record, or a blank name: no row', () => {
    expect(
      maintenanceRelatedRows({ relatedItemId: ITEM, relatedLocationId: LOC, relatedItem: null, relatedLocation: undefined }),
    ).toEqual({ item: null, location: null });
    expect(
      maintenanceRelatedRows({
        relatedItemId: ITEM,
        relatedLocationId: LOC,
        relatedItem: { name: '  ', sku: 'A1' },
        relatedLocation: { name: '', warehouseName: 'DC4' },
      }),
    ).toEqual({ item: null, location: null });
  });
});

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ORDER_FAULT_COPY,
  ORDER_RATE_LIMITED_COPY,
  ORDER_SIGN_IN_COPY,
  ORDER_STOREFRONT_LOAD_FAILED_COPY,
  ORDER_STOREFRONT_RATE_LIMITED_COPY,
  ORDER_STOREFRONT_SIGN_IN_COPY,
} from '../place-order';
import { ORDER_CATALOG_MANAGE_PAGE_SIZE } from '../catalog-visibility';
import {
  ORDER_CATALOG_ROW_CEILING,
  ORDER_CATALOG_STALE_AFTER_SECONDS,
  ORDER_PHOTO_URL_TTL_SECONDS,
  ORDER_STOREFRONT_PART_DEADLINE_MS,
  type OrderCatalogFamilyAnswer,
  type OrderCatalogManageListAnswer,
  type OrderCatalogManageRow,
  type OrderCatalogVisibilityWriteAnswer,
  type OrderCatalogVisibilityWriteBody,
  type OrderStorefrontViewer,
} from './phone-api';

/**
 * The phone storefront's read contract (phone ordering PO-3, plan 3.1): the
 * numbers the server and the phone both read, and the words of a read.
 */
describe('the phone storefront read contract', () => {
  it('pins the plan numbers', () => {
    expect(ORDER_STOREFRONT_PART_DEADLINE_MS).toBe(2_500);
    expect(ORDER_CATALOG_STALE_AFTER_SECONDS).toBe(60);
    expect(ORDER_CATALOG_ROW_CEILING).toBe(10_000);
    expect(ORDER_PHOTO_URL_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it('a read is not a submission: its words never point at Check and finish', () => {
    for (const s of [
      ORDER_STOREFRONT_LOAD_FAILED_COPY,
      ORDER_STOREFRONT_RATE_LIMITED_COPY,
      ORDER_STOREFRONT_SIGN_IN_COPY,
    ]) {
      expect(s).not.toMatch(/check and finish|order request/i);
      expect(s).not.toMatch(/\bbook\b/i);
    }
    // The submission sentences stay as they are, and differ from the reads'.
    expect(ORDER_STOREFRONT_LOAD_FAILED_COPY).not.toBe(ORDER_FAULT_COPY);
    expect(ORDER_STOREFRONT_RATE_LIMITED_COPY).not.toBe(ORDER_RATE_LIMITED_COPY);
    expect(ORDER_STOREFRONT_SIGN_IN_COPY).not.toBe(ORDER_SIGN_IN_COPY);
  });

  it('a failed read says how to read it again on the phone', () => {
    expect(ORDER_STOREFRONT_LOAD_FAILED_COPY).toMatch(/Pull down to try again\.$/);
    expect(ORDER_STOREFRONT_RATE_LIMITED_COPY).toMatch(/pull down to try again\.$/);
  });
});

// Ordering visibility (0413): the storefront answer says whether the viewer may
// open Manage order items, and the management routes answer these shapes.
describe('the ordering-visibility contract', () => {
  it('the viewer flag is optional (an answer from an older server still parses) and boolean', () => {
    expectTypeOf<OrderStorefrontViewer['canManageOrderItems']>().toEqualTypeOf<boolean | undefined>();
    const viewer: OrderStorefrontViewer = {
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'manager',
      name: 'Pat Example',
      email: 'pat@example.test',
      canOrderOnBehalf: true,
      canApproveOrders: true,
    };
    // The phone shows the entry only for an explicit true.
    expect(viewer.canManageOrderItems === true).toBe(false);
  });

  it('a management row, list, family and write answer', () => {
    const row: OrderCatalogManageRow = {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'New Hire Shirt',
      sku: 'NHS-XS',
      identifier: null,
      itemType: 'item',
      sizeOrEdition: 'XS',
      warehouseId: '33333333-3333-4333-8333-333333333333',
      warehouseName: 'North',
      categoryName: 'Apparel',
      familyId: '55555555-5555-4555-8555-555555555555',
      familyName: 'New Hire Shirt',
      expected: false,
      visible: false,
      hiddenSince: '2026-10-26T18:00:00.000Z',
      thumbUrl: null,
    };
    const list: OrderCatalogManageListAnswer = {
      organizationId: '66666666-6666-4666-8666-666666666666',
      viewer: { canManage: true },
      page: 1,
      pageSize: ORDER_CATALOG_MANAGE_PAGE_SIZE,
      total: 1,
      rows: [row],
    };
    const family: OrderCatalogFamilyAnswer = {
      organizationId: list.organizationId,
      familyId: row.familyId!,
      familyName: row.familyName,
      rows: [row],
      truncated: false,
    };
    const body: OrderCatalogVisibilityWriteBody = {
      itemIds: [row.id],
      visible: false,
      operationId: '77777777-7777-4777-8777-777777777777',
    };
    const answer: OrderCatalogVisibilityWriteAnswer = {
      organizationId: list.organizationId,
      operationId: body.operationId,
      visible: false,
      changed: [row.id],
      unchanged: [],
    };
    expectTypeOf<OrderCatalogManageRow['itemType']>().toEqualTypeOf<'item' | 'book'>();
    expect(family.rows[0]).toBe(row);
    expect(answer.changed).toEqual(body.itemIds);
  });
});

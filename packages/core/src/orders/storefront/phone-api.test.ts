import { describe, expect, it } from 'vitest';

import {
  ORDER_FAULT_COPY,
  ORDER_RATE_LIMITED_COPY,
  ORDER_SIGN_IN_COPY,
  ORDER_STOREFRONT_LOAD_FAILED_COPY,
  ORDER_STOREFRONT_RATE_LIMITED_COPY,
  ORDER_STOREFRONT_SIGN_IN_COPY,
} from '../place-order';
import {
  ORDER_CATALOG_ROW_CEILING,
  ORDER_CATALOG_STALE_AFTER_SECONDS,
  ORDER_PHOTO_URL_TTL_SECONDS,
  ORDER_STOREFRONT_PART_DEADLINE_MS,
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

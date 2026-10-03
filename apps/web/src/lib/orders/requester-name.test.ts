import { describe, expect, it } from 'vitest';

import { DELETED_REQUESTER_LABEL } from '@stockpilot/core';

import { detailRequesterName } from './requester-name';

/**
 * Review R9 (2026-10-03): the pick page and the pick slip PDF printed "—" for
 * an order whose requester deleted their account, while the order page, the
 * list, print and the exports say "Deleted user". The name they print now
 * comes from one helper over get()'s detail: the resolved name, else "Deleted
 * user" when the ROW has no requester id and no email (core
 * isDeletedRequester, strict null), else null (the caller's own fallback).
 */
function detail(
  request: { requester_user_id?: string | null; requester_email?: string | null },
  requesterName: string | null,
) {
  return { request, requesterName };
}

describe('detailRequesterName', () => {
  it('a requester who deleted their account: Deleted user', () => {
    expect(detailRequesterName(detail({ requester_user_id: null, requester_email: null }, null))).toBe(
      DELETED_REQUESTER_LABEL,
    );
    expect(DELETED_REQUESTER_LABEL).toBe('Deleted user');
  });

  it('a resolved name always wins (a name the row already held stays)', () => {
    expect(detailRequesterName(detail({ requester_user_id: null, requester_email: null }, 'Doua Vang'))).toBe(
      'Doua Vang',
    );
    expect(detailRequesterName(detail({ requester_user_id: 'u-1', requester_email: null }, 'Jane Doe'))).toBe(
      'Jane Doe',
    );
  });

  it('a live member with no name, or an email-only requester: null (the caller falls back)', () => {
    expect(detailRequesterName(detail({ requester_user_id: 'u-1', requester_email: null }, null))).toBeNull();
    expect(detailRequesterName(detail({ requester_user_id: null, requester_email: 'a@b.org' }, null))).toBeNull();
  });

  it('columns the read did not carry (undefined) are never taken as deleted', () => {
    expect(detailRequesterName(detail({}, null))).toBeNull();
  });
});

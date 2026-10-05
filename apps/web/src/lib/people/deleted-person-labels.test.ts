import { describe, expect, it } from 'vitest';

import {
  auditActorName,
  orderTimelineActor,
  platformAuditActorLabel,
  platformAuditTargetLabel,
  returnRequesterLabel,
} from './deleted-person-labels';

/**
 * Each surface whose wording changed with 0394: stamped (the person deleted
 * their account), unstamped null (the surface's own words), live, and hidden.
 */
const STAMP = '2026-11-04T18:22:05.123456+00:00';

describe('auditActorName (/dashboard/audit)', () => {
  it('names a live actor, then their email', () => {
    expect(
      auditActorName({ actor: { fullName: 'Marissa', email: 'm@x.org' }, actorDeleted: false }),
    ).toBe('Marissa');
    expect(
      auditActorName({ actor: { fullName: null, email: 'm@x.org' }, actorDeleted: false }),
    ).toBe('m@x.org');
  });
  it('says "Deleted user" for a stamped row and "System" for an unstamped one', () => {
    expect(auditActorName({ actor: null, actorDeleted: true })).toBe('Deleted user');
    expect(auditActorName({ actor: null, actorDeleted: false })).toBe('System');
  });
  it('says "Unknown" for a profile with neither name nor email', () => {
    expect(auditActorName({ actor: { fullName: null, email: null }, actorDeleted: false })).toBe(
      'Unknown',
    );
  });
});

describe('orderTimelineActor (order page timeline)', () => {
  it('names a live member, else "Unknown user" for one the reader cannot see', () => {
    expect(orderTimelineActor({ full_name: 'Doua', email: null }, { user_id: 'u1' })).toBe('Doua');
    expect(orderTimelineActor(null, { user_id: 'u1' })).toBe('Unknown user');
  });
  it('says "Public" for a public-link step and "Deleted user" for a stamped one', () => {
    expect(orderTimelineActor(null, { user_id: null, deleted_users: null })).toBe('Public');
    expect(orderTimelineActor(null, { user_id: null, deleted_users: { user_id: STAMP } })).toBe(
      'Deleted user',
    );
  });
});

describe('returnRequesterLabel (return detail)', () => {
  it('keeps the recorded requester name', () => {
    expect(
      returnRequesterLabel({
        requester_name: 'Pat Doe',
        requested_by: null,
        deleted_users: { requested_by: STAMP },
      }),
    ).toBe('Pat Doe');
  });
  it('says "Deleted user" when the member who asked deleted their account, and hides the row otherwise', () => {
    expect(
      returnRequesterLabel({
        requester_name: null,
        requested_by: null,
        deleted_users: { requested_by: STAMP },
      }),
    ).toBe('Deleted user');
    expect(
      returnRequesterLabel({ requester_name: null, requested_by: null, deleted_users: null }),
    ).toBeNull();
    expect(
      returnRequesterLabel({ requester_name: null, requested_by: 'u1', deleted_users: null }),
    ).toBeNull();
  });
});

describe('platform audit cells', () => {
  it('keeps the actor email and prefixes it when the admin deleted their account', () => {
    expect(platformAuditActorLabel({ actorEmail: 'ops@x.org', actorDeleted: false })).toBe(
      'ops@x.org',
    );
    expect(platformAuditActorLabel({ actorEmail: 'ops@x.org', actorDeleted: true })).toBe(
      'Deleted user · ops@x.org',
    );
  });
  it('shows the target email, else the uuid, else "Deleted user" or "—"', () => {
    expect(
      platformAuditTargetLabel({
        targetUserEmail: 't@x.org',
        targetUserId: 'u1',
        targetDeleted: false,
      }),
    ).toBe('t@x.org');
    expect(
      platformAuditTargetLabel({ targetUserEmail: null, targetUserId: 'u1', targetDeleted: false }),
    ).toBe('u1');
    expect(
      platformAuditTargetLabel({ targetUserEmail: null, targetUserId: null, targetDeleted: true }),
    ).toBe('Deleted user');
    expect(
      platformAuditTargetLabel({ targetUserEmail: null, targetUserId: null, targetDeleted: false }),
    ).toBe('—');
  });
});

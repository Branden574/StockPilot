import { describe, expect, it } from 'vitest';

import { orphanAccountNotices } from './remove-org-notices';

/**
 * Review R8 (2026-10-03): the remove-organization dialog said every account
 * it did not delete "was kept because it is linked to records that must be
 * kept", also when the check could not answer or the delete failed. A
 * transient fault then read as a permanent business refusal, and no retry was
 * suggested. The two outcomes now have their own sentences.
 */
describe('orphanAccountNotices', () => {
  it('says nothing when every orphan account was deleted', () => {
    expect(orphanAccountNotices({ keptUsers: 0, failedUsers: 0 })).toEqual({ kept: null, failed: null });
  });

  it('names accounts kept for linked records, singular and plural', () => {
    expect(orphanAccountNotices({ keptUsers: 1, failedUsers: 0 }).kept).toBe(
      '1 account was kept because it is linked to records that must be kept.',
    );
    expect(orphanAccountNotices({ keptUsers: 3, failedUsers: 0 }).kept).toBe(
      '3 accounts were kept because they are linked to records that must be kept.',
    );
  });

  it('names accounts whose delete could not be completed apart, with what to do', () => {
    const one = orphanAccountNotices({ keptUsers: 0, failedUsers: 1 });
    expect(one.kept).toBeNull();
    expect(one.failed).toBe(
      '1 account could not be deleted right now and was left in place. The error report has the details.',
    );
    expect(orphanAccountNotices({ keptUsers: 2, failedUsers: 2 }).failed).toBe(
      '2 accounts could not be deleted right now and were left in place. The error report has the details.',
    );
  });

  it('never says "linked to records" about a failed delete, and never "book"', () => {
    const n = orphanAccountNotices({ keptUsers: 0, failedUsers: 4 });
    expect(n.failed).not.toMatch(/linked to records/);
    for (const s of [n.kept, n.failed, orphanAccountNotices({ keptUsers: 4, failedUsers: 0 }).kept]) {
      if (s) expect(s.toLowerCase()).not.toMatch(/\bbook\b/);
    }
  });
});

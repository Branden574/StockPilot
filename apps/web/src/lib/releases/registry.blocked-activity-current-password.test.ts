import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  releaseSchema,
  ROLE_PERMISSIONS,
  type ModuleId,
  type ReleaseViewer,
} from '@stockpilot/core';

import { buildReleaseList } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-sign-in-alerts-and-reader (2026-11-22): the What's
 * New for the two rows Blocked activity gained (a wrong current password and
 * a wrong authenticator set-up code), live since the refused sign-ins reader
 * (#634) at 2026-11-22T05:42:55Z. Published below the Liquid Glass draft and the
 * sign-in alerts release (published later) and above the Blocked activity
 * release. Owners and admins only, the page's own rule.
 *
 * Left out, checked against the code: a sign-in refused for another reason and
 * the rows read from the sign-in service's own log have no organization, so no
 * member could see them; the entry must not promise them.
 */
const ID = 'blocked-activity-current-password-and-set-up-code-2026-11';
const BLOCKED_ID = 'blocked-activity-2026-11';
const SIGNIN_ID = 'sign-in-alerts-2026-11';
const PHONE_LARGE_ID = 'phone-large-text-2026-11';
const RECOVERY_ID = 'recovery-code-signs-out-other-devices-2026-11';
const UPLOAD_ID = 'upload-checks-2026-11';
const signInRead = {
  release_id: SIGNIN_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-22T06:01:00Z',
  read_at: '2026-11-22T06:01:00Z',
};
const phoneLargeRead = {
  release_id: PHONE_LARGE_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-23T06:01:00Z',
  read_at: '2026-11-23T06:01:00Z',
};
const recoveryRead = {
  release_id: RECOVERY_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-23T06:31:00Z',
  read_at: '2026-11-23T06:31:00Z',
};
const uploadRead = {
  release_id: UPLOAD_ID,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-28T06:58:00Z',
  read_at: '2026-11-28T06:58:00Z',
};

const release = () => RELEASES.find((r) => r.id === ID)!;
const ALL_MODULES = Object.keys(MODULE_REGISTRY) as ModuleId[];
const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
): ReleaseViewer => ({ role, permissions, enabledModules: ALL_MODULES });
const owner = viewer('owner', [...PERMISSIONS]);
const admin = viewer('admin', ROLE_PERMISSIONS.admin);
const manager = viewer('manager', ROLE_PERMISSIONS.manager);

describe('the Blocked activity current password and set-up code release', () => {
  it('is published once, as revision 1, directly below the sign-in alerts release and above the Blocked activity release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().revision).toBe(1);
    expect(RELEASES[0]?.id).toBe('liquid-glass-2026-11');
    expect(RELEASES[0]?.status).toBe('draft');
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES[1]): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES[2]): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    expect(RELEASES[4]?.id).toBe(SIGNIN_ID);
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES[2]): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES[3]): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    expect(RELEASES[5]?.id).toBe(ID);
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES[2]): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES[3]): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    expect(RELEASES[5]?.status).toBe('published');
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES[3]): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES[4]): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    expect(RELEASES[6]?.id).toBe(BLOCKED_ID);
    expect(releaseSchema.safeParse(release()).success).toBe(true);
  });

  it('is dated on the whole minute the reader went live, and every release below it is older', () => {
    expect(release().publishedAt).toBe('2026-11-22T05:42:00Z');
    // Re-pinned by docs/whats-new-phone-large-text (2026-11-23; was: RELEASES.slice(3)): the phone large text release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-recovery-code (2026-11-23; was: RELEASES.slice(4)): the recovery code release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    for (const r of RELEASES.slice(6)) {
      expect(Date.parse(release().publishedAt), r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('names the page it links to, for owners and admins only', () => {
    expect(release().entries.map((e) => e.id)).toEqual([
      'blocked-activity-wrong-current-password',
      'blocked-activity-wrong-set-up-code',
    ]);
    for (const e of release().entries) {
      expect(e.link?.href).toBe('/dashboard/settings/security/activity');
      expect(e.audience).toEqual({ roles: ['owner', 'admin'] });
    }
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    expect(buildReleaseList(RELEASES, owner, [uploadRead, recoveryRead, phoneLargeRead, signInRead], null).latestUnread?.id).toBe(ID);
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    expect(buildReleaseList(RELEASES, admin, [uploadRead, recoveryRead, phoneLargeRead, signInRead], null).latestUnread?.id).toBe(ID);
    // Re-pinned by docs/whats-new-upload-checks (2026-11-28; was: earlier positions, lists and reads): the upload checks release is published at the top, below the Liquid Glass draft, so every position below it moves down by one and every list of newer releases takes it too.
    expect(buildReleaseList(RELEASES, manager, [uploadRead, recoveryRead, phoneLargeRead, signInRead], null).latestUnread?.id).not.toBe(ID);
  });

  it('promises nothing a member cannot see: no organization-less rows, nothing about how refusals are found', () => {
    const text = JSON.stringify(release()).toLowerCase();
    expect(text).not.toContain('another reason');
    expect(text).not.toContain('sign-in service');
    expect(text).not.toContain('platform console');
  });
});

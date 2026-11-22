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
 * (#634) at 2026-11-22T05:42:55Z. Published at the top, below the Liquid Glass
 * draft and above the Blocked activity release; the draft placeholder takes the
 * same minute. Owners and admins only, the page's own rule.
 *
 * Left out, checked against the code: a sign-in refused for another reason and
 * the rows read from the sign-in service's own log have no organization, so no
 * member could see them; the entry must not promise them.
 */
const ID = 'blocked-activity-current-password-and-set-up-code-2026-11';
const BLOCKED_ID = 'blocked-activity-2026-11';

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
  it('is published once, as revision 1, directly below the Liquid Glass draft and above the Blocked activity release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().revision).toBe(1);
    expect(RELEASES[0]?.id).toBe('liquid-glass-2026-11');
    expect(RELEASES[0]?.status).toBe('draft');
    expect(RELEASES[1]?.id).toBe(ID);
    expect(RELEASES[1]?.status).toBe('published');
    expect(RELEASES[2]?.id).toBe(BLOCKED_ID);
    expect(releaseSchema.safeParse(release()).success).toBe(true);
  });

  it('is dated on the whole minute the reader went live, with the draft placeholder at the same minute and every release below it older', () => {
    expect(release().publishedAt).toBe('2026-11-22T05:42:00Z');
    expect(RELEASES[0]!.publishedAt).toBe(release().publishedAt);
    for (const r of RELEASES.slice(2)) {
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
    expect(buildReleaseList(RELEASES, owner, [], null).latestUnread?.id).toBe(ID);
    expect(buildReleaseList(RELEASES, admin, [], null).latestUnread?.id).toBe(ID);
    expect(buildReleaseList(RELEASES, manager, [], null).latestUnread?.id).not.toBe(ID);
  });

  it('promises nothing a member cannot see: no organization-less rows, nothing about how refusals are found', () => {
    const text = JSON.stringify(release()).toLowerCase();
    expect(text).not.toContain('another reason');
    expect(text).not.toContain('sign-in service');
    expect(text).not.toContain('platform console');
  });
});

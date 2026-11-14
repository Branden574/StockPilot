import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  releaseRegistrySchema,
  type ModuleId,
  type ReleaseViewer,
} from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

import { ANNOUNCEMENTS } from '../onboarding/announcements';

import {
  buildReleaseList,
  legacyAnnouncementsFor,
  registryFingerprint,
  visibleReleases,
} from './logic';
import { RELEASES } from './registry';

/**
 * Added by lg/s5-flag-home (2026-11-09): the Liquid Glass release, held as a
 * DRAFT at the top of the registry (RELEASE.md section 2 item 4) until G5.
 * A draft never leaves the server (docs/releases/PUBLISHING.md step 1): these
 * tests read the real registry and prove that no reader, on the web or on an
 * old phone build, is offered it, and that /api/version's key does not change
 * because of it. The words are checked at G5, when it is published; every
 * RECHECK stays only in comments until then.
 */
const ID = 'liquid-glass-2026-11';
const release = () => RELEASES.find((r) => r.id === ID)!;

const owner: ReleaseViewer = {
  role: 'owner',
  permissions: [...PERMISSIONS],
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
};
const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };

describe('the Liquid Glass release is a draft at the top, and never leaves the server', () => {
  it('is in the registry once, at the top, as a draft at revision 1, and the registry still validates', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(RELEASES[0]?.id).toBe(ID);
    expect(release().status).toBe('draft');
    expect(release().revision).toBe(1);
    expect(releaseRegistrySchema.safeParse(RELEASES).success).toBe(true);
  });

  it('is offered to no reader: not in any list, notice or old phone announcement', () => {
    for (const viewer of [owner, member]) {
      expect(visibleReleases(RELEASES, viewer).map((r) => r.id)).not.toContain(ID);
      const list = buildReleaseList(RELEASES, viewer, [], null);
      expect(list.releases.map((r) => r.id)).not.toContain(ID);
      expect(list.latestUnread?.id).not.toBe(ID);
      expect(legacyAnnouncementsFor(RELEASES, viewer, {}).map((a) => a.id)).not.toContain(ID);
    }
    expect(ANNOUNCEMENTS.map((a) => a.id)).not.toContain(ID);
  });

  it('does not change the key /api/version serves', () => {
    expect(registryFingerprint(RELEASES)).toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== ID)),
    );
    expect(registryFingerprint(RELEASES)).not.toContain(ID);
  });

  it('keeps every RECHECK as a code comment only, never in the words a reader would see', () => {
    expect(JSON.stringify(release())).not.toMatch(/RECHECK/);
    const text = readFileSync(resolve(__dirname, 'registry.ts'), 'utf8');
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: every pinned position two places higher): the phone authenticator code and access check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: every pinned position one place higher): the phone screens by access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    const block = text.slice(0, text.indexOf(`id: '${RELEASES[8]!.id}'`));
    const lines = block.split('\n').filter((l) => l.includes('RECHECK'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.trim().startsWith('//'), line).toBe(true);
  });
});

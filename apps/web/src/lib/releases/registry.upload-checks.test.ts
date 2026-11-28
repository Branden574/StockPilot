import { describe, expect, it } from 'vitest';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-upload-checks (2026-11-28): the upload checks release
 * is published at the top, directly below the Liquid Glass draft. Its first
 * entry has no audience and no link, so every member sees it, on the website
 * and in the phone app. Its second entry is for owners and admins.
 */
const ID = 'upload-checks-2026-11';
const release = () => RELEASES.find((r) => r.id === ID)!;

describe('the upload checks release', () => {
  it('is published once, at revision 1, directly below the Liquid Glass draft', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(RELEASES[0]?.id).toBe('liquid-glass-2026-11');
    expect(RELEASES[1]?.id).toBe(ID);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
  });

  it('tells every member about the checks and owners and admins about the new row', () => {
    const [checks, row] = release().entries;
    expect(checks!.audience).toBeUndefined();
    expect(checks!.link).toBeUndefined();
    expect(row!.audience).toEqual({ roles: ['owner', 'admin'] });
    expect(row!.link?.href).toBe('/dashboard/settings/security/activity');
  });

  it('says what the checks are and are not, and names no check, kind or limit', () => {
    const text = JSON.stringify(release()).toLowerCase();
    expect(text).toContain('not an antivirus');
    expect(text).toContain('refused file');
    for (const word of ['malware', 'virus scan', 'megabyte', ' mb', 'magic', 'signature check']) {
      expect(text, word).not.toContain(word);
    }
  });
});

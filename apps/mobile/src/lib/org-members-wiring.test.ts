import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS: the three member lists read through loadOrgMembers (which
 * throws on a failed read, tested in org-members.test.ts) and show a failed
 * load as a failure. The screens import native modules, so vitest cannot
 * render them.
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');
const users = read('../../app/(drawer)/admin/users.tsx');
const team = read('../../app/(drawer)/team.tsx');
const sheet = read('../components/cycle-count-reassign-sheet.tsx');

/** The body of a screen's `load` callback. */
function loadBody(src: string): string {
  const start = src.indexOf('const load = React.useCallback(');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('React.useEffect(', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/**
 * The words a list shows in place of its rows when the load failed, in
 * either spelling: DataListScreen's `failed` prop (its failed state, shown
 * over the empty state: the redesign's D25 hand-off, which team.tsx took in
 * P5.10), or the empty state's words swapped on the flag (users.tsx). Null
 * when neither is there, so the empty list's words would stand for a failed
 * read.
 */
function failureWords(src: string): { title: string; body: string } | null {
  const viaFailed =
    /failed=\{\s*loadFailed\s*\?\s*\{\s*title:\s*'([^']*)',\s*body:\s*'([^']*)',?\s*\}\s*:\s*null,?\s*\}/.exec(
      src,
    );
  if (viaFailed) return { title: viaFailed[1]!, body: viaFailed[2]! };
  const title = /emptyTitle=\{loadFailed \? '([^']*)' : /.exec(src);
  const body = /emptyBody=\{\s*loadFailed\s*\?\s*'([^']*)'/.exec(src);
  return title && body ? { title: title[1]!, body: body[1]! } : null;
}

describe.each([
  ['users', users, 'Could not load users.', "'ADMIN · USERS'"],
  ['team', team, 'Could not load the team.', "'TEAM'"],
])('%s screen', (_name, src, failedTitle, neutralEyebrow) => {
  it('reads members and profiles through loadOrgMembers, never an unbatched in()', () => {
    const body = loadBody(src);
    expect(body).toContain('await loadOrgMembers<');
    expect(body).toContain('joinMemberProfiles(members, profiles)');
    expect(src).not.toContain(".from('user_profiles')");
    expect(src).not.toMatch(/\.in\('id', userIds\)/);
  });

  it('a failed load empties the list and sets the flag; a good one clears it', () => {
    const body = loadBody(src);
    expect(body).toMatch(/setLoadFailed\(false\);\s*\} catch \(e\) \{[\s\S]*?setRows\(\[\]\);\s*setLoadFailed\(true\);/);
  });

  // Mutation caught: a failed load shown with the empty list's words, or the
  // failure's words changed (either spelling, see failureWords).
  it('shows the failure, not an empty team, and quotes no member count', () => {
    expect(failureWords(src)).toEqual({
      title: failedTitle,
      body: 'Check your connection and pull down to try again.',
    });
    expect(src).toMatch(new RegExp(`loadFailed\\s*\\? ${neutralEyebrow.replace(/[·]/g, '.')}`));
  });
});

describe('cycle-count reassign sheet', () => {
  it('loads through the throwing loader, so its catch finally fires', () => {
    expect(sheet).toContain('await loadOrgMembers<');
    expect(sheet).toContain("{ acceptedOnly: true, profileColumns: 'id, full_name, email' }");
    expect(sheet).toContain('buildReassignCandidates(rows, profiles)');
    expect(sheet).not.toContain(".from('user_profiles')");
    expect(sheet).toMatch(/\} catch \(e\) \{[\s\S]*?setMembers\(\[\]\);\s*setMembersFailed\(true\);/);
  });

  it('a failed load shows the error and a Try again instead of "No other team members"', () => {
    const failedBranch = sheet.indexOf(') : membersFailed ? (');
    expect(failedBranch).toBeGreaterThan(-1);
    expect(failedBranch).toBeLessThan(sheet.lastIndexOf('No other team members to assign.'));
    expect(sheet.slice(failedBranch)).toMatch(/Could not load team members\.[\s\S]*?onPress=\{retryMembers\}/);
  });

  it('Try again re-runs the load, clears the flag, and cannot stack reloads', () => {
    expect(sheet).toContain('}, [visible, orgId, reloadNonce]);');
    expect(sheet).toMatch(
      /function retryMembers\(\) \{\s*if \(loading\) return;\s*setMembersFailed\(false\);\s*setLoading\(true\);\s*setReloadNonce\(\(n\) => n \+ 1\);/,
    );
  });
});

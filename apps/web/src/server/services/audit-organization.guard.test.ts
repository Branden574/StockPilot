import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Docket S74 (web). The profile's default organization is a preference the
 * person sets on their own row; it is not proof of membership. Code that
 * files an audit row, sends a message or names "the person's organization"
 * takes the organization from a membership-checked answer instead:
 * resolveDefaultOrgAndRole (server/services/auth-audit.ts) for a row written
 * outside an organization context, or the organization withContext() /
 * withApiContext() resolved for an action or a route.
 *
 *   1. email-change.ts never reads the default organization itself, and its
 *      one audit writer resolves the organization through
 *      resolveDefaultOrgAndRole (it takes no organization from its callers);
 *   2. every other source file under src that names the column, or the
 *      session's copy of it, is listed in READS_DEFAULT with what it does
 *      with it, and every listed file still names it.
 *
 * What it does NOT catch (a reviewer still reads for these):
 *   - a new reader inside a file already on the list: the list is per file,
 *     so a second use in, say, session.ts passes unseen;
 *   - a read that never names the column, such as `select('*')` on
 *     user_profiles, or a row handed on from such a read;
 *   - SQL, database functions and triggers, and anything outside
 *     apps/web/src (the phone app, edge functions, migrations).
 */

const WEB_SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(WEB_SRC, rel), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const NAMES = /\bdefault_organization_id\b|\bdefaultOrganizationId\b/;

/** Reviewed 2026-11-13 (docket S74). Path under src -> what it does with the default. */
const READS_DEFAULT: Record<string, string> = {
  'lib/auth/session.ts':
    'Loads the profile; the organization is the accepted membership matching the default, else another accepted membership (memberRows are accepted only).',
  'lib/auth/api-context.ts':
    'pickActiveMembership and the bundle path use the default only when an accepted membership matches it.',
  'lib/auth/request-context-bundle.ts': 'Carries the profile column into the bundle; api-context checks it against memberships.',
  'server/services/auth-audit.ts':
    'resolveDefaultOrgAndRole, counting only memberships with no end time: the default only when it is an accepted membership, else the oldest accepted membership, else none.',
  'server/services/team.ts':
    'Writes only: clears the default of a removed member, and sets it on invite acceptance when it is empty.',
  'server/services/platform/impersonation.ts':
    'Saves the value to restore after impersonation and writes the target; never attributes anything to it.',
  'server/actions/org-switcher.ts': 'Writes the default after checking the accepted membership.',
  'server/actions/organization.ts': 'Writes the default to the organization the caller just created.',
  'server/actions/platform-admin.ts': 'Writes the default for a platform admin entering a workspace.',
  'server/services/maintenance-requests.ts': 'A comment naming the user_profiles columns.',
  'test/step-up-session-fixture.ts': 'A test fixture.',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (name === 'node_modules') continue;
      out.push(...sourceFiles(abs));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(path.relative(WEB_SRC, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

describe('the default organization is never taken as a membership', () => {
  it('email-change.ts never reads the default organization', () => {
    expect(read('server/services/email-change.ts')).not.toMatch(NAMES);
  });

  it("email-change.ts's audit writer resolves the organization through resolveDefaultOrgAndRole", () => {
    const src = code(read('server/services/email-change.ts'));
    expect(src).toMatch(/import \{[^}]*\bresolveDefaultOrgAndRole\b[^}]*\} from '@\/server\/services\/auth-audit';/);
    const writer = src.match(/async function writeAudit\(([^)]*)\)[^{]*\{([\s\S]*?)\n\}/);
    expect(writer, 'writeAudit is defined').not.toBeNull();
    const [, params, body] = writer!;
    // It takes no organization from its callers.
    expect(params).not.toMatch(/organization/i);
    expect(body).toMatch(/await resolveDefaultOrgAndRole\(userId\)/);
    // It is the only place in the file that writes an audit row.
    expect(src.match(/insertAuditRowReported\(/g)).toHaveLength(1);
    expect(body).toMatch(/insertAuditRowReported\(/);
  });

  it('every other source file that names the default organization is reviewed, and every entry is current', () => {
    const naming = sourceFiles(WEB_SRC).filter((rel) => NAMES.test(read(rel)));
    const unlisted = naming.filter((rel) => !(rel in READS_DEFAULT));
    expect(unlisted, 'files that name the default organization without a review entry').toEqual([]);
    const stale = Object.keys(READS_DEFAULT).filter((rel) => !naming.includes(rel));
    expect(stale, 'review entries for files that no longer name it').toEqual([]);
  });
});

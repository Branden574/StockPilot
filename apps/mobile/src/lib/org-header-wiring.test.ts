import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS: every raw `fetch` / `postMultipart` under app/ that sends a
 * Bearer token must also send the active-workspace header (SP-017).
 *
 * THE BUG: `api()` scopes every request with X-Organization-Id, but six call
 * sites (AI-scan upload / per-line record / confirm, PO scan, AI chat, ISBN
 * extraction) built their own headers with only Authorization. The server's
 * withApiContext then fell back to the user's DEFAULT org, so a multi-org
 * user working in workspace B had their counts, PO scans and chat questions
 * resolved against workspace A. This is a CLASS guard (recurring pattern #26
 * — fix every sibling, not the instance): any future raw call site that
 * forgets the header fails here.
 *
 * AND THE ACCOUNT (docket B10, from the security review of the first fix).
 * orgHeader names only the given account's own saved workspace, so each site
 * passes the account of the SAME session whose token it sends:
 * `Bearer ${s.access_token}` beside `orgHeader(s.user.id)`. A bare
 * orgHeader() read the stored session on its own: unreadable, it named no
 * workspace and the request landed in the default organization; holding
 * another account, it named that account's workspace beside this token.
 * api.org-header.test.ts runs each site's headers.
 */

const APP_DIR = path.resolve(__dirname, '../../app');

const SRC_DIR = path.resolve(__dirname, '..');

/** Source with comments removed: a comment naming orgHeader() is not a call. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

function appSourceFiles(dir: string = APP_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...appSourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('raw Bearer call sites carry X-Organization-Id (SP-017)', () => {
  const sites: { file: string; line: number; window: string }[] = [];
  for (const file of appSourceFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (/Authorization:.*Bearer \$\{/.test(text)) {
        // The enclosing headers object: a few lines either side is enough for
        // every shape in the tree (inline object or multi-line spread).
        sites.push({ file: path.relative(APP_DIR, file), line: i + 1, window: lines.slice(Math.max(0, i - 4), i + 5).join('\n') });
      }
    });
  }

  it('finds the raw call sites (vacuity control — the sweep must have something to judge)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(6);
  });

  // Re-pinned by docket B10 (was `...(await orgHeader())`): the header is
  // spread from orgHeader called with the account of the session whose
  // access token the same line sends. A site that sends a bare token variable
  // fails too: the token and the account must come from one session.
  it.each(sites.map((s) => [`${s.file}:${s.line}`, s] as const))(
    '%s spreads orgHeader(<its session>.user.id) into the same headers object',
    (_label, s) => {
      const bearer = /Bearer \$\{(\w+)\.access_token\}/.exec(s.window);
      expect(bearer, `${s.file}:${s.line} must send a session's own access_token`).not.toBeNull();
      const session = bearer![1]!;
      const withAccount = new RegExp(
        `\\.\\.\\.\\(await orgHeader\\(${session}\\??\\.user\\.id(?: \\?\\? null)?\\)\\)`,
      );
      expect(
        s.window,
        `${s.file}:${s.line} must name the workspace for ${session}'s account`,
      ).toMatch(withAccount);
    },
  );

  it('no source calls orgHeader() without the account', () => {
    const files = [...appSourceFiles(), ...appSourceFiles(SRC_DIR)].filter(
      (f) => !/\.test\.tsx?$/.test(f),
    );
    // Vacuity control: the sweep reaches api.ts and the raw sites.
    expect(files.some((f) => f.endsWith(path.join('lib', 'api.ts')))).toBe(true);
    const bare = files.filter((f) => /\borgHeader\(\s*\)/.test(code(readFileSync(f, 'utf8'))));
    expect(bare.map((f) => path.relative(path.resolve(__dirname, '../..'), f))).toEqual([]);
  });

  it('the activity beacon names the workspace for the account it reports', () => {
    const beacon = code(readFileSync(path.join(__dirname, 'activity-beacon.ts'), 'utf8'));
    expect(beacon).toContain("(await orgHeader(userId))['X-Organization-Id']");
  });

  it('api.ts exports orgHeader and uses it itself', () => {
    const api = readFileSync(path.join(__dirname, 'api.ts'), 'utf8');
    // Re-pinned by docket B10 (was `orgHeader()` with no argument): the saved
    // workspace is named only for the account the request goes out as
    // (api.org-header.test.ts runs it). The account is REQUIRED, and
    // orgHeader never reads a session itself: the caller's session is the one
    // whose token goes out.
    expect(api).toMatch(/export async function orgHeader\(userId: string \| null\)/);
    expect(code(api)).not.toContain('readDeviceAuthSession');
    // The saved workspace, unless the caller names the request's own
    // (the outbox sends each queued row under the org it was queued in),
    // checked against the account whose bearer the same session read gave.
    expect(api).toMatch(/const auth = await authHeader\(opts\.asUserId\);/);
    expect(api).toMatch(/\.\.\.\(opts\.orgId \? \{ 'X-Organization-Id': opts\.orgId \} : await orgHeader\(auth\.userId\)\)/);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Security invariant: the auth audit helpers are server code, never Server
 * Actions (S29's move, made by S5: plans/S29-S32.md "Moving the audit
 * helpers", G1).
 *
 * emitAuthAudit writes an audit_logs row with the service role for whatever
 * event, user and organization it is handed. Exported from a 'use server'
 * module it would be a Server Action: an endpoint anyone could call to write
 * Audit log rows in any organization's name. They lived inside
 * server/actions/auth.ts (not exported). S5's phone routes need them too, so
 * they moved, verbatim, to server/services/auth-audit.ts, which is
 * `import 'server-only'` and never 'use server'.
 */

const WEB_SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(WEB_SRC, rel), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const HELPERS = ['emitAuthAudit', 'resolveDefaultOrgAndRole'];

describe('the auth audit helpers stay out of Server Actions', () => {
  it('auth-audit.ts starts with server-only and is never a server module', () => {
    const src = read('server/services/auth-audit.ts');
    expect(src.trimStart().startsWith("import 'server-only';")).toBe(true);
    expect(code(src)).not.toMatch(/['"]use server['"]/);
    for (const name of HELPERS) expect(src).toMatch(new RegExp(`export async function ${name}\\(`));
  });

  it('no server module under server/actions defines or exports them; auth.ts imports them', () => {
    const dir = path.join(WEB_SRC, 'server/actions');
    for (const file of readdirSync(dir).filter(
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
    )) {
      const src = code(read(`server/actions/${file}`));
      if (!/^\s*['"]use server['"]/.test(src)) continue;
      for (const name of HELPERS) {
        expect(src, `${file} ${name}`).not.toMatch(new RegExp(`function ${name}\\b`));
        expect(src, `${file} ${name}`).not.toMatch(new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`));
      }
    }
    expect(read('server/actions/auth.ts')).toMatch(
      /import \{ emitAuthAudit, resolveDefaultOrgAndRole \} from '@\/server\/services\/auth-audit';/,
    );
  });
});

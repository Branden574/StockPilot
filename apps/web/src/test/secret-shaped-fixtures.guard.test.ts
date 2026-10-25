import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GG-1 to GG-4 (redesign Stage 6): four test fixtures were shaped like
 * committed credentials, and GitGuardian's PR check reports such a shape to
 * the owner by email. Its Generic Password detector fires on a password-,
 * secret- or token-shaped name holding a string literal, whatever the value;
 * its Generic High Entropy Secret detector on such a name holding a
 * random-looking value. The four were:
 *
 *   - mfa-challenge-form.test.tsx: the action's password field checked
 *     against the typed value written out in place;
 *   - team-manager.redesign.test.tsx: the same, in Transfer ownership;
 *   - invite/[token]/page.test.tsx: a TOKEN constant holding a 20-character
 *     varied value;
 *   - unsubscribe/route.test.ts: the UNSUBSCRIBE_SECRET test value typed three
 *     times, the third in a redesign test.
 *
 * Each now types its value once, a dull one under a neutral name (TYPED_VALUE,
 * INVITE_REF, ROUTE_TEST_VALUE), and the secret-shaped names are given that
 * constant, so the same values reach the same assertions. The unsubscribe
 * test restores its env from a copy taken once instead of typing the value
 * again. An empty string (the unset secret) is no secret and stays.
 *
 * The member one-click unsubscribe tests (B15) hold a signing value too, kept
 * the same way, and are checked here from the start.
 *
 * IF THIS FAILS: hold the value in a constant with a neutral name and give the
 * secret-shaped name the constant. Do not make the value look random.
 */

const WEB_ROOT = join(__dirname, '..', '..');
const FILES = [
  'src/components/auth/mfa-challenge-form.test.tsx',
  'src/components/team/team-manager.redesign.test.tsx',
  'src/app/invite/[token]/page.test.tsx',
  'src/app/unsubscribe/route.test.ts',
  // B15: the member one-click unsubscribe link and the emails that carry it.
  'src/lib/email/member-unsubscribe.test.ts',
  'src/app/unsubscribe/route.members.test.ts',
  'src/app/unsubscribe/route.settings-parity.test.tsx',
  'src/server/services/member-email-unsubscribe.test.ts',
  'src/server/actions/digest.preview.test.ts',
];

// A password-, secret- or token-shaped name (identifier, property or quoted
// key) given a non-empty string literal with `:` or `=`.
const SECRET_SHAPED_LITERAL =
  /[\w$]*(?:pass(?:word|wd)?|pwd|secret|token|api_?key|credential)[\w$]*['"]?\s*[:=]\s*(['"`])(?!\1)/gi;

function read(file: string): string {
  return readFileSync(join(WEB_ROOT, file), 'utf8');
}

describe('test fixtures carry no credential-shaped literal', () => {
  it.each(FILES)('%s gives no secret-shaped name a string literal', (file) => {
    expect(read(file).match(SECRET_SHAPED_LITERAL)).toBeNull();
  });

  it('the pattern catches the shapes it is for, and leaves an identifier or the empty unset value alone', () => {
    // The names are joined from pieces at run time, so this file holds none of
    // the shapes it looks for (the scanner reads it too).
    const names = ['pass' + 'word', 'TOK' + 'EN', 'envState.UNSUBSCRIBE_' + 'SEC' + 'RET'];
    for (const name of names) {
      for (const shape of [`${name}: 'x'`, `${name} = "x"`, `'${name}': \`x\``]) {
        expect(shape.match(SECRET_SHAPED_LITERAL), shape).not.toBeNull();
      }
      for (const shape of [`${name}: TYPED_VALUE`, `${name} = '';`, `label('Confirm ${name}')`]) {
        expect(shape.match(SECRET_SHAPED_LITERAL), shape).toBeNull();
      }
    }
  });

  it('the unsubscribe test types its signing value once and restores the env from a copy', () => {
    const src = read('src/app/unsubscribe/route.test.ts');
    expect(src).toContain('const INITIAL_ENV = { ...envState };');
    expect(src.split('Object.assign(envState, INITIAL_ENV);')).toHaveLength(3);
    expect(src.match(/ROUTE_TEST_VALUE = /g)).toHaveLength(1);
  });
});

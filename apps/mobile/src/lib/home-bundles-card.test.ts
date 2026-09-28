import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { HOME_BUNDLES_SUBTITLE } from './cta-gating';

/**
 * The Home screen's Bundles card (simulator walk 2026-09-27): its subtitle
 * read "Distribute kits & assembled stock" to every role, but staff cannot
 * distribute (showDistributeCta: manager or above, the database's rule since
 * 0101), so the card offered staff an action the bundle screen withholds.
 * The subtitle is now role-neutral: it names what the bundle list holds, and
 * no action.
 */

const home = readFileSync(path.resolve(__dirname, '../../app/(drawer)/(tabs)/index.tsx'), 'utf8');

/** Source with comments stripped. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('Home: the Bundles card', () => {
  it('names no action that depends on the role', () => {
    expect(HOME_BUNDLES_SUBTITLE).not.toMatch(/distribut|assemble |create|manage|edit/i);
    expect(HOME_BUNDLES_SUBTITLE.trim()).not.toBe('');
  });

  // Mutation caught: the old literal (or any Distribute wording) back on Home.
  it('the card shows the role-neutral subtitle, and Home says "Distribute" nowhere', () => {
    const code = codeOnly(home);
    const card = code.slice(code.indexOf('<Eyebrow>BUNDLES</Eyebrow>'));
    expect(card).toMatch(/title="Bundles"\s+subtitle=\{HOME_BUNDLES_SUBTITLE\}/);
    expect(code).not.toMatch(/Distribute/);
    expect(code).toContain("import { HOME_BUNDLES_SUBTITLE } from '@/lib/cta-gating';");
  });
});

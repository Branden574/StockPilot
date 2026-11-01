// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * The export dialog's preview effect is written so the React hooks rules pass
 * as they stand. It used to break two of them four times (a setState straight
 * in the effect body, `filters` and `selectedIds` missing from the dependency
 * list, and two JSON.stringify calls inside it) and hide all four behind
 * eslint-disable comments, which also hid any real dependency mistake made
 * there later.
 */
const WEB = path.resolve(__dirname, '..', '..', '..', '..');
const FILE = path.join(WEB, 'src/components/inventory/export-builder/export-builder-dialog.tsx');

describe('export-builder-dialog.tsx and the React hooks rules', () => {
  it('suppresses no react-hooks rule', () => {
    const source = readFileSync(FILE, 'utf8');
    expect(source).not.toMatch(/eslint-disable[^\n]*react-hooks\//);
  });

  it('passes the react-hooks rules with no warning', async () => {
    const eslint = new ESLint({ cwd: WEB });
    const [result] = await eslint.lintFiles([FILE]);
    const hooks = (result?.messages ?? [])
      .filter((m) => (m.ruleId ?? '').startsWith('react-hooks/'))
      .map((m) => `${m.line}:${m.column} ${m.ruleId} ${m.message}`);
    expect(hooks).toEqual([]);
  }, 60_000);
});

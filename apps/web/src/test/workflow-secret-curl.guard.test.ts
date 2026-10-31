import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Security invariant (docket S16 review): a workflow that calls one of our
 * routes with a secret never prints the answer.
 *
 * The repository is public, and so are its Actions logs. The deploy hook
 * (prewarm-on-deploy.yml) called the prewarm route with BACKFILL_ADMIN_SECRET
 * after every production deploy, and curl printed the 200's body into the
 * run's log: every warmed organization's id and its warehouses' ids, their
 * item, book and charter counts and timings, and the text of any read that
 * failed (the loaders keep a failure's own text in those results). GitHub
 * masks the secret in a log, never the answer. The step decides by curl's
 * exit status alone, so the body is discarded and only the status printed.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

/** Each curl command in a workflow, one per line (continuation lines joined), comments left out. */
function curlCommands(text: string): string[] {
  return text
    .replace(/\\\r?\n\s*/g, ' ')
    .split('\n')
    .filter((line) => /\bcurl\b/.test(line) && !/^\s*#/.test(line));
}

/** Sends a secret: an Authorization header, or a `secrets.` expression. */
function sendsSecret(command: string): boolean {
  return /\bAuthorization\s*:/i.test(command) || /\$\{\{\s*secrets\./.test(command);
}

/** Writes the answer's body nowhere the log shows it. */
function discardsBody(command: string): boolean {
  return /\s(?:-o|--output)\s+\/dev\/null(?:\s|$)/.test(command);
}

function workflows(): Array<{ file: string; text: string }> {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({ file: name, text: readFileSync(join(WORKFLOWS_DIR, name), 'utf8') }));
}

describe('workflows never print the answer of a call that sends a secret', () => {
  it('every curl that sends a secret discards the body', () => {
    const printed = workflows().flatMap(({ file, text }) =>
      curlCommands(text)
        .filter((command) => sendsSecret(command) && !discardsBody(command))
        .map((command) => `${file}: ${command.trim()}`),
    );
    expect(printed).toEqual([]);
  });

  it('the census sees the deploy hook (control: it does not pass on nothing)', () => {
    const hook = workflows().find(({ file }) => file === 'prewarm-on-deploy.yml');
    expect(hook).toBeDefined();
    expect(curlCommands(hook!.text).filter(sendsSecret)).toHaveLength(1);
  });

  it('control: a command that prints the body counts, one that discards it does not', () => {
    const sample = [
      '          # we curl the route with a secret: a comment, not a command',
      '          if curl -fsS --max-time 90 \\',
      '            -H "Authorization: Bearer ${SECRET}" \\',
      '            "${URL}"; then',
      '          curl -fsS -o /dev/null -w "HTTP %{http_code}\\n" -H "Authorization: Bearer ${SECRET}" "${URL}"',
      '          curl -sSfL -o tool.tar.gz "https://example.com/tool.tar.gz"',
      '          curl --output /dev/null -H "Authorization: Bearer ${{ secrets.TOKEN }}" "${URL}"',
      '          curl -H "X-Key: ${{ secrets.TOKEN }}" "${URL}"',
    ].join('\n');
    const commands = curlCommands(sample);
    expect(commands).toHaveLength(5);
    expect(commands.map((c) => sendsSecret(c) && !discardsBody(c))).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
  });
});

// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WHO MAY IMPORT THE READ OF "WHAT WAS ASKED FOR", AND WHO MAY CALL ITS ACTION.
 *
 * Security invariant. readPlatformSecurityEventSamples reads the paths and
 * query strings that scanners sent, across every organization and none, with
 * the service client, and has no gate of its own (like its sibling platform
 * services). So the files that import it are the doors to that data, and
 * each is pinned here with its gate:
 *   - the panel's Server Action, which asks checkPlatformConsoleRead() (the
 *     console's own rule) before it reads its input or the table, and is
 *     called only by the panel's "What was asked for" section.
 * A new importer (a route, a cron, a page or another action) must be judged
 * before it is added here.
 */

const SRC = join(__dirname, '..', '..', '..');

const importOf = (alias: string, name: string) =>
  new RegExp(
    `['"](?:${alias.replace(/[/@-]/g, (c) => `\\${c}`)}|(?:\\.{1,2}\\/)+(?:[\\w()[\\]-]+\\/)*${name})['"]`,
  );

const SERVICE_ALIAS = '@/server/services/platform/security-event-samples';
const ACTION_ALIAS = '@/server/actions/platform/security-event-samples';

const SERVICE_FILE = 'server/services/platform/security-event-samples.ts';
const ACTION_FILE = 'server/actions/platform/security-event-samples.ts';
const SECTION_FILE = 'components/platform/security-response/security-response-samples.tsx';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function importers(pattern: RegExp, alias: string, folder: string, self: string): string[] {
  return sourceFiles(SRC)
    .filter((path) => {
      const text = readFileSync(path, 'utf8');
      if (!pattern.test(text)) return false;
      if (text.includes(alias)) return true;
      // A relative import of that name counts only from inside its folder.
      return path.startsWith(join(SRC, folder) + sep);
    })
    .map((path) => relative(SRC, path).split(sep).join('/'))
    .filter((path) => path !== self)
    .sort();
}

const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

describe('the read of what was asked for', () => {
  it('is imported by the panel action alone', () => {
    expect(
      importers(
        importOf(SERVICE_ALIAS, 'security-event-samples'),
        SERVICE_ALIAS,
        join('server', 'services', 'platform'),
        SERVICE_FILE,
      ),
    ).toEqual([ACTION_FILE]);
  });

  it('the action is called by the panel section alone', () => {
    expect(
      importers(
        importOf(ACTION_ALIAS, 'security-event-samples'),
        ACTION_ALIAS,
        join('server', 'actions', 'platform'),
        ACTION_FILE,
      ),
    ).toEqual([SECTION_FILE]);
  });

  it('the service starts with server-only', () => {
    expect(read(SERVICE_FILE).startsWith("import 'server-only';")).toBe(true);
  });

  it("the action asks the console's own rule first: before its input is read and before the table is", () => {
    const action = read(ACTION_FILE);
    expect(action.startsWith("'use server';")).toBe(true);
    const body = action.slice(
      action.indexOf('export async function readSecurityEventSamplesAction'),
    );
    const gate = body.indexOf('await checkPlatformConsoleRead()');
    expect(gate).toBeGreaterThan(-1);
    expect(body.indexOf('.safeParse(')).toBeGreaterThan(gate);
    expect(body.indexOf('readPlatformSecurityEventSamples(')).toBeGreaterThan(gate);
    // Not the weaker action check, which serves an allowlisted account with
    // no authenticator (its comment may name it; its code may not call it).
    const code = action.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/checkPlatformAdmin\s*\(/);
    expect(code).toMatch(/checkPlatformConsoleRead\s*\(/);
    // One export: nothing else on this door.
    expect(code.match(/export /g)).toHaveLength(1);
  });

  it('the section calls the action from an effect, not with the page', () => {
    const section = read(SECTION_FILE);
    expect(section.startsWith("'use client';")).toBe(true);
    expect(section.split('readSecurityEventSamplesAction(').length - 1).toBe(1);
    expect(section).not.toMatch(/setInterval|setTimeout/);
  });
});

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
 */

const APP_DIR = path.resolve(__dirname, '../../app');

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

  it.each(sites.map((s) => [`${s.file}:${s.line}`, s] as const))('%s spreads orgHeader() into the same headers object', (_label, s) => {
    expect(s.window, `${s.file}:${s.line} sends Authorization without the org header`).toMatch(/\.\.\.\(await orgHeader\(\)\)/);
  });

  it('api.ts exports orgHeader and uses it itself', () => {
    const api = readFileSync(path.join(__dirname, 'api.ts'), 'utf8');
    expect(api).toMatch(/export async function orgHeader\(\)/);
    expect(api).toMatch(/\.\.\.\(await orgHeader\(\)\)/);
  });
});

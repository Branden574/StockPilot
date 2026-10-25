import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fakeBroadcastChannels,
  interruptedRunKeys,
  seedInterruptedRuns,
  UNRELATED_KEY,
} from '@/test/interrupted-run-fixtures';

import GlobalError from './global-error';

/**
 * The last-resort error page's "Sign out and back in" is a sign-out on
 * purpose: its click removes what an interrupted run kept in this tab
 * (lib/interrupted-run), then loads the sign-out route in this tab.
 *
 * The page renders when the root layout itself failed, so it must not depend
 * on anything that could be what broke: besides React it imports only modules
 * that import nothing themselves. The second case holds it to that.
 */

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('global-error: Sign out and back in', () => {
  it('removes every interrupted-run record in this tab as it is clicked', () => {
    // The page's crash beacon posts to /api/client-error as it mounts; nothing
    // here may leave the test.
    const beacon = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', beacon);
    // The page owns <html> and <body>; rendered inside the test's container,
    // React warns about the nesting. That is the test's arrangement, not the page's.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sessionStorage.clear();
    seedInterruptedRuns();
    const keysAtLoad: string[][] = [];
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {
      keysAtLoad.push(interruptedRunKeys());
    });
    render(
      <GlobalError error={Object.assign(new Error('x'), { digest: 'd-1' })} reset={() => {}} />,
    );
    expect(screen.queryByRole('link', { name: 'Sign out and back in' })).toBeNull();
    expect(interruptedRunKeys()).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out and back in' }));

    // The records went first, then this tab loaded the sign-out route.
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/auth/session-ended');
    expect(keysAtLoad).toEqual([[]]);
    expect(sessionStorage.getItem(UNRELATED_KEY)).toBe('kept');
  });

  it('tells the other tabs of this browser before the sign-out route loads: the route signs them out too', () => {
    // Review of round 2's repair: the route ends the session in every tab (the
    // session cookies are the browser's) and sends no revoke, so another tab
    // kept its records, and a run going there kept recording.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tabs = fakeBroadcastChannels();
    const otherTab = tabs.otherTab();
    const sentAtLoad: unknown[][] = [];
    vi.spyOn(window.location, 'assign').mockImplementation(() => {
      sentAtLoad.push(tabs.sent());
    });
    render(<GlobalError error={new Error('x')} reset={() => {}} />);
    expect(tabs.sent()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out and back in' }));

    expect(sentAtLoad).toEqual([[{ type: 'purge' }]]);
    tabs.deliver();
    expect(otherTab.received).toEqual([{ type: 'purge' }]);
  });

  it('while it shows, a sign-out in another tab of this browser removes what this tab kept', () => {
    // The page replaces the root layout, whose InterruptedRunExpiry listens on
    // every other page, so it listens itself.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tabs = fakeBroadcastChannels();
    sessionStorage.clear();
    seedInterruptedRuns();
    render(<GlobalError error={new Error('x')} reset={() => {}} />);

    tabs.otherTab().postMessage({ type: 'purge' });
    tabs.deliver();

    expect(interruptedRunKeys()).toEqual([]);
    expect(sessionStorage.getItem(UNRELATED_KEY)).toBe('kept');
  });

  it('imports, besides React, only modules that import nothing themselves', () => {
    const src = path.resolve(__dirname, '..');
    const importsOf = (file: string): string[] => {
      const sf = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      return sf.statements
        .filter(ts.isImportDeclaration)
        .map((d) => (d.moduleSpecifier as ts.StringLiteral).text);
    };

    const imported = importsOf(path.join(__dirname, 'global-error.tsx'));
    expect(imported).toEqual(['react', '@/lib/interrupted-run', '@/lib/share-paths']);
    for (const spec of imported.filter((s) => s.startsWith('@/'))) {
      const file = path.join(src, `${spec.slice(2)}.ts`);
      expect({ module: spec, imports: importsOf(file) }).toEqual({ module: spec, imports: [] });
    }
  });
});

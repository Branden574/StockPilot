import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COUNT_IN_OTHER_WORKSPACE_COPY,
  COUNT_NOT_AVAILABLE_COPY,
  missingCountCopy,
  whyCountIsMissing,
  type MissingCountClient,
} from './cycle-count-missing';

/**
 * "This count has no lines yet" is said only of a count that was read and has
 * none (B25, the F1-3 follow-up). The count screen read the count in the
 * workspace on screen; a read that found no row and no error rendered the
 * ordinary screen with nothing in it, so a link to a count in another of the
 * person's workspaces, or to one they cannot see or that does not exist, said
 * the count had no lines and to add them from the web.
 */

const ORG_A = 'org-a';
const ORG_B = 'org-b';

/** The count as row-level security answers this person: its row, or none. */
function client(answer: { data: unknown; error: unknown } | Error): MissingCountClient & {
  asked: { table: string; columns: string; eq: [string, string][] }[];
} {
  const asked: { table: string; columns: string; eq: [string, string][] }[] = [];
  return {
    asked,
    from(table: string) {
      const q = { table, columns: '', eq: [] as [string, string][] };
      asked.push(q);
      const chain = {
        select(columns: string) {
          q.columns = columns;
          return chain;
        },
        eq(column: string, value: string) {
          q.eq.push([column, value]);
          return chain;
        },
        maybeSingle: async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
      };
      return chain;
    },
  };
}

describe('whyCountIsMissing', () => {
  it("a count in another of the person's workspaces (security lets a member of its organization read it)", async () => {
    const c = client({ data: { organization_id: ORG_B }, error: null });
    expect(await whyCountIsMissing(c, 'cc-1', ORG_A)).toBe('other-workspace');
    // One read, by id only: no workspace filter.
    expect(c.asked).toEqual([
      { table: 'cycle_counts', columns: 'organization_id', eq: [['id', 'cc-1']] },
    ]);
  });

  it('no row (no such count, or an organization the person is not in): not available', async () => {
    expect(await whyCountIsMissing(client({ data: null, error: null }), 'cc-1', ORG_A)).toBe(
      'not-available',
    );
  });

  it('a refused or failed read says not available, never a guess about where it is', async () => {
    expect(
      await whyCountIsMissing(client({ data: null, error: { message: 'denied' } }), 'cc-1', ORG_A),
    ).toBe('not-available');
    expect(
      await whyCountIsMissing(client(new Error('Network request failed')), 'cc-1', ORG_A),
    ).toBe('not-available');
  });

  it('a row in the workspace on screen (the first read raced) is not called another workspace', async () => {
    expect(
      await whyCountIsMissing(
        client({ data: { organization_id: ORG_A }, error: null }),
        'cc-1',
        ORG_A,
      ),
    ).toBe('not-available');
  });
});

describe('missingCountCopy', () => {
  it('says where the count is, or that it is not available; never that it has no lines', () => {
    expect(missingCountCopy('other-workspace')).toEqual({
      title: 'Count in another workspace',
      body: COUNT_IN_OTHER_WORKSPACE_COPY,
    });
    expect(missingCountCopy('not-available')).toEqual({
      title: 'Count not available',
      body: COUNT_NOT_AVAILABLE_COPY,
    });
    for (const why of ['other-workspace', 'not-available'] as const) {
      expect(JSON.stringify(missingCountCopy(why))).not.toMatch(/no lines/);
    }
  });
});

describe('app/cycle-count/[id].tsx (source: app/ cannot load under node)', () => {
  const screen = readFileSync(path.join(__dirname, '../../app/cycle-count/[id].tsx'), 'utf8');

  it('a read with no row and no error asks why, and never falls through to the ordinary screen', () => {
    expect(screen).toContain('setEmptyState(await whyCountIsMissing(supabase, id, orgId));');
    expect(screen).not.toContain("setEmptyState(message ? 'read-failed' : 'none');");
  });

  it('renders the missing count on its own screen, before the count view, with Back and Retry', () => {
    const missing = screen.indexOf(
      "if (emptyState === 'other-workspace' || emptyState === 'not-available') {",
    );
    expect(missing).toBeGreaterThan(-1);
    const block = screen.slice(missing, screen.indexOf("if (emptyState === 'offline-uncached')"));
    expect(block).toContain('const missing = missingCountCopy(emptyState);');
    expect(block).toContain('{missing.title}');
    expect(block).toContain('{missing.body}');
    expect(block).toContain('accessibilityLabel="Back"');
    expect(block).toContain('Retry');
  });

  it('"no lines yet" only under a count that was read', () => {
    expect(screen).toMatch(
      /\{header !== null && lines\.length === 0 && \(\s*<Text[^>]*>\s*This count has no lines yet\./,
    );
  });
});

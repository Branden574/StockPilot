import { describe, expect, it } from 'vitest';

import {
  compareRouteTables,
  parseRouteTable,
  routeTableFails,
} from '../../tests/e2e/appearance/stage5a-route-table';

/** The plan 8.5 route-table rule route-table-compare.mjs applies to two saved build logs. */

const BASE_LOG = [
  '   ▲ Next.js 16.4.3',
  '\u001b[1mRoute (app)\u001b[22m',
  '┌ ○ /',
  '├ ƒ /api/ai/chat',
  '├ ● /blog/[slug]',
  '│ ├ /blog/one',
  '│ └ /blog/two',
  '├ ○ /signin                                 1.2 kB   110 kB',
  '└ ƒ /dashboard',
  '',
  'ƒ Proxy (Middleware)',
  '',
  '○  (Static)   prerendered as static content',
].join('\n');

describe('stage 5 route table', () => {
  it('reads each route’s marker, leaves out generated paths and legend lines, keeps the proxy', () => {
    const table = parseRouteTable(BASE_LOG);
    expect([...table.entries()]).toEqual([
      ['app /', '○'],
      ['app /api/ai/chat', 'ƒ'],
      ['app /blog/[slug]', '●'],
      ['app /signin', '○'],
      ['app /dashboard', 'ƒ'],
      ['(proxy)', 'ƒ'],
    ]);
  });

  it('passes the same table with the glass routes added, listing them', () => {
    const branch = parseRouteTable(
      BASE_LOG.replace(
        '└ ƒ /dashboard',
        '├ ƒ /dashboard\n├ ƒ /api/appearance/style\n├ ○ /glass-site\n└ ○ /glass-site/pricing',
      ),
    );
    const base = parseRouteTable(BASE_LOG);
    const comparison = compareRouteTables(base, branch);
    expect(routeTableFails(base, branch, comparison)).toEqual([]);
    expect(comparison.added).toEqual([
      'app /api/appearance/style',
      'app /glass-site',
      'app /glass-site/pricing',
    ]);
    expect(comparison.unexpectedAdded).toEqual([]);
  });

  it('fails a changed marker, a lost route and an empty log; lists an unexpected new route', () => {
    const base = parseRouteTable(BASE_LOG);
    const branch = parseRouteTable(
      BASE_LOG.replace('├ ○ /signin', '├ ƒ /signin').replace('├ ƒ /api/ai/chat\n', '├ ○ /extra\n'),
    );
    const comparison = compareRouteTables(base, branch);
    expect(routeTableFails(base, branch, comparison)).toEqual([
      'marker changed: app /signin: ○ -> ƒ',
      'route missing on the branch: app /api/ai/chat',
    ]);
    expect(comparison.unexpectedAdded).toEqual(['app /extra']);
    const empty = parseRouteTable('build failed');
    expect(routeTableFails(base, empty, compareRouteTables(base, empty))).toContain(
      'the branch build log holds no route table',
    );
  });
});

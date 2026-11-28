import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every reader of an organization's module state, and what each does when the
 * state could not be read.
 *
 * supabase-js resolves a failed read as `{ data: null, error }`, the shape of
 * "no row". A reader that looks at `data` alone therefore answers "the module
 * is off" for a read that never answered. The rule this file holds the web
 * app to: a module state that could not be read is neither on nor off.
 *
 *   - Code that decides or writes (Server Actions, services, route handlers,
 *     the public API key path) refuses with a retry.
 *   - A page says it could not check and offers Try again, through its module
 *     panel, the dashboard's strip, or its error state.
 *   - Nothing is ever granted on a read that failed.
 *
 * The census below lists every source file that reads the
 * `organization_modules` table, with what it reads and what an unread answer
 * becomes. A new reader fails this guard until it is listed, which is the
 * moment to decide what it does with a read that failed.
 *
 * WHAT THIS IS, AND IS NOT. It is a census, one entry per FILE, that forces a
 * decision when a new file starts reading the table. It is not a proof that
 * every read is handled:
 *   - it finds a read by the table's name written out in a `.from(...)` call.
 *     A read that reaches the table some other way is for review to catch;
 *   - an entry speaks for its whole file, so a second read added to a listed
 *     file is covered by that file's entry and by review, not by a new entry;
 *   - the class and the note are written by hand. For `settings` and `error`
 *     entries the guard checks the read's text for what the class claims,
 *     which is a sanity check on the listing, not an analysis of the code;
 *     a `closed` entry's note is not checked against the code at all.
 * The behaviour itself is held by the suites beside each reader (listed in
 * scripts/security-test.sh); this file keeps the list of readers complete.
 *
 * Its companion for the answers: server/actions/unchecked-access.guard.test.ts
 * reads every catch in the Server Action modules and holds each to the shared
 * mapping of a check that could not be read, so an action module with its own
 * error mapping cannot answer its generic sentence for this state.
 */

const SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__classic__' || name === '__parity__') continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC);
const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');
const read = (relative: string) => readFileSync(path.join(SRC, relative), 'utf8');

/**
 * What a reader does with a module state it could not read.
 *
 *   error     the read's failure is an error to the caller: a thrown error, a
 *             5xx, a retry answer, a "could not check" state. Never "off".
 *   closed    the reader answers as if nothing were there, for a reason the
 *             note gives. Nothing is granted; these are listed so the choice
 *             is visible and is made on purpose.
 *   settings  the file reads the row's `settings` (a threshold, a list of
 *             categories), never whether the module is on.
 */
type Unread = 'error' | 'closed' | 'settings';

const READERS: Record<string, { unread: Unread; note: string }> = {
  // ── The request's own module set ──────────────────────────────────────────
  'lib/dashboard/request-cache.ts': {
    unread: 'error',
    note: 'held as unknown (UnreadableModuleSet); the page gate and the layout read the outcome',
  },
  'lib/auth/api-context.ts': {
    unread: 'error',
    note: 'held as unknown (UnreadableModuleSet)',
  },
  'lib/modules/org-may-use-module.ts': {
    unread: 'error',
    note: 'throws ModulesUnavailableError; callers answer 503 or the transient connect code',
  },

  // ── Pages ─────────────────────────────────────────────────────────────────
  'app/(dashboard)/dashboard/settings/modules/page.tsx': {
    unread: 'error',
    note: 'no switches; "We couldn\'t load your modules" with Try again',
  },
  'app/(dashboard)/dashboard/settings/integrations/page.tsx': {
    unread: 'closed',
    note: 'a note about exports only: an unread row shows no note, and claims nothing',
  },
  'app/(dashboard)/dashboard/customers/page.tsx': { unread: 'settings', note: 'pricing mode' },
  'app/(dashboard)/dashboard/maintenance/new/page.tsx': { unread: 'settings', note: 'categories' },
  'app/(dashboard)/dashboard/purchase-orders/page.tsx': {
    unread: 'settings',
    note: 'approval threshold shown in a panel',
  },
  'app/(dashboard)/dashboard/settings/inventory-cleanup/page.tsx': {
    unread: 'settings',
    note: 'cleanup settings',
  },
  'app/(dashboard)/dashboard/settings/maintenance/page.tsx': {
    unread: 'settings',
    note: 'maintenance settings',
  },

  // ── Public routes and services (the explicit enabled row) ─────────────────
  'app/api/v1/public/catalog-thumbnails/route.ts': {
    unread: 'error',
    note: '503, no-store, Retry-After; never the cached empty map',
  },
  'app/api/v1/public/order-requests/[id]/route.ts': {
    unread: 'error',
    note: 'the order is shown and the answer says the return link could not be checked',
  },
  'app/api/v1/public/order-requests/route.ts': { unread: 'error', note: '500 before any write' },
  'server/services/public-catalog.ts': {
    unread: 'error',
    note: 'kept as "unread", never as an answer: read again directly, and the page\'s error state when that read does not answer either',
  },
  'server/services/portal.ts': {
    unread: 'error',
    note: 'throws for the portal gate and for the returns button',
  },
  'server/email/return-prompt.ts': { unread: 'error', note: 'reported as a failed read; no email' },
  'server/services/rentals.ts': {
    unread: 'error',
    note: 'null, and the pages say they could not check',
  },
  'server/services/returns.ts': {
    unread: 'closed',
    note: 'the shared door of the requester return surfaces: every miss, a failed read included, is their one "not found"',
  },
  'server/services/delivery-tracking.ts': {
    unread: 'closed',
    note: 'a polled position: "not available" for this poll, asked again on the next',
  },

  // ── Readers that already refuse ───────────────────────────────────────────
  'server/loaders/inventory-list.ts': { unread: 'error', note: 'throws; the pass is not cached' },
  'server/services/platform/permission-exceptions.ts': { unread: 'error', note: 'throws' },
  'server/connectors/drainer.ts': { unread: 'error', note: 'throws; nothing is exported' },
  'server/actions/module-settings.ts': { unread: 'error', note: 'throws before any write' },
  'server/actions/industry-pack.ts': { unread: 'error', note: 'throws before any write' },
  'lib/ai/embeddings-sweep.ts': { unread: 'error', note: 'throws; the run reads no item' },

  // ── Scheduled jobs ────────────────────────────────────────────────────────
  // The list of organizations a job runs for is read with a helper that
  // throws on a failed page, so the run fails. The per-organization context a
  // job then runs as comes from the shared loadSystemContext, which answers a
  // failed read with read_failed: that organization is a failure for that run
  // (reported once per run), never run with an empty set, and the next run
  // reads again.
  'app/api/cron/auto-archive-zero-stock/route.ts': {
    unread: 'error',
    note: 'list read throws; the settings read again as each organization starts throws; the per-organization set comes from loadSystemContext',
  },
  'app/api/cron/auto-delete-archived/route.ts': {
    unread: 'error',
    note: 'list read throws; the settings read again as each organization starts throws; the per-organization set comes from loadSystemContext',
  },
  'app/api/cron/auto-reorder/route.ts': {
    unread: 'error',
    note: 'list read throws; the settings read again as each organization starts throws; the per-organization set comes from loadSystemContext',
  },
  'app/api/cron/daily-briefing/route.ts': {
    unread: 'error',
    note: 'list read throws; the per-organization set comes from loadSystemContext, and an organization whose set could not be read is a failure for the run, reported once',
  },
  'app/api/cron/recurring-pos/route.ts': {
    unread: 'error',
    note: 'list read throws; the per-organization set comes from loadSystemContext',
  },
  'server/services/lib/system-context.ts': {
    unread: 'error',
    note: 'the shared per-organization context: a failed read is read_failed (buildSystemContext throws), never an empty set',
  },
  'app/api/cron/maintenance-draft-reminders/route.ts': { unread: 'error', note: '500; no run' },
  'app/api/cron/price-pull/route.ts': { unread: 'error', note: '500; no run' },
  'app/api/cron/rental-overdue/route.ts': { unread: 'error', note: '500; no run' },
  'app/api/cron/supplier-risk-reminders/route.ts': {
    unread: 'error',
    note: '500; nothing claimed or sent',
  },

  // ── Settings only ─────────────────────────────────────────────────────────
  'server/actions/auto-archive-settings.ts': { unread: 'settings', note: 'reads, then writes settings' },
  'server/actions/auto-reorder-settings.ts': { unread: 'settings', note: 'reads, then writes settings' },
  'server/actions/inventory-cleanup-settings.ts': {
    unread: 'settings',
    note: 'reads, then writes settings',
  },
  'server/actions/maintenance-settings.ts': { unread: 'settings', note: 'reads, then writes settings' },
  'server/actions/planning-settings.ts': { unread: 'settings', note: 'reads, then writes settings' },
  'server/actions/po-approval-settings.ts': { unread: 'settings', note: 'reads, then writes settings' },
  'server/email/maintenance-resolved.ts': { unread: 'settings', note: 'share link setting' },
  'server/services/auto-reorder.ts': { unread: 'settings', note: 'auto-reorder settings' },
  'server/services/customers.ts': { unread: 'settings', note: 'pricing mode' },
  'server/services/maintenance-notify.ts': { unread: 'settings', note: 'notification settings' },
  'server/services/maintenance-share-links.ts': { unread: 'settings', note: 'share link setting' },
  'server/services/planning.ts': { unread: 'settings', note: 'planning parameters' },
  'server/services/purchase-orders.ts': { unread: 'settings', note: 'approval threshold' },
  'server/services/recurring-pos.ts': { unread: 'settings', note: 'approval threshold' },
};

/** For matchAll, which works on a copy and leaves this one's position alone. */
const MODULE_TABLE_READ = /\.from\(\s*['"`]organization_modules['"`]\s*\)/g;
/** For a yes or no: not global, so it keeps no position between calls. */
const READS_MODULE_TABLE = /\.from\(\s*['"`]organization_modules['"`]\s*\)/;

describe('every reader of the module table is listed, with what an unread answer becomes', () => {
  const found = FILES.filter((f) => READS_MODULE_TABLE.test(readFileSync(f, 'utf8')))
    .map(rel)
    .sort();

  it('finds the readers', () => {
    expect(found.length).toBeGreaterThan(40);
  });

  it('no reader is missing from the census', () => {
    expect(found.filter((f) => !(f in READERS))).toEqual([]);
  });

  it('the census lists no file that no longer reads the table', () => {
    expect(Object.keys(READERS).filter((f) => !found.includes(f))).toEqual([]);
  });

  it('a reader listed as "settings" selects the settings and never whether the module is on', () => {
    for (const [file, entry] of Object.entries(READERS)) {
      if (entry.unread !== 'settings') continue;
      const src = read(file);
      for (const m of src.matchAll(MODULE_TABLE_READ)) {
        const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 200);
        const select = /^\s*\.select\(\s*['"`]([^'"`]*)['"`]/.exec(after);
        // A write (update / upsert) follows a read of the same row here.
        if (!select) {
          expect(after, `${file}: a read or a write of settings`).toMatch(/^\s*\.(update|upsert)\(/);
          continue;
        }
        expect(select[1], file).toMatch(/settings/);
        expect(select[1], file).not.toMatch(/\benabled\b/);
      }
    }
  });

  it('a reader listed as "error" takes its read\'s failure: the error, or a helper that throws on one', () => {
    for (const [file, entry] of Object.entries(READERS)) {
      if (entry.unread !== 'error') continue;
      const src = read(file);
      for (const m of src.matchAll(MODULE_TABLE_READ)) {
        const around = src.slice(Math.max(0, m.index! - 500), m.index! + 700);
        expect(around, `${file}: the read near offset ${m.index} does not look at its error`).toMatch(
          /\berror\b|Error\b|fetchAllRows|fetchAllRowsByIds/,
        );
      }
    }
  });
});

describe('the request-cached module set cannot be taken for "off"', () => {
  it('getModulesForRequest holds an unread state as unknown', () => {
    const src = read('lib/dashboard/request-cache.ts');
    const body = src.slice(src.indexOf('export const getModulesForRequest'));
    expect(body).toMatch(/moduleSetFromReads\(\s*read\.modules,\s*read\.rowsUnreadable,/);
  });

  it('only the page gate reads the plain fail-closed set beside its outcome', () => {
    const users = FILES.filter((f) => /\breadModulesForRequest\(/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .sort();
    expect(users).toEqual(['lib/dashboard/request-cache.ts', 'lib/modules/module-gate.ts']);
  });

  it('withContext builds its set from getModulesForRequest, never from a read of its own', () => {
    const src = read('server/services/context.ts');
    expect(src).toMatch(/modulesFromMembership\(held\) \?\? getModulesForRequest\(ctx\.organizationId\)/);
    expect(src).not.toMatch(/readModulesForRequest/);
    expect(src).not.toMatch(READS_MODULE_TABLE);
  });

  it('a Server Action answers the unknown state with its try-again sentence', () => {
    const src = read('server/lib/action-error-result.ts');
    expect(src).toMatch(/e instanceof ModulesUnavailableError/);
    // The shared mapper and the helper for modules with their own mapping are one code path.
    expect(src).toMatch(/const unchecked = uncheckedAccessResult\(e, tag, \{/);
  });

  it('the unknown state carries a digest the error cards know, and both cards read it', () => {
    expect(read('lib/modules/module-state.ts')).toMatch(/readonly digest = ACCESS_UNCHECKED_DIGEST;/);
    for (const card of ['app/(dashboard)/error.tsx', 'app/error.tsx']) {
      expect(read(card), card).toMatch(/knownErrorState\(error\)/);
    }
  });
});

/**
 * A page gate answer (`checkModuleAccess`) says `enabled: false` both for a
 * module that is off and for one it could not check (`checkFailed`). A page's
 * OWN gate draws ModuleUnavailable, which tells the two apart. A page that
 * asks about another module (a form's extra fields, a card) must not read
 * `enabled` alone: it goes through `moduleAnswer`, which throws for "could
 * not check".
 *
 * A page that draws its own gate first is exempt: within one request every
 * non-core module is answered from the same read, so its other modules cannot
 * be unknown once its own is on (lib/modules/module-gate.test.ts pins that).
 */
describe('a page never reads a page gate answer\'s `enabled` alone', () => {
  const BARE_ENABLED = [
    /\{\s*enabled\b[^}]*\}\s*=\s*await\s+checkModuleAccess\(/,
    /checkModuleAccess\([^)]*\)\s*\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.enabled\b/,
    /\[\s*\{\s*enabled\b[^\]]*\]\s*=\s*await\s+Promise\.all\(\[\s*checkModuleAccess\(/,
  ];
  /** Display-only enrichment with its own "degrades, never breaks" contract. */
  const EXEMPT = new Set(['server/services/size-run-display.ts']);

  it('every such read is in a file that draws its own gate, or goes through moduleAnswer', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('checkModuleAccess(')) continue;
      const name = rel(file);
      if (EXEMPT.has(name) || name === 'lib/modules/module-gate.ts') continue;
      if (src.includes('<ModuleUnavailable')) continue;
      if (BARE_ENABLED.some((re) => re.test(src))) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('the pages that ask about a module that is not their own gate use moduleAnswer', () => {
    for (const file of [
      'app/(dashboard)/dashboard/page.tsx',
      'app/(dashboard)/dashboard/reports/page.tsx',
      'app/(dashboard)/dashboard/categories/page.tsx',
      'app/(dashboard)/dashboard/inventory/new/page.tsx',
      'app/(dashboard)/dashboard/inventory/import/page.tsx',
      'app/(dashboard)/dashboard/inventory/[id]/edit/page.tsx',
      'app/(dashboard)/dashboard/books/new/page.tsx',
      'app/(dashboard)/dashboard/books/[id]/edit/page.tsx',
      'app/(dashboard)/dashboard/rentals/items/new/page.tsx',
    ]) {
      expect(read(file), file).toMatch(/moduleAnswer\b/);
    }
  });

  it('the dashboard layout draws the menu from what is known and says when the state was not read', () => {
    const src = read('app/(dashboard)/layout.tsx');
    expect(src).toMatch(/moduleSetUnreadable\(enabledModuleSet\)/);
    expect(src).toMatch(/\{moduleStateUnknown && <ModulesUnreadBanner \/>\}/);
  });
});

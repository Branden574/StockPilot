import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * SP-120 — every exported Server Action must have at least one caller.
 *
 * WHY THIS EXISTS. A `'use server'` module compiles EVERY export into a server
 * reference the runtime will execute if it is invoked by ID. An exported action
 * with no UI, no route and no test is therefore live, callable surface that
 * nobody maintains — and, worse, it is usually a SECOND implementation of a
 * behaviour that also has a live sibling. That is recurring bug pattern #26
 * ("a fix applied to ONE copy of a duplicated function is not a fix"): the
 * behaviour fix lands on the reachable copy, the orphan keeps the old
 * semantics, and the next reviewer greps, finds two implementations and cannot
 * tell which one is canonical.
 *
 * It had already started drifting when this guard was written:
 *   - `archiveItemAction` called `InventoryService.archive` (guarded by
 *     `assertArchivableOrThrow`) while the LIVE single-item archive in
 *     components/inventory/bulk-actions.tsx goes through
 *     `bulkUpdateInventoryAction` -> `svc.bulkUpdate` and its separate 'bulk
 *     twin' guard. Two guards, one reachable only through dead code.
 *   - actions/embeddings.ts enforces the MFA step-up on the live
 *     `backfillItemEmbeddingsAction` but NOT on the orphaned
 *     `getMissingEmbeddingsCountAction` — the drift already happened.
 *
 * WHAT IT CHECKS. For every `'use server'` module under src/server/actions,
 * every `export async function` name must appear in at least one OTHER
 * non-test source file under apps/web/src or apps/mobile/src.
 *
 * Tests deliberately do NOT count as callers: an action reachable only from a
 * test is still unreachable in production.
 */

const WEB_SRC = path.resolve(__dirname, '../..');
const ACTIONS_DIR = __dirname;
const MOBILE_SRC = path.resolve(WEB_SRC, '../../mobile/src');

/**
 * Actions that are knowingly unreachable and are NOT being deleted here.
 *
 * All of these live in files outside this change's ownership. They are listed
 * — not ignored — so the guard can go green while the class stays visible and
 * countable. Removing an entry is the whole point: either wire the action to a
 * caller or delete it (and drop the entry). Adding one needs a written reason;
 * "an API-only action with no UI yet" is a reason, "I could not find the
 * caller" is not.
 *
 * Deleting the action but leaving its entry here does NOT fail this suite — a
 * stale excuse is untidy, not dangerous. An excuse that has quietly gained a
 * real caller DOES fail, because then it is hiding a live action from the
 * guard.
 */
const KNOWN_UNREACHABLE: ReadonlyArray<{ name: string; file: string; reason: string }> = [
  {
    name: 'createProcedureCategoryAction',
    file: 'procedures.ts',
    reason: 'SP-120 orphan; procedures.ts is outside this change — delete or wire it.',
  },
  {
    name: 'updateProcedureCategoryAction',
    file: 'procedures.ts',
    reason: 'SP-120 orphan; procedures.ts is outside this change — delete or wire it.',
  },
  {
    name: 'archiveProcedureCategoryAction',
    file: 'procedures.ts',
    reason: 'SP-120 orphan; procedures.ts is outside this change — delete or wire it.',
  },
  {
    name: 'getMissingEmbeddingsCountAction',
    file: 'embeddings.ts',
    reason:
      'SP-120 orphan; already drifted (no MFA step-up, unlike its live sibling). embeddings.ts is outside this change.',
  },
  {
    name: 'rotateIntegrationEndpointSecretAction',
    file: 'integration-endpoints.ts',
    reason:
      'SP-120 orphan; the owner still has to decide whether secret rotation gets a settings button. integration-endpoints.ts is outside this change.',
  },
  // Found by this guard, NOT by the SP-120 sweep (which stopped at seven) —
  // proof that the class is wider than the report and that a mechanical check
  // beats a manual grep. Each needs the same wire-or-delete decision.
  {
    name: 'signUpAction',
    file: 'auth.ts',
    reason:
      'No caller: self-serve sign-up is not wired to a page. Unreachable auth surface — decide deliberately.',
  },
  {
    name: 'setBundleActiveAction',
    file: 'bundles.ts',
    reason: 'No caller: bundle activation has no UI control.',
  },
  {
    name: 'setDigestOptinAction',
    file: 'digest.ts',
    reason:
      'No caller: the daily-briefing opt-in is set elsewhere (notification preferences), not through this action.',
  },
  {
    name: 'updateMaintenanceRequestAction',
    file: 'maintenance-requests.ts',
    reason:
      'No caller: only the maintenance detail page TEST mocks it, which is exactly the shape this guard exists to catch.',
  },
  {
    name: 'rotatePublicRequestTokenAction',
    file: 'order-requests.ts',
    reason: 'No caller: public-request token rotation has no settings control yet.',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      walk(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

const isTestFile = (file: string) => /\.test\.(ts|tsx)$/.test(path.basename(file));

/** Files an action could legitimately be called from: app source, never tests. */
const sourceFiles = [...walk(WEB_SRC), ...walk(MOBILE_SRC)].filter((f) => !isTestFile(f));

/** `'use server'` modules only — plain helper modules export normal functions. */
const actionModules = walk(ACTIONS_DIR)
  .filter((f) => !isTestFile(f))
  .filter((f) => /^\s*(['"])use server\1\s*;/.test(fs.readFileSync(f, 'utf8')));

const exportedActions = actionModules.flatMap((file) => {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/^export async function ([A-Za-z0-9_$]+)/gm)].map((m) => ({
    file,
    name: m[1] as string,
  }));
});

/**
 * action name -> the files that mention it. ONE tokenizing pass over the tree,
 * matched against the known names, instead of one `grep` per action: ~200
 * greps was slow enough to be a flake risk under CI load. Matching against the
 * collected name set (rather than a name-shaped regex) matters — not every
 * action is spelled `…Action` (`getMfaRecoveryCodeStatus` is one), and a
 * shape-based tokenizer reports those as orphans no matter who calls them.
 */
const actionNames = new Set(exportedActions.map((a) => a.name));
const mentions = new Map<string, Set<string>>();
for (const file of sourceFiles) {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const token of text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
    if (!actionNames.has(token)) continue;
    let set = mentions.get(token);
    if (!set) {
      set = new Set();
      mentions.set(token, set);
    }
    set.add(file);
  }
}

describe('server actions are reachable (SP-120)', () => {
  it('finds the action modules at all (guards the regexes above)', () => {
    expect(actionModules.length).toBeGreaterThan(20);
    expect(exportedActions.length).toBeGreaterThan(100);
    expect(exportedActions.map((a) => a.name)).toContain('bulkUpdateInventoryAction');
  });

  it('has no exported Server Action without a caller', () => {
    const allowed = new Set(KNOWN_UNREACHABLE.map((e) => e.name));
    const orphans = exportedActions
      .filter(({ file, name }) => {
        if (allowed.has(name)) return false;
        const callers = mentions.get(name);
        if (!callers) return true;
        // The defining module mentions its own export; that is not a caller.
        return [...callers].every((caller) => caller === file);
      })
      .map(({ file, name }) => `${path.relative(WEB_SRC, file)}: ${name}`);

    expect(orphans).toEqual([]);
  });

  it('does not excuse an action that now has a caller', () => {
    // An excuse that has gained a real caller is worse than no excuse: it hides
    // a LIVE action from the reachability check above. Prune it when you wire
    // the action up. (A deleted action whose entry lingers is merely untidy and
    // deliberately does not fail here — see the note on KNOWN_UNREACHABLE.)
    const stale = KNOWN_UNREACHABLE.filter(({ name }) => {
      const defining = exportedActions.find((a) => a.name === name);
      if (!defining) return false; // already deleted — nothing to hide
      const callers = mentions.get(name);
      if (!callers) return false;
      return [...callers].some((caller) => caller !== defining.file);
    }).map((e) => `${e.file}: ${e.name}`);

    expect(stale).toEqual([]);
  });
});

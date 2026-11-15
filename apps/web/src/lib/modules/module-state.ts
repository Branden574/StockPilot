import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

import { ACCESS_UNCHECKED_DIGEST } from '@/lib/known-error-states';

/**
 * An organization's module state that could not be read, held as a refusal
 * instead of as "off" (docket S81).
 *
 * WHY. withApiContext builds `ctx.enabledModules` from two reads when
 * get_request_context() gives no usable answer: the organization's enabled
 * `organization_modules` rows and its `organizations.all_modules_comp` flag.
 * supabase-js RESOLVES a failed read as `{ data: null, error }`, and a set
 * built from that alone would be the set of an organization that switched
 * every module off. "Off" is an answer the phone acts on: a 403
 * `module_disabled` is final for its outbox, and a snapshot's module list is
 * stored and redraws its navigation. A state that was not read must be
 * neither.
 *
 * WHAT. When a read failed and the answer is not fully known, the context
 * holds an UnreadableModuleSet instead of a plain Set:
 *   - `has(id)` answers true for a core module (core is never gated) and for a
 *     module KNOWN to be on (an enabled row that was read, or a comp that was
 *     read as true), and throws ModulesUnavailableError for any other module;
 *   - anything that lists or changes the set (size, iteration, forEach, a
 *     copy, add, delete, clear, the set operations) throws it too, so no
 *     route can send an empty or partial list as the organization's modules.
 * Its own set storage is empty, so code that reaches past these methods
 * (Set.prototype.has.call, structuredClone) reads an empty set: it never
 * reads a module as on. No code here does that; a caller that did would read
 * every module as off, so none may.
 *
 * LAZY ON PURPOSE. Only a request that asks about a module it cannot know is
 * refused; a route that depends on no optional module answers as before. The
 * routes the phone cannot send twice ask for their module in the API context
 * gate (server/lib/api-context-gate.ts), which answers this state as its 503
 * marked as refused before any write (docket S26). Anywhere else the error is
 * the route's 5xx, which the phone retries: internalErrorResponse handles it
 * like PermissionsUnavailableError.
 */

/**
 * The module state could not be read: a refusal, never "the module is off".
 *
 * `digest` is fixed so a page's error boundary can name this state. Thrown
 * while a Server Component renders, the error reaches the browser only as
 * its digest (Next keeps one an error already carries: lib/known-error-states
 * has the detail), and the dashboard and root error cards then say "We
 * couldn't check your access just now" with Try again, instead of the card
 * for a crash. It changes nothing for a catch: this is not Next control flow.
 */
export class ModulesUnavailableError extends Error {
  readonly code = 'MODULES_UNAVAILABLE';
  readonly digest = ACCESS_UNCHECKED_DIGEST;

  constructor() {
    super('Your access could not be checked. Please try again.');
    this.name = 'ModulesUnavailableError';
  }
}

function refuse(): never {
  throw new ModulesUnavailableError();
}

function isCoreModule(id: unknown): boolean {
  return (
    (MODULE_REGISTRY as Record<string, { tier?: string } | undefined>)[String(id)]?.tier === 'core'
  );
}

export class UnreadableModuleSet extends Set<ModuleId> {
  readonly #knownOn: ReadonlySet<ModuleId>;

  constructor(knownOn: Iterable<ModuleId>) {
    // Nothing goes into the set's own storage: see the note above.
    super();
    this.#knownOn = new Set(knownOn);
  }

  override has(id: ModuleId): boolean {
    if (this.#knownOn.has(id) || isCoreModule(id)) return true;
    return refuse();
  }

  override get size(): number {
    return refuse();
  }

  override add(_id: ModuleId): this {
    return refuse();
  }

  override delete(_id: ModuleId): boolean {
    return refuse();
  }

  override clear(): void {
    refuse();
  }

  override forEach(): void {
    refuse();
  }

  override values(): SetIterator<ModuleId> {
    return refuse();
  }

  override keys(): SetIterator<ModuleId> {
    return refuse();
  }

  override entries(): SetIterator<[ModuleId, ModuleId]> {
    return refuse();
  }

  override [Symbol.iterator](): SetIterator<ModuleId> {
    return refuse();
  }
}

// The set operations (union, intersection, difference, symmetricDifference,
// isSubsetOf, isSupersetOf, isDisjointFrom) read the receiver's own storage,
// which is empty here, so each one refuses too. Defined on the prototype so it
// holds whether or not the TypeScript lib in use declares them.
for (const name of [
  'union',
  'intersection',
  'difference',
  'symmetricDifference',
  'isSubsetOf',
  'isSupersetOf',
  'isDisjointFrom',
]) {
  Object.defineProperty(UnreadableModuleSet.prototype, name, {
    value: refuse,
    writable: true,
    configurable: true,
  });
}

/**
 * The context's module set after the two reads: `known` is what the reads
 * that worked say is on. Fully known (both reads worked, or a comp that was
 * read covers every non-core module) is the plain set; otherwise the
 * UnreadableModuleSet above.
 */
export function moduleSetFromReads(
  known: Set<ModuleId>,
  readFailed: boolean,
  allNonCore: readonly ModuleId[],
): Set<ModuleId> {
  if (!readFailed) return known;
  if (allNonCore.every((id) => known.has(id))) return known;
  return new UnreadableModuleSet(known);
}

/**
 * True when some module's state is unknown for this context: the set cannot be
 * listed. For a route that lists the whole set (the mobile snapshot), which
 * refuses before any work. Never true for a plain set.
 */
export function moduleSetUnreadable(modules: ReadonlySet<ModuleId>): boolean {
  return modules instanceof UnreadableModuleSet;
}

/**
 * True when `id`'s state is unknown for this context: asking would throw
 * ModulesUnavailableError. For the API context gate, which answers that before
 * any work. Never true for a plain set.
 */
export function moduleStateUnreadable(modules: ReadonlySet<ModuleId>, id: ModuleId): boolean {
  if (!(modules instanceof UnreadableModuleSet)) return false;
  try {
    modules.has(id);
    return false;
  } catch (e) {
    if (e instanceof ModulesUnavailableError) return true;
    throw e;
  }
}

/**
 * A page gate's answer (checkModuleAccess, lib/modules/module-gate) for a
 * page that asks about a module that is NOT its own gate: a form's extra
 * fields, a card, a shortcut. True when the module is on, false when it is
 * off, and ModulesUnavailableError when its state could not be read
 * (`checkFailed`): the page then reaches its error state with Try again
 * instead of being drawn as if the module were off.
 *
 * A page's OWN gate does not use this: it draws ModuleUnavailable, which has
 * a "could not check" panel of its own. Pure, so a test that replaces
 * checkModuleAccess keeps this rule.
 */
export function moduleAnswer(access: { enabled: boolean; checkFailed?: boolean }): boolean {
  if (access.checkFailed) return refuse();
  return access.enabled;
}

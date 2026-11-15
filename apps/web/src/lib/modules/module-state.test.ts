import { describe, expect, it } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { isControlFlow } from '@/lib/control-flow';
import { ACCESS_UNCHECKED_DIGEST, knownErrorState } from '@/lib/known-error-states';

import { NON_CORE_MODULE_IDS } from './effective-modules';
import {
  ModulesUnavailableError,
  UnreadableModuleSet,
  moduleAnswer,
  moduleSetFromReads,
  moduleStateUnreadable,
} from './module-state';

/**
 * The module set withApiContext holds when a module read failed (docket S81).
 * api-context.unreadable-modules.guard.test.ts pins it through the real
 * context loader; this pins the set itself, every way of reading it.
 */

const unreadable = () => new UnreadableModuleSet(['orders']);

describe('UnreadableModuleSet', () => {
  it('answers on for a module known to be on and for a core module', () => {
    const s = unreadable();
    expect(s.has('orders')).toBe(true);
    expect(s.has('inventory')).toBe(true);
    expect(s.has('scan')).toBe(true);
  });

  it('refuses a question about any other module', () => {
    expect(() => unreadable().has('rentals')).toThrow(ModulesUnavailableError);
    expect(() => unreadable().has('lot_serial')).toThrow(ModulesUnavailableError);
  });

  it.each<[string, (s: Set<ModuleId>) => unknown]>([
    ['size', (s) => s.size],
    ['spread', (s) => [...s]],
    ['Array.from', (s) => Array.from(s)],
    ['a copy', (s) => new Set(s)],
    ['forEach', (s) => s.forEach(() => {})],
    ['values', (s) => s.values()],
    ['keys', (s) => s.keys()],
    ['entries', (s) => s.entries()],
    ['add', (s) => s.add('rentals')],
    ['delete', (s) => s.delete('orders')],
    ['clear', (s) => s.clear()],
    ['union', (s) => (s as unknown as { union: (o: Set<string>) => unknown }).union(new Set())],
    [
      'isSubsetOf',
      (s) => (s as unknown as { isSubsetOf: (o: Set<string>) => unknown }).isSubsetOf(new Set()),
    ],
  ])('refuses %s', (_how, read) => {
    expect(() => read(unreadable())).toThrow(ModulesUnavailableError);
  });

  it('holds nothing in its own storage, so a read past the methods finds nothing on', () => {
    expect(Set.prototype.has.call(unreadable(), 'orders')).toBe(false);
  });

  it('the error is a refusal with a fixed sentence and its own class', () => {
    const e = new ModulesUnavailableError();
    expect(e.name).toBe('ModulesUnavailableError');
    expect(e.code).toBe('MODULES_UNAVAILABLE');
    expect(e.message).toBe('Your access could not be checked. Please try again.');
  });
});

describe('moduleSetFromReads', () => {
  it('reads that worked: the plain set, as it was', () => {
    const known = new Set<ModuleId>(['orders']);
    expect(moduleSetFromReads(known, false, NON_CORE_MODULE_IDS)).toBe(known);
  });

  it('a failed read with every non-core module known on (a comp that was read): the plain set', () => {
    const known = new Set<ModuleId>(NON_CORE_MODULE_IDS);
    expect(moduleSetFromReads(known, true, NON_CORE_MODULE_IDS)).toBe(known);
  });

  it('a failed read with anything unknown: the unreadable set, never a plain empty one', () => {
    const s = moduleSetFromReads(new Set(), true, NON_CORE_MODULE_IDS);
    expect(s).toBeInstanceOf(UnreadableModuleSet);
    expect(() => s.has('rentals')).toThrow(ModulesUnavailableError);
  });
});

describe('moduleStateUnreadable', () => {
  it('true only for a module whose state is unknown', () => {
    const s = unreadable();
    expect(moduleStateUnreadable(s, 'rentals')).toBe(true);
    expect(moduleStateUnreadable(s, 'orders')).toBe(false);
    expect(moduleStateUnreadable(s, 'inventory')).toBe(false);
  });

  it('never true for a plain set, whether the module is on or off', () => {
    expect(moduleStateUnreadable(new Set<ModuleId>(['rentals']), 'rentals')).toBe(false);
    expect(moduleStateUnreadable(new Set<ModuleId>(), 'rentals')).toBe(false);
  });
});

describe('moduleAnswer: a page gate answer for a module that is not the page\'s own gate', () => {
  it('on is true and off is false, when the state was read', () => {
    expect(moduleAnswer({ enabled: true })).toBe(true);
    expect(moduleAnswer({ enabled: false })).toBe(false);
    expect(moduleAnswer({ enabled: false, checkFailed: false })).toBe(false);
  });

  it('a state that could not be read is the try-again error, never false', () => {
    expect(() => moduleAnswer({ enabled: false, checkFailed: true })).toThrow(
      ModulesUnavailableError,
    );
    expect(() => moduleAnswer({ enabled: false, checkFailed: true })).toThrow(
      'Your access could not be checked. Please try again.',
    );
  });
});

describe('ModulesUnavailableError is a state an error boundary can name', () => {
  it('carries the access-unchecked digest, which Next passes to the page\'s error boundary in place of a generated one', () => {
    expect(new ModulesUnavailableError().digest).toBe(ACCESS_UNCHECKED_DIGEST);
    expect(knownErrorState(new ModulesUnavailableError())?.key).toBe('access-unchecked');
  });

  it('is not Next control flow: a catch that lets redirects out still handles it', () => {
    expect(isControlFlow(new ModulesUnavailableError())).toBe(false);
  });
});


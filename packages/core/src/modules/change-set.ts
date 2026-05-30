import { MODULE_REGISTRY, type ModuleId } from './registry';

export interface ModuleChange { moduleId: ModuleId; enabled: boolean; }

const isCore = (id: ModuleId) => MODULE_REGISTRY[id].tier === 'core';

/** All modules that directly depend on `id` (any core ones are filtered out by
 *  the isCore guard in visit(), not here). */
function directDependents(id: ModuleId): ModuleId[] {
  return (Object.values(MODULE_REGISTRY))
    .filter((m) => m.dependsOn.includes(id))
    .map((m) => m.id);
}

/**
 * The coherent set of (moduleId, enabled) changes to apply so that toggling
 * `moduleId` to `next` never leaves an enabled module with a disabled required
 * dependency. Enabling cascades required (non-core) deps ON; disabling cascades
 * (non-core) dependents OFF. Core modules are always on and never emitted. Only
 * modules whose state actually changes vs `enabled` are returned.
 */
export function computeModuleChangeSet(
  enabled: Set<ModuleId>,
  moduleId: ModuleId,
  next: boolean,
): ModuleChange[] {
  if (isCore(moduleId)) return [];
  const target = new Map<ModuleId, boolean>();
  const visit = (id: ModuleId) => {
    if (isCore(id) || target.has(id)) return;
    target.set(id, next);
    if (next) {
      for (const dep of MODULE_REGISTRY[id].dependsOn) if (!isCore(dep)) visit(dep);
    } else {
      for (const dep of directDependents(id)) visit(dep);
    }
  };
  visit(moduleId);
  const out: ModuleChange[] = [];
  for (const [id, want] of target) {
    if (enabled.has(id) !== want) out.push({ moduleId: id, enabled: want });
  }
  return out;
}

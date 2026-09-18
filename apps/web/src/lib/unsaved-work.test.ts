import { beforeEach, describe, expect, it } from 'vitest';

import {
  getUnsavedSources,
  registerUnsavedSource,
  resetUnsavedSourcesForTests,
} from './unsaved-work';

beforeEach(() => resetUnsavedSourcesForTests());

describe('unsaved-work registry', () => {
  it('reports only the sources that are dirty at the moment of asking', () => {
    let dirty = false;
    registerUnsavedSource({ id: 'item-form', label: 'New item', isDirty: () => dirty });
    registerUnsavedSource({ id: 'receive', label: 'Receiving PO-1042', isDirty: () => true });
    expect(getUnsavedSources()).toEqual([{ id: 'receive', label: 'Receiving PO-1042' }]);
    dirty = true;
    expect(getUnsavedSources().map((s) => s.id)).toEqual(['item-form', 'receive']);
  });

  it('forgets a form when it unmounts', () => {
    const off = registerUnsavedSource({ id: 'item-form', label: 'New item', isDirty: () => true });
    off();
    expect(getUnsavedSources()).toEqual([]);
  });

  it('a stale unregister does not remove the remounted form’s registration', () => {
    const offOld = registerUnsavedSource({
      id: 'item-form',
      label: 'New item',
      isDirty: () => true,
    });
    registerUnsavedSource({ id: 'item-form', label: 'New item', isDirty: () => true });
    offOld();
    expect(getUnsavedSources()).toHaveLength(1);
  });

  it('treats a source that THROWS as dirty: a guard that fails open is not a guard', () => {
    registerUnsavedSource({
      id: 'broken',
      label: 'Broken form',
      isDirty: () => {
        throw new Error('boom');
      },
    });
    expect(getUnsavedSources()).toEqual([{ id: 'broken', label: 'Broken form' }]);
  });
});

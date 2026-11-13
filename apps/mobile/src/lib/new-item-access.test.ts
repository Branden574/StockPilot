import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { screenFunction } from './__fixtures__/screen-functions';

/**
 * NEW ITEM AND NEW BOOK ARE OFFERED ONLY TO A MEMBER WHO CAN CREATE ITEMS
 * (B124).
 *
 * The server refuses a create without items:create (InventoryService.create
 * and bulkCreateSizedVariants assert it). The Items and Books tabs drew their
 * plus for everyone, so a viewer filled in the whole form and was refused on
 * Save. The plus now shows only once the saved permissions are read and hold
 * items:create (screen-access.ts permissionAccess), and the form itself
 * refuses before anything is sent, with a plain sentence beside Create.
 */

const NOT_ALLOWED = 'You do not have permission to add items in this workspace.';

const code = (file: string) =>
  readFileSync(path.resolve(__dirname, '../..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

describe('the plus on Items and Books', () => {
  it.each([
    ['app/(drawer)/(tabs)/inventory.tsx', 'New item'],
    ['app/(drawer)/(tabs)/books.tsx', 'New book'],
  ])('%s draws "%s" only when items:create is held, once read', (file, label) => {
    const src = code(file);
    expect(src).toContain(
      "const canCreateItems = usePermissionAccess('items:create') === 'allowed';",
    );
    const chip = src.indexOf(`accessibilityLabel="${label}"`);
    expect(chip).toBeGreaterThan(-1);
    const gate = src.lastIndexOf('{canCreateItems ? (', chip);
    expect(gate).toBeGreaterThan(-1);
    // The gate opens right before this control: nothing closes in between.
    expect(src.slice(gate, chip)).not.toMatch(/\) : null\}/);
  });
});

describe('the New item form', () => {
  const FILE = 'app/item/new.tsx';

  function save(createAccess: 'unknown' | 'allowed' | 'denied') {
    const alert = vi.fn();
    const run = screenFunction<() => Promise<void>>(FILE, 'save', {
      busy: false,
      createAccess,
      ITEMS_CREATE_NOT_ALLOWED: NOT_ALLOWED,
      user: null,
      orgId: null,
      Alert: { alert },
    });
    return { run, alert };
  }

  it('refuses before anything is read or sent for a member who cannot create items', async () => {
    const { run, alert } = save('denied');
    await run();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith('Not allowed', NOT_ALLOWED);
  });

  it('goes on as before when they can, or while it is not known yet (the server decides)', async () => {
    for (const access of ['allowed', 'unknown'] as const) {
      const { run, alert } = save(access);
      await run();
      // The next check in save(): no account signed in.
      expect(alert).toHaveBeenCalledWith('Not signed in', 'Sign in again to add inventory.');
    }
  });

  it('says so beside Create, so the member knows before typing', () => {
    const src = code(FILE);
    expect(src).toContain("const createAccess = usePermissionAccess('items:create');");
    expect(src).toContain(
      "{createAccess === 'denied' ? ( <Body size={12.5} muted style={{ marginBottom: 8 }}> {ITEMS_CREATE_NOT_ALLOWED} </Body> ) : null}",
    );
  });

  it('the sentence is the shared one', async () => {
    vi.doMock('./nav-icons', () => ({ NAV_ICONS: {} }));
    const access = (await import('./screen-access')) as Record<string, unknown>;
    expect(access.ITEMS_CREATE_NOT_ALLOWED).toBe(NOT_ALLOWED);
  });
});

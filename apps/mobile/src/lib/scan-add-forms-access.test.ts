import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { screenFunction } from './__fixtures__/screen-functions';

/**
 * THE SCAN TAB OFFERS TO ADD AN UNKNOWN CODE ONLY TO A MEMBER WHO CAN CREATE
 * ITEMS (B124).
 *
 * A code that matches nothing in the workspace used to open the one-tap
 * "add this book" or "add this item" card for everyone, though the server
 * creates items only with items:create. Now the card opens only when the
 * member's saved access answers 'allowed' for items:create
 * (screen-access.ts permissionAccess); otherwise a plain "Not found" alert,
 * and no lookup is sent. The barcode handler is RUN here
 * (screen-functions.ts); the photo flow and the cards are pinned.
 */

const SCAN = 'app/(drawer)/(tabs)/scan.tsx';
const NOT_FOUND = { title: 'Not found', message: 'Nothing in this workspace has this code.' };

function barcode(canCreateItems: boolean, code: string) {
  const alert = vi.fn();
  const api = vi.fn(async () => ({ isbn: code, existingItem: null, metadata: null }));
  const setAddBook = vi.fn();
  const setAddItem = vi.fn();
  const setBusy = vi.fn();
  const reset = vi.fn();
  const run = screenFunction<(e: { data: string }) => Promise<void>>(SCAN, 'onBarCodeScanned', {
    busy: false,
    orgId: 'org-a',
    lastCode: null,
    setLastCode: () => undefined,
    setBusy,
    setScanning: () => undefined,
    parseSignToken: () => null,
    parseItemId: () => null,
    loadItemById: async () => null,
    loadItemByValue: async () => null,
    looksLikeIsbn: (d: string) => /^97[89]\d{10}$/.test(d),
    api,
    canCreateItems,
    SCAN_CODE_NOT_FOUND: NOT_FOUND,
    Alert: { alert },
    reset,
    setAddBook,
    setAddItem,
    showScannedItem: () => undefined,
  });
  return { run, alert, api, setAddBook, setAddItem, setBusy, reset };
}

describe('a scanned code that matches nothing', () => {
  it.each(['9780000000002', '012345678905'])(
    '%s: a member who can create items gets the lookup and the add card, as before',
    async (code) => {
      const h = barcode(true, code);
      await h.run({ data: code });
      expect(h.api).toHaveBeenCalledTimes(1);
      expect(h.setAddBook.mock.calls.length + h.setAddItem.mock.calls.length).toBe(1);
      expect(h.alert).not.toHaveBeenCalled();
    },
  );

  it.each(['9780000000002', '012345678905'])(
    '%s: a member who cannot gets a plain "Not found", no lookup and no card',
    async (code) => {
      const h = barcode(false, code);
      await h.run({ data: code });
      expect(h.api).not.toHaveBeenCalled();
      expect(h.setAddBook).not.toHaveBeenCalled();
      expect(h.setAddItem).not.toHaveBeenCalled();
      expect(h.alert).toHaveBeenCalledTimes(1);
      const [title, message, buttons] = h.alert.mock.calls[0] as [
        string,
        string,
        { onPress: () => void }[],
      ];
      expect([title, message]).toEqual([NOT_FOUND.title, NOT_FOUND.message]);
      buttons[0]!.onPress();
      expect(h.reset).toHaveBeenCalledTimes(1);
      expect(h.setBusy).toHaveBeenLastCalledWith(false);
    },
  );
});

describe('the wiring', () => {
  const src = () =>
    readFileSync(path.resolve(__dirname, '../..', SCAN), 'utf8').replace(/\s+/g, ' ');

  it("decides from the saved access for items:create, only when it answers 'allowed'", () => {
    expect(src()).toContain(
      "const canCreateItems = usePermissionAccess('items:create') === 'allowed';",
    );
  });

  it('the photo flow says "Not found" before any card for a member who cannot create items', () => {
    expect(src()).toContain(
      'if (!canCreateItems) { Alert.alert(SCAN_PHOTO_NOT_FOUND.title, SCAN_PHOTO_NOT_FOUND.message); return; }',
    );
  });

  it('the two cards are drawn only for a member who can create items', () => {
    expect(src()).toContain('{addBook && canCreateItems && (');
    expect(src()).toContain('{addItem && canCreateItems && (');
  });

  it('the words', async () => {
    const words = await import('./scan-add-gate');
    expect(words.SCAN_CODE_NOT_FOUND).toEqual(NOT_FOUND);
    expect(words.SCAN_PHOTO_NOT_FOUND).toEqual({
      title: 'Not found',
      message: 'Nothing in this workspace matches this photo.',
    });
  });
});

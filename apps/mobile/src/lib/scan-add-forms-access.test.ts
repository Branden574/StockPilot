import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { screenFunction } from './__fixtures__/screen-functions';

/**
 * THE SCAN TAB FINDS THIS WORKSPACE'S OWN ITEMS FOR EVERYONE, AND OFFERS TO
 * ADD AN UNKNOWN CODE ONLY WHERE A CREATE CONTROL IS OFFERED (B124).
 *
 * A scanned code is looked up in the workspace's own items for every member,
 * as before. When it matches nothing:
 *   - where the create control is offered (screen-access.ts
 *     createControlOffer): the book or product lookup and the one-tap add
 *     card, as before;
 *   - anywhere else: a plain "Not found", and neither lookup is sent (they
 *     exist to prefill a new item).
 * A lookup in the workspace that FAILED is said as a failed lookup, for
 * everyone and offline too, never as "Nothing in this workspace has this
 * code."
 *
 * A photo goes to the server's photo reader for everyone, as before. Where
 * the create control is offered, its result flows into the lookups and the
 * add cards as before. Anywhere else, the code the photo carried is looked up
 * in the workspace's own items: a match shows the item, a failed lookup is
 * said, and "Nothing in this workspace matches this photo." only when nothing
 * matched.
 *
 * The handlers are RUN here (screen-functions.ts).
 */

const SCAN = 'app/(drawer)/(tabs)/scan.tsx';
const CODE_NOT_FOUND = { title: 'Not found', message: 'Nothing in this workspace has this code.' };
const PHOTO_NOT_FOUND = {
  title: 'Not found',
  message: 'Nothing in this workspace matches this photo.',
};
const LOOKUP_FAILED = {
  title: 'Lookup failed',
  message:
    'This code could not be looked up in this workspace. Check your connection and try again.',
};
const FOUND = { id: 'item-1', name: 'Made-up item' };

type Lookup = typeof FOUND | null | 'ambiguous' | 'failed';

function barcode(canCreateItems: boolean, code: string, inWorkspace: Lookup = null) {
  const alert = vi.fn();
  const api = vi.fn(async () => ({ isbn: code, existingItem: null, metadata: null }));
  const setAddBook = vi.fn();
  const setAddItem = vi.fn();
  const setBusy = vi.fn();
  const reset = vi.fn();
  const showScannedItem = vi.fn();
  const loadItemByValue = vi.fn(async () => inWorkspace);
  const loadItemById = vi.fn(async () => inWorkspace);
  const run = screenFunction<(e: { data: string }) => Promise<void>>(SCAN, 'onBarCodeScanned', {
    busy: false,
    orgId: 'org-a',
    lastCode: null,
    setLastCode: () => undefined,
    setBusy,
    setScanning: () => undefined,
    parseSignToken: () => null,
    parseItemId: (d: string) => (d.startsWith('item:') ? d.slice(5) : null),
    loadItemById,
    loadItemByValue,
    looksLikeIsbn: (d: string) => /^97[89]\d{10}$/.test(d),
    api,
    canCreateItems,
    SCAN_CODE_NOT_FOUND: CODE_NOT_FOUND,
    SCAN_LOOKUP_FAILED: LOOKUP_FAILED,
    Alert: { alert },
    reset,
    setAddBook,
    setAddItem,
    showScannedItem,
  });
  return {
    run,
    alert,
    api,
    setAddBook,
    setAddItem,
    setBusy,
    reset,
    showScannedItem,
    loadItemByValue,
  };
}

describe('a scanned code', () => {
  it.each([true, false])(
    'in the workspace: shown, whoever scans it (create offered: %s); nothing else is sent',
    async (canCreate) => {
      const h = barcode(canCreate, '012345678905', FOUND);
      await h.run({ data: '012345678905' });
      expect(h.loadItemByValue).toHaveBeenCalledTimes(1);
      expect(h.showScannedItem).toHaveBeenCalledWith(FOUND);
      expect(h.api).not.toHaveBeenCalled();
      expect(h.alert).not.toHaveBeenCalled();
    },
  );

  it.each(['9780000000002', '012345678905'])(
    '%s matching nothing, create offered: the lookup and the add card, as before',
    async (code) => {
      const h = barcode(true, code);
      await h.run({ data: code });
      expect(h.api).toHaveBeenCalledTimes(1);
      expect(h.setAddBook.mock.calls.length + h.setAddItem.mock.calls.length).toBe(1);
      expect(h.alert).not.toHaveBeenCalled();
    },
  );

  it.each(['9780000000002', '012345678905'])(
    '%s matching nothing, create not offered: a plain "Not found", no lookup and no card',
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
      expect([title, message]).toEqual([CODE_NOT_FOUND.title, CODE_NOT_FOUND.message]);
      buttons[0]!.onPress();
      expect(h.reset).toHaveBeenCalledTimes(1);
      expect(h.setBusy).toHaveBeenLastCalledWith(false);
    },
  );

  it.each([
    [true, '9780000000002'],
    [false, '9780000000002'],
    [true, '012345678905'],
    [false, '012345678905'],
    [true, 'item:item-9'],
    [false, 'item:item-9'],
  ])(
    'a lookup in the workspace that failed (create offered: %s, %s): "Lookup failed", nothing else sent, no card',
    async (canCreate, code) => {
      const h = barcode(canCreate, code, 'failed');
      await h.run({ data: code });
      expect(h.api).not.toHaveBeenCalled();
      expect(h.setAddBook).not.toHaveBeenCalled();
      expect(h.setAddItem).not.toHaveBeenCalled();
      expect(h.showScannedItem).not.toHaveBeenCalled();
      expect(h.alert).toHaveBeenCalledTimes(1);
      const [title, message, buttons] = h.alert.mock.calls[0] as [
        string,
        string,
        { onPress: () => void }[],
      ];
      expect([title, message]).toEqual([LOOKUP_FAILED.title, LOOKUP_FAILED.message]);
      buttons[0]!.onPress();
      expect(h.reset).toHaveBeenCalledTimes(1);
      expect(h.setBusy).toHaveBeenLastCalledWith(false);
    },
  );
});

describe("the workspace's own lookup tells a failed read from an empty one", () => {
  function lookup(answer: { data: unknown; error: unknown }) {
    const q: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'or']) q[k] = () => q;
    q.is = async () => answer;
    return screenFunction<(v: string) => Promise<unknown>>(SCAN, 'loadItemByValue', {
      orgId: 'org-a',
      supabase: { from: () => q },
      sanitizeScanCode: (v: string) => v,
      resolveScanMatches: (rows: unknown[]) =>
        rows.length === 0 ? { kind: 'not_found' } : { kind: 'single', match: rows[0] },
      loadItemById: async () => FOUND,
      setPlacementChoices: () => undefined,
      withPlacementLabels: async (_o: string, rows: unknown[]) => rows,
    });
  }

  it('an error: failed', async () => {
    expect(await lookup({ data: null, error: { message: 'offline' } })('012345678905')).toBe(
      'failed',
    );
  });

  it('no rows: nothing found', async () => {
    expect(await lookup({ data: [], error: null })('012345678905')).toBeNull();
  });
});

describe('a photo', () => {
  function photo(canCreateItems: boolean, vision: Record<string, unknown>, inWorkspace: Lookup) {
    const alert = vi.fn();
    const calls: string[] = [];
    const api = vi.fn(async (p: string) => {
      calls.push(p.split('?')[0]!);
      if (p.startsWith('/api/v1/ai/identify-from-photo')) return vision;
      return { isbn: '9780000000002', existingItem: null, metadata: { title: 'Made-up' } };
    });
    const showScannedItem = vi.fn();
    const setAddBook = vi.fn();
    const setAddItem = vi.fn();
    const loadItemByValue = vi.fn(async () => inWorkspace);
    // The screen's own helper, RUN as well.
    const showPhotoMatchInWorkspace = screenFunction<(codes: string[]) => Promise<void>>(
      SCAN,
      'showPhotoMatchInWorkspace',
      {
        loadItemByValue,
        showScannedItem,
        Alert: { alert },
        SCAN_PHOTO_NOT_FOUND: PHOTO_NOT_FOUND,
        SCAN_LOOKUP_FAILED: LOOKUP_FAILED,
      },
    );
    const run = screenFunction<() => Promise<void>>(SCAN, 'captureCoverId', {
      showPhotoMatchInWorkspace,
      ImagePicker: {
        requestCameraPermissionsAsync: async () => ({ granted: true }),
        launchCameraAsync: async () => ({ canceled: false, assets: [{ uri: 'file:///x.jpg' }] }),
        MediaTypeOptions: { Images: 'Images' },
      },
      resizeForUpload: async () => ({ uri: 'file:///y.jpg', ext: 'jpg' }),
      FileSystem: { readAsStringAsync: async () => 'AAAA', EncodingType: { Base64: 'base64' } },
      api,
      canCreateItems,
      loadItemByValue,
      showScannedItem,
      setAddBook,
      setAddItem,
      setBusy: () => undefined,
      Alert: { alert },
      SCAN_PHOTO_NOT_FOUND: PHOTO_NOT_FOUND,
      SCAN_LOOKUP_FAILED: LOOKUP_FAILED,
      photoCodes: (v: { isbn?: string; upc?: string }) =>
        [v.upc, v.isbn].filter((c): c is string => Boolean(c)),
      reset: () => undefined,
    });
    return { run, alert, calls, showScannedItem, setAddBook, setAddItem, loadItemByValue };
  }

  it('in the workspace, create not offered: the item is shown; only the photo reader was asked', async () => {
    const h = photo(false, { kind: 'book', isbn: '9780000000002' }, FOUND);
    await h.run();
    expect(h.calls).toEqual(['/api/v1/ai/identify-from-photo']);
    expect(h.loadItemByValue).toHaveBeenCalledWith('9780000000002');
    expect(h.showScannedItem).toHaveBeenCalledWith(FOUND);
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.setAddBook).not.toHaveBeenCalled();
  });

  it('matching nothing, create not offered: "Nothing in this workspace matches this photo."', async () => {
    const h = photo(false, { kind: 'product', upc: '012345678905' }, null);
    await h.run();
    expect(h.calls).toEqual(['/api/v1/ai/identify-from-photo']);
    expect(h.alert).toHaveBeenCalledWith(PHOTO_NOT_FOUND.title, PHOTO_NOT_FOUND.message);
    expect(h.setAddItem).not.toHaveBeenCalled();
  });

  it('a lookup in the workspace that failed, create not offered: said as failed', async () => {
    const h = photo(false, { kind: 'book', isbn: '9780000000002' }, 'failed');
    await h.run();
    expect(h.alert).toHaveBeenCalledWith(LOOKUP_FAILED.title, LOOKUP_FAILED.message);
    expect(h.showScannedItem).not.toHaveBeenCalled();
  });

  it('no code on the photo, create not offered: nothing matches', async () => {
    const h = photo(false, { kind: 'product', title: 'Made-up' }, FOUND);
    await h.run();
    expect(h.loadItemByValue).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledWith(PHOTO_NOT_FOUND.title, PHOTO_NOT_FOUND.message);
  });

  it('create offered: the lookup and the card, as before', async () => {
    const h = photo(true, { kind: 'book', isbn: '9780000000002' }, null);
    await h.run();
    expect(h.calls).toEqual(['/api/v1/ai/identify-from-photo', '/api/v1/books/isbn-lookup']);
    expect(h.setAddBook).toHaveBeenCalledTimes(1);
    expect(h.alert).not.toHaveBeenCalled();
  });
});

describe('photoCodes: the code a photo carried', () => {
  it('a product: its UPC digits; a book: its ISBN as the server normalizes it; nothing otherwise', async () => {
    const { photoCodes } = await import('./scan-add-gate');
    expect(photoCodes({ kind: 'product', upc: '0 12345-67890 5' })).toEqual(['012345678905']);
    expect(photoCodes({ kind: 'product', upc: '1234' })).toEqual([]);
    expect(photoCodes({ kind: 'book', isbn: '978-0-00-000000-2' })).toEqual(['9780000000002']);
    expect(photoCodes({ kind: 'book', isbn: '0-00-000000-x' })).toEqual(['000000000X']);
    expect(photoCodes({ kind: 'book', isbn: 'none' })).toEqual([]);
    expect(photoCodes({ kind: 'book' })).toEqual([]);
  });
});

describe('the wiring', () => {
  const src = () =>
    readFileSync(path.resolve(__dirname, '../..', SCAN), 'utf8').replace(/\s+/g, ' ');

  it('the cards are drawn where a create control is offered, and an existing item always', () => {
    expect(src()).toContain('{addBook && (canCreateItems || addBook.existingItem) && (');
    expect(src()).toContain('{addItem && (canCreateItems || addItem.existingItem) && (');
  });

  it('the words', async () => {
    const words = await import('./scan-add-gate');
    expect(words.SCAN_CODE_NOT_FOUND).toEqual(CODE_NOT_FOUND);
    expect(words.SCAN_PHOTO_NOT_FOUND).toEqual(PHOTO_NOT_FOUND);
    expect(words.SCAN_LOOKUP_FAILED).toEqual(LOOKUP_FAILED);
  });
});

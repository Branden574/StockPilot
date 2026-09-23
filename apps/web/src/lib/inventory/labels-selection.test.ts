// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cleanLabelIds,
  LABELS_HANDOFF_TTL_MS,
  LABELS_SELECTION_PREFIX,
  labelsItemsHref,
  labelsSelectionHref,
  LABELS_URL_FALLBACK_MAX,
  readLabelsSelection,
  writeLabelsSelection,
} from './labels-selection';

/**
 * The Print labels handoff. The bulk bar used to put every selected id in the
 * URL: 443 ids made a 16,437-byte request line and Node answered 431 before
 * the app ran. The ids now stay in sessionStorage and the URL carries a key.
 */

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ids = (n: number) => Array.from({ length: n }, (_, i) => uuid(i));

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('labels selection handoff', () => {
  it('keeps the URL short however many items are selected', () => {
    const key = writeLabelsSelection(ids(5000));
    expect(key).not.toBeNull();
    const href = labelsSelectionHref(key!);
    expect(href).toBe(`/dashboard/inventory/labels?selection=${key}`);
    // A uuid key: 74 characters for 1 item or 5000.
    expect(href.length).toBe(74);
    expect(readLabelsSelection(key!)).toEqual(ids(5000));
  });

  it('reads back the ids in order, without duplicates or malformed values', () => {
    const key = writeLabelsSelection([uuid(2), uuid(1), uuid(2), 'nope', uuid(3)])!;
    expect(readLabelsSelection(key)).toEqual([uuid(2), uuid(1), uuid(3)]);
  });

  it('survives a reload: reading does not consume the selection', () => {
    const key = writeLabelsSelection(ids(3))!;
    expect(readLabelsSelection(key)).toEqual(ids(3));
    expect(readLabelsSelection(key)).toEqual(ids(3));
  });

  it('returns null for an unknown key, a malformed key or a corrupt entry', () => {
    expect(readLabelsSelection(uuid(9))).toBeNull();
    expect(readLabelsSelection('../../etc')).toBeNull();
    sessionStorage.setItem(`${LABELS_SELECTION_PREFIX}${uuid(8)}`, '{not json');
    expect(readLabelsSelection(uuid(8))).toBeNull();
  });

  it('keeps only the five newest selections in the tab', () => {
    const now = vi.spyOn(Date, 'now');
    const keys: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      now.mockReturnValue(1_000 + i);
      keys.push(writeLabelsSelection(ids(2))!);
    }
    const stored = Object.keys(sessionStorage).filter((k) => k.startsWith(LABELS_SELECTION_PREFIX));
    expect(stored).toHaveLength(5);
    expect(readLabelsSelection(keys[0]!)).toBeNull();
    expect(readLabelsSelection(keys[6]!)).toEqual(ids(2));
  });

  it('returns null instead of throwing when storage refuses the write', () => {
    const refusing = {
      length: 0,
      key: () => null,
      getItem: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    vi.stubGlobal('sessionStorage', refusing);
    vi.stubGlobal('localStorage', refusing);
    try {
      expect(writeLabelsSelection(ids(3))).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the ?items= fallback stays far below the 16 KB header limit at its maximum', () => {
    expect(labelsItemsHref(ids(LABELS_URL_FALLBACK_MAX)).length).toBe(3733);
  });

  it('cleanLabelIds drops non-strings and non-uuids', () => {
    const mixed = 'ABCDEF00-0000-4000-8000-00000000000A';
    expect(cleanLabelIds([uuid(1), 42, null, '', 'x', mixed, uuid(1)])).toEqual([uuid(1), mixed]);
  });
});

/**
 * Review of this branch: Print labels used to be a plain link, so cmd-click or
 * middle-click opened the sheet in a new tab and left the Items tab and its
 * selection as they were. sessionStorage belongs to one tab (and Chrome no
 * longer copies it into a tab opened from a link), so a ?selection= link
 * opened in a new tab found nothing. A short-lived copy in localStorage lets
 * the new tab pick the selection up.
 */
describe('labels selection in a new tab', () => {
  it('a new tab reads the selection from the handoff copy and keeps it for its own reloads', () => {
    const key = writeLabelsSelection(ids(443))!;
    // A new tab starts with an empty sessionStorage.
    sessionStorage.clear();

    expect(readLabelsSelection(key)).toEqual(ids(443));
    // Copied into the new tab's own storage, so a reload after the handoff
    // copy expires still works.
    localStorage.clear();
    expect(readLabelsSelection(key)).toEqual(ids(443));
  });

  it(`the handoff copy expires after ${LABELS_HANDOFF_TTL_MS / 60_000} minutes`, () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const key = writeLabelsSelection(ids(3))!;
    sessionStorage.clear();
    now.mockReturnValue(1_000_000 + LABELS_HANDOFF_TTL_MS + 1);
    expect(readLabelsSelection(key)).toBeNull();
    // And an expired copy is removed, not left behind.
    expect(Object.keys(localStorage).filter((k) => k.startsWith(LABELS_SELECTION_PREFIX))).toEqual(
      [],
    );
  });

  it('keeps at most five handoff copies, and drops expired ones on the next write', () => {
    const now = vi.spyOn(Date, 'now');
    for (let i = 0; i < 7; i += 1) {
      now.mockReturnValue(1_000 + i);
      writeLabelsSelection(ids(2));
    }
    const handoff = () =>
      Object.keys(localStorage).filter((k) => k.startsWith(LABELS_SELECTION_PREFIX));
    expect(handoff()).toHaveLength(5);
    now.mockReturnValue(1_000 + LABELS_HANDOFF_TTL_MS + 10);
    writeLabelsSelection(ids(2));
    expect(handoff()).toHaveLength(1);
  });
});

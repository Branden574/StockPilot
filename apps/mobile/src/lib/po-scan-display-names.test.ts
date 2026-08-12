import { PO_IMPORT_DISPLAY_NAME_MAX } from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

import { buildDisplayNames } from './po-scan-display-names';

/**
 * The `displayNames` array the mobile PO scan puts on the wire.
 *
 * The route (apps/web/src/app/api/po-imports/scan/route.ts) refuses a length
 * that does not match the import count with a 400 and NEVER guesses, so every
 * assertion below pins a literal array — the length AND the order — rather than
 * a property of one. The failure this file exists to catch is silent: a name
 * landing on the wrong purchase order looks exactly like the user's own typo.
 */

describe('buildDisplayNames — separate mode (one import per file)', () => {
  it('returns one entry per sent file, in file order', () => {
    expect(
      buildDisplayNames({
        names: ['August DC4 Books', 'Sept Uniforms', 'Lab supplies'],
        sentIndices: [0, 1, 2],
        mode: 'separate',
      }),
    ).toEqual(['August DC4 Books', 'Sept Uniforms', 'Lab supplies']);
  });

  it('a DROPPED MIDDLE FRAME takes its name with it — the surviving names stay on their own files', () => {
    // Frame 1 ("Sept Uniforms") failed to resize and was left out of the upload,
    // so two files travel. The array must be the names of THOSE two files.
    const built = buildDisplayNames({
      names: ['August DC4 Books', 'Sept Uniforms', 'Lab supplies'],
      sentIndices: [0, 2],
      mode: 'separate',
    });
    expect(built).toEqual(['August DC4 Books', 'Lab supplies']);
    // Spelled out because this is the whole point: NOT the captured order
    // truncated to length 2, which would name the second file "Sept Uniforms".
    expect(built).not.toEqual(['August DC4 Books', 'Sept Uniforms']);
    expect(built).toHaveLength(2);
  });

  it('a dropped FIRST frame does not slide name 0 onto the next file', () => {
    expect(
      buildDisplayNames({
        names: ['dropped', 'second', 'third'],
        sentIndices: [1, 2],
        mode: 'separate',
      }),
    ).toEqual(['second', 'third']);
  });

  it('drops leaving a single file send that FILE’s name, not index 0’s', () => {
    // The route downgrades `mode=separate` with one file to combined and then
    // expects exactly ONE entry. It must name the surviving frame.
    expect(
      buildDisplayNames({
        names: ['dropped page', 'the one that made it'],
        sentIndices: [1],
        mode: 'separate',
      }),
    ).toEqual(['the one that made it']);
  });

  it('keeps unnamed slots as null instead of shortening the array', () => {
    expect(
      buildDisplayNames({
        names: ['named', '', 'also named'],
        sentIndices: [0, 1, 2],
        mode: 'separate',
      }),
    ).toEqual(['named', null, 'also named']);
  });

  it('treats a missing slot (never typed into) as null', () => {
    expect(
      buildDisplayNames({ names: ['only the first'], sentIndices: [0, 1], mode: 'separate' }),
    ).toEqual(['only the first', null]);
  });
});

describe('buildDisplayNames — combined mode (pages of one PO)', () => {
  it('returns EXACTLY ONE entry for four files', () => {
    expect(
      buildDisplayNames({
        names: ['August DC4 Book Order'],
        sentIndices: [0, 1, 2, 3],
        mode: 'combined',
      }),
    ).toEqual(['August DC4 Book Order']);
  });

  it('ignores per-page names — the merged import takes the single name field', () => {
    expect(
      buildDisplayNames({
        names: ['the one name', 'page two', 'page three'],
        sentIndices: [0, 1, 2],
        mode: 'combined',
      }),
    ).toEqual(['the one name']);
  });

  it('still names the merged import when page one was dropped', () => {
    expect(
      buildDisplayNames({ names: ['the one name'], sentIndices: [1, 2], mode: 'combined' }),
    ).toEqual(['the one name']);
  });
});

describe('buildDisplayNames — when to omit the field entirely', () => {
  it('returns null when nothing was typed, so the request stays byte-identical to the old client', () => {
    expect(buildDisplayNames({ names: [], sentIndices: [0, 1], mode: 'separate' })).toBeNull();
    expect(
      buildDisplayNames({ names: ['', '', ''], sentIndices: [0, 1, 2], mode: 'separate' }),
    ).toBeNull();
    expect(buildDisplayNames({ names: [''], sentIndices: [0, 1], mode: 'combined' })).toBeNull();
  });

  it('returns null when whitespace-only is all that was typed', () => {
    expect(
      buildDisplayNames({ names: ['   ', '\t\n'], sentIndices: [0, 1], mode: 'separate' }),
    ).toBeNull();
  });

  it('returns null when no file survived the resize step', () => {
    expect(
      buildDisplayNames({ names: ['a name'], sentIndices: [], mode: 'separate' }),
    ).toBeNull();
    expect(
      buildDisplayNames({ names: ['a name'], sentIndices: [], mode: 'combined' }),
    ).toBeNull();
  });

  it('sends the array when even ONE slot is named', () => {
    expect(
      buildDisplayNames({ names: ['', 'named', ''], sentIndices: [0, 1, 2], mode: 'separate' }),
    ).toEqual([null, 'named', null]);
  });
});

describe('buildDisplayNames — normalization matches the shared schema', () => {
  it('trims, and a whitespace-only entry becomes null (never an empty string)', () => {
    expect(
      buildDisplayNames({
        names: ['  August DC4  ', '   '],
        sentIndices: [0, 1],
        mode: 'separate',
      }),
    ).toEqual(['August DC4', null]);
  });

  it('a name at the shared maximum length survives untouched', () => {
    const max = 'y'.repeat(PO_IMPORT_DISPLAY_NAME_MAX);
    expect(PO_IMPORT_DISPLAY_NAME_MAX).toBe(160);
    expect(
      buildDisplayNames({ names: [max], sentIndices: [0], mode: 'combined' }),
    ).toEqual([max]);
  });

  it('does NOT truncate or reject an over-long name — the server owns validation', () => {
    // The input's maxLength is a courtesy; a paste can still exceed it, and the
    // route must be the one that says no (with the real message) rather than
    // mobile silently shipping a mangled name.
    const tooLong = 'z'.repeat(PO_IMPORT_DISPLAY_NAME_MAX + 1);
    expect(
      buildDisplayNames({ names: [tooLong], sentIndices: [0], mode: 'combined' }),
    ).toEqual([tooLong]);
  });
});

// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import {
  attributeRecorder,
  headScriptSetGlass,
  neverClassicAfterGlass,
  neverGlass,
  readAttrHistory,
  readPaintFrames,
} from '../../tests/e2e/appearance/stage5a-paint';

/**
 * The first-paint recorder the stage 5 hard-load cases install as an init
 * script. An init script runs before the parser has put <html> into the
 * document, so the recorder is proved here on a document that has no
 * documentElement yet (the state Chromium hands it), and the readers are
 * proved to refuse a history that was never started.
 */

const XHTML = 'http://www.w3.org/1999/xhtml';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A document as an init script sees it: created, with no <html> in it yet. */
function emptyDocument(): Document {
  const doc = document.implementation.createHTMLDocument('x');
  doc.removeChild(doc.documentElement);
  expect(doc.documentElement).toBeNull();
  return doc;
}

describe('attributeRecorder', () => {
  it('starts without throwing on a document that has no <html> yet, and records once <html> arrives', async () => {
    const doc = emptyDocument();
    const target: { __lgAttrHistory?: (string | null)[] } = {};
    expect(() => attributeRecorder(doc, target)).not.toThrow();
    expect(target.__lgAttrHistory).toEqual([]);

    const html = doc.createElementNS(XHTML, 'html');
    doc.appendChild(html);
    await flush();
    expect(target.__lgAttrHistory).toEqual([null]);

    html.setAttribute('data-appearance', 'liquid-glass');
    await flush();
    expect(target.__lgAttrHistory).toEqual([null, null, 'liquid-glass']);
    expect(headScriptSetGlass(target.__lgAttrHistory!)).toBe(true);
  });

  it('reads the served value when <html> arrives already carrying it', async () => {
    const doc = emptyDocument();
    const target: { __lgAttrHistory?: (string | null)[] } = {};
    attributeRecorder(doc, target);
    const html = doc.createElementNS(XHTML, 'html');
    html.setAttribute('data-appearance', 'classic');
    doc.appendChild(html);
    await flush();
    expect(target.__lgAttrHistory).toEqual(['classic']);
    expect(neverGlass(target.__lgAttrHistory!)).toBe(true);
  });

  it('starts at once when <html> already exists, and sees a glass value set and removed in one task', async () => {
    const doc = document.implementation.createHTMLDocument('x');
    const target: { __lgAttrHistory?: (string | null)[] } = {};
    attributeRecorder(doc, target);
    expect(target.__lgAttrHistory).toEqual([null]);
    doc.documentElement.setAttribute('data-appearance', 'liquid-glass');
    doc.documentElement.setAttribute('data-appearance', 'classic');
    await flush();
    expect(target.__lgAttrHistory).toContain('liquid-glass');
    expect(neverGlass(target.__lgAttrHistory!)).toBe(false);
  });
});

describe('the readers refuse a recorder that never started', () => {
  it('readAttrHistory throws on undefined or an empty history', () => {
    expect(() => readAttrHistory(undefined)).toThrow(/never started/u);
    expect(() => readAttrHistory([])).toThrow(/never started/u);
    expect(readAttrHistory(['classic'])).toEqual(['classic']);
  });

  it('readPaintFrames throws when no frame was seen', () => {
    expect(() => readPaintFrames(undefined)).toThrow(/no frame/u);
    expect(() => readPaintFrames({ count: 0, glass: [] })).toThrow(/no frame/u);
    expect(readPaintFrames({ count: 3, glass: [] })).toEqual({ count: 3, glass: [] });
  });

  it('neverGlass is false on an empty history, so a dead recorder cannot read as "no glass"', () => {
    expect(neverGlass([])).toBe(false);
    expect(neverGlass(['classic', 'classic', 'classic'])).toBe(true);
    expect(neverGlass([null, null, 'liquid-glass'])).toBe(false);
  });
});

describe('the history rules', () => {
  it('headScriptSetGlass: served glass, or the head script as the first write', () => {
    expect(headScriptSetGlass(['liquid-glass'])).toBe(true);
    expect(headScriptSetGlass([null, null, 'liquid-glass'])).toBe(true);
    expect(headScriptSetGlass([null, null, 'classic', 'classic', 'liquid-glass'])).toBe(false);
    expect(headScriptSetGlass([])).toBe(false);
  });

  it('neverClassicAfterGlass: once glass, always glass', () => {
    expect(neverClassicAfterGlass([null, null, 'liquid-glass'])).toBe(true);
    expect(neverClassicAfterGlass(['liquid-glass', 'liquid-glass', 'classic'])).toBe(false);
    expect(neverClassicAfterGlass([])).toBe(false);
  });
});

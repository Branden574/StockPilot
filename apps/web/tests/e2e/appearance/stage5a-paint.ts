/**
 * The first-paint recorders the stage 5 hard-load cases install as init
 * scripts (plan 8.2 cases 6, 12 and the MFA sign-in), and the rules that
 * read what they recorded. No Playwright import, so the unit tests in
 * src/test/stage5a-paint.test.ts run the very functions the lab runs.
 *
 * An init script runs when the document has been created but before the
 * parser has put <html> into it: document.documentElement is still null
 * there. A recorder that reads documentElement at once throws, records
 * nothing, and every later check then reads an empty history (a dead
 * recorder that looks like "no glass"). attributeRecorder therefore waits
 * for <html> (a childList observer on the document) before it reads the
 * attribute, and the readers refuse a history that was never started.
 */

export type AttrHistory = (string | null)[];

export interface PaintFrames {
  /** Animation frames seen while <body> existed. */
  count: number;
  /** One line per frame that would have drawn glass. */
  glass: string[];
}

interface RecorderWindow {
  __lgAttrHistory?: AttrHistory;
  __lgPaintFrames?: PaintFrames;
}

/**
 * Records every value data-appearance takes on <html> from the moment <html>
 * exists: its first value, then (attributeOldValue) the value each change
 * replaced and the value after it, so a value set and removed within one
 * task is still seen. Install as an init script (it runs with no argument;
 * the parameters exist for the unit tests).
 */
export function attributeRecorder(
  doc: Document = document,
  target: object = window,
  Observer: typeof MutationObserver = MutationObserver,
): void {
  const w = target as RecorderWindow;
  const history: AttrHistory = [];
  w.__lgAttrHistory = history;
  const watch = (html: Element) => {
    history.push(html.getAttribute('data-appearance'));
    new Observer((records) => {
      for (const record of records) {
        history.push(record.oldValue, html.getAttribute('data-appearance'));
      }
    }).observe(html, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-appearance'],
    });
  };
  if (doc.documentElement) {
    watch(doc.documentElement);
    return;
  }
  const waiter = new Observer(() => {
    const html = doc.documentElement;
    if (!html) return;
    waiter.disconnect();
    watch(html);
  });
  waiter.observe(doc, { childList: true });
}

/**
 * The frame probe: on every animation frame while <body> exists, whether the
 * page would draw glass. Glass draws its scene on body::before (scene.css:
 * `:root[data-appearance='liquid-glass'] body::before`, the only body::before
 * in the app), so a frame draws glass when body::before has content or <html>
 * carries the glass attribute. This is the automated reading of the frames
 * the screencast saves for a person. Install as an init script.
 */
export function paintFrameRecorder(): void {
  const w = window as unknown as RecorderWindow;
  const frames: PaintFrames = { count: 0, glass: [] };
  w.__lgPaintFrames = frames;
  const tick = () => {
    const body = document.body;
    if (body) {
      frames.count += 1;
      const attr = document.documentElement.getAttribute('data-appearance');
      const before = getComputedStyle(body, '::before').content;
      if (attr === 'liquid-glass' || (before !== 'none' && before !== 'normal')) {
        frames.glass.push(`frame ${frames.count}: attribute ${attr}, body::before ${before}`);
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Reads a recorded history; a recorder that never started is an error, never "no glass". */
export function readAttrHistory(value: unknown): AttrHistory {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error(
      'The data-appearance recorder never started on this page (no history): install it with recordAttributeHistory before the navigation.',
    );
  }
  return value as AttrHistory;
}

/** Reads the frame probe; a probe that never saw a frame is an error. */
export function readPaintFrames(value: unknown): PaintFrames {
  const frames = value as PaintFrames | undefined;
  if (!frames || typeof frames.count !== 'number' || frames.count < 1) {
    throw new Error(
      'The frame probe saw no frame on this page: install it with recordPaintFrames before the navigation.',
    );
  }
  return frames;
}

/** The head script set glass before anything else touched the attribute. */
export function headScriptSetGlass(history: AttrHistory): boolean {
  return history[0] === 'liquid-glass' || (history[0] === null && history[2] === 'liquid-glass');
}

/** The attribute never returned to classic after it first showed glass. */
export function neverClassicAfterGlass(history: AttrHistory): boolean {
  const first = history.indexOf('liquid-glass');
  return first >= 0 && history.slice(first).every((value) => value === 'liquid-glass');
}

/** No glass value at any point of a recorded (non-empty) history. */
export function neverGlass(history: AttrHistory): boolean {
  return history.length >= 1 && !history.includes('liquid-glass');
}

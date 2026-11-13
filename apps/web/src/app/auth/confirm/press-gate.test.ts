import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PRESS_GATE_FORM_ATTR,
  PRESS_GATE_PASSED_FIELD,
  PRESS_GATE_PASSED_VALUE,
  PRESS_GATE_QUIET_MS,
  PRESS_GATE_SCRIPT,
  PRESS_GATE_SEE_ATTR,
} from './press-gate';

/**
 * Security invariant (docket S25, INV-E5): a press on the confirmation page
 * counts only after the page has been in front of the person, quiet, for a
 * second, and only once every address it names has been on screen through
 * such a second: wholly, or, for one too tall for the screen, every one of
 * its lines.
 *
 * The page names the account a link is for before anyone presses, but a
 * known window-swap trick (DoubleClickjacking, published December 2024) gets
 * the press without the person ever seeing the page: another site asks for a
 * double-click, loads its own link in the person's tab behind a popup, and
 * closes the popup on the first press, so the second lands on the button.
 * Framing headers do not stop it (the page is never framed). Another site
 * also picks the window's size and where the page opens scrolled to (a
 * fragment), so the button can be on screen while the line naming the
 * account is not, or a long address it chose fills a tiny window with a few
 * of its characters (S25 review). The inline gate cancels any submit until
 * the page has been visible, with focus or the pointer over it, for a whole
 * second with no pointerdown, keydown, scroll or resize, and until each
 * address has been on screen through such a second. These run the exact
 * script the page carries (route.test.ts pins that it does, and that the page
 * marks its addresses and gives no element an id a link could scroll to):
 *   - a submit in the first second is cancelled, and one after it goes through;
 *   - a press or a key while not armed restarts the second (a rapid-click or
 *     rapid-key lure keeps the button off);
 *   - losing focus or visibility disarms, and coming back starts again;
 *   - the swap itself: focus arriving with a press right behind it is
 *     cancelled, with or without a focus event, and a page the pointer armed
 *     behind the popup is disarmed when the pointer leaves for it;
 *   - an address scrolled off screen, or on screen for less than the second,
 *     has not been seen; once it has, scrolling on to the button keeps the
 *     gate armed, so a small screen is not locked out;
 *   - an address taller than the screen counts once each of its lines has
 *     been on screen, a screenful at a time, so a large zoom is not locked
 *     out either; the few lines a tiny window shows of it, a line cut by an
 *     edge, or lines seen before it wrapped again, do not count;
 *   - a page that never gets focus arms after pointer movement and a quiet
 *     second, so no browser is locked out;
 *   - the button is disabled in the markup, so it takes no press where this
 *     script has not run; the script enables it as its last step, with every
 *     listener in place, and shows it aria-disabled until armed;
 *   - the field POST asks for (route.test.ts) is on the form only for a press
 *     the gate let through.
 */

let focused = true;
let visibility: DocumentVisibilityState = 'visible';

function runGate(): { form: HTMLFormElement; button: HTMLButtonElement } {
  // The page carries the script inline, right after the form: run it the same
  // way, once, against this document.
  new Function(PRESS_GATE_SCRIPT)();
  return {
    form: document.querySelector(`form[${PRESS_GATE_FORM_ATTR}]`) as HTMLFormElement,
    button: document.querySelector('button') as HTMLButtonElement,
  };
}

/** The form alone, as the page sends it (its button disabled), before any script has run. */
function mountMarkup(): void {
  document.body.innerHTML = `<main>
    <form method="post" action="/auth/confirm" ${PRESS_GATE_FORM_ATTR}>
      <input type="hidden" name="type" value="magiclink">
      <button type="submit" class="btn" disabled>Continue to StockPilot</button>
    </form>
  </main>`;
}

/** The form alone: a page that names no address (a link written before S25's first release). */
function mount(): { form: HTMLFormElement; button: HTMLButtonElement } {
  mountMarkup();
  return runGate();
}

/** The gate's field on the form, as POST would receive it. */
function gateFields(form: HTMLFormElement): string[] {
  return [
    ...form.querySelectorAll<HTMLInputElement>(`input[name="${PRESS_GATE_PASSED_FIELD}"]`),
  ].map((input) => `${input.type}:${input.value}`);
}

/**
 * A real click on the button, as a pointer or the keyboard makes it: the
 * browser fires submit only when the button is not disabled. Returns how many
 * submits the form saw (each is then cancelled here, after the gate's own
 * listener has run, since this document cannot navigate).
 */
function clickCounts(form: HTMLFormElement, button: HTMLButtonElement): number {
  let submits = 0;
  const count = (event: Event) => {
    submits += 1;
    event.preventDefault();
  };
  form.addEventListener('submit', count);
  button.click();
  form.removeEventListener('submit', count);
  return submits;
}

/**
 * The page as /auth/confirm renders it for a signed link: the line naming the
 * account and, with `notice`, the note naming the account this browser is
 * signed in as too, each address marked, above the form.
 */
function mountPage(notice = false): {
  form: HTMLFormElement;
  button: HTMLButtonElement;
  marks: HTMLElement[];
} {
  const see = (email: string) => `<span class="addr" ${PRESS_GATE_SEE_ATTR}>${email}</span>`;
  document.body.innerHTML = `<main>
    <div class="brand">StockPilot</div>
    <h1>Sign in</h1>
    <p class="recipient">This link signs in as ${see('person@example.com')}. If that is not your email address, close this page.</p>
    ${notice ? `<p class="note">You're signed in as ${see('member@example.com')} on this browser. Continuing signs you in as ${see('person@example.com')} instead.</p>` : ''}
    <p>This link works once. Press the button to continue.</p>
    <form method="post" action="/auth/confirm" ${PRESS_GATE_FORM_ATTR}>
      <input type="hidden" name="type" value="magiclink">
      <button type="submit" class="btn" disabled>Continue to StockPilot</button>
    </form>
  </main>`;
  const marks = [...document.querySelectorAll<HTMLElement>(`[${PRESS_GATE_SEE_ATTR}]`)];
  return { ...runGate(), marks };
}

/** How far the page is scrolled down, in CSS pixels. */
let scrollY = 0;

/** The window's inner size, as another site can pick it for a popup. */
function windowSize(width: number, height: number) {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(height);
}

/**
 * Lays an element out at a place on the page (its box moves with the scroll).
 * With `line`, it is an address wrapped over lines that tall, as a very large
 * zoom or a very small window wraps it: each line is one of its client rects,
 * as a browser gives them for an inline element. The box is read on every
 * call, so a test can change it (the address wraps again).
 */
function layOut(
  el: Element,
  box: { top: number; height: number; left?: number; width?: number; line?: number },
): void {
  const rect = (top: number, height: number): DOMRect => {
    const left = box.left ?? 40;
    const width = box.width ?? 240;
    return {
      x: left,
      y: top,
      top,
      bottom: top + height,
      left,
      right: left + width,
      width,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() =>
    rect(box.top - scrollY, box.height),
  );
  vi.spyOn(el, 'getClientRects').mockImplementation(() => {
    const line = box.line ?? box.height;
    const lines: DOMRect[] = [];
    for (let y = 0; y < box.height; y += line) {
      lines.push(rect(box.top - scrollY + y, Math.min(line, box.height - y)));
    }
    return lines as unknown as DOMRectList;
  });
}

/** Scrolls the page, by the person or by a fragment: the browser fires scroll. */
function scrollTo(y: number) {
  scrollY = y;
  document.dispatchEvent(new Event('scroll'));
}

/** A submit as the browser fires it; true when nothing cancelled it. */
function submit(form: HTMLFormElement): boolean {
  return form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

/** A whole press: the pointer goes down on the button, then the form submits. */
function press(form: HTMLFormElement, button: HTMLButtonElement): boolean {
  button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  return submit(form);
}

async function wait(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  focused = true;
  visibility = 'visible';
  scrollY = 0;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  document.body.innerHTML = '';
});

describe('the press gate', () => {
  it('cancels a submit in the first second after the page opens, and lets one through after it', async () => {
    const { form, button } = mount();
    expect(PRESS_GATE_QUIET_MS).toBe(1000);
    expect(submit(form)).toBe(false);
    await wait(PRESS_GATE_QUIET_MS - 1);
    expect(submit(form)).toBe(false);
    // The cancelled submit started the second again.
    await wait(PRESS_GATE_QUIET_MS);
    expect(press(form, button)).toBe(true);
  });

  it('enables the button the markup disabled, and shows it aria-disabled until armed', async () => {
    const { button } = mount();
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(button.disabled).toBe(false);
  });

  it('a press while not armed restarts the second, so a rapid-click lure keeps the button off', async () => {
    const { form, button } = mount();
    for (let i = 0; i < 6; i++) {
      await wait(PRESS_GATE_QUIET_MS - 100);
      expect(press(form, button), `press ${i}`).toBe(false);
    }
    // Still off just short of a quiet second after the last press...
    await wait(PRESS_GATE_QUIET_MS - 100);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // ...and on once the second has passed.
    await wait(100);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(press(form, button)).toBe(true);
  });

  it('a pointerdown while not armed restarts the second; once armed, a key or a pointerdown does not take it back', async () => {
    const { form } = mount();
    await wait(900);
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await wait(900);
    expect(submit(form)).toBe(false);
    await wait(PRESS_GATE_QUIET_MS);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(submit(form)).toBe(true);
    // Armed: the person's own pointerdown and keys do not take it back.
    const { form: again, button } = mount();
    await wait(PRESS_GATE_QUIET_MS);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(press(again, button)).toBe(true);
  });

  it('a run of keys while not armed keeps the button off (the rapid-click lure, by keyboard)', async () => {
    const { form, button } = mount();
    // The person is kept pressing Tab across the swap: each key comes before
    // the second is up, so the second starts again each time.
    for (let i = 0; i < 5; i++) {
      await wait(PRESS_GATE_QUIET_MS - 100);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    }
    await wait(PRESS_GATE_QUIET_MS - 100);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // Tab has reached the only button, and Space submits it: cancelled.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(submit(form)).toBe(false);
    // Nobody is locked out: a quiet second later the press goes through.
    await wait(PRESS_GATE_QUIET_MS);
    expect(submit(form)).toBe(true);
  });

  it('losing focus disarms; coming back starts the second again', async () => {
    const { form, button } = mount();
    await wait(PRESS_GATE_QUIET_MS);
    focused = false;
    window.dispatchEvent(new Event('blur'));
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(submit(form)).toBe(false);
    focused = true;
    window.dispatchEvent(new Event('focus'));
    await wait(PRESS_GATE_QUIET_MS - 1);
    expect(submit(form)).toBe(false);
    await wait(PRESS_GATE_QUIET_MS);
    expect(press(form, button)).toBe(true);
  });

  it('losing focus part-way through the second stops it from arming', async () => {
    const { form } = mount();
    await wait(500);
    focused = false;
    window.dispatchEvent(new Event('blur'));
    await wait(PRESS_GATE_QUIET_MS * 3);
    expect(submit(form)).toBe(false);
  });

  it('a timer that fires while the page has silently lost focus does not arm', async () => {
    const { form, button } = mount();
    focused = false;
    await wait(PRESS_GATE_QUIET_MS * 2);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(submit(form)).toBe(false);
  });

  it('visibility turning hidden disarms; visible again starts the second again', async () => {
    const { form, button } = mount();
    await wait(PRESS_GATE_QUIET_MS);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(submit(form)).toBe(false);
    await wait(PRESS_GATE_QUIET_MS * 2);
    expect(submit(form)).toBe(false);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await wait(PRESS_GATE_QUIET_MS);
    expect(press(form, button)).toBe(true);
  });

  it('a page opened in a background tab arms only after it is shown', async () => {
    visibility = 'hidden';
    const { form, button } = mount();
    await wait(PRESS_GATE_QUIET_MS * 5);
    expect(submit(form)).toBe(false);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await wait(PRESS_GATE_QUIET_MS);
    expect(press(form, button)).toBe(true);
  });

  it('back-forward cache: leaving disarms, and pageshow starts the second again', async () => {
    const { form, button } = mount();
    await wait(PRESS_GATE_QUIET_MS);
    window.dispatchEvent(new Event('pagehide'));
    expect(button.getAttribute('aria-disabled')).toBe('true');
    window.dispatchEvent(new Event('pageshow'));
    expect(submit(form)).toBe(false);
    await wait(PRESS_GATE_QUIET_MS);
    expect(press(form, button)).toBe(true);
  });
});

describe('the window swap (DoubleClickjacking)', () => {
  it('the page loads behind a popup, the popup closes on the first click, the second click lands: cancelled', async () => {
    focused = false; // the popup in front has focus
    const { form, button } = mount();
    // However long the popup stays up, the page behind it never arms.
    await wait(PRESS_GATE_QUIET_MS * 10);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // First click: the popup closes itself and the person's tab comes back.
    focused = true;
    window.dispatchEvent(new Event('focus'));
    await wait(120);
    // Second click of the double-click, on the button.
    expect(press(form, button)).toBe(false);
  });

  it('the same, in a browser that sends no focus event when the popup closes', async () => {
    focused = false;
    const { form, button } = mount();
    await wait(PRESS_GATE_QUIET_MS * 10);
    focused = true;
    await wait(120);
    expect(press(form, button)).toBe(false);
    await wait(120);
    expect(press(form, button)).toBe(false);
  });

  it('pointer movement over the page behind the popup, then the swap: cancelled', async () => {
    focused = false;
    const { form, button } = mount();
    document.dispatchEvent(new Event('pointermove', { bubbles: true }));
    await wait(PRESS_GATE_QUIET_MS * 2);
    // The pointer goes onto the popup (leaving this window), the popup closes.
    document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
    focused = true;
    window.dispatchEvent(new Event('focus'));
    await wait(120);
    expect(press(form, button)).toBe(false);
  });

  it('armed by the pointer behind the popup, the pointer leaves for the popup, which closes with no focus event: cancelled', async () => {
    focused = false; // the popup in front has focus
    const { form, button } = mount();
    // The pointer rests on the page behind the popup long enough to arm it.
    document.dispatchEvent(new Event('pointermove', { bubbles: true }));
    await wait(PRESS_GATE_QUIET_MS * 2);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    // It leaves this window for the popup (no element of this page under it)...
    document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // ...whose first click closes it. This browser sends no focus event.
    focused = true;
    await wait(120);
    // The second click lands on the button.
    expect(press(form, button)).toBe(false);
  });

  it('a person who then reads the page and presses after a second gets through', async () => {
    focused = false;
    const { form, button } = mount();
    focused = true;
    window.dispatchEvent(new Event('focus'));
    await wait(120);
    expect(press(form, button)).toBe(false);
    await wait(PRESS_GATE_QUIET_MS);
    expect(press(form, button)).toBe(true);
  });
});

describe('every address the page names must have been on screen (S25 review)', () => {
  it("the reviewer's case: a 360x150 window opened at the form, the button on screen and the address above it, never arms", async () => {
    windowSize(360, 150);
    const { form, button, marks } = mountPage();
    layOut(marks[0]!, { top: 160, height: 21 });
    // Where an old link's #confirm-form put the page, in Chromium, Firefox
    // and WebKit alike (the button on screen, the line naming the account
    // above it): today's page gives no element an id, so any scroll that
    // gets it there, a text fragment or the window's own, counts the same.
    scrollTo(244);
    await wait(PRESS_GATE_QUIET_MS * 5);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(press(form, button)).toBe(false);
    await wait(PRESS_GATE_QUIET_MS * 5);
    expect(press(form, button)).toBe(false);
    // The person scrolls up to the line and reads it: armed after a quiet
    // second, and it stays armed while they scroll back down to the button.
    scrollTo(120);
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    scrollTo(244);
    expect(press(form, button)).toBe(true);
  });

  it('an address on screen for less than the second, then scrolled away (a fragment scrolling after load), has not been seen', async () => {
    windowSize(1024, 768);
    const { form, button, marks } = mountPage();
    layOut(marks[0]!, { top: 160, height: 21 });
    await wait(PRESS_GATE_QUIET_MS - 100);
    scrollTo(600);
    await wait(PRESS_GATE_QUIET_MS * 3);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(submit(form)).toBe(false);
  });

  it('a scroll starts the second again: an address scrolled onto the screen just before it is up counts only after a whole second there', async () => {
    windowSize(360, 150);
    const { form, button, marks } = mountPage();
    layOut(marks[0]!, { top: 160, height: 21 });
    await wait(PRESS_GATE_QUIET_MS - 100);
    scrollTo(100);
    await wait(200);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await wait(PRESS_GATE_QUIET_MS - 200);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(press(form, button)).toBe(true);
  });

  it('a resize or zoom starts the second again the same way', async () => {
    windowSize(360, 150);
    const { form, button, marks } = mountPage();
    layOut(marks[0]!, { top: 160, height: 21 });
    await wait(PRESS_GATE_QUIET_MS - 100);
    // A rotated phone, or a zoom out: the address comes on screen.
    windowSize(1024, 768);
    window.dispatchEvent(new Event('resize'));
    await wait(200);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await wait(PRESS_GATE_QUIET_MS - 200);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(press(form, button)).toBe(true);
  });

  it('an address only partly on screen, at any edge, has not been seen', async () => {
    windowSize(360, 150);
    for (const box of [
      { top: 140, height: 21 },
      { top: -10, height: 21 },
      { top: 60, height: 21, left: -30 },
      { top: 60, height: 21, left: 200, width: 240 },
    ]) {
      const { form, button, marks } = mountPage();
      layOut(marks[0]!, box);
      await wait(PRESS_GATE_QUIET_MS * 3);
      expect(button.getAttribute('aria-disabled'), JSON.stringify(box)).toBe('true');
      expect(submit(form), JSON.stringify(box)).toBe(false);
    }
  });

  it('each address must have been seen: on a small screen, one after another, each through a quiet second', async () => {
    windowSize(360, 150);
    // The line's address, then the note's two.
    const { form, button, marks } = mountPage(true);
    expect(marks).toHaveLength(3);
    layOut(marks[0]!, { top: 60, height: 21 });
    layOut(marks[1]!, { top: 300, height: 21 });
    layOut(marks[2]!, { top: 360, height: 21 });
    await wait(PRESS_GATE_QUIET_MS * 3);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(submit(form)).toBe(false);
    // The note's addresses come on screen, and the line's leaves it.
    scrollTo(250);
    await wait(PRESS_GATE_QUIET_MS - 1);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await wait(1);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(press(form, button)).toBe(true);
  });

  it('a long address another site chose, in a tiny window it opened at a text fragment inside the address, never arms: a few characters filling the window are not the address', async () => {
    // The other site's own account, under a 60-character address. In a
    // 100x100 window it wraps one character a line, 22 px each (measured in
    // Chromium, Firefox and WebKit), and a text fragment inside it opens the
    // window on its middle: a few characters fill the screen.
    windowSize(100, 100);
    const { form, button, marks } = mountPage();
    layOut(marks[0]!, { top: 280, height: 1320, left: 43, width: 8, line: 22 });
    scrollTo(504);
    await wait(PRESS_GATE_QUIET_MS * 5);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // Its lure: Tab to the button, then Enter.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(submit(form)).toBe(false);
    await wait(PRESS_GATE_QUIET_MS * 5);
    expect(submit(form)).toBe(false);
  });

  it('an address taller than the screen counts once each of its lines has been on screen, a screenful at a time, so a very large zoom locks nobody out', async () => {
    windowSize(130, 200);
    const { form, button, marks } = mountPage();
    // Wrapped a few characters a line: 12 lines of 22 px, taller than the window.
    layOut(marks[0]!, { top: 100, height: 264, left: 43, width: 40, line: 22 });
    await wait(PRESS_GATE_QUIET_MS * 3);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // Its first eight lines.
    scrollTo(90);
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // The rest of it.
    scrollTo(200);
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    scrollTo(900);
    expect(press(form, button)).toBe(true);
  });

  it('a line never wholly on screen in between keeps the button off until it has been', async () => {
    windowSize(130, 100);
    const { form, button, marks } = mountPage();
    // 10 lines of 22 px.
    layOut(marks[0]!, { top: 100, height: 220, left: 43, width: 40, line: 22 });
    // Lines 1-4, then 6-9, then 10: the fifth is never on screen.
    for (const y of [100, 210, 290]) {
      scrollTo(y);
      await wait(PRESS_GATE_QUIET_MS);
      expect(button.getAttribute('aria-disabled'), String(y)).toBe('true');
    }
    expect(submit(form)).toBe(false);
    scrollTo(180);
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(press(form, button)).toBe(true);
  });

  it('a line seen only in halves, its top on one screen and its bottom on the next, has not been seen', async () => {
    windowSize(130, 100);
    const { form, button, marks } = mountPage();
    // Three lines of 22 px, at 60-82, 82-104 and 104-126: the second is cut by the bottom edge.
    layOut(marks[0]!, { top: 60, height: 66, left: 43, width: 40, line: 22 });
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // Now the second is cut by the top edge, and the third is whole.
    scrollTo(90);
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(submit(form)).toBe(false);
    scrollTo(50);
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('false');
  });

  it('lines on screen only while the page was not in front do not count', async () => {
    windowSize(130, 200);
    const { form, button, marks } = mountPage();
    // 12 lines of 22 px; its first 8 come on screen, and a popup takes the
    // front part-way through the second, with no blur event.
    layOut(marks[0]!, { top: 100, height: 264, left: 43, width: 40, line: 22 });
    scrollTo(90);
    await wait(PRESS_GATE_QUIET_MS - 500);
    focused = false;
    await wait(PRESS_GATE_QUIET_MS * 3);
    // The page comes back to the front showing only the rest of it.
    scrollTo(200);
    focused = true;
    window.dispatchEvent(new Event('focus'));
    await wait(PRESS_GATE_QUIET_MS * 3);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(submit(form)).toBe(false);
  });

  it('when the address wraps again (the window is resized), the lines seen in the old wrapping do not count', async () => {
    windowSize(130, 200);
    const { form, button, marks } = mountPage();
    const box = { top: 100, height: 264, left: 43, width: 40, line: 22 };
    layOut(marks[0]!, box);
    // The first 8 of its 12 lines.
    scrollTo(90);
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // A narrower window wraps it again over 16 lines: the first 8 of these
    // are not the 8 seen. Its last 8 come on screen.
    Object.assign(box, { height: 352, width: 30 });
    windowSize(110, 200);
    window.dispatchEvent(new Event('resize'));
    scrollTo(260);
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(submit(form)).toBe(false);
    // Its first 8 lines, in this wrapping.
    scrollTo(90);
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(press(form, button)).toBe(true);
  });

  it('an address on screen only while the page was not in front has not been seen', async () => {
    windowSize(360, 150);
    const { form, button, marks } = mountPage();
    layOut(marks[0]!, { top: 60, height: 21 });
    // A popup takes the front part-way through the second, with no blur event:
    // the address sits on screen in a window nobody is looking at.
    await wait(PRESS_GATE_QUIET_MS - 500);
    focused = false;
    await wait(PRESS_GATE_QUIET_MS * 3);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // The page comes back to the front scrolled to the button.
    scrollTo(244);
    focused = true;
    window.dispatchEvent(new Event('focus'));
    await wait(PRESS_GATE_QUIET_MS * 3);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(submit(form)).toBe(false);
  });

  it('seen once is seen: leaving and coming back needs only the quiet second, wherever the page is scrolled', async () => {
    windowSize(360, 150);
    const { form, button, marks } = mountPage();
    layOut(marks[0]!, { top: 60, height: 21 });
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    scrollTo(244);
    focused = false;
    window.dispatchEvent(new Event('blur'));
    expect(button.getAttribute('aria-disabled')).toBe('true');
    focused = true;
    window.dispatchEvent(new Event('focus'));
    expect(submit(form)).toBe(false);
    await wait(PRESS_GATE_QUIET_MS);
    expect(press(form, button)).toBe(true);
  });
});

describe('nothing can be pressed where the script has not run', () => {
  it('the page as sent, before its script has run (it is still arriving, or the browser runs none): a click on the button submits nothing, however long the page has been open', async () => {
    mountMarkup();
    const form = document.querySelector(`form[${PRESS_GATE_FORM_ATTR}]`) as HTMLFormElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(clickCounts(form, button)).toBe(0);
    await wait(PRESS_GATE_QUIET_MS * 5);
    expect(clickCounts(form, button)).toBe(0);
    expect(button.disabled).toBe(true);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(gateFields(form)).toEqual([]);
  });

  it('once the script has run, a click reaches the gate: cancelled in the first second, let through after it', async () => {
    const { form, button } = mount();
    // The click now fires submit, and the gate cancels it (the counter's own
    // listener runs after the gate's and sees every submit).
    expect(clickCounts(form, button)).toBe(1);
    expect(gateFields(form)).toEqual([]);
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(clickCounts(form, button)).toBe(1);
    expect(gateFields(form)).toEqual([`hidden:${PRESS_GATE_PASSED_VALUE}`]);
  });

  it('enabling the button is the last thing the script does before its first second starts, with every listener in place', () => {
    expect(PRESS_GATE_SCRIPT).toMatch(/\n  button\.disabled = false;\n  restart\(\);\n\}\)\(\);$/);
    expect(PRESS_GATE_SCRIPT.match(/\.disabled\b/g)).toHaveLength(1);
    expect(PRESS_GATE_SCRIPT).not.toContain("removeAttribute('disabled')");
    // A script that stops part-way (here: a browser without one of the calls
    // it makes on the way) leaves the button as the markup sent it.
    mountMarkup();
    const button = document.querySelector('button') as HTMLButtonElement;
    vi.spyOn(window, 'addEventListener').mockImplementation(() => {
      throw new Error('not supported');
    });
    expect(() => new Function(PRESS_GATE_SCRIPT)()).toThrow('not supported');
    expect(button.disabled).toBe(true);
  });
});

describe('the field POST asks for is on the form only for a press the gate let through', () => {
  it('no field in the markup, none after a cancelled press, exactly one after an armed press', async () => {
    const { form, button } = mount();
    expect(PRESS_GATE_PASSED_FIELD).toBe('press_gate');
    expect(PRESS_GATE_PASSED_VALUE).toBe('armed');
    expect(gateFields(form)).toEqual([]);
    expect(press(form, button)).toBe(false);
    expect(gateFields(form)).toEqual([]);
    await wait(PRESS_GATE_QUIET_MS - 1);
    expect(submit(form)).toBe(false);
    expect(gateFields(form)).toEqual([]);
    await wait(PRESS_GATE_QUIET_MS);
    // Armed, and not pressed yet: still no field.
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(gateFields(form)).toEqual([]);
    expect(press(form, button)).toBe(true);
    expect(gateFields(form)).toEqual([`hidden:${PRESS_GATE_PASSED_VALUE}`]);
    // A second armed press does not add a second one.
    expect(press(form, button)).toBe(true);
    expect(gateFields(form)).toEqual([`hidden:${PRESS_GATE_PASSED_VALUE}`]);
    // It is inside the gate's own form, where the post picks it up.
    expect(form.querySelector(`input[name="${PRESS_GATE_PASSED_FIELD}"]`)!.parentElement).toBe(
      form,
    );
  });

  it('the field goes when the page is no longer armed, so a press cancelled later carries none', async () => {
    const { form, button } = mount();
    await wait(PRESS_GATE_QUIET_MS);
    expect(press(form, button)).toBe(true);
    expect(gateFields(form)).toHaveLength(1);
    // The window loses focus (the swap): disarmed, and the field is gone.
    focused = false;
    window.dispatchEvent(new Event('blur'));
    expect(gateFields(form)).toEqual([]);
    focused = true;
    window.dispatchEvent(new Event('focus'));
    expect(press(form, button)).toBe(false);
    expect(gateFields(form)).toEqual([]);
    await wait(PRESS_GATE_QUIET_MS);
    expect(press(form, button)).toBe(true);
    expect(gateFields(form)).toEqual([`hidden:${PRESS_GATE_PASSED_VALUE}`]);
  });

  it('back-forward cache: a page left after its press comes back without the field', async () => {
    const { form, button } = mount();
    await wait(PRESS_GATE_QUIET_MS);
    expect(press(form, button)).toBe(true);
    expect(gateFields(form)).toHaveLength(1);
    window.dispatchEvent(new Event('pagehide'));
    expect(gateFields(form)).toEqual([]);
    window.dispatchEvent(new Event('pageshow'));
    expect(gateFields(form)).toEqual([]);
    expect(submit(form)).toBe(false);
    expect(gateFields(form)).toEqual([]);
  });

  it('a page that names addresses: no field while one of them has not been seen', async () => {
    windowSize(360, 150);
    const { form, button, marks } = mountPage();
    layOut(marks[0]!, { top: 400, height: 20 });
    await wait(PRESS_GATE_QUIET_MS * 3);
    expect(press(form, button)).toBe(false);
    expect(gateFields(form)).toEqual([]);
  });
});

describe('a page whose browser runs the script locks nobody out', () => {
  it('a page that never gets focus arms after pointer movement and a quiet second', async () => {
    focused = false;
    const { form, button } = mount();
    await wait(PRESS_GATE_QUIET_MS * 3);
    expect(submit(form)).toBe(false);
    document.dispatchEvent(new Event('pointermove', { bubbles: true }));
    await wait(PRESS_GATE_QUIET_MS - 1);
    expect(submit(form)).toBe(false);
    await wait(PRESS_GATE_QUIET_MS);
    expect(press(form, button)).toBe(true);
  });

  it('a page that never gets focus, on a touch screen: the first tap wakes it, a tap after a second goes through', async () => {
    focused = false;
    const { form, button } = mount();
    expect(press(form, button)).toBe(false);
    await wait(PRESS_GATE_QUIET_MS);
    expect(press(form, button)).toBe(true);
  });

  it('a page without the form does nothing and throws nothing', () => {
    document.body.innerHTML = '<main><p>Nothing to press.</p></main>';
    expect(() => new Function(PRESS_GATE_SCRIPT)()).not.toThrow();
  });

  it('the script is plain, self-contained JavaScript the page can inline', () => {
    expect(PRESS_GATE_SCRIPT).not.toMatch(/<\/script/i);
    expect(PRESS_GATE_SCRIPT).not.toMatch(/\bimport\b|\brequire\(|\bfetch\(|\beval\(/);
    // It finds its form and the addresses by attribute: the page gives no
    // element an id, so no link can scroll it to the button.
    expect(PRESS_GATE_SCRIPT).toContain(`querySelector('form[${PRESS_GATE_FORM_ATTR}]')`);
    expect(PRESS_GATE_SCRIPT).toContain(`querySelectorAll('[${PRESS_GATE_SEE_ATTR}]')`);
    expect(PRESS_GATE_SCRIPT).not.toContain('getElementById');
  });
});

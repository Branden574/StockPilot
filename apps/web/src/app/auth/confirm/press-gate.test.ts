import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PRESS_GATE_FORM_ATTR,
  PRESS_GATE_QUIET_MS,
  PRESS_GATE_SCRIPT,
  PRESS_GATE_SEE_ATTR,
} from './press-gate';

/**
 * Security invariant (docket S25, INV-E5): a press on the confirmation page
 * counts only after the page has been in front of the person, quiet, for a
 * second, and only once every address it names has been wholly on screen
 * through such a second.
 *
 * The page names the account a link is for before anyone presses, but a
 * known window-swap trick (DoubleClickjacking, published December 2024) gets
 * the press without the person ever seeing the page: another site asks for a
 * double-click, loads its own link in the person's tab behind a popup, and
 * closes the popup on the first press, so the second lands on the button.
 * Framing headers do not stop it (the page is never framed). Another site
 * also picks the window's size and where the page opens scrolled to (a
 * fragment), so the button can be on screen while the line naming the
 * account is not (S25 review). The inline gate cancels any submit until the
 * page has been visible, with focus or the pointer over it, for a whole
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
 *     gate armed, and an address taller than the screen counts once it fills
 *     it, so neither a small screen nor a large zoom is locked out;
 *   - a page that never gets focus arms after pointer movement and a quiet
 *     second, so no browser is locked out;
 *   - the button stays enabled in the markup and is shown aria-disabled
 *     until armed.
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

/** The form alone: a page that names no address (a link without r, until PR-2). */
function mount(): { form: HTMLFormElement; button: HTMLButtonElement } {
  document.body.innerHTML = `<main>
    <form method="post" action="/auth/confirm" ${PRESS_GATE_FORM_ATTR}>
      <input type="hidden" name="type" value="magiclink">
      <button type="submit" class="btn">Continue to StockPilot</button>
    </form>
  </main>`;
  return runGate();
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
      <button type="submit" class="btn">Continue to StockPilot</button>
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

/** Lays an element out at a place on the page (its box moves with the scroll). */
function layOut(
  el: Element,
  box: { top: number; height: number; left?: number; width?: number },
): void {
  vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() => {
    const top = box.top - scrollY;
    const left = box.left ?? 40;
    const width = box.width ?? 240;
    return {
      x: left,
      y: top,
      top,
      bottom: top + box.height,
      left,
      right: left + width,
      width,
      height: box.height,
      toJSON: () => ({}),
    } as DOMRect;
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

  it('shows the button aria-disabled until armed, and never disables it in the markup', async () => {
    const { button } = mount();
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(button.hasAttribute('disabled')).toBe(false);
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

  it('an address taller than the screen counts once it fills the screen, so a very large zoom locks nobody out', async () => {
    windowSize(320, 120);
    const { form, button, marks } = mountPage();
    // Wrapped a few characters a line at a very large zoom.
    layOut(marks[0]!, { top: 100, height: 400 });
    await wait(PRESS_GATE_QUIET_MS * 3);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    scrollTo(150);
    await wait(PRESS_GATE_QUIET_MS);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    scrollTo(900);
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

describe('fails open, never locks anyone out', () => {
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

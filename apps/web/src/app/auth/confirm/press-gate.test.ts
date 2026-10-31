import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PRESS_GATE_FORM_ID, PRESS_GATE_QUIET_MS, PRESS_GATE_SCRIPT } from './press-gate';

/**
 * Security invariant (docket S25, INV-E5): a press on the confirmation page
 * counts only after the page has been in front of the person, quiet, for a
 * second.
 *
 * The page names the account a link is for before anyone presses, but a
 * known window-swap trick (DoubleClickjacking, published December 2024) gets
 * the press without the person ever seeing the page: another site asks for a
 * double-click, loads its own link in the person's tab behind a popup, and
 * closes the popup on the first press, so the second lands on the button.
 * Framing headers do not stop it (the page is never framed). The inline gate
 * cancels any submit until the page has been visible, with focus or the
 * pointer over it, for a whole second with no pointerdown or keydown, so a
 * press that lands within a second of the swap does nothing. These run the
 * exact script the page carries (route.test.ts pins that it does):
 *   - a submit in the first second is cancelled, and one after it goes through;
 *   - a press while not armed restarts the second (a rapid-click lure keeps
 *     the button off);
 *   - losing focus or visibility disarms, and coming back starts again;
 *   - the swap itself: focus arriving with a press right behind it is
 *     cancelled, with or without a focus event;
 *   - a page that never gets focus arms after pointer movement and a quiet
 *     second, so no browser is locked out;
 *   - the button stays enabled in the markup and is shown aria-disabled
 *     until armed.
 */

let focused = true;
let visibility: DocumentVisibilityState = 'visible';

function mount(): { form: HTMLFormElement; button: HTMLButtonElement } {
  document.body.innerHTML = `<main>
    <form id="${PRESS_GATE_FORM_ID}" method="post" action="/auth/confirm">
      <input type="hidden" name="type" value="magiclink">
      <button type="submit" class="btn">Continue to StockPilot</button>
    </form>
  </main>`;
  // The page carries the script inline, right after the form: run it the same
  // way, once, against this document.
  new Function(PRESS_GATE_SCRIPT)();
  return {
    form: document.getElementById(PRESS_GATE_FORM_ID) as HTMLFormElement,
    button: document.querySelector('button') as HTMLButtonElement,
  };
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

  it('a pointerdown or a key while not armed restarts the second', async () => {
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
    expect(PRESS_GATE_SCRIPT).toContain(`getElementById('${PRESS_GATE_FORM_ID}')`);
  });
});

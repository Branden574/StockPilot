/**
 * The press gate on /auth/confirm's page (docket S25): the page's only
 * script, inline, right after its form.
 *
 * The page names the account a link is for before anyone presses. A known
 * window-swap trick (DoubleClickjacking, published December 2024) skips that:
 * another site asks for a double-click, loads its own link in the person's
 * tab behind a popup, and closes the popup on the first press, so the second
 * press lands on the button before the page was ever seen. The page cannot be
 * framed (next.config.ts), and the swap needs no frame. Another site can also
 * open the link in a window of the size it likes, scrolled where it likes, so
 * that the button is on screen and the line naming the account is not (S25
 * review: a fragment naming the form did it in every engine).
 *
 * The rule: a submit is cancelled until the page is ARMED, which takes one
 * quiet second in which the page is visible and has focus (or the pointer is
 * on it), with no pointerdown, keydown, scroll or resize in it, and at the end
 * of which every address the page names (marked with PRESS_GATE_SEE_ATTR) has
 * been seen. An address is seen once it is wholly on screen at the end of
 * such a second, or once each of its lines has been, a screenful at a time:
 * a very large zoom or a very small window wraps an address a few characters
 * a line, taller than the screen. Part of an address is never enough: another
 * site can open a tiny window at a text fragment inside a long address it
 * chose for its own account, and the window then shows five of its
 * characters (S25 review). The second is restarted by any scroll or resize,
 * so whatever is on screen at its end was on screen all through it. Lines are
 * the address's line boxes (getClientRects), so an address must stay an
 * inline element; when it wraps again (its box or its number of lines
 * changes), its lines start again. An address seen stays seen: a small screen
 * scrolls on to the button afterwards. A press while it is not armed is
 * cancelled and starts the second again, so the second press of a
 * double-click, or a run of rapid clicks or keys, never counts. Losing focus or visibility, or leaving the page,
 * disarms it; coming back (focus, visibilitychange, pageshow after the
 * back-forward cache) starts the second again. Once armed, the person's own
 * pointer, keys and scrolling do not take it back. Until then the button is
 * shown aria-disabled, and the page's style dims it.
 *
 * The page gives no element an id, so no link can open it scrolled to the
 * button: the gate finds its form and the addresses by attribute.
 *
 * Fail-safe: the button stays enabled in the markup, so a browser where this
 * does not run posts as before, and the pointer can arm a page whose browser
 * never reports focus. What it does not stop: a person talked into stopping
 * on the page and pressing again later (every line of every address it names
 * has then been on screen for at least a second), INV-E5.
 *
 * Plain ES5 with no dependency: the CSP allows inline scripts
 * (next.config.ts), and nothing from the request is ever written into it.
 * press-gate.test.ts runs this exact text; route.test.ts pins that the page
 * carries it, once, and no other script.
 */

/** The attribute that marks the form the gate guards (the page has one form, and no ids). */
export const PRESS_GATE_FORM_ATTR = 'data-press-gate';

/** The attribute that marks each address the person must have seen before a press counts. */
export const PRESS_GATE_SEE_ATTR = 'data-press-gate-see';

/** The quiet time before a press counts. */
export const PRESS_GATE_QUIET_MS = 1000;

export const PRESS_GATE_SCRIPT = `(function () {
  var form = document.querySelector('form[${PRESS_GATE_FORM_ATTR}]');
  var button = form && form.querySelector('button');
  if (!form || !button) return;
  var marks = document.querySelectorAll('[${PRESS_GATE_SEE_ATTR}]');
  var seen = [];
  var linesSeen = [];
  var shapes = [];
  for (var i = 0; i < marks.length; i++) {
    seen.push(false);
    linesSeen.push([]);
    shapes.push('');
  }
  var armed = false;
  var pointerOn = false;
  var timer = null;
  function show() {
    button.setAttribute('aria-disabled', armed ? 'false' : 'true');
  }
  function present() {
    return document.visibilityState === 'visible' && (document.hasFocus() || pointerOn);
  }
  function onScreen(box) {
    return (
      box.top >= -1 &&
      box.bottom <= window.innerHeight + 1 &&
      box.left >= -1 &&
      box.right <= window.innerWidth + 1
    );
  }
  function look(n) {
    var box = marks[n].getBoundingClientRect();
    if (onScreen(box)) return true;
    var lines = marks[n].getClientRects();
    var shape = box.width + 'x' + box.height + 'x' + lines.length;
    if (shape !== shapes[n]) {
      shapes[n] = shape;
      linesSeen[n] = [];
    }
    var all = lines.length > 0;
    for (var k = 0; k < lines.length; k++) {
      if (onScreen(lines[k])) linesSeen[n][k] = true;
      if (!linesSeen[n][k]) all = false;
    }
    return all;
  }
  function stop() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function arm() {
    timer = null;
    var here = present();
    var all = here;
    for (var i = 0; i < marks.length; i++) {
      if (here && !seen[i] && look(i)) seen[i] = true;
      if (!seen[i]) all = false;
    }
    armed = all;
    show();
  }
  function restart() {
    stop();
    armed = false;
    show();
    if (present()) timer = setTimeout(arm, ${PRESS_GATE_QUIET_MS});
  }
  function disarm() {
    stop();
    armed = false;
    show();
  }
  function interrupt() {
    if (!armed) restart();
  }
  function pointerSeen() {
    pointerOn = true;
    if (!armed && timer === null) restart();
  }
  function touched() {
    pointerOn = true;
    interrupt();
  }
  form.addEventListener('submit', function (event) {
    if (armed) return;
    event.preventDefault();
    restart();
  });
  document.addEventListener('pointerdown', touched, true);
  document.addEventListener('mousedown', touched, true);
  document.addEventListener('touchstart', touched, true);
  document.addEventListener('keydown', interrupt, true);
  document.addEventListener('pointermove', pointerSeen, true);
  document.addEventListener('mousemove', pointerSeen, true);
  document.addEventListener('mouseout', function (event) {
    if (event.relatedTarget) return;
    pointerOn = false;
    if (!document.hasFocus()) disarm();
  }, true);
  window.addEventListener('scroll', interrupt, true);
  window.addEventListener('resize', interrupt);
  window.addEventListener('focus', restart);
  window.addEventListener('blur', function () {
    pointerOn = false;
    disarm();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') restart();
    else disarm();
  });
  window.addEventListener('pageshow', restart);
  window.addEventListener('pagehide', disarm);
  restart();
})();`;

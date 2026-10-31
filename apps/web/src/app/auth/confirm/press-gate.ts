/**
 * The press gate on /auth/confirm's page (docket S25): the page's only
 * script, inline, right after its form.
 *
 * The page names the account a link is for before anyone presses. A known
 * window-swap trick (DoubleClickjacking, published December 2024) skips that:
 * another site asks for a double-click, loads its own link in the person's
 * tab behind a popup, and closes the popup on the first press, so the second
 * press lands on the button before the page was ever seen. The page cannot be
 * framed (next.config.ts), and the swap needs no frame.
 *
 * The rule: a submit is cancelled until the page is ARMED, which takes one
 * quiet second in which the page is visible and has focus (or the pointer is
 * on it), with no pointerdown or keydown in it. A press while it is not armed
 * is cancelled and starts the second again, so the second press of a
 * double-click, or a run of rapid clicks, never counts. Losing focus or
 * visibility, or leaving the page, disarms it; coming back (focus,
 * visibilitychange, pageshow after the back-forward cache) starts the second
 * again. Once armed, the person's own pointer and keys do not take it back.
 * Until then the button is shown aria-disabled, and the page's style dims it.
 *
 * Fail-safe: the button stays enabled in the markup, so a browser where this
 * does not run posts as before, and the pointer can arm a page whose browser
 * never reports focus. What it does not stop: a person talked into stopping
 * on the page and pressing again later (the address is then on screen for at
 * least a second), INV-E5.
 *
 * Plain ES5 with no dependency: the CSP allows inline scripts
 * (next.config.ts), and nothing from the request is ever written into it.
 * press-gate.test.ts runs this exact text; route.test.ts pins that the page
 * carries it, once, and no other script.
 */

/** The form the gate guards (route.ts gives its form this id). */
export const PRESS_GATE_FORM_ID = 'confirm-form';

/** The quiet time before a press counts. */
export const PRESS_GATE_QUIET_MS = 1000;

export const PRESS_GATE_SCRIPT = `(function () {
  var form = document.getElementById('${PRESS_GATE_FORM_ID}');
  var button = form && form.querySelector('button');
  if (!form || !button) return;
  var armed = false;
  var pointerOn = false;
  var timer = null;
  function show() {
    button.setAttribute('aria-disabled', armed ? 'false' : 'true');
  }
  function present() {
    return document.visibilityState === 'visible' && (document.hasFocus() || pointerOn);
  }
  function stop() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function arm() {
    timer = null;
    armed = present();
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

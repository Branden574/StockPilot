#!/usr/bin/env python3
"""StockPilot iOS simulator smoke suite.

Why this exists: the last three floor-reported bugs -- the sheet-scroll
regression (d8e9669f), the delivery-request compose surface (#132), and the
maintenance email actions (#136) -- were device-surface bugs living in .tsx
screens, gesture arbitration, and deep-link rendering. Mobile vitest cannot
reach .tsx at all, so none of them were visible to the test suite. This
suite drives the real app on the real simulator via idb and asserts on the
rendered accessibility tree.

V1 is strictly READ-ONLY against the demo org (71b27a4a): it never mutates
orders, never files tickets, never taps a send/compose button. A nightly
run must not accrete junk data. Mutating flows belong behind the extension
point marked MUTATING-FLOWS below and need their own fixture + cleanup
story first.

Hard-won simulator facts baked in (each cost real debugging time):
- `idb ui swipe` WITHOUT --duration produces no scroll on any list. Every
  swipe here passes --duration, and validate_gesture() proves the gesture
  moves a known-scrollable list once per run before any scroll assertion
  is trusted. If the gesture is broken the run ABORTS blaming the harness.
- `idb ui describe-all` frames are in POINTS (1032x1376 screen); screenshots
  are ~2x pixels. Taps are always computed from describe-all frame centers,
  never from screenshot pixels. The output is one JSON array -- json.loads
  the whole blob and walk children.
- `idb ui text` truncates long strings (it has dropped the tail of an email
  twice), so typed input goes in short chunks and the field content is
  verified via describe-all afterwards, with the tail keyed in if short.
- The installed DEBUG binary loads JS from Metro on :8081 and has
  localhost:3000 baked into extra.apiUrl, so every REST read (maintenance
  list/detail, the enabled-modules snapshot) needs the local web server on
  :3000. Both are preflight checks with explicit failure messages.
- A notification detail sheet can overlay on launch; dismiss_overlays()
  runs before any flow asserts.
- Deep links use the `stockpilot` scheme; after openurl the driver polls
  describe-all for a landmark label -- fixed sleeps are only ever brief
  inter-step settling, never the assertion wait.

CI MODE (--ci): the app on a CI runner is a RELEASE simulator build (the
`simulator` EAS profile) -- its JS is bundled (no Metro) and its baked
extra.apiUrl is the production API, not localhost:3000. --ci therefore
skips the Metro and :3000 preflight checks, SKIPS the flows that depend on
the locally served REST API (LOCAL_API_FLOWS below; skips are printed
honestly and never counted as passes), reads the sign-in password from the
STOCKPILOT_SMOKE_PASSWORD environment variable when the macOS keychain
entry is absent (a CI runner has no user keychain; the value is read into
memory and never printed or echoed), and expects --udid because the CI
simulator is created per-run. Everything else -- gesture self-validation,
the flows themselves, the artifacts -- is identical to a local run, so a
flow passing locally and failing in CI means the app or the runner, not a
forked code path. The default (no --ci) behavior asserts exactly what it
did before this change; two non-asserting deltas exist (the
STOCKPILOT_SMOKE_PASSWORD fallback and a preflight mode line), so it is
behaviourally equivalent rather than byte-for-byte the
local workflow this file has always run.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime

# The LOCAL simulator (iPad Pro 13-inch (M5), iOS 26.5). Overridable with
# --udid for CI, where the simulator is created per-run -- but it must still
# be an iPad Pro 13-inch: SCREEN_W/H below are that device's point geometry,
# and every tap/swipe coordinate is derived from them.
UDID = "0620A9E7-237A-4E16-9953-C8CD4AC6D284"
BUNDLE_ID = "app.stockpilot.mobile"
SCREEN_W, SCREEN_H = 1032, 1376  # points, per describe-all
SWIPE_DURATION = "0.4"  # a swipe without --duration does nothing at all
METRO_PORT = 8081
API_PORT = 3000  # baked into the debug binary's extra.apiUrl
DELIVERY_ORDER_URL = "stockpilot://order/fead05f8-d3cd-4c51-b88b-41f7136f1602"
DELIVERY_ORDER_LABEL = "SO-000021"
DELIVERY_RECIPIENT = "dc4@learn4life.org"
SHEET_LANDMARK = "Search items to add"  # the Add-items sheet's search field
MOVE_EPSILON = 20  # points a row must move before we call it a scroll
SMOKE_DIR = os.path.dirname(os.path.abspath(__file__))
ARTIFACTS_DIR = os.path.join(SMOKE_DIR, "artifacts")


def run(cmd, timeout=60):
    """Run a command, capture output. Never echoes secrets."""
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def idb(*args, timeout=60):
    return run(["idb"] + list(args) + ["--udid", UDID], timeout=timeout)


# ---------------------------------------------------------------------------
# Accessibility-tree helpers (frames in POINTS; tap frame centers only)
# ---------------------------------------------------------------------------

def describe_all():
    """Full accessibility tree, flattened. One JSON array for the screen."""
    p = idb("ui", "describe-all")
    if p.returncode != 0:
        raise RuntimeError(f"idb ui describe-all failed: {p.stderr.strip()}")
    try:
        tree = json.loads(p.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"describe-all was not valid JSON: {e}")
    flat = []

    def walk(node):
        if isinstance(node, list):
            for child in node:
                walk(child)
        elif isinstance(node, dict):
            flat.append(node)
            for key in ("children", "AXChildren"):
                if isinstance(node.get(key), list):
                    walk(node[key])

    walk(tree)
    return flat


def frame_of(el):
    """(x, y, w, h) in points, from the frame dict or the AXFrame string."""
    f = el.get("frame")
    if isinstance(f, dict) and "x" in f:
        return (f["x"], f["y"], f.get("width", 0), f.get("height", 0))
    m = re.match(
        r"\{\{([-\d.]+), ([-\d.]+)\}, \{([-\d.]+), ([-\d.]+)\}\}",
        el.get("AXFrame", ""),
    )
    return tuple(float(g) for g in m.groups()) if m else None


def label_of(el):
    return el.get("AXLabel") or ""


def on_screen(el):
    fr = frame_of(el)
    if not fr:
        return False
    x, y, w, h = fr
    return w > 0 and h > 0 and x + w > 0 and y + h > 0 and x < SCREEN_W and y < SCREEN_H


def find_all(substr, elements=None, visible=True):
    """Elements whose label contains substr (case-insensitive)."""
    if elements is None:
        elements = describe_all()
    needle = substr.lower()
    out = [e for e in elements if needle in label_of(e).lower()]
    return [e for e in out if on_screen(e)] if visible else out


def find_re(pattern, elements=None, visible=True):
    if elements is None:
        elements = describe_all()
    rx = re.compile(pattern)
    out = [e for e in elements if rx.search(label_of(e))]
    return [e for e in out if on_screen(e)] if visible else out


def wait_for(substr=None, pattern=None, timeout=25, interval=0.7, visible=True):
    """Poll describe-all until a label matches. The assertion wait everywhere."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            els = describe_all()
        except RuntimeError:
            time.sleep(interval)
            continue
        hits = (
            find_all(substr, els, visible=visible)
            if substr is not None
            else find_re(pattern, els, visible=visible)
        )
        if hits:
            return hits[0]
        time.sleep(interval)
    return None


def wait_gone(substr, timeout=15, interval=0.7):
    """Poll until no visible label contains substr."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if not find_all(substr):
                return True
        except RuntimeError:
            pass
        time.sleep(interval)
    return False


# ---------------------------------------------------------------------------
# Input helpers
# ---------------------------------------------------------------------------

def tap(x, y):
    idb("ui", "tap", str(int(x)), str(int(y)))


def tap_element(el):
    fr = frame_of(el)
    if not fr:
        raise RuntimeError(f"element has no frame: {label_of(el)!r}")
    x, y, w, h = fr
    tap(x + w / 2, y + h / 2)


def swipe(x1, y1, x2, y2):
    """Swipe. ALWAYS passes --duration: without it idb produces no scroll."""
    idb(
        "ui", "swipe",
        str(int(x1)), str(int(y1)), str(int(x2)), str(int(y2)),
        "--duration", SWIPE_DURATION,
    )


def type_text(text, chunk=8):
    """Type in short chunks; idb ui text truncates long strings."""
    for i in range(0, len(text), chunk):
        idb("ui", "text", text[i : i + chunk])
        time.sleep(0.3)


def open_url(url):
    run(["xcrun", "simctl", "openurl", UDID, url])


def launch_app(fresh=True):
    if fresh:
        run(["xcrun", "simctl", "terminate", UDID, BUNDLE_ID])
        time.sleep(1)
    run(["xcrun", "simctl", "launch", UDID, BUNDLE_ID])


def screenshot(name):
    os.makedirs(ARTIFACTS_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = os.path.join(ARTIFACTS_DIR, f"{stamp}-{name}.png")
    run(["xcrun", "simctl", "io", UDID, "screenshot", path])
    return path


def moved(anchor_label, before_y, sibling_pattern=None):
    """True when the labelled element left its y position or scrolled off.

    THE FAIL-OPEN THIS CLOSES (verifier finding, 2026-08-16): the original
    version returned True whenever the anchor was simply ABSENT, so a sheet
    that failed to render at all -- or an accessibility tree that came back
    empty -- counted as "it scrolled". An anchor that vanished only proves
    movement if the LIST it lived in is still there (virtualization recycles
    off-screen rows; the list itself never disappears). So absence counts as
    moved ONLY when `sibling_pattern` still matches something on screen;
    otherwise it is a failure the caller reports as "anchor and its list both
    gone", which is a render problem, not a scroll.
    """
    hits = find_all(anchor_label, visible=False)
    if hits:
        fr = frame_of(hits[0])
        return fr is not None and abs(fr[1] - before_y) > MOVE_EPSILON
    if sibling_pattern is None:
        return False
    els = describe_all()
    return any(re.search(sibling_pattern, label_of(e) or "") for e in els)


# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

def fail_hard(msg):
    print(f"\nFATAL: {msg}", file=sys.stderr)
    sys.exit(2)


def preflight(ci=False):
    """Metro alive, API server alive, sim booted, app launched, overlays gone.

    In --ci mode the Metro and :3000 checks are SKIPPED, not satisfied some
    other way: the CI app is a release simulator build whose JS is bundled
    and whose baked apiUrl is the production API. Those two prerequisites
    simply do not exist there, and pretending to check them would fail every
    CI run for reasons that are not failures.
    """
    if not ci:
        if run(["lsof", "-ti", f":{METRO_PORT}"]).stdout.strip() == "":
            fail_hard(
                f"Metro dev server is not running on :{METRO_PORT}. The installed "
                "build is a DEBUG build that loads its JS from Metro. Start it "
                "with `pnpm start` in apps/mobile and re-run. (A RELEASE sim "
                "build needs no Metro -- use --ci for that case.)"
            )
        if run(["lsof", "-ti", f":{API_PORT}"]).stdout.strip() == "":
            fail_hard(
                f"No web server on :{API_PORT}. The debug binary has "
                "localhost:3000 baked into extra.apiUrl, and the maintenance "
                "flow (plus the enabled-modules snapshot) reads over that REST "
                "API. Start apps/web with the prod-Supabase env "
                "(.env.local.prod) and re-run."
            )
    if UDID not in run(["xcrun", "simctl", "list", "devices", "booted"]).stdout:
        print(f"Simulator {UDID} not booted; booting...")
        run(["xcrun", "simctl", "boot", UDID])
        time.sleep(5)
        if UDID not in run(["xcrun", "simctl", "list", "devices", "booted"]).stdout:
            fail_hard(f"Could not boot simulator {UDID}.")
    launch_app(fresh=True)
    if not wait_for(pattern=r"\S", timeout=60):
        fail_hard("App launched but no accessibility elements appeared in 60s.")
    dismiss_overlays()


def dismiss_overlays():
    """A notification detail sheet can overlay on launch; close it by frame."""
    for _ in range(3):
        els = describe_all()
        close = [
            e
            for e in find_all("close", els)
            if label_of(e).strip().lower() in ("close", "close button", "dismiss")
        ]
        if not close:
            return
        tap_element(close[0])
        time.sleep(1.2)


def reset_state():
    """Return the app to a known screen after a failed flow.

    Order matters: the Add-items sheet has no Close labelled 'close' (it
    dismisses on scrim tap), so close IT first if its landmark is visible,
    then sweep labelled overlays, then deep-link home so the next flow's own
    deep link starts from the same place a clean run would.
    """
    try:
        if find_all(SHEET_LANDMARK):
            tap(SCREEN_W / 2, 200)  # scrim tap, well above the sheet's top
            wait_gone(SHEET_LANDMARK, timeout=8)
        dismiss_overlays()
        open_url("stockpilot://")
        time.sleep(1.5)
        dismiss_overlays()
    except Exception as e:  # noqa: BLE001 - never let cleanup mask the real failure
        print(f"(reset_state: best-effort cleanup hit {e!r}; continuing)")


# ---------------------------------------------------------------------------
# Gesture self-validation: prove the harness can scroll before trusting any
# scroll assertion. A suite that can blame the app for its own broken
# gestures is worse than no suite.
# ---------------------------------------------------------------------------

def validate_gesture():
    open_url("stockpilot://orders")
    anchor = wait_for(pattern=r"SO-\d+", timeout=30)
    if anchor is None:
        fail_hard(
            "HARNESS FAILURE (not the app): could not reach the orders list "
            "to self-validate the swipe gesture."
        )
    label, before = label_of(anchor), frame_of(anchor)
    swipe(SCREEN_W / 2, SCREEN_H * 0.65, SCREEN_W / 2, SCREEN_H * 0.30)
    time.sleep(1.0)
    ok = moved(label, before[1], sibling_pattern=r"SO-\d+")
    # Restore the list position for the flows that follow.
    swipe(SCREEN_W / 2, SCREEN_H * 0.30, SCREEN_W / 2, SCREEN_H * 0.65)
    time.sleep(0.8)
    if not ok:
        fail_hard(
            "HARNESS FAILURE (not the app): the self-validation swipe did not "
            "move the orders list, which is known to scroll. No scroll "
            "assertion from this harness can be trusted. Check idb and that "
            "every swipe passes --duration."
        )
    print("gesture self-validation: swipe moved the orders list, OK")


# ---------------------------------------------------------------------------
# Flows. Each returns (passed: bool, reason: str).
# ---------------------------------------------------------------------------

def flow_login_shell():
    """LOGIN/SHELL. Regression class this month: store/auth boot issues render
    a blank or stuck shell on device -- invisible to vitest, which cannot
    mount the .tsx shell at all."""
    launch_app(fresh=True)
    deadline = time.time() + 60
    state = None
    while time.time() < deadline:
        try:
            els = describe_all()
        except RuntimeError:
            time.sleep(1)
            continue
        if _shell_rendered(els):
            state = "shell"
            break
        if find_all("Sign in to", els) or find_all("WELCOME BACK", els):
            state = "login"
            break
        time.sleep(1)
    if state is None:
        return False, "neither the signed-in shell nor the sign-in screen appeared in 60s"
    if state == "login":
        ok, why = _password_login()
        if not ok:
            return False, why
        deadline = time.time() + 60
        while time.time() < deadline and not _shell_rendered(describe_all()):
            time.sleep(1)
        if not _shell_rendered(describe_all()):
            return False, "sign-in submitted but the signed-in shell never rendered"
    dismiss_overlays()
    els = describe_all()
    missing = [t for t in ("Home", "Items", "Scan") if not find_all(t, els)]
    if missing:
        return False, f"shell rendered without expected tab(s): {missing}"
    return True, "signed-in shell rendered with Home/Items/Scan tabs"


def _shell_rendered(els):
    return all(find_all(t, els) for t in ("Home", "Items", "Scan"))


def _password_login():
    """Password login from the macOS keychain, else STOCKPILOT_SMOKE_PASSWORD
    (the CI path -- a runner has no user keychain). Either way the secret is
    fetched into memory, never printed, never written anywhere, never in argv
    of anything that logs."""
    p = run(
        ["security", "find-generic-password", "-w", "-s", "stockpilot/demo-org-qa-login"]
    )
    password = p.stdout.rstrip("\n") if p.returncode == 0 else ""
    if not password:
        password = os.environ.get("STOCKPILOT_SMOKE_PASSWORD", "")
    if not password:
        return False, (
            "demo password unavailable: not in the keychain "
            "(stockpilot/demo-org-qa-login) and STOCKPILOT_SMOKE_PASSWORD is unset"
        )
    email = "demo@stockpilotusa.com"
    els = describe_all()
    fields = [e for e in els if e.get("type") == "TextField" and on_screen(e)]
    if not fields:
        return False, "sign-in screen rendered but no email field found"
    fields.sort(key=lambda e: frame_of(e)[1])
    tap_element(fields[0])
    time.sleep(0.5)
    type_text(email)  # short chunks: idb ui text truncates long strings
    typed = _field_value_containing("@")
    if typed and typed != email and email.startswith(typed):
        for ch in email[len(typed):]:  # key in the truncated tail
            idb("ui", "text", ch)
    secure = [
        e for e in describe_all() if e.get("type") == "SecureTextField" and on_screen(e)
    ]
    if not secure:
        return False, "no password field found on sign-in screen"
    tap_element(secure[0])
    time.sleep(0.5)
    type_text(password)
    btn = wait_for("Sign in", timeout=5)
    if not btn:
        return False, "no Sign in button found"
    tap_element(btn)
    return True, "submitted"


def _field_value_containing(substr):
    for e in describe_all():
        v = e.get("AXValue") or ""
        if substr in v:
            return v
    return None


def flow_sheet_scroll():
    """SHEET SCROLL. The d8e9669f/#135 regression: the Add-items sheet could
    not be scrolled until something else took the touch -- a gesture-
    arbitration bug that only exists on a real UI surface, so vitest could
    not see it. Assert a row actually MOVES under a swipe, then that the
    scrim tap closes the sheet."""
    open_url("stockpilot://orders")
    first = wait_for(pattern=r"SO-\d+", timeout=30)
    if first is None:
        return False, "orders list did not render any SO- rows"
    tap_element(first)
    add = wait_for("Add items", timeout=25)
    if add is None:
        return False, "order detail did not render an Add items action"
    tap_element(add)
    if not wait_for(SHEET_LANDMARK, timeout=20):
        return False, "Add items sheet did not open (no search field)"
    anchor = wait_for(pattern=r"·\s*\d+ on hand", timeout=15)
    if anchor is None:
        return False, "Add items sheet opened but no item rows appeared"
    label, before = label_of(anchor), frame_of(anchor)
    # The regression: this exact swipe used to do nothing until another
    # touch primed the sheet. Swipe INSIDE the sheet, with --duration.
    swipe(SCREEN_W / 2, SCREEN_H * 0.75, SCREEN_W / 2, SCREEN_H * 0.48)
    time.sleep(1.0)
    if not moved(label, before[1], sibling_pattern=r"on hand"):
        return False, f"sheet did not scroll: row {label!r} stayed at y={before[1]}"
    # Scrim tap closes the sheet (tap well above the sheet's top edge).
    tap(SCREEN_W / 2, 200)
    if not wait_gone(SHEET_LANDMARK, timeout=12):
        return False, "tapped the scrim but the Add items sheet stayed open"
    if not wait_for("MANAGER ACTIONS", timeout=10):
        return False, "sheet closed but the order detail did not come back"
    return True, "sheet row moved under swipe; scrim tap closed the sheet"


def flow_delivery_section():
    """DELIVERY SECTION. The #132 surface: the delivery-request section and
    its native compose action are pure .tsx + deep-link rendering that
    vitest cannot mount. Assert it renders on SO-000021 without crashing.
    The send button is NEVER tapped -- it would leave the app into
    Outlook/Safari."""
    open_url(DELIVERY_ORDER_URL)
    if not wait_for(DELIVERY_ORDER_LABEL, timeout=30):
        return False, f"deep link did not render order {DELIVERY_ORDER_LABEL}"
    if _scroll_until("DELIVERY REQUEST", max_swipes=8) is None:
        return False, "DELIVERY REQUEST section not found on the order"
    els = describe_all()
    if not find_all("Email delivery request", els):
        return False, "delivery request action button not found"
    if not find_all(DELIVERY_RECIPIENT, els):
        return False, f"recipients line does not name {DELIVERY_RECIPIENT}"
    if not find_all(DELIVERY_ORDER_LABEL, els, visible=False):
        return False, "order screen lost its landmark after scrolling (possible crash)"
    return True, f"delivery section rendered: action button + recipients naming {DELIVERY_RECIPIENT}"


def _scroll_until(substr, max_swipes=8):
    hit = wait_for(substr, timeout=6)
    if hit:
        return hit
    for _ in range(max_swipes):
        swipe(SCREEN_W / 2, SCREEN_H * 0.70, SCREEN_W / 2, SCREEN_H * 0.30)
        time.sleep(0.9)
        hits = find_all(substr)
        if hits:
            return hits[0]
    return None


def flow_maintenance():
    """MAINTENANCE. The #127/#136 surface: the maintenance detail and its
    email action area (compose-link fit, one-tap copy, double-tap guard)
    are native screens vitest cannot mount. Render-assert only; no action
    is ever tapped. Requires the maintenance_requests module enabled for
    the demo org (one-time setup, see README) and the :3000 API server
    (REST reads)."""
    open_url("stockpilot://maintenance")
    if not wait_for("Maintenance requests.", timeout=30):
        return False, "maintenance list did not render"
    if find_all("enabled for this workspace"):
        return False, (
            "maintenance module is disabled for this workspace -- the app's "
            "module snapshot is stale or the org toggle was turned off"
        )
    row = wait_for(pattern=r"MR-\d{4}-\d+", timeout=20)
    if row is None:
        return False, "maintenance list rendered but no MR- request rows found"
    tap_element(row)
    if not wait_for(pattern=r"— MR-\d{4}-\d+", timeout=20):
        return False, "maintenance detail did not render its MR- header"
    if _scroll_until("EMAIL", max_swipes=6) is None:
        return False, "maintenance detail rendered without the EMAIL section"
    els = describe_all()
    for needle in ("Open in Outlook", "Copy Email Details"):
        if not find_all(needle, els):
            return False, f"email action area is missing {needle!r}"
    return True, "maintenance detail rendered with the email action area"


# ---------------------------------------------------------------------------
# MUTATING-FLOWS extension point.
# V1 is read-only by design: a nightly run must not accrete junk data in
# the demo org. A future mutating flow must (a) create its own fixture,
# (b) clean up in a finally block even on failure, and (c) sit behind an
# explicit --allow-writes argument so a plain nightly run stays read-only.
# ---------------------------------------------------------------------------

FLOWS = [
    ("login-shell", flow_login_shell),
    ("sheet-scroll", flow_sheet_scroll),
    ("delivery-section", flow_delivery_section),
    ("maintenance", flow_maintenance),
]

# Flows whose reads are served by the REST API layer (locally: the :3000 web
# server the debug binary points at). --ci SKIPS these rather than running
# them against whatever the release build's baked apiUrl happens to reach --
# admitting one to CI is a deliberate decision for after a real CI run, not a
# default. Everything else reads Supabase directly and runs in both modes.
LOCAL_API_FLOWS = {"maintenance"}


def main():
    ap = argparse.ArgumentParser(description="StockPilot simulator smoke suite")
    ap.add_argument("--flow", choices=[n for n, _ in FLOWS], help="run one flow")
    ap.add_argument("--dump", action="store_true", help="dump visible labels and exit")
    ap.add_argument(
        "--ci",
        action="store_true",
        help="release-sim-build mode: skip the Metro/:3000 preflight checks and "
        "the LOCAL_API_FLOWS (see module doc)",
    )
    ap.add_argument(
        "--udid",
        help="target simulator UDID (default: the local iPad Pro 13-inch; a CI "
        "run creates its own iPad Pro 13-inch and passes it here -- the "
        "hardcoded point geometry is that device's)",
    )
    args = ap.parse_args()

    global UDID
    if args.udid:
        UDID = args.udid

    if args.dump:
        for e in describe_all():
            if on_screen(e) and label_of(e).strip():
                print(f"{e.get('type', '?'):>18}  {frame_of(e)}  {label_of(e)[:110]!r}")
        return

    preflight(ci=args.ci)
    validate_gesture()

    selected = [(n, f) for n, f in FLOWS if not args.flow or n == args.flow]
    skipped = []
    if args.ci:
        skipped = [n for n, _ in selected if n in LOCAL_API_FLOWS]
        selected = [(n, f) for n, f in selected if n not in LOCAL_API_FLOWS]
        for name in skipped:
            print(f"\n=== {name} ===\nSKIP: needs the locally served REST API; not run under --ci")
    results = []
    for name, fn in selected:
        print(f"\n=== {name} ===")
        try:
            passed, reason = fn()
        except Exception as e:  # noqa: BLE001 - a flow crash is a failure, not an abort
            passed, reason = False, f"exception: {e}"
        shot = screenshot(f"FAIL-{name}") if not passed else None
        results.append((name, passed, reason, shot))
        print(f"{'PASS' if passed else 'FAIL'}: {reason}")
        if not passed:
            # FLOW ISOLATION (verifier finding, 2026-08-16): a failed flow can
            # bail with a modal still open — the Add-items sheet, an alert —
            # and the NEXT flow's deep link renders BEHIND it, so one real
            # regression read as two failures and the second one lied about
            # where the problem was. Screenshot first (above) so the evidence
            # shows the abandoned state, then reset to a known screen.
            reset_state()

    print("\n" + "=" * 76)
    print(f"{'flow':<20} {'result':<8} reason")
    print("-" * 76)
    any_fail = False
    for name, passed, reason, shot in results:
        print(f"{name:<20} {'PASS' if passed else 'FAIL':<8} {reason}")
        if shot:
            print(f"{'':<29} screenshot: {shot}")
        any_fail = any_fail or not passed
    # Skips are reported, never counted: a skipped flow is coverage that did
    # not happen, and the summary must say so rather than looking greener.
    for name in skipped:
        print(f"{name:<20} {'SKIP':<8} needs the locally served REST API; not run under --ci")
    print("=" * 76)
    sys.exit(1 if any_fail else 0)


if __name__ == "__main__":
    main()

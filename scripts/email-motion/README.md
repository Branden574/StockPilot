# Email motion pipeline

Produces the animated hero GIFs the email system embeds (unit E2 of
`docs/superpowers/plans/2026-07-20-email-system-implementation.md`, pinned
decision 4), plus the header logo marks. Everything under
`apps/web/public/email/` is a committed build artifact of this pipeline —
never hand-edit those files; regenerate them.

## Regenerate

One command, from the repo root:

```
node scripts/email-motion/generate.mjs
```

Optionally pass asset ids to rebuild a subset: `node scripts/email-motion/generate.mjs lock route`.
Then verify:

```
node scripts/email-motion/validate.ts        # or: pnpm --filter web test motion-assets
```

Prerequisites:

- Workspace deps installed (`pnpm install`) — Playwright ships with apps/web;
  run `pnpm --filter web exec playwright install chromium` once per machine.
- ImageMagick + gifsicle on PATH: `brew install imagemagick gifsicle`.

## What it does

For each of the 14 assets (13 MOTION board rows in
`docs/design/email-system/es-tokens.js`; the clock row ships `clock` +
`clock-arc`):

1. `pages/<id>.html` — a self-contained capture page: the hero SVG (ported
   from `docs/design/email-system/es-heroes.jsx`) with the es-* keyframes from
   `es-core.jsx:214-225`, centered on the light sunk canvas (`#eeece5`) exactly
   as `motion-board.html` presents heroes, 1200x440 (@2x of 600x220).
2. Playwright (headless chromium) pauses every CSS animation and seeks the
   timeline frame-by-frame — capture is fully deterministic.
3. ImageMagick assembles frames with per-frame delays and the Netscape loop
   count; gifsicle `-O3` + palette reduction fits each GIF under its MOTION
   size cap (a ladder drops colors, then lossy LZW, until it fits — the specs
   land far under cap at 96 colors, lossless).
4. Frame 1 of each GIF is extracted to `preview/<id>.png` (committed) so the
   resting compositions can be eyeballed without a GIF player.

`validate.ts` (and the vitest twin `apps/web/src/lib/email/motion-assets.test.ts`,
which runs in the web suite) asserts per asset: file exists, exactly 1200x440,
under its MOTION cap, Netscape loop matches spec, frame count > 1; and that the
logo marks are 44x44.

## Loop + first-frame rules

Loop mapping (plan pinned decision 4): play once -> Netscape loop `1`;
"Loop xN, then hold" -> loop `N` with a long-hold rest frame at the end;
"Infinite (subtle)" -> loop `0`.

FRAME 1 RULE (`MOTION_GLOBAL.firstFrame`): frame 1 of every GIF is the
composed resting state — Outlook desktop and reduced-motion users see only
this frame. Play-once draws (tiles, settle, check, pin, calendar, bars, lock)
open on their FINISHED end state; loop-N assets open on the design's own
reduced-motion state (`es-core.jsx` applies `animation:none` under
`prefers-reduced-motion`) with stroke-dash draws forced complete; the two
infinite loops (route, reverse) open at animation phase 0, which is already a
fully composed frame, keeping the loop seamless.

## Production deviations from the mockup JSX

The es-heroes.jsx animations are live-preview CSS ("mockup-only", per the
motion board) — a few could not ship verbatim; each change implements what the
MOTION row specifies:

- lock: rings play once each (mockup: infinite) and the shackle gets a
  click-shut keyframe (`es-click`) — MOTION: "Shackle clicks shut once; soft
  ring expands and fades x2, then rests", play once on security.
- pin: single ring pulse (mockup: infinite) — MOTION: "one ring pulse".
- route/reverse: dash march 1.6s -> 1.8s so every period divides the 3.6s
  cycle and the infinite loop is seamless.
- scanner: scan sweep at the spec's 2.2s (mockup 2.4s); corner brackets blink
  once per sweep (`es-blinkonce`; static in the mockup) — MOTION: "corner
  brackets blink once".
- check: compass ticks fade at 1.05s (mockup 1.15s) so the draw settles by the
  spec's 1.4s.
- clock-arc: tone `err` with arc, matching both rendered mockups
  (`es-rentals.jsx:67`, motion-board demo); the MOTION prose says "amber arc" —
  the rendered design was taken as normative.

## Dark-mode trade-off (accepted)

GIFs bake the LIGHT sunk background (`#eeece5`). Dark-mode email clients show
a light hero card inside the dark layout. Accepted per plan pinned decision 4
(no APNG-only assets per `MOTION_GLOBAL.outlook`; GIF has no alpha that could
survive every client).

## Logo marks

`apps/web/public/email/logo-mark-light.png` / `logo-mark-dark.png` — the Mark
D stencil-frame S from `apps/web/src/app/icon.svg`, rasterized at 44x44
(22x22 display @2x) on a transparent background; light = ink `#0c0c0e` for
light headers, dark = paper `#f6f4ef` for dark-mode headers.

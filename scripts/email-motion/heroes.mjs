// Hero SVG builders — plain-string ports of docs/design/email-system/es-heroes.jsx
// (light theme only; production GIFs bake the light sunk background).
//
// Geometry, stroke weights, opacities and keyframe names are verbatim from the
// JSX. The only deviations are the production timing adaptations each MOTION
// row requires (play-once ring pulses, loop-period locking, spec durations) —
// every one is listed in README.md and in the per-hero comments below.
//
// Elements that draw in via stroke-dashoffset carry class="draw" so the rest
// state (animations off) can force them to their finished, fully-drawn state.
import { LIGHT } from './theme.mjs';

const T = LIGHT;

const svg = (children) =>
  // 220x120 viewBox as in es-heroes.jsx hsvg(); display size set by the page.
  `<svg class="es-anim" viewBox="0 0 220 120" width="691" height="377" style="display:block;overflow:visible">${children}</svg>`;

// es-heroes.jsx HeroLock. Production (MOTION lock row: "Shackle clicks shut
// once; soft ring expands and fades x2, then rests" / 2.4s / play once):
// - rings play ONCE each (base opacity 0 + fill forwards) instead of the
//   mockup's infinite es-ring 3s; two pulses settle by ~2.15s.
// - shackle gets es-click (click-shut) — the JSX mockup has no shackle
//   animation; motion-board.html's live demo shows only the looping rings.
export function heroLock() {
  const c = T.ink;
  return svg(`<g fill="none" stroke="${c}" stroke-opacity="0.8" stroke-width="2">
    <circle cx="110" cy="62" r="34" stroke="${c}" stroke-opacity="0.25" style="opacity:0;animation:es-ring 1.2s ease-out 0.25s 1 forwards;transform-origin:110px 62px"></circle>
    <circle cx="110" cy="62" r="34" stroke="${c}" stroke-opacity="0.18" style="opacity:0;animation:es-ring 1.2s ease-out 0.95s 1 forwards;transform-origin:110px 62px"></circle>
    <path d="M 97 56 v-8 a13 13 0 0 1 26 0 v8" style="animation:es-click .35s ease-out both"></path>
    <rect x="90" y="56" width="40" height="30" rx="6" fill="${T.sunk}"></rect>
    <circle cx="110" cy="68" r="3.5" fill="${c}" stroke="none"></circle>
    <line x1="110" y1="71" x2="110" y2="78"></line>
  </g>`);
}

// es-heroes.jsx HeroDevice — verbatim (rings loop; the GIF captures one full
// 2.8s period starting one period in, so the loop point is seamless).
export function heroDevice() {
  const c = T.ink;
  const a = T.status.info.fg;
  return svg(`<g fill="none" stroke="${c}" stroke-opacity="0.8" stroke-width="2">
    <rect x="62" y="30" width="82" height="52" rx="4"></rect>
    <line x1="50" y1="88" x2="156" y2="88" stroke-linecap="round"></line>
    <line x1="96" y1="58" x2="112" y2="58" stroke-opacity="0.35"></line>
    <line x1="88" y1="66" x2="120" y2="66" stroke-opacity="0.35"></line>
    <circle cx="158" cy="82" r="5" fill="${a}" stroke="none"></circle>
    <circle cx="158" cy="82" r="12" stroke="${a}" stroke-opacity="0.6" style="animation:es-ring 2.8s ease-out infinite;transform-origin:158px 82px"></circle>
    <circle cx="158" cy="82" r="12" stroke="${a}" stroke-opacity="0.4" style="animation:es-ring 2.8s ease-out 0.9s infinite;transform-origin:158px 82px"></circle>
  </g>`);
}

// es-heroes.jsx HeroTiles — verbatim (check path gets class="draw").
export function heroTiles() {
  const c = T.ink;
  const ok = T.status.ok.fg;
  const tiles = [[64, 26], [94, 26], [124, 26], [64, 56], [94, 56], [124, 56]];
  const rects = tiles
    .map((t, i) => {
      const last = i === 5;
      return `<rect x="${t[0]}" y="${t[1]}" width="24" height="24" rx="5" fill="${last ? T.status.ok.bg : T.sunk}"
        stroke="${last ? ok : c}" stroke-opacity="${last ? 0.9 : 0.5}" stroke-width="1.5"
        style="animation:es-drop .5s cubic-bezier(.2,.7,.3,1.3) ${(i * 0.12).toFixed(2)}s both"></rect>`;
    })
    .join('');
  return svg(`<g>${rects}
    <path class="draw" d="M 130 68 l 4 4 l 8 -8" fill="none" stroke="${ok}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
      stroke-dasharray="20" stroke-dashoffset="20" style="animation:es-draw .4s ease .9s forwards"></path>
    <line x1="64" y1="92" x2="148" y2="92" stroke="${c}" stroke-opacity="0.25" stroke-width="2" stroke-linecap="round"></line>
  </g>`);
}

// es-heroes.jsx HeroRoute (+reverse prop). Production: es-march-p 1.8s (JSX
// 1.6s) so the dash period divides the 3.6s travel/ring cycle — required for a
// seamless infinite GIF loop. Dash speed change is imperceptible.
export function heroRoute({ reverse = false } = {}) {
  const c = T.ink;
  const a = T.status.info.fg;
  return svg(`<g${reverse ? ' transform="scale(-1,1) translate(-220,0)"' : ''}>
    <line x1="28" y1="72" x2="192" y2="72" stroke="${c}" stroke-opacity="0.35" stroke-width="2" stroke-dasharray="6 6"
      style="animation:es-march-p 1.8s linear infinite"></line>
    <circle cx="28" cy="72" r="5" fill="${c}" fill-opacity="0.75"></circle>
    <circle cx="192" cy="72" r="5" fill="none" stroke="${a}" stroke-width="2"></circle>
    <circle cx="192" cy="72" r="10" fill="none" stroke="${a}" stroke-opacity="0.5" style="animation:es-ring 3.6s ease-out infinite;transform-origin:192px 72px"></circle>
    <g style="--es-tx:72px;--es-tx2:144px;animation:es-travel 3.6s ease-in-out infinite">
      <rect x="30" y="48" width="26" height="20" rx="3" fill="${T.sunk}" stroke="${c}" stroke-opacity="0.85" stroke-width="2"></rect>
      <line x1="43" y1="48" x2="43" y2="54" stroke="${c}" stroke-opacity="0.85" stroke-width="2"></line>
    </g>
  </g>`);
}

// es-heroes.jsx HeroScanner. Production (MOTION scanner row): es-scan at the
// spec's 2.2s (JSX 2.4s), and the corner brackets get es-blinkonce ("corner
// brackets blink once" — static in the JSX / board demo).
export function heroScanner() {
  const c = T.ink;
  const a = T.status.info.fg;
  const bars = [92, 99, 104, 113, 120, 127]
    .map((x, i) => `<line x1="${x}" y1="62" x2="${x}" y2="74" stroke-width="${i % 2 ? 1.5 : 3}" stroke-opacity="0.65"></line>`)
    .join('');
  return svg(`<g fill="none" stroke="${c}" stroke-opacity="0.8" stroke-width="2">
    <rect x="82" y="36" width="56" height="46" rx="4" fill="${T.sunk}"></rect>
    <line x1="110" y1="36" x2="110" y2="46"></line>
    ${bars}
    <g stroke-opacity="0.45" style="animation:es-blinkonce .5s ease both">
      <path d="M 66 30 h -10 v 10"></path><path d="M 154 30 h 10 v 10"></path>
      <path d="M 66 90 h -10 v -10"></path><path d="M 154 90 h 10 v -10"></path>
    </g>
    <line x1="110" y1="26" x2="110" y2="94" stroke="${a}" stroke-width="2" stroke-opacity="0.9"
      style="animation:es-scan 2.2s ease-in-out infinite"></line>
  </g>`);
}

// es-heroes.jsx HeroSettle — verbatim.
export function heroSettle() {
  const c = T.ink;
  const ok = T.status.ok.fg;
  const boxes = [[70, 60, 26, 26], [102, 68, 22, 18], [130, 54, 30, 32]]
    .map(
      (b, i) => `<g style="animation:es-drop .55s cubic-bezier(.2,.7,.3,1.35) ${(i * 0.16).toFixed(2)}s both">
        <rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" rx="3" fill="${T.sunk}" stroke="${c}" stroke-opacity="0.8" stroke-width="2"></rect>
        <line x1="${b[0] + b[2] / 2}" y1="${b[1]}" x2="${b[0] + b[2] / 2}" y2="${b[1] + 5}" stroke="${c}" stroke-opacity="0.8" stroke-width="2"></line>
      </g>`,
    )
    .join('');
  return svg(`<g>${boxes}
    <line x1="56" y1="88" x2="168" y2="88" stroke="${c}" stroke-opacity="0.3" stroke-width="2" stroke-linecap="round"></line>
    <circle cx="166" cy="48" r="4" fill="${ok}" style="animation:es-blinkonce 1.4s ease both"></circle>
  </g>`);
}

// es-heroes.jsx HeroCheck. Production: compass ticks fade at 1.05s over .35s so
// the whole draw settles by the MOTION row's 1.4s (JSX: .5s at 1.15s -> 1.65s).
export function heroCheck() {
  const a = T.status.ok.fg;
  const ticks = [[110, 14], [156, 60], [110, 106], [64, 60]]
    .map((p) => {
      const x2 = p[0] + (p[0] === 110 ? 0 : p[0] > 110 ? 6 : -6);
      const y2 = p[1] + (p[1] === 60 ? 0 : p[1] > 60 ? 6 : -6);
      return `<line x1="${p[0]}" y1="${p[1]}" x2="${x2}" y2="${y2}" stroke="${a}" stroke-opacity="0.5" stroke-width="2" stroke-linecap="round" style="animation:es-fadein .35s ease 1.05s both"></line>`;
    })
    .join('');
  return svg(`<g fill="none">
    <circle class="draw" cx="110" cy="60" r="32" stroke="${a}" stroke-width="2.5" stroke-dasharray="202" stroke-dashoffset="202"
      style="animation:es-draw .9s ease forwards;transform:rotate(-90deg);transform-origin:110px 60px"></circle>
    <path class="draw" d="M 96 61 l 10 10 l 20 -22" stroke="${a}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"
      stroke-dasharray="46" stroke-dashoffset="46" style="animation:es-draw .5s ease .7s forwards"></path>
    ${ticks}
  </g>`);
}

// es-heroes.jsx HeroPin. Production (MOTION pin row: "one ring pulse" / play
// once): the ring pulses ONCE (base opacity 0 + fill forwards) instead of the
// mockup's infinite es-ring 2.6s.
export function heroPin() {
  const c = T.ink;
  const ok = T.status.ok.fg;
  const hatches = [58, 86, 114, 142, 170]
    .map((x) => `<line x1="${x}" y1="88" x2="${x - 8}" y2="98" stroke-opacity="0.3" stroke-width="1.5"></line>`)
    .join('');
  return svg(`<g fill="none" stroke="${c}" stroke-opacity="0.8" stroke-width="2">
    <line x1="44" y1="88" x2="176" y2="88" stroke-linecap="round"></line>
    ${hatches}
    <rect x="84" y="56" width="30" height="32" rx="3" fill="${T.sunk}"></rect>
    <line x1="99" y1="56" x2="99" y2="63"></line>
    <g style="animation:es-drop .6s cubic-bezier(.2,.7,.3,1.3) both">
      <path d="M 142 44 a 11 11 0 1 1 0.01 0 M 142 55 l 0 14" stroke="${ok}" stroke-width="2.5"></path>
      <circle cx="142" cy="38.5" r="4" fill="${ok}" stroke="none"></circle>
    </g>
    <circle cx="142" cy="72" r="8" stroke="${ok}" stroke-opacity="0.6" style="opacity:0;animation:es-ring 1s ease-out .55s 1 forwards;transform-origin:142px 72px"></circle>
  </g>`);
}

// Timeline tick — the "received" email's motion (MOTION note "L2 · Timeline
// tick"). Not a hero-box asset: a 22x22 @2x transparent dot that replaces the
// active timeline glyph (display 11x11). The dot pops in, one ring pulses,
// rest = solid dot (frame 1). Info-blue per the received badge/timeline tone.
export function heroTick() {
  const info = T.status.info.fg;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
    <circle cx="11" cy="11" r="6.5" fill="${info}" style="animation:es-tick-dot .6s ease-out both;transform-origin:11px 11px"></circle>
    <circle cx="11" cy="11" r="6.5" fill="none" stroke="${info}" stroke-width="1.8" style="opacity:0;animation:es-tick-ring .9s ease-out .25s 1 forwards;transform-origin:11px 11px"></circle>
  </svg>`;
}

// es-heroes.jsx HeroTag — verbatim (swing loops; captured over one full 3.2s
// period; the appended hold frame eases the tag back to rest).
export function heroTag() {
  const c = T.ink;
  return svg(`<g fill="none" stroke="${c}" stroke-opacity="0.8" stroke-width="2">
    <path d="M 110 18 q 14 4 0 12" stroke-opacity="0.5"></path>
    <g style="animation:es-swing 3.2s ease-in-out infinite;transform-origin:110px 30px">
      <rect x="86" y="30" width="48" height="62" rx="9" fill="${T.sunk}"></rect>
      <circle cx="110" cy="42" r="4.5"></circle>
      <line x1="96" y1="60" x2="124" y2="60" stroke-opacity="0.5"></line>
      <line x1="96" y1="70" x2="116" y2="70" stroke-opacity="0.35"></line>
      <line x1="96" y1="80" x2="120" y2="80" stroke-opacity="0.35"></line>
    </g>
  </g>`);
}

// es-heroes.jsx HeroClock (+arc/tone props). Board demo + es-rentals.jsx:67
// both render the overdue variant as tone="err" with arc; the schedule 1-hour
// email (es-digest.jsx:45) renders tone="warn" without arc.
export function heroClock({ tone = 'warn', arc = false } = {}) {
  const c = T.ink;
  const a = T.status[tone].fg;
  const ticks = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]
    .map(
      (d, i) => `<line x1="110" y1="27" x2="110" y2="${i % 3 === 0 ? 32 : 30}" stroke="${c}" stroke-opacity="0.5" stroke-width="${i % 3 === 0 ? 2 : 1}"
        transform="rotate(${d} 110 60)"></line>`,
    )
    .join('');
  return svg(`<g fill="none">
    <circle cx="110" cy="60" r="36" stroke="${c}" stroke-opacity="0.8" stroke-width="2" fill="${T.sunk}"></circle>
    ${ticks}
    ${arc ? `<path d="M 110 24 A 36 36 0 0 1 141 78" stroke="${a}" stroke-width="3.5" stroke-opacity="0.85" stroke-linecap="round" style="animation:es-fadein .8s ease .8s both"></path>` : ''}
    <line x1="110" y1="60" x2="110" y2="34" stroke="${a}" stroke-width="3" stroke-linecap="round"
      style="animation:es-hand 2.6s cubic-bezier(.6,0,.3,1) forwards;transform-origin:110px 60px"></line>
    <line x1="110" y1="60" x2="94" y2="68" stroke="${c}" stroke-opacity="0.7" stroke-width="2.5" stroke-linecap="round"></line>
    <circle cx="110" cy="60" r="3.5" fill="${c}"></circle>
  </g>`);
}

// es-heroes.jsx HeroCalendar — verbatim (the board demo animates only the
// date-tile pop; there is no separate underline element in the JSX).
export function heroCalendar() {
  const c = T.ink;
  const a = T.status.info.fg;
  const dots = [[88, 60], [104, 60], [120, 60], [88, 74], [120, 74]]
    .map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="2" fill="${c}" fill-opacity="0.35" stroke="none"></circle>`)
    .join('');
  return svg(`<g fill="none" stroke="${c}" stroke-opacity="0.8" stroke-width="2">
    <rect x="74" y="30" width="72" height="62" rx="8" fill="${T.sunk}"></rect>
    <line x1="74" y1="48" x2="146" y2="48"></line>
    <line x1="92" y1="22" x2="92" y2="36" stroke-linecap="round"></line>
    <line x1="128" y1="22" x2="128" y2="36" stroke-linecap="round"></line>
    ${dots}
    <rect x="98" y="66" width="16" height="16" rx="4" fill="${T.status.info.bg}" stroke="${a}" stroke-width="2"
      style="animation:es-pop .5s cubic-bezier(.2,.7,.3,1.3) .4s both;transform-origin:106px 74px"></rect>
  </g>`);
}

// es-heroes.jsx HeroBars — verbatim (the exception bar is amber-filled, as in
// the JSX / board demo).
export function heroBars() {
  const c = T.ink;
  const w = T.status.warn.fg;
  const bars = [[66, 38], [90, 52], [114, 30], [138, 58], [162, 44]]
    .map(
      (b, i) => `<rect x="${b[0]}" y="${92 - b[1]}" width="14" height="${b[1]}" rx="3" fill="${i === 3 ? w : c}" fill-opacity="${i === 3 ? 0.85 : 0.6}"
        style="animation:es-rise .7s cubic-bezier(.2,.7,.3,1) ${(i * 0.1).toFixed(1)}s both;transform-origin:${b[0] + 7}px 92px"></rect>`,
    )
    .join('');
  return svg(`<g>${bars}
    <line x1="56" y1="92" x2="186" y2="92" stroke="${c}" stroke-opacity="0.35" stroke-width="2" stroke-linecap="round"></line>
  </g>`);
}

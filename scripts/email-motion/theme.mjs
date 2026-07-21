// Light theme tokens — verbatim from docs/design/email-system/es-tokens.js (light).
// GIFs bake the LIGHT sunk background per plan pinned decision 4.
export const LIGHT = {
  sunk: '#eeece5',
  ink: '#0c0c0e',
  status: {
    ok: { fg: '#2f6a4a', bg: '#e6efe7' },
    info: { fg: '#3f5f78', bg: '#e4ebf0' },
    warn: { fg: '#7a5a1f', bg: '#f0e7d2' },
    err: { fg: '#8a3d33', bg: '#f2e1dc' },
  },
};

// The es-* keyframes, verbatim from docs/design/email-system/es-core.jsx:214-225
// (the one-time <style id="es-anim-css"> block motion-board.html injects).
// Production additions, each justified by a MOTION-row behavior the live-preview
// CSS could not express (documented in README.md):
//   es-click     lock row: "Shackle clicks shut once" (no shackle animation in JSX)
//   es-march-p   route rows: 1.6s -> 1.8s so the dash period divides the 3.6s
//                travel cycle and the infinite GIF loops seamlessly
export const KEYFRAMES_CSS = `
@keyframes es-ring{0%{transform:scale(0.55);opacity:0.9}80%{transform:scale(1.5);opacity:0}100%{transform:scale(1.5);opacity:0}}
@keyframes es-drop{0%{transform:translateY(-14px);opacity:0}60%{transform:translateY(2px);opacity:1}100%{transform:translateY(0);opacity:1}}
@keyframes es-fadein{from{opacity:0}to{opacity:1}}
@keyframes es-draw{to{stroke-dashoffset:0}}
@keyframes es-travel{0%{transform:translateX(0)}45%,55%{transform:translateX(var(--es-tx,240px))}100%{transform:translateX(var(--es-tx2,480px))}}
@keyframes es-march{to{stroke-dashoffset:-24px}}
@keyframes es-scan{0%,100%{transform:translateX(-46px)}50%{transform:translateX(46px)}}
@keyframes es-swing{0%,100%{transform:rotate(5deg)}50%{transform:rotate(-5deg)}}
@keyframes es-rise{from{transform:scaleY(0.06)}to{transform:scaleY(1)}}
@keyframes es-hand{0%{transform:rotate(0deg)}45%,100%{transform:rotate(80deg)}}
@keyframes es-pop{0%{transform:scale(0.6);opacity:0}70%{transform:scale(1.06);opacity:1}100%{transform:scale(1)}}
@keyframes es-blinkonce{0%,40%{opacity:0}60%,100%{opacity:1}}
@keyframes es-click{0%{transform:translateY(-6px)}60%{transform:translateY(1.5px)}100%{transform:translateY(0)}}
@keyframes es-march-p{to{stroke-dashoffset:-24px}}
`;

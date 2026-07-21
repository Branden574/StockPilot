// Builds the self-contained capture page for one asset: the inline SVG hero on
// the light sunk canvas (#eeece5), composed exactly as motion-board.html
// presents heroes (ESHeroBox: sunk background, hero centered, 220x120 SVG at
// 120/140 of the box height -> 691x377 on the 1200x440 @2x canvas).
import { KEYFRAMES_CSS, LIGHT } from './theme.mjs';
import { CANVAS } from './assets.mjs';

export function buildPage(asset) {
  const canvas = asset.canvas ?? CANVAS;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>StockPilot email motion — ${asset.id}</title>
<style>
  html, body { margin: 0; padding: 0; }
  html { background: transparent; }
  body {
    width: ${canvas.width}px; height: ${canvas.height}px; overflow: hidden;
    background: ${asset.transparent ? 'transparent' : LIGHT.sunk};
    display: flex; align-items: center; justify-content: center;
  }
  ${KEYFRAMES_CSS}
  /* Rest state = the design's reduced-motion fallback (es-core.jsx applies
     animation:none under prefers-reduced-motion) + finished dash draws. */
  .es-rest * { animation: none !important; }
  .es-rest .draw { stroke-dashoffset: 0 !important; }
</style>
</head>
<body>
${asset.hero()}
</body>
</html>
`;
}

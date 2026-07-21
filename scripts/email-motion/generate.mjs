// StockPilot email motion pipeline — regenerates every committed GIF + the
// frame-1 previews + the logo marks. See README.md. Run from anywhere:
//   node scripts/email-motion/generate.mjs [assetId ...]
//
// Requires: workspace deps installed (Playwright chromium via apps/web),
// ImageMagick (`magick`) and gifsicle on PATH (brew install imagemagick gifsicle).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSETS, CANVAS, frameplan } from './assets.mjs';
import { buildPage } from './page.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PAGES_DIR = path.join(HERE, 'pages');
const PREVIEW_DIR = path.join(HERE, 'preview');
const OUT_DIR = path.join(REPO, 'apps/web/public/email/motion');
const LOGO_DIR = path.join(REPO, 'apps/web/public/email');
const WORK_DIR = process.env.EMAIL_MOTION_WORK
  || fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'email-motion-'));

// Playwright is a devDependency of apps/web; resolve it from there so the
// pipeline needs no dependencies of its own.
const requireWeb = createRequire(path.join(REPO, 'apps/web/package.json'));
const { chromium } = requireWeb('@playwright/test');

// Size-fitting ladder: these are flat line drawings, so shrink the palette
// first and only then reach for lossy LZW.
const FIT_LADDER = [
  { colors: 96, lossy: 0 },
  { colors: 64, lossy: 0 },
  { colors: 64, lossy: 30 },
  { colors: 48, lossy: 30 },
  { colors: 48, lossy: 60 },
  { colors: 32, lossy: 80 },
];

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
}

async function captureAsset(page, asset) {
  const { nFrames, stepMs } = frameplan(asset);
  const dir = path.join(WORK_DIR, asset.id);
  fs.mkdirSync(dir, { recursive: true });

  const pageFile = path.join(PAGES_DIR, `${asset.id}.html`);
  await page.goto(`file://${pageFile}`);

  const canvas = asset.canvas ?? CANVAS;
  const clip = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const omitBackground = !!asset.transparent;
  const restPath = path.join(dir, 'rest.png');

  if (asset.prependRest || asset.endHold === 'restFrame') {
    await page.evaluate(() => document.documentElement.classList.add('es-rest'));
    await page.screenshot({ path: restPath, clip, omitBackground });
    await page.evaluate(() => document.documentElement.classList.remove('es-rest'));
  }

  // Deterministic frames: pause every animation, seek the shared timeline.
  await page.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
  const framePaths = [];
  for (let i = 0; i < nFrames; i++) {
    const t = asset.captureFromMs + i * stepMs;
    await page.evaluate((ms) => {
      document.getAnimations().forEach((a) => { a.currentTime = ms; });
    }, t);
    const p = path.join(dir, `f-${String(i).padStart(3, '0')}.png`);
    await page.screenshot({ path: p, clip, omitBackground });
    framePaths.push(p);
  }
  return { framePaths, restPath, dir };
}

function assembleAsset(asset, framePaths, restPath) {
  const { delayCs } = frameplan(asset);
  // [{png, delayCs}] — frame 1 obeys MOTION_GLOBAL.firstFrame (rest state).
  const seq = [];
  if (asset.prependRest) seq.push({ png: restPath, delay: asset.restDelayCs });
  for (const p of framePaths) seq.push({ png: p, delay: delayCs });
  // The breathing pause: where each infinite cycle holds composed.
  if (asset.endHold === 'lastFrame') {
    // The final capture IS the settled state (play-once boards, swept clock).
    seq[seq.length - 1].delay = asset.endDelayCs;
  } else if (asset.endHold === 'restFrame') {
    // Periodic cycles (pulse/scanner/tag) end mid-motion — append the
    // composed rest frame to carry the pause.
    seq.push({ png: restPath, delay: asset.endDelayCs });
  } // endHold 'none': seamless continuous cycle, uniform delays.

  const rawGif = path.join(WORK_DIR, asset.id, 'raw.gif');
  const outGif = path.join(OUT_DIR, asset.file);
  const imArgs = [];
  // Transparent frames must clear to background between frames or the ring
  // pulse smears (previous frame shows through the transparency). -dispose
  // is a SETTING: it must precede the frames it applies to.
  if (asset.transparent) imArgs.push('-dispose', 'Background');
  for (const f of seq) imArgs.push('-delay', String(f.delay), f.png);
  imArgs.push('-loop', String(asset.netscapeLoop), rawGif);
  run('magick', imArgs);

  let fit = null;
  for (const step of FIT_LADDER) {
    const args = ['-O3', '--no-warnings', `--colors=${step.colors}`];
    if (step.lossy > 0) args.push(`--lossy=${step.lossy}`);
    args.push(`--loopcount=${asset.netscapeLoop}`, rawGif, '-o', outGif);
    run('gifsicle', args);
    const size = fs.statSync(outGif).size;
    if (size <= asset.maxBytes) { fit = { ...step, size }; break; }
    fit = { ...step, size };
  }
  if (fit.size > asset.maxBytes) {
    throw new Error(`${asset.file}: ${fit.size} bytes exceeds cap ${asset.maxBytes} after full fit ladder`);
  }
  return fit;
}

function extractPreview(asset) {
  const outGif = path.join(OUT_DIR, asset.file);
  const preview = path.join(PREVIEW_DIR, `${asset.id}.png`);
  run('magick', [`${outGif}[0]`, preview]);
}

// Logo marks: derived from apps/web/src/app/icon.svg (Mark D - Stencil Frame),
// exported @2x (44x44) for a 22x22 display size, transparent background.
// light = ink mark for light headers; dark = paper mark for dark-mode headers.
const LOGO_MARK = (fill) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}</style></head>
<body><svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 100 100">
  <defs>
    <mask id="m" maskUnits="userSpaceOnUse">
      <rect width="100" height="100" fill="white"/>
      <path d="M 32 78 Q 72 78 72 66 Q 72 54 54 54 Q 32 54 32 42 Q 32 24 72 24"
        stroke="black" stroke-width="11" stroke-linecap="round" fill="none"/>
      <circle cx="72" cy="24" r="6" fill="black"/>
    </mask>
  </defs>
  <rect x="12" y="12" width="76" height="76" rx="16" fill="${fill}" mask="url(#m)"/>
</svg></body></html>`;

async function exportLogos(page) {
  const marks = [
    { file: 'logo-mark-light.png', fill: '#0c0c0e' },
    { file: 'logo-mark-dark.png', fill: '#f6f4ef' },
  ];
  for (const mark of marks) {
    const tmp = path.join(WORK_DIR, mark.file.replace('.png', '.html'));
    fs.writeFileSync(tmp, LOGO_MARK(mark.fill));
    await page.goto(`file://${tmp}`);
    await page.screenshot({
      path: path.join(LOGO_DIR, mark.file),
      clip: { x: 0, y: 0, width: 44, height: 44 },
      omitBackground: true,
    });
    console.log(`  ${mark.file}  44x44`);
  }
}

async function main() {
  const only = process.argv.slice(2);
  const assets = only.length ? ASSETS.filter((a) => only.includes(a.id)) : ASSETS;
  if (only.length && assets.length !== only.length) {
    throw new Error(`Unknown asset id(s): ${only.filter((id) => !ASSETS.some((a) => a.id === id)).join(', ')}`);
  }

  for (const dir of [PAGES_DIR, PREVIEW_DIR, OUT_DIR, LOGO_DIR]) fs.mkdirSync(dir, { recursive: true });
  for (const asset of ASSETS) {
    fs.writeFileSync(path.join(PAGES_DIR, `${asset.id}.html`), buildPage(asset));
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: CANVAS.width, height: CANVAS.height },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();

  const rows = [];
  for (const asset of assets) {
    const { nFrames, delayCs } = frameplan(asset);
    process.stdout.write(`  ${asset.file} ... `);
    const { framePaths, restPath } = await captureAsset(page, asset);
    const fit = assembleAsset(asset, framePaths, restPath);
    extractPreview(asset);
    const frames = nFrames + (asset.prependRest ? 1 : 0)
      + (asset.endHold === 'restFrame' ? 1 : 0);
    console.log(`${(fit.size / 1024).toFixed(0)} KB, ${frames} frames, ${delayCs}cs/frame, loop=${asset.netscapeLoop}, colors=${fit.colors}${fit.lossy ? `, lossy=${fit.lossy}` : ''}`);
    rows.push({ file: asset.file, kb: +(fit.size / 1024).toFixed(1), frames, delayCs, loop: asset.netscapeLoop, colors: fit.colors, lossy: fit.lossy });
  }

  if (!only.length) await exportLogos(page);
  await browser.close();
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });

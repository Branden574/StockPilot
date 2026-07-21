// Standalone validator for the committed email motion assets.
//   node scripts/email-motion/validate.ts        (Node >= 22.18, type stripping)
// Same assertions as apps/web/src/lib/email/motion-assets.test.ts, which runs
// in the web vitest suite; this CLI is the quick post-generate check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOGO_MARK_FILES,
  LOGO_MARK_SIZE,
  MOTION_ASSET_SPECS,
  parseGif,
  parsePngSize,
  validateMotionGif,
} from '../../apps/web/src/lib/email/motion-spec.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MOTION_DIR = path.join(REPO, 'apps/web/public/email/motion');
const EMAIL_DIR = path.join(REPO, 'apps/web/public/email');

let failures = 0;

console.log('file                 size KB  frames  loop  dims');
for (const spec of MOTION_ASSET_SPECS) {
  const file = path.join(MOTION_DIR, spec.file);
  if (!fs.existsSync(file)) {
    console.error(`FAIL ${spec.file}: missing — run node scripts/email-motion/generate.mjs`);
    failures += 1;
    continue;
  }
  const buf = fs.readFileSync(file);
  const errors = validateMotionGif(spec, buf);
  const info = parseGif(buf);
  console.log(
    `${spec.file.padEnd(20)} ${(buf.byteLength / 1024).toFixed(1).padStart(7)} ${String(info.frameCount).padStart(7)} ${String(info.loopCount ?? '-').padStart(5)}  ${info.width}x${info.height}${errors.length ? '  FAIL' : ''}`,
  );
  for (const err of errors) console.error(`  ${err}`);
  failures += errors.length;
}

for (const logo of LOGO_MARK_FILES) {
  const p = path.join(EMAIL_DIR, logo);
  if (!fs.existsSync(p)) {
    console.error(`FAIL ${logo}: missing`);
    failures += 1;
    continue;
  }
  const { width, height } = parsePngSize(fs.readFileSync(p));
  const ok = width === LOGO_MARK_SIZE && height === LOGO_MARK_SIZE;
  console.log(`${logo.padEnd(20)} ${width}x${height}${ok ? '' : '  FAIL'}`);
  if (!ok) failures += 1;
}

if (failures > 0) {
  console.error(`\n${failures} violation(s)`);
  process.exit(1);
}
console.log('\nAll motion assets valid.');

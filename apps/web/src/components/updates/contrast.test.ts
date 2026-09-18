// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The What's New surfaces promise 4.5:1 text contrast in both themes. The
 * editorial ink scale has steps that do not meet it (--ed-ink-4 measured
 * 3.3:1 on a light card and 3.45:1 on a dark one), and they read fine to the
 * eye, so nothing but a measurement catches them. This pins both halves: the
 * new files never colour text with a failing step, and the step they do use
 * still measures 4.5:1 against the card it sits on.
 */

const WEB_ROOT = join(__dirname, '..', '..', '..');
const SURFACES = [
  join(WEB_ROOT, 'src/components/updates'),
  join(WEB_ROOT, 'src/app/(dashboard)/dashboard/whats-new'),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [full] : [];
  });
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function hslToHex(triplet: string): string {
  const [h, s, l] = triplet.replace(/%/g, '').split(/\s+/).map(Number) as [number, number, number];
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number) =>
    Math.round(255 * (light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** Every declared value of one custom property, in source order: [light, dark]. */
function tokenValues(css: string, name: string): string[] {
  return [...css.matchAll(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'gm'))].map((m) => m[1]!.trim());
}

describe("What's New text contrast", () => {
  it('never colours text with an ink step that fails 4.5:1', () => {
    const offenders = SURFACES.flatMap(sourceFiles).filter((file) =>
      /text-\[var\(--ed-ink-[45]\)\]|text-ink-[45]\b/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the label ink at 4.5:1 or better on the card, light and dark', () => {
    const css = readFileSync(join(WEB_ROOT, 'src/app/globals.css'), 'utf8');
    const ink = tokenValues(css, '--ed-ink-3');
    const card = tokenValues(css, '--card').map(hslToHex);
    expect(ink).toHaveLength(2);
    expect(card).toHaveLength(2);
    expect(contrast(ink[0]!, card[0]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ink[1]!, card[1]!)).toBeGreaterThanOrEqual(4.5);
  });

  it('measures the step it replaced as failing, so the rule above is not vacuous', () => {
    const css = readFileSync(join(WEB_ROOT, 'src/app/globals.css'), 'utf8');
    const ink = tokenValues(css, '--ed-ink-4');
    const card = tokenValues(css, '--card').map(hslToHex);
    expect(contrast(ink[0]!, card[0]!)).toBeLessThan(4.5);
    expect(contrast(ink[1]!, card[1]!)).toBeLessThan(4.5);
  });
});

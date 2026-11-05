// @vitest-environment node
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import postcss from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SCENE_OUTPUTS } from '../../../../../scripts/liquid-glass/install-scene.mjs';

import { enclosing, GLASS_ROOT, inMedia, splitSelectors } from './glass-css';
import {
  isScenePhotoBuilt,
  isScenePhotoInstalled,
  SCENE_PHOTO_FLAG_NAME,
  SCENE_PUBLIC_PATH,
  SCENE_WEB_FILES,
  scenePhotoCss,
} from './scene-photo';

/**
 * The scene photo wiring (FOLLOWUPS SC1; the photos are never committed): the
 * build turns the photo on only when install-scene.mjs put every web file in
 * apps/web/public/liquid-glass; otherwise nothing references them and the
 * opaque --bg shows, as before.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

const web = join(__dirname, '..', '..', '..');

describe('the scene photo', () => {
  it('needs exactly the web files install-scene.mjs writes', () => {
    const written = SCENE_OUTPUTS.filter((o) => o.app === 'web');
    for (const o of written)
      expect(o.path.startsWith(join('apps', 'web', 'public', 'liquid-glass'))).toBe(true);
    expect([...SCENE_WEB_FILES].sort()).toEqual(written.map((o) => basename(o.path)).sort());
    expect(SCENE_PUBLIC_PATH).toBe('/liquid-glass');
  });

  it('is installed only when every file is there', () => {
    expect(isScenePhotoInstalled(() => true)).toBe(true);
    expect(isScenePhotoInstalled(() => false)).toBe(false);
    for (const missing of SCENE_WEB_FILES) {
      expect(
        isScenePhotoInstalled((name) => name !== missing),
        missing,
      ).toBe(false);
    }
  });

  it('is built in only when next.config.ts inlined exactly 1', () => {
    expect(SCENE_PHOTO_FLAG_NAME).toBe('NEXT_PUBLIC_LIQUID_GLASS_SCENE');
    for (const value of ['', '0', 'true', 'yes']) {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS_SCENE', value);
      expect(isScenePhotoBuilt(), value).toBe(false);
    }
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS_SCENE', '1');
    expect(isScenePhotoBuilt()).toBe(true);
  });

  it('next.config.ts inlines the flag from the installed files, with the literal access the bundle needs', () => {
    const config = readFileSync(join(web, 'next.config.ts'), 'utf8');
    expect(config).toMatch(/NEXT_PUBLIC_LIQUID_GLASS_SCENE:\s*LIQUID_GLASS_SCENE/u);
    expect(config).toContain('isScenePhotoInstalled(');
    expect(readFileSync(join(__dirname, 'scene-photo.ts'), 'utf8')).toContain(
      'process.env.NEXT_PUBLIC_LIQUID_GLASS_SCENE',
    );
  });

  it('its inline style only sets --lg-scene-photo, on screen, on the glass root, Day and Night', () => {
    const tree = postcss.parse(scenePhotoCss());
    const seen: string[] = [];
    tree.walkRules((rule) => {
      expect(inMedia(rule, 'screen')).toBe(true);
      expect(enclosing(rule).some((a) => a.startsWith('@layer'))).toBe(false);
      for (const selector of splitSelectors(rule.selector)) {
        expect(GLASS_ROOT.test(selector), selector).toBe(true);
        seen.push(selector);
      }
      rule.walkDecls((d) => {
        expect(d.prop).toBe('--lg-scene-photo');
        expect(d.value).toMatch(/^image-set\(/u);
      });
    });
    expect(seen).toEqual([
      ':root[data-appearance="liquid-glass"]',
      ':root[data-appearance="liquid-glass"].dark',
    ]);
  });

  it('references only the installed files: light for Day, dark for Night, AVIF and WebP first', () => {
    const css = scenePhotoCss();
    const urls = [...css.matchAll(/url\("([^"]+)"\)/gu)].map((m) => m[1]!);
    expect(urls).toHaveLength(SCENE_WEB_FILES.length);
    expect([...urls].sort()).toEqual(SCENE_WEB_FILES.map((f) => `/liquid-glass/${f}`).sort());
    const [day, night] = css.split('.dark{');
    expect(day).not.toContain('scene-dark');
    expect(night).not.toContain('scene-light');
    expect(day!.indexOf('avif')).toBeLessThan(day!.indexOf('webp'));
    expect(day!.indexOf('webp')).toBeLessThan(day!.indexOf('.jpg'));
  });
});

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { REPO_ROOT, SCENE_OUTPUTS } from '../../../../../../scripts/liquid-glass/install-scene.mjs';

vi.mock('react-native', () => ({}));

/**
 * The phone's scene photos (FOLLOWUPS SC1, standing rule): the repository is
 * public and the photos' source is not confirmed, so they are never
 * committed. scripts/liquid-glass/install-scene.mjs writes the pre-blurred
 * phone copies into apps/mobile/assets/liquid-glass/ (git-ignored), and the
 * app loads them from exactly there through OPTIONAL requires: Metro (Expo
 * sets allowOptionalDependencies) bundles a require inside a try block even
 * when the file is missing, and it throws at run time instead, so a checkout
 * without the photos (CI, any clone) builds and draws the opaque --bg, as
 * before.
 */
const HERE = __dirname;
const code = readFileSync(path.join(HERE, 'scene-assets.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const phone = SCENE_OUTPUTS.filter((o) => o.app === 'phone');

describe('the phone scene photos', () => {
  it('are required from exactly the paths the install script writes, one optional require per scheme', () => {
    expect(phone.map((o) => o.scheme).sort()).toEqual(['dark', 'light']);
    for (const output of phone) {
      const rel = path.relative(HERE, path.join(REPO_ROOT, output.path)).split(path.sep).join('/');
      const call = `require('${rel}')`;
      expect(code, output.scheme).toContain(call);
      // Directly inside a try block (Metro's optional-dependency rule).
      const at = code.indexOf(call);
      const before = code.slice(0, at);
      expect(before.lastIndexOf('try {'), output.scheme).toBeGreaterThan(before.lastIndexOf('}'));
    }
    expect((code.match(/require\(/g) ?? []).length).toBe(phone.length);
  });

  it('are never committed: every phone path is ignored by git and not tracked', () => {
    for (const output of phone) {
      expect(() =>
        execFileSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', output.path], {
          stdio: 'ignore',
        }),
      ).not.toThrow();
      const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', output.path], {
        encoding: 'utf8',
      });
      expect(tracked, output.path).toBe('');
    }
  });

  it('without the files the scene is null, so SceneBackground draws the opaque --bg', async () => {
    const { SCENE_IMAGES } = await import('./scene-assets');
    expect(SCENE_IMAGES).toEqual({ day: null, night: null });
  });

  it('SceneBackground draws a photo only when the theme says so and the file is there', () => {
    const bg = readFileSync(path.join(HERE, 'scene-background.tsx'), 'utf8').replace(/\s+/g, ' ');
    expect(bg).toContain('const { scene, mode, c } = useTheme();');
    expect(bg).toContain(
      "const source = scene ? (mode === 'dark' ? SCENE_IMAGES.night : SCENE_IMAGES.day) : null;",
    );
    expect(bg).toContain('style={[StyleSheet.absoluteFill, { backgroundColor: c.paper }]}');
    expect(bg).toContain('{source ? (');
  });
});

import { describe, expect, it, vi } from 'vitest';

import { SceneBackground } from './scene-background';

/**
 * SceneBackground draws the iOS boards' ground (spec/design-system.md 13,
 * "iOS glass"; sp.css:1040-1041): from the bottom, the opaque ground, the
 * scene at `42% center / cover`, the 180deg wash (Day warm white .30, .10 at
 * 40%, .36; Night black .25, .05 at 40%, .35), then the scheme's veil (Day
 * rgba(255,250,242) .06 to .02; Night rgba(6,10,9) .18 to .30).
 *
 * No React Native renderer here (the glass-surface.test.ts method): the
 * component is called as a function, react-native, expo-image and
 * expo-linear-gradient are stand-ins that are only their names, and the
 * theme is set per case.
 */
const env = vi.hoisted(() => ({ theme: null as unknown }));
vi.mock('react-native', () => ({
  View: 'View',
  // React Native's own Image only centres a cover image; the scene is never drawn with it.
  Image: 'RNImage',
  StyleSheet: { create: (s: unknown) => s, absoluteFill: { position: 'absolute' } },
}));
vi.mock('expo-image', () => ({ Image: 'ExpoImage' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('../../../lib/use-theme', () => ({ useTheme: () => env.theme }));
vi.mock('./scene-assets', () => ({ SCENE_IMAGES: { day: 11, night: 12 } }));

type Node = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

/** Every element under `n`, depth first, fragments and arrays flattened. */
function nodes(n: unknown): Node[] {
  if (Array.isArray(n)) return n.flatMap(nodes);
  if (typeof n !== 'object' || n === null || !('type' in n)) return [];
  const node = n as Node;
  const inner = nodes(node.props.children);
  return typeof node.type === 'string' ? [node, ...inner] : inner;
}

const theme = (mode: 'light' | 'dark', scene = true) => ({
  scene,
  mode,
  c: { paper: mode === 'dark' ? '#0E100F' : '#F2F3F1' },
});

describe('SceneBackground', () => {
  it('Day: the day file at 42% across and centred down, by cover, under the warm wash and the warm veil', () => {
    env.theme = theme('light');
    const root = SceneBackground() as Node;
    expect(root.type).toBe('View');
    expect(root.props.pointerEvents).toBe('none');
    const drawn = nodes(root).slice(1);
    expect(drawn.map((n) => n.type)).toEqual(['ExpoImage', 'LinearGradient', 'LinearGradient']);
    const [image, wash, veil] = drawn as [Node, Node, Node];
    expect(image.props).toMatchObject({
      source: 11,
      contentFit: 'cover',
      contentPosition: { left: '42%', top: '50%' },
    });
    expect(wash.props).toMatchObject({
      colors: ['rgba(255,250,244,0.30)', 'rgba(255,250,244,0.10)', 'rgba(255,250,244,0.36)'],
      locations: [0, 0.4, 1],
    });
    expect(veil.props).toMatchObject({
      colors: ['rgba(255,250,242,0.06)', 'rgba(255,250,242,0.02)'],
    });
    // Both run top to bottom, the 180deg of the board (expo-linear-gradient's default).
    for (const g of [wash, veil]) {
      expect(g.props.start).toBeUndefined();
      expect(g.props.end).toBeUndefined();
    }
  });

  it('Night: the night file at the same place, under the black wash and the ink veil', () => {
    env.theme = theme('dark');
    const [image, wash, veil] = nodes(SceneBackground()).slice(1) as [Node, Node, Node];
    expect(image.props).toMatchObject({
      source: 12,
      contentFit: 'cover',
      contentPosition: { left: '42%', top: '50%' },
    });
    expect(wash.props).toMatchObject({
      colors: ['rgba(0,0,0,0.25)', 'rgba(0,0,0,0.05)', 'rgba(0,0,0,0.35)'],
      locations: [0, 0.4, 1],
    });
    expect(veil.props).toMatchObject({ colors: ['rgba(6,10,9,0.18)', 'rgba(6,10,9,0.30)'] });
  });

  it('no scene (classic, Reduce Transparency, Android): the opaque ground alone, no picture, wash or veil', () => {
    for (const mode of ['light', 'dark'] as const) {
      env.theme = theme(mode, false);
      const root = SceneBackground() as Node;
      expect(nodes(root).map((n) => n.type)).toEqual(['View']);
      expect(
        Object.assign({}, ...[root.props.style].flat().filter(Boolean)) as {
          backgroundColor?: string;
        },
      ).toMatchObject({ backgroundColor: theme(mode).c.paper });
    }
  });
});

import { describe, expect, it, vi } from 'vitest';

import { GLASS_IOS_TOKENS, GLASS_TOKENS } from '../../../lib/appearance/glass-tokens.generated';
import { GLASS_DAY, palette } from '../../../lib/theme';
import { GlassSurface } from './glass-surface';

/**
 * GlassSurface picks its material and never fails to draw (plan 5.2, 5.5):
 * with the glass module absent it is a BlurView (or the solid fallback for the
 * tab bar), under Reduce Transparency and on Android the opaque token, and
 * content surfaces are never a live blur.
 *
 * No React Native renderer here (the touch-target.test.ts method): the
 * component is called as a function, react-native and expo-blur are stand-ins
 * that are only their names, and the theme is set per case.
 */
const env = vi.hoisted(() => ({
  theme: null as unknown,
  glassView: null as unknown,
}));
vi.mock('react-native', () => ({
  View: 'View',
  StyleSheet: {
    create: (s: unknown) => s,
    hairlineWidth: 0.5,
    absoluteFill: { position: 'absolute' },
  },
}));
vi.mock('expo-blur', () => ({ BlurView: 'BlurView' }));
vi.mock('../../../lib/use-theme', () => ({ useTheme: () => env.theme }));
vi.mock('../../../lib/appearance/glass-module', () => ({ GlassViewOrNull: () => env.glassView }));

type Node = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

const glassTheme = (material: 'glass' | 'blur' | 'opaque') => ({
  c: GLASS_DAY,
  g: material === 'opaque' ? GLASS_TOKENS.dayOpaque : GLASS_TOKENS.day,
  ios: GLASS_IOS_TOKENS.light,
  material,
  mode: 'light',
});

function types(n: unknown): unknown[] {
  if (Array.isArray(n)) return n.flatMap(types);
  if (typeof n !== 'object' || n === null || !('type' in n)) return [];
  const node = n as Node;
  return [node.type, ...types(node.props.children)];
}

const flatStyle = (n: Node) =>
  Object.assign({}, ...[n.props.style].flat(3).filter((s) => s && typeof s === 'object'));

describe('GlassSurface', () => {
  it('iOS 26 with the module: a GlassView, regular, interactive when floating, in the scheme', () => {
    env.theme = glassTheme('glass');
    env.glassView = 'GlassView';
    const n = GlassSurface({ variant: 'floating', radius: 32 }) as Node;
    expect(n.type).toBe('GlassView');
    expect(n.props).toMatchObject({
      glassEffectStyle: 'regular',
      isInteractive: true,
      colorScheme: 'light',
    });
  });

  it('the glass module ABSENT: the BlurView path, systemMaterial at 80, and nothing throws', () => {
    env.theme = glassTheme('glass');
    env.glassView = null;
    const n = GlassSurface({ variant: 'floating', radius: 32 }) as Node;
    expect(types(n)).toContain('BlurView');
    const blur = (n.props.children as Node[]).find((c) => c?.type === 'BlurView')!;
    expect(blur.props).toMatchObject({ tint: 'systemMaterial', intensity: 80 });
  });

  it('below iOS 26 (blur): a BlurView, but the tab bar takes the solid fallback', () => {
    env.theme = glassTheme('blur');
    env.glassView = null;
    expect(types(GlassSurface({ variant: 'overlay', radius: 36 }))).toContain('BlurView');
    const solid = GlassSurface({ variant: 'floating', radius: 32, solid: true }) as Node;
    expect(types(solid)).not.toContain('BlurView');
    expect(flatStyle(solid).backgroundColor).toBe(GLASS_IOS_TOKENS.light.card);
  });

  it('Reduce Transparency and Android (opaque): the opaque chrome, no blur, no GlassView', () => {
    env.theme = glassTheme('opaque');
    env.glassView = 'GlassView';
    const n = GlassSurface({ variant: 'floating', radius: 32 }) as Node;
    expect(types(n)).not.toContain('BlurView');
    expect(types(n)).not.toContain('GlassView');
    expect(flatStyle(n).backgroundColor).toBe(GLASS_TOKENS.dayOpaque.chrome);
  });

  it('content is never a live blur: the card fill and line, in every material', () => {
    env.glassView = 'GlassView';
    for (const material of ['glass', 'blur', 'opaque'] as const) {
      env.theme = glassTheme(material);
      const n = GlassSurface({ variant: 'content', radius: 24 }) as Node;
      expect(types(n), material).toEqual(['View']);
      expect(flatStyle(n).backgroundColor).toBe(glassTheme(material).g.cardFill);
    }
  });

  // LG-1: over the Scan camera the tab capsule is drawn in the Night scheme
  // whatever the theme is, so the surface takes a scheme of its own.
  it('a scheme of its own: the GlassView, the solid bar and the opaque bar are drawn in it', () => {
    const day = (material: 'glass' | 'blur' | 'opaque') => ({
      ...glassTheme(material),
      style: 'liquid-glass',
      scene: material !== 'opaque',
    });
    env.theme = day('glass');
    env.glassView = 'GlassView';
    const glass = GlassSurface({ variant: 'floating', radius: 32, scheme: 'dark' }) as Node;
    expect(glass.type).toBe('GlassView');
    expect(glass.props.colorScheme).toBe('dark');

    env.theme = day('blur');
    env.glassView = null;
    const solid = GlassSurface({
      variant: 'floating',
      radius: 32,
      solid: true,
      scheme: 'dark',
    }) as Node;
    expect(flatStyle(solid).backgroundColor).toBe(GLASS_IOS_TOKENS.dark.card);

    env.theme = day('opaque');
    const opaque = GlassSurface({ variant: 'floating', radius: 32, scheme: 'dark' }) as Node;
    expect(flatStyle(opaque).backgroundColor).toBe(GLASS_TOKENS.nightOpaque.chrome);

    // The theme's own scheme asked for by name changes nothing.
    env.theme = day('glass');
    env.glassView = 'GlassView';
    const same = GlassSurface({ variant: 'floating', radius: 32, scheme: 'light' }) as Node;
    expect(same.props.colorScheme).toBe('light');
  });

  it('in classic (never asked for glass) it still draws a readable classic card', () => {
    env.theme = { c: palette('dark'), g: null, ios: null, material: 'opaque', mode: 'dark' };
    const n = GlassSurface({ variant: 'floating', radius: 10 }) as Node;
    expect(flatStyle(n).backgroundColor).toBe(palette('dark').card);
  });
});

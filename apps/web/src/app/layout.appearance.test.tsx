import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The root layout and the Liquid Glass rollout (plan 2.1; REVISION-DEFAULT
 * R5, R6). Under `off` the server HTML carries no appearance script and no
 * data-appearance at all; under `opt-in` and `default`, the rollout's one head
 * script, recognised by its text, is the only addition (plus the scene photo
 * style when the build found the photos), and <html> still carries no
 * appearance on the server (the script sets it in the browser, from the
 * cookie). No route reads the cookie on the server, so the HTML is the same
 * for every visitor (appearance-render.guard.test.ts).
 */

vi.mock('next/font/google', () => {
  const font = () => ({ variable: 'font-var', className: 'font' });
  return { Inter: font, Inter_Tight: font, Instrument_Serif: font, JetBrains_Mono: font };
});
vi.mock('./globals.css', () => ({}));
vi.mock('../styles/liquid-glass/globals.glass.css', () => ({}));
vi.mock('@/components/analytics/posthog-provider', () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/perf/web-vitals-reporter', () => ({ WebVitalsReporter: () => null }));
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
vi.mock('@/server/actions/appearance', () => ({
  getMyAppearanceAction: vi.fn(),
  setMyAppearanceAction: vi.fn(),
}));

import { appearanceScript } from '@/components/theme/appearance-script';
import { scenePhotoCss } from '@/styles/liquid-glass/scene-photo';

import RootLayout from './layout';

afterEach(() => {
  vi.unstubAllEnvs();
});

const page = () =>
  renderToStaticMarkup(
    <RootLayout>
      <p>the page</p>
    </RootLayout>,
  );

const escaped = (text: string) =>
  renderToStaticMarkup(<script dangerouslySetInnerHTML={{ __html: text }} />)
    .replace(/^<script>/u, '')
    .replace(/<\/script>$/u, '');

describe('root layout and the Liquid Glass rollout (REVISION-DEFAULT R5, R6; item 40)', () => {
  it('off: no appearance script, no scene style and no data-appearance in the server HTML', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS_SCENE', '1');
    const markup = page();
    expect(markup).not.toContain('sp_style');
    expect(markup).not.toContain('data-appearance');
    expect(markup).not.toContain('--lg-scene-photo');
    // React writes an empty <head> when the layout gives none; Next fills it.
    expect(markup).not.toMatch(/<head>.+<\/head>/u);
    expect(markup).toContain('<p>the page</p>');
  });

  it.each(['opt-in', 'default'] as const)(
    '%s: the rollout’s one head script, ahead of the body, and still no data-appearance on the server',
    (rollout) => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      const markup = page();
      const script = escaped(appearanceScript(rollout)!);
      const at = markup.indexOf(script);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(markup.indexOf('<body'));
      expect(markup.split(script)).toHaveLength(2);
      expect(markup).not.toMatch(/<html[^>]*data-appearance/u);
    },
  );

  it('the default and opt-in scripts differ only in their rule; the rest of the document is the same in every rollout', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    const off = page();
    for (const rollout of ['opt-in', 'default'] as const) {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      // React writes an empty <head> when the layout gives none.
      const on = page().replace(`<script>${escaped(appearanceScript(rollout)!)}</script>`, '');
      expect(on, rollout).toBe(off);
    }
  });

  it('the scene photo style is emitted only when the build found the installed photos', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS_SCENE', '');
    expect(page()).not.toContain('--lg-scene-photo');
    expect(page()).not.toContain('/liquid-glass/scene-');
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS_SCENE', '1');
    const markup = page();
    const css = renderToStaticMarkup(
      <style dangerouslySetInnerHTML={{ __html: scenePhotoCss() }} />,
    );
    expect(markup).toContain(css);
    expect(markup.indexOf(css)).toBeLessThan(markup.indexOf('<body'));
  });
});

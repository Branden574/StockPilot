import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The root layout and the Liquid Glass rollout (plan 2.1; REVISION-DEFAULT
 * R5, R6). Under `off` the server HTML carries no appearance script and no
 * data-appearance at all; under `opt-in` and `default`, the rollout's one head
 * script, recognised by its text, is the only addition, and <html> still
 * carries no appearance on the server (the script sets it in the browser,
 * from the cookie). The scene illustration is named by the glass stylesheet
 * alone (styles/liquid-glass/scene.css), never by a head style, an element or
 * a preload. No route reads the cookie on the server, so the HTML is the same
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
  setMyAppearanceAction: vi.fn(),
}));
// Under opt-in and default the provider renders the marketing variant guard,
// which asks for the router (it renders nothing on the server). Next mounts
// the app router around every layout; this render has none, so it gets a stub.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

import { appearanceScript } from '@/components/theme/appearance-script';

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
  it('off: no appearance script and no data-appearance in the server HTML', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    const markup = page();
    expect(markup).not.toContain('sp_style');
    expect(markup).not.toContain('data-appearance');
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

  it.each(['', 'opt-in', 'default'] as const)(
    'rollout "%s": no style, link or scene file in the server HTML (the scene is the glass stylesheet’s alone)',
    (rollout) => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      const markup = page();
      expect(markup).not.toMatch(/<style\b|<link\b/u);
      expect(markup).not.toMatch(/liquid-glass\/scene-|scene-(light|dark)[-.]|--lg-scene-photo/u);
    },
  );
});

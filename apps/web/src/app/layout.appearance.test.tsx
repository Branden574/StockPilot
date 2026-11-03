import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The root layout and the Liquid Glass kill switch (plan 2.1, D12). With
 * NEXT_PUBLIC_LIQUID_GLASS off the server HTML carries no appearance script
 * and no data-appearance at all; with it on, the one head script, recognised by
 * its text, is the only addition, and <html> still carries no appearance on
 * the server (the script sets it in the browser, from the cookie). No route
 * reads the cookie on the server, so the HTML is the same for every visitor
 * either way (appearance-render.guard.test.ts).
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

import { APPEARANCE_SCRIPT } from '@/components/theme/appearance-script';

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

describe('root layout and the Liquid Glass flag', () => {
  it('flag off: no appearance script and no data-appearance in the server HTML', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    const markup = page();
    expect(markup).not.toContain(APPEARANCE_SCRIPT);
    expect(markup).not.toContain('sp_appearance');
    expect(markup).not.toContain('data-appearance');
    expect(markup).toContain('<p>the page</p>');
  });

  it('flag on: the one head script, ahead of the body, and still no data-appearance on the server', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '1');
    const markup = page();
    const at = markup.indexOf(APPEARANCE_SCRIPT);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(markup.indexOf('<body'));
    expect(markup.split(APPEARANCE_SCRIPT)).toHaveLength(2);
    expect(markup).not.toMatch(/<html[^>]*data-appearance/);
  });

  it('the rest of the document is the same with the flag on or off', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    const off = page();
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '1');
    const on = page();
    // React writes an empty <head> when the layout gives none; Next fills it.
    const withoutScript = on.replace(`<script>${APPEARANCE_SCRIPT}</script>`, '');
    expect(withoutScript).toBe(off);
  });
});

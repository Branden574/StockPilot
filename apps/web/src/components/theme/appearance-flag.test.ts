import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  glassSiteRedirects,
  isLiquidGlassEnabled,
  LIQUID_GLASS_FLAG_NAME,
} from './appearance-flag';

/** The kill switch (Liquid Glass plan D12, 2.1). */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the Liquid Glass build flag', () => {
  it('is on only for exactly "1"', () => {
    expect(LIQUID_GLASS_FLAG_NAME).toBe('NEXT_PUBLIC_LIQUID_GLASS');
    for (const value of ['', '0', 'true', 'yes', ' 1', 'on']) {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', value);
      expect(isLiquidGlassEnabled(), JSON.stringify(value)).toBe(false);
    }
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '1');
    expect(isLiquidGlassEnabled()).toBe(true);
  });

  it('flag off: every /glass-site/* path redirects to its classic path, whatever the cookie', () => {
    expect(glassSiteRedirects(false)).toEqual([
      { source: '/glass-site/:path*', destination: '/:path*', permanent: false },
    ]);
  });

  it('flag on: only a visitor without the glass cookie is redirected', () => {
    expect(glassSiteRedirects(true)).toEqual([
      {
        source: '/glass-site/:path*',
        destination: '/:path*',
        permanent: false,
        missing: [{ type: 'cookie', key: 'sp_appearance', value: 'liquid-glass' }],
      },
    ]);
  });

  it('is read in every glass entry point', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const web = join(__dirname, '..', '..', '..');
    const read = (p: string) => readFileSync(join(web, p), 'utf8');
    expect(read('src/app/layout.tsx')).toMatch(/isLiquidGlassEnabled\(\) \?/);
    expect(read('next.config.ts')).toContain('glassSiteRedirects(isLiquidGlassEnabled())');
    expect(read('src/components/theme/appearance-provider.tsx')).toContain(
      'const glassEnabled = isLiquidGlassEnabled();',
    );
    expect(read('src/components/theme/appearance-recovery.tsx')).toContain(
      'isLiquidGlassEnabled()',
    );
    expect(read('src/app/global-error.tsx')).toContain('isLiquidGlassEnabled()');
  });
});

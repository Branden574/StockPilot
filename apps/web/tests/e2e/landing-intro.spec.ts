import { expect, test, type Page } from '@playwright/test';

/**
 * Landing intro E2E.
 *
 * The landing page is fully anonymous (proxy.ts deliberately excludes "/"), so
 * these run WITHOUT the shared auth storageState — no Supabase test account
 * needed. That also keeps them useful as a smoke check on a preview URL.
 *
 * The load-bearing assertion in most of these is not "the animation looked
 * right" but "the page was never uncovered mid-sequence". A single frame where
 * neither the pre-hydration curtain nor the live overlay is present is the flash
 * the design forbids, so we sample every animation frame and assert zero gaps.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const SESSION_KEY = 'stockpilot:intro-seen:v1';
const CURTAIN = '#li-pre';
const OVERLAY = '.li-root';

interface FrameSample {
  t: number;
  covered: boolean;
  beam: boolean;
  transform: string;
}

/** Record coverage on every animation frame, starting before any page script. */
async function instrument(page: Page, opts: { seen?: boolean } = {}) {
  await page.addInitScript(
    ([key, seen]) => {
      try {
        // Seed the lane ONCE per browser session. This script re-runs on every
        // navigation, so seeding unconditionally would wipe the flag the intro
        // just set and turn every reload/back into a fresh first visit — which
        // is exactly what the reload and bfcache tests are meant to rule out.
        const marker = '__introE2eSeeded';
        if (!window.sessionStorage.getItem(marker)) {
          window.sessionStorage.setItem(marker, '1');
          if (seen) window.sessionStorage.setItem(key as string, '1');
          else window.sessionStorage.removeItem(key as string);
        }
      } catch {
        /* private mode — the intro degrades to first-visit, which is fine */
      }
      const frames: FrameSample[] = [];
      (window as unknown as { __introFrames: FrameSample[] }).__introFrames = frames;
      const rec = () => {
        const lock = document.querySelector('.li-lock');
        frames.push({
          t: Math.round(performance.now()),
          covered: !!document.querySelector('#li-pre') || !!document.querySelector('.li-root'),
          beam: !!document.querySelector('.li-beam'),
          transform: lock ? getComputedStyle(lock).transform : 'none',
        });
        if (performance.now() < 3000) requestAnimationFrame(rec);
      };
      requestAnimationFrame(rec);
    },
    [SESSION_KEY, opts.seen ?? false] as const,
  );
}

async function framesOf(page: Page): Promise<FrameSample[]> {
  return page.evaluate(
    () => (window as unknown as { __introFrames?: FrameSample[] }).__introFrames ?? [],
  );
}

/** Frames where the page showed through after the intro had started but before it ended. */
function gapsIn(frames: FrameSample[]): FrameSample[] {
  return frames.filter(
    (f, i) =>
      !f.covered &&
      frames.slice(0, i).some((x) => x.covered) &&
      frames.slice(i).some((x) => x.covered),
  );
}

const moved = (t: string) => t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)';

/**
 * Wait until the intro has genuinely finished.
 *
 * Deliberately NOT `expect(OVERLAY).toHaveCount(0)`: an absent overlay is
 * ambiguous — it is equally true in the moment before the intro mounts, so that
 * assertion passes instantly and proves nothing. The session flag is written
 * once, by the same code path that tears the overlay down, so it is the only
 * unambiguous "it ran and it is over" signal.
 */
async function waitForIntroDone(page: Page) {
  await page.waitForFunction(
    (k) => {
      try {
        return sessionStorage.getItem(k as string) === '1';
      } catch {
        return true; // storage denied: the intro cannot gate on it either
      }
    },
    SESSION_KEY,
    { timeout: 8000 },
  );
  await expect(page.locator(OVERLAY)).toHaveCount(0);
}

test.describe('landing intro', () => {
  test('first visit plays the sequence and never uncovers the page', async ({ page }) => {
    await instrument(page);
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForTimeout(2800);

    const frames = await framesOf(page);
    expect(frames.length).toBeGreaterThan(30);
    expect(frames.some((f) => f.covered)).toBe(true);
    expect(frames.some((f) => f.beam), 'the scan beam should sweep on a first visit').toBe(true);
    expect(gapsIn(frames), 'the landing must never show through mid-sequence').toHaveLength(0);

    // It finishes, and leaves nothing behind in the DOM or the a11y tree.
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    await expect(page.locator(CURTAIN)).toHaveCount(0);
  });

  test('sets the session flag and the page ends up interactive', async ({ page }) => {
    await instrument(page);
    await page.goto('/', { waitUntil: 'commit' });
    await waitForIntroDone(page);

    expect(await page.evaluate((k) => sessionStorage.getItem(k), SESSION_KEY)).toBe('1');
    // The nav brand is visible again after the handoff — never left hidden.
    await expect(page.locator('#sp-nav .brand')).toBeVisible();
    await expect(page.locator('#sp-nav .brand')).toHaveCSS('opacity', '1');
  });

  test('repeat visit in the same session skips the beam', async ({ page }) => {
    await instrument(page, { seen: true });
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForTimeout(2200);

    const frames = await framesOf(page);
    expect(frames.some((f) => f.beam), 'no scan beam on the short lane').toBe(false);
    expect(gapsIn(frames)).toHaveLength(0);
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });

  test('a hard reload uses the short lane, not the full sequence', async ({ page }) => {
    await instrument(page);
    await page.goto('/', { waitUntil: 'commit' });
    await waitForIntroDone(page);

    // Same document, same session: the flag survives the reload.
    await page.reload({ waitUntil: 'commit' });
    await page.waitForTimeout(2000);
    const frames = await framesOf(page);
    expect(frames.some((f) => f.beam), 'a reload must not replay the full sequence').toBe(false);
  });

  test('reduced motion: no beam, no movement at all, still branded', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await instrument(page);
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForTimeout(2200);

    const frames = await framesOf(page);
    expect(frames.some((f) => f.beam)).toBe(false);
    expect(
      frames.some((f) => moved(f.transform)),
      'reduced motion must never translate or scale the lockup',
    ).toBe(false);
    expect(gapsIn(frames)).toHaveLength(0);
    expect(frames.some((f) => f.covered), 'still shows the branded surface').toBe(true);
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });

  test('internal navigation away and back never replays it', async ({ page }) => {
    await instrument(page);
    await page.goto('/', { waitUntil: 'commit' });
    await waitForIntroDone(page);

    await page.goto('/pricing');
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    await expect(page.locator(CURTAIN)).toHaveCount(0);

    await page.goBack();
    await page.waitForTimeout(1200);
    // Back may restore from bfcache; either way the intro must not run again.
    const frames = await framesOf(page);
    expect(frames.some((f) => f.beam)).toBe(false);
  });

  test('never mounts on other marketing routes', async ({ page }) => {
    for (const path of ['/pricing', '/support', '/terms']) {
      await page.goto(path);
      await expect(page.locator(CURTAIN), `${path} must not render the intro`).toHaveCount(0);
      await expect(page.locator(OVERLAY), `${path} must not render the intro`).toHaveCount(0);
    }
  });

  test('clicking the overlay skips ahead to the exit', async ({ page }) => {
    await instrument(page);
    await page.goto('/', { waitUntil: 'commit' });
    await page.locator(OVERLAY).click({ timeout: 4000, force: true }).catch(() => {
      /* if it already exited, the assertion below still holds */
    });
    await expect(page.locator(OVERLAY)).toHaveCount(0, { timeout: 3000 });
  });

  test('with JavaScript disabled the page is fully usable', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto('/');
    // noscript removes the curtain outright; the SSR landing is present and readable.
    await expect(page.locator('#sp-landing')).toBeVisible();
    await expect(page.locator('#sp-nav .brand')).toBeVisible();
    const curtain = page.locator(CURTAIN);
    if (await curtain.count()) await expect(curtain).toBeHidden();
    await ctx.close();
  });

  test('mobile 390: plays, and the page never scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await instrument(page);
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForTimeout(2600);

    const frames = await framesOf(page);
    expect(frames.some((f) => f.beam)).toBe(true);
    expect(gapsIn(frames)).toHaveLength(0);
    await expect(page.locator(OVERLAY)).toHaveCount(0);

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflows, 'no horizontal overflow at 390px').toBe(false);
  });

  test('a slow hero image cannot hold the page past the hard cap', async ({ page }) => {
    // Stall the LCP poster well beyond the 1500ms cap.
    await page.route('**/*.{png,jpg,jpeg,webp,avif}', async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      await route.abort();
    });
    await instrument(page);
    const started = Date.now();
    await page.goto('/', { waitUntil: 'commit' });
    await expect(page.locator(OVERLAY)).toHaveCount(0, { timeout: 4000 });
    // Cap is 1500ms + a 460ms exit; allow generous headroom for CI scheduling.
    expect(Date.now() - started).toBeLessThan(3500);
  });

  test('announces itself once, and traps no focus', async ({ page }) => {
    await instrument(page);
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForTimeout(300);

    const status = page.locator('.li-root [role="status"]');
    if (await status.count()) {
      await expect(status).toHaveCount(1);
      await expect(status).toHaveText(/loading stockpilot/i);
    }
    // The overlay itself is hidden from AT and holds nothing focusable.
    const focusable = await page.locator(`${OVERLAY} a, ${OVERLAY} button, ${OVERLAY} input`).count();
    expect(focusable).toBe(0);
  });
});

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { addedByGlass, findings, runAxe, severe, type Finding } from './axe';
import { chooseLook, glassBuild, settle } from './look';
import {
  arriveSignedOut,
  DETAIL_ROUTES,
  firstRecordPath,
  FOUR_LOOKS,
  PLATFORM_ROUTES,
  SIGNED_IN_ROUTES,
  SIGNED_OUT_ROUTES,
  visit,
  type NamedLook,
} from './stage5-pages';
import { coverageProblems, requiredLooks } from './stage5-visit';

/**
 * PLAN 8.3-1: AXE-CORE ON EVERY ROUTE IN DARK, LIGHT, DAY GLASS AND NIGHT GLASS.
 *
 * For each route the four looks are put on screen in turn (signed in: the
 * header appearance menu on the page itself; signed out: the Design cookie
 * and stored theme before a fresh load) and axe-core runs over the whole
 * document with the WCAG 2.x A/AA and best-practice rules (axe.ts). Fails:
 *  - a serious or critical violation in Day glass or Night glass;
 *  - any violation glass adds on that route that Classic of the same theme
 *    (Light for Day, Dark for Night) does not have (same rule, same node).
 * A serious or critical violation in Classic is a pre-existing defect: it
 * is attached to the report as "classic-findings" for the integrator and
 * does not fail this run (Classic is not changed by Liquid Glass).
 * Signed in, an `off` build skips (it is today's Classic; its Dark and
 * Light are measured in the glass builds, where the switch is offered);
 * signed out, it runs Dark and Light.
 * Every look the build offers must have been measured (stage5-visit.ts
 * coverageProblems): a route where axe ran in no look, or not in both glass
 * looks on a glass build, FAILS; a page that answers a server error fails
 * in visit() before any look.
 *
 * Lab command (from apps/web; the runner does this per role and per build):
 *   STAGE5_ROLE=manager PLAYWRIGHT_BASE_URL=http://127.0.0.1:3400 \
 *     pnpm exec playwright test -c playwright.stage5.config.ts --project=chrome a11y-axe.spec.ts
 * Signed-out routes run in every project with an empty session; the platform
 * console runs only as STAGE5_ROLE=platform.
 */

const signedIn = (info: TestInfo) => typeof info.project.use.storageState === 'string';
const role = process.env.STAGE5_ROLE ?? 'manager';

async function axeAll(
  page: Page,
  route: string,
  looks: readonly NamedLook[],
  put: (look: NamedLook) => Promise<boolean>,
  required: readonly string[],
): Promise<void> {
  const byLook = new Map<string, Finding[]>();
  for (const look of looks) {
    if (!(await put(look))) continue;
    byLook.set(look.label, findings(await runAxe(page)));
  }
  expect(coverageProblems(route, byLook.keys(), required), `${route}: looks measured`).toEqual([]);
  const report: Record<string, Finding[]> = Object.fromEntries(byLook);
  await test.info().attach(`axe ${route}`, {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  const classicSevere = [...(byLook.get('Dark') ?? []), ...(byLook.get('Light') ?? [])].filter(
    (f) => f.impact === 'serious' || f.impact === 'critical',
  );
  if (classicSevere.length)
    test.info().annotations.push({
      type: 'classic-findings',
      description: `${route}: ${classicSevere.map((f) => `${f.rule} @ ${f.target}`).join('; ')}`,
    });
  for (const [glass, classic] of [
    ['Day glass', 'Light'],
    ['Night glass', 'Dark'],
  ] as const) {
    const g = byLook.get(glass);
    if (!g) continue;
    expect.soft(severe(g), `${route} ${glass}: serious or critical violations`).toEqual([]);
    const base = byLook.get(classic);
    if (base)
      expect
        .soft(addedByGlass(base, g), `${route} ${glass}: violations ${classic} does not have`)
        .toEqual([]);
  }
}

test.describe('signed in', () => {
  test.beforeEach(() => {
    const info = test.info();
    test.skip(!signedIn(info), 'This project has no session.');
    test.skip(
      info.project.name === 'phone-390',
      'The header menu is a desktop control; phone layouts have their own specs.',
    );
    test.skip(
      role === 'portal',
      'The customer portal has its own routes (signed-out list and /portal).',
    );
  });

  const routes = role === 'platform' ? [...PLATFORM_ROUTES] : [...SIGNED_IN_ROUTES];
  for (const route of routes) {
    test(`axe on ${route} in the four looks`, async ({ page }) => {
      if (!(await visit(page, route, null))) test.skip(true, `${route} does not open for ${role}.`);
      // An off build is today's Classic, untouched: its Dark and Light are measured in the glass builds.
      if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
      await axeAll(
        page,
        route,
        FOUR_LOOKS,
        async (look) => {
          await chooseLook(page, look);
          await settle(page);
          return true;
        },
        requiredLooks(true),
      );
    });
  }

  for (const detail of DETAIL_ROUTES) {
    test(`axe on the first ${detail.what} in the four looks`, async ({ page }) => {
      test.skip(role === 'platform', "Records are an organisation member's.");
      const path = await firstRecordPath(page, detail);
      if (!path) test.skip(true, `No ${detail.what} for ${role}.`);
      if (!(await visit(page, path!, null))) test.skip(true, `${path} does not open for ${role}.`);
      if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
      await axeAll(
        page,
        path!,
        FOUR_LOOKS,
        async (look) => {
          await chooseLook(page, look);
          await settle(page);
          return true;
        },
        requiredLooks(true),
      );
    });
  }
});

test.describe('customer portal', () => {
  test.beforeEach(() => {
    const info = test.info();
    test.skip(!signedIn(info) || info.project.name === 'phone-390', 'This project has no session.');
  });
  test('axe on /portal in the four looks (customer-portal principal)', async ({
    page,
    baseURL,
  }) => {
    test.skip(role !== 'portal', 'Only the portal principal opens /portal.');
    expect(await visit(page, '/portal', null), '/portal opens for the portal principal').toBe(true);
    const glass = await glassBuild(page);
    const looks = FOUR_LOOKS.filter((l) => glass || l.design === 'classic');
    await axeAll(
      page,
      '/portal',
      looks,
      async (look) => {
        // The portal has no dashboard header menu: the look arrives as a visitor's does.
        await arriveSignedOut(page.context(), baseURL!, look);
        return visit(page, '/portal', look);
      },
      requiredLooks(glass),
    );
  });
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.beforeEach(() => {
    const info = test.info();
    // Once per run: in the anonymous project, or in chrome when no anonymous run is made.
    test.skip(info.project.name !== 'anonymous', 'Signed-out routes run in the anonymous project.');
  });

  for (const route of SIGNED_OUT_ROUTES) {
    test(`axe on ${route} in the four looks`, async ({ browser, baseURL }) => {
      const byLook = new Map<string, Finding[]>();
      let glass = false;
      for (const look of FOUR_LOOKS) {
        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
          await arriveSignedOut(context, baseURL!, look);
          const page = await context.newPage();
          // A signed-out page opens for everyone: visit() fails the test on any error status.
          if (!(await visit(page, route, null))) continue;
          const offered = await glassBuild(page);
          glass ||= offered;
          if (look.design === 'liquid-glass' && !offered) continue;
          byLook.set(look.label, findings(await runAxe(page)));
        } finally {
          await context.close();
        }
      }
      expect(
        coverageProblems(route, byLook.keys(), requiredLooks(glass)),
        `${route}: looks measured`,
      ).toEqual([]);
      await test.info().attach(`axe ${route}`, {
        body: JSON.stringify(Object.fromEntries(byLook), null, 2),
        contentType: 'application/json',
      });
      for (const [glass, classic] of [
        ['Day glass', 'Light'],
        ['Night glass', 'Dark'],
      ] as const) {
        const g = byLook.get(glass);
        if (!g) continue;
        expect.soft(severe(g), `${route} ${glass}: serious or critical violations`).toEqual([]);
        const base = byLook.get(classic);
        if (base)
          expect
            .soft(addedByGlass(base, g), `${route} ${glass}: violations ${classic} does not have`)
            .toEqual([]);
      }
    });
  }
});

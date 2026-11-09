import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  BOARD_TARGETS,
  boxProblems,
  comparableLandmarks,
  EXACT_VARIANTS,
  selectorDrift,
  STYLE_PROPS,
  styleProblems,
  variantsOf,
  type BoardLandmarksFile,
  type BoardTarget,
  type Measured,
  type StyleRecord,
} from './fidelity-landmarks';
import { chooseLook, settle } from './look';
import { arriveSignedOut, firstRecordPath, requireGlass, visit } from './stage5-pages';

/**
 * PLAN 8.1-1 AND 8.1-2: LANDMARK GEOMETRY AND COMPUTED STYLE AGAINST THE
 * RENDERED BOARDS.
 *
 * fixtures/board-landmarks.json holds, for every drawn web board and its
 * exact variants (reduced and contrast: no scene, plan 8.1), the box and the
 * computed style of each landmark (sidebar, top bar, h1, page header,
 * toolbar, first column header, first card, pager, selection bar, dialog),
 * measured from reference-shots/_render by
 * liquid-glass/verify/stage5/export-board-landmarks.mjs. This spec opens the
 * app page at the board's size in Day glass with the same material (reduced:
 * data-lg-material="reduced" on <html>; contrast: `prefers-contrast: more`),
 * measures the same landmarks and compares (fidelity-landmarks.ts):
 * position within 2 px, size within 1 px for fixed landmarks; font, colour
 * (delta E 2000 < 1 on opaque surfaces), radii, borders, shadow and
 * backdrop-filter exact. Font family differences (San Francisco or system
 * versus the boards' Inter, plan 8.1-3) are attached as "gaps", not failed.
 * A landmark the board lacks is skipped (attached); one the app lacks fails.
 * The 390 px boards (drawn only in their default variant) are compared for
 * geometry.
 *
 * Each measured state is also shot to $STAGE5_STATE_DIR/fidelity/ as
 * <board>-<variant>-<w>x<h>.app.png, for liquid-glass/verify/stage5/
 * fidelity-images.mjs (side-by-side, 50% overlay and difference images for
 * the person who reviews them, 8.1-3).
 *
 * The data on screen is the lab's plus the fidelity seed
 * (fixtures/seed-fidelity.sql), which the runner applies inside the lab
 * snapshot before this spec.
 *
 * Lab command:
 *   STAGE5_ROLE=manager STAGE5_STATE_DIR=<dir> PLAYWRIGHT_BASE_URL=http://127.0.0.1:3400 \
 *     pnpm exec playwright test -c playwright.stage5.config.ts --project=chrome fidelity-geometry.spec.ts
 * Skips in a build without Liquid Glass and when the landmark file holds no
 * export yet.
 */

const FILE = join(__dirname, 'fixtures', 'board-landmarks.json');
const data = JSON.parse(readFileSync(FILE, 'utf8')) as BoardLandmarksFile;

/** First visible match of `selector`: its box and computed style. */
async function measure(page: Page, selector: string): Promise<Measured | null> {
  return page.evaluate(
    ({ sel, props }) => {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none')
          continue;
        const style: Record<string, string> = {};
        for (const p of props) style[p] = (cs as unknown as Record<string, string>)[p] ?? '';
        return { x: r.left, y: r.top, w: r.width, h: r.height, style };
      }
      return null;
    },
    { sel: selector, props: [...STYLE_PROPS] as string[] },
  );
}

async function openTarget(page: Page, target: BoardTarget): Promise<string | null> {
  if (target.route.kind === 'path') return target.route.path;
  return firstRecordPath(page, {
    what: target.board,
    list: target.route.list,
    link: target.route.link,
  });
}

async function makeState(page: Page, target: BoardTarget): Promise<boolean> {
  if (target.state !== 'selection') return true;
  const rows = page.getByRole('table').getByRole('checkbox', { name: /^Select (?!all)/u });
  if ((await rows.count()) < 2) return false;
  await rows.nth(0).click();
  await rows.nth(1).click();
  await settle(page);
  return true;
}

for (const target of BOARD_TARGETS) {
  for (const variant of variantsOf(target)) {
    const title = `${target.board} (${variant}${target.state ? `, ${target.state}` : ''}): landmarks match the board`;
    test(title, async ({ page, browser, baseURL }, info) => {
      test.skip(
        info.project.name !== 'chrome',
        'Measured once, in Chrome (the boards were rendered in Chrome).',
      );
      test.skip(
        target.auth === 'signed-in' &&
          ['platform', 'portal'].includes(process.env.STAGE5_ROLE ?? ''),
        'Dashboard boards are measured as an organisation member.',
      );
      const record = data.boards.find((b) => b.board === target.board && b.variant === variant);
      test.skip(!record, `board-landmarks.json has no export of ${target.board} ${variant} yet.`);
      expect(selectorDrift(target, record!), "the export used this file's board selectors").toEqual(
        [],
      );

      let p = page;
      let close: (() => Promise<void>) | null = null;
      const look = { design: 'liquid-glass', theme: 'light' } as const;
      if (target.auth === 'signed-out') {
        const context = await browser.newContext({
          storageState: { cookies: [], origins: [] },
          viewport: { width: record!.viewport.w, height: record!.viewport.h },
          deviceScaleFactor: 1,
        });
        await arriveSignedOut(context, baseURL!, look);
        p = await context.newPage();
        close = () => context.close();
      }
      try {
        const path = await openTarget(p, target);
        if (!path) test.skip(true, `No record for ${target.board}.`);
        if (!(await visit(p, path!, null))) test.skip(true, `${path} does not open for this role.`);
        await requireGlass(p);
        if (target.auth === 'signed-in') {
          await p.setViewportSize({ width: 1440, height: 1000 });
          await chooseLook(p, look);
        }
        await p.setViewportSize({ width: record!.viewport.w, height: record!.viewport.h });
        if (variant === 'reduced')
          await p.evaluate(() =>
            document.documentElement.setAttribute('data-lg-material', 'reduced'),
          );
        await p.emulateMedia({ contrast: variant === 'contrast' ? 'more' : 'no-preference' });
        await p.evaluate(() => {
          const main = document.querySelector('main#main-content');
          if (main) main.scrollTop = 0;
          window.scrollTo(0, 0);
        });
        await settle(p);
        if (!(await makeState(p, target)))
          test.skip(true, `${target.board}: could not make the ${target.state} state.`);

        const fail: string[] = [];
        const gaps: string[] = [];
        for (const def of target.landmarks) {
          const board = record!.landmarks[def.name];
          if (!board) {
            gaps.push(`${def.name}: not drawn on the ${variant} board`);
            continue;
          }
          const app = await measure(p, def.app);
          if (!app) {
            fail.push(`${def.name}: the board draws it, the app shows no ${def.app}`);
            continue;
          }
          fail.push(...boxProblems(def.name, board, app, def.fixed));
          if ((EXACT_VARIANTS as readonly string[]).includes(variant) && board.style && app.style) {
            const s = styleProblems(def.name, board.style as StyleRecord, app.style as StyleRecord);
            fail.push(...s.fail);
            gaps.push(...s.gaps);
          }
        }
        const dir = process.env.STAGE5_STATE_DIR;
        if (dir) {
          mkdirSync(join(dir, 'fidelity'), { recursive: true });
          await p.screenshot({
            path: join(
              dir,
              'fidelity',
              `${target.board}-${variant}${target.state ? `-${target.state}` : ''}-${record!.viewport.w}x${record!.viewport.h}.app.png`,
            ),
            animations: 'disabled',
            caret: 'hide',
          });
        }
        await info.attach(`gaps ${target.board} ${variant}`, {
          body: gaps.join('\n') || '(none)',
          contentType: 'text/plain',
        });
        // Nothing compared is not a pass: the board draws none of this target's landmarks.
        if (comparableLandmarks(target, record!).length === 0)
          test.skip(
            true,
            `${target.board} ${variant}${target.state ? ` (${target.state})` : ''}: the board draws none of ${target.landmarks.map((l) => l.name).join(', ')}, so nothing was compared (gap; the app shot is saved for review)`,
          );
        expect(fail).toEqual([]);
      } finally {
        if (close) await close();
      }
    });
  }
}

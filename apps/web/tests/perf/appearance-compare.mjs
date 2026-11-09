// @ts-check
/**
 * The judging half of the Liquid Glass performance run (IMPLEMENTATION-PLAN.md
 * 8.4; plans/REVISION-DEFAULT.md R12). Plain JavaScript with JSDoc types, so
 * the lab tool liquid-glass/verify/stage5/perf-compare.mjs imports it with
 * plain node and src/test/stage5-perf-compare.test.ts proves it with vitest;
 * appearance.perf.ts writes the samples it reads.
 *
 * Inputs: one folder per build ("B" = classic at the merge base,
 * "branch-classic", "branch-glass", and "B-repeat" = B measured again for the
 * A/A drift), each holding the sample files appearance.perf.ts wrote.
 *
 * The rules:
 *  - every timing is the MEDIAN of its runs (3 cold, 3 warm per route);
 *  - both sides of every comparison are listed SORTED (the run order carries
 *    no meaning, and a reader sees the whole spread, not one pairing);
 *  - noise: branch-classic passes a timing when its median is within the
 *    noise allowance of B's median. The allowance is the larger of
 *      (a) the A/A drift: |median(B) - median(B-repeat)| plus each side's
 *          own spread (max - min) of B, and
 *      (b) an absolute floor (NOISE_FLOOR_MS, 10% of B's median for bytes
 *          of 0, i.e. bytes must match exactly);
 *  - glass: LCP within 10% of branch-classic (8.4) on every route;
 *  - R12 budgets (release blockers): the landing in glass LCP <= 2500 ms and
 *    <= classic + 10%, CLS <= 0.1; no frame over 50 ms during the 5 s scroll at
 *    CPU 4x and none over 100 ms at 6x on Overview, Items and Place an Order;
 *    INP <= 200 ms for row select, open dialog and add to cart; a design or
 *    theme switch under 100 ms; the reduced material holds the 6x budget with
 *    margin (MARGIN_FACTOR of it).
 */

/** Timings (ms) where run-to-run noise applies. */
export const TIMING_METRICS = /** @type {const} */ (['ttfb', 'fcp', 'lcp', 'useful']);
/** Byte counts: reported side by side; branch-classic must equal B apart from the scoped glass CSS. */
export const BYTE_METRICS = /** @type {const} */ ([
  'jsBytes',
  'cssBytes',
  'imgBytes',
  'classicGlassCssBytes',
  'sceneBytes',
]);
export const NOISE_FLOOR_MS = 30;
export const GLASS_LCP_FACTOR = 1.1;
export const LANDING_LCP_MS = 2500;
export const LANDING_CLS = 0.1;
export const FRAME_BUDGET_MS = /** @type {Record<string, number>} */ ({ 4: 50, 6: 100 });
export const INP_BUDGET_MS = 200;
export const SWITCH_BUDGET_MS = 100;
/** The reduced material must hold the 6x budget "with margin": its worst frame at most this share of it. */
export const MARGIN_FACTOR = 0.8;
/** Routes R12 holds to the scroll budget. */
export const SCROLL_ROUTES = ['overview', 'items', 'place-order'];
/**
 * Every route appearance.perf.ts measures (its ROUTES keys; the spec refuses
 * to run when the two lists differ). judge() expects each of them on every
 * build, in both modes: a route that is missing is a FAIL, never "no verdict".
 */
export const EXPECTED_ROUTES = [
  'overview',
  'items',
  'items-grid',
  'books',
  'item-detail',
  'orders',
  'place-order',
  'order-detail',
  'book-order-totals',
  'landing',
];
/** The builds whose desktop loads every expected route must have. */
export const LOAD_BUILDS = /** @type {const} */ ([
  'B',
  'B-repeat',
  'branch-classic',
  'branch-glass',
]);

/**
 * @param {readonly number[]} values
 * @returns {number | null}
 */
export function median(values) {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1
    ? /** @type {number} */ (v[mid])
    : /** @type {number} */ (v[mid - 1] + /** @type {number} */ (v[mid])) / 2;
}

/**
 * @param {readonly number[]} values
 * @returns {number}
 */
export function spread(values) {
  const v = values.filter((n) => Number.isFinite(n));
  if (v.length === 0) return 0;
  return Math.max(...v) - Math.min(...v);
}

/**
 * @param {readonly number[]} values
 * @returns {number[]}
 */
export const sorted = (values) => values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

/**
 * @typedef {{ build: string, profile: string, route: string, mode: 'cold' | 'warm', run: number,
 *   metrics: Record<string, number | null> }} LoadSample
 * @typedef {{ build: string, profile: string, route: string, cpu: number, material: 'normal' | 'reduced',
 *   run: number, maxFrameMs: number, over50: number, over100: number, loafCount: number,
 *   scrollMax?: number }} ScrollSample  (scrollMax: how far the pane could scroll, px; 0 = it never moved)
 * @typedef {{ build: string, profile: string, interaction: string, run: number, inpMs: number | null }} InteractionSample
 * @typedef {{ build: string, profile: string, route: string, run: number, latencyMs: number | null,
 *   dataRequests: number }} SwitchSample
 * @typedef {{ loads: LoadSample[], scrolls: ScrollSample[], interactions: InteractionSample[],
 *   switches: SwitchSample[] }} BuildSamples
 */

/**
 * Collects one build's values of `metric` for (route, mode, profile).
 * @param {BuildSamples} s
 * @param {string} route
 * @param {'cold' | 'warm'} mode
 * @param {string} metric
 * @param {string} profile
 * @returns {number[]}
 */
export function valuesOf(s, route, mode, metric, profile = 'desktop') {
  return s.loads
    .filter((l) => l.route === route && l.mode === mode && l.profile === profile)
    .map((l) => l.metrics[metric])
    .filter(/** @returns {v is number} */ (v) => typeof v === 'number' && Number.isFinite(v));
}

/**
 * The noise allowance of one timing (ms) from B and its repeat.
 * @param {readonly number[]} b
 * @param {readonly number[]} bRepeat
 * @returns {number}
 */
export function noiseAllowance(b, bRepeat) {
  const mb = median(b);
  const mr = median(bRepeat);
  const drift = mb === null || mr === null ? 0 : Math.abs(mb - mr);
  return Math.max(NOISE_FLOOR_MS, drift + Math.max(spread(b), spread(bRepeat)));
}

/**
 * @typedef {{ check: string, route?: string, pass: boolean, detail: string }} Verdict
 */

/**
 * Compares the builds and applies every rule. Missing data is a FAIL (a
 * budget that was not measured did not pass): every route of
 * `expectedRoutes` must have desktop loads, cold and warm, on every build;
 * a scroll sample whose pane could not scroll (scrollMax 0 or absent) does
 * not count as a scroll.
 * @param {{ B: BuildSamples, 'B-repeat': BuildSamples, 'branch-classic': BuildSamples, 'branch-glass': BuildSamples }} builds
 * @param {readonly string[]} [expectedRoutes]
 * @returns {{ verdicts: Verdict[], table: Array<Record<string, unknown>> }}
 */
export function judge(builds, expectedRoutes = EXPECTED_ROUTES) {
  /** @type {Verdict[]} */
  const verdicts = [];
  /** @type {Array<Record<string, unknown>>} */
  const table = [];
  const B = builds.B;
  const BR = builds['B-repeat'];
  const BC = builds['branch-classic'];
  const BG = builds['branch-glass'];
  const routes = [
    ...new Set([
      ...expectedRoutes,
      ...[...B.loads, ...BC.loads, ...BG.loads]
        .filter((l) => l.profile === 'desktop')
        .map((l) => l.route),
    ]),
  ].sort();

  for (const route of routes) {
    for (const mode of /** @type {const} */ (['cold', 'warm'])) {
      // Every build measured this route in this mode (a route with no record is not a pass).
      const missing = LOAD_BUILDS.filter(
        (b) =>
          !builds[b].loads.some(
            (l) => l.route === route && l.mode === mode && l.profile === 'desktop',
          ),
      );
      verdicts.push({
        check: `measured ${mode}`,
        route,
        pass: missing.length === 0,
        detail: missing.length
          ? `not measured on ${missing.join(', ')}`
          : `on ${LOAD_BUILDS.join(', ')}`,
      });
      for (const metric of [...TIMING_METRICS, ...BYTE_METRICS]) {
        const b = valuesOf(B, route, mode, metric);
        const bc = valuesOf(BC, route, mode, metric);
        const bg = valuesOf(BG, route, mode, metric);
        table.push({
          route,
          mode,
          metric,
          B: sorted(b),
          'branch-classic': sorted(bc),
          'branch-glass': sorted(bg),
          medianB: median(b),
          medianClassic: median(bc),
          medianGlass: median(bg),
        });
        if (/** @type {readonly string[]} */ (TIMING_METRICS).includes(metric)) {
          const mb = median(b);
          const mc = median(bc);
          if (metric === 'useful' && b.length === 0 && bc.length === 0) continue; // a route without the mark
          if (mb === null || mc === null) {
            verdicts.push({
              check: `noise ${metric} ${mode}`,
              route,
              pass: false,
              detail: 'not measured on B or branch-classic',
            });
            continue;
          }
          const allow = noiseAllowance(b, valuesOf(BR, route, mode, metric));
          const d = mc - mb;
          verdicts.push({
            check: `noise ${metric} ${mode}`,
            route,
            pass: d <= allow,
            detail: `branch-classic ${mc.toFixed(0)} vs B ${mb.toFixed(0)} (${d >= 0 ? '+' : ''}${d.toFixed(0)} ms, allowance ${allow.toFixed(0)} ms)`,
          });
        }
      }
      // 8.4: glass LCP within 10% of classic (on the branch).
      const lc = median(valuesOf(BC, route, mode, 'lcp'));
      const lg = median(valuesOf(BG, route, mode, 'lcp'));
      verdicts.push(
        lc === null || lg === null
          ? { check: `glass LCP ${mode}`, route, pass: false, detail: 'not measured' }
          : {
              check: `glass LCP ${mode}`,
              route,
              pass: lg <= lc * GLASS_LCP_FACTOR,
              detail: `glass ${lg.toFixed(0)} ms vs classic ${lc.toFixed(0)} ms (limit ${(lc * GLASS_LCP_FACTOR).toFixed(0)})`,
            },
      );
      // Branch classic ships the same JS and image bytes as B; its CSS may grow only by the scoped glass CSS (reported).
      for (const metric of ['jsBytes', 'imgBytes']) {
        const mb = median(valuesOf(B, route, mode, metric));
        const mc = median(valuesOf(BC, route, mode, metric));
        if (mb !== null && mc !== null && mb !== mc)
          verdicts.push({
            check: `bytes ${metric} ${mode} (report)`,
            route,
            pass: true,
            detail: `B ${mb}, branch-classic ${mc} (${mc - mb >= 0 ? '+' : ''}${mc - mb})`,
          });
      }
    }
  }

  // R12 low-end landing budget.
  const landG = valuesOf(BG, 'landing', 'cold', 'lcp', 'low-end');
  const landC = valuesOf(BC, 'landing', 'cold', 'lcp', 'low-end');
  const clsG = valuesOf(BG, 'landing', 'cold', 'cls', 'low-end');
  const mlg = median(landG);
  const mlc = median(landC);
  const mcls = median(clsG);
  verdicts.push(
    mlg === null || mlc === null
      ? { check: 'R12 landing LCP (low-end)', pass: false, detail: 'not measured' }
      : {
          check: 'R12 landing LCP (low-end)',
          pass: mlg <= LANDING_LCP_MS && mlg <= mlc * GLASS_LCP_FACTOR,
          detail: `glass ${mlg.toFixed(0)} ms (limit ${LANDING_LCP_MS} and ${(mlc * GLASS_LCP_FACTOR).toFixed(0)} = classic + 10%)`,
        },
  );
  verdicts.push(
    mcls === null
      ? { check: 'R12 landing CLS (low-end)', pass: false, detail: 'not measured' }
      : {
          check: 'R12 landing CLS (low-end)',
          pass: mcls <= LANDING_CLS,
          detail: `glass CLS ${mcls.toFixed(3)} (limit ${LANDING_CLS})`,
        },
  );

  // R12 scroll frames, glass, normal material at 4x and 6x, reduced at 6x with margin.
  for (const route of SCROLL_ROUTES) {
    for (const [cpu, material] of /** @type {Array<[number, 'normal' | 'reduced']>} */ ([
      [4, 'normal'],
      [6, 'normal'],
      [6, 'reduced'],
    ])) {
      const all = BG.scrolls.filter(
        (s) => s.route === route && s.cpu === cpu && s.material === material,
      );
      // A pane that could not scroll was never scrolled: its frames prove nothing.
      const runs = all.filter((s) => typeof s.scrollMax === 'number' && s.scrollMax > 0);
      const limit =
        /** @type {number} */ (FRAME_BUDGET_MS[String(cpu)]) *
        (material === 'reduced' ? MARGIN_FACTOR : 1);
      const worst = runs.length ? Math.max(...runs.map((r) => r.maxFrameMs)) : null;
      verdicts.push(
        worst === null
          ? {
              check: `R12 scroll ${cpu}x ${material}`,
              route,
              pass: false,
              detail: all.length
                ? `not measured: the pane did not scroll in any of ${all.length} runs (scrollMax 0)`
                : 'not measured',
            }
          : runs.length < all.length
            ? {
                check: `R12 scroll ${cpu}x ${material}`,
                route,
                pass: false,
                detail: `the pane did not scroll in ${all.length - runs.length} of ${all.length} runs (scrollMax 0)`,
              }
            : {
                check: `R12 scroll ${cpu}x ${material}`,
                route,
                pass: worst <= limit,
                detail: `worst frame ${worst.toFixed(0)} ms over ${runs.length} runs (limit ${limit.toFixed(0)})`,
              },
      );
    }
  }

  // R12 INP, glass.
  for (const name of ['row-select', 'open-dialog', 'add-to-cart']) {
    const v = BG.interactions
      .filter((i) => i.interaction === name)
      .map((i) => i.inpMs)
      .filter(/** @returns {x is number} */ (x) => typeof x === 'number');
    const m = v.length ? Math.max(...v) : null;
    verdicts.push(
      m === null
        ? { check: `R12 INP ${name}`, pass: false, detail: 'not measured' }
        : {
            check: `R12 INP ${name}`,
            pass: m <= INP_BUDGET_MS,
            detail: `worst ${m.toFixed(0)} ms (limit ${INP_BUDGET_MS})`,
          },
    );
  }

  // R12 switch latency, glass build, with no data refetch.
  const sw = BG.switches;
  if (sw.length === 0)
    verdicts.push({ check: 'R12 switch latency', pass: false, detail: 'not measured' });
  else {
    const lat = sw
      .map((s) => s.latencyMs)
      .filter(/** @returns {x is number} */ (x) => typeof x === 'number');
    const worst = lat.length ? Math.max(...lat) : null;
    const refetch = sw.reduce((n, s) => n + s.dataRequests, 0);
    verdicts.push({
      check: 'R12 switch latency',
      pass: worst !== null && worst < SWITCH_BUDGET_MS && refetch === 0,
      detail: `worst ${worst === null ? 'n/a' : worst.toFixed(0)} ms over ${sw.length} switches (limit < ${SWITCH_BUDGET_MS}); data requests ${refetch}`,
    });
  }
  return { verdicts, table };
}

/**
 * The run passes when every verdict passes.
 * @param {readonly Verdict[]} verdicts
 */
export const allPass = (verdicts) => verdicts.every((v) => v.pass);

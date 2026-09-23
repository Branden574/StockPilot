import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, type BrowserContext, type Page } from '@playwright/test';

import {
  buildRunReport,
  HARNESS_VERSION,
  parseRunFile,
  SCHEMA_VERSION,
  type ImageRecord,
  type PhotoSample,
  type RunFile,
  type RunMeta,
  type Sample,
} from '../../src/lib/perf/report';
import { collectorScript, type ArmConfig, type PageImages, type PageResult } from './collector';
import { fingerprintKey, NetworkLog } from './network-log';
import { authStatePath, identityPath, isLoopback, resultsRoot, roleLabel } from './paths';
import { toRouteTemplate } from '../../src/lib/perf/route-template';
import {
  ERROR_SCREEN,
  FEEDBACK_SELECTORS,
  SCENARIOS,
  type ClickStep,
  type Marker,
  type Scenario,
} from './scenarios';

/**
 * The scenario runner. One Playwright test per scenario; each test is N timed
 * iterations plus one warm-up that is stored apart.
 *
 * Rules this file exists to keep (owner brief, performance program 2026-09):
 *   - many samples, reported as percentiles; a failed iteration is RECORDED as
 *     a failure with a classified reason, never dropped silently and never
 *     retried into a better number;
 *   - the warm-up iteration pays for cold server caches and is stored with
 *     `warmup: true` so cold and warm are never averaged together;
 *   - every iteration starts from a NEW PAGE, so the client router cache is
 *     empty and iteration 7 is not faster than iteration 1 just for being 7th;
 *   - the pointer rests on the link for PERF_HOVER_MS before the click, because
 *     that is what a hand does and it is what gives intent warming its head
 *     start. 0 measures the no-warning click;
 *   - the environment is MEASURED where it can be (round trip, machine, build
 *     at both ends, the account's real role) and the run refuses to start
 *     without a dataset description, because none of it can be added later.
 */

const num = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
};
const ITERATIONS = num('PERF_ITERATIONS', 20);
const COLD_ITERATIONS = num('PERF_COLD_ITERATIONS', 10);
const SETTLE_MS = num('PERF_SETTLE_MS', 2000);
const HOVER_MS = num('PERF_HOVER_MS', 150);
const USEFUL_TIMEOUT_MS = num('PERF_USEFUL_TIMEOUT_MS', 30_000);
const IMAGE_WAIT_MS = num('PERF_IMAGE_WAIT_MS', 15_000);
const ONLY = (process.env.PERF_SCENARIOS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SERVER_STATES = ['post-deploy', 'post-idle', 'first-org-request', 'steady', 'not controlled'];

/**
 * Network profiles are APPLIED, never just named: a label with nothing behind
 * it would put an invented condition into the results. Throughput in bytes/s,
 * latency in ms added per request (Chrome DevTools' own presets).
 */
const NETWORK_PROFILES: Record<
  string,
  { latency: number; downloadThroughput: number; uploadThroughput: number } | null
> = {
  unthrottled: null,
  'fast-4g': {
    latency: 165,
    downloadThroughput: (9 * 1024 * 1024) / 8,
    uploadThroughput: (1.5 * 1024 * 1024) / 8,
  },
  'slow-4g': {
    latency: 562.5,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  },
  // A LAB target given the round trip this machine measures to production
  // (130 ms, run 2026-09-22 after-batch) and no bandwidth limit (-1), so a
  // localhost build answers across the same distance a customer's request travels.
  'rtt-130': { latency: 130, downloadThroughput: -1, uploadThroughput: -1 },
};
const NETWORK = process.env.PERF_NETWORK ?? 'unthrottled';
const CPU_SLOWDOWN = num('PERF_CPU', 1);
if (!(NETWORK in NETWORK_PROFILES))
  throw new Error(`PERF_NETWORK must be one of ${Object.keys(NETWORK_PROFILES).join(', ')}`);

const samples: Sample[] = [];
// Set once by playwright.perf.config.ts in the runner process and inherited by
// every worker, so a worker that restarts continues the SAME results folder.
const startedAt = process.env.PERF_RUN_ID ?? new Date().toISOString();

/** A failure that says what kind it was and nothing else: Playwright's own messages quote URLs and selectors. */
class PerfFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
async function step<T>(code: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PerfFailure) throw error;
    // Only a real timeout keeps the step's own code. A crashed page or a closed
    // context must not be filed as "the content was slow".
    const name = error instanceof Error ? error.name : '';
    throw new PerfFailure(
      name === 'TimeoutError' ? code : `error:${code.replace(/^timeout:/, '')}`,
    );
  }
}

function arm(marker: Marker, fromNavigationStart = false, manualStart = false): ArmConfig {
  return {
    feedbackSelectors: FEEDBACK_SELECTORS,
    targetPath: marker.path,
    targetSearch: marker.search,
    usefulSelector: marker.selector,
    usefulHrefPattern: marker.hrefPattern,
    freshOnly: marker.freshOnly,
    rowText: marker.rowText,
    changedTextSelector: marker.changedText,
    shellSelector: marker.shell,
    errorSelector: ERROR_SCREEN,
    fromNavigationStart,
    manualStart,
  };
}

type PerfWindow = {
  __spPerf: {
    arm(config: ArmConfig): void;
    start(): void;
    isUseful(): boolean;
    result(until: number | null): PageResult;
    images(
      scope: string,
      first: number,
      waitMs: number,
      settledWhenGone: string | null,
    ): Promise<PageImages>;
  };
  __spPerfAutoArm: ArmConfig;
};

function waitUseful(page: Page, code: string): Promise<unknown> {
  return step(code, () =>
    page.waitForFunction(() => (window as never as PerfWindow).__spPerf.isUseful(), null, {
      timeout: USEFUL_TIMEOUT_MS,
      polling: 'raf',
    }),
  );
}

/**
 * The previous navigation's progress bar fades out for a moment after its
 * content is up. Wait for a clean slate, or that leftover bar would be read
 * as instant feedback for THIS step.
 */
function waitNoFeedback(page: Page): Promise<unknown> {
  return step('feedback-marker-stuck', () =>
    page.waitForFunction(
      (selectors) => selectors.every((s) => document.querySelector(s) === null),
      FEEDBACK_SELECTORS,
      { timeout: 5000, polling: 100 },
    ),
  );
}

async function clickStep(page: Page, click: ClickStep, hoverMs = HOVER_MS): Promise<void> {
  const via = click.via ?? 'click';
  if (via === 'back' || via === 'forward') {
    await waitNoFeedback(page);
    await page.evaluate(
      (config) => (window as never as PerfWindow).__spPerf.arm(config),
      arm(click.arrives, false, true),
    );
    // Started and sent in ONE task on the page's clock: nothing between the
    // stamp and the history call.
    await page.evaluate((direction) => {
      (window as never as PerfWindow).__spPerf.start();
      if (direction === 'back') history.back();
      else history.forward();
    }, via);
    await waitUseful(page, 'timeout:useful');
    return;
  }
  // Unmeasured clicks that open what the measured one needs (a menu, a popover).
  for (const selector of click.setup ?? []) {
    const opener = page.locator(selector).first();
    if ((await opener.count()) === 0) throw new PerfFailure('setup-missing');
    await step('setup-failed', () => opener.click());
    await page.waitForTimeout(300);
  }
  let link = page.locator(click.selector);
  if (click.hrefPattern) {
    const pattern = new RegExp(click.hrefPattern);
    const hrefs = await link.evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
    const index = hrefs.findIndex((href) => pattern.test(href));
    if (index === -1) throw new PerfFailure('link-missing');
    link = link.nth(index);
  } else {
    if ((await link.count()) === 0) throw new PerfFailure('link-missing');
    link = link.first();
  }
  // Below 768 px the sidebar is display:none and its links live in a drawer.
  const rendered = await link.evaluate((el) => el.getClientRects().length > 0).catch(() => false);
  if (!rendered) throw new PerfFailure('link-hidden-at-this-viewport');
  await waitNoFeedback(page);
  if (via === 'fill') {
    // Typing: the clock starts in the page right before the text goes in, so
    // it errs slow by one round trip, never fast.
    await page.evaluate(
      (config) => (window as never as PerfWindow).__spPerf.arm(config),
      arm(click.arrives, false, true),
    );
    await step('input-not-focusable', () => link.focus());
    await page.evaluate(() => (window as never as PerfWindow).__spPerf.start());
    await step('fill-failed', () => link.fill(click.text ?? ''));
    await waitUseful(page, 'timeout:useful');
    return;
  }
  // Armed only now, so the wait above cannot eat into the measured interval.
  await page.evaluate(
    (config) => (window as never as PerfWindow).__spPerf.arm(config),
    arm(click.arrives),
  );
  // hoverMs 0 is the no-warning click: the pointer lands and clicks at once.
  if (hoverMs > 0) {
    await step('link-not-hoverable', () => link.hover());
    await page.waitForTimeout(hoverMs);
  }
  await step('click-failed', () => link.click({ noWaitAfter: true }));
  await waitUseful(page, 'timeout:useful');
}

function photoSample(
  collected: PageImages,
  log: NetworkLog,
  origin: number,
  usefulPaintMs: number | null,
): PhotoSample {
  const visible = collected.records.filter((i) => i.inViewport);
  // A photo is not "done" before the content it sits in is on screen. Priority
  // photos are preloaded from the response head, so their bytes routinely
  // arrive BEFORE the rows paint; without the floor the table would claim
  // photos were visible earlier than the list they belong to. The unfloored
  // figure is kept beside it as "bytes ready".
  const floor = usefulPaintMs ?? 0;
  const images: ImageRecord[] = visible.map((i) => {
    const at = i.loadAt ?? i.responseEnd;
    const bytesReadyMs = at === null || i.failed || !i.complete ? null : Math.max(0, at - origin);
    return {
      order: i.order,
      row: i.row,
      first: i.first,
      renderedWidth: i.renderedWidth,
      renderedHeight: i.renderedHeight,
      naturalWidth: i.naturalWidth,
      naturalHeight: i.naturalHeight,
      intrinsicWidth: i.intrinsicWidth,
      intrinsicHeight: i.intrinsicHeight,
      objectFit: i.objectFit,
      devicePixelRatio: i.devicePixelRatio,
      loading: i.loading,
      fetchPriority: i.fetchPriority,
      hasBlurPlaceholder: i.hasBlurPlaceholder,
      complete: i.complete,
      failed: i.failed,
      doneMs: bytesReadyMs === null ? null : Math.max(floor, bytesReadyMs),
      bytesReadyMs,
      // When the browser STARTED fetching it: late discovery, as opposed to slow delivery.
      requestStartMs: i.fetchStart === null ? null : i.fetchStart - origin,
      klass: i.klass,
      objectFingerprint: i.objectFingerprint,
      tokenFingerprint: i.tokenFingerprint,
      network: log.image(i.urlFingerprint),
    };
  });
  // The time the LAST photo of a set finished. One broken or unfinished photo
  // means the set never finished: that sample has no value (and the broken /
  // unfinished counts say why), rather than a flattering partial time.
  const latest = (set: ImageRecord[], key: 'doneMs' | 'bytesReadyMs') => {
    const times = set.map((i) => i[key]);
    return set.length === 0 || times.some((t) => t === null)
      ? null
      : Math.max(...(times as number[]));
  };
  const first = images.filter((i) => i.first);
  return {
    visibleCount: images.length,
    firstCount: first.length,
    failedCount: images.filter((i) => i.failed).length,
    unfinishedCount: collected.unfinished,
    flooredCount: images.filter((i) => i.bytesReadyMs !== null && i.bytesReadyMs <= floor).length,
    firstDoneMs: latest(first, 'doneMs'),
    allVisibleDoneMs: latest(images, 'doneMs'),
    firstRequestStartMs: (() => {
      const starts = first.map((i) => i.requestStartMs).filter((t): t is number => t !== null);
      return starts.length === 0 ? null : Math.min(...starts);
    })(),
    firstBytesReadyMs: latest(first, 'bytesReadyMs'),
    allVisibleBytesReadyMs: latest(images, 'bytesReadyMs'),
    images,
  };
}

type Measured = Omit<Sample, 'scenario' | 'iteration' | 'warmup' | 'at'>;

async function iterate(
  scenario: Scenario,
  context: BrowserContext,
  browserName: string,
): Promise<{ measured: Measured; unsupported: string[] }> {
  const page = await context.newPage();
  const log = await NetworkLog.attach(page, browserName);
  const profile = NETWORK_PROFILES[NETWORK];
  if (profile || CPU_SLOWDOWN > 1) {
    const cdp = await context.newCDPSession(page);
    if (profile) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile });
    if (CPU_SLOWDOWN > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
  }
  // Counts only. A console message can quote an item name or a URL.
  let consoleErrors = 0;
  let hydrationErrors = 0;
  const HYDRATION = /hydrat|Minified React error #(418|419|421|422|423|425)\b/i;
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    consoleErrors += 1;
    if (HYDRATION.test(message.text())) hydrationErrors += 1;
  });
  page.on('pageerror', (error) => {
    consoleErrors += 1;
    if (HYDRATION.test(String(error?.message ?? ''))) hydrationErrors += 1;
  });
  let crashed = false;
  page.on('crash', () => {
    crashed = true;
  });
  try {
    const hardLoad = scenario.kind === 'hard-load';
    if (hardLoad) {
      await page.addInitScript(
        (config) => {
          (window as never as PerfWindow).__spPerfAutoArm = config;
        },
        arm(scenario.startReady, true),
      );
    }
    const wallStart = Date.now();
    await step('start-page-unreachable', () => page.goto(scenario.start, { waitUntil: 'commit' }));
    if (!hardLoad) {
      await page.evaluate(
        (config) => {
          (window as never as PerfWindow).__spPerfAutoArm = config;
        },
        arm(scenario.startReady, true),
      );
    }
    await waitUseful(page, hardLoad ? 'timeout:useful' : 'timeout:start-page');

    if (!hardLoad) {
      // Let the start page finish its own work (the sidebar's staggered
      // warm-ups, late chunks) so the click is measured from a resting page.
      // A scenario with settleMs 0 is the QUICK click: made as soon as the
      // start page shows content, before any of that work has finished.
      const settle = scenario.settleMs ?? SETTLE_MS;
      if (settle > 0) {
        await page.waitForLoadState('load').catch(() => {});
        await page.waitForTimeout(settle);
      }
      for (const prelude of scenario.prelude ?? []) {
        await clickStep(page, prelude);
        await page.waitForTimeout(500);
      }
      if (scenario.restBeforeMs) await page.waitForTimeout(scenario.restBeforeMs);
      await clickStep(page, scenario.click as ClickStep, scenario.hoverMs ?? HOVER_MS);
    }

    const collected = scenario.photos
      ? await page.evaluate(
          ([scope, first, wait, settled]) =>
            (window as never as PerfWindow).__spPerf.images(
              scope as string,
              first as number,
              wait as number,
              settled as string | null,
            ),
          [
            scenario.photos.scope,
            scenario.photos.first,
            IMAGE_WAIT_MS,
            scenario.photos.settledWhenGone ?? null,
          ] as const,
        )
      : null;
    // A FIXED window: layout shift, long tasks and requests are counted from
    // the click to one second past "useful", however long the photos took.
    await page.waitForTimeout(1000);
    const closesAt = await page.evaluate(() => {
      const useful = (window as never as PerfWindow).__spPerf.result(null).usefulAt;
      return useful === null ? null : useful + 1000;
    });
    const result = await page.evaluate(
      (until) => (window as never as PerfWindow).__spPerf.result(until),
      closesAt,
    );

    if (result.errorScreen) throw new PerfFailure('error-screen');
    const origin = hardLoad ? 0 : (result.clickAt as number);
    const nonNegative = (at: number | null) => (at === null ? null : Math.max(0, at - origin));
    // The network window opens at the CLICK on the page's clock, converted to
    // the wall clock, so requests the hover started are not counted as the
    // navigation's own.
    // Both ends of the network window are on the BROWSER's clock (the page's
    // timeOrigin and each request's own start time), so a request cannot fall
    // on the wrong side because of when Node happened to hear about it.
    const windowStart = hardLoad ? wallStart : result.timeOrigin + (result.clickAt as number);
    const windowEnd = closesAt === null ? Number.POSITIVE_INFINITY : result.timeOrigin + closesAt;
    const usefulPaintMs = nonNegative(result.usefulPaintAt);
    // The navigation's OWN page-data fetch, told from prefetches by its headers.
    const fetched = hardLoad
      ? null
      : log.navigationFetch(toRouteTemplate(result.pathname), windowStart - HOVER_MS - 250);
    const sinceClick = (epoch: number | null | undefined) =>
      typeof epoch === 'number' ? epoch - windowStart : null;
    return {
      unsupported: result.unsupported,
      measured: {
        ok: true,
        error: null,
        feedbackMs: hardLoad ? null : nonNegative(result.feedbackAt),
        feedbackPaintMs: hardLoad ? null : nonNegative(result.feedbackPaintAt),
        feedbackBy: result.feedbackBy,
        clickEventDurationMs: result.clickEventDuration,
        clickInputDelayMs: result.clickInputDelay,
        hoverLeadMs: hardLoad ? null : result.hoverLead,
        usefulMs: nonNegative(result.usefulAt),
        usefulPaintMs,
        shellPaintMs: hardLoad ? null : nonNegative(result.shellPaintAt),
        // May be negative: hover warming can send the request before the click.
        rscRequestStartMs: sinceClick(fetched?.requestSentAt),
        rscFirstByteMs: sinceClick(fetched?.firstByteAt),
        // The whole page-data stream in hand: every streamed part, not only the first.
        rscCompleteMs:
          fetched?.requestSentAt != null && fetched.totalMs != null
            ? sinceClick(fetched.requestSentAt + fetched.totalMs)
            : null,
        ttfbMs: hardLoad ? result.ttfb : null,
        fcpMs: hardLoad ? result.fcp : null,
        lcpMs: hardLoad ? result.lcp : null,
        cls: result.cls,
        longTaskBlockingMs: result.longTaskBlocking,
        consoleErrors,
        hydrationErrors,
        listRows: result.listRows,
        network: log.summarize(windowStart, windowEnd),
        photos: collected ? photoSample(collected, log, origin, usefulPaintMs) : null,
      },
    };
  } catch (error) {
    throw crashed ? new PerfFailure('page-crashed') : error;
  } finally {
    await log.detach();
    await page.close().catch(() => {});
  }
}

const FAILED: Measured = {
  ok: false,
  error: null,
  feedbackMs: null,
  feedbackPaintMs: null,
  feedbackBy: null,
  clickEventDurationMs: null,
  clickInputDelayMs: null,
  hoverLeadMs: null,
  usefulMs: null,
  usefulPaintMs: null,
  shellPaintMs: null,
  rscRequestStartMs: null,
  rscFirstByteMs: null,
  rscCompleteMs: null,
  ttfbMs: null,
  fcpMs: null,
  lcpMs: null,
  cls: null,
  longTaskBlockingMs: null,
  consoleErrors: null,
  hydrationErrors: null,
  listRows: null,
  network: null,
  photos: null,
};

// ---------------------------------------------------------------------------
// Environment: measured once, before the first scenario

interface Version {
  build: string | null;
  builtAt: string | null;
  env: string | null;
}

async function siteVersion(baseURL: string): Promise<Version> {
  try {
    const res = await fetch(new URL('/api/version', baseURL), { cache: 'no-store' });
    if (!res.ok) return { build: null, builtAt: null, env: null };
    const body = (await res.json()) as Partial<Version>;
    return { build: body.build ?? null, builtAt: body.builtAt ?? null, env: body.env ?? null };
  } catch {
    return { build: null, builtAt: null, env: null };
  }
}

/** Median of a few tiny same-origin requests: the network the run was really taken on. */
async function roundTrip(baseURL: string): Promise<number | null> {
  const times: number[] = [];
  for (let i = 0; i < 8; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(new URL('/api/version', baseURL), { cache: 'no-store' });
      await res.arrayBuffer();
      // A bot challenge or a 5xx is not the network's round trip.
      if (res.ok && i > 0) times.push(performance.now() - t0); // the first one pays for the TLS handshake
    } catch {
      /* counted as missing */
    }
  }
  times.sort((a, b) => a - b);
  return times.length === 0 ? null : (times[Math.floor(times.length / 2)] as number);
}

function kindOf(host: string, env: string | null): RunMeta['kind'] {
  if (isLoopback(host.split(':')[0] ?? host)) return 'lab';
  if (env === 'production') return 'production-synthetic';
  if (env === 'preview') return 'preview-synthetic';
  return 'unknown-target';
}

let environment: Promise<{ start: Version; rttMs: number | null }> | null = null;
const unsupportedMetrics = new Set<string>();
let lastReport = '';

async function flush(
  use: {
    baseURL?: string;
    viewport?: { width: number; height: number } | null;
    deviceScaleFactor?: number;
  },
  browserVersion: string,
  browserName: string,
): Promise<void> {
  if (samples.length === 0 || environment === null) return;
  const baseURL = use.baseURL ?? '';
  const host = new URL(baseURL).host;
  const { start, rttMs } = await environment;
  const end = await siteVersion(baseURL);
  const identity = existsSync(identityPath())
    ? (JSON.parse(readFileSync(identityPath(), 'utf8')) as { verifiedRole?: string | null })
    : {};
  const cpus = os.cpus();
  const serverState = process.env.PERF_SERVER_STATE ?? 'not controlled';
  const run: RunFile = {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      harnessVersion: HARNESS_VERSION,
      label: process.env.PERF_LABEL ?? 'unlabelled',
      kind: kindOf(host, start.env),
      host,
      buildAtStart: start.build,
      buildAtEnd: end.build,
      builtAt: start.builtAt,
      startedAt,
      finishedAt: new Date().toISOString(),
      browser: browserName,
      browserVersion,
      viewport: use.viewport ? `${use.viewport.width}x${use.viewport.height}` : null,
      devicePixelRatio: use.deviceScaleFactor ?? 1,
      network:
        `${NETWORK}${CPU_SLOWDOWN > 1 ? `, CPU ${CPU_SLOWDOWN}x slower` : ''} (applied by emulation)`.replace(
          'unthrottled (applied by emulation)',
          "unthrottled (the machine's own connection)",
        ),
      rttMs,
      machine: `${os.platform()} ${os.arch()}, ${cpus[0]?.model ?? 'unknown CPU'} x${cpus.length}`,
      role: identity.verifiedRole ?? null,
      roleLabel: roleLabel(),
      dataset: process.env.PERF_DATASET as string,
      serverState: SERVER_STATES.includes(serverState) ? serverState : 'not controlled',
      iterations: ITERATIONS,
      coldIterations: COLD_ITERATIONS,
      hoverMs: HOVER_MS,
      settleMs: SETTLE_MS,
      usefulTimeoutMs: USEFUL_TIMEOUT_MS,
      imageWaitMs: IMAGE_WAIT_MS,
      unsupportedMetrics: [...unsupportedMetrics].sort(),
    },
    scenarios: SCENARIOS.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      routes: [s.start, s.click?.arrives.path ?? s.startReady.path],
    })),
    samples,
  };
  const dir = path.join(
    resultsRoot(),
    `${startedAt.replace(/[:.]/g, '-')}-${run.meta.label}-${browserName}`,
  );
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'results.json');
  // A worker restart (after a scenario timed out) starts with empty memory. Keep
  // what the earlier worker of THIS run already saved for other scenarios.
  if (existsSync(file)) {
    try {
      const earlier = parseRunFile(JSON.parse(readFileSync(file, 'utf8')), 'earlier');
      const mine = new Set(samples.map((s) => s.scenario));
      run.samples = [...earlier.samples.filter((s) => !mine.has(s.scenario)), ...samples];
      run.meta.buildAtStart = earlier.meta.buildAtStart;
    } catch {
      /* unreadable or older shape: this worker's samples stand alone */
    }
  }
  // Raw samples go to disk BEFORE the report is built: a bug in the report must
  // never cost a production run its data.
  writeFileSync(file, JSON.stringify(run, null, 2));
  try {
    const report = buildRunReport(run);
    writeFileSync(path.join(dir, 'summary.md'), report.markdown);
    writeFileSync(path.join(dir, 'chart.svg'), report.chartSvg);
    lastReport = `\nperf results: ${dir}\n\n${report.markdown}`;
  } catch {
    writeFileSync(
      path.join(dir, 'summary.md'),
      'The report could not be built. The raw samples are safe in results.json.\n',
    );
    lastReport = `\nperf results: ${dir} (report failed; raw samples saved)`;
  }
}

for (const scenario of SCENARIOS) {
  if (ONLY.length > 0 && !ONLY.includes(scenario.id)) continue;

  test(scenario.title, async ({ browser, browserName }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? '';
    // Emulation goes through the DevTools protocol, which only Chromium speaks.
    // Checked HERE, once, so a misconfigured run stops with a sentence instead
    // of recording forty opaque failures.
    if ((NETWORK_PROFILES[NETWORK] || CPU_SLOWDOWN > 1) && browserName !== 'chromium') {
      throw new Error('PERF_NETWORK / PERF_CPU throttling needs PERF_BROWSER=chromium.');
    }
    if (!process.env.PERF_DATASET) {
      throw new Error(
        'Set PERF_DATASET to describe the data being measured (for example "Demo Co, 29 list rows, 33 photos"). It cannot be added to a result afterwards.',
      );
    }
    environment ??= (async () => ({
      start: await siteVersion(baseURL),
      rttMs: await roundTrip(baseURL),
    }))();
    await environment;

    const count =
      scenario.iterations ?? (scenario.coldBrowserCache ? COLD_ITERATIONS : ITERATIONS);
    const open = async () => {
      const context = await browser.newContext({ storageState: authStatePath() });
      await context.addInitScript({ content: collectorScript(fingerprintKey()) });
      return context;
    };
    let context = await open();
    try {
      for (let i = 0; i <= count; i++) {
        if (scenario.coldBrowserCache && i > 0) {
          await context.close();
          context = await open();
        }
        const at = new Date().toISOString();
        let sample: Measured;
        try {
          const { measured, unsupported } = await iterate(scenario, context, browserName);
          for (const type of unsupported) unsupportedMetrics.add(type);
          sample = measured;
        } catch (error) {
          sample = {
            ...FAILED,
            error: error instanceof PerfFailure ? error.code : 'unexpected-error',
          };
        }
        samples.push({ scenario: scenario.id, iteration: i, warmup: i === 0, at, ...sample });

        // The same failure three times running (a missing link, an account that
        // cannot see the page) will not fix itself: stop, and say so, instead of
        // spending 30 s x 40 iterations recording it.
        const mine = samples.filter((s) => s.scenario === scenario.id);
        const code = mine[0]?.error;
        if (i === 2 && code && mine.every((s) => !s.ok && s.error === code)) {
          for (let rest = i + 1; rest <= count; rest++) {
            samples.push({
              scenario: scenario.id,
              iteration: rest,
              warmup: false,
              at,
              ...FAILED,
              error: `not-attempted:${code}`,
            });
          }
          break;
        }
      }
      // Cookies the app refreshed during the scenario go back to disk, so the
      // next scenario does not start from a session that has since been rotated.
      await context
        .storageState({ path: authStatePath() })
        .then(() => chmodSync(authStatePath(), 0o600))
        .catch(() => {});
    } finally {
      await context.close().catch(() => {});
      // Written after EVERY scenario: a later crash restarts the worker and
      // would take the in-memory samples with it.
      await flush(testInfo.project.use, browser.version(), browserName);
    }
  });
}

test.afterAll(() => {
  if (lastReport) console.info(lastReport);
});

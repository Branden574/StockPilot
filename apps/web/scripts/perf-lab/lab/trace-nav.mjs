// LOCAL LAB ONLY. Counts the Supabase calls each navigation causes, through the
// latency relay's trace (TRACE_FILE on latency-proxy.mjs). Each navigation is
// bracketed by GET http://127.0.0.1:54400/__mark/<label>:start|end.
//
// Usage (from apps/web): node scripts/perf-lab/lab/trace-nav.mjs <label-prefix> [iterations]
// Env: SERVICE_ROLE_KEY (local stack, never printed), EMAIL (lab account).
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const BASE = 'http://localhost:3000';
const RELAY = 'http://127.0.0.1:54400';
const PREFIX = process.argv[2] ?? 'trace';
const N = Number(process.argv[3] ?? 5);
const EMAIL = process.env.EMAIL ?? 'perf-lab+admin@stockpilotusa.com';

async function tokenHash() {
  const key = process.env.SERVICE_ROLE_KEY;
  const res = await fetch('http://127.0.0.1:54321/auth/v1/admin/generate_link', {
    method: 'POST',
    redirect: 'error',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: EMAIL }),
  });
  if (!res.ok) throw new Error(`generate_link ${res.status}`);
  return (await res.json()).hashed_token;
}
const mark = (label) => fetch(`${RELAY}/__mark/${encodeURIComponent(label)}`).catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 130, downloadThroughput: -1, uploadThroughput: -1 });
await page.goto(`${BASE}/auth/confirm?token_hash=${encodeURIComponent(await tokenHash())}&type=magiclink&next=%2Fdashboard`);
// /auth/confirm has a confirm step (an email scanner fetching the link cannot burn it).
await page.getByRole('button', { name: /continue to stockpilot/i }).click({ timeout: 15000 });
await page.waitForURL(/\/dashboard/, { timeout: 30000 });

async function firstItemHref() {
  await page.goto(`${BASE}/dashboard/inventory`);
  const a = page.locator('main table tbody tr a[href^="/dashboard/inventory/"]').first();
  await a.waitFor({ timeout: 30000 });
  return (await a.getAttribute('href')).split('?')[0];
}

const scenarios = [
  { id: 'inventory', start: '/dashboard', click: 'aside a[href="/dashboard/inventory"]', done: 'main table tbody tr a[href^="/dashboard/inventory/"]', url: /\/dashboard\/inventory$/ },
  { id: 'books', start: '/dashboard', click: 'aside a[href="/dashboard/books"]', done: 'main table tbody tr a[href]', url: /\/dashboard\/books$/ },
  { id: 'orders', start: '/dashboard', click: 'aside a[href="/dashboard/orders"]', done: 'main a[href^="/dashboard/orders/"]', url: /\/dashboard\/orders$/ },
  { id: 'item', start: '/dashboard/inventory', click: 'main table tbody tr a[href^="/dashboard/inventory/"]', done: 'main div.sticky h1', url: /\/dashboard\/inventory\/[0-9a-f-]{36}/ },
  { id: 'movements', start: 'ITEM', click: '#item-detail-tab-movements', done: '#item-detail-panel-movements', url: /tab=movements/ },
  { id: 'activity', start: 'ITEM', click: '#item-detail-tab-activity', done: '#item-detail-panel-activity', url: /tab=activity/ },
  { id: 'order', start: '/dashboard/orders', click: 'main a[href^="/dashboard/orders/"]:not([href$="/new"])', done: 'main h1', url: /\/dashboard\/orders\/[0-9a-f-]{36}/ },
  { id: 'adjust-save', start: 'ITEM', setup: 'main button:has-text("Adjust stock")', click: '[role="dialog"] button:has-text("Apply")', changed: '#item-detail-panel-overview span.text-base.font-semibold.tabular-nums', tail: 2500 },
];

const only = (process.env.ONLY ?? '').split(',').filter(Boolean);
const itemHref = await firstItemHref();
for (const s of scenarios) {
  if (only.length && !only.includes(s.id)) continue;
  for (let i = 0; i < N; i++) {
    await page.goto(`${BASE}${s.start === 'ITEM' ? itemHref : s.start}`);
    await page.waitForLoadState('load');
    await sleep(2000);
    if (s.setup) {
      await page.locator(s.setup).first().click();
      await sleep(400);
    }
    const before = s.changed ? await page.locator(s.changed).first().textContent() : null;
    const link = page.locator(s.click).first();
    await link.hover();
    await sleep(150);
    await mark(`${PREFIX}:${s.id}:${i}:start`);
    const t0 = Date.now();
    await link.click({ noWaitAfter: true });
    try {
      if (s.changed) {
        await page.waitForFunction(([sel, prev]) => (document.querySelector(sel)?.textContent ?? '') !== prev, [s.changed, before], { timeout: 30000 });
      } else {
        await page.waitForURL(s.url, { timeout: 30000 });
        await page.locator(s.done).first().waitFor({ timeout: 30000 });
      }
      const ms = Date.now() - t0;
      await sleep(s.tail ?? 1500);
      await mark(`${PREFIX}:${s.id}:${i}:end:${ms}`);
    } catch {
      await mark(`${PREFIX}:${s.id}:${i}:end:timeout`);
    }
  }
}
await browser.close();
console.log('trace pass done', PREFIX);

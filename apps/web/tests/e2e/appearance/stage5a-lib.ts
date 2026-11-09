import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
} from '@playwright/test';

import {
  canonicalJson,
  DEVICE_LOCAL_KEYS,
  DEVICE_SESSION_KEYS,
  INFO_LOCAL_KEYS,
  STYLE_COOKIE,
  type DeviceSnapshot,
} from './stage5a-records';
import type { NetRequest } from './stage5a-network';
import { msLeftInStep, totp } from './stage5a-totp';
import { isAppearanceSaveBody } from './switch-requests';
import {
  attributeRecorder,
  paintFrameRecorder,
  readAttrHistory,
  readPaintFrames,
  type AttrHistory,
  type PaintFrames,
} from './stage5a-paint';

/**
 * Shared steps for writerA's stage 5 specs (plan 8.2 cases 2, 4, 5, 6, 7, 9,
 * 10, 11, 12 and plan 8.5): lab users and sign-in (TOTP from an environment
 * seed, node crypto), the bell's unread count (8.2 A6), save interception
 * (delay, failure), device-record snapshots, the stage 5 state folder for
 * phased cases, the attribute history and a CDP screencast for hard loads.
 *
 * LAB ONLY. Everything comes from the environment the stage 5 runner
 * (liquid-glass/verify/stage5/run-stage5.sh) sets; nothing secret is in this
 * file, and every value is a lab value:
 *   PLAYWRIGHT_BASE_URL       the branch server under test (next start)
 *   STAGE5_BASE_URL_B         the classic server at B (headers parity)
 *   STAGE5_ROLE               the signed-in role of this run (admin, manager,
 *                             staff, viewer, platform, portal; unset or
 *                             'anonymous' for the signed-out run)
 *   STAGE5_ROLLOUT            off | opt-in | default (cross-checked against
 *                             the page's head script)
 *   STAGE5_PHASE, STAGE5_STATE_DIR   the phased cases (kill switch, rehearsal)
 *   STAGE5_A_EMAIL, STAGE5_A_PASSWORD   lab user A (an organisation admin)
 *   STAGE5_B_EMAIL, STAGE5_B_PASSWORD   lab user B (another member of A's
 *                             organisation: the account switch)
 *   STAGE5_MFA_EMAIL, STAGE5_MFA_PASSWORD, STAGE5_MFA_TOTP_SECRET   a lab
 *                             user with a verified TOTP factor (base32 seed)
 *   STAGE5_LAB_DB_URL         the lab's Postgres (127.0.0.1 or localhost
 *                             only; labSql refuses any other host), used to
 *                             read a user's user_appearance row and to remove
 *                             it for the "missing row" and SR4 cases
 */

// ── environment ────────────────────────────────────────────────────────────

export type Stage5Role = 'admin' | 'manager' | 'staff' | 'viewer' | 'platform' | 'portal';

/** The role this run is signed in as, or null for the signed-out run. */
export function stage5Role(): Stage5Role | null {
  const role = process.env.STAGE5_ROLE;
  if (!role || role === 'anonymous') return null;
  return role as Stage5Role;
}

/**
 * Cases that make their own contexts and users run once per build, not once
 * per role: in the admin run (or a run with no STAGE5_ROLE at all).
 */
export function onlyOnceAcrossRoles(): void {
  const role = process.env.STAGE5_ROLE;
  test.skip(
    role !== undefined && role !== 'admin',
    `Runs once per build, in the admin run (this run: ${role}).`,
  );
}

/** The named environment values, or the test skips naming what is missing. */
export function requireEnv<const K extends string>(...names: K[]): Record<K, string> {
  const missing = names.filter((name) => !process.env[name]);
  test.skip(missing.length > 0, `Needs ${missing.join(', ')} (lab values, from the runner).`);
  return Object.fromEntries(names.map((name) => [name, process.env[name] ?? ''])) as Record<
    K,
    string
  >;
}

export interface LabUser {
  email: string;
  password: string;
  totpSecret?: string;
}

export function labUser(which: 'A' | 'B' | 'MFA'): LabUser {
  if (which === 'MFA') {
    const env = requireEnv('STAGE5_MFA_EMAIL', 'STAGE5_MFA_PASSWORD', 'STAGE5_MFA_TOTP_SECRET');
    return {
      email: env.STAGE5_MFA_EMAIL,
      password: env.STAGE5_MFA_PASSWORD,
      totpSecret: env.STAGE5_MFA_TOTP_SECRET,
    };
  }
  const email = `STAGE5_${which}_EMAIL` as const;
  const password = `STAGE5_${which}_PASSWORD` as const;
  const env = requireEnv(email, password);
  return { email: env[email], password: env[password] };
}

// ── the lab database (read a row, remove a row) ────────────────────────────

/** Throws unless the URL's host is this machine: nothing here may reach another database. */
export function assertLabDatabase(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('STAGE5_LAB_DB_URL is not a URL.');
  }
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`STAGE5_LAB_DB_URL must point at 127.0.0.1 or localhost (got ${host}).`);
  }
}

/** Runs one SQL statement on the lab with psql (-At: bare rows). */
export function labSql(sql: string): string {
  const { STAGE5_LAB_DB_URL: url } = requireEnv('STAGE5_LAB_DB_URL');
  assertLabDatabase(url);
  return execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const quote = (text: string) => `'${text.replace(/'/gu, "''")}'`;

/** The user's user_appearance row as `style|theme`, or null when there is none. */
export function appearanceRow(email: string): string | null {
  const out = labSql(
    `select coalesce(a.style,'') || '|' || coalesce(a.theme,'') from public.user_appearance a ` +
      `join auth.users u on u.id = a.user_id where lower(u.email) = lower(${quote(email)})`,
  ).trim();
  return out === '' ? null : out;
}

/** Removes the user's user_appearance row (the "never chose on an account" state). */
export function removeAppearanceRow(email: string): void {
  labSql(
    `delete from public.user_appearance where user_id = ` +
      `(select id from auth.users where lower(email) = lower(${quote(email)}))`,
  );
}

// ── sign-in and sign-out through the real pages ────────────────────────────

/** The 30 s step of the last code typed per seed: a code is never typed twice. */
const lastStep = new Map<string, number>();

/**
 * A code with at least 4 s left in its step (never typed as it expires), from
 * a step no earlier sign-in of this run used (a verifier may refuse a code
 * it has already accepted).
 */
export async function freshTotp(page: Page, secret: string): Promise<string> {
  const step = () => Math.floor(Date.now() / 30_000);
  if (msLeftInStep(Date.now()) < 4000 || lastStep.get(secret) === step()) {
    await page.waitForTimeout(msLeftInStep(Date.now()) + 250);
  }
  lastStep.set(secret, step());
  return totp(secret, Date.now());
}

/** Fills the sign-in form already on screen and submits it; answers the two-step page when asked. */
export async function submitSignIn(page: Page, user: LabUser): Promise<void> {
  await page.getByLabel(/email/iu).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: /sign in/iu }).click();
  await Promise.race([
    page.waitForURL(/\/dashboard/u, { timeout: 20_000 }),
    page.waitForURL(/\/signin\/mfa/u, { timeout: 20_000 }),
  ]);
  if (/\/signin\/mfa/u.test(page.url())) {
    if (!user.totpSecret)
      throw new Error(`${user.email} asks for a two-step code and has no seed.`);
    await page.locator('#mfa-code').fill(await freshTotp(page, user.totpSecret));
    await page.getByRole('button', { name: 'Verify & continue' }).click();
    await page.waitForURL(/\/dashboard/u, { timeout: 20_000 });
  }
}

/** Opens /signin and signs in. */
export async function signIn(page: Page, user: LabUser): Promise<void> {
  await page.goto('/signin');
  await submitSignIn(page, user);
}

/** Signs out through the account menu, as a person does. */
export async function signOut(page: Page): Promise<void> {
  await page.locator('#user-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL(/\/signin|\/$/u, { timeout: 20_000 });
}

/** A fresh browser context with nobody signed in (no cookies, no storage). */
export async function signedOutContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  return browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
}

interface SavedProfile {
  cookies: Array<{ name: string } & Record<string, unknown>>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

/**
 * A fresh context with this project's signed-in profile (its storageState,
 * or nobody for the signed-out project) whose appearance records all say
 * `look`: the Design cookie (when the rollout needs one: `cookie`, null for
 * none), the device record and next-themes' theme. Every other appearance
 * key is dropped, so no earlier spec's records leak in.
 */
export async function contextWithLook(
  browser: Browser,
  baseURL: string,
  look: { design: 'classic' | 'liquid-glass'; theme: 'light' | 'dark' },
  cookie: string | null,
): Promise<BrowserContext> {
  const project = test.info().project.use.storageState;
  const base: SavedProfile =
    typeof project === 'string' && existsSync(project)
      ? (JSON.parse(readFileSync(project, 'utf8')) as SavedProfile)
      : { cookies: [], origins: [] };
  const url = new URL(baseURL);
  const appearanceKeys = new Set<string>([...DEVICE_LOCAL_KEYS, ...INFO_LOCAL_KEYS]);
  return browser.newContext({
    baseURL,
    storageState: {
      cookies: [
        ...(base.cookies.filter((c) => c.name !== STYLE_COOKIE) as never[]),
        ...(cookie === null
          ? []
          : [
              {
                name: STYLE_COOKIE,
                value: cookie,
                domain: url.hostname,
                path: '/',
                expires: -1,
                httpOnly: false,
                secure: false,
                sameSite: 'Lax' as const,
              },
            ]),
      ],
      origins: [
        {
          origin: url.origin,
          localStorage: [
            ...(base.origins[0]?.localStorage ?? []).filter((i) => !appearanceKeys.has(i.name)),
            {
              name: 'sp-appearance',
              value: JSON.stringify({ v: 2, style: look.design, theme: look.theme }),
            },
            { name: 'theme', value: look.theme },
          ],
        },
      ],
    },
  });
}

// ── the bell (8.2 A6: no duplicate notifications) ──────────────────────────

/** The bell's unread count (its accessible name), or null when the page has no bell. */
export async function bellCount(page: Page): Promise<number | null> {
  const bell = page.locator('header a[href="/dashboard/notifications"]').first();
  if ((await bell.count()) === 0) return null;
  const label = (await bell.getAttribute('aria-label')) ?? '';
  const match = /\((\d+) unread\)/u.exec(label);
  return match ? Number(match[1]) : 0;
}

// ── the account save: watch, delay, fail ───────────────────────────────────

/** A request that is the account save (setMyAppearanceAction). */
export function isSave(request: Request): boolean {
  return (
    request.method() === 'POST' &&
    Boolean(request.headers()['next-action']) &&
    isAppearanceSaveBody(request.postData())
  );
}

export interface SaveBody {
  userId: string;
  style?: string;
  theme?: string;
}

/** Records every account save `page` sends from now on, with its body. */
export function watchSaves(page: Page): { list(): SaveBody[]; reset(): void } {
  let seen: SaveBody[] = [];
  page.on('request', (request) => {
    if (!isSave(request)) return;
    const [input] = JSON.parse(request.postData() ?? '[]') as [Record<string, unknown>];
    const clean = (v: unknown) => (typeof v === 'string' && v !== '$undefined' ? v : undefined);
    seen.push({
      userId: String(input.userId),
      ...(clean(input.style) ? { style: clean(input.style) } : {}),
      ...(clean(input.theme) ? { theme: clean(input.theme) } : {}),
    });
  });
  return {
    list: () => [...seen],
    reset: () => {
      seen = [];
    },
  };
}

/**
 * Holds every account save for `ms` before it goes on (a slow network). Every
 * other request passes untouched.
 */
export async function delaySaves(page: Page, ms: number): Promise<void> {
  await page.route('**/*', async (route) => {
    if (isSave(route.request())) await new Promise((resolve) => setTimeout(resolve, ms));
    await route.fallback();
  });
}

/**
 * Answers the account saves with a server error while `failing()` says so;
 * returns how many it answered. Every other request passes untouched.
 */
export async function failSaves(
  page: Page,
  failing: () => boolean,
  status = 500,
): Promise<{ failed(): number }> {
  let failed = 0;
  await page.route('**/*', async (route) => {
    if (failing() && isSave(route.request())) {
      failed += 1;
      await route.fulfill({ status, contentType: 'text/plain', body: 'lab: save refused' });
      return;
    }
    await route.fallback();
  });
  return { failed: () => failed };
}

// ── every request, for the parity comparisons (stage5a-network.ts) ─────────

/** Records every request `page` makes from now on, as stage5a-network.ts reads it. */
export function recordRequests(page: Page): { list(): NetRequest[]; reset(): void } {
  let seen: NetRequest[] = [];
  page.on('request', (request) => {
    seen.push({
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      postData: request.postData(),
    });
  });
  return {
    list: () => [...seen],
    reset: () => {
      seen = [];
    },
  };
}

/** The paths of the same-origin links the page holds now. */
export async function linkPaths(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
      .map((a) => new URL(a.href, location.href))
      .filter((u) => u.origin === location.origin)
      .map((u) => u.pathname),
  );
}

// ── device records ─────────────────────────────────────────────────────────

/** This tab's device records (stage5a-records.ts), read from the page. */
export async function deviceSnapshot(page: Page): Promise<DeviceSnapshot> {
  const stored = await page.evaluate(
    ({ local, session, info }) => {
      const read = (store: Storage, keys: readonly string[]) =>
        Object.fromEntries(keys.map((k) => [k, store.getItem(k)]));
      return {
        local: read(localStorage, local),
        session: read(sessionStorage, session),
        info: read(localStorage, info),
      };
    },
    {
      local: [...DEVICE_LOCAL_KEYS],
      session: [...DEVICE_SESSION_KEYS],
      info: [...INFO_LOCAL_KEYS],
    },
  );
  const cookie =
    (await page.context().cookies(page.url())).find((c) => c.name === STYLE_COOKIE)?.value ?? null;
  return { cookie, ...stored };
}

// ── the stage 5 state folder (phased cases) ────────────────────────────────

/** The phase this run of a phased spec is in (STAGE5_PHASE), or null. */
export function stage5Phase(): string | null {
  return process.env.STAGE5_PHASE ?? null;
}

export function stateDir(): string {
  const { STAGE5_STATE_DIR: dir } = requireEnv('STAGE5_STATE_DIR');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeState(name: string, value: unknown): void {
  writeFileSync(join(stateDir(), name), typeof value === 'string' ? value : canonicalJson(value));
}

export function readState(name: string): string | null {
  const path = join(stateDir(), name);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function statePath(name: string): string {
  return join(stateDir(), name);
}

// ── first paint: the attribute's whole history, and a screencast ───────────

/**
 * Records every value data-appearance takes on <html> from the moment <html>
 * exists (an init script that waits for <html>, so it sees the head script's
 * write), including a value set and removed within one task
 * (attributeOldValue). See stage5a-paint.ts for why it must wait.
 */
export async function recordAttributeHistory(page: Page | BrowserContext): Promise<void> {
  // Called with no argument in the page (its parameters exist for the unit
  // tests); typed as such, since Playwright's argument inference cannot follow
  // the DOM parameter types.
  await page.addInitScript(attributeRecorder as () => void);
}

/** The recorded history; throws when the recorder never started on this page. */
export async function attributeHistory(page: Page): Promise<AttrHistory> {
  return readAttrHistory(
    await page.evaluate(() => (window as unknown as { __lgAttrHistory?: unknown }).__lgAttrHistory),
  );
}

/** Installs the frame probe (stage5a-paint.ts paintFrameRecorder). */
export async function recordPaintFrames(page: Page | BrowserContext): Promise<void> {
  await page.addInitScript(paintFrameRecorder);
}

/** What the frame probe saw; throws when it saw no frame on this page. */
export async function paintFrames(page: Page): Promise<PaintFrames> {
  return readPaintFrames(
    await page.evaluate(() => (window as unknown as { __lgPaintFrames?: unknown }).__lgPaintFrames),
  );
}

/**
 * A CDP screencast of `page` (Chromium only): every frame the compositor
 * produced, kept as JPEG for a person to look through, saved under `dir`
 * when stopped. Start it before the navigation it should cover.
 */
export async function startScreencast(page: Page): Promise<{
  stop(dir: string, prefix: string): Promise<number>;
}> {
  const cdp = await page.context().newCDPSession(page);
  const frames: { data: string; at: number }[] = [];
  cdp.on('Page.screencastFrame', (frame) => {
    frames.push({ data: frame.data, at: frame.metadata.timestamp ?? 0 });
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 });
  return {
    async stop(dir, prefix) {
      await cdp.send('Page.stopScreencast').catch(() => undefined);
      mkdirSync(dir, { recursive: true });
      frames.forEach((frame, i) => {
        writeFileSync(
          join(dir, `${prefix}-${String(i).padStart(3, '0')}.jpg`),
          Buffer.from(frame.data, 'base64'),
        );
      });
      await cdp.detach().catch(() => undefined);
      return frames.length;
    },
  };
}

/** Whether this project's browser is Chromium (CDP, CPU throttling, screencast). */
export function isChromium(page: Page): boolean {
  return page.context().browser()?.browserType().name() === 'chromium';
}

/** Throttles the CPU through CDP (Chromium only); 1 turns it off. */
export async function throttleCpu(page: Page, rate: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
}

/** The glass attribute and theme class both say `look` (a check, not a wait). */
export async function expectLookNow(
  page: Page,
  look: { design: 'classic' | 'liquid-glass'; theme: 'light' | 'dark' },
  why: string,
): Promise<void> {
  const shown = await page.evaluate(() => ({
    glass: document.documentElement.getAttribute('data-appearance') === 'liquid-glass',
    dark: document.documentElement.classList.contains('dark'),
  }));
  expect(
    { design: shown.glass ? 'liquid-glass' : 'classic', theme: shown.dark ? 'dark' : 'light' },
    why,
  ).toEqual(look);
}

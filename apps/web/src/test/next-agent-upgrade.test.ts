import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import nextConfig from '../../next.config';

/**
 * Next 16.4 added an upgrade reminder to `next dev` and `next build`:
 * `experimental.agentUpgrade`, default 'security' (vercel/next.js#99311).
 *
 * Under a detected AI agent (AI_AGENT or CLAUDECODE, both set in every agent
 * shell here), while npm lists an advisory for the installed Next.js, the
 * command stops with exit code 1 (SecurityFatalError) and tells the agent to
 * run `next upgrade`. A retry within five minutes continues, so agent builds
 * and dev starts fail on every other run for as long as the advisory is open;
 * `next build` stops only after the whole build has run. Next 16.3 had no
 * such step. next.config.ts sets the option to false, which keeps 16.3's
 * behaviour: next/dist/build/index.js and next/dist/server/lib/router-server.js
 * load the reminder only for 'security', 'latest' or 'experimental-future', or
 * when the __NEXT_AGENT_UPGRADE variable asks for one.
 *
 * These tests drive Next's own reminder (next/dist/lib/upgrade/nudge.js) with
 * a fixed open advisory and with fetch stubbed to fail, so nothing leaves the
 * machine. Each run loads a fresh copy of the module, the way each `next build`
 * process does: the module remembers an allowed retry for its own lifetime.
 * If the CONTROL starts failing, Next changed the reminder, and this setting
 * needs a fresh look.
 */

const nodeRequire = createRequire(import.meta.url);

const NUDGE = 'next/dist/lib/upgrade/nudge.js';
const AGENT_NAME = 'next/dist/telemetry/agent-name.js';

type Reminder = {
  kind: 'security';
  policy: 'security';
  installedVersion: string;
  reference: string | null;
  targetVersion: string;
};

type NudgeModule = {
  getUpgradeContext: (config: unknown) => unknown;
  nudgeUpgrade: (
    directory: string,
    context: unknown,
    command: 'build' | 'dev',
    signal: AbortSignal | null,
    initialAssessment: Promise<Reminder | null> | null,
    telemetryOptions: null,
  ) => Promise<unknown>;
};

const { defaultConfig } = nodeRequire('next/dist/server/config-shared.js') as {
  defaultConfig: Record<string, unknown> & { experimental: Record<string, unknown> };
};
const { experimentalSchema } = nodeRequire('next/dist/server/config-schema.js') as {
  experimentalSchema: { agentUpgrade: { safeParse: (value: unknown) => { success: boolean } } };
};
const installedVersion = (nodeRequire('next/package.json') as { version: string }).version;

const OPEN_ADVISORY: Reminder = {
  kind: 'security',
  policy: 'security',
  installedVersion,
  reference: 'https://example.invalid/advisory',
  targetVersion: '99.0.0',
};

const STOPPED = { name: 'SecurityFatalError', exitCode: 1 };

function forgetNudgeModules() {
  for (const id of [NUDGE, AGENT_NAME]) delete nodeRequire.cache[nodeRequire.resolve(id)];
}

/**
 * The config Next builds from the app's: the app's experimental keys over
 * Next's defaults, dropping undefined and null, as
 * next/dist/server/config.js assignDefaultsAndValidate merges them.
 */
function resolvedConfig(experimental: object | undefined) {
  const own = Object.fromEntries(
    Object.entries(experimental ?? {}).filter(([, value]) => value !== undefined && value !== null),
  );
  return { ...defaultConfig, experimental: { ...defaultConfig.experimental, ...own } };
}

/** One `next build` or `next dev` start, as far as the reminder goes. */
async function run(directory: string, experimental: object | undefined, command: 'build' | 'dev') {
  forgetNudgeModules();
  const nudge = nodeRequire(NUDGE) as NudgeModule;
  const context = nudge.getUpgradeContext(resolvedConfig(experimental));
  try {
    await nudge.nudgeUpgrade(
      directory,
      context,
      command,
      null,
      Promise.resolve(OPEN_ADVISORY),
      null,
    );
    return 'continued';
  } catch (error) {
    return { name: (error as Error).name, exitCode: (error as { exitCode?: unknown }).exitCode };
  }
}

describe("Next's upgrade reminder for AI agents (experimental.agentUpgrade)", () => {
  let directory: string;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'sp-agent-upgrade-'));
    vi.stubEnv('AI_AGENT', 'claude-code');
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('__NEXT_AGENT_UPGRADE', undefined);
    vi.stubEnv('__NEXT_AGENT_UPGRADE_FORCE_TERMINAL_FOR_TESTING', undefined);
    vi.stubEnv('NEXT_PRIVATE_WORKER', undefined);
    fetchSpy = vi.fn(async () => {
      throw new Error('this test makes no network request');
    });
    vi.stubGlobal('fetch', fetchSpy);
    // Next prints its "continuing after the upgrade reminder" line with console.warn.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    forgetNudgeModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('is turned off in next.config.ts', () => {
    expect(nextConfig.experimental?.agentUpgrade).toBe(false);
  });

  it("is set to a value Next's config schema accepts, so Next applies it without an invalid-option warning", () => {
    expect(
      experimentalSchema.agentUpgrade.safeParse(nextConfig.experimental?.agentUpgrade).success,
    ).toBe(true);
  });

  it("never stops an agent's build or dev start with this config, even while an advisory covers the installed Next.js", async () => {
    const runs = [];
    for (const command of ['build', 'build', 'build', 'dev', 'dev', 'dev'] as const) {
      runs.push(await run(directory, nextConfig.experimental, command));
    }

    expect(runs).toEqual(Array(6).fill('continued'));
    // It returned before it wrote a retry receipt (into <dir>/.next/cache) or asked npm.
    await expect(stat(path.join(directory, '.next'))).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("CONTROL: without the setting, Next's default stops every other run of an agent's build", async () => {
    expect(defaultConfig.experimental.agentUpgrade).toBe('security');
    const withoutSetting = { ...nextConfig.experimental, agentUpgrade: undefined };

    const runs = [];
    for (let i = 0; i < 4; i++) runs.push(await run(directory, withoutSetting, 'build'));

    expect(runs).toEqual([STOPPED, 'continued', STOPPED, 'continued']);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('This command is continuing after the upgrade reminder.'),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

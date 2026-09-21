/**
 * Shared helpers for the Perf Lab dataset tooling (seed / verify / teardown).
 *
 * WHAT THE PERF LAB IS: one separate organization, slug `stockpilot-perf-lab`,
 * holding synthetic data shaped like a real customer's MEASURED photo
 * distribution, so page and photo timings can be taken against realistic
 * volume without ever measuring inside a customer organization. Teardown is
 * "delete that one organization and everything under it".
 *
 * These scripts are eventually run against PRODUCTION by the owner, so this
 * file is mostly safety rails. Every rail below exists because the failure it
 * prevents is cheap to make and expensive to undo:
 *
 *   1. `--target=local|production` is mandatory. There is no default, because
 *      a default is a decision somebody did not make.
 *   2. `local` accepts only a loopback URL. `production` is PINNED to the one
 *      known project host and never read from the environment, so "production"
 *      can never mean "whatever SUPABASE_URL happens to hold today".
 *   3. `production` also needs the flag `--i-am-authorized-by-the-owner` AND
 *      the env `PERF_LAB_CONFIRM=stockpilot-perf-lab`, then prints what it is
 *      about to do and waits 10 seconds before the first write.
 *   4. The key comes from the env `SUPABASE_SERVICE_ROLE_KEY` only. It is never
 *      read from a file, never printed, never put in an error message.
 *   5. The run aborts unless the key really bypasses RLS (the seed-demo-org.mjs
 *      probe). An anon key would otherwise "succeed" at reading nothing.
 *   6. Every org-scoped read and write goes through `orgScope()`, which pins
 *      `organization_id` and refuses the two organizations that must never be
 *      touched, and any organization whose slug is not exactly the Perf Lab's.
 *   7. THE SLUG IS NOT PROOF OF OWNERSHIP. The product lets a person create an
 *      organization whose name slugifies to `stockpilot-perf-lab`, and that row
 *      would be in no forbidden list. So an existing row is trusted only when it
 *      also carries the exact Perf Lab name AND the provenance marker this tool
 *      stamps into `billing_notes` at creation (a column tenants cannot write:
 *      migration 0218), AND every one of its members is one of the six exact
 *      Perf Lab addresses. On production it must additionally be pinned with
 *      `--org-id`. See assertIsPerfLabOrg() and assertPerfLabOrgIsOurs().
 *   8. Unknown flags are refused, and so is a flag given twice. `--dryrun`
 *      (typo) must not become a live run, and a recalled command line with a
 *      second `--target` appended must not silently use the last one.
 *   9. `--dry-run` makes every write helper THROW, so a missing `if (dryRun)`
 *      in a caller is a loud bug instead of a quiet production write. The writes
 *      that do not go through orgScope() (storage, the Auth admin API, the
 *      organization row itself) call assertLive() for the same reason.
 *
 * WHEN EACH RAIL REFUSES, AND WHAT THE EXIT CODE PROMISES. Rails 1-4 and 8, and
 * the flag checks (`--slug`, `--org-id`), refuse with NO network traffic at all:
 * refuseEarly(), exit 2, "nothing was read or written". Rails 5-7 are questions
 * about the database, so they refuse after READ-ONLY queries and before any
 * write: refuse(), exit 2, "only reads were run". Those trailers are appended by
 * the two functions, not typed into each message, so a message cannot claim the
 * wrong one. And once a script has called noteWritesBegun(), refuse() stops being
 * a refusal: the same check failing MID-RUN exits 1 and says what had already
 * been done, because exit 2 must never be read as "nothing happened" when
 * something did.
 *
 * No dependencies beyond @supabase/supabase-js (resolved from apps/web).
 */
import { randomBytes } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

// ── Identity of the one organization these scripts may touch ────────────────
export const PERF_LAB_SLUG = 'stockpilot-perf-lab';
export const PERF_LAB_NAME = 'StockPilot Perf Lab';

/**
 * Provenance marker, written into `organizations.billing_notes` by the seed in
 * the SAME insert that creates the row, and required by every script before it
 * trusts a row it found by slug.
 *
 * Why that column: it is the one free-text field on the row a tenant cannot
 * write. The 0218 trigger blocks the `authenticated` and `anon` roles from
 * changing any billing column, so only the service role and the platform console
 * can set it. A person who creates an organization called "StockPilot Perf Lab"
 * through the product gets the slug and the name, and cannot get this. It also
 * tells whoever opens the organization in the platform console what it is.
 * Matched with includes(), so a note added around it in the console is fine.
 */
export const PERF_LAB_MARKER = 'perf-lab-synthetic';
export const PERF_LAB_BILLING_NOTE = `${PERF_LAB_MARKER}: benchmark organization created by apps/web/scripts/perf-lab/seed.mjs. Synthetic data only. Remove with teardown.mjs. Do not clear this note: the Perf Lab scripts refuse an organization without it.`;

/**
 * Stamped into every account the seed creates, as auth `app_metadata`. Unlike
 * `user_metadata`, a signed-in user cannot write app_metadata, so an account at a
 * Perf Lab address that lacks it was not made by this tool: someone registered
 * the address by hand. The seed refuses to adopt such an account and teardown
 * keeps it.
 */
export const ACCOUNT_STAMP = Object.freeze({ perf_lab: PERF_LAB_MARKER });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Lower-case canonical uuid, the shape Postgres renders. Every id these scripts build a filter or a storage prefix from must pass. */
export const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);

/** The columns every script reads from the organization row. One list, so no caller can omit what a rail needs. */
export const ORG_COLUMNS =
  'id, slug, name, plan, all_modules_comp, mfa_policy, billing_notes, created_at';

/**
 * Organizations that must NEVER be read from or written to by these scripts,
 * whatever else goes wrong (an edited constant, a bad slug lookup, a pasted
 * id). Checked wherever an org id enters the program.
 */
export const FORBIDDEN_ORG_IDS = Object.freeze({
  '63c13e64-92a6-4ea4-9936-6a2c26a85b4a': 'the customer organization',
  '71b27a4a-7948-4638-bc3f-535974713bd2': 'Demo Co, the QA organization',
});

/** The production project. A host, not a secret (seed-demo-org.mjs carries it too). */
const PRODUCTION_URL = 'https://xizpqmhhslgzbuqtjubv.supabase.co';
const LOCAL_DEFAULT_URL = 'http://127.0.0.1:54321';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

const AUTHORIZED_FLAG = '--i-am-authorized-by-the-owner';
const CONFIRM_ENV = 'PERF_LAB_CONFIRM';
const KEY_ENV = 'SUPABASE_SERVICE_ROLE_KEY';
const PRODUCTION_WAIT_SECONDS = 10;

/** Every bucket object the seed writes lives under `<orgId>/` in this bucket. */
export const ITEM_IMAGES_BUCKET = 'item-images';

// ── Accounts ────────────────────────────────────────────────────────────────
// One account per role for the role matrix, plus a staff account restricted to
// ONE warehouse. Plus-addressing on the company domain: nothing is ever mailed
// to them (see README, "Side effects"), and if something were, it would land in
// a company mailbox rather than a stranger's.
export const ACCOUNT_KEYS = Object.freeze([
  'owner',
  'admin',
  'manager',
  'staff',
  'viewer',
  'staff-restricted',
]);
export const perfLabEmail = (key) => `perf-lab+${key}@stockpilotusa.com`;

/**
 * THE one test for "is this a Perf Lab account": the email is one of the six
 * EXACT addresses the seed creates. Used for the stranger check in seed and
 * teardown, for finding accounts, and again at the point of deletion.
 *
 * Deliberately not a pattern. An earlier version matched perf-lab+<anything>,
 * which meant a seventh address (a teammate's own perf-lab+name login) was
 * neither refused as a stranger nor kept: it was deleted. These scripts create
 * six accounts, so six is what they may recognise. Anything else is a person.
 */
const PERF_LAB_EMAILS = new Set(ACCOUNT_KEYS.map(perfLabEmail));
export const isPerfLabAccountEmail = (email) =>
  PERF_LAB_EMAILS.has(String(email ?? '').toLowerCase());

// ── Output ──────────────────────────────────────────────────────────────────
// Counts and fixed strings only. No ids of other organizations, no emails of
// real people, no URLs that carry a token, no key material: a terminal
// scrollback is a document that gets pasted into tickets.
// console.info, not console.log: the repo's ESLint config allows info/warn/error and
// flags bare console.log.
export const log = (msg = '') => console.info(msg);

/**
 * What this process has already changed, in words, or null while it has only
 * read. Set by the scripts at their first write. It decides what a failed rail
 * is allowed to say and which exit code it may use.
 */
let writesBegun = null;
export function noteWritesBegun(what) {
  if (!writesBegun) writesBegun = what;
}

/** A rail refused BEFORE ANY NETWORK CALL. Exit 2. The trailer is appended here so no message can omit or misstate it. */
export function refuseEarly(msg) {
  console.error(`\nREFUSED: ${msg} Nothing was read or written.\n`);
  process.exit(2);
}

/**
 * A rail refused after reads. Exit 2 means exactly "only reads were run".
 *
 * The same checks are repeated mid-run (ownership is re-asserted after the
 * countdown and again before the last deletes). If one of them fails THEN, this
 * is no longer a refusal: it exits 1 and says what had already been done and how
 * to recover, because "REFUSED, exit 2" after a write would be a lie.
 */
export function refuse(msg) {
  if (writesBegun) {
    console.error(
      `\nERROR: ${msg}\n\nSTOPPED PART-WAY: ${writesBegun}. Nothing further was changed. ` +
        'What this run already did is still in place. Find out what changed, then either run the same ' +
        'command again (on production: with --org-id) or run teardown.\n',
    );
    process.exit(1);
  }
  console.error(`\nREFUSED: ${msg} Only reads were run; nothing was written or deleted.\n`);
  process.exit(2);
}

/** Something failed at runtime. Exit code 1. Safe to re-run: every script is resumable. */
export function die(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

// ── Arguments ───────────────────────────────────────────────────────────────
/**
 * Strict parser. `spec` maps a flag name to 'boolean' or 'value'; anything not
 * in it is refused rather than ignored, because the most dangerous typo here is
 * a misspelt `--dry-run` that silently turns a rehearsal into the real thing.
 */
export function parseArgs(argv, extraSpec = {}) {
  const spec = {
    '--target': 'value',
    '--dry-run': 'boolean',
    [AUTHORIZED_FLAG]: 'boolean',
    '--concurrency': 'value',
    '--slug': 'value',
    '--org-id': 'value',
    '--help': 'boolean',
    ...extraSpec,
  };
  const out = {};
  for (const raw of argv) {
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw : raw.slice(0, eq);
    // Object.hasOwn, not `spec[name]`: a plain lookup finds `constructor` and
    // `toString` on Object.prototype, so "constructor=x" used to be accepted.
    if (!Object.hasOwn(spec, name)) refuseEarly(`unknown argument "${name}".`);
    // A recalled command line with a second --target (or --org-id) appended would
    // otherwise silently use the last one.
    if (Object.hasOwn(out, name)) refuseEarly(`"${name}" was given more than once.`);
    const kind = spec[name];
    if (kind === 'boolean') {
      if (eq !== -1) refuseEarly(`"${name}" takes no value.`);
      out[name] = true;
    } else {
      if (eq === -1 || eq === raw.length - 1)
        refuseEarly(`"${name}" needs a value, as ${name}=...`);
      out[name] = raw.slice(eq + 1);
    }
  }

  // `--help` prints usage and exits in the caller; it needs no target.
  if (out['--help'] === true) return { help: true, raw: out };

  const target = out['--target'];
  if (target !== 'local' && target !== 'production') {
    refuseEarly(
      '--target=local or --target=production is required. There is no default on purpose.',
    );
  }

  // `--slug` and `--org-id` are ASSERTIONS, not selectors: the organization is
  // always found by the one constant slug. They exist so an operator (or a
  // wrapper script) can state what they believe they are aiming at and have the
  // run refuse when that belief is wrong, before anything touches the network.
  if (out['--slug'] !== undefined && out['--slug'] !== PERF_LAB_SLUG) {
    refuseEarly(
      `these scripts only ever operate on the organization with slug "${PERF_LAB_SLUG}". ` +
        'A different slug was given.',
    );
  }
  let expectedOrgId = null;
  if (out['--org-id'] !== undefined) {
    expectedOrgId = out['--org-id'].toLowerCase();
    if (!isUuid(expectedOrgId)) refuseEarly('--org-id must be a uuid.');
    assertNotForbiddenOrgId(expectedOrgId);
  }

  let concurrency = 4;
  if (out['--concurrency'] !== undefined) {
    concurrency = Number(out['--concurrency']);
    // Capped at 8: the point of the bound is to stay far below anything that
    // looks like load to the storage API or trips the edge firewall.
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
      refuseEarly('--concurrency must be a whole number from 1 to 8.');
    }
  }

  return {
    target,
    dryRun: out['--dry-run'] === true,
    authorized: out[AUTHORIZED_FLAG] === true,
    concurrency,
    expectedOrgId,
    help: out['--help'] === true,
    raw: out,
  };
}

/**
 * `seenInDatabase` only changes the wording. A forbidden id given on the command
 * line is refused before any network call ("nothing was read"). One that came
 * back from the slug lookup arrived after two reads (the RLS probe, then the
 * lookup), and a safety message should not claim otherwise.
 */
export function assertNotForbiddenOrgId(orgId, { seenInDatabase = false } = {}) {
  const why = FORBIDDEN_ORG_IDS[String(orgId).toLowerCase()];
  if (!why) return;
  const msg = `organization id ${orgId} is ${why}. These scripts hard-refuse it.`;
  if (seenInDatabase) refuse(`${msg} It came back from a lookup.`);
  refuseEarly(msg);
}

// ── Target resolution (no network) ──────────────────────────────────────────
/**
 * Decides which Supabase URL this run talks to and proves the operator meant
 * it. Runs BEFORE any client exists, so every refusal here happens with zero
 * network traffic: a refused production run never reaches production.
 */
export function resolveTarget(args, env = process.env) {
  const envUrl = (env.SUPABASE_URL ?? '').trim();

  if (args.target === 'local') {
    const url = envUrl || LOCAL_DEFAULT_URL;
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      refuseEarly('SUPABASE_URL is not a valid URL.');
    }
    if (!LOOPBACK_HOSTS.has(host)) {
      refuseEarly(
        '--target=local only accepts a Supabase URL on 127.0.0.1 or localhost, and SUPABASE_URL ' +
          'points somewhere else. Unset it, or use --target=production with its safeguards.',
      );
    }
    // The ORIGIN, not the string as typed: a path, query or userinfo in
    // SUPABASE_URL must not ride along into every request URL.
    return { target: 'local', url: new URL(url).origin };
  }

  // production: the URL is pinned. If the environment ALSO names a URL and it
  // is a different host, the operator's shell and their flag disagree about
  // where this is going; stop and let a human resolve it.
  if (envUrl) {
    let host = null;
    try {
      host = new URL(envUrl).hostname;
    } catch {
      /* fall through to the refusal below */
    }
    if (host !== new URL(PRODUCTION_URL).hostname) {
      refuseEarly(
        '--target=production was given, but SUPABASE_URL in this shell points at a different host. ' +
          'Unset SUPABASE_URL (production is pinned inside the script) and try again.',
      );
    }
  }
  // The key is about to travel to production. Two ways a shell can quietly
  // change what that means, both refused: certificate checking switched off, and
  // code preloaded into this process (NODE_OPTIONS, --import, --require) that
  // could replace fetch. The README's procedure unsets NODE_OPTIONS; this makes
  // forgetting to a refusal instead of a risk.
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    refuseEarly(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 is set, which turns off certificate checking. Unset it before a production run.',
    );
  }
  const preload = /^(-r|--require|--import|--loader|--experimental-loader)(=|$)/;
  if ((env.NODE_OPTIONS ?? '').trim() !== '' || process.execArgv.some((a) => preload.test(a))) {
    refuseEarly(
      'NODE_OPTIONS is set, or node was started with a preload flag (--import, --require, --loader). ' +
        'Unset NODE_OPTIONS and start the script plainly before a production run.',
    );
  }
  if (!args.authorized) {
    refuseEarly(`--target=production needs the flag ${AUTHORIZED_FLAG}.`);
  }
  if (env[CONFIRM_ENV] !== PERF_LAB_SLUG) {
    refuseEarly(
      `--target=production needs the environment variable ${CONFIRM_ENV}=${PERF_LAB_SLUG}.`,
    );
  }
  return { target: 'production', url: PRODUCTION_URL };
}

/** The key, from the process environment and nowhere else. Never logged. */
export function readServiceKey(env = process.env) {
  const key = (env[KEY_ENV] ?? '').trim();
  if (!key) {
    refuseEarly(
      `${KEY_ENV} is not set in the environment. It is read from the environment only ` +
        '(never from a file), so it cannot be picked up by accident.',
    );
  }
  return key;
}

/**
 * Every request this client makes refuses to follow a redirect. On a
 * cross-origin redirect undici drops `Authorization` but NOT the `apikey` header,
 * and for the new-style `sb_secret_` keys the apikey header IS the secret. The
 * API never redirects, so this costs nothing and removes the question.
 */
export function createAdminClient(url, key) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) },
  });
}

/**
 * The backstop for writes that do NOT go through orgScope(): storage, the Auth
 * admin API, the organization row, order lines. Throws in a dry run, so a branch
 * somebody forgot is a loud bug and never a quiet write.
 */
export function assertLive(dryRun, what) {
  if (dryRun !== false) throw new Error(`BUG: ${what} attempted during --dry-run`);
}

/**
 * A read that must succeed AND must have answered. postgrest-js returns
 * `{ data: null, error: null }` for a 2xx (or a 404) with an empty body, and
 * `null` read as "no rows" is how "none found" gets reported without anything
 * having been found out. So: an error stops the run, and so does anything that
 * is not an array.
 */
export async function must(query, what) {
  const { data, error } = await query;
  if (error) die(`${what}: ${error.message || error.code || 'read failed'}`);
  if (!Array.isArray(data)) die(`${what}: the server answered without a rows array.`);
  return data;
}

/**
 * A count is usable only if it is a non-negative integer. `typeof n === 'number'`
 * is not that test: postgrest-js computes parseInt(contentRange[1]), and a
 * Content-Range of "0-0/*" (count unknown) gives NaN, which IS a number, and
 * `NaN > 0` is false, so "has ties elsewhere?" would answer "no" in front of a
 * deleteUser. Found by review; proven with a stubbed response.
 */
function usableCount(count, what) {
  if (!Number.isInteger(count) || count < 0) {
    die(`${what}: the server returned no usable count.`);
  }
  return count;
}

/**
 * Same probe as seed-demo-org.mjs: with an anon or wrong key, RLS makes
 * `organizations` read as EMPTY rather than as an error, and every later
 * "find or create" would then happily create. Seeing at least one row proves
 * the key bypasses RLS.
 *
 * One addition for a brand-new database with no organizations at all: the Auth
 * admin API answers only a service-role key, so it settles "empty table" versus
 * "RLS is hiding rows" without weakening the rail.
 */
export async function assertBypassesRls(admin) {
  const { data, error } = await admin.from('organizations').select('id').limit(1);
  if (error)
    die(`service-key probe failed (${error.code ?? 'no code'}). Is the key for this target?`);
  if (data && data.length > 0) return;
  const probe = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (probe.error) {
    refuse(
      'the key does not bypass RLS (no organizations visible and the Auth admin API refused it). Not a service-role key.',
    );
  }
}

/**
 * The production gate: say plainly what is about to happen, then give the
 * operator ten seconds to change their mind. Called once, immediately before
 * the first write, and never in a dry run (a dry run writes nothing).
 */
export async function productionCountdown(target, summaryLines) {
  if (target !== 'production') return;
  log('');
  log('================================================================');
  log(' THIS RUN WRITES TO PRODUCTION.');
  log('================================================================');
  for (const line of summaryLines) log(` ${line}`);
  log('');
  log(` Organization touched: slug "${PERF_LAB_SLUG}" and nothing else.`);
  log(
    ` Starting in ${PRODUCTION_WAIT_SECONDS} seconds. Press Ctrl-C now to abort with nothing written.`,
  );
  for (let s = PRODUCTION_WAIT_SECONDS; s > 0; s--) {
    process.stdout.write(` ${s}...`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  log('\n');
}

// ── The organization ────────────────────────────────────────────────────────
/**
 * Finds the Perf Lab organization by its slug. Returns null when it does not
 * exist yet. Whatever comes back is checked again before it is trusted; see
 * assertIsPerfLabOrg() for the row checks and assertPerfLabOrgIsOurs() for the
 * checks that need further reads.
 *
 * `missingOk` is for TEARDOWN ONLY. With `--org-id` given and no row holding the
 * slug, seed and verify refuse: the operator believes an organization exists and
 * it does not. For teardown that same state is the expected aftermath of a run
 * interrupted after the organization delete, and the documented production
 * command always carries `--org-id`, so refusing there made the documented
 * command unable to finish its own job. Teardown gets null back and sweeps the
 * leftover accounts instead.
 */
export async function findPerfLabOrg(admin, expectedOrgId = null, { missingOk = false } = {}) {
  const data = await must(
    admin.from('organizations').select(ORG_COLUMNS).eq('slug', PERF_LAB_SLUG).limit(2),
    'organization lookup',
  );
  if (data.length === 0) {
    if (expectedOrgId && !missingOk) {
      refuse(
        `an organization id was given but no organization with slug "${PERF_LAB_SLUG}" exists on this target.`,
      );
    }
    return null;
  }
  if (data.length > 1)
    refuse('more than one organization matched the Perf Lab slug. Stop and investigate.');
  const org = data[0];
  assertIsPerfLabOrg(org);
  if (expectedOrgId && org.id !== expectedOrgId.toLowerCase()) {
    refuse(
      `the organization that holds slug "${PERF_LAB_SLUG}" on this target is not the one this run is pinned to.`,
    );
  }
  return org;
}

/** Does ANY organization row carry this id? `id, slug` only. Used when the slug lookup came back empty. */
export async function findOrgRowById(admin, id) {
  if (!isUuid(id)) refuse('an organization id that is not a uuid reached a lookup.');
  assertNotForbiddenOrgId(id);
  const rows = await must(
    admin.from('organizations').select('id, slug').eq('id', id).limit(1),
    'organization lookup by id',
  );
  return rows[0] ?? null;
}

/**
 * Row-level trust, from the columns already in hand (no further reads):
 *   - the id is not one of the two forbidden organizations;
 *   - the slug matches EXACTLY (`slug` is citext, so the lookup alone would
 *     accept "StockPilot-Perf-Lab");
 *   - the name is exactly the Perf Lab's. Weak by itself (typing that name is how
 *     a product-created row gets the slug) but it catches a row that was given the
 *     slug explicitly under another name;
 *   - the provenance marker is present. This is the one that settles it: only the
 *     seed and the platform console can write the column it lives in.
 * Called by findPerfLabOrg() and again by orgScope(), so no code path can hold
 * an organization-scoped handle on a row that did not pass.
 */
export function assertIsPerfLabOrg(org) {
  // A uuid, not merely a string: this id becomes an `organization_id` filter and
  // a storage prefix, and "" or "." as a prefix would address the bucket root.
  if (!org || !isUuid(org.id)) refuse('no organization row with a uuid id to check.');
  assertNotForbiddenOrgId(org.id, { seenInDatabase: true });
  if (org.slug !== PERF_LAB_SLUG) {
    refuse(`organization slug is "${org.slug}", not exactly "${PERF_LAB_SLUG}".`);
  }
  if (org.name !== PERF_LAB_NAME) {
    refuse(
      `an organization holds the slug "${PERF_LAB_SLUG}" but its name is not "${PERF_LAB_NAME}". ` +
        'These scripts did not create it and will not touch it.',
    );
  }
  if (typeof org.billing_notes !== 'string' || !org.billing_notes.includes(PERF_LAB_MARKER)) {
    refuse(
      `an organization holds the slug "${PERF_LAB_SLUG}" but does not carry the Perf Lab provenance ` +
        `marker ("${PERF_LAB_MARKER}" in its billing notes), which the seed writes in the same statement ` +
        'that creates the row. Someone created this organization through the product, or the note was ' +
        'cleared in the platform console. These scripts will not touch it. If it really is the Perf Lab, ' +
        'restore the note in the platform console (organization > billing); if it is not, it needs a ' +
        'different slug before the Perf Lab can exist.',
    );
  }
}

/** Members of the organization with their profile email. Two reads, both keyed on the Perf Lab id. */
export async function readOrgMembers(admin, org) {
  assertIsPerfLabOrg(org);
  const members = await must(
    admin
      .from('organization_members')
      .select('user_id, role, accepted_at, all_warehouses, impersonation_expires_at')
      .eq('organization_id', org.id),
    'read members',
  );
  const ids = members.map((m) => m.user_id);
  if (ids.length === 0) return [];
  const profiles = await must(
    admin.from('user_profiles').select('id, email').in('id', ids),
    'read member profiles',
  );
  const emailById = new Map(profiles.map((p) => [p.id, String(p.email).toLowerCase()]));
  // A member with no profile row gets '' and therefore counts as a stranger.
  return members.map((m) => ({ ...m, email: emailById.get(m.user_id) ?? '' }));
}

/**
 * People attached to the organization WITHOUT being members of it:
 *   - pending invitations (organization_invites with accepted_at null): somebody
 *     was invited and has not clicked yet. Seeding or deleting under them is the
 *     same mistake as doing it under a member, one click earlier;
 *   - customer-portal logins (customer_users, reached through
 *     customers.organization_id): external people who can sign in to this
 *     organization's portal and are never in organization_members at all.
 * Counts only. Both must be zero for the Perf Lab, which creates neither.
 */
export async function readOrgOutsiders(admin, org) {
  assertIsPerfLabOrg(org);
  const pendingInvites = await exactCount(
    admin
      .from('organization_invites')
      .select('id', { count: 'exact' })
      .eq('organization_id', org.id)
      .is('accepted_at', null),
    'count pending invitations',
  );
  const portalLogins = await exactCount(
    admin
      .from('customer_users')
      .select('user_id, customers!inner(organization_id)', { count: 'exact' })
      .eq('customers.organization_id', org.id),
    'count customer-portal logins',
  );
  return { pendingInvites, portalLogins };
}

/**
 * The checks that need reads, run by seed AND teardown before anything is
 * written or deleted, and in a dry run too (a dry run that says "would create"
 * about a run that would refuse is a lie).
 *
 *   1. Every member is one of the six exact Perf Lab accounts. ZERO members is
 *      allowed: that is what a seed that died between creating the organization
 *      and adding the first membership leaves behind, and the marker has already
 *      established whose row it is. Any other member is a person. The seed would
 *      otherwise pin that person's modules off, add a second owner beside them and
 *      pour 443 items into their organization; teardown would delete it.
 *   2. On production, an organization that ALREADY EXISTS must be pinned with
 *      `--org-id`. The first run finds nothing, creates it and prints the id; every
 *      later run states which organization it means. Finding one unexpectedly is
 *      exactly the moment a human should look before anything proceeds. The id is
 *      printed here on purpose, and only here: by this point the row has passed
 *      the name, marker and member checks, so it is ours by every test there is,
 *      and a first run that crashed after creating it must be resumable.
 *
 * `target` is a parameter (not read from a global) so the production branch can
 * be exercised against a local database without ever aiming at production.
 * Returns the members, which both callers need next.
 */
export async function assertPerfLabOrgIsOurs({ admin, target, org, expectedOrgId, verb }) {
  const members = await readOrgMembers(admin, org);
  const strangers = members.filter((m) => !isPerfLabAccountEmail(m.email));
  if (strangers.length > 0) {
    const roles = strangers
      .map((m) => (m.impersonation_expires_at ? `${m.role} (platform "act as" grant)` : m.role))
      .join(', ');
    refuse(
      `${strangers.length} member(s) of the organization holding the Perf Lab slug are not one of the ` +
        `six Perf Lab accounts (roles: ${roles}). Someone real is in it, or the platform console is ` +
        `acting as a member. This run will not ${verb} an organization that has real members. Find out ` +
        'who they are first.',
    );
  }
  const outsiders = await readOrgOutsiders(admin, org);
  if (outsiders.pendingInvites + outsiders.portalLogins > 0) {
    refuse(
      `the organization holding the Perf Lab slug has ${outsiders.pendingInvites} pending invitation(s) and ` +
        `${outsiders.portalLogins} customer-portal login(s). The Perf Lab creates neither, so a person did. ` +
        `This run will not ${verb} it until they are gone (Team page; Customers).`,
    );
  }
  assertPinnedOnProduction({ target, org, expectedOrgId, memberCount: members.length });
  return members;
}

/**
 * The same ownership test AGAIN, from scratch, for the moments when time has
 * passed since the first one: right after the production countdown (ten seconds
 * in which a person can join, or the slug can change hands), and in teardown
 * just before the membership rows and the organization row are deleted (minutes
 * later, after ~880 object removals). The row is re-read by slug and must still
 * be the SAME id, with the name, the marker, only Perf Lab members, no invitees
 * and no portal logins. Mid-run, a failure here exits 1 and says what was already
 * done (see refuse()).
 */
export async function reassertPerfLabOrg({ admin, target, org, expectedOrgId, verb }) {
  const fresh = await findPerfLabOrg(admin, org.id);
  if (!fresh) {
    refuse(
      `the organization holding slug "${PERF_LAB_SLUG}" is no longer there. Someone else removed it.`,
    );
  }
  await assertPerfLabOrgIsOurs({ admin, target, org: fresh, expectedOrgId, verb });
  return fresh;
}

/**
 * Rule 2 above, on its own so verify.mjs (which reports strangers as a failed
 * check instead of refusing, because a census is still worth printing) applies
 * the same pin as the two scripts that write.
 */
export function assertPinnedOnProduction({ target, org, expectedOrgId, memberCount }) {
  if (target !== 'production' || expectedOrgId) return;
  refuse(
    `the Perf Lab organization already exists on production (id ${org.id}, created ${org.created_at}, ` +
      `${memberCount} member(s)) and this run was not pinned to it. If that is the organization you ` +
      `created, run the same command again with --org-id=${org.id}. If you did not expect one to exist, ` +
      'stop and find out where it came from.',
  );
}

/**
 * Every org-scoped statement goes through here, so `organization_id = <Perf
 * Lab>` is not something each call site has to remember. Inserts are checked
 * row by row; selects, updates and deletes get the filter appended.
 *
 * In a dry run the three write methods THROW. Callers still branch on
 * `dryRun` to print what they would do; this is the backstop for the branch
 * somebody forgets.
 */
export function orgScope(admin, org, { dryRun }) {
  assertIsPerfLabOrg(org);
  const orgId = org.id;
  const noWrites = (what) => {
    if (dryRun) throw new Error(`BUG: ${what} attempted during --dry-run`);
  };
  return {
    orgId,
    dryRun,
    select(table, columns = 'id', options) {
      return admin.from(table).select(columns, options).eq('organization_id', orgId);
    },
    insert(table, rows) {
      noWrites(`insert into ${table}`);
      const list = Array.isArray(rows) ? rows : [rows];
      for (const row of list) {
        if (row.organization_id !== orgId) {
          throw new Error(`BUG: insert into ${table} without the Perf Lab organization_id`);
        }
      }
      return admin.from(table).insert(rows);
    },
    update(table, patch) {
      noWrites(`update ${table}`);
      if ('organization_id' in patch)
        throw new Error(`BUG: update of ${table} tries to move a row between organizations`);
      return admin.from(table).update(patch).eq('organization_id', orgId);
    },
    delete(table) {
      noWrites(`delete from ${table}`);
      return admin.from(table).delete().eq('organization_id', orgId);
    },
    /**
     * Exact row count for this org. `null` when the table (or its
     * organization_id column) does not exist on this target. A GET with
     * limit(1) rather than a HEAD: a failed HEAD has no body, so its error
     * carries no code and "table missing" could not be told from "broken".
     */
    async count(table, refine = (q) => q) {
      const { count, error } = await refine(
        admin
          .from(table)
          .select('organization_id', { count: 'exact' })
          .eq('organization_id', orgId),
      ).limit(1);
      if (error) {
        // PGRST205 / 42P01: no such table. 42703: no organization_id column.
        if (['PGRST205', '42P01', '42703'].includes(error.code)) return null;
        die(`count ${table}: ${error.message || error.code}`);
      }
      // No error and no usable count means the answer never arrived. Reporting
      // that as 0 is how a safety check passes without having been made.
      return usableCount(count, `count ${table}`);
    },
  };
}

/**
 * Reads every row of an ORDERED query. PostgREST caps a response at the
 * project's max_rows (1000 in config.toml; production's value was not checked,
 * by instruction), and a cap BELOW the page size would make "a short page means
 * the end" stop after the first page with a truncated read. So the cursor
 * advances by what actually arrived and the loop ends only on an empty page. One
 * extra request per read buys independence from a setting nobody can see from
 * here. Callers must order the query, or pages may overlap.
 */
export async function fetchAll(makeQuery, pageSize = 1000) {
  const rows = [];
  let previousFirst = null;
  // 1000 pages of at least one row is far beyond anything these scripts read;
  // reaching it means the loop is not advancing, and looping forever against
  // production is not an acceptable way to find that out.
  for (let page = 0; ; page++) {
    if (page >= 1000) die('paged read: gave up after 1000 pages.');
    const { data, error } = await makeQuery().range(rows.length, rows.length + pageSize - 1);
    // PGRST103: some PostgREST versions answer an offset past the last row with
    // "range not satisfiable" instead of an empty page. Same meaning: the end.
    if (error?.code === 'PGRST103') break;
    if (error) die(`paged read failed: ${error.message}`);
    // `null` is not "the end": it is an answer that never arrived (see must()).
    if (!Array.isArray(data)) die('paged read: the server answered without a rows array.');
    if (data.length === 0) break;
    // The same first row twice means the offset was ignored, and every row after
    // this would be a duplicate of one already read.
    const first = JSON.stringify(data[0]);
    if (first === previousFirst) die('paged read: the same page came back twice.');
    previousFirst = first;
    rows.push(...data);
  }
  return rows;
}

/**
 * An exact count that must succeed. GET + limit(1), not HEAD: a failed HEAD has
 * no body, so supabase-js hands back `count: null` with an error that carries
 * nothing, and `count ?? 0` then reads as "zero". Every "there are none" in these
 * scripts that guards something goes through here or through orgScope().count().
 */
export async function exactCount(query, what) {
  const { count, error } = await query.limit(1);
  if (error) die(`${what}: ${error.message || error.code || 'read failed'}`);
  return usableCount(count, what);
}

/**
 * What ties an account to anything OTHER than the Perf Lab: a membership of
 * another organization, or a B2B portal login (customer_users.user_id cascades
 * from auth.users, so deleting the account would silently delete that too).
 * `exceptOrgId` null means "any organization at all".
 */
export async function accountTiesElsewhere(admin, userId, exceptOrgId = null) {
  let memberships = admin
    .from('organization_members')
    .select('user_id', { count: 'exact' })
    .eq('user_id', userId);
  if (exceptOrgId) memberships = memberships.neq('organization_id', exceptOrgId);
  const organizations = await exactCount(memberships, 'count other memberships');
  const portals = await exactCount(
    admin.from('customer_users').select('user_id', { count: 'exact' }).eq('user_id', userId),
    'count portal logins',
  );
  return { organizations, portals, any: organizations + portals > 0 };
}

// ── Accounts (not org-scoped by nature, so scoped by the six exact emails) ──
/**
 * The Perf Lab accounts that exist on this target, found through
 * `user_profiles` by their EXACT emails. Deliberately not `auth.admin.listUsers`:
 * that pages through every user on the platform to find six, and these scripts
 * have no business reading anyone else's row.
 */
export async function findPerfLabProfiles(admin) {
  const emails = ACCOUNT_KEYS.map(perfLabEmail);
  const data = await must(
    admin
      .from('user_profiles')
      .select('id, email, full_name, default_organization_id, email_digest_optin, disabled_at')
      .in('email', emails),
    'account lookup',
  );
  const byKey = new Map();
  for (const row of data) {
    const key = ACCOUNT_KEYS.find((k) => perfLabEmail(k) === String(row.email).toLowerCase());
    if (key) byKey.set(key, row);
  }
  return byKey;
}

/**
 * The auth-side truth about one account, read NOW: its current email, whether it
 * carries the stamp the seed writes, and its MFA factors. `user_profiles.email`
 * is a projection (pinned to auth since 0345, but a projection); the identity
 * that auth.admin.deleteUser acts on is this one, so this is what is tested
 * immediately before a delete. A read that fails stops the run.
 */
export async function readAuthAccount(admin, userId) {
  if (!isUuid(userId)) die('read auth user: not a uuid.');
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data?.user) die(`read auth user: ${error?.message || 'no user returned'}`);
  const user = data.user;
  return {
    email: String(user.email ?? '').toLowerCase(),
    stamped: user.app_metadata?.perf_lab === PERF_LAB_MARKER,
    factors: (user.factors ?? []).length,
  };
}

/**
 * A 40-character password that satisfies the project's password policy
 * (config.toml: lower + upper + digit) and is then forgotten. It is never
 * returned to a caller that prints, never stored, never reused: sign-in to
 * these accounts is by an admin-minted magic link (tests/perf/auth.setup.ts),
 * so nobody ever needs to know it.
 */
export function throwawayPassword() {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digit = '23456789';
  const all = lower + upper + digit;
  const pick = (set) => set[randomBytes(1)[0] % set.length];
  const chars = [pick(lower), pick(upper), pick(digit)];
  while (chars.length < 40) chars.push(pick(all));
  // Fisher-Yates with crypto bytes so the three guaranteed classes are not
  // always the first three characters.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// ── Bounded concurrency ─────────────────────────────────────────────────────
/**
 * Runs `worker(item, index)` over `items` with at most `limit` in flight.
 * On the first failure it stops handing out new work, lets the in-flight calls
 * finish, and rethrows: a crashed run leaves a consistent prefix behind, and
 * every script here resumes from whatever is already there.
 */
export async function runPool(items, limit, worker, onProgress = () => {}) {
  let next = 0;
  let done = 0;
  let failure = null;
  async function lane() {
    while (failure === null && next < items.length) {
      const index = next++;
      try {
        await worker(items[index], index);
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
        return;
      }
      done++;
      onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, lane));
  if (failure) throw failure;
  return done;
}

/** Progress as counts only, on one line when the terminal allows it. */
export function progressPrinter(label, every = 25) {
  return (done, total) => {
    if (done === total || done % every === 0) log(`  ${label}: ${done}/${total}`);
  };
}

// ── Seeded PRNG ─────────────────────────────────────────────────────────────
// Same seed => same plan, on every machine and every day: the same catalog, the
// same quotas, the same item getting the same format, size target and cache
// group, so a "before" run and an "after" run weeks apart compare like with like.
// (The image BYTES additionally depend on the sharp build and the installed
// fonts; see images.mjs and `seed.mjs --fingerprint`.) Math.random() is never
// used for anything that shapes the dataset.
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/**
 * sfc32, seeded from a string. `createRng(seed, 'photo', 17)` gives item 17's
 * photo its OWN stream, so tuning one knob (say, the grain) never shifts every
 * later item's name, quantity and cache-control group along with it.
 */
export function createRng(...labels) {
  const seedFn = xmur3(labels.join('|'));
  let a = seedFn();
  let b = seedFn();
  let c = seedFn();
  let d = seedFn();
  const nextU32 = () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) nextU32(); // discard the correlated warm-up
  const next = () => nextU32() / 4294967296;
  const rng = {
    u32: nextU32,
    next,
    /** Integer in [min, max], inclusive. */
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    range: (min, max) => min + next() * (max - min),
    pick: (list) => list[Math.floor(next() * list.length)],
    /** Weighted pick over [[value, weight], ...]. */
    weighted(pairs) {
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      let roll = next() * total;
      for (const [value, weight] of pairs) {
        roll -= weight;
        if (roll < 0) return value;
      }
      return pairs[pairs.length - 1][0];
    },
    /** Standard normal, Box-Muller. */
    normal() {
      const u = 1 - next();
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    shuffle(list) {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    /**
     * A v4-SHAPED lowercase uuid from the stream. Deterministic on purpose: a
     * photo's object path is `<org>/items/<item>/<this>.<ext>`, so a re-run
     * after a crash writes to the SAME path (an upsert that heals) instead of
     * leaving an orphan beside a fresh copy.
     */
    uuid() {
      const hex = [];
      for (let i = 0; i < 16; i++) hex.push(nextU32() & 0xff);
      hex[6] = (hex[6] & 0x0f) | 0x40;
      hex[8] = (hex[8] & 0x3f) | 0x80;
      const s = hex.map((n) => n.toString(16).padStart(2, '0')).join('');
      return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    },
  };
  return rng;
}

// ── Small statistics + image header parsing (used by verify) ────────────────
/** Nearest-rank percentile, the same definition the 2026-09-18 census used. */
export function percentile(values, p) {
  const sorted = values.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/**
 * Encoded pixel dimensions from the first bytes of a file, without decoding
 * it. Ported from the production census (thumb-census.mjs) so the Perf Lab is
 * measured with the same ruler the customer's photos were.
 */
export function imageDims(buf) {
  return webpDims(buf) ?? jpegDims(buf) ?? pngDims(buf);
}
function webpDims(b) {
  if (
    b.length < 30 ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.toString('ascii', 8, 12) !== 'WEBP'
  )
    return null;
  const fourcc = b.toString('ascii', 12, 16);
  if (fourcc === 'VP8X')
    return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), kind: 'webp' };
  if (fourcc === 'VP8 ')
    return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, kind: 'webp' };
  if (fourcc === 'VP8L') {
    const v = b.readUInt32LE(21);
    return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff), kind: 'webp' };
  }
  return null;
}
function jpegDims(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), kind: 'jpeg' };
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
function pngDims(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), kind: 'png' };
}

// ── Storage ─────────────────────────────────────────────────────────────────
/**
 * Every object under `<orgId>/` in one bucket, by walking folders. The Storage
 * list API is one level deep; an entry with a null `id` is a folder. Returns full
 * object paths. Read-only.
 *
 * Pages until an EMPTY page, advancing by what actually arrived, for the same
 * reason fetchAll() does: "a short page means the end" is wrong the day the
 * server caps a page below the limit asked for, and the cost of being wrong here
 * is objects left behind in a bucket with nothing pointing at them.
 */
export async function listObjectsUnderOrg(admin, bucket, orgId, concurrency = 4) {
  // A uuid or nothing: '' or undefined as a prefix would list the bucket root.
  if (!isUuid(orgId)) die('list objects: the organization id is not a uuid.');
  assertNotForbiddenOrgId(orgId);
  const files = [];
  let frontier = [orgId];
  while (frontier.length > 0) {
    const nextFrontier = [];
    await runPool(frontier, concurrency, async (prefix) => {
      let offset = 0;
      for (let page = 0; ; page++) {
        if (page >= 1000) throw new Error(`list ${bucket}: gave up after 1000 pages.`);
        const { data, error } = await admin.storage
          .from(bucket)
          .list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
        if (error) throw new Error(`list ${bucket}: ${error.message}`);
        if (!Array.isArray(data))
          throw new Error(`list ${bucket}: the server answered without a list.`);
        if (data.length === 0) break;
        for (const entry of data) {
          const path = `${prefix}/${entry.name}`;
          if (entry.id === null || entry.id === undefined) nextFrontier.push(path);
          else files.push(path);
        }
        offset += data.length;
      }
    });
    frontier = nextFrontier;
  }
  return files;
}

/**
 * May this path be handed to storage.remove() for this organization? The paths
 * come from listObjectsUnderOrg(), which BUILDS them from the prefix, so
 * `startsWith(orgId + '/')` alone is true by construction and proves nothing.
 * What can actually go wrong is an entry NAME the listing returned: '..' or an
 * empty segment would let the final path resolve outside the prefix once the
 * storage client turns it into a URL.
 */
export function isRemovableOrgObjectPath(path, orgId) {
  if (!isUuid(orgId) || typeof path !== 'string') return false;
  const segments = path.split('/');
  return (
    segments.length >= 2 &&
    segments[0] === orgId &&
    segments.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..') &&
    !path.includes('//') &&
    !path.includes('..') &&
    !path.includes('%') &&
    !path.includes('\\')
  );
}

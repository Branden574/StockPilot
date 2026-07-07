#!/usr/bin/env node
// Prepare an App Store version for review submission via the App Store
// Connect API — the missing first half of `submit:review`
// (asc-submit-for-review.mjs), which requires a version already sitting in
// "Prepare for Submission" with a build attached and metadata filled.
//
// What it does, idempotently:
//   1. Waits for the given build number to finish PROCESSING in ASC
//      (EAS --auto-submit uploads the binary; Apple then processes ~5-30 min).
//   2. Creates the appStoreVersion for APP_VERSION if it doesn't exist
//      (reuses it when it's already in an editable state).
//   3. Attaches the processed build to that version.
//   4. Writes the en-US "What's New" release notes.
// Then run: pnpm submit:review
//
// Usage:
//   ASC_ISSUER_ID=... APP_VERSION=1.1.0 BUILD_NUMBER=50 \
//     RELEASE_NOTES="..." node scripts/asc-prepare-version.mjs
//
// Auth mirrors asc-submit-for-review.mjs (same key, same JWT recipe).

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSign } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));

const KEY_ID = process.env.ASC_KEY_ID || '9SA2GBH9YV';
const ISSUER_ID = process.env.ASC_ISSUER_ID || '';
const APP_ID = process.env.ASC_APP_ID || '6773892519';
const PLATFORM = process.env.ASC_PLATFORM || 'IOS';
const KEY_PATH =
  process.env.ASC_KEY_PATH || resolve(HERE, '../../../secrets/AuthKey_9SA2GBH9YV.p8');
const APP_VERSION = process.env.APP_VERSION || '';
const BUILD_NUMBER = process.env.BUILD_NUMBER || '';
const RELEASE_NOTES = process.env.RELEASE_NOTES || '';
// Apple processing rarely exceeds 30 min; poll for up to 45.
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS || 45 * 60 * 1000);

const API = 'https://api.appstoreconnect.apple.com';

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!ISSUER_ID) fail('Set ASC_ISSUER_ID.');
if (!APP_VERSION) fail('Set APP_VERSION (e.g. 1.1.0).');
if (!BUILD_NUMBER) fail('Set BUILD_NUMBER (e.g. 50).');

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a short-lived ES256 JWT (re-minted per call batch; 10 min ttl). */
function makeToken() {
  let privateKey;
  try {
    privateKey = readFileSync(KEY_PATH, 'utf8');
  } catch {
    fail(`Could not read the API key at ${KEY_PATH} (set ASC_KEY_PATH).`);
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iss: ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

async function asc(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${makeToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const detail = json?.errors?.map((e) => `${e.title}: ${e.detail}`).join('; ') || text;
    throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Version states that are still editable (safe to reuse + attach a build).
const EDITABLE = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
]);

async function main() {
  // 1. Wait for the uploaded binary to finish processing.
  console.log(`Waiting for build ${BUILD_NUMBER} (${APP_VERSION}) to process…`);
  const deadline = Date.now() + MAX_WAIT_MS;
  let buildId = null;
  for (;;) {
    const res = await asc(
      'GET',
      `/v1/builds?filter[app]=${APP_ID}&filter[version]=${BUILD_NUMBER}` +
        `&filter[preReleaseVersion.version]=${APP_VERSION}&fields[builds]=processingState,version&limit=5`,
    );
    const build = res?.data?.[0];
    const state = build?.attributes?.processingState;
    if (state === 'VALID') {
      buildId = build.id;
      console.log(`✔ Build processed (id ${buildId}).`);
      break;
    }
    if (state === 'FAILED' || state === 'INVALID') {
      fail(`Build ${BUILD_NUMBER} processing state: ${state} — check App Store Connect.`);
    }
    if (Date.now() > deadline) {
      fail(`Timed out waiting for build ${BUILD_NUMBER} (last state: ${state ?? 'not visible yet'}).`);
    }
    console.log(`  …${state ?? 'not in ASC yet (upload/ingest pending)'}; retrying in 60s`);
    await sleep(60_000);
  }

  // 2. Find-or-create the appStoreVersion.
  const versions = await asc(
    'GET',
    `/v1/apps/${APP_ID}/appStoreVersions?limit=10&fields[appStoreVersions]=versionString,appStoreState,platform`,
  );
  let version = versions?.data?.find(
    (v) =>
      v.attributes.platform === PLATFORM &&
      v.attributes.versionString === APP_VERSION &&
      EDITABLE.has(v.attributes.appStoreState),
  );
  if (version) {
    console.log(`✔ Reusing existing version ${APP_VERSION} (${version.attributes.appStoreState}).`);
  } else {
    const clash = versions?.data?.find(
      (v) => v.attributes.platform === PLATFORM && v.attributes.versionString === APP_VERSION,
    );
    if (clash) {
      fail(
        `Version ${APP_VERSION} exists in non-editable state ${clash.attributes.appStoreState}.`,
      );
    }
    const created = await asc('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform: PLATFORM, versionString: APP_VERSION },
        relationships: { app: { data: { type: 'apps', id: APP_ID } } },
      },
    });
    version = created.data;
    console.log(`✔ Created App Store version ${APP_VERSION}.`);
  }

  // 3. Attach the build.
  await asc('PATCH', `/v1/appStoreVersions/${version.id}/relationships/build`, {
    data: { type: 'builds', id: buildId },
  });
  console.log(`✔ Attached build ${BUILD_NUMBER}.`);

  // 4. Release notes (en-US). Localizations are auto-created with the version.
  if (RELEASE_NOTES) {
    const locs = await asc(
      'GET',
      `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale,whatsNew`,
    );
    const enUS = locs?.data?.find((l) => l.attributes.locale === 'en-US') || locs?.data?.[0];
    if (!enUS) fail('No version localization found to write release notes into.');
    await asc('PATCH', `/v1/appStoreVersionLocalizations/${enUS.id}`, {
      data: {
        type: 'appStoreVersionLocalizations',
        id: enUS.id,
        attributes: { whatsNew: RELEASE_NOTES },
      },
    });
    console.log(`✔ Release notes set (${enUS.attributes.locale}).`);
  }

  console.log(`\nVersion ${APP_VERSION} is prepared. Now run: pnpm submit:review\n`);
}

main().catch((e) => fail(e.message));

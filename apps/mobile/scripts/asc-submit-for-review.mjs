#!/usr/bin/env node
// Submit the latest prepared App Store version for App Store REVIEW via the
// App Store Connect API — so native builds don't need a manual "Submit for
// Review" click in App Store Connect.
//
// What it does NOT do: it does not skip Apple's review (impossible) and does not
// upload the build (EAS `--auto-submit` already does that). It performs the
// final "submit for review" step on a version that's already in
// "Prepare for Submission" (build attached, metadata filled).
//
// Auth uses the SAME App Store Connect API key EAS already uses
// (secrets/AuthKey_9SA2GBH9YV.p8, Key ID 9SA2GBH9YV). The one thing you must
// provide is the ISSUER ID (App Store Connect → Users and Access → Integrations
// → App Store Connect API → Issuer ID):
//
//   ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx pnpm submit:review
//
// Optional env overrides: ASC_KEY_ID, ASC_KEY_PATH, ASC_APP_ID, ASC_PLATFORM.

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const KEY_ID = process.env.ASC_KEY_ID || '9SA2GBH9YV';
const ISSUER_ID = process.env.ASC_ISSUER_ID || '';
const APP_ID = process.env.ASC_APP_ID || '6773892519';
const PLATFORM = process.env.ASC_PLATFORM || 'IOS';
const KEY_PATH =
  process.env.ASC_KEY_PATH || resolve(HERE, '../../../secrets/AuthKey_9SA2GBH9YV.p8');

const API = 'https://api.appstoreconnect.apple.com';

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!ISSUER_ID) {
  fail(
    'Set ASC_ISSUER_ID (App Store Connect → Users and Access → Integrations → App Store Connect API → Issuer ID).',
  );
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a short-lived ES256 JWT for the App Store Connect API. */
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
  // ieee-p1363 gives the JOSE-style R||S signature ES256 requires (not DER).
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

const TOKEN = makeToken();

async function asc(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
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

// App Store version states from which a version can be submitted for review.
const SUBMITTABLE = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
]);

async function main() {
  console.log(`› App Store Connect: app ${APP_ID}, key ${KEY_ID}`);

  // 1. Find the version to submit (latest in a submittable state).
  const versions = await asc(
    'GET',
    `/v1/apps/${APP_ID}/appStoreVersions?limit=10&fields[appStoreVersions]=versionString,appStoreState,platform`,
  );
  const candidate = (versions?.data ?? []).find((v) => {
    const a = v.attributes ?? {};
    const state = a.appStoreState || a.appVersionState; // API field rename tolerance
    return a.platform === PLATFORM && SUBMITTABLE.has(state);
  });
  if (!candidate) {
    fail(
      'No App Store version is ready to submit (need one in "Prepare for Submission" with the build attached + metadata complete). ' +
        'EAS auto-submit uploads the build; create/fill the version in App Store Connect first, then re-run.',
    );
  }
  const versionId = candidate.id;
  const versionString = candidate.attributes?.versionString;
  console.log(`› Submitting version ${versionString} (${versionId}) for review…`);

  // 2. Reuse an open reviewSubmission if one exists, else create one.
  let submissionId;
  const open = await asc(
    'GET',
    `/v1/apps/${APP_ID}/reviewSubmissions?filter[platform]=${PLATFORM}&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=1`,
  ).catch(() => null);
  if (open?.data?.length) {
    submissionId = open.data[0].id;
    console.log(`› Reusing open review submission ${submissionId}`);
  } else {
    const created = await asc('POST', '/v1/reviewSubmissions', {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: PLATFORM },
        relationships: { app: { data: { type: 'apps', id: APP_ID } } },
      },
    });
    submissionId = created.data.id;
    console.log(`› Created review submission ${submissionId}`);
  }

  // 3. Add the version as a submission item (idempotent-ish: ignore "already added").
  try {
    await asc('POST', '/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    });
    console.log('› Added the version to the submission');
  } catch (e) {
    if (!/already|exists/i.test(String(e.message))) throw e;
    console.log('› Version already in the submission');
  }

  // 4. Submit for review.
  await asc('PATCH', `/v1/reviewSubmissions/${submissionId}`, {
    data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } },
  });

  console.log(`\n✔ Submitted ${versionString} for App Store review. Apple review is ~24–48h.`);
  console.log(
    '  Tip: set the version to "Automatically release this version" in App Store Connect so it goes live on approval without another click.',
  );
}

main().catch((e) => fail(e.message));

#!/usr/bin/env node
/**
 * Backfill pre-generated thumbnails for LEGACY item_images rows
 * (storage_path set, thumb_path null) — perf plan P1.
 *
 * WHY: /dashboard/orders/new signs thumbnails in one batch call ONLY
 * for rows that have a thumb_path. Legacy rows (uploads predating
 * migration 0122) fall into an individual-transform-sign branch — 270
 * of L4L's 355 image rows — which is the multi-second sign storm seen
 * in the storage logs on every cold recompute. Backfilling thumb_path
 * moves every row onto the single-batch path.
 *
 * WHAT IT DOES per candidate row:
 *   1. Signs a short-lived 200px transform URL of the master
 *      (width/height 200, resize cover — same params the app's
 *      fallback branch uses) and downloads it as webp.
 *   2. Uploads it to the SAME directory as the master, named
 *      `<basename>-thumb.webp` (the app's existing thumb naming
 *      convention — see ItemImagesService createThumbUploadUrl).
 *   3. Sets item_images.thumb_path. lqip is left untouched.
 *
 * SAFETY / IDEMPOTENCY:
 *   - Only rows with thumb_path IS NULL are candidates; re-running
 *     skips everything already backfilled.
 *   - Uploads use upsert, so a partially-failed previous run heals.
 *   - Aborts unless the service key actually bypasses RLS.
 *   - --dry-run prints the plan without writing anything.
 *
 * ENV: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the
 * process env or apps/web/.env.local (vercel env pull first).
 *
 * Usage:
 *   node apps/web/scripts/backfill-item-thumbs.mjs --dry-run
 *   node apps/web/scripts/backfill-item-thumbs.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

const BUCKET = 'item-images';
const THUMB_SIZE = 200;
const SIGN_TTL_SEC = 600; // short-lived; only needed for the download
const CONCURRENCY = 5;
const PAGE_SIZE = 1000; // Supabase caps selects at 1000 — paginate

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function envVal(name) {
  if (process.env[name]) return process.env[name].trim();
  try {
    const env = readFileSync(resolve(__dirname, '../.env.local'), 'utf8');
    const m = env.match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\n]+)"?`, 'm'));
    if (m) return m[1].trim();
  } catch {
    /* fall through */
  }
  return null;
}

const SUPABASE_URL = envVal('NEXT_PUBLIC_SUPABASE_URL');
const SERVICE_KEY = envVal('SUPABASE_SERVICE_ROLE_KEY');
if (!SUPABASE_URL) die('NEXT_PUBLIC_SUPABASE_URL not found in env or apps/web/.env.local');
if (!SERVICE_KEY) die('SUPABASE_SERVICE_ROLE_KEY not found in env or apps/web/.env.local');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** `<same dir>/<master basename without extension>-thumb.webp` */
function thumbPathFor(storagePath) {
  const slash = storagePath.lastIndexOf('/');
  const dir = slash >= 0 ? storagePath.slice(0, slash) : '';
  const file = slash >= 0 ? storagePath.slice(slash + 1) : storagePath;
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  return `${dir ? dir + '/' : ''}${base}-thumb.webp`;
}

async function assertServiceRole() {
  const { count, error } = await supabase
    .from('organizations')
    .select('id', { count: 'exact', head: true });
  if (error) die(`service-key sanity check failed: ${error.message}`);
  if (!count) {
    die(
      'service key does not appear to bypass RLS (0 organizations visible) — wrong or anon key?',
    );
  }
}

async function fetchCandidates() {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('item_images')
      .select('id, organization_id, item_id, storage_path')
      .is('thumb_path', null)
      .not('storage_path', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) die(`candidate query failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function backfillRow(row) {
  const target = thumbPathFor(row.storage_path);
  if (row.storage_path.endsWith('-thumb.webp')) {
    return { status: 'skipped', reason: 'storage_path is already a thumb' };
  }

  if (DRY_RUN) {
    return { status: 'dry', target };
  }

  // 1. Short-lived signed transform URL of the master.
  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(row.storage_path, SIGN_TTL_SEC, {
      transform: { width: THUMB_SIZE, height: THUMB_SIZE, resize: 'cover' },
    });
  if (signErr || !signed?.signedUrl) {
    return { status: 'failed', reason: `sign: ${signErr?.message ?? 'no url'}` };
  }

  // 2. Download the transformed image (Accept: image/webp so the
  //    render endpoint emits webp).
  const res = await fetch(signed.signedUrl, { headers: { Accept: 'image/webp' } });
  if (!res.ok) {
    return { status: 'failed', reason: `download: HTTP ${res.status}` };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    return { status: 'failed', reason: 'download: empty body' };
  }
  const contentType = res.headers.get('content-type') ?? 'image/webp';

  // 3. Upload next to the master (upsert = idempotent re-runs).
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(target, buf, { contentType, upsert: true });
  if (upErr) {
    return { status: 'failed', reason: `upload: ${upErr.message}` };
  }

  // 4. Point the row at it. .select().maybeSingle() so a 0-row update
  //    (row deleted mid-run) is a visible failure, not a silent no-op.
  const { data: updated, error: updErr } = await supabase
    .from('item_images')
    .update({ thumb_path: target })
    .eq('id', row.id)
    .is('thumb_path', null)
    .select('id')
    .maybeSingle();
  if (updErr) return { status: 'failed', reason: `update: ${updErr.message}` };
  if (!updated) return { status: 'skipped', reason: 'row changed/removed mid-run' };

  return { status: 'done', target, bytes: buf.length };
}

async function main() {
  console.info(
    `Backfill item thumbnails — ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'} → ${SUPABASE_URL}`,
  );
  await assertServiceRole();

  const candidates = await fetchCandidates();
  console.info(`${candidates.length} legacy row(s) with storage_path but no thumb_path`);
  if (candidates.length === 0) {
    console.info('Nothing to do.');
    return;
  }

  const totals = { done: 0, dry: 0, skipped: 0, failed: 0 };
  let cursor = 0;
  let processed = 0;

  async function worker() {
    while (cursor < candidates.length) {
      const idx = cursor++;
      const row = candidates[idx];
      try {
        const result = await backfillRow(row);
        totals[result.status] = (totals[result.status] ?? 0) + 1;
        processed++;
        const tag =
          result.status === 'done'
            ? `ok (${result.bytes}B) → ${result.target}`
            : result.status === 'dry'
              ? `would write → ${result.target}`
              : `${result.status}: ${result.reason}`;
        console.info(`[${processed}/${candidates.length}] ${row.item_id} ${tag}`);
      } catch (err) {
        totals.failed++;
        processed++;
        console.info(
          `[${processed}/${candidates.length}] ${row.item_id} failed: ${err?.message ?? err}`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.info('\nSummary:');
  console.info(`  candidates: ${candidates.length}`);
  console.info(`  backfilled: ${totals.done}`);
  if (DRY_RUN) console.info(`  would backfill: ${totals.dry}`);
  console.info(`  skipped:    ${totals.skipped}`);
  console.info(`  failed:     ${totals.failed}`);
  if (!DRY_RUN && totals.done > 0) {
    console.info(
      '\nNote: the orders/new thumb map recomputes within 4h (or on the next',
    );
    console.info(
      "deploy/prewarm). To force it now, hit the prewarm cron route or wait.",
    );
  }
  if (totals.failed > 0) process.exit(1);
}

main().catch((err) => die(err?.message ?? String(err)));

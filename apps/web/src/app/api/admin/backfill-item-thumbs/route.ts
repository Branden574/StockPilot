import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Each row = sign + download + upload + update; a 60-row batch at
// concurrency 5 can legitimately take minutes on large masters.
export const maxDuration = 300;

/**
 * Server-side port of scripts/backfill-item-thumbs.mjs (perf plan P1).
 *
 * Exists because SUPABASE_SERVICE_ROLE_KEY is marked Sensitive in
 * Vercel (unpullable), so the local script can't run against prod
 * without the key. This route does the same work behind
 * BACKFILL_ADMIN_SECRET, in bounded batches — invoke repeatedly until
 * `remaining` hits 0:
 *
 *   curl -X POST -H "Authorization: Bearer $BACKFILL_ADMIN_SECRET" \
 *     "https://<host>/api/admin/backfill-item-thumbs?limit=40"
 *
 * Per candidate row (storage_path set, thumb_path null):
 *   1. sign a short-lived 200px cover-transform URL of the master,
 *   2. download the webp bytes,
 *   3. upload `<same dir>/<basename>-thumb.webp` (upsert),
 *   4. set thumb_path, guarded `.is('thumb_path', null)` so re-runs
 *      and concurrent invocations stay idempotent.
 * Per-row failures are reported in the response, never thrown.
 */

const BUCKET = 'item-images';
const THUMB_SIZE = 200;
const SIGN_TTL_SEC = 600; // only needed long enough to download
const CONCURRENCY = 5;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 60;

/**
 * Constant-time string compare (same as cron/drain-outbox — a naive
 * `a !== b` leaks the matching-prefix length through timing).
 */
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** `<same dir>/<master basename without extension>-thumb.webp` */
function thumbPathFor(storagePath: string): string {
  const slash = storagePath.lastIndexOf('/');
  const dir = slash >= 0 ? storagePath.slice(0, slash) : '';
  const file = slash >= 0 ? storagePath.slice(slash + 1) : storagePath;
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  return `${dir ? dir + '/' : ''}${base}-thumb.webp`;
}

interface CandidateRow {
  id: string;
  item_id: string;
  storage_path: string;
}

interface RowFailure {
  path: string;
  error: string;
}

async function backfillRow(
  supabase: ReturnType<typeof createAdminClient>,
  row: CandidateRow,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = thumbPathFor(row.storage_path);
  if (row.storage_path.endsWith('-thumb.webp')) {
    return { ok: false, error: 'storage_path is already a thumb' };
  }

  // 1. Short-lived signed transform URL of the master.
  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(row.storage_path, SIGN_TTL_SEC, {
      transform: { width: THUMB_SIZE, height: THUMB_SIZE, resize: 'cover' },
    });
  if (signErr || !signed?.signedUrl) {
    return { ok: false, error: `sign: ${signErr?.message ?? 'no url'}` };
  }

  // 2. Download the transformed image (Accept: image/webp so the
  //    render endpoint emits webp).
  const res = await fetch(signed.signedUrl, { headers: { Accept: 'image/webp' } });
  if (!res.ok) {
    return { ok: false, error: `download: HTTP ${res.status}` };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    return { ok: false, error: 'download: empty body' };
  }
  const contentType = res.headers.get('content-type') ?? 'image/webp';

  // 3. Upload next to the master (upsert = idempotent re-runs).
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(target, buf, { contentType, upsert: true });
  if (upErr) {
    return { ok: false, error: `upload: ${upErr.message}` };
  }

  // 4. Point the row at it. Guarded + .select().maybeSingle() so a
  //    0-row update (row deleted / already backfilled concurrently)
  //    is visible instead of a silent no-op.
  const { data: updated, error: updErr } = await supabase
    .from('item_images')
    .update({ thumb_path: target })
    .eq('id', row.id)
    .is('thumb_path', null)
    .select('id')
    .maybeSingle();
  if (updErr) return { ok: false, error: `update: ${updErr.message}` };
  if (!updated) return { ok: false, error: 'row changed/removed mid-run' };

  return { ok: true };
}

export async function POST(req: Request) {
  // Fail-closed when the secret is unset/empty so an unauthenticated
  // POST can't drive service-role storage writes.
  if (!env.BACKFILL_ADMIN_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.BACKFILL_ADMIN_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)))
    : DEFAULT_LIMIT;

  try {
    const supabase = createAdminClient();

    const { data: candidates, error } = await supabase
      .from('item_images')
      .select('id, item_id, storage_path')
      .is('thumb_path', null)
      .not('storage_path', 'is', null)
      .order('id', { ascending: true })
      .limit(limit);
    if (error) {
      return NextResponse.json(
        { error: `candidate query failed: ${error.message}` },
        { status: 500 },
      );
    }

    const rows = (candidates ?? []) as CandidateRow[];
    const failed: RowFailure[] = [];
    let succeeded = 0;

    // Bounded worker pool — per-row failures are recorded, never thrown.
    let cursor = 0;
    async function worker() {
      while (cursor < rows.length) {
        const row = rows[cursor++]!;
        try {
          const result = await backfillRow(supabase, row);
          if (result.ok) succeeded += 1;
          else failed.push({ path: row.storage_path, error: result.error });
        } catch (err) {
          failed.push({
            path: row.storage_path,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker()),
    );

    // How many legacy rows are still left after this batch.
    const { count: remaining } = await supabase
      .from('item_images')
      .select('id', { count: 'exact', head: true })
      .is('thumb_path', null)
      .not('storage_path', 'is', null);

    return NextResponse.json({
      processed: rows.length,
      succeeded,
      failed,
      remaining: remaining ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'backfill failed' },
      { status: 500 },
    );
  }
}

import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { isSniffedKindAllowedInBucket, sniffImage } from '@/lib/image-signature';
import { makeItemPhotoThumbnail } from '@/lib/item-photo-thumbnail';
import { isValidStoragePath, itemImageAnyPathShape } from '@/lib/storage-path';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Each row = up to two reads, one thumbnail, one upload and one update; a
// 60-row batch at concurrency 5 can take a while on large photos.
export const maxDuration = 300;

/**
 * Thumbnails for item photos stored without one (item_images.thumb_path
 * null), so lists stop signing the full-size photo for them (docket B31).
 * It runs on the server because SUPABASE_SERVICE_ROLE_KEY is marked Sensitive
 * in Vercel (unpullable), so no local script can run this against
 * production; the one it was ported from (scripts/backfill-item-thumbs.mjs)
 * was retired in B31. This route does the work behind BACKFILL_ADMIN_SECRET,
 * in bounded batches.
 *
 * POST, Authorization: Bearer $BACKFILL_ADMIN_SECRET, and one of:
 *
 *   ?ids=<id>,<id>,...  exactly these item_images rows (at most 60), each
 *                       only while its thumb_path is still null. The way the
 *                       reviewed backfill plan runs it: the ids come from its
 *                       read-only report, so no other row is touched.
 *   ?limit=N            the first N rows by id that have a photo and no
 *                       thumbnail, in every organization (1-60, default 40).
 *
 * Add `dryRun=1` to either: every check runs and each row's outcome is
 * reported as `would-create` / `would-link`, and nothing is written.
 *
 * GET, with the same secret, writes nothing and says what this build accepts:
 * a caller asks it first, because the build before B31 ignored `ids` and
 * `dryRun` and wrote on every call.
 *
 * Per row:
 *   1. The thumbnail's name is the web uploader's: the photo's folder, its
 *      name without the extension, then `-thumb.webp`.
 *   2. An object ALREADY at that name (a thumbnail that was stored but whose
 *      row was never pointed at it) is LINKED, never replaced, and only if
 *      its bytes are an image the bucket accepts.
 *   3. Otherwise the photo is downloaded, must be an image the bucket
 *      accepts, and the thumbnail is made from it here
 *      (lib/item-photo-thumbnail.ts: the web uploader's 200 px WEBP, aspect
 *      kept). It is uploaded at that name without overwriting anything.
 *   4. The row is pointed at it, guarded `.is('thumb_path', null)` and with
 *      row proof, so a re-run or a concurrent call changes nothing twice and
 *      a row changed meanwhile is reported, not overwritten.
 * Per-row outcomes are reported (with the path written, for the plan's
 * reversal), never thrown. A thumbnail uploaded for a row that then changed
 * is left in place: it is harmless, and another row may name it by then.
 */

const BUCKET = 'item-images';
const CONCURRENCY = 5;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  storage_path: string | null;
  thumb_path: string | null;
}

type RowResult =
  | { id: string; outcome: 'created' | 'linked' | 'would-create' | 'would-link'; thumbPath: string }
  | { id: string; outcome: 'skipped'; reason: string }
  | { id: string; outcome: 'failed'; error: string };

type AdminClient = ReturnType<typeof createAdminClient>;
type AdminBucket = ReturnType<AdminClient['storage']['from']>;

/** The whole object, or null when it cannot be read. */
async function download(store: AdminBucket, path: string): Promise<Uint8Array | null> {
  try {
    const { data, error } = await store.download(path);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Is there an object at `path`? null when storage could not say. storage-js
 * answers `{ data: false }` for a 400 or 404 (no object) and THROWS for
 * anything else. A wrong "no" is still safe: the upload below never
 * overwrites, so it is refused instead.
 */
async function objectExists(store: AdminBucket, path: string): Promise<boolean | null> {
  try {
    const { data } = await store.exists(path);
    return data === true;
  } catch {
    return null;
  }
}

/** The bytes are an image the item-images bucket accepts (magic bytes, not a name or a header). */
function isAcceptedImage(bytes: Uint8Array): boolean {
  const sniffed = sniffImage(bytes);
  return !!sniffed && isSniffedKindAllowedInBucket(sniffed.kind, 'item-images');
}

async function pointRowAt(
  admin: AdminClient,
  id: string,
  thumbPath: string,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const { data, error } = await admin
    .from('item_images')
    .update({ thumb_path: thumbPath })
    .eq('id', id)
    .is('thumb_path', null)
    .select('id')
    .maybeSingle();
  if (error) return { ok: false, why: `update: ${error.message}` };
  if (!data) return { ok: false, why: 'the row changed or was removed meanwhile' };
  return { ok: true };
}

async function backfillRow(
  admin: AdminClient,
  row: CandidateRow,
  dryRun: boolean,
): Promise<RowResult> {
  const id = row.id;
  if (row.thumb_path) return { id, outcome: 'skipped', reason: 'already has a thumbnail' };
  const master = row.storage_path;
  if (!master) return { id, outcome: 'skipped', reason: 'no photo path' };
  // The service role can read the whole bucket, so a path that is not an item
  // photo's shape is never handed to storage (HI-8; item-images.ts signs only
  // these shapes too).
  if (!isValidStoragePath(master, itemImageAnyPathShape())) {
    return { id, outcome: 'failed', error: 'the photo path is not an item photo path' };
  }
  if (/-thumb\.[A-Za-z0-9]+$/.test(master)) {
    return { id, outcome: 'skipped', reason: 'the photo path is itself a thumbnail' };
  }
  const target = thumbPathFor(master);
  // The derived name must be an item photo path too: the web signs only those
  // (item-images.ts isSignableItemImagePath), so a row pointed at any other
  // name shows no photo at all. A photo named with two dots (`a.v2.jpg`)
  // derives `a.v2-thumb.webp`, which is not one.
  if (!isValidStoragePath(target, itemImageAnyPathShape())) {
    return { id, outcome: 'failed', error: 'the thumbnail name would not be an item photo path' };
  }
  const store = admin.storage.from(BUCKET);

  // 2. A thumbnail already stored at the name: link it, never replace it.
  const present = await objectExists(store, target);
  if (present === null)
    return { id, outcome: 'failed', error: 'could not tell whether a thumbnail exists' };
  if (present) {
    const existing = await download(store, target);
    if (!existing)
      return { id, outcome: 'failed', error: 'the existing thumbnail could not be read' };
    if (!isAcceptedImage(existing)) {
      return {
        id,
        outcome: 'failed',
        error: 'an object that is not an accepted image sits at the thumbnail name',
      };
    }
    if (dryRun) return { id, outcome: 'would-link', thumbPath: target };
    const linked = await pointRowAt(admin, id, target);
    return linked.ok
      ? { id, outcome: 'linked', thumbPath: target }
      : { id, outcome: 'failed', error: linked.why };
  }

  // 3. Make it from the photo.
  const photo = await download(store, master);
  if (!photo) return { id, outcome: 'failed', error: 'the photo could not be read' };
  if (!isAcceptedImage(photo))
    return { id, outcome: 'failed', error: 'the photo is not an accepted image' };
  const thumb = await makeItemPhotoThumbnail(photo);
  if (!thumb) return { id, outcome: 'failed', error: 'the photo could not be decoded' };
  if (dryRun) return { id, outcome: 'would-create', thumbPath: target };
  // Never over an existing object (upsert false): one stored since the check
  // above is refused here, and the next run links it instead.
  const { error: upErr } = await store.upload(target, thumb, {
    contentType: 'image/webp',
    upsert: false,
  });
  if (upErr) return { id, outcome: 'failed', error: `upload: ${upErr.message}` };

  // 4. Point the row at it.
  const pointed = await pointRowAt(admin, id, target);
  return pointed.ok
    ? { id, outcome: 'created', thumbPath: target }
    : { id, outcome: 'failed', error: pointed.why };
}

/** `ids` from the query: null when absent, an error string when malformed. */
function parseIds(raw: string | null): string[] | null | string {
  if (raw === null) return null;
  const ids = [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0) return 'ids is empty';
  if (ids.length > MAX_LIMIT) return `at most ${MAX_LIMIT} ids per call`;
  if (!ids.every((v) => UUID.test(v))) return 'every id must be a uuid';
  return ids;
}

/** The bearer secret, compared in constant time. Fail-closed when it is unset
 *  or empty, so an unauthenticated call can't drive service-role storage writes. */
function authorized(req: Request): boolean {
  if (!env.BACKFILL_ADMIN_SECRET) return false;
  const auth = req.headers.get('authorization') ?? '';
  return secretsEqual(auth, `Bearer ${env.BACKFILL_ADMIN_SECRET}`);
}

/**
 * What this build of the route accepts, for the reviewed plan's caller to ask
 * BEFORE its first POST. The build before B31 has no GET (405) and ignores
 * `ids` and `dryRun`, so any authorized POST to it writes square-cropped
 * thumbnails over up to 40 rows of any organization; the caller stops unless
 * this answers. Reads and writes nothing.
 */
export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json({
    backfill: 'item-thumbs',
    version: 2,
    accepts: ['ids', 'limit', 'dryRun'],
    maxIds: MAX_LIMIT,
  });
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dryRun') === '1';
  const ids = parseIds(url.searchParams.get('ids'));
  if (typeof ids === 'string') {
    return NextResponse.json({ error: ids }, { status: 400 });
  }
  const rawLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)))
    : DEFAULT_LIMIT;

  try {
    const admin = createAdminClient();

    let rows: CandidateRow[];
    const results: RowResult[] = [];
    if (ids) {
      const { data, error } = await admin
        .from('item_images')
        .select('id, storage_path, thumb_path')
        // in-list-bound: at most MAX_LIMIT (60) ids; parseIds refuses more.
        .in('id', ids);
      if (error) {
        return NextResponse.json({ error: `row read failed: ${error.message}` }, { status: 500 });
      }
      rows = (data ?? []) as CandidateRow[];
      // Every id asked for is answered: one that matches no row says so.
      const found = new Set(rows.map((r) => r.id));
      for (const id of ids) {
        if (!found.has(id)) results.push({ id, outcome: 'skipped', reason: 'no such row' });
      }
    } else {
      const { data, error } = await admin
        .from('item_images')
        .select('id, storage_path, thumb_path')
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
      rows = (data ?? []) as CandidateRow[];
    }

    // Bounded worker pool — per-row failures are recorded, never thrown.
    let cursor = 0;
    async function worker() {
      while (cursor < rows.length) {
        const row = rows[cursor++]!;
        try {
          results.push(await backfillRow(admin, row, dryRun));
        } catch (err) {
          results.push({
            id: row.id,
            outcome: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker()));

    // How many rows, in every organization, still have a photo and no thumbnail.
    const { count: remaining } = await admin
      .from('item_images')
      .select('id', { count: 'exact', head: true })
      .is('thumb_path', null)
      .not('storage_path', 'is', null);

    const tally = (o: RowResult['outcome']) => results.filter((r) => r.outcome === o).length;
    return NextResponse.json({
      dryRun,
      processed: rows.length,
      created: tally('created'),
      linked: tally('linked'),
      wouldCreate: tally('would-create'),
      wouldLink: tally('would-link'),
      skipped: tally('skipped'),
      failed: tally('failed'),
      results,
      remaining: remaining ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'backfill failed' },
      { status: 500 },
    );
  }
}

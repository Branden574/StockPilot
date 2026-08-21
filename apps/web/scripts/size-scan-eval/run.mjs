#!/usr/bin/env node
/* eslint-disable no-console -- an evaluation report; console output IS the deliverable */
/**
 * Size-sticker scan evaluation — see README.md in this directory.
 *
 * Deliberately a plain script and not a vitest file. It costs real money, takes
 * minutes, and needs prod credentials, so it must never run in CI alongside the
 * unit tests. What it measures is not a property of our code — it is a property
 * of the model reading real photographs, and that has to be re-measured rather
 * than asserted.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const sharp = require_('sharp');
const HERE = import.meta.dirname;
const OUT = path.join(HERE, '.out');

// ── configuration ──────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const STAGE = args.stage ?? 'all';
const MODEL = args.model ?? 'claude-sonnet-4-5-20250929';
const LIMIT = Number(args.limit ?? 0);
const CONCURRENCY = Number(args.concurrency ?? 6);

/**
 * Env from the process, falling back to the files outside the repo.
 *
 * The fallback is a convenience for running this on the machine that holds
 * them; the process env is the real interface, so this works in any checkout
 * without the paths below existing.
 */
function readEnv(keys) {
  const found = {};
  for (const k of keys) if (process.env[k]) found[k] = process.env[k];
  const missing = keys.filter((k) => !found[k]);
  if (missing.length === 0) return found;
  for (const file of ['.env.local.prod', '.env.local']) {
    const p = path.join(process.env.HOME ?? '', 'Developer/stockpilot-env/apps/web', file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.includes('=') || line.trim().startsWith('#')) continue;
      const k = line.slice(0, line.indexOf('=')).trim();
      if (found[k] || !keys.includes(k)) continue;
      found[k] = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  const still = keys.filter((k) => !found[k]);
  if (still.length) {
    console.error(`Missing required env: ${still.join(', ')}`);
    process.exit(1);
  }
  return found;
}

/** The prompt and schema are read OUT OF THE SHIPPED MODULE, never copied.
 *  A harness measuring its own copy of the prompt measures nothing. */
async function loadShipped() {
  const src = fs.readFileSync(path.join(HERE, '../../src/lib/ai/size-scan.ts'), 'utf8');
  const m = src.match(/export const SIZE_SCAN_PROMPT = `([\s\S]*?)`;\n/);
  if (!m) throw new Error('SIZE_SCAN_PROMPT not found — did the module move?');
  const prompt = m[1].replace(/\\`/g, '`').replace(/\\\$/g, '$');
  const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL'];
  const CARRIERS = ['round_dot', 'printed_tag_or_label', 'other'];
  const schema = {
    type: 'object',
    properties: {
      stickers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            carrier: { type: 'string', enum: CARRIERS },
            rawText: { type: 'string' },
            xCount: { type: 'integer' },
            size: { type: 'string', enum: SIZES },
            confidence: { type: 'number' },
          },
          required: ['carrier', 'rawText', 'xCount', 'size', 'confidence'],
        },
      },
      noStickerVisible: { type: 'boolean' },
      notes: { type: 'string' },
    },
    required: ['stickers', 'noStickerVisible', 'notes'],
  };
  return { prompt, schema, SIZES };
}

// ── stage 1: build the evaluation set ──────────────────────────────────────

/** Frames closer together than this, with the same label, are the same
 *  physical sticker. See the README — this is the whole method. */
const BURST_GAP_MS = 3000;

async function buildBursts() {
  const env = readEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(
      `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/size_count_training_samples` +
        `?select=id,size_label,image_storage_path,created_at&order=created_at.asc`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          range: `${from}-${from + 999}`,
        },
      },
    );
    const page = await r.json();
    if (!Array.isArray(page)) throw new Error(`PostgREST: ${JSON.stringify(page).slice(0, 200)}`);
    rows.push(...page);
    if (page.length < 1000) break;
  }

  const bursts = [];
  let cur = null;
  for (const row of rows) {
    const t = Date.parse(row.created_at);
    if (cur && row.size_label === cur.label && t - cur.lastT < BURST_GAP_MS) {
      cur.items.push(row);
      cur.lastT = t;
    } else {
      cur = { label: row.size_label, items: [row], lastT: t };
      bursts.push(cur);
    }
  }
  // The MIDDLE frame: the first is still being aimed, the last is already
  // moving away, and both are systematically worse than a real scan would be.
  const sample = bursts.map((b, i) => ({
    burst: i + 1,
    label: b.label,
    frames: b.items.length,
    path: b.items[Math.floor(b.items.length / 2)].image_storage_path,
  }));

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'bursts.json'), JSON.stringify(sample, null, 2));
  const byLabel = {};
  for (const s of sample) byLabel[s.label] = (byLabel[s.label] ?? 0) + 1;
  console.log(`${rows.length} frames -> ${sample.length} distinct stickers`);
  console.log(`  ${JSON.stringify(byLabel)}`);
  const zero = ['XXXXL', 'XXXXXL'].filter((s) => !byLabel[s]);
  if (zero.length) console.log(`  NOT COVERED AT ALL: ${zero.join(', ')} — no score below applies to them`);
  return sample;
}

// ── stage 2: fetch the images at the size the phone actually sends ─────────

/** apps/mobile/src/lib/image-resize.ts uses maxEdge 1600 / quality 0.85.
 *  Evaluating on anything sharper measures an image the product never sends. */
const MAX_EDGE = 1600;
const QUALITY = 85;

async function fetchImages(sample) {
  const env = readEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const dir = path.join(OUT, 'images');
  fs.mkdirSync(dir, { recursive: true });
  const queue = [...sample];
  let done = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const dest = path.join(dir, `${item.burst}.jpg`);
        if (fs.existsSync(dest)) {
          done += 1;
          continue;
        }
        try {
          const r = await fetch(
            `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/size-count-training/${item.path}`,
            {
              headers: {
                apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              },
            },
          );
          if (!r.ok) {
            failed += 1;
            continue;
          }
          await sharp(Buffer.from(await r.arrayBuffer()))
            .rotate()
            .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: QUALITY })
            .toFile(dest);
          done += 1;
          if (done % 50 === 0) console.log(`  ${done}/${sample.length}`);
        } catch {
          failed += 1;
        }
      }
    }),
  );
  console.log(`images: ${done} ready, ${failed} failed`);
}

// ── stage 3: run the model and score ──────────────────────────────────────

async function callClaude({ prompt, schema }, b64, apiKey) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      // sonnet-5 and newer REJECT `temperature` outright (see the note on
      // ANTHROPIC_PO_SCAN_MODEL in lib/env.ts). Sending it turns the whole
      // run into 400s, which looks like a model that cannot read stickers.
      ...(/sonnet-5|opus-5|haiku-5/.test(MODEL) ? {} : { temperature: 0 }),
      tools: [{ name: 'report_stickers', description: 'Report the size stickers read from the photo.', input_schema: schema }],
      tool_choice: { type: 'tool', name: 'report_stickers' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 300));
  const use = j.content.find((c) => c.type === 'tool_use');
  if (!use) throw new Error('no tool_use in response');
  return use.input;
}

/** The single answer to score: the size most dots agree on, ties by confidence.
 *  Only round dots count — a reading on a neck tag is not a sticker, which is
 *  the same rule `parseSizeScanResponse` applies in production. */
function primaryOf(res, minConf, SIZES) {
  // OBSERVED IN THE WILD: sonnet-5 returned `stickers` as a JSON-encoded
  // STRING once in 260 calls, through a forced tool schema. Mirror what
  // parseSizeScanResponse does in production rather than assuming the shape.
  const raw = typeof res.stickers === 'string' ? tryParseArray(res.stickers) : res.stickers;
  const good = (Array.isArray(raw) ? raw : []).filter(
    (s) =>
      SIZES.includes(s.size) &&
      (s.confidence ?? 0) >= minConf &&
      (s.carrier === undefined || s.carrier === 'round_dot'),
  );
  if (good.length === 0) return 'NONE';
  const tally = new Map();
  for (const s of good) {
    const cur = tally.get(s.size) ?? { n: 0, conf: 0 };
    tally.set(s.size, { n: cur.n + 1, conf: Math.max(cur.conf, s.confidence) });
  }
  return [...tally.entries()].sort((a, b) => b[1].n - a[1].n || b[1].conf - a[1].conf)[0][0];
}

async function scoreRun(sample, shipped) {
  const { ANTHROPIC_API_KEY } = readEnv(['ANTHROPIC_API_KEY']);
  const dir = path.join(OUT, 'images');
  const work = LIMIT ? sample.slice(0, LIMIT) : sample;
  const queue = [...work];
  const results = [];
  let done = 0;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const b64 = fs.readFileSync(path.join(dir, `${item.burst}.jpg`)).toString('base64');
        let res = null;
        let err = null;
        for (let attempt = 0; attempt < 4 && !res; attempt += 1) {
          try {
            res = await callClaude(shipped, b64, ANTHROPIC_API_KEY);
          } catch (e) {
            err = e.message;
            // Transient NETWORK failures retry too. Without this a dropped
            // connection ends that burst's attempts immediately and quietly
            // shrinks the sample the score is computed from.
            if (/429|rate|overload|529|fetch failed|ECONN|ETIMEDOUT|socket/i.test(err)) {
              await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
            } else break;
          }
        }
        results.push({ ...item, res, err });
        done += 1;
        if (done % 25 === 0) console.log(`  ${done}/${work.length}`);
      }
    }),
  );

  fs.writeFileSync(path.join(OUT, `run-${MODEL}.json`), JSON.stringify({ MODEL, results }, null, 2));
  report(results, shipped.SIZES);
}

function tryParseArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [v];
  } catch {
    return [];
  }
}

function report(results, SIZES) {
  const failed = results.filter((r) => !r.res);
  // ANNOUNCED, NOT SWALLOWED. A run where a third of the calls errored produces
  // a percentage that looks like a measurement and is not one — the surviving
  // subset is whatever ran before the credit ran out, which is not a sample.
  if (failed.length) {
    console.log(`\n!! ${failed.length}/${results.length} CALLS FAILED — the score below is NOT a measurement`);
    console.log(`   first error: ${failed[0].err?.slice(0, 160)}`);
  }

  const scored = results.filter((r) => r.res);
  console.log(`\n=== ${MODEL} — ${scored.length} bursts ===\n`);
  console.log('thresh  overall  positives  no-sticker-recall  FALSE-SIZE  MISSED  WRONG-SIZE');
  for (const t of [0, 0.5, 0.7, 0.9, 0.95]) {
    let ok = 0, posOk = 0, posN = 0, noneOk = 0, noneN = 0, falseSize = 0, missed = 0, wrong = 0;
    for (const r of scored) {
      const p = primaryOf(r.res, t, SIZES);
      if (r.label === 'NONE') {
        noneN += 1;
        if (p === 'NONE') { noneOk += 1; ok += 1; } else falseSize += 1;
      } else {
        posN += 1;
        if (p === r.label) { posOk += 1; ok += 1; }
        else if (p === 'NONE') missed += 1;
        else wrong += 1;
      }
    }
    console.log(
      `${t.toFixed(2).padStart(5)}  ${((100 * ok) / scored.length).toFixed(1).padStart(6)}%  ` +
        `${((100 * posOk) / posN).toFixed(1).padStart(8)}%  ${((100 * noneOk) / noneN).toFixed(1).padStart(16)}%  ` +
        `${String(falseSize).padStart(10)}  ${String(missed).padStart(6)}  ${String(wrong).padStart(10)}`,
    );
  }

  const T = 0.7;
  const conf = {};
  for (const r of scored) {
    const p = primaryOf(r.res, T, SIZES);
    conf[r.label] ??= {};
    conf[r.label][p] = (conf[r.label][p] ?? 0) + 1;
  }
  const cols = [...SIZES, 'NONE'];
  console.log(`\n--- confusion at confidence >= ${T} (row = truth) ---`);
  console.log('truth'.padEnd(8) + cols.map((c) => c.padStart(7)).join(''));
  for (const label of cols) {
    if (!conf[label]) continue;
    console.log(label.padEnd(8) + cols.map((c) => String(conf[label][c] ?? '').padStart(7)).join(''));
  }

  console.log('\n--- every error, with what the model said it saw ---');
  for (const r of scored) {
    const p = primaryOf(r.res, T, SIZES);
    if (p === r.label) continue;
    const raw = (r.res.stickers ?? []).map((s) => `${s.carrier}:${s.rawText}->${s.size}@${s.confidence}`).join(' ');
    console.log(`  burst ${String(r.burst).padStart(3)}  truth=${r.label.padEnd(6)} said=${p.padEnd(6)} :: ${raw.slice(0, 120)}`);
  }
}

// ── main ───────────────────────────────────────────────────────────────────

const shipped = await loadShipped();
let sample;
if (STAGE === 'bursts' || STAGE === 'all') sample = await buildBursts();
else sample = JSON.parse(fs.readFileSync(path.join(OUT, 'bursts.json'), 'utf8'));

if (STAGE === 'images' || STAGE === 'all') await fetchImages(sample);
if (STAGE === 'score' || STAGE === 'all') await scoreRun(sample, shipped);

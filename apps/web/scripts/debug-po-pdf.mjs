#!/usr/bin/env node
/* eslint-disable no-console -- developer debug script; console output is the point */
// Pulls the most recent PO import PDF from Storage and prints what pdf-parse
// extracts. Used for debugging parser regressions on real-world POs.
//
// Run from apps/web: `node scripts/debug-po-pdf.mjs`

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env.local');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sb = createClient(url, key);
const { data: rows, error } = await sb
  .from('po_imports')
  .select('id, file_name, storage_path, status, parse_error')
  .order('created_at', { ascending: false })
  .limit(1);
if (error) {
  console.error('Query failed:', error);
  process.exit(1);
}
const row = rows?.[0];
if (!row) {
  console.error('No po_imports rows found');
  process.exit(1);
}
console.log('Most recent import:', row);

const { data: blob, error: dlErr } = await sb.storage
  .from('po-imports')
  .download(row.storage_path);
if (dlErr || !blob) {
  console.error('Download failed:', dlErr);
  process.exit(1);
}
const buf = Buffer.from(await blob.arrayBuffer());
const { default: pdfParse } = await import('pdf-parse');
const { text } = await pdfParse(buf);

console.log('\n--- RAW EXTRACTED TEXT ---');
console.log(text);
console.log('--- END ---\n');
console.log('Lines (', text.split(/\r?\n/).length, 'total):');
text.split(/\r?\n/).forEach((line, i) => {
  console.log(String(i + 1).padStart(3), JSON.stringify(line));
});

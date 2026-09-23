// Latency-injecting relay in front of the LOCAL Supabase API (lab only).
//
// Models the production Vercel(iad1) -> Supabase call cost measured from
// edge_logs 2026-09-22 13:00-21:00Z, server (UA node) calls entering IAD,
// response.origin_time: p50 36, p75 58, p90 137, p99 1675 ms.
//
// MODE=fixed  -> every HTTP request waits DELAY_MS before it is forwarded.
// MODE=empirical -> waits a value drawn from the measured quantiles
//                   (piecewise-linear between them; seeded, so runs repeat).
// MODE=off    -> no delay.
// The mode can be changed while running: write "fixed:35" / "empirical" / "off"
// to the CONTROL file; it is re-read every second.
//
// WebSocket upgrades (realtime) are piped through undelayed after the same wait.
// Nothing is logged except per-minute counts; no headers, URLs or bodies.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

const LISTEN = Number(process.env.LISTEN_PORT ?? 54400);
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = Number(process.env.TARGET_PORT ?? 54321);
const CONTROL = process.env.CONTROL ?? new URL('./.latency-mode', import.meta.url).pathname;

let mode = { kind: 'off', ms: 0 };
function readControl() {
  try {
    const raw = fs.readFileSync(CONTROL, 'utf8').trim();
    if (raw === 'off') mode = { kind: 'off', ms: 0 };
    else if (raw === 'empirical') mode = { kind: 'empirical', ms: 0 };
    else if (raw.startsWith('fixed:')) mode = { kind: 'fixed', ms: Number(raw.slice(6)) || 0 };
  } catch {
    /* keep the last mode */
  }
}
readControl();
setInterval(readControl, 1000).unref();

// Measured quantiles (ms) of origin_time, minus ~3 ms the local stack already spends.
const Q = [
  [0.0, 5],
  [0.5, 33],
  [0.75, 55],
  [0.9, 134],
  [0.95, 386],
  [0.99, 1672],
  [1.0, 3000],
];
let seed = 0x2f6e2b1;
function rand() {
  // mulberry32
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function empirical() {
  const u = rand();
  for (let i = 1; i < Q.length; i++) {
    const [q0, v0] = Q[i - 1];
    const [q1, v1] = Q[i];
    if (u <= q1) return v0 + ((u - q0) / (q1 - q0)) * (v1 - v0);
  }
  return Q[Q.length - 1][1];
}
function delay() {
  if (mode.kind === 'fixed') return mode.ms;
  if (mode.kind === 'empirical') return empirical();
  return 0;
}

let count = 0;
// TRACE: one line per HTTP request: start (epoch ms), injected wait, total ms,
// method, path WITHOUT the query string (ids/filters/tokens stay out), status,
// and who asked (server = UA node, browser otherwise). Written only when the
// TRACE_FILE env is set.
const TRACE_FILE = process.env.TRACE_FILE || null;
const trace = TRACE_FILE ? fs.createWriteStream(TRACE_FILE, { flags: 'a' }) : null;
const pathOnly = (url) => {
  const p = (url || '').split('?')[0];
  // Storage object paths carry org/item ids and file names: keep the prefix only.
  return p.startsWith('/storage/v1/object/') ? p.split('/').slice(0, 6).join('/') : p;
};
const server = http.createServer((req, res) => {
  // Lab marker: GET /__mark/<label> writes a MARK line to the trace and
  // answers 204 without touching Supabase (the trace script brackets each
  // navigation with two of these).
  if (req.url && req.url.startsWith('/__mark/')) {
    if (trace) trace.write(`${Date.now()}\tMARK\t${decodeURIComponent(req.url.slice(8)).replace(/[^\w:.-]/g, '_')}\n`);
    res.writeHead(204);
    res.end();
    return;
  }
  count++;
  const wait = delay();
  const t0 = Date.now();
  if (trace) {
    const who = /node|undici/i.test(req.headers['user-agent'] || '') ? 'server' : 'browser';
    res.on('finish', () => {
      trace.write(`${t0}\t${Math.round(wait)}\t${Date.now() - t0}\t${req.method}\t${pathOnly(req.url)}\t${res.statusCode}\t${who}\n`);
    });
  }
  const go = () => {
    const upstream = http.request(
      { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  };
  if (wait > 0) {
    req.pause();
    setTimeout(() => {
      req.resume();
      go();
    }, wait);
  } else go();
});
server.keepAliveTimeout = 65_000;

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    upstream.write(raw + '\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(LISTEN, '127.0.0.1', () => {
  console.log(`latency relay on 127.0.0.1:${LISTEN} -> ${TARGET_PORT}, control file ${CONTROL}`);
});
setInterval(() => {
  console.log(`${new Date().toISOString()} mode=${mode.kind}${mode.kind === 'fixed' ? ':' + mode.ms : ''} requests/min=${count}`);
  count = 0;
}, 60_000).unref();

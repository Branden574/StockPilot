'use strict';
// The outbound-traffic guard for the app server of a load test. LOCAL ONLY.
//
// run-scale.mjs starts the app as `node --require <this file> next start ...`
// and nothing else loads it: it is not part of the app and never runs in the
// app's own deployments. It refuses every outbound connection from the server
// process that is not to this machine, so a load test cannot reach an outside
// service even when the service needs no key (push, book and barcode lookups,
// analytics ingest, an integration with credentials stored in the database).
//
// Two layers:
//   - net.Socket.prototype.connect: every TCP and TLS connection in Node goes
//     through it (http, https, http2, tls, and the connector of the built-in
//     undici behind fetch). A connection to anything but 127.0.0.1, [::1] or
//     localhost (or a local socket path) is destroyed before any lookup or
//     packet, with an error.
//   - globalThis.fetch: a request to anything but this machine is rejected
//     before undici sees it.
// Each refusal is appended as one JSON line to LOADTEST_OUTBOUND_LOG and
// written to stderr. run-scale.mjs counts the lines: any refusal fails the
// step. DNS lookups that never lead to a connection are not blocked, and
// connections the database itself makes (pg_net) are outside this process.
const net = require('node:net');
const fs = require('node:fs');

const LOG = process.env.LOADTEST_OUTBOUND_LOG || '';
const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

function isLocalHost(host) {
  // Node's own default host for a connect without one is localhost.
  if (host === undefined || host === null || host === '') return true;
  return LOCAL_HOSTS.has(
    String(host)
      .toLowerCase()
      .replace(/^\[|\]$/g, ''),
  );
}

function refuse(kind, target) {
  const line = JSON.stringify({ at: new Date().toISOString(), kind, target, pid: process.pid });
  try {
    if (LOG) fs.appendFileSync(LOG, `${line}\n`);
  } catch (_e) {
    // The stderr line below still records it.
  }
  process.stderr.write(`[outbound-guard] refused ${kind} to ${target}\n`);
  return new Error(
    `Load-test outbound guard: a connection to ${target} was refused (only this machine is allowed).`,
  );
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  // (options[, cb]), (port[, host][, cb]), (path[, cb]), or the internal
  // normalized form [options, cb].
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  let host;
  let port;
  let path;
  if (first && typeof first === 'object') {
    host = first.host;
    port = first.port;
    path = first.path;
  } else if (typeof first === 'string' && !/^\d+$/.test(first)) {
    path = first;
  } else {
    port = first;
    host = typeof args[1] === 'string' ? args[1] : undefined;
  }
  // A local socket path (http sets path to null when there is none).
  if (!path && !isLocalHost(host)) {
    const err = refuse('socket', `${host}:${port}`);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return originalConnect.apply(this, args);
};

const originalFetch = globalThis.fetch;
if (typeof originalFetch === 'function') {
  globalThis.fetch = function guardedFetch(input, init) {
    let url = null;
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    } catch (_e) {
      url = null;
    }
    if (url && !isLocalHost(url.hostname)) {
      return Promise.reject(new TypeError('fetch failed', { cause: refuse('fetch', url.origin) }));
    }
    return originalFetch.call(this, input, init);
  };
}

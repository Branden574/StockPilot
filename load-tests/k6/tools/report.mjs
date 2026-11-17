#!/usr/bin/env node
// Builds report.md and report.json for a run-scale.mjs output folder.
//
//   node load-tests/k6/tools/report.mjs --dir <run folder>
//
// Per step of the ladder: offered load and the iterations k6 dropped, requests
// and throughput (workload requests over the configured step time; setup()'s
// sign-ins and the stop at the end are left out), failures and checks, writes
// cut off unanswered at the end, p50/p95/p99 by kind, by kind and role and by action, response bytes,
// database statements per request (pg_stat_statements before/after, by
// database role), the slowest statements, connection counts, and the
// correctness check.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseArgs } from './local.mjs';

// The timed kinds, then the ones reported apart (lib/workload.js).
const KINDS = ['ssr', 'api_read', 'write', 'write_refused', 'write_replay', 'probe'];
const COUNTED_WRITES = ['place_order', 'adjust_up', 'adjust_down', 'receive_line'];

function readMaybe(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
function ms(v) {
  return v === undefined || v === null ? '-' : String(Math.round(v));
}
function kb(v) {
  return v === undefined || v === null ? '-' : (v / 1024).toFixed(1);
}

function trend(summary, name) {
  const m = summary.metrics[name];
  return m ? m.values : null;
}

function statementDelta(before, after) {
  const prev = new Map(before.statements.map((s) => [`${s.queryid}|${s.role}`, s]));
  const rows = [];
  for (const s of after.statements) {
    const p = prev.get(`${s.queryid}|${s.role}`);
    const calls = s.calls - (p ? p.calls : 0);
    if (calls <= 0) continue;
    rows.push({
      role: s.role,
      query: s.query,
      calls,
      totalMs: Number(s.total_ms) - (p ? Number(p.total_ms) : 0),
      rows: s.rows - (p ? p.rows : 0),
      read: s.read - (p ? p.read : 0),
    });
  }
  return rows;
}

function stepReport(dir, name) {
  const summary = readMaybe(join(dir, 'summary.json'));
  if (!summary) return { name, missing: true };
  const before = readMaybe(join(dir, 'pg-before.json'));
  const after = readMaybe(join(dir, 'pg-after.json'));
  const correctness = readMaybe(join(dir, 'correctness.json'));
  const outboundRefused = existsSync(join(dir, 'outbound-refused.txt'))
    ? Number(readFileSync(join(dir, 'outbound-refused.txt'), 'utf8').trim())
    : null;
  const exitCode = existsSync(join(dir, 'k6-exit.txt'))
    ? readFileSync(join(dir, 'k6-exit.txt'), 'utf8').trim()
    : '?';
  const samples = existsSync(join(dir, 'connections.jsonl'))
    ? readFileSync(join(dir, 'connections.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((s) => !s.error)
    : [];
  // The configured steady time: testRunDurationMs also holds setup() (sign-ins
  // for every account) and the graceful stop.
  const lt = summary.loadtest || {};
  const durationS = lt.durationSeconds || summary.state.testRunDurationMs / 1000;
  const count = (n) => (summary.metrics[n] ? summary.metrics[n].values.count : 0);
  const unanswered = Object.fromEntries(
    COUNTED_WRITES.map((w) => [
      w,
      Math.max(0, count(`writes_sent{write:${w}}`) - count(`writes_answered{write:${w}}`)),
    ]),
  );
  const unansweredTotal = Object.values(unanswered).reduce((a, b) => a + b, 0);
  const counts = Object.fromEntries(
    [
      'signin_redirects',
      'mfa_required',
      'scope_violations',
      'viewer_write_allowed',
      'replay_mismatch',
      'rate_limited',
      'orders_created',
      'orders_replayed',
      'receipts_created',
      'receipts_replayed',
      'adjust_up_ok',
      'adjust_down_ok',
      'dropped_iterations',
      'iterations',
    ].map((c) => [c, summary.metrics[c] ? summary.metrics[c].values.count : 0]),
  );
  const rate = (n) => (summary.metrics[n] ? summary.metrics[n].values.rate : null);
  const byKind = {};
  let appRequests = 0;
  for (const k of KINDS) {
    const d = trend(summary, `http_req_duration{kind:${k}}`);
    const b = trend(summary, `response_bytes{kind:${k}}`);
    const n = summary.metrics[`http_reqs{kind:${k}}`]
      ? summary.metrics[`http_reqs{kind:${k}}`].values.count
      : 0;
    appRequests += n;
    byKind[k] = d && {
      count: n,
      p50: d.med,
      p95: d['p(95)'],
      p99: d['p(99)'],
      max: d.max,
      bytesAvg: b && b.avg,
      bytesP95: b && b['p(95)'],
    };
  }
  const byKindRole = {};
  const byAction = {};
  for (const [key, m] of Object.entries(summary.metrics)) {
    let mm = /^http_req_duration\{kind:([a-z_]+),role:([a-z_]+)\}$/.exec(key);
    if (mm && m.values.count > 0) {
      byKindRole[`${mm[1]} / ${mm[2]}`] = {
        count: m.values.count,
        p50: m.values.med,
        p95: m.values['p(95)'],
        p99: m.values['p(99)'],
      };
    }
    mm = /^http_req_duration\{action:([a-z_]+)\}$/.exec(key);
    if (mm && m.values.count > 0) {
      const b = trend(summary, `response_bytes{action:${mm[1]}}`);
      byAction[mm[1]] = {
        count: m.values.count,
        p50: m.values.med,
        p95: m.values['p(95)'],
        p99: m.values['p(99)'],
        bytesAvg: b && b.avg,
      };
    }
  }
  // Scenarios not built on lib/workload.js keep no per-kind counts: use
  // every request k6 sent (they have no setup() sign-ins).
  if (appRequests === 0 && summary.metrics.http_reqs)
    appRequests = summary.metrics.http_reqs.values.count;
  let db = null;
  if (before && after) {
    const delta = statementDelta(before, after);
    const byRole = {};
    for (const r of delta) {
      byRole[r.role] = byRole[r.role] || { calls: 0, totalMs: 0 };
      byRole[r.role].calls += r.calls;
      byRole[r.role].totalMs += r.totalMs;
    }
    // Statements the app's requests send through PostgREST (the roles it
    // switches to), over every request the app answered in the step,
    // setup()'s own included. The auth server's statements (role
    // supabase_auth_admin) are shown apart: setup()'s sign-ins are most of them.
    const setupRequests = summary.metrics['http_reqs{kind:setup}']
      ? summary.metrics['http_reqs{kind:setup}'].values.count
      : 0;
    const POSTGREST_ROLES = new Set(['authenticated', 'anon', 'service_role', 'authenticator']);
    const restCalls = delta
      .filter((r) => POSTGREST_ROLES.has(r.role))
      .reduce((a, r) => a + r.calls, 0);
    db = {
      byRole,
      setupRequests,
      statementsPerRequest:
        appRequests + setupRequests ? restCalls / (appRequests + setupRequests) : null,
      top: delta.sort((a, b) => b.totalMs - a.totalMs).slice(0, 15),
      connectionsBefore: before.connections,
      connectionsAfter: after.connections,
      maxConnections: after.maxConnections,
    };
  }
  const peak = samples.reduce(
    (p, s) => ({
      total: Math.max(p.total, s.total),
      active: Math.max(p.active, s.active),
      waitingOnLock: Math.max(p.waitingOnLock, s.waitingOnLock || 0),
    }),
    { total: 0, active: 0, waitingOnLock: 0 },
  );
  const failedThresholds = [];
  for (const [n, m] of Object.entries(summary.metrics)) {
    if (m.thresholds)
      for (const [t, r] of Object.entries(m.thresholds))
        if (!r.ok) failedThresholds.push(`${n}: ${t}`);
  }
  const offered = Object.fromEntries(
    Object.entries(
      summary.loadtest && summary.loadtest.scenarios ? summary.loadtest.scenarios : {},
    ).map(([r, s]) => [r, s.ratePerMinute]),
  );
  return {
    name,
    exitCode,
    durationS,
    plannedIterations: lt.plannedIterations ?? null,
    maxDropped: lt.maxDropped ?? null,
    unanswered,
    unansweredTotal,
    outboundRefused,
    appRequests,
    throughputPerS: appRequests / durationS,
    httpFailedRate: rate('http_req_failed'),
    checksRate: rate('checks'),
    authOkRate: rate('auth_ok'),
    counts,
    byKind,
    byKindRole,
    byAction,
    db,
    connectionPeak: peak,
    correctness,
    failedThresholds,
    offeredPerMinute: offered,
  };
}

function liquidGlassText(v) {
  if (v && typeof v === 'object')
    return `${v.intended} intended (baked in at build time; the build's own value is not verified)`;
  return v ?? 'not recorded';
}

function markdown(run, steps, outbound) {
  const L = [];
  L.push(`# Load test report: ${run.label || run.startedAt}`, '');
  L.push(
    `Local only. App ${run.baseUrl}, database on this machine. Seeded ${run.items} items, ${run.usersPerRole} accounts per role` +
      ` (organization ${run.organizationId}). Each step ran ${run.duration}` +
      `${run.warmup && !/^0s?$/.test(run.warmup) ? `, after one ${run.warmup} warm-up run that is not reported` : ''}.` +
      ` The app was ${run.server || 'started by hand'}; NEXT_PUBLIC_LIQUID_GLASS ${liquidGlassText(run.liquidGlass)}.`,
    '',
  );
  if (outbound) {
    const n = outbound.refusals.length;
    L.push(
      n
        ? `**The run FAILED its outbound check: the app tried to reach outside this machine ${n} time(s), each refused:**`
        : 'Outbound check: the app tried no connection off this machine, in any phase (start-up to shutdown).',
      '',
    );
    for (const r of outbound.refusals)
      L.push(`- ${r.phase}: ${r.kind} to \`${r.target}\` at ${r.at}`);
    if (n) L.push('');
  }
  if (run.singlePurpose) {
    const sp = run.singlePurpose;
    L.push(
      `Single-purpose scenarios (run-all.sh, started by the runner): run-all.sh exit ${sp.runAllExit}, ` +
        `data check ${sp.correctnessOk ? 'pass' : 'FAIL'}, outbound refused ${sp.outboundRefused}. ` +
        'Per-scenario summaries are in scenarios/, the data check in correctness-all.json.',
      '',
    );
  }
  L.push('## Summary', '');
  L.push(
    '| actors | requests | req/s | dropped / planned | failed | checks | ssr p95 | api p95 | write p95 | unanswered writes | outbound refused | PostgREST stmts/req | peak conns | correctness | k6 exit |',
  );
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of steps) {
    if (s.missing) {
      L.push(`| ${s.name} | not run | | | | | | | | | | | | | |`);
      continue;
    }
    L.push(
      `| ${s.name} | ${s.appRequests} | ${s.throughputPerS.toFixed(1)} | ${s.counts.dropped_iterations} / ${s.plannedIterations ?? '-'} | ` +
        `${(s.httpFailedRate * 100).toFixed(2)}% | ${(s.checksRate * 100).toFixed(2)}% | ` +
        `${ms(s.byKind.ssr && s.byKind.ssr.p95)} | ${ms(s.byKind.api_read && s.byKind.api_read.p95)} | ${ms(s.byKind.write && s.byKind.write.p95)} | ` +
        `${s.unansweredTotal} | ${s.outboundRefused ?? '-'} | ` +
        `${s.db && s.db.statementsPerRequest !== null ? s.db.statementsPerRequest.toFixed(1) : '-'} | ${s.connectionPeak.total} | ` +
        `${s.correctness ? (s.correctness.ok ? 'pass' : 'FAIL') : '-'} | ${s.exitCode} |`,
    );
  }
  L.push(
    '',
    'req/s = workload requests over the configured step time (setup() sign-ins and the graceful stop left out). ' +
      'dropped = iterations k6 could not start on time for want of a free VU (the step fails above ' +
      'LOADTEST_MAX_DROPPED_PCT of the planned ones). unanswered writes = writes sent but cut off by the end of ' +
      'the step; the correctness check allows each to have been committed or not (adjusts are matched exactly, by token). ' +
      'outbound refused = connections the app server tried to make off this machine, refused by the outbound guard (any fails the step). ' +
      'The p95 columns hold the timed kinds only: refused viewer writes, resent submissions and scope probes are ' +
      'reported apart below.',
    '',
  );
  for (const s of steps) {
    if (s.missing) continue;
    L.push(`## ${s.name} actors`, '');
    L.push(
      `Offered arrivals per minute by role: ${Object.entries(s.offeredPerMinute)
        .map(([r, v]) => `${r} ${v}`)
        .join(', ')}.` +
        ` Ran ${s.durationS.toFixed(0)} s, ${s.counts.iterations} iterations of ${s.plannedIterations ?? '-'} planned,` +
        ` ${s.counts.dropped_iterations} dropped (limit ${s.maxDropped ?? '-'}).` +
        ` Writes cut off unanswered: ${Object.entries(s.unanswered)
          .map(([w, n]) => `${w} ${n}`)
          .join(', ')}.`,
      '',
    );
    L.push(
      `Sign-in redirects ${s.counts.signin_redirects}, authenticator demands ${s.counts.mfa_required}, other-warehouse items seen ${s.counts.scope_violations},` +
        ` viewer writes allowed ${s.counts.viewer_write_allowed}, replay mismatches ${s.counts.replay_mismatch}, rate limited ${s.counts.rate_limited}.` +
        ` Orders ${s.counts.orders_created} (+${s.counts.orders_replayed} replayed), receipts ${s.counts.receipts_created} (+${s.counts.receipts_replayed} replayed),` +
        ` adjust +1 ${s.counts.adjust_up_ok} / -1 ${s.counts.adjust_down_ok}.`,
      '',
    );
    if (s.failedThresholds.length)
      L.push(`**Thresholds failed:** ${s.failedThresholds.join('; ')}`, '');
    L.push(
      '| kind | n | p50 ms | p95 ms | p99 ms | max ms | avg KB | p95 KB |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const k of KINDS) {
      const v = s.byKind[k];
      if (v)
        L.push(
          `| ${k} | ${v.count} | ${ms(v.p50)} | ${ms(v.p95)} | ${ms(v.p99)} | ${ms(v.max)} | ${kb(v.bytesAvg)} | ${kb(v.bytesP95)} |`,
        );
    }
    L.push('', '| kind / role | n | p50 | p95 | p99 |', '|---|---|---|---|---|');
    for (const [k, v] of Object.entries(s.byKindRole).sort())
      L.push(`| ${k} | ${v.count} | ${ms(v.p50)} | ${ms(v.p95)} | ${ms(v.p99)} |`);
    L.push('', '| action | n | p50 | p95 | p99 | avg KB |', '|---|---|---|---|---|---|');
    for (const [k, v] of Object.entries(s.byAction).sort())
      L.push(
        `| ${k} | ${v.count} | ${ms(v.p50)} | ${ms(v.p95)} | ${ms(v.p99)} | ${kb(v.bytesAvg)} |`,
      );
    if (s.db) {
      L.push(
        '',
        `PostgREST statements per app request: ${s.db.statementsPerRequest === null ? '-' : s.db.statementsPerRequest.toFixed(1)}` +
          ` (pg_stat_statements top-level statements of the roles authenticated, anon, service_role and authenticator, over` +
          ` ${s.appRequests} workload and ${s.db.setupRequests} setup requests). All statements by role (supabase_auth_admin is` +
          ` the auth server, mostly setup()'s sign-ins; postgres is these tools): ` +
          `${Object.entries(s.db.byRole)
            .map(([r, v]) => `${r} ${v.calls} calls / ${Math.round(v.totalMs)} ms`)
            .join('; ')}.`,
      );
      L.push(
        `Connections: before ${s.db.connectionsBefore.total}, after ${s.db.connectionsAfter.total}, peak sampled ${s.connectionPeak.total}` +
          ` (active ${s.connectionPeak.active}, waiting on a lock ${s.connectionPeak.waitingOnLock}), max_connections ${s.db.maxConnections}.`,
        '',
      );
      L.push('| role | calls | total ms | mean ms | statement |', '|---|---|---|---|---|');
      for (const t of s.db.top) {
        L.push(
          `| ${t.role} | ${t.calls} | ${Math.round(t.totalMs)} | ${(t.totalMs / t.calls).toFixed(2)} | \`${t.query.slice(0, 160).replace(/\|/g, '\\|').replace(/`/g, "'")}\` |`,
        );
      }
    }
    if (s.correctness) {
      L.push('', 'Correctness after the step:', '');
      for (const c of s.correctness.checks)
        L.push(`- ${c.pass ? 'ok' : '**FAIL**'}: ${c.name} (${c.detail})`);
    }
    L.push('');
  }
  return L.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir;
  if (!dir) throw new Error('--dir is required');
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  if (existsSync(join(dir, 'single-purpose.json')))
    run.singlePurpose = JSON.parse(readFileSync(join(dir, 'single-purpose.json'), 'utf8'));
  const stepDir = join(dir, 'steps');
  const names = existsSync(stepDir)
    ? readdirSync(stepDir)
        .filter((n) => /^\d+$/.test(n))
        .sort((a, b) => Number(a) - Number(b))
    : [];
  const steps = names.map((n) => stepReport(join(stepDir, n), n));
  const outbound = existsSync(join(dir, 'outbound-refusals.json'))
    ? JSON.parse(readFileSync(join(dir, 'outbound-refusals.json'), 'utf8'))
    : null;
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ run, steps, outbound }, null, 1));
  const md = markdown(run, steps, outbound);
  writeFileSync(join(dir, 'report.md'), md);
  const parts = md.split('\n## ');
  console.log([parts[0], parts[1]].filter(Boolean).join('\n## '));
}

try {
  main();
} catch (e) {
  console.error(`[report] ${e.message}`);
  process.exit(1);
}

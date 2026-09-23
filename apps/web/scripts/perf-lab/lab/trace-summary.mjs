// Summarise a relay trace: per navigation label, Supabase calls between its
// start and end marks, split server / browser, plus a critical-path sketch.
import fs from 'node:fs';
const [file, prefix] = process.argv.slice(2);
const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => l.split('\t'));
const marks = lines.filter((l) => l[1] === 'MARK');
const calls = lines.filter((l) => l[1] !== 'MARK').map((l) => ({ t: +l[0], wait: +l[1], ms: +l[2], method: l[3], path: l[4], status: l[5], who: l[6] }));
const byScenario = {};
for (let i = 0; i < marks.length; i++) {
  const m = marks[i][2].split(':');
  if (m[0] !== prefix || m[3] !== 'start') continue;
  const end = marks.slice(i + 1).find((x) => x[2].startsWith(`${m[0]}:${m[1]}:${m[2]}:end`));
  if (!end) continue;
  const t0 = +marks[i][0], t1 = +end[0];
  const inWin = calls.filter((c) => c.t >= t0 && c.t < t1);
  const server = inWin.filter((c) => c.who === 'server');
  // serial depth: greedy chain of server calls where each starts after the previous one ended
  const sorted = [...server].sort((a, b) => a.t - b.t);
  let depth = 0, frontierEnd = -Infinity;
  for (const c of sorted) { if (c.t >= frontierEnd) { depth++; frontierEnd = c.t + c.ms; } else frontierEnd = Math.max(frontierEnd, c.t + c.ms) === frontierEnd ? frontierEnd : frontierEnd; }
  (byScenario[m[1]] ??= []).push({ ms: end[2].split(':')[4], server: server.length, browser: inWin.length - server.length, depth, detail: sorted.map((c) => `${c.t - t0}+${c.ms} ${c.method} ${c.path}`) });
}
for (const [id, runs] of Object.entries(byScenario)) {
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log(`${id.padEnd(12)} n=${runs.length} server calls median=${med(runs.map((r) => r.server))} [${runs.map((r) => r.server).join(',')}]  browser median=${med(runs.map((r) => r.browser))}  serial waves median=${med(runs.map((r) => r.depth))}  useful ms [${runs.map((r) => r.ms).join(',')}]`);
}
if (process.env.DETAIL) for (const [id, runs] of Object.entries(byScenario)) { console.log(`\n== ${id} (iteration 1)`); console.log(runs[1]?.detail.join('\n')); }

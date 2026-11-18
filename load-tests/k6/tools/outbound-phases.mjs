// Which phase of a run each outbound refusal fell in. Pure: no imports, so the
// guard test can check it.
//
// run-scale.mjs marks each phase as it begins ({ name, at } in ms: start-up,
// seeding, warm-up, step N, after step N, teardown, shutdown). The outbound
// guard writes one JSON line per refused connection with its time. Every
// refusal, in any phase, fails the run: a refusal after a step's own count
// (late work the server finishes after answering, email or push sent after the
// response) counts the same as one inside a step.

/** The refusal lines of the guard's log (one JSON object per line). */
export function parseRefusals(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_e) {
      // A line that is not JSON is still a refusal the guard wrote.
      rec = { at: null, kind: 'unreadable', target: line.slice(0, 200) };
    }
    out.push(rec);
  }
  return out;
}

/** Each refusal with the phase it fell in (the last phase begun at or before it). */
export function assignPhases(refusals, phases) {
  const sorted = [...phases].sort((a, b) => a.at - b.at);
  return refusals.map((r) => {
    const at = r.at ? Date.parse(r.at) : NaN;
    let phase = sorted.length ? sorted[0].name : 'unknown';
    if (Number.isNaN(at)) phase = 'unknown time';
    else for (const p of sorted) if (p.at <= at) phase = p.name;
    return { ...r, phase };
  });
}

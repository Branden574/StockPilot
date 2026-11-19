// handleSummary for the scenarios that do not use lib/workload.js: the JSON
// summary for run-scale.mjs (LOADTEST_SUMMARY_OUT), without setup_data, and a
// short line on stdout.
export function plainSummary(data) {
  const clean = Object.assign({}, data);
  delete clean.setup_data;
  const failed = [];
  for (const [name, m] of Object.entries(data.metrics)) {
    if (m.thresholds)
      for (const [t, r] of Object.entries(m.thresholds)) if (!r.ok) failed.push(`${name}: ${t}`);
  }
  const out = {
    stdout: failed.length
      ? `\n  FAILED thresholds:\n    ${failed.join('\n    ')}\n`
      : '\n  All thresholds passed.\n',
  };
  if (__ENV.LOADTEST_SUMMARY_OUT) out[__ENV.LOADTEST_SUMMARY_OUT] = JSON.stringify(clean, null, 1);
  return out;
}
